import assert from 'node:assert/strict';
import {
	blockTypeEmoji,
	buildBlockTitle,
	buildContentHeader,
	buildDisplayTitle,
	clampPositiveNumber,
	cleanEmbedBlocks,
	cleanMarkdown,
	convertBlockRefs,
	convertHighlights,
	convertLocalImages,
	countWords,
	countWordsDetailed,
	estimateReadTime,
	estimateReadTimeDetailed,
	extractLinks,
	extractParentDocId,
	extractTags,
	formatPathBreadcrumb,
	formatRelativeDate,
	iconCodepointToEmoji,
	parseExcludeNotebooks,
	stripDuplicateH1,
	stripInlineHtml,
	toRfc3339,
	truncateTitle,
} from './utils.ts';

Deno.test('toRfc3339 converts SiYuan YYYYMMDDHHmmss to RFC 3339 UTC', () => {
	// 2026-08-23T15:30:45 in local time -> ISO UTC string.
	const result = toRfc3339('20260823153045');
	assert.equal(typeof result, 'string');
	assert.match(result!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
	// Year and date must be preserved (timezone shift aside, the calendar
	// date near midnight boundary may roll, but for 15:30 it won't).
	assert.equal(result!.slice(0, 4), '2026');
});

Deno.test('toRfc3339 returns undefined for malformed input', () => {
	assert.equal(toRfc3339(undefined), undefined);
	assert.equal(toRfc3339(''), undefined);
	assert.equal(toRfc3339('20260823'), undefined);
	assert.equal(toRfc3339('not-a-timestamp'), undefined);
});

Deno.test('extractTags pulls ASCII and CJK tags from markdown', () => {
	const md = [
		'This doc covers #investing and #尽职调查.',
		'',
		'Related: #fund #大健康 #fund #investing',
	].join('\n');
	const tags = extractTags(md);
	const set = new Set(tags.split(','));
	assert.equal(set.has('investing'), true);
	assert.equal(set.has('尽职调查'), true);
	assert.equal(set.has('fund'), true);
	assert.equal(set.has('大健康'), true);
	// Duplicates collapsed.
	assert.equal(tags.split(',').filter((t) => t === 'fund').length, 1);
});

Deno.test('extractTags returns empty string for no tags', () => {
	assert.equal(extractTags(''), '');
	assert.equal(extractTags('plain text without hashtags'), '');
});

Deno.test('extractParentDocId returns last segment id from SiYuan path', () => {
	const path = '/20260101000008-hhhhhhh/20260823130000-def456';
	assert.equal(extractParentDocId(path), '20260823130000-def456');
});

Deno.test('extractParentDocId handles 20-char ID format', () => {
	const path = '/20260823120000-20260101000008-hhhhhhh45';
	const result = extractParentDocId(path);
	assert.equal(result !== undefined, true);
});

Deno.test('extractParentDocId returns undefined for empty or root paths', () => {
	assert.equal(extractParentDocId(undefined), undefined);
	assert.equal(extractParentDocId(''), undefined);
	assert.equal(extractParentDocId('/'), undefined);
});

Deno.test('buildBlockTitle truncates long content', () => {
	const long = 'x'.repeat(100);
	const result = buildBlockTitle(long, 'p');
	assert.equal(result.length, 80);
	assert.equal(result.endsWith('...'), true);
});

Deno.test('buildBlockTitle keeps short content intact', () => {
	assert.equal(buildBlockTitle('short', 'p'), 'short');
});

Deno.test('buildBlockTitle falls back to type-based title for empty content', () => {
	assert.equal(
		buildBlockTitle('', 'h', 'h1', '20260823120000-abc'),
		'h:h1 20260823120000-abc',
	);
	assert.equal(buildBlockTitle('', 'p', undefined, undefined), 'p');
});

Deno.test('clampPositiveNumber falls back on invalid input', () => {
	assert.equal(clampPositiveNumber(undefined, 50), 50);
	assert.equal(clampPositiveNumber(NaN, 50), 50);
	assert.equal(clampPositiveNumber(0, 50), 50);
	assert.equal(clampPositiveNumber(-5, 50), 50);
	assert.equal(clampPositiveNumber(3.7, 50), 3);
	assert.equal(clampPositiveNumber(100, 50), 100);
});

Deno.test('parseExcludeNotebooks splits and trims comma-separated ids', () => {
	const set = parseExcludeNotebooks('20260823120000-abc, 20260823130000-def ,');
	assert.equal(set.size, 2);
	assert.equal(set.has('20260823120000-abc'), true);
	assert.equal(set.has('20260823130000-def'), true);
});

Deno.test('parseExcludeNotebooks returns empty set for falsy input', () => {
	assert.equal(parseExcludeNotebooks(undefined).size, 0);
	assert.equal(parseExcludeNotebooks('').size, 0);
	assert.equal(parseExcludeNotebooks('   ').size, 0);
});

Deno.test('cleanMarkdown strips YAML frontmatter', () => {
	const input =
		'---\ntitle: 示例文档\ndate: 2024-05-22T09:02:18+08:00\n---\n\n# 示例文档\n\n内容';
	const result = cleanMarkdown(input);
	assert.equal(result.startsWith('---'), false);
	assert.match(result, /^# 示例文档/);
});

Deno.test('cleanMarkdown removes zero-width characters', () => {
	const input = '正文内容\u200D\u200B\n第二行\uFEFF';
	const result = cleanMarkdown(input);
	assert.equal(result.includes('\u200D'), false);
	assert.equal(result.includes('\u200B'), false);
	assert.equal(result.includes('\uFEFF'), false);
});

Deno.test('cleanMarkdown collapses 3+ blank lines into 2', () => {
	const input = '第一段\n\n\n\n\n第二段';
	const result = cleanMarkdown(input);
	assert.equal(result, '第一段\n\n第二段');
});

Deno.test('buildDisplayTitle appends notebook name', () => {
	assert.equal(
		buildDisplayTitle('示例文档', '笔记'),
		'示例文档 · 笔记',
	);
	assert.equal(buildDisplayTitle('标题', undefined), '标题');
	assert.equal(buildDisplayTitle('标题', ''), '标题');
});

Deno.test('formatPathBreadcrumb converts hpath to readable breadcrumb', () => {
	assert.equal(
		formatPathBreadcrumb('/项目A/子目录/文档名'),
		'项目A / 子目录 / 文档名',
	);
	assert.equal(formatPathBreadcrumb('/示例文档'), '示例文档');
	assert.equal(formatPathBreadcrumb(undefined), '');
	assert.equal(formatPathBreadcrumb(''), '');
});

Deno.test('iconCodepointToEmoji converts hex codepoints to emoji', () => {
	assert.equal(iconCodepointToEmoji('1f4d4'), '📔');
	assert.equal(iconCodepointToEmoji('2702-fe0f'), '✂️');
	assert.equal(iconCodepointToEmoji('1f947'), '🥇');
	assert.equal(iconCodepointToEmoji(''), '');
	assert.equal(iconCodepointToEmoji(undefined), '');
	assert.equal(iconCodepointToEmoji('invalid'), '');
});

Deno.test('stripDuplicateH1 removes leading H1 matching title', () => {
	assert.equal(
		stripDuplicateH1('# 示例文档\n\n正文', '示例文档'),
		'正文',
	);
	assert.equal(
		stripDuplicateH1('# 示例文档\n\n正文', '示例文档 · 笔记'),
		'正文',
	);
	// H1 doesn't match title — keep it.
	assert.equal(
		stripDuplicateH1('# 其他标题\n正文', '示例文档'),
		'# 其他标题\n正文',
	);
});

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
	assert.equal(header.includes('#反思'), true);
});

Deno.test('buildContentHeader omits the path line for root-level docs', () => {
	const header = buildContentHeader(
		undefined,
		'2026-03-22T22:02:13.000Z',
		'内容',
	);
	assert.equal(header.includes('📁'), false);
	assert.equal(header.includes('📅'), true);
});

Deno.test('buildContentHeader does not repeat context already in the title', () => {
	// The title already renders "<icon> <doc title> · <notebook>", so the
	// header must not print the notebook name or icon a second time.
	const header = buildContentHeader(
		'子目录',
		'2026-03-22T22:02:13.000Z',
		'内容',
	);
	assert.equal(header.includes('📔'), false);
});

Deno.test('buildContentHeader returns empty for no input', () => {
	assert.equal(
		buildContentHeader(undefined, undefined, undefined, undefined),
		'',
	);
});

Deno.test('convertBlockRefs converts ((id "text")) to quoted reference', () => {
	const input = '前文 ((20260101000001-aaaaaaa "引用内容")) 后文';
	const result = convertBlockRefs(input);
	assert.equal(result.includes('((20260307230420'), false);
	assert.equal(
		result.includes('「引用内容」[↗](siyuan://blocks/20260101000001-aaaaaaa)'),
		true,
	);
});

Deno.test('convertBlockRefs handles single quotes', () => {
	const input = "((20260101000003-ccccccc '示例公司'))";
	const result = convertBlockRefs(input);
	assert.equal(result.includes('「示例公司」'), true);
	assert.equal(result.includes('siyuan://blocks/20260101000003-ccccccc'), true);
});

Deno.test('convertBlockRefs handles multiple inline refs in a sentence', () => {
	const input =
		'上会项目：((20260101000006-fffffff "示例公司A"))、((20260101000007-ggggggg "示例公司B"))';
	const result = convertBlockRefs(input);
	assert.equal(result.includes('「示例公司A」'), true);
	assert.equal(result.includes('「示例公司B」'), true);
	assert.equal(result.includes('>'), false);
});

Deno.test('convertBlockRefs leaves non-matching text intact', () => {
	assert.equal(convertBlockRefs('普通文本'), '普通文本');
	assert.equal(convertBlockRefs('((不是块引用))'), '((不是块引用))');
});

Deno.test('stripInlineHtml removes span tags but keeps text', () => {
	const input = '<span data-type="text">📄</span>文档内容<span> </span>';
	const result = stripInlineHtml(input);
	assert.equal(result.includes('<span'), false);
	assert.equal(result.includes('</span>'), false);
	assert.equal(result.includes('📄文档内容'), true);
});

Deno.test('cleanEmbedBlocks converts {{{row...}}} to blockquote', () => {
	const input = '{{{row\n嵌入内容\n}}}';
	const result = cleanEmbedBlocks(input);
	assert.equal(result.includes('{{{'), false);
	assert.equal(result.includes('}}}'), false);
	assert.equal(result.includes('> 嵌入内容'), true);
});

Deno.test('extractLinks pulls siyuan block IDs from markdown', () => {
	const md =
		'链接 [📑](siyuan://blocks/20260101000004-ddddddd) 和 [📄](siyuan://blocks/20260101000005-eeeeeee)';
	const links = extractLinks(md);
	assert.equal(links.includes('20260101000004-ddddddd'), true);
	assert.equal(links.includes('20260101000005-eeeeeee'), true);
});

Deno.test('extractLinks returns empty for no links', () => {
	assert.equal(extractLinks('普通文本无链接'), '');
});

Deno.test('blockTypeEmoji maps known types', () => {
	assert.equal(blockTypeEmoji('p'), '📝');
	assert.equal(blockTypeEmoji('h'), '🔖');
	assert.equal(blockTypeEmoji('c'), '💻');
	assert.equal(blockTypeEmoji('l'), '📋');
});

Deno.test('blockTypeEmoji returns empty for unknown/empty', () => {
	assert.equal(blockTypeEmoji('x'), '');
	assert.equal(blockTypeEmoji(undefined), '');
});

Deno.test('formatRelativeDate shows relative time for recent dates', () => {
	const now = new Date().toISOString();
	assert.equal(formatRelativeDate(now), '刚刚');

	const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
	assert.match(formatRelativeDate(oneHourAgo), /\d+小时前/);

	const oneDayAgo = new Date(Date.now() - 90000000).toISOString();
	assert.match(formatRelativeDate(oneDayAgo), /\d+天前/);
});

Deno.test('formatRelativeDate shows date for old timestamps', () => {
	const old = '2026-01-01T00:00:00.000Z';
	const result = formatRelativeDate(old);
	assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

Deno.test('countWords counts CJK and Latin separately', () => {
	assert.equal(countWords('你好世界'), 4);
	assert.equal(countWords('hello world'), 2);
	assert.equal(countWords('你好 hello world 世界'), 6);
	assert.equal(countWords(''), 0);
});

Deno.test('estimateReadTime returns at least 1', () => {
	assert.equal(estimateReadTime(0), 1);
	assert.equal(estimateReadTime(100), 1);
	assert.equal(estimateReadTime(400), 1);
	assert.equal(estimateReadTime(401), 2);
	assert.equal(estimateReadTime(1200), 3);
});

Deno.test('buildContentHeader includes word count and read time', () => {
	const header = buildContentHeader(
		'子目录',
		'2026-03-22T22:02:13.000Z',
		'这是一段测试内容，用于验证字数统计功能。',
		'日记,反思',
	);
	assert.equal(header.includes('📝'), true);
	assert.equal(header.includes('字'), true);
	assert.equal(header.includes('⏱'), true);
	assert.equal(header.includes('分钟'), true);
	assert.equal(header.includes('🏷️'), true);
	assert.equal(header.includes('#日记'), true);
	assert.equal(header.includes('#反思'), true);
});

// ───────────────────────────────────────────────────────────────────────────
// Display-pipeline regression tests
//
// These encode the SiYuan export constructs that previously leaked raw markup
// into search previews. If one of these fails, previews show syntax noise.
// ───────────────────────────────────────────────────────────────────────────

Deno.test('convertBlockRefs converts bare ((id)) with no text', () => {
	const result = convertBlockRefs('参见 ((20260101000001-aaaaaaa)) 处。');
	assert.equal(result.includes('(('), false);
	assert.equal(
		result.includes('[↗](siyuan://blocks/20260101000001-aaaaaaa)'),
		true,
	);
});

Deno.test('cleanEmbedBlocks handles col layout', () => {
	const result = cleanEmbedBlocks('{{{col\n列内容\n}}}');
	assert.equal(result.includes('{{{'), false);
	assert.equal(result.includes('> 列内容'), true);
});

Deno.test('cleanEmbedBlocks keeps a link for id-only embeds', () => {
	const result = cleanEmbedBlocks('{{{row id="20260101000008-hhhhhhh"\n\n}}}');
	assert.equal(result.includes('{{{'), false);
	assert.equal(result.includes('}}}'), false);
	assert.equal(
		result.includes('siyuan://blocks/20260101000008-hhhhhhh'),
		true,
	);
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

Deno.test('convertLocalImages replaces workspace images with a marker', () => {
	const result = convertLocalImages('![配图说明](assets/a.png)');
	assert.equal(result.includes('!['), false);
	assert.equal(result.includes('🖼 配图说明'), true);
});

Deno.test('convertLocalImages keeps remote images intact', () => {
	const md = '![图](https://example.com/a.png)';
	assert.equal(convertLocalImages(md), md);
});

Deno.test('convertLocalImages labels images without a caption', () => {
	assert.equal(convertLocalImages('![](assets/a.png)'), '🖼 图片');
});

Deno.test('stripInlineHtml handles div and br', () => {
	const result = stripInlineHtml('<div>包裹的内容</div>\n第一行<br>第二行');
	assert.equal(result.includes('<div'), false);
	assert.equal(result.includes('<br'), false);
	assert.equal(result.includes('包裹的内容'), true);
	assert.equal(result.includes('第一行\n第二行'), true);
});

Deno.test('countWordsDetailed splits CJK and Latin counts', () => {
	assert.deepEqual(countWordsDetailed('你好 hello world'), {
		cjk: 2,
		latin: 2,
	});
	assert.deepEqual(countWordsDetailed(''), { cjk: 0, latin: 0 });
});

Deno.test('estimateReadTimeDetailed scores each script separately', () => {
	// 400 CJK chars -> 1 min; 200 Latin words -> 1 min; together -> 2 min.
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

Deno.test('formatPathBreadcrumb keeps segments when nothing matches', () => {
	assert.equal(
		formatPathBreadcrumb('/项目A/子目录/文档名', {
			dropFirst: '不存在的笔记本',
			dropLast: '不存在的文档',
		}),
		'项目A / 子目录 / 文档名',
	);
});

Deno.test('formatPathBreadcrumb never empties the breadcrumb', () => {
	// A root-level document's only segment is itself: dropping it would leave
	// an empty path, so it must be preserved.
	assert.equal(
		formatPathBreadcrumb('/文档名', { dropLast: '文档名' }),
		'文档名',
	);
});

Deno.test('cleanMarkdown leaves no SiYuan markup artifacts', () => {
	// One document exercising every construct at once must come out clean.
	const md = [
		'---',
		'title: 综合测试',
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
	const artifacts = [
		'---',
		'{{{',
		'}}}',
		'((',
		'))',
		'==',
		'<span',
		'<div',
		'![',
	];
	for (const bad of artifacts) {
		assert.equal(result.includes(bad), false, `残留语法: ${bad}`);
	}
	assert.equal(result.includes('「文本」'), true);
	assert.equal(result.includes('**重点内容**'), true);
	assert.equal(result.includes('🖼 配图'), true);
});
