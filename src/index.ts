import {
	Connector,
	del,
	type PollResult,
	upsert,
} from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { type SiyuanBlock, SiYuanClient } from './siyuan-client.ts';
import {
	buildContentHeader,
	buildDisplayTitle,
	cleanMarkdown,
	extractFrontmatterTags,
	extractLinks,
	extractTags,
	formatPathBreadcrumb,
	iconCodepointToEmoji,
	stripDuplicateH1,
	toRfc3339,
	truncateTitle,
} from './utils.ts';

/**
 * Persisted state across poll cycles.
 *
 * knownDocs maps doc_id -> updated timestamp, used both to detect deletions
 * and to skip content fetches for unchanged documents.
 * lastMaxUpdated is the highest `updated` timestamp seen so far, used as the
 * lower bound for incremental SQL queries.
 * lastSyncAt is informational only.
 */
type SiyuanState = {
	knownDocs?: Record<string, string>;
	lastMaxUpdated?: string;
	lastSyncAt?: string;
};

const DOC_TYPE = 'siyuan:doc';

/** Number of concurrent exportMdContent requests during a poll. */
const EXPORT_CONCURRENCY = 6;

/** Shown instead of the title for documents with no exported content. */
const EMPTY_DOC_PLACEHOLDER = '*（暂无内容）*';

function readDebugLogPath(): string | undefined {
	try {
		const value = Deno.env.get('SIYUAN_CONNECTOR_DEBUG_LOG');
		return value && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

export default class SiYuanConnector extends Connector<
	ManifestConfig,
	SiyuanState
> {
	private client!: SiYuanClient;

	private readonly debugLogPath = readDebugLogPath();

	/** Buffered debug lines; flushed in batches to avoid per-line file IO. */
	private debugBuffer: string[] = [];

	private debug(msg: string): void {
		const path = this.debugLogPath;
		if (!path) return;
		this.debugBuffer.push(`${new Date().toISOString()} ${msg}\n`);
		if (this.debugBuffer.length >= 50) this.flushDebug();
	}

	private flushDebug(): void {
		const path = this.debugLogPath;
		if (!path || this.debugBuffer.length === 0) return;
		try {
			Deno.writeTextFileSync(path, this.debugBuffer.join(''), {
				append: true,
			});
			this.debugBuffer = [];
		} catch {
			// Best-effort; never fail the connector over logging.
		}
	}

	override async onLoad(): Promise<void> {
		const apiUrl = (this.config.api_url ?? 'http://localhost:6806').trim();
		const apiToken = (this.config.api_token ?? '').trim();
		this.debug(
			`onLoad start. apiUrl=${apiUrl} apiToken.length=${apiToken.length}` +
				` apiToken_prefix=${apiToken.slice(0, 4)}...` +
				` configKeys=${Object.keys(this.config).join(',')}`,
		);
		this.client = new SiYuanClient(apiUrl, apiToken, this.signal);

		try {
			const ver = await this.client.version();
			this.debug(`version() ok: ${ver}`);
		} catch (err) {
			this.debug(`version() FAILED: ${(err as Error).message}`);
			this.flushDebug();
			throw new Error(
				`Could not reach SiYuan kernel at ${apiUrl}. ` +
					`Ensure SiYuan is running and the API URL is correct. ` +
					`Cause: ${(err as Error).message}`,
			);
		}

		try {
			const nbs = await this.client.lsNotebooks();
			const open = nbs.filter((n) => !n.closed);
			this.debug(
				`lsNotebooks() ok: ${nbs.length} total, ${open.length} open` +
					` [${open.map((n) => `${n.id}:${n.name}`).join(', ')}]`,
			);
		} catch (err) {
			this.debug(`lsNotebooks() FAILED: ${(err as Error).message}`);
			this.flushDebug();
			throw new Error(
				apiToken === ''
					? `SiYuan API token is required but not provided. ` +
						`Get it from SiYuan: Settings > About > API token. ` +
						`Cause: ${(err as Error).message}`
					: `SiYuan API token is invalid or rejected. ` +
						`Regenerate it in SiYuan: Settings > About > API token. ` +
						`Cause: ${(err as Error).message}`,
			);
		}
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		this.debug(`poll start. concurrency=${EXPORT_CONCURRENCY}`);

		const notebooks = (await this.client.lsNotebooks()).filter(
			(nb) => !nb.closed,
		);
		this.debug(`poll: ${notebooks.length} open notebooks`);

		const notebookNames = new Map<string, string>();
		const notebookIcons = new Map<string, string>();
		for (const nb of notebooks) {
			notebookNames.set(nb.id, nb.name);
			if (nb.icon) notebookIcons.set(nb.id, nb.icon);
		}

		// Phase 1: lightweight ID list for deletion detection.
		const liveIds = new Set<string>();
		for (const nb of notebooks) {
			if (this.signal.aborted) return;
			const ids = await this.client.listDocIds(nb.id);
			for (const b of ids) liveIds.add(b.id);
		}
		this.debug(`poll: ${liveIds.size} live doc IDs across all notebooks`);

		// Phase 2: incremental fetch of changed documents.
		const previousDocs = this.lastState?.knownDocs ?? {};
		const previousIds = new Set(Object.keys(previousDocs));
		const lastMaxUpdated = this.lastState?.lastMaxUpdated;

		const changedDocs: SiyuanBlock[] = [];
		let maxUpdated = lastMaxUpdated ?? '';

		for (const nb of notebooks) {
			if (this.signal.aborted) return;
			let blocks: SiyuanBlock[];
			if (lastMaxUpdated) {
				blocks = await this.client.listDocBlocksSince(nb.id, lastMaxUpdated);
				this.debug(
					`poll: notebook ${nb.name} incremental since ${lastMaxUpdated} → ${blocks.length} docs`,
				);
			} else {
				blocks = await this.client.listDocBlocks(nb.id);
				this.debug(
					`poll: notebook ${nb.name} full scan → ${blocks.length} docs`,
				);
			}
			for (const b of blocks) {
				changedDocs.push(b);
				if (b.updated && b.updated > maxUpdated) maxUpdated = b.updated;
			}
		}

		// Phase 3: detect deletions.
		const deletedDocIds: string[] = [];
		for (const id of previousIds) {
			if (!liveIds.has(id)) deletedDocIds.push(id);
		}

		if (deletedDocIds.length > 0) {
			this.debug(`poll: ${deletedDocIds.length} docs to delete`);
			yield { updates: deletedDocIds.map((id) => del(id)) };
		}

		// Phase 4: filter changed docs by exact updated timestamp.
		// (listDocBlocksSince may return docs at the boundary; knownDocs
		// comparison ensures we only re-fetch genuinely changed ones.)
		const docsToFetch: SiyuanBlock[] = [];
		for (const doc of changedDocs) {
			const prevUpdated = previousDocs[doc.id];
			if (prevUpdated === undefined || prevUpdated !== doc.updated) {
				docsToFetch.push(doc);
			}
		}
		this.debug(
			`poll: ${docsToFetch.length} docs to fetch (new/updated), ` +
				`${deletedDocIds.length} to delete`,
		);

		const nextDocs: Record<string, string> = { ...previousDocs };
		for (const id of deletedDocIds) delete nextDocs[id];

		// Phase 5: concurrent export + batch yield.
		let yielded = 0;
		for (let i = 0; i < docsToFetch.length; i += EXPORT_CONCURRENCY) {
			if (this.signal.aborted) return;

			const chunk = docsToFetch.slice(i, i + EXPORT_CONCURRENCY);
			const chunkResults = await Promise.all(
				chunk.map(async (doc) => {
					try {
						const exported = await this.client.exportMdContent(doc.id);
						return { doc, markdown: exported.content ?? '' };
					} catch (err) {
						return {
							doc,
							markdown: `<!-- export failed: ${(err as Error).message} -->`,
						};
					}
				}),
			);

			const batch = chunkResults.map((r) =>
				this.buildDocUpsert(r.doc, r.markdown, notebookNames, notebookIcons)
			);

			// Advance state for docs in this chunk.
			for (const r of chunkResults) {
				if (r.doc.updated) nextDocs[r.doc.id] = r.doc.updated;
			}

			yielded += batch.length;
			this.debug(
				`poll: yielding batch of ${batch.length} docs (total=${yielded})`,
			);
			yield {
				updates: batch,
				state: {
					knownDocs: nextDocs,
					lastMaxUpdated: maxUpdated,
					lastSyncAt: new Date().toISOString(),
				},
			};
		}

		// If nothing changed, yield an empty state checkpoint.
		if (docsToFetch.length === 0 && deletedDocIds.length === 0) {
			this.debug('poll: no changes, yielding empty state checkpoint');
			yield {
				updates: [],
				state: {
					knownDocs: nextDocs,
					lastMaxUpdated: maxUpdated,
					lastSyncAt: new Date().toISOString(),
				},
			};
		}

		this.flushDebug();
		this.debug('poll: done');
		this.flushDebug();
	}

	private buildDocUpsert(
		doc: SiyuanBlock,
		rawMarkdown: string,
		notebookNames: Map<string, string>,
		notebookIcons: Map<string, string>,
	) {
		const notebookId = doc.box ?? '';
		const notebookName = notebookNames.get(notebookId) ?? '';
		const notebookIcon = notebookIcons.get(notebookId);
		const rawTitle = doc.content || doc.hpath || doc.id;
		const iconEmoji = iconCodepointToEmoji(notebookIcon);
		const titleCore = buildDisplayTitle(
			truncateTitle(rawTitle),
			notebookName || undefined,
		);
		const title = iconEmoji ? `${iconEmoji} ${titleCore}` : titleCore;
		const updatedAt = toRfc3339(doc.updated);
		const createdAt = toRfc3339(doc.created);

		const pathBreadcrumb = formatPathBreadcrumb(doc.hpath, {
			dropFirst: notebookName || undefined,
			dropLast: rawTitle,
		});

		// Extract frontmatter tags BEFORE stripFrontmatter removes them.
		const fmTags = extractFrontmatterTags(rawMarkdown);

		let content = cleanMarkdown(rawMarkdown);
		content = stripDuplicateH1(content, rawTitle);
		content = content.trim() || EMPTY_DOC_PLACEHOLDER;

		// Merge frontmatter tags with inline #tags from the body.
		const bodyTags = extractTags(content);
		const tagSet = new Set<string>();
		for (const t of fmTags.split(',')) if (t) tagSet.add(t);
		for (const t of bodyTags.split(',')) if (t) tagSet.add(t);
		const tags = Array.from(tagSet).slice(0, 20).join(',');

		// Compact header: path + date only. Word count, read time, and tags
		// live in metadata so the body dominates the search preview.
		const header = buildContentHeader(
			pathBreadcrumb || undefined,
			updatedAt,
			undefined,
			undefined,
			true, // compact
		);
		const fullContent = header + content;
		const links = extractLinks(fullContent);

		return upsert({
			id: doc.id,
			title,
			content: fullContent,
			content_format: 'markdown',
			doc_type: DOC_TYPE,
			doc_updated_at: updatedAt,
			original_file_size: new TextEncoder().encode(fullContent).length,
			metadata: {
				url: `siyuan://blocks/${doc.id}`,
				created_at: createdAt,
				notebook: notebookId,
				notebook_name: notebookName,
				doc_path: pathBreadcrumb,
				tags,
				links,
			},
		});
	}
}
