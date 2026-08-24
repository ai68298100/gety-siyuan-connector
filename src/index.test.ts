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
	countWords,
	estimateReadTime,
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
	const path = '/20260823120000-abc123/20260823130000-def456';
	assert.equal(extractParentDocId(path), '20260823130000-def456');
});

Deno.test('extractParentDocId handles 20-char ID format', () => {
	const path = '/20260823120000-20260823120000-abc12345';
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
		'---\ntitle: 2020年日记\ndate: 2024-05-22T09:02:18+08:00\n---\n\n# 2020年日记\n\n内容';
	const result = cleanMarkdown(input);
	assert.equal(result.startsWith('---'), false);
	assert.match(result, /^# 2020年日记/);
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
		buildDisplayTitle('2020年日记', 'DailyNote'),
		'2020年日记 · DailyNote',
	);
	assert.equal(buildDisplayTitle('标题', undefined), '标题');
	assert.equal(buildDisplayTitle('标题', ''), '标题');
});

Deno.test('formatPathBreadcrumb converts hpath to readable breadcrumb', () => {
	assert.equal(
		formatPathBreadcrumb('/安徽金宣/金宣-投资项目/公司名'),
		'安徽金宣 / 金宣-投资项目 / 公司名',
	);
	assert.equal(formatPathBreadcrumb('/2020年日记'), '2020年日记');
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
		stripDuplicateH1('# 2020年日记\n\n正文', '2020年日记'),
		'正文',
	);
	assert.equal(
		stripDuplicateH1('# 2020年日记\n\n正文', '2020年日记 · DailyNote'),
		'正文',
	);
	// H1 doesn't match title — keep it.
	assert.equal(
		stripDuplicateH1('# 其他标题\n正文', '2020年日记'),
		'# 其他标题\n正文',
	);
});

Deno.test('buildContentHeader generates blockquote with notebook info', () => {
	const header = buildContentHeader(
		'DailyNote',
		'1f4d4',
		'2020年日记',
		'2026-03-22T22:02:13.000Z',
	);
	assert.equal(header.startsWith('> '), true);
	assert.equal(header.includes('📔'), true);
	assert.equal(header.includes('DailyNote'), true);
	assert.equal(header.includes('2020年日记'), true);
	assert.equal(header.includes('2026-03-22'), true);
});

Deno.test('buildContentHeader returns empty for no input', () => {
	assert.equal(
		buildContentHeader(undefined, undefined, undefined, undefined),
		'',
	);
});

Deno.test('convertBlockRefs converts ((id "text")) to quoted reference', () => {
	const input = '前文 ((20260307230420-xyno4aj "引用内容")) 后文';
	const result = convertBlockRefs(input);
	assert.equal(result.includes('((20260307230420'), false);
	assert.equal(
		result.includes('「引用内容」[↗](siyuan://blocks/20260307230420-xyno4aj)'),
		true,
	);
});

Deno.test('convertBlockRefs handles single quotes', () => {
	const input = "((20240626111812-rqqp2j0 '疌泉新材料'))";
	const result = convertBlockRefs(input);
	assert.equal(result.includes('「疌泉新材料」'), true);
	assert.equal(result.includes('siyuan://blocks/20240626111812-rqqp2j0'), true);
});

Deno.test('convertBlockRefs handles multiple inline refs in a sentence', () => {
	const input =
		'上会项目：((20260327133933-ui6a7kx "安徽晶镁光罩有限公司"))、((20260327133938-9puiyeo "合肥星能玄光科技有限责任公司"))';
	const result = convertBlockRefs(input);
	assert.equal(result.includes('「安徽晶镁光罩有限公司」'), true);
	assert.equal(result.includes('「合肥星能玄光科技有限责任公司」'), true);
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
		'链接 [📑](siyuan://blocks/20240626150912-qvfqkr2) 和 [📄](siyuan://blocks/20260122172745-1sqymrt)';
	const links = extractLinks(md);
	assert.equal(links.includes('20240626150912-qvfqkr2'), true);
	assert.equal(links.includes('20260122172745-1sqymrt'), true);
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
		'DailyNote',
		'1f4d4',
		'2020年日记',
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
