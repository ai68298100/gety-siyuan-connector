import assert from 'node:assert/strict';
import {
	buildContentHeader,
	buildDisplayTitle,
	cleanEmbedBlocks,
	cleanMarkdown,
	convertBlockRefs,
	convertHighlights,
	convertLocalAssets,
	convertLocalImages,
	countWords,
	countWordsDetailed,
	estimateReadTime,
	estimateReadTimeDetailed,
	extractFrontmatterTags,
	extractIALAttribute,
	extractIALIcon,
	extractLinks,
	extractTags,
	formatFullSourcePath,
	formatPathBreadcrumb,
	formatRelativeDate,
	iconCodepointToEmoji,
	protectCode,
	stripDuplicateH1,
	stripInlineHtml,
	toRfc3339,
	truncateTitle,
} from './utils.ts';

// ─── Timestamp ──────────────────────────────────────────────────────────────

Deno.test('toRfc3339 converts SiYuan YYYYMMDDHHmmss to RFC 3339 UTC', () => {
	const result = toRfc3339('20260823153045');
	assert.equal(typeof result, 'string');
	assert.match(result!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
	assert.equal(result!.slice(0, 4), '2026');
});

Deno.test('toRfc3339 returns undefined for malformed input', () => {
	assert.equal(toRfc3339(undefined), undefined);
	assert.equal(toRfc3339(''), undefined);
	assert.equal(toRfc3339('20260823'), undefined);
	assert.equal(toRfc3339('not-a-timestamp'), undefined);
});

// ─── Code protection ────────────────────────────────────────────────────────

Deno.test('protectCode replaces fenced blocks and restores them', () => {
	const input = 'before\n```js\nconst x = a == b;\n```\nafter';
	const { clean, restore } = protectCode(input);
	assert.equal(clean.includes('```'), false);
	assert.equal(clean.includes('const x'), false);
	const restored = restore(clean);
	assert.equal(restored, input);
});

Deno.test('protectCode protects inline code', () => {
	const input = 'use `const x = a == b` here';
	const { clean, restore } = protectCode(input);
	assert.equal(clean.includes('`const'), false);
	assert.equal(restore(clean), input);
});

Deno.test('protectCode protects math spans', () => {
	const input = 'formula $E=mc^2$ and $$\\int_0^1 x dx$$ done';
	const { clean, restore } = protectCode(input);
	assert.equal(clean.includes('$E=mc'), false);
	assert.equal(restore(clean), input);
});

Deno.test('cleanMarkdown does not corrupt code block content', () => {
	const input = [
		'# 标题',
		'',
		'正文 ==高亮== 结束。',
		'',
		'```js',
		'const x = a == b; // == not highlight',
		'function ((test)) {',
		'  return #not_a_tag;',
		'}',
		'```',
		'',
		'更多正文。',
	].join('\n');
	const result = cleanMarkdown(input);
	// Code block must remain intact.
	assert.match(result, /const x = a == b;/);
	assert.match(result, /function \(\(test\)\)/);
	assert.match(result, /return #not_a_tag;/);
	// Non-code highlight must be converted.
	assert.match(result, /\*\*高亮\*\*/);
});

Deno.test('cleanMarkdown preserves blank lines inside code blocks', () => {
	const input = '```\nline1\n\n\nline4\n```';
	const result = cleanMarkdown(input);
	assert.match(result, /line1\n\n\nline4/);
});

// ─── Tags ───────────────────────────────────────────────────────────────────

Deno.test('extractTags pulls ASCII and CJK tags from markdown', () => {
	const md =
		'This doc covers #investing and #尽职调查.\n\nRelated: #fund #大健康';
	const tags = extractTags(md);
	const set = new Set(tags.split(','));
	assert.equal(set.has('investing'), true);
	assert.equal(set.has('尽职调查'), true);
	assert.equal(set.has('fund'), true);
	assert.equal(set.has('大健康'), true);
});

Deno.test('extractTags ignores tags inside code blocks', () => {
	const md =
		'正文 #real_tag\n```python\n# this is a comment\n#include <stdio.h>\n```';
	const tags = extractTags(md);
	const set = new Set(tags.split(','));
	assert.equal(set.has('real_tag'), true);
	assert.equal(set.has('this'), false);
	assert.equal(set.has('include'), false);
});

Deno.test('extractTags returns empty string for no tags', () => {
	assert.equal(extractTags(''), '');
	assert.equal(extractTags('plain text without hashtags'), '');
});

Deno.test('extractFrontmatterTags parses flow sequence', () => {
	const md = '---\ntitle: 测试\ntags: [投资, 尽调]\n---\n正文';
	assert.equal(extractFrontmatterTags(md), '投资,尽调');
});

Deno.test('extractFrontmatterTags parses block sequence', () => {
	const md = '---\ntags:\n  - 投资\n  - 尽调\n---\n正文';
	assert.equal(extractFrontmatterTags(md), '投资,尽调');
});

Deno.test('extractFrontmatterTags parses scalar comma list', () => {
	const md = '---\ntags: 投资, 尽调\n---\n正文';
	assert.equal(extractFrontmatterTags(md), '投资,尽调');
});

Deno.test('extractFrontmatterTags returns empty when no tags field', () => {
	assert.equal(extractFrontmatterTags('---\ntitle: 测试\n---\n正文'), '');
	assert.equal(extractFrontmatterTags('no frontmatter'), '');
});

// ─── Markdown cleaning ──────────────────────────────────────────────────────

Deno.test('cleanMarkdown strips YAML frontmatter', () => {
	const input = '---\ntitle: 示例\ndate: 2024-05-22\n---\n\n# 示例\n\n内容';
	const result = cleanMarkdown(input);
	assert.equal(result.startsWith('---'), false);
	assert.match(result, /^# 示例/);
});

Deno.test('cleanMarkdown removes zero-width characters', () => {
	const input = '正文内容\u200D\u200B\n第二行\uFEFF';
	const result = cleanMarkdown(input);
	assert.equal(result.includes('\u200D'), false);
	assert.equal(result.includes('\u200B'), false);
	assert.equal(result.includes('\uFEFF'), false);
});

Deno.test('cleanMarkdown collapses 3+ blank lines into 2', () => {
	const result = cleanMarkdown('第一段\n\n\n\n\n第二段');
	assert.equal(result, '第一段\n\n第二段');
});

Deno.test('convertBlockRefs converts ((id "text")) to quoted reference', () => {
	const input = '前文 ((20260101000001-aaaaaaa "引用内容")) 后文';
	const result = convertBlockRefs(input);
	assert.equal(
		result.includes('「引用内容」[↗](siyuan://blocks/20260101000001-aaaaaaa)'),
		true,
	);
});

Deno.test('convertBlockRefs handles single quotes', () => {
	const result = convertBlockRefs("((20260101000003-ccccccc '示例公司'))");
	assert.equal(result.includes('「示例公司」'), true);
});

Deno.test('convertBlockRefs handles bare ((id)) with no text', () => {
	const result = convertBlockRefs('参见 ((20260101000001-aaaaaaa)) 处。');
	assert.equal(result.includes('(('), false);
	assert.equal(
		result.includes('[↗](siyuan://blocks/20260101000001-aaaaaaa)'),
		true,
	);
});

Deno.test('convertBlockRefs matches 20+ char pure-alphanumeric IDs', () => {
	const longId = '202608231200002026010100abcdef';
	const result = convertBlockRefs(`引用 ((${longId} "文本"))`);
	assert.equal(result.includes(`siyuan://blocks/${longId}`), true);
});

Deno.test('convertBlockRefs leaves non-matching text intact', () => {
	assert.equal(convertBlockRefs('普通文本'), '普通文本');
	assert.equal(convertBlockRefs('((不是块引用))'), '((不是块引用))');
});

Deno.test('stripInlineHtml removes span tags but keeps text', () => {
	const result = stripInlineHtml('<span data-type="text">📄</span>文档内容');
	assert.equal(result.includes('<span'), false);
	assert.equal(result.includes('📄文档内容'), true);
});

Deno.test('stripInlineHtml handles div and br', () => {
	const result = stripInlineHtml('<div>包裹的内容</div>\n第一行<br>第二行');
	assert.equal(result.includes('<div'), false);
	assert.equal(result.includes('<br'), false);
	assert.equal(result.includes('包裹的内容'), true);
	assert.equal(result.includes('第一行\n第二行'), true);
});

Deno.test('stripInlineHtml removes table and list wrappers', () => {
	const result = stripInlineHtml('<table><tr><td>cell</td></tr></table>');
	assert.equal(result.includes('<table'), false);
	assert.equal(result.includes('cell'), true);
});

Deno.test('stripInlineHtml removes executable content and preserves links', () => {
	const result = stripInlineHtml(
		'<script>alert(1)</script><a href="https://example.com">Docs</a>',
	);
	assert.equal(result.includes('alert'), false);
	assert.equal(result.includes('[Docs](https://example.com)'), true);
});

Deno.test('stripInlineHtml drops unsafe link protocols', () => {
	assert.equal(stripInlineHtml('<a href="javascript:alert(1)">Run</a>'), 'Run');
});

Deno.test('cleanEmbedBlocks converts {{{row...}}} to blockquote', () => {
	const result = cleanEmbedBlocks('{{{row\n嵌入内容\n}}}');
	assert.equal(result.includes('{{{'), false);
	assert.equal(result.includes('> 嵌入内容'), true);
});

Deno.test('cleanEmbedBlocks handles col layout', () => {
	const result = cleanEmbedBlocks('{{{col\n列内容\n}}}');
	assert.equal(result.includes('> 列内容'), true);
});

Deno.test('cleanEmbedBlocks keeps a link for id-only embeds', () => {
	const result = cleanEmbedBlocks('{{{row id="20260101000008-hhhhhhh"\n\n}}}');
	assert.equal(result.includes('siyuan://blocks/20260101000008-hhhhhhh'), true);
});

Deno.test('cleanEmbedBlocks drops empty embeds that carry no id', () => {
	assert.equal(cleanEmbedBlocks('{{{row\n\n}}}'), '');
});

Deno.test('convertHighlights maps ==text== to bold', () => {
	assert.equal(
		convertHighlights('这里是一段 ==被高亮的内容== 和其余文字。'),
		'这里是一段 **被高亮的内容** 和其余文字。',
	);
});

Deno.test('convertHighlights leaves setext heading underlines alone', () => {
	assert.equal(convertHighlights('标题\n==='), '标题\n===');
});

// ─── Local assets ───────────────────────────────────────────────────────────

Deno.test('convertLocalAssets replaces images with marker', () => {
	const result = convertLocalAssets('![配图说明](assets/a.png)');
	assert.equal(result.includes('!['), false);
	assert.equal(result.includes('🖼 配图说明'), true);
});

Deno.test('convertLocalAssets labels audio files', () => {
	const result = convertLocalAssets('![录音](assets/meeting.mp3)');
	assert.equal(result.includes('🎵 录音'), true);
});

Deno.test('convertLocalAssets labels video files', () => {
	const result = convertLocalAssets('![演示](assets/demo.mp4)');
	assert.equal(result.includes('🎬 演示'), true);
});

Deno.test('convertLocalAssets labels other attachments', () => {
	const result = convertLocalAssets('![报告](assets/report.pdf)');
	assert.equal(result.includes('📎 报告'), true);
});

Deno.test('convertLocalAssets keeps remote images intact', () => {
	const md = '![图](https://example.com/a.png)';
	assert.equal(convertLocalAssets(md), md);
});

Deno.test('convertLocalImages is aliased to convertLocalAssets', () => {
	assert.equal(convertLocalImages('![](assets/a.png)'), '🖼 图片');
});

// ─── Links ──────────────────────────────────────────────────────────────────

Deno.test('convertLocalAssets keeps remote query images intact', () => {
	const md = '![remote](https://example.com/a.png?width=320)';
	assert.equal(convertLocalAssets(md), md);
});

Deno.test('convertLocalAssets classifies local media with query parameters', () => {
	assert.equal(
		convertLocalAssets('![recording](assets/meeting.mp3?download=1)'),
		'🎵 recording',
	);
});

Deno.test('extractLinks pulls siyuan block IDs from markdown', () => {
	const md =
		'链接 [📑](siyuan://blocks/20260101000004-ddddddd) 和 [📄](siyuan://blocks/20260101000005-eeeeeee)';
	const links = extractLinks(md);
	assert.equal(links.includes('20260101000004-ddddddd'), true);
	assert.equal(links.includes('20260101000005-eeeeeee'), true);
});

Deno.test('extractLinks matches 20+ char IDs', () => {
	const longId = '202608231200002026010100abcdef';
	const md = `[link](siyuan://blocks/${longId})`;
	assert.equal(extractLinks(md).includes(longId), true);
});

Deno.test('extractLinks returns empty for no links', () => {
	assert.equal(extractLinks('普通文本无链接'), '');
});

// ─── Display helpers ────────────────────────────────────────────────────────

Deno.test('formatRelativeDate shows relative time for recent dates', () => {
	const now = new Date().toISOString();
	assert.equal(formatRelativeDate(now), '刚刚');
	const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
	assert.match(formatRelativeDate(oneHourAgo), /\d+小时前/);
});

Deno.test('formatRelativeDate shows date for old timestamps', () => {
	const old = '2026-01-01T00:00:00.000Z';
	assert.match(formatRelativeDate(old), /^\d{4}-\d{2}-\d{2}$/);
});

Deno.test('countWords counts CJK and Latin separately', () => {
	assert.equal(countWords('你好世界'), 4);
	assert.equal(countWords('hello world'), 2);
	assert.equal(countWords('你好 hello world 世界'), 6);
	assert.equal(countWords(''), 0);
});

Deno.test('countWordsDetailed splits CJK and Latin counts', () => {
	assert.deepEqual(countWordsDetailed('你好 hello world'), {
		cjk: 2,
		latin: 2,
	});
	assert.deepEqual(countWordsDetailed(''), { cjk: 0, latin: 0 });
});

Deno.test('estimateReadTime returns at least 1', () => {
	assert.equal(estimateReadTime(0), 1);
	assert.equal(estimateReadTime(400), 1);
	assert.equal(estimateReadTime(401), 2);
});

Deno.test('estimateReadTimeDetailed scores each script separately', () => {
	assert.equal(estimateReadTimeDetailed(400, 0), 1);
	assert.equal(estimateReadTimeDetailed(0, 200), 1);
	assert.equal(estimateReadTimeDetailed(400, 200), 2);
	assert.equal(estimateReadTimeDetailed(0, 0), 1);
});

Deno.test('truncateTitle shortens overlong titles only', () => {
	assert.equal(truncateTitle('短标题'), '短标题');
	const result = truncateTitle('标题内容'.repeat(50));
	assert.equal(result.length, 60);
	assert.equal(result.endsWith('…'), true);
	const emojiResult = truncateTitle(`${'a'.repeat(57)}😀${'x'.repeat(4)}`);
	assert.equal(emojiResult, `${'a'.repeat(57)}😀x…`);
});

Deno.test('buildDisplayTitle appends notebook name', () => {
	assert.equal(buildDisplayTitle('示例文档', '笔记'), '示例文档 · 笔记');
	assert.equal(buildDisplayTitle('标题', undefined), '标题');
});

Deno.test('formatPathBreadcrumb converts hpath to readable breadcrumb', () => {
	assert.equal(
		formatPathBreadcrumb('/项目A/子目录/文档名'),
		'项目A / 子目录 / 文档名',
	);
	assert.equal(formatPathBreadcrumb(undefined), '');
});

Deno.test('formatPathBreadcrumb drops segments already shown in the title', () => {
	assert.equal(
		formatPathBreadcrumb('/笔记/子目录/文档名', {
			dropFirst: '笔记',
			dropLast: '文档名',
		}),
		'子目录',
	);
});

Deno.test('formatPathBreadcrumb removes notebook and document from a root path', () => {
	assert.equal(
		formatPathBreadcrumb('/Notebook/Document', {
			dropFirst: 'Notebook',
			dropLast: 'Document',
		}),
		'',
	);
});

Deno.test('formatFullSourcePath keeps notebook and document context', () => {
	assert.equal(
		formatFullSourcePath('/Notebook/Project/Document', 'Notebook', 'Document'),
		'Notebook / Project / Document',
	);
	assert.equal(
		formatFullSourcePath(undefined, 'Notebook', 'Document'),
		'Notebook / Document',
	);
	assert.equal(
		formatFullSourcePath('/Project/Document', 'Notebook', 'Document'),
		'Notebook / Project / Document',
	);
});

Deno.test('iconCodepointToEmoji converts hex codepoints to emoji', () => {
	assert.equal(iconCodepointToEmoji('1f4d4'), '📔');
	assert.equal(iconCodepointToEmoji('2702-fe0f'), '✂️');
	assert.equal(iconCodepointToEmoji(''), '');
	assert.equal(iconCodepointToEmoji('invalid'), '');
});

Deno.test('extractIALIcon reads single or double quoted document icons', () => {
	assert.equal(extractIALIcon('{: icon="1f4c1"}'), '1f4c1');
	assert.equal(
		extractIALAttribute("{: alias='Notes' icon='1f4d1'}", 'alias'),
		'Notes',
	);
	assert.equal(extractIALIcon('{: id="x"}'), '');
});

Deno.test('stripDuplicateH1 removes leading H1 matching title', () => {
	assert.equal(stripDuplicateH1('# 示例文档\n\n正文', '示例文档'), '正文');
	assert.equal(
		stripDuplicateH1('# 示例文档\n\n正文', '示例文档 · 笔记'),
		'正文',
	);
	assert.equal(
		stripDuplicateH1('# 其他标题\n正文', '示例文档'),
		'# 其他标题\n正文',
	);
});

// ─── Content header ─────────────────────────────────────────────────────────

Deno.test('buildContentHeader shows path, freshness and tags', () => {
	const header = buildContentHeader(
		'子目录',
		'2026-03-22T22:02:13.000Z',
		'这是一段测试内容，用于验证字数统计功能。',
		'日记,反思',
	);
	assert.equal(header.startsWith('> '), true);
	assert.equal(header.includes('📁 子目录'), true);
	assert.equal(header.includes('📅'), true);
	assert.equal(header.includes('📝'), true);
	assert.equal(header.includes('🏷️'), true);
	assert.equal(header.includes('#日记'), true);
});

Deno.test('buildContentHeader compact mode omits word count and tags', () => {
	const header = buildContentHeader(
		'子目录',
		'2026-03-22T22:02:13.000Z',
		'内容内容内容',
		'日记,反思',
		true,
	);
	assert.equal(header.includes('📁 子目录'), true);
	assert.equal(header.includes('📅'), true);
	assert.equal(header.includes('📝'), false);
	assert.equal(header.includes('🏷️'), false);
});

Deno.test('buildContentHeader returns empty for no input', () => {
	assert.equal(
		buildContentHeader(undefined, undefined, undefined, undefined),
		'',
	);
});

// ─── End-to-end pipeline ────────────────────────────────────────────────────

Deno.test('cleanMarkdown leaves no SiYuan markup artifacts', () => {
	const md = [
		'---',
		'title: 综合测试',
		'tags: [标签A, 标签B]',
		'---',
		'',
		'# 综合测试',
		'',
		'<span data-type="text">📄</span> 引用 ((20260101000001-aaaaaaa "文本"))',
		'与裸引用 ((20260101000002-bbbbbbb))。',
		'',
		'{{{row id="20260101000008-hhhhhhh"',
		'',
		'}}}',
		'',
		'高亮 ==重点内容== 结束。',
		'',
		'![配图](assets/a.png)',
		'',
		'<div>块级内容</div>',
	].join('\n');

	const result = cleanMarkdown(md);
	const artifacts = ['---', '{{{', '}}}', '((', '))', '<span', '<div', '!['];
	for (const bad of artifacts) {
		assert.equal(result.includes(bad), false, `残留语法: ${bad}`);
	}
	assert.equal(result.includes('「文本」'), true);
	assert.equal(result.includes('**重点内容**'), true);
	assert.equal(result.includes('🖼 配图'), true);
});
