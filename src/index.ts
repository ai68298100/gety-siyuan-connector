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
 * (ids present in state but missing from the source list) and to skip
 * content fetches for documents that haven't changed.
 * lastSyncAt is informational only.
 */
type SiyuanState = {
	knownDocs?: Record<string, string>;
	lastSyncAt?: string;
};

const DOC_TYPE = 'siyuan:doc';

/** Shown instead of the title for documents with no exported content, so an
 * empty note does not just echo its own title back at the reader. */
const EMPTY_DOC_PLACEHOLDER = '*（暂无内容）*';

/**
 * Resolve the optional debug-log destination from the environment.
 *
 * Logging is OFF unless SIYUAN_CONNECTOR_DEBUG_LOG is set. Writing to a
 * hardcoded per-user path (as an earlier revision did) leaked a Windows
 * account name into a published connector and failed outright on other
 * machines, so the destination is now explicit and opt-in.
 */
function readDebugLogPath(): string | undefined {
	try {
		const value = Deno.env.get('SIYUAN_CONNECTOR_DEBUG_LOG');
		return value && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		// No env permission in the host sandbox — stay silent.
		return undefined;
	}
}

export default class SiYuanConnector extends Connector<
	ManifestConfig,
	SiyuanState
> {
	private client!: SiYuanClient;

	/** Optional debug log destination. Undefined means logging is disabled. */
	private readonly debugLogPath = readDebugLogPath();

	/** Write a debug line to a file so we can see what happens inside Gety
	 * (console is redirected to IPC and not visible in app logs).
	 * No-op unless SIYUAN_CONNECTOR_DEBUG_LOG is set. */
	private debug(msg: string): void {
		const path = this.debugLogPath;
		if (!path) return;
		try {
			const line = `${new Date().toISOString()} ${msg}\n`;
			Deno.writeTextFileSync(path, line, { append: true });
		} catch {
			// Best-effort; never fail the connector over logging.
		}
	}

	override async onLoad(): Promise<void> {
		// config is injected by the host before onLoad runs.
		const apiUrl = (this.config.api_url ?? 'http://localhost:6806').trim();
		const apiToken = (this.config.api_token ?? '').trim();
		this.debug(
			`onLoad start. apiUrl=${apiUrl} apiToken.length=${apiToken.length}` +
				` apiToken_prefix=${apiToken.slice(0, 4)}...` +
				` configKeys=${Object.keys(this.config).join(',')}`,
		);
		this.client = new SiYuanClient(apiUrl, apiToken, this.signal);

		// Stage 1: connectivity check via /api/system/version (no auth needed).
		try {
			const ver = await this.client.version();
			this.debug(`version() ok: ${ver}`);
		} catch (err) {
			this.debug(`version() FAILED: ${(err as Error).message}`);
			throw new Error(
				`Could not reach SiYuan kernel at ${apiUrl}. ` +
					`Ensure SiYuan is running and the API URL is correct. ` +
					`Cause: ${(err as Error).message}`,
			);
		}

		// Stage 2: auth check via lsNotebooks.
		try {
			const nbs = await this.client.lsNotebooks();
			const open = nbs.filter((n) => !n.closed);
			this.debug(
				`lsNotebooks() ok: ${nbs.length} total, ${open.length} open` +
					` [${open.map((n) => `${n.id}:${n.name}`).join(', ')}]`,
			);
		} catch (err) {
			this.debug(`lsNotebooks() FAILED: ${(err as Error).message}`);
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
		const pageSize = 50;
		this.debug(`poll start. pageSize=${pageSize}`);

		const notebooks = (await this.client.lsNotebooks()).filter(
			(nb) => !nb.closed,
		);
		this.debug(`poll: ${notebooks.length} open notebooks`);

		// Build notebook id -> name/icon lookups for metadata enrichment.
		const notebookNames = new Map<string, string>();
		const notebookIcons = new Map<string, string>();
		for (const nb of notebooks) {
			notebookNames.set(nb.id, nb.name);
			if (nb.icon) notebookIcons.set(nb.id, nb.icon);
		}

		// Gather the full current document set across all notebooks.
		// SiYuan SQL is per-box, so we query each notebook and merge.
		const liveDocs: SiyuanBlock[] = [];
		for (const nb of notebooks) {
			if (this.signal.aborted) return;
			const blocks = await this.client.listDocBlocks(nb.id);
			this.debug(
				`poll: notebook ${nb.name} (${nb.id}) → ${blocks.length} doc blocks`,
			);
			liveDocs.push(...blocks);
		}
		this.debug(`poll: total ${liveDocs.length} live docs across all notebooks`);

		const previousDocs = this.lastState?.knownDocs ?? {};
		const previousIds = new Set(Object.keys(previousDocs));

		// Detect deleted docs: previously known, no longer in source.
		const liveIds = new Set(liveDocs.map((d) => d.id));
		const deletedDocIds: string[] = [];
		for (const id of previousIds) {
			if (!liveIds.has(id)) {
				deletedDocIds.push(id);
			}
		}

		// Emit deletes first (small batch, usually empty on steady state).
		if (deletedDocIds.length > 0) {
			yield {
				updates: deletedDocIds.map((id) => del(id)),
			};
		}

		// Determine which docs need a content refresh: new docs, or docs whose
		// `updated` timestamp advanced since last poll.
		const docsToFetch: SiyuanBlock[] = [];
		for (const doc of liveDocs) {
			const prevUpdated = previousDocs[doc.id];
			if (prevUpdated === undefined || prevUpdated !== doc.updated) {
				docsToFetch.push(doc);
			}
		}
		this.debug(
			`poll: ${docsToFetch.length} docs to fetch (new/updated), ` +
				`${deletedDocIds.length} to delete`,
		);

		// Rebuild the known-doc map incrementally. Start from the previous map
		// and update with the new timestamps as we yield batches.
		const nextDocs: Record<string, string> = { ...previousDocs };
		// Remove deleted entries from the working map.
		for (const id of deletedDocIds) {
			delete nextDocs[id];
		}

		// Fetch content and yield in page-sized batches.
		let batch: ReturnType<typeof upsert>[] = [];
		for (let i = 0; i < docsToFetch.length; i++) {
			if (this.signal.aborted) return;

			const doc = docsToFetch[i];
			let markdown = '';
			try {
				const exported = await this.client.exportMdContent(doc.id);
				markdown = exported.content ?? '';
			} catch (err) {
				// If a single doc fails (e.g. deleted mid-poll), emit a
				// best-effort doc with whatever metadata we have and continue.
				markdown = `<!-- export failed: ${(err as Error).message} -->`;
			}

			batch.push(
				this.buildDocUpsert(doc, markdown, notebookNames, notebookIcons),
			);

			if (batch.length >= pageSize || i === docsToFetch.length - 1) {
				this.debug(`poll: yielding batch of ${batch.length} docs (i=${i})`);
				// Advance state for the docs covered by this batch.
				for (let j = i - batch.length + 1; j <= i; j++) {
					const d = docsToFetch[j];
					if (d.updated) {
						nextDocs[d.id] = d.updated;
					}
				}
				yield {
					updates: batch,
					state: {
						knownDocs: nextDocs,
						lastSyncAt: new Date().toISOString(),
					},
				};
				batch = [];
			}
		}

		// If nothing changed at all, still yield an empty state checkpoint so
		// lastSyncAt advances.
		if (docsToFetch.length === 0 && deletedDocIds.length === 0) {
			this.debug('poll: no changes, yielding empty state checkpoint');
			yield {
				updates: [],
				state: {
					knownDocs: nextDocs,
					lastSyncAt: new Date().toISOString(),
				},
			};
		}
		this.debug('poll: done');
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
		// Truncate the core title before suffixing the notebook name so an
		// overlong document name can't blow out the result row layout.
		const iconEmoji = iconCodepointToEmoji(notebookIcon);
		const titleCore = buildDisplayTitle(
			truncateTitle(rawTitle),
			notebookName || undefined,
		);
		const title = iconEmoji ? `${iconEmoji} ${titleCore}` : titleCore;
		const updatedAt = toRfc3339(doc.updated);
		const createdAt = toRfc3339(doc.created);
		// Breadcrumb keeps only the parent path: a leading segment equal to the
		// notebook name and the trailing segment equal to the document title are
		// both already visible in the title, so drop them.
		const pathBreadcrumb = formatPathBreadcrumb(doc.hpath, {
			dropFirst: notebookName || undefined,
			dropLast: rawTitle,
		});
		// Clean: strip frontmatter, invisible chars, duplicate H1, collapse blanks.
		let content = cleanMarkdown(rawMarkdown);
		content = stripDuplicateH1(content, rawTitle);
		// Empty documents fall back to a neutral marker rather than echoing the
		// title, which is already shown as the document title.
		content = content.trim() || EMPTY_DOC_PLACEHOLDER;
		const tags = extractTags(content);
		// Prepend a blockquote header with path, date, word count, and tags.
		const header = buildContentHeader(
			pathBreadcrumb || undefined,
			updatedAt,
			content,
			tags,
		);
		const fullContent = header + content;
		// Extract outgoing siyuan:// links for relationship metadata.
		const links = extractLinks(fullContent);

		return upsert({
			id: doc.id,
			title,
			content: fullContent,
			content_format: 'markdown',
			doc_type: DOC_TYPE,
			doc_updated_at: updatedAt,
			// Byte length, not string length: CJK characters take 3 bytes each,
			// so `String.length` under-reports the real payload size.
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
