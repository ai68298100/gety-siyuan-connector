/**
 * Display-pipeline diagnostic (temporary dev tool).
 *
 * Two modes:
 *  1. `--live`  : pull real documents from the running SiYuan kernel. Requires
 *                 a valid GETY_CONFIG_API_TOKEN in .env. Reports aggregated
 *                 defect counts only — never prints note body text.
 *  2. default   : run a fixture suite that reproduces every SiYuan Markdown
 *                 export construct we know about, and report which ones leak
 *                 raw syntax into the rendered output.
 *
 * Usage: deno run -A --env-file=.env dev/display-diagnose.ts [--live] [n]
 */
import { SiyuanBlock, SiYuanClient } from '../src/siyuan-client.ts';
import {
	buildContentHeader,
	cleanMarkdown,
	extractTags,
	formatPathBreadcrumb,
	iconCodepointToEmoji,
	stripDuplicateH1,
	toRfc3339,
	truncateTitle,
} from '../src/utils.ts';

const argList: string[] = Array.isArray(Deno.args) ? [...Deno.args] : [];
const liveMode = argList.includes('--live');
const sampleSize = Number(argList.find((a) => /^\d+$/.test(a))) || 40;

/**
 * Fixtures reproducing SiYuan's Markdown export constructs.
 * Bodies are synthetic — no real note content.
 */
const FIXTURES: Array<{ name: string; title: string; md: string }> = [
	{
		name: 'YAML frontmatter',
		title: '带元数据的文档',
		md:
			'---\ntitle: 带元数据的文档\nid: 20260101000008-hhhhhhh\n---\n\n正文内容在这里。',
	},
	{
		name: '块引用（带文本）',
		title: '引用测试',
		md:
			'# 引用测试\n\n上会项目：((20260101000001-aaaaaaa "公司A"))、((20260101000002-bbbbbbb "公司B"))。',
	},
	{
		name: '块引用（无文本）',
		title: '无文本引用',
		md: '# 无文本引用\n\n参见 ((20260101000001-aaaaaaa)) 处的说明。',
	},
	{
		name: '嵌入块（多行 row）',
		title: '嵌入测试',
		md: '# 嵌入测试\n\n{{{row\n被嵌入的内容第一行\n第二行\n}}}',
	},
	{
		name: '嵌入块（带 id 属性）',
		title: '嵌入带属性',
		md:
			'# 嵌入带属性\n\n{{{row id="20260101000008-hhhhhhh"\n\n}}}\n\n后续正文。',
	},
	{
		name: '嵌入块（col 布局）',
		title: '嵌入 col',
		md: '# 嵌入 col\n\n{{{col\n列内容\n}}}',
	},
	{
		name: '高亮语法 ==x==',
		title: '高亮测试',
		md: '# 高亮测试\n\n这里是一段 ==被高亮的内容== 和其余文字。',
	},
	{
		name: 'HTML span 标签',
		title: 'span 测试',
		md: '# span 测试\n\n<span data-type="text">📄</span> 带图标的文本段落。',
	},
	{
		name: 'HTML div / br 标签',
		title: 'div br 测试',
		md: '# div br 测试\n\n<div>包裹的内容</div>\n第一行<br>第二行',
	},
	{
		name: '图片 assets 路径',
		title: '图片测试',
		md:
			'# 图片测试\n\n![配图说明](assets/image-20260101000008-hhhhhhh.png)\n\n图片后的文字。',
	},
	{
		name: '数学公式',
		title: '公式测试',
		md: '# 公式测试\n\n行内公式 $E=mc^2$ 和块级公式：\n\n$$\\int_0^1 x^2 dx$$',
	},
	{
		name: '零宽字符',
		title: '零宽测试',
		md: '# 零宽测试\n\n段落一\u200B内容\n\n\uFEFF段落二内容',
	},
	{
		name: '多级标题（标签污染检测）',
		title: '会议记录',
		md:
			'# 会议记录\n\n## 项目进展\n\n讨论了一些事情 #尽职调查 相关内容。\n\n## 后续安排\n\n继续跟进。',
	},
	{
		name: '单井号 H1 非标题行',
		title: '标签边界',
		md:
			'# 标签边界\n\n#这不是标签 因为井号后无空格\n\n# 这是 H1 会被误判为标签\n\n真正的标签：#工作',
	},
	{
		name: '表格',
		title: '表格测试',
		md:
			'# 表格测试\n\n| 项目 | 金额 | 备注 |\n| --- | --- | --- |\n| A | 100 | 无 |\n| B | 200 | 无 |',
	},
	{
		name: '代码块',
		title: '代码测试',
		md: '# 代码测试\n\n```\nconst x = 1;\nconsole.log(x);\n```',
	},
	{
		name: '连续空行',
		title: '空行测试',
		md: '# 空行测试\n\n第一段\n\n\n\n\n第二段',
	},
	{
		name: '超长标题',
		title:
			'这是一个非常长的文档标题用于测试在搜索结果列表中标题过长时是否会撑破布局导致显示异常需要截断处理',
		md:
			'# 这是一个非常长的文档标题用于测试在搜索结果列表中标题过长时是否会撑破布局导致显示异常需要截断处理\n\n正文。',
	},
	{
		name: '空文档',
		title: '空文档标题',
		md: '',
	},
	{
		name: '纯标题无正文',
		title: '只有标题',
		md: '# 只有标题\n',
	},
];

/** Patterns indicating un-rendered SiYuan syntax leaking into display. */
const ARTIFACT_PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: '嵌入块残留 {{{', re: /\{\{\{/ },
	{ name: '嵌入块残留 }}}', re: /\}\}\}/ },
	{ name: '块引用残留 ((', re: /\(\(\d{14}-/ },
	{ name: '高亮语法 ==x==', re: /==\S/ },
	{ name: 'HTML span 标签', re: /<span[^>]*>/i },
	{ name: 'HTML div 标签', re: /<div[^>]*>/i },
	{ name: 'HTML br 标签', re: /<br\s*\/?>/i },
	{ name: '其他 HTML 标签', re: /<(?!span|div|br)[a-z][a-z0-9]*[\s>]/i },
	{ name: '图片 assets/', re: /!\[[^\]]*\]\([^)]*assets\// },
	{ name: '裸 siyuan://', re: /(?<!\]\()siyuan:\/\// },
	{ name: '零宽字符', re: /[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/ },
	{ name: 'YAML frontmatter', re: /^---\s*$/m },
	{ name: '连续空行(3+)', re: /\n{3,}/ },
	{ name: '空行后紧跟引用符', re: /\n> \n/ },
];

/** Render one document through the current pipeline, mirroring index.ts. */
function render(
	raw: string,
	rawTitle: string,
	notebookName: string,
	notebookIcon: string | undefined,
	hpath: string,
	updated: string,
) {
	let content = cleanMarkdown(raw);
	content = stripDuplicateH1(content, rawTitle);
	content = content.trim() || '*（暂无内容）*';
	const updatedAt = toRfc3339(updated);
	// Mirror index.ts: drop breadcrumb segments already shown in the title.
	const pathBreadcrumb = formatPathBreadcrumb(hpath, {
		dropFirst: notebookName || undefined,
		dropLast: rawTitle,
	});
	const tags = extractTags(content);
	const iconEmoji = iconCodepointToEmoji(notebookIcon);
	const titleCore = `${truncateTitle(rawTitle)} · ${notebookName}`;
	const title = iconEmoji ? `${iconEmoji} ${titleCore}` : titleCore;
	const header = buildContentHeader(
		pathBreadcrumb || undefined,
		updatedAt,
		content,
		tags,
	);
	return { title, content, header, full: header + content, tags };
}

const NB = '示例笔记本';
const NB_ICON = '1f4d4'; // 📔
const HPATH = '/示例笔记本/子目录/文档';

// ───────────────────────── fixture mode ─────────────────────────
if (!liveMode) {
	console.log('════════ 显示管线诊断（fixture 模式）════════');
	console.log(`思源导出语法样本: ${FIXTURES.length} 组\n`);

	const rows: Array<{ name: string; defects: string[] }> = [];
	const defectCount = new Map<string, number>();

	for (const fx of FIXTURES) {
		const r = render(fx.md, fx.title, NB, NB_ICON, HPATH, '20260823153045');
		const defects: string[] = [];
		for (const p of ARTIFACT_PATTERNS) {
			if (p.re.test(r.full)) {
				defects.push(p.name);
				defectCount.set(p.name, (defectCount.get(p.name) ?? 0) + 1);
			}
		}
		// Extra semantic checks.
		if (
			r.tags.split(',').some((t) =>
				t === '会议记录' || t === '这是H1会被误判为标签'
			)
		) {
			defects.push('标签被标题污染');
			defectCount.set(
				'标签被标题污染',
				(defectCount.get('标签被标题污染') ?? 0) + 1,
			);
		}
		if (r.title.length > 60) {
			defects.push(`标题过长(${r.title.length}字)`);
			defectCount.set('标题过长', (defectCount.get('标题过长') ?? 0) + 1);
		}
		if (r.header.includes(NB) && r.title.includes(NB)) {
			defects.push('标题/头部重复笔记本名');
			defectCount.set(
				'标题/头部重复笔记本名',
				(defectCount.get('标题/头部重复笔记本名') ?? 0) + 1,
			);
		}
		rows.push({ name: fx.name, defects });
	}

	console.log('【逐样本结果】');
	for (const row of rows) {
		const mark = row.defects.length === 0 ? '✓' : '✗';
		const detail = row.defects.length === 0 ? '正常' : row.defects.join('、');
		console.log(`  ${mark} ${row.name.padEnd(22)} ${detail}`);
	}

	console.log('\n【问题汇总】(影响样本数)');
	const sorted = [...defectCount.entries()].sort((a, b) => b[1] - a[1]);
	if (sorted.length === 0) {
		console.log('  ✓ 未检出显示残留');
	} else {
		for (const [name, n] of sorted) {
			console.log(`  ✗ ${name.padEnd(24)} ${n} / ${FIXTURES.length} 个样本`);
		}
	}
	console.log('');
	Deno.exit(0);
}

// ───────────────────────── live mode ─────────────────────────
const apiUrl = Deno.env.get('GETY_CONFIG_API_URL') || 'http://localhost:6806';
const apiToken = Deno.env.get('GETY_CONFIG_API_TOKEN') || '';
const client = new SiYuanClient(apiUrl, apiToken, AbortSignal.timeout(30_000));

console.log('════════ 显示管线诊断（真实数据模式）════════');
try {
	console.log(`思源内核: v${await client.version()}`);
} catch (err) {
	console.error(`✗ 无法连接思源内核: ${(err as Error).message}`);
	Deno.exit(1);
}

let notebooks;
try {
	notebooks = (await client.lsNotebooks()).filter((n) => !n.closed);
} catch (err) {
	console.error(
		`✗ 笔记本列表获取失败（API token 可能已失效）: ${(err as Error).message}`,
	);
	Deno.exit(1);
}
console.log(`开放笔记本: ${notebooks.length} 个`);

const docs: SiyuanBlock[] = [];
for (const nb of notebooks) {
	docs.push(...(await client.listDocBlocks(nb.id)));
}
console.log(
	`文档总数: ${docs.length}，采样: ${Math.min(sampleSize, docs.length)}\n`,
);

const step = Math.max(1, Math.floor(docs.length / sampleSize));
const sample: SiyuanBlock[] = [];
for (let i = 0; i < docs.length && sample.length < sampleSize; i += step) {
	sample.push(docs[i]);
}

const nbNames = new Map<string, string>();
const nbIcons = new Map<string, string>();
for (const nb of notebooks) {
	nbNames.set(nb.id, nb.name);
	if (nb.icon) nbIcons.set(nb.id, nb.icon);
}

const liveDefects = new Map<string, number>();
const titleLengths: number[] = [];
let emptyContent = 0;
let byteDelta = 0;

for (const doc of sample) {
	let raw = '';
	try {
		raw = (await client.exportMdContent(doc.id)).content ?? '';
	} catch {
		raw = '';
	}
	if (!raw.trim()) emptyContent++;

	const rawTitle = doc.content || doc.hpath || doc.id;
	const notebookName = nbNames.get(doc.box ?? '') ?? '';
	const notebookIcon = nbIcons.get(doc.box ?? '');
	const r = render(
		raw,
		rawTitle,
		notebookName,
		notebookIcon,
		doc.hpath ?? '',
		doc.updated ?? '',
	);

	for (const p of ARTIFACT_PATTERNS) {
		if (p.re.test(r.full)) {
			liveDefects.set(p.name, (liveDefects.get(p.name) ?? 0) + 1);
		}
	}
	titleLengths.push(rawTitle.length);
	byteDelta += new TextEncoder().encode(r.full).length - r.full.length;
}

console.log('【残留语法 / 显示噪音】');
if (liveDefects.size === 0) {
	console.log('  ✓ 未检出显示残留');
} else {
	for (
		const [name, n] of [...liveDefects.entries()].sort((a, b) => b[1] - a[1])
	) {
		const pct = ((n / sample.length) * 100).toFixed(1);
		console.log(`  ✗ ${name.padEnd(24)} ${String(n).padStart(3)} 篇 (${pct}%)`);
	}
}

const maxLen = Math.max(...titleLengths, 0);
const avgLen = Math.round(
	titleLengths.reduce((a, b) => a + b, 0) / (titleLengths.length || 1),
);
console.log('\n【标题 / 元数据】');
console.log(`  标题长度: 平均 ${avgLen} 字, 最长 ${maxLen} 字`);
console.log(`  超 50 字: ${titleLengths.filter((l) => l > 50).length} 篇`);
console.log(`  空文档: ${emptyContent} 篇`);
console.log(
	`  original_file_size 低估: 平均每篇 ${
		Math.round(byteDelta / (sample.length || 1))
	} 字节（按字符数计而非字节数）`,
);
console.log('\n诊断完成（未输出任何笔记正文）。');
