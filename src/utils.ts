/**
 * Pure utility helpers for the SiYuan connector. Kept separate from the
 * connector class so they can be unit-tested without a running SiYuan kernel.
 */

/**
 * Unified SiYuan block ID pattern.
 *
 * SiYuan historically used `YYYYMMDDHHmmss-<hash>` (14-digit timestamp +
 * 7+ alphanumerics). Newer workspaces may emit 20+ character pure-alphanumeric
 * IDs. Both shapes must be matched wherever block references appear.
 */
const SIYUAN_ID = '(?:[0-9]{14}-[a-z0-9]+|[a-z0-9]{20,})';

/**
 * Convert a SiYuan "YYYYMMDDHHmmss" local-time timestamp to RFC 3339 UTC.
 * Returns undefined if the input is missing or malformed.
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

// ───────────────────────────────────────────────────────────────────────────
// Code-block protection
//
// Many cleaning steps are global regex replaces that would corrupt source
// code inside fenced blocks or inline code.  protectCode() swaps those spans
// for NUL-delimited placeholders; restoreCode() swaps them back after all
// transforms have run.
// ───────────────────────────────────────────────────────────────────────────

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const MATH_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;
const MATH_INLINE_RE = /\$[^$\n]+\$/g;
// NUL delimiters are intentional placeholders for protected code/math spans.
// deno-lint-ignore no-control-regex
const PLACEHOLDER_RE = /\x00(?:FENCE|INLINE|MATHB|MATHI)\d+\x00/g;

interface ProtectedState {
	clean: string;
	restore: (text: string) => string;
}

/**
 * Replace fenced code blocks, inline code, and math spans with placeholders
 * so downstream regex transforms cannot touch them.  Returns the cleaned
 * text and a restore function.
 */
export function protectCode(markdown: string): ProtectedState {
	const store: string[] = [];
	let result = markdown;

	const stash = (re: RegExp, prefix: string) => {
		result = result.replace(re, (match) => {
			const idx = store.length;
			store.push(match);
			return `\x00${prefix}${idx}\x00`;
		});
	};

	// Order matters: fenced blocks first (they may contain backticks inside),
	// then math blocks, then inline code, then inline math.
	stash(CODE_FENCE_RE, 'FENCE');
	stash(MATH_BLOCK_RE, 'MATHB');
	stash(INLINE_CODE_RE, 'INLINE');
	stash(MATH_INLINE_RE, 'MATHI');

	return {
		clean: result,
		restore: (text: string) =>
			text.replace(PLACEHOLDER_RE, (token) => {
				const idx = parseInt(token.match(/\d+/)![0], 10);
				return store[idx] ?? token;
			}),
	};
}

// ───────────────────────────────────────────────────────────────────────────
// Tag extraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Extract `#tag` style tags from Markdown content. Returns a comma-joined
 * string to keep the metadata value small and searchable via fast_text.
 *
 * Code blocks and inline code are protected first so `#include` or shell
 * comments are not mistaken for tags.
 *
 * Supports ASCII and CJK tag names. Caps at 20 tags.
 */
export function extractTags(markdown: string): string {
	if (!markdown) return '';
	const { clean, restore: _restore } = protectCode(markdown);
	const tags = new Set<string>();
	const tagRe = /(?:^|\s)#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(clean)) !== null) {
		tags.add(m[1]);
		if (tags.size >= 20) break;
	}
	return Array.from(tags).join(',');
}

/**
 * Parse tags from a YAML frontmatter block.  SiYuan stores document tags in
 * the frontmatter `tags:` field, either as a flow sequence `[a, b]` or as
 * plain comma-separated text.  Returns a comma-joined string.
 */
export function extractFrontmatterTags(markdown: string): string {
	if (!markdown) return '';
	const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return '';
	const body = fm[1];
	// Flow sequence: tags: [tag1, tag2]
	let m = body.match(/^tags:\s*\[([^\]]*)\]/m);
	if (m) {
		return m[1]
			.split(',')
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean)
			.join(',');
	}
	// Block sequence:
	//   tags:
	//     - tag1
	//     - tag2
	m = body.match(/^tags:\s*\n((?:\s*-\s+.+\n?)+)/m);
	if (m) {
		return m[1]
			.split('\n')
			.map((line) =>
				line.replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, '')
			)
			.filter(Boolean)
			.join(',');
	}
	// Scalar: tags: tag1, tag2
	m = body.match(/^tags:\s*(.+)$/m);
	if (m) {
		return m[1]
			.split(',')
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean)
			.join(',');
	}
	return '';
}

// ───────────────────────────────────────────────────────────────────────────
// Markdown cleaning pipeline
// ───────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading YAML frontmatter block (`---\n...\n---\n`) from Markdown
 * content exported by SiYuan.
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
 * inserts between blocks.
 */
export function stripInvisibleChars(text: string): string {
	if (!text) return '';
	return text.replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, '');
}

/**
 * Strip inline HTML tags that SiYuan embeds in exported Markdown.
 * Enhanced to cover table/list/media wrappers that HTML blocks may emit.
 */
export function stripInlineHtml(markdown: string): string {
	if (!markdown) return '';
	return markdown
		// Line breaks become real newlines.
		.replace(/<br\s*\/?>/gi, '\n')
		// Images are workspace-local and unreachable; drop the tag.
		.replace(/<img\b[^>]*>/gi, '')
		// Block-level wrappers: drop tags, keep content, add line break.
		.replace(
			/<\/?(?:div|p|section|article|header|footer|nav|aside|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|blockquote|pre|h[1-6])\b[^>]*>/gi,
			'\n',
		)
		// Inline wrappers: drop tags, keep inner text.
		.replace(
			/<\/?(?:span|font|em|strong|b|i|u|s|del|ins|mark|sub|sup|small|big|label|code|abbr|kbd|samp|var|a|button|input|select|textarea|iframe|style|script|video|audio|source|track)\b[^>]*>/gi,
			'',
		);
}

/**
 * Convert SiYuan block references `((block-id "text"))` or `((block-id 'text'))`
 * into an inline quoted reference with a link back to the source block.
 *
 * Uses the unified SIYUAN_ID pattern so both legacy and new ID shapes match.
 */
export function convertBlockRefs(markdown: string): string {
	if (!markdown) return '';
	const re = new RegExp(
		`\\(\\((${SIYUAN_ID})(?:\\s+["']([^"']*)["'])?\\s*\\)\\)`,
		'gi',
	);
	return markdown.replace(
		re,
		(_, blockId: string, text: string | undefined) => {
			const trimmed = (text ?? '').trim();
			if (!trimmed) return `[↗](siyuan://blocks/${blockId})`;
			return `「${trimmed}」[↗](siyuan://blocks/${blockId})`;
		},
	);
}

/**
 * Clean SiYuan embed block syntax `{{{row\n...\n}}}` by stripping the
 * markers and keeping the inner content, wrapped in a blockquote.
 *
 * Enhanced to handle nested attributes and empty reference embeds.
 */
export function cleanEmbedBlocks(markdown: string): string {
	if (!markdown) return '';
	const re = /\{\{\{\s*(?:row|col)\b([^\n]*)\r?\n?([\s\S]*?)\r?\n?\}\}\}/gi;
	return markdown.replace(re, (_match, attrs: string, body: string) => {
		const inner = body.trim();
		if (inner) {
			return inner
				.split('\n')
				.map((l) => `> ${l.trim()}`)
				.join('\n');
		}
		// Empty embed: recover the referenced block id when present.
		const idMatch = attrs.match(new RegExp(SIYUAN_ID, 'i'));
		if (idMatch) return `[↗](siyuan://blocks/${idMatch[0]})`;
		return '';
	});
}

/**
 * Convert SiYuan highlight syntax `==text==` to bold `**text**`.
 */
export function convertHighlights(markdown: string): string {
	if (!markdown) return '';
	return markdown.replace(/==([^\n=]+)==/g, '**$1**');
}

/**
 * Replace workspace-local assets (images, audio, video, attachments) with
 * text markers.  Remote URLs (http/https) are left intact.
 *
 * Extension mapping:
 *   images  → 🖼 caption
 *   audio   → 🎵 filename
 *   video   → 🎬 filename
 *   other   → 📎 filename
 */
export function convertLocalAssets(markdown: string): string {
	if (!markdown) return '';
	return markdown.replace(
		/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g,
		(_, alt: string, url: string) => {
			const caption = alt.trim();
			const ext = (url.split('.').pop() || '').toLowerCase();
			const name = url.split('/').pop() || url;
			if (
				['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)
			) {
				return caption ? `🖼 ${caption}` : '🖼 图片';
			}
			if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)) {
				return `🎵 ${caption || name}`;
			}
			if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv'].includes(ext)) {
				return `🎬 ${caption || name}`;
			}
			return `📎 ${caption || name}`;
		},
	);
}

/**
 * @deprecated Use convertLocalAssets instead.  Kept as a thin alias for
 * backward compatibility with existing tests.
 */
export function convertLocalImages(markdown: string): string {
	return convertLocalAssets(markdown);
}

/**
 * Extract all siyuan://blocks/ link targets from Markdown content.
 * Uses the unified SIYUAN_ID pattern.
 */
export function extractLinks(markdown: string): string {
	if (!markdown) return '';
	const ids = new Set<string>();
	const linkRe = new RegExp(`siyuan://blocks/(${SIYUAN_ID})`, 'gi');
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(markdown)) !== null) {
		ids.add(m[1]);
		if (ids.size >= 50) break;
	}
	return Array.from(ids).join(',');
}

/**
 * Clean up SiYuan-exported Markdown for display.
 *
 * Pipeline:
 *   1. Protect code blocks and math spans
 *   2. Strip frontmatter, invisible chars, inline HTML
 *   3. Convert block refs, embed blocks, highlights, local assets
 *   4. Collapse blank lines
 *   5. Restore code blocks and math
 */
export function cleanMarkdown(markdown: string): string {
	if (!markdown) return '';
	const { clean, restore } = protectCode(markdown);
	let result = stripFrontmatter(clean);
	result = stripInvisibleChars(result);
	result = stripInlineHtml(result);
	result = convertBlockRefs(result);
	result = cleanEmbedBlocks(result);
	result = convertHighlights(result);
	result = convertLocalAssets(result);
	result = result.replace(/\n{3,}/g, '\n\n');
	return restore(result.trim());
}

// ───────────────────────────────────────────────────────────────────────────
// Display helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Format an RFC 3339 timestamp as a relative date string in Chinese.
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
 * Count CJK characters and Latin words separately.
 */
export function countWordsDetailed(
	text: string,
): { cjk: number; latin: number } {
	if (!text) return { cjk: 0, latin: 0 };
	const cjk =
		(text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
	const latin = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
	return { cjk, latin };
}

/**
 * Count words in mixed CJK + Latin text.
 */
export function countWords(text: string): number {
	const { cjk, latin } = countWordsDetailed(text);
	return cjk + latin;
}

/**
 * Estimate reading time in minutes (single rate).
 */
export function estimateReadTime(wordCount: number): number {
	return Math.max(1, Math.ceil(wordCount / 400));
}

/**
 * Estimate reading time for mixed CJK/Latin content at per-script rates.
 */
export function estimateReadTimeDetailed(cjk: number, latin: number): number {
	const minutes = cjk / 400 + latin / 200;
	return Math.max(1, Math.ceil(minutes));
}

/**
 * Truncate an overlong document title.
 */
export function truncateTitle(title: string, maxLength = 60): string {
	const text = (title ?? '').trim();
	if (text.length <= maxLength) return text;
	return text.slice(0, Math.max(1, maxLength - 1)) + '…';
}

/**
 * Build a display title that includes the notebook name for context.
 */
export function buildDisplayTitle(
	docTitle: string,
	notebookName: string | undefined,
): string {
	if (!notebookName) return docTitle;
	return `${docTitle} · ${notebookName}`;
}

/**
 * Convert a SiYuan hPath into a readable breadcrumb string.
 */
export function formatPathBreadcrumb(
	hpath: string | undefined,
	opts?: { dropFirst?: string; dropLast?: string },
): string {
	if (!hpath) return '';
	let segments = hpath.split('/').filter(Boolean);
	if (
		opts?.dropFirst &&
		segments.length > 1 &&
		segments[0] === opts.dropFirst
	) {
		segments = segments.slice(1);
	}
	if (
		opts?.dropLast &&
		segments.length > 1 &&
		segments[segments.length - 1] === opts.dropLast
	) {
		segments = segments.slice(0, -1);
	}
	return segments.join(' / ');
}

/**
 * Convert a SiYuan notebook icon codepoint string to an emoji character.
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
 */
export function stripDuplicateH1(markdown: string, title: string): string {
	if (!markdown || !title) return markdown;
	const lines = markdown.split('\n');
	if (lines.length === 0) return markdown;
	const firstLine = lines[0].trim();
	const titleCore = title.split(' · ')[0];
	if (firstLine === `# ${title}` || firstLine === `# ${titleCore}`) {
		return lines.slice(1).join('\n').replace(/^\n+/, '');
	}
	return markdown;
}

/**
 * Build a compact Markdown blockquote header rendered above the document body.
 *
 * When `compact` is true, only the path and freshness line are emitted (no
 * word count, read time, or tags) — useful when the search preview window is
 * small and the body should dominate.
 */
export function buildContentHeader(
	pathBreadcrumb: string | undefined,
	updatedAt: string | undefined,
	content?: string,
	tags?: string,
	compact = false,
): string {
	const lines: string[] = [];
	if (pathBreadcrumb) lines.push(`📁 ${pathBreadcrumb}`);

	if (!compact) {
		const metaParts: string[] = [];
		if (updatedAt) metaParts.push(`📅 ${formatRelativeDate(updatedAt)}`);
		if (content) {
			const { cjk, latin } = countWordsDetailed(content);
			const wc = cjk + latin;
			if (wc > 0) {
				metaParts.push(`📝 ${wc.toLocaleString('en-US')} 字`);
				metaParts.push(`⏱ ${estimateReadTimeDetailed(cjk, latin)} 分钟`);
			}
		}
		if (metaParts.length > 0) lines.push(metaParts.join(' · '));

		if (tags) {
			const tagList = tags.split(',').filter(Boolean).slice(0, 10);
			if (tagList.length > 0) {
				lines.push('🏷️ ' + tagList.map((t) => `#${t}`).join(' '));
			}
		}
	} else if (updatedAt) {
		lines.push(`📅 ${formatRelativeDate(updatedAt)}`);
	}

	if (lines.length === 0) return '';
	return `> ${lines.join('  \n> ')}\n\n`;
}
