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
 * lastUpdatedByNotebook stores an inclusive incremental cursor per notebook.
 * lastMaxUpdated is retained only as a migration fallback for v0.4.x state.
 * lastSyncAt is informational only.
 */
type SiyuanState = {
	knownDocs?: Record<string, string>;
	lastUpdatedByNotebook?: Record<string, string>;
	lastMaxUpdated?: string;
	lastSyncAt?: string;
	/** Doc IDs whose export failed on the previous poll, to retry by ID. */
	pendingRetry?: string[];
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
			`onLoad start. apiUrl=${apiUrl} apiToken.present=${apiToken.length > 0}` +
				` apiToken.length=${apiToken.length}` +
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

		const allNotebooks = await this.client.lsNotebooks();
		const notebooks = allNotebooks.filter((nb) => !nb.closed);
		this.debug(
			`poll: ${notebooks.length} open notebooks of ${allNotebooks.length} total`,
		);

		const notebookNames = new Map<string, string>();
		const notebookIcons = new Map<string, string>();
		for (const nb of allNotebooks) {
			notebookNames.set(nb.id, nb.name);
			if (nb.icon) notebookIcons.set(nb.id, nb.icon);
		}

		// Phase 1: lightweight ID list for deletion detection.
		// Collect live IDs from ALL notebooks (open and closed) so that closing
		// a notebook does not mark its documents as deleted. Incremental sync
		// below still targets only open notebooks; closed notebooks keep their
		// already-indexed docs but are not refreshed.
		const liveIds = new Set<string>();
		for (const nb of allNotebooks) {
			if (this.signal.aborted) return;
			const ids = await this.client.listDocIds(nb.id);
			for (const b of ids) liveIds.add(b.id);
		}
		this.debug(`poll: ${liveIds.size} live doc IDs across all notebooks`);

		// Phase 2: incremental fetch of changed documents.
		const previousDocs = this.lastState?.knownDocs ?? {};
		const previousIds = new Set(Object.keys(previousDocs));
		const previousCursors = this.lastState?.lastUpdatedByNotebook ?? {};
		const legacyCursor = this.lastState?.lastMaxUpdated;
		const previousRetryIds = this.lastState?.pendingRetry ?? [];

		const changedDocs: SiyuanBlock[] = [];

		for (const nb of notebooks) {
			if (this.signal.aborted) return;
			let blocks: SiyuanBlock[];
			const cursor = previousCursors[nb.id] ?? legacyCursor;
			if (cursor) {
				blocks = await this.client.listDocBlocksSince(nb.id, cursor);
				this.debug(
					`poll: notebook ${nb.name} incremental since ${cursor} → ${blocks.length} docs`,
				);
			} else {
				blocks = await this.client.listDocBlocks(nb.id);
				this.debug(
					`poll: notebook ${nb.name} full scan → ${blocks.length} docs`,
				);
			}
			for (const b of blocks) {
				changedDocs.push(b);
			}
		}

		// Phase 2b: re-fetch documents whose export previously failed. The
		// incremental query above is keyed on `updated`, so once the cursor has
		// advanced past a failed doc it would never be rediscovered; fetch by
		// ID instead to give it another chance.
		let retryDocs: SiyuanBlock[] = [];
		if (previousRetryIds.length > 0) {
			retryDocs = await this.client.listDocsByIds(previousRetryIds);
			this.debug(
				`poll: retrying ${retryDocs.length} previously failed docs` +
					` (wanted ${previousRetryIds.length})`,
			);
		}

		const retryFoundIds = new Set(retryDocs.map((doc) => doc.id));

		// Phase 3: detect deletions.
		const deletedDocIds: string[] = [];
		for (const id of previousIds) {
			if (!liveIds.has(id)) deletedDocIds.push(id);
		}

		// Phase 4: filter changed docs by exact updated timestamp.
		// (listDocBlocksSince includes the boundary; knownDocs comparison ensures
		// we only re-fetch genuinely changed ones.)
		// Retry docs are force-included regardless of their updated timestamp.
		const docsByID = new Map<string, SiyuanBlock>();
		for (const doc of changedDocs) {
			const prevUpdated = previousDocs[doc.id];
			if (prevUpdated === undefined || prevUpdated !== doc.updated) {
				docsByID.set(doc.id, doc);
			}
		}
		for (const doc of retryDocs) {
			docsByID.set(doc.id, doc);
		}
		const docsToFetch = Array.from(docsByID.values());
		this.debug(
			`poll: ${docsToFetch.length} docs to fetch (new/updated/retry), ` +
				`${deletedDocIds.length} to delete`,
		);

		const nextDocs: Record<string, string> = { ...previousDocs };
		for (const id of deletedDocIds) delete nextDocs[id];

		// Track docs whose export still needs a retry on the next poll.
		const nextRetry = new Set(previousRetryIds);
		for (const id of deletedDocIds) nextRetry.delete(id);
		for (const id of previousRetryIds) {
			if (!retryFoundIds.has(id)) nextRetry.delete(id);
		}

		const nextCursors: Record<string, string> = { ...previousCursors };
		if (legacyCursor) {
			for (const nb of notebooks) {
				if (nextCursors[nb.id] === undefined) nextCursors[nb.id] = legacyCursor;
			}
		}

		const checkpoint = (): SiyuanState => ({
			knownDocs: { ...nextDocs },
			lastUpdatedByNotebook: { ...nextCursors },
			lastSyncAt: new Date().toISOString(),
			pendingRetry: Array.from(nextRetry),
		});

		if (deletedDocIds.length > 0) {
			this.debug(`poll: ${deletedDocIds.length} docs to delete`);
			yield {
				updates: deletedDocIds.map((id) => del(id)),
				state: checkpoint(),
			};
		}

		// Phase 5: concurrent export + batch yield.
		let yielded = 0;
		for (let i = 0; i < docsToFetch.length; i += EXPORT_CONCURRENCY) {
			if (this.signal.aborted) return;

			const chunk = docsToFetch.slice(i, i + EXPORT_CONCURRENCY);
			const chunkResults = await Promise.all(
				chunk.map(async (doc) => {
					try {
						const exported = await this.client.exportMdContent(doc.id);
						return {
							doc,
							markdown: exported.content ?? '',
							exported: true,
						};
					} catch {
						return {
							doc,
							markdown: '',
							exported: false,
						};
					}
				}),
			);

			const batch = chunkResults
				.filter((r) => r.exported)
				.map((r) =>
					this.buildDocUpsert(
						r.doc,
						r.markdown,
						notebookNames,
						notebookIcons,
					)
				);

			// Advance state only for successfully exported docs; failed ones
			// keep their previous timestamp and are queued for a retry.
			for (const r of chunkResults) {
				if (r.exported) {
					if (r.doc.updated) nextDocs[r.doc.id] = r.doc.updated;
					const notebookId = r.doc.box ?? '';
					if (
						r.doc.updated &&
						(!nextCursors[notebookId] ||
							r.doc.updated > nextCursors[notebookId])
					) {
						nextCursors[notebookId] = r.doc.updated;
					}
					nextRetry.delete(r.doc.id);
				} else {
					nextRetry.add(r.doc.id);
					this.debug(`export failed for doc ${r.doc.id}; queued for retry`);
				}
			}

			yielded += batch.length;
			this.debug(
				`poll: yielding batch of ${batch.length} docs (total=${yielded})`,
			);
			yield {
				updates: batch,
				state: checkpoint(),
			};
		}

		// If nothing changed, yield an empty state checkpoint.
		if (docsToFetch.length === 0 && deletedDocIds.length === 0) {
			this.debug('poll: no changes, yielding empty state checkpoint');
			yield {
				updates: [],
				state: checkpoint(),
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
			rawTitle,
			notebookName || undefined,
		);
		const titleWithIcon = iconEmoji ? `${iconEmoji} ${titleCore}` : titleCore;
		const title = truncateTitle(titleWithIcon);
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
