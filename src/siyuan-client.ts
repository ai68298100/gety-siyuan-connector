/**
 * SiYuan Note kernel HTTP API client.
 *
 * Wraps the local SiYuan kernel API (default http://localhost:6806) with typed
 * responses, abort-signal propagation, and token-based authentication.
 *
 * Reference: https://github.com/siyuan-note/siyuan/blob/master/API.md
 */

export interface SiyuanNotebook {
	id: string;
	name: string;
	closed: boolean;
	icon?: string;
	sort?: number;
}

interface LsNotebooksResponse {
	notebooks: SiyuanNotebook[];
}

export interface SiyuanBlock {
	/** Block ID. For type='d' this is the document ID. */
	id: string;
	/** Block type: 'd' for document, 'p' for paragraph, 'h' for heading, etc. */
	type: string;
	/** Block subtype, e.g. 'h1' for headings. */
	subtype?: string;
	/** For documents, this is the document title. For other blocks, the content text. */
	content: string;
	/** Human-readable path, e.g. "/笔记/2026-08-23". */
	hpath?: string;
	/** SiYuan internal path, e.g. "/20260823121500-abc123". */
	path?: string;
	/** Notebook (box) ID this block belongs to. */
	box?: string;
	/** Update timestamp, format "YYYYMMDDHHmmss" in local time. */
	updated?: string;
	/** Creation timestamp, format "YYYYMMDDHHmmss" in local time. */
	created?: string;
	/** Parent block and document root IDs from the blocks table. */
	parent_id?: string;
	root_id?: string;
	/** Native document attributes surfaced by SiYuan search. */
	name?: string;
	alias?: string;
	memo?: string;
	tag?: string;
	ial?: string;
	/** Markdown content for the block (only populated by some queries). */
	fcontent?: string;
	/** Markdown content of the block (alternate field name). */
	markdown?: string;
}

interface SqlResponse {
	data: SiyuanBlock[];
}

export interface ExportMdResponse {
	/** Human-readable path of the document, e.g. "/笔记/2026-08-23". */
	hPath: string;
	/** Markdown content of the document. */
	content: string;
}

export class SiYuanError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly endpoint: string,
		readonly code?: number,
	) {
		super(message);
		this.name = 'SiYuanError';
	}
}

export class SiYuanClient {
	private readonly baseUrl: string;
	private readonly token: string | undefined;
	private readonly signal: AbortSignal;

	constructor(
		baseUrl: string,
		token: string | undefined,
		signal: AbortSignal,
	) {
		// Trim trailing slashes so endpoint paths compose cleanly.
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.token = token && token.length > 0 ? token : undefined;
		this.signal = signal;
	}

	/** Ping the kernel and return its version string. */
	async version(): Promise<string> {
		// SiYuan 3.x exposes version at /api/system/version, returning
		// { code: 0, msg: "", data: "<version>" }. post() already unwraps
		// the {code,msg,data} envelope, so the result IS the version string.
		return await this.post<string>('/api/system/version', {});
	}

	/** List all notebooks (open and closed). */
	async lsNotebooks(): Promise<SiyuanNotebook[]> {
		const data = await this.post<LsNotebooksResponse>(
			'/api/notebook/lsNotebooks',
			{},
		);
		return data.notebooks ?? [];
	}

	/** List all document blocks for a notebook via SQL (full metadata). */
	listDocBlocks(notebookId: string): Promise<SiyuanBlock[]> {
		const stmt =
			`SELECT id, parent_id, root_id, content, type, subtype, hpath, path, box, ` +
			`updated, created, name, alias, memo, tag, ial ` +
			`FROM blocks WHERE type = 'd' AND box = '${
				this.escapeSql(notebookId)
			}' ` +
			`ORDER BY path ASC`;
		return this.query(stmt);
	}

	/**
	 * List document blocks updated at or after a SiYuan timestamp
	 * (YYYYMMDDHHmmss). The inclusive boundary prevents same-second updates
	 * from being skipped; callers de-duplicate against their persisted state.
	 * Used for incremental sync: only fetches docs whose `updated` advanced
	 * since the last poll, avoiding a full metadata scan on steady state.
	 */
	listDocBlocksSince(
		notebookId: string,
		sinceTimestamp: string,
	): Promise<SiyuanBlock[]> {
		const stmt =
			`SELECT id, parent_id, root_id, content, type, subtype, hpath, path, box, ` +
			`updated, created, name, alias, memo, tag, ial ` +
			`FROM blocks WHERE type = 'd' AND box = '${
				this.escapeSql(notebookId)
			}' ` +
			`AND updated >= '${this.escapeSql(sinceTimestamp)}' ` +
			`ORDER BY path ASC`;
		return this.query(stmt);
	}

	/**
	 * List only the IDs of all document blocks in a notebook.
	 * Lighter than listDocBlocks (no content/path columns) — used purely for
	 * deletion detection (IDs present in state but missing from source).
	 */
	listDocIds(notebookId: string): Promise<SiyuanBlock[]> {
		const stmt =
			`SELECT id FROM blocks WHERE type = 'd' AND box = '${
				this.escapeSql(notebookId)
			}' ` +
			`ORDER BY path ASC`;
		return this.query(stmt);
	}

	/**
	 * Fetch full metadata for a specific set of document IDs. Used to retry
	 * documents whose export previously failed: incremental queries keyed on
	 * the `updated` timestamp cannot rediscover them once the cursor has
	 * advanced, so we re-fetch them by ID instead.
	 */
	listDocsByIds(ids: string[]): Promise<SiyuanBlock[]> {
		if (ids.length === 0) return Promise.resolve([]);
		const quoted = ids.map((id) => `'${this.escapeSql(id)}'`).join(', ');
		const stmt =
			`SELECT id, parent_id, root_id, content, type, subtype, hpath, path, box, ` +
			`updated, created, name, alias, memo, tag, ial ` +
			`FROM blocks WHERE type = 'd' AND id IN (${quoted}) ` +
			`ORDER BY path ASC`;
		return this.query(stmt);
	}

	/** Run an arbitrary SQL query against the SiYuan kernel. */
	async query(stmt: string): Promise<SiyuanBlock[]> {
		// post() unwraps the {code,msg,data} envelope, so the result IS the
		// data array directly.
		return await this.post<SiyuanBlock[]>('/api/query/sql', { stmt });
	}

	/** Export a document as Markdown. */
	exportMdContent(docId: string): Promise<ExportMdResponse> {
		return this.post<ExportMdResponse>('/api/export/exportMdContent', {
			id: docId,
		});
	}

	private async post<T>(endpoint: string, body: unknown): Promise<T> {
		const url = this.baseUrl + endpoint;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.token) {
			headers['Authorization'] = `token ${this.token}`;
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: this.signal,
			});
		} catch (err) {
			if (this.signal.aborted) {
				throw new SiYuanError(
					`Request aborted: ${endpoint}`,
					0,
					endpoint,
				);
			}
			throw new SiYuanError(
				`Network error calling ${endpoint}: ${(err as Error).message}`,
				0,
				endpoint,
			);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new SiYuanError(
				`HTTP ${response.status} from ${endpoint}: ${text.slice(0, 200)}`,
				response.status,
				endpoint,
			);
		}

		const payload = await response.json() as {
			code: number;
			msg: string;
			data?: T;
		} & Partial<T>;

		// SiYuan wraps most responses in { code, msg, data }. code === 0 means OK.
		// Some endpoints (e.g. /api/version) return the payload directly.
		if (
			typeof payload === 'object' &&
			payload !== null &&
			'code' in payload &&
			typeof (payload as { code: unknown }).code === 'number'
		) {
			const code = (payload as { code: number }).code;
			if (code !== 0) {
				throw new SiYuanError(
					`SiYuan error on ${endpoint}: ${(payload as { msg: string }).msg}`,
					response.status,
					endpoint,
					code,
				);
			}
			if (!('data' in payload)) {
				throw new SiYuanError(
					`SiYuan response missing data on ${endpoint}`,
					response.status,
					endpoint,
					code,
				);
			}
			return (payload as { data: T }).data;
		}

		// Direct payload (e.g. /api/version).
		return payload as T;
	}

	private escapeSql(value: string): string {
		// Notebook IDs are alphanumeric; escape defensively anyway.
		return value.replace(/'/g, "''");
	}
}
