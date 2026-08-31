# Gety Connector for SiYuan Note

A [Gety](https://gety.ai) connector that indexes documents from a local
[SiYuan Note](https://b3log.org/siyuan/) kernel via its HTTP API, making your
notebooks fully searchable in Gety — alongside local files and other sources.

每个思源笔记文档被导出为 Markdown 并在 Gety 中全文检索，点击搜索结果即可通过
`siyuan://` 协议跳回思源打开对应文档进行编辑。

## Features

- **文档级索引** — 最小索引单位是思源文档（不索引细碎的内容块），
  全部文档自动纳入检索
- **快速并发索引** — 最多 6 个文档并行导出 Markdown，首次索引提速 3-5 倍
- **增量同步** — 基于 SQL `updated` 时间戳增量拉取，稳态下只查询变更文档，
  不再全量扫描
- **删除检测** — 文档被删除/移出笔记本后自动从 Gety 索引中移除
- **代码块保护** — 围栏代码块、行内代码、数学公式在清理过程中被完整保护，
  代码中的 `==`、`(( ))`、HTML 标签、空行不会被误转换
- **frontmatter 标签** — 思源文档 YAML 中的 `tags:` 字段被提取并索引， 不再随
  frontmatter 一起丢弃
- **一键跳转编辑** — 点击搜索结果通过 `siyuan://blocks/<id>`
  协议在思源中打开对应文档
- **丰富元数据** — 笔记本名、路径面包屑、标签、双链关系均可搜索
- **内容美化** — 自动清理 YAML frontmatter、零宽字符、思源专有语法
  （块引用/嵌入块/高亮），转换双链为标准 Markdown
- **本地资源分类** — 图片🖼、音频🎵、视频🎬、附件📎 分别标记，避免破图

## 内容处理管线

思源导出的 Markdown 经过 12 步清理与美化，确保在 Gety 中显示干净美观：

| 步骤              | 处理                                                 | 示例                                                     |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| 0. 保护代码与公式 | 围栏代码、行内代码、`$...$` / `$$...$$` 替换为占位符 | 代码块内容不被后续步骤破坏                               |
| 1. 去 frontmatter | 移除 YAML 元数据块（先提取其中的 `tags:`）           | `---\ntitle:...\n---` → 移除                             |
| 2. 去零宽字符     | 移除不可见 Unicode（U+200B/200D/FEFF 等）            | 移除                                                     |
| 3. 去内联 HTML    | 移除思源嵌入的标签（含 table/list/media 包装器）     | `<span data-type="text">📄</span>` → `📄`；`<br>` → 换行 |
| 4. 块引用转换     | `((id "文本"))` → 内联引用，含无文本 `((id))`        | `「文本」[↗](siyuan://blocks/id)`                        |
| 5. 嵌入块清理     | `{{{row ...}}}` / `{{{col ...}}}` → 引用块           | `> 内容`；空嵌入块 → 源块链接                            |
| 6. 高亮转换       | `==高亮==` → `**加粗**`（Markdown 无高亮语法）       | `==重点==` → `**重点**`                                  |
| 7. 本地资源转换   | 工作区文件按类型标记：图片🖼、音频🎵、视频🎬、附件📎  | `![图](assets/a.png)` → `🖼 图`                           |
| 8. 压缩空行       | 3+ 连续空行 → 1 个空行（代码块内不受影响）           | —                                                        |
| 9. 恢复代码与公式 | 将占位符还原为原始代码/公式                          | 代码块完整恢复                                           |
| 10. 去重 H1       | 移除与标题重复的 H1                                  | `# 标题` → 移除                                          |
| 11. 双链提取      | 收集 siyuan:// 链接到元数据                          | `metadata.links`                                         |

### 标题与内容头部的分工

标题已经包含笔记本图标与名称，内容头部采用 **compact
模式**，只显示路径和更新时间，
为正文预留更多搜索预览空间。字数、阅读时长、标签等信息存储在 `metadata` 中，
可通过 Gety 的元数据筛选使用：

- 标题：`📔 示例文档标题 · 日记本`
- 内容头部：父路径（如有）、更新时间

```
> 📁 子目录
> 📅 3天前
```

根目录下的文档没有父路径，内容头部只显示更新时间。超长标题会截断到 60
字，避免撑破结果列表的布局。

## Prerequisites / 前置要求

- **Gety** v0.5.1 or newer
- **SiYuan Note** running locally with the kernel HTTP API enabled (default
  `http://localhost:6806`)
- **Deno** v2.x (only required to rebuild `dist/main.js`; a prebuilt bundle is
  included)

## Install in Gety / 安装

### 方式一：从 Release 下载（推荐）

1. 前往 [Releases](https://github.com/ai68298100/gety-siyuan-connector/releases)
   下载最新的 `gety-siyuan-connector-<version>.zip`
2. 解压到任意目录
3. 打开 **Gety → Settings → Connectors**
4. 点击 **Install connector**，选择解压后的文件夹（包含 `manifest.json`）
5. 填写配置字段，确认安装后点击 **Update now**

### 方式二：从源码安装

1. Clone 或下载本仓库
2. （可选）运行 `deno task build` 重新构建 `dist/main.js`
3. 在 Gety 中选择仓库根文件夹安装

安装后在 Gety → Settings → Connectors 中点击 **Update now** 触发首次索引
（视文档数量而定，并发模式下通常 30 秒-1 分钟）。之后默认每 30
分钟增量同步一次。

## Configuration / 配置

| Field 字段              | Type     | Required | Description                                                 |
| ----------------------- | -------- | -------- | ----------------------------------------------------------- |
| `api_url` 思源 API 地址 | text     | yes      | SiYuan kernel API base URL, default `http://localhost:6806` |
| `api_token` API 令牌    | password | yes      | SiYuan API token from **Settings → About → API token**      |

### 获取 API Token

1. 打开思源笔记
2. 进入 **设置 → 关于 → API token**
3. 复制 token 填入连接器配置

## Usage / 使用

1. 在 Gety 搜索框中输入关键词，即可检索所有思源笔记文档。
2. 点击搜索结果（链接图标），Gety 调用 `siyuan://blocks/<doc-id>` 协议，
   自动打开思源并定位到该文档，可直接编辑。
3. 可用元数据字段辅助筛选搜索：
   - `notebook` — 笔记本 ID
   - `notebook_name` — 笔记本名（如 `工作笔记`、`个人日记`）
   - `doc_path` — 文档路径（如 `项目A / 子目录 / 文档`）
   - `tags` — 思源标签（含 frontmatter 中的 `tags:` 和正文 `#标签`）
   - `links` — 文档内双链指向的块 ID

## Local development / 本地开发

### Rebuild / 重新构建

```bash
deno task build
```

### Verify / 验证

```bash
deno task verify
```

包含格式化检查、lint、单元测试（59 个）和构建。

### Exercise the lifecycle locally / 本地试跑

```bash
cp .env.example .env
# 编辑 .env 填入 GETY_CONFIG_API_URL 和 GETY_CONFIG_API_TOKEN
deno task runner -- --reset-state
```

输出快照在 `dev/runs/<timestamp>/`，可用 `--polls 2` 验证增量同步。

### Debug logging / 调试日志

连接器内部的 `console` 输出会被 Gety 重定向到
IPC，在应用日志里看不到。需要排查时，用环境变量指定日志文件路径即可开启：

```bash
# Windows
set SIYUAN_CONNECTOR_DEBUG_LOG=C:\Users\you\siyuan-connector-debug.log
# macOS / Linux
export SIYUAN_CONNECTOR_DEBUG_LOG=/tmp/siyuan-connector-debug.log
```

**默认关闭**：不设置该变量时不会写入任何文件。日志采用缓冲写入（每 50 条 或 poll
结束时 flush），减少文件 IO。日志会记录 `onLoad` 与每次 `poll`
的文档数、批次信息，可能包含笔记本名称，请按需开启并自行保管。

### Diagnose display issues / 显示诊断

用一组覆盖思源各类导出语法的样本跑一遍渲染管线，报告残留语法与显示缺陷：

```bash
deno run -A dev/display-diagnose.ts
```

配置好 `.env` 后，可以对真实笔记做只读诊断 —— 只输出缺陷统计，**不会打印
笔记正文**：

```bash
deno run -A --env-file=.env dev/display-diagnose.ts --live 40
```

## Troubleshooting / 排错

### `Could not reach SiYuan kernel at http://localhost:6806`

- 确认思源正在运行
- 确认 API 地址正确（思源默认 6806 端口）
- 如果思源配置了其他端口，修改 `api_url`

### `HTTP 401` / `Auth failed`

- API 令牌为空或错误
- 在思源 **设置 → 关于** 重新获取 token 并填入
- 如果思源关闭了鉴权，仍建议填入 token（思源会忽略无效 token）

### 搜索结果中没有思源内容

- 确认连接器已 **Enable**，配置字段已填写
- 点击 **Update now** 手动触发索引
- 检查 `dev/runs/<timestamp>/summary.json` 查看索引统计

### 点击搜索结果无法跳转思源

- 确认思源正在运行
- 确认 Windows 上 `siyuan://` 协议已注册（安装思源时会自动注册）
- 若协议缺失，重装思源即可恢复

### 代码块内容显示异常

v0.4.0 已加入代码块保护机制。如果仍有异常，请运行显示诊断工具
（`deno run -A dev/display-diagnose.ts`）并提交 Issue。

## Repository structure / 项目结构

```text
manifest.json          # Connector manifest (id/name/config/icon/schedule)
src/index.ts           # Connector implementation (poll lifecycle, concurrent export)
src/siyuan-client.ts   # SiYuan kernel HTTP API client (incremental SQL queries)
src/utils.ts           # Pure content-cleaning helpers (code protection, tag extraction)
src/index.test.ts      # Unit tests (59)
dist/main.js           # Built bundle loaded by Gety
icon.svg / icon.png    # SiYuan logo icons
scripts/               # Build tooling (esbuild bundler)
dev/                   # SDK + local runner + test harness
```

## Version history / 版本历史

- **v0.4.1** — 修复 Release 打包缺失 `dist/` 目录、导出失败永不重试 （新增
  `pendingRetry` 机制）、关闭笔记本导致文档被误删；新增 `listDocsByIds`
  与对应单元测试
- **v0.4.0** — 并发导出（6 并发）、增量 SQL 查询、代码块/公式保护、 frontmatter
  标签提取、本地资源分类（音视频附件）、compact 内容头部、 debug 日志缓冲、统一
  ID 正则（支持新版 20+ 字符 ID）、移除死代码、 测试增至 56 个
- **v0.3.3** — 修复搜索结果重复上下文、裸块引用、嵌入块、HTML 标签、
  高亮语法、本地图片、空文档回退、文件大小计算
- **v0.3.2** — 修复单引号块引用转换、内联块引用破坏文本流、HTML span 清理
- **v0.3.1** — 更换思源 logo 图标；配置精简为 2 字段
- **v0.3.0** — 最小单位改为文档级索引（移除块级索引）
- **v0.2.0** — 中英双语配置、相对日期、字数统计、阅读时间、标签条
- **v0.1.0** — 初始版本：基础索引 + 增量同步 + 删除检测

## License / 许可证

[MIT](LICENSE) © 2026 WorkBuddy User
