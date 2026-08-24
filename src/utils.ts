/**
 * Pure utility helpers for the SiYuan connector. Kept separate from the
 * connector class so they can be unit-tested without a running SiYuan kernel.
 */

/**
 * Convert a SiYuan "YYYYMMDDHHmmss" local-time timestamp to RFC 3339 UTC.
 * Returns undefined if the input is missing or malformed.
 *
 * SiYuan stores block timestamps as a 14-digit string in the user's local
 * timezone. We parse it as local time, then emit UTC via Date.toISOString().
 */
export function toRfc3339(ts: string | undefined): string | undefined {
	if (!ts || ts.length !== 14) return undefined;
	const y = ts.slice(0, 4);
	const mo = ts.slice(4, 6);
	const d = ts.slice(6, 8);
	const h = ts.slice(8, 10);
	const mi = ts.slice(10, 12);
	const s = ts.slice(12, 14);
	const localIso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
	const ms = Date.parse(localIso);
	if (Number.isNaN(ms)) return undefined;
	return new Date(ms).toISOString();
}

/**
 * Extract `#tag` style tags from Markdown content. Returns a comma-joined
 * string to keep the metadata value small and searchable via fast_text.
 *
 * Supports ASCII and CJK tag names. Caps at 20 tags.
 */
export function extractTags(markdown: string): string {
	if (!markdown) return '';
	const tags = new Set<string>();
	const tagRe = /(?:^|\s)#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(markdown)) !== null) {
		tags.add(m[1]);
		if (tags.size >= 20) break;
	}
	return Array.from(tags).join(',');
}

/**
 * SiYuan internal path looks like
 * "/20260823120000-abc123/20260823130000-def456".
 * The last segment's ID is the document ID for that path. Returns undefined
 * for the root or malformed paths.
 */
export function extractParentDocId(
	path: string | undefined,
): string | undefined {
	if (!path) return undefined;
	const segments = path.split('/').filter(Boolean);
	if (segments.length === 0) return undefined;
	const last = segments[segments.length - 1];
	const match = last.match(/(\d{14}-[a-z0-9]+|[a-z0-9]{20,})/i);
	return match ? match[1] : undefined;
}

/**
 * Build a human-readable title for a content block from its raw content.
 * Truncates to 80 chars; falls back to a synthetic type-based title.
 */
export function buildBlockTitle(
	content: string,
	type: string,
	subtype?: string,
	id?: string,
): string {
	const text = (content ?? '').trim();
	if (text) {
		return text.length > 80 ? text.slice(0, 77) + '...' : text;
	}
	const idSuffix = id ? ` ${id}` : '';
	return subtype ? `${type}:${subtype}${idSuffix}` : `${type}${idSuffix}`;
}

/** Clamp a positive integer with fallback. Used for page_size config. */
export function clampPositiveNumber(
	value: number | undefined,
	fallback: number,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.floor(value);
}

/** Parse comma-separated notebook IDs into a Set for exclusion filtering. */
export function parseExcludeNotebooks(value: string | undefined): Set<string> {
	if (!value) return new Set();
	return new Set(
		value
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);
}

/**
 * Strip a leading YAML frontmatter block (`---\n...\n---\n`) from Markdown
 * content exported by SiYuan. The frontmatter is metadata noise in search
 * previews and should not be indexed as visible content.
 */
export function stripFrontmatter(markdown: string): string {
	if (!markdown) return '';
	const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (match) {
		return markdown.slice(match[0].length);
	}
	return markdown;
}

/**
 * Remove zero-width and other invisible Unicode characters that SiYuan
 * inserts between blocks. These render as blank lines or invisible spacing
 * in search previews.
 *
 * Removes: U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM/ZWNBSP),
 * U+2060 (WJ), and U+00AD (SHY).
 */
export function stripInvisibleChars(text: string): string {
	if (!text) return '';
	// eslint-disable-next-line no-misleading-character-class
	return text.replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, '');
}

/**
 * Clean up SiYuan-exported Markdown for display: strip frontmatter, remove
 * invisible characters, convert SiYuan-specific syntax, collapse blanks.
 */
export function cleanMarkdown(markdown: string): string {
	if (!markdown) return '';
	let result = stripFrontmatter(markdown);
	result = stripInvisibleChars(result);
	result = stripInlineHtml(result);
	result = convertBlockRefs(result);
	result = cleanEmbedBlocks(result);
	// Collapse 3+ consecutive newlines into 2 (one blank line).
	result = result.replace(/\n{3,}/g, '\n\n');
	return result.trim();
}

/**
 * Convert SiYuan block references `((block-id "text"))` or `((block-id 'text'))`
 * into an inline quoted reference with a link back to the source block.
 *
 * Inline style is used (rather than blockquote) so references embedded in a
 * sentence flow naturally without breaking the paragraph structure.
 *
 * Examples:
 *   ((20260307230420-xyno4aj "引用文本"))
 * →   「引用文本」[↗](siyuan://blocks/20260307230420-xyno4aj)
 *
 *   上会项目：((id1 "公司A"))、((id2 "公司B"))
 * →  上会项目：「公司A」[↗](siyuan://blocks/id1)、「公司B」[↗](siyuan://blocks/id2)
 */
export function convertBlockRefs(markdown: string): string {
	if (!markdown) return '';
	return markdown.replace(
		/\(\(([0-9]{14}-[a-z0-9]+)\s+["']([^"']*)["']\)\)/g,
		(_, blockId: string, text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return `[↗](siyuan://blocks/${blockId})`;
			return `「${trimmed}」[↗](siyuan://blocks/${blockId})`;
		},
	);
}

/**
 * Strip inline HTML tags that SiYuan embeds in exported Markdown, such as
 * `<span data-type="text">📄</span>`. Keeps the inner text but removes the
 * tags so they don't render as raw HTML in previews.
 */
export function stripInlineHtml(markdown: string): string {
	if (!markdown) return '';
	// Remove opening/closing tags but keep inner content.
	return markdown.replace(/<\/?span[^>]*>/gi, '');
}

/**
 * Clean SiYuan embed block syntax `{{{row\n...\n}}}` by stripping the
 * markers and keeping the inner content, wrapped in a blockquote for visual
 * distinction (embedded content is quoted from another location).
 *
 * Example:
 *   {{{row
 *   嵌入内容
 *   }}}
 * →
 *   > 嵌入内容
 */
export function cleanEmbedBlocks(markdown: string): string {
	if (!markdown) return '';
	return markdown.replace(
		/\{\{\{row?\r?\n([\s\S]*?)\r?\n\}\}\}/g,
		(_, content: string) => {
			const lines = content.trim().split('\n').map((l) => `> ${l}`);
			return lines.join('\n');
		},
	);
}

/**
 * Extract all siyuan://blocks/ link targets from Markdown content.
 * Returns a comma-joined string of block IDs for metadata storage.
 */
export function extractLinks(markdown: string): string {
	if (!markdown) return '';
	const ids = new Set<string>();
	const linkRe = /siyuan:\/\/blocks\/([0-9]{14}-[a-z0-9]+)/g;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(markdown)) !== null) {
		ids.add(m[1]);
		if (ids.size >= 50) break;
	}
	return Array.from(ids).join(',');
}

/**
 * Map a SiYuan block type code to a display emoji for visual differentiation
 * in search results.
 *
 * p = paragraph 📝, h = heading 🔖, l = list item 📋, c = code 💻,
 * q = quote 💬, t = table 📊, m = math ∑, d = document 📄, s = super 💠,
 * i = list item (ordered) 🔢, b = bookmark 🔖
 */
const BLOCK_TYPE_EMOJI: Record<string, string> = {
	p: '📝',
	h: '🔖',
	l: '📋',
	i: '🔢',
	c: '💻',
	q: '💬',
	t: '📊',
	m: '∑',
	d: '📄',
	s: '💠',
	b: '🔖',
};

export function blockTypeEmoji(type: string | undefined): string {
	if (!type) return '';
	return BLOCK_TYPE_EMOJI[type] ?? '';
}

/**
 * Format an RFC 3339 timestamp as a relative date string in Chinese.
 * < 1h → "刚刚", < 24h → "N小时前", < 7d → "N天前", else → "YYYY-MM-DD".
 */
export function formatRelativeDate(rfc3339: string | undefined): string {
	if (!rfc3339) return '';
	const ts = Date.parse(rfc3339);
	if (Number.isNaN(ts)) return rfc3339.slice(0, 10);
	const diffMs = Date.now() - ts;
	const diffMin = Math.floor(diffMs / 60000);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);
	if (diffMin < 1) return '刚刚';
	if (diffMin < 60) return `${diffMin}分钟前`;
	if (diffHr < 24) return `${diffHr}小时前`;
	if (diffDay < 7) return `${diffDay}天前`;
	return rfc3339.slice(0, 10);
}

/**
 * Count words in mixed CJK + Latin text. CJK characters count as 1 word each;
 * Latin words (sequences of latin letters/digits) count as 1 word each.
 */
export function countWords(text: string): number {
	if (!text) return 0;
	const cjk =
		(text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
	const latin = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
	return cjk + latin;
}

/**
 * Estimate reading time in minutes. Assumes ~400 CJK chars or ~200 English
 * words per minute. Returns at least 1.
 */
export function estimateReadTime(wordCount: number): number {
	return Math.max(1, Math.ceil(wordCount / 400));
}

/**
 * Build a display title that includes the notebook name for context.
 * Example: "示例文档 · 笔记"
 */
export function buildDisplayTitle(
	docTitle: string,
	notebookName: string | undefined,
): string {
	if (!notebookName) return docTitle;
	return `${docTitle} · ${notebookName}`;
}

/**
 * Convert a SiYuan hPath (e.g. "/示例文档" or "/项目A/子目录/文档名")
 * into a readable breadcrumb string. Returns the path without leading slash.
 */
export function formatPathBreadcrumb(hpath: string | undefined): string {
	if (!hpath) return '';
	const segments = hpath.split('/').filter(Boolean);
	return segments.join(' / ');
}

/**
 * Convert a SiYuan notebook icon codepoint string to an emoji character.
 * SiYuan stores icons as hyphen-separated hex codepoints, e.g. "1f4d4" for
 * 📔, or "2702-fe0f" for ✂️ (scissors + variation selector).
 * Returns empty string if the input is empty or malformed.
 */
export function iconCodepointToEmoji(icon: string | undefined): string {
	if (!icon) return '';
	try {
		const codepoints = icon.split('-').map((hex) => parseInt(hex, 16));
		if (codepoints.some((cp) => Number.isNaN(cp))) return '';
		return String.fromCodePoint(...codepoints);
	} catch {
		return '';
	}
}

/**
 * Remove a leading H1 heading from Markdown if it matches the document title.
 * SiYuan exports always start with `# <title>`, but the title is already in
 * the WireDoc `title` field, so showing it again in the content preview is
 * redundant.
 */
export function stripDuplicateH1(markdown: string, title: string): string {
	if (!markdown || !title) return markdown;
	const lines = markdown.split('\n');
	if (lines.length === 0) return markdown;
	const firstLine = lines[0].trim();
	// Match "# <title>" or "# <title without notebook suffix>"
	const titleCore = title.split(' · ')[0];
	if (firstLine === `# ${title}` || firstLine === `# ${titleCore}`) {
		return lines.slice(1).join('\n').replace(/^\n+/, '');
	}
	return markdown;
}

/**
 * Build a Markdown blockquote header for the content, showing notebook icon,
 * notebook name, path breadcrumb, relative date, word count, read time, and
 * tags. Renders as a visually distinct info bar at the top of search preview.
 *
 * Example output:
 *   > 📔 笔记 · 示例文档
 *   > 📅 3天前 · 📝 1,234 字 · ⏱ 3 分钟
 *   > 🏷️ #日记 #反思
 */
export function buildContentHeader(
	notebookName: string | undefined,
	notebookIcon: string | undefined,
	pathBreadcrumb: string | undefined,
	updatedAt: string | undefined,
	content?: string,
	tags?: string,
): string {
	const lines: string[] = [];
	const icon = iconCodepointToEmoji(notebookIcon);
	const nbLabel = [icon, notebookName].filter(Boolean).join(' ');
	const pathPart = pathBreadcrumb || '';
	const location = [nbLabel, pathPart].filter(Boolean).join(' · ');
	if (location) lines.push(location);

	const metaParts: string[] = [];
	if (updatedAt) metaParts.push(`📅 ${formatRelativeDate(updatedAt)}`);
	if (content) {
		const wc = countWords(content);
		if (wc > 0) {
			metaParts.push(`📝 ${wc.toLocaleString()} 字`);
			metaParts.push(`⏱ ${estimateReadTime(wc)} 分钟`);
		}
	}
	if (metaParts.length > 0) lines.push(metaParts.join(' · '));

	if (tags) {
		const tagList = tags.split(',').filter(Boolean).slice(0, 10);
		if (tagList.length > 0) {
			lines.push('🏷️ ' + tagList.map((t) => `#${t}`).join(' '));
		}
	}

	if (lines.length === 0) return '';
	return `> ${lines.join('  \n> ')}\n\n`;
}
