# Gety Connector for SiYuan Note

A [Gety](https://gety.ai) connector that indexes documents from a local
[SiYuan Note](https://b3log.org/siyuan/) kernel via its HTTP API, making your
notebooks fully searchable in Gety — alongside local files and other sources.

每个思源笔记文档被导出为 Markdown 并在 Gety 中全文检索，点击搜索结果即可通过
`siyuan://` 协议跳回思源打开对应文档进行编辑。

## Features

- **文档级索引** — 最小索引单位是思源文档（不索引细碎的内容块），
  全部文档自动纳入检索
- **Markdown 全文搜索** — 思源文档导出为 Markdown，支持 Gety 全文检索与高亮
- **一键跳转编辑** — 点击搜索结果通过 `siyuan://blocks/<id>`
  协议在思源中打开对应文档
- **增量同步** — 基于文档 `updated` 时间戳增量拉取，只更新变更的文档
- **删除检测** — 文档被删除/移出笔记本后自动从 Gety 索引中移除
- **丰富元数据** — 笔记本名、路径面包屑、标签、双链关系均可搜索
- **内容美化** — 自动清理 YAML
  frontmatter、零宽字符、思源专有语法（块引用/嵌入块），转换双链为标准 Markdown

## 内容处理管线

思源导出的 Markdown 经过 7 步清理与美化，确保在 Gety 中显示干净美观：

| 步骤              | 处理                        | 示例                                      |
| ----------------- | --------------------------- | ----------------------------------------- |
| 1. 去 frontmatter | 移除 YAML 元数据块          | `---\ntitle:...\n---` → 移除              |
| 2. 去零宽字符     | 移除不可见 Unicode          | `‍` U+200D → 移除                          |
| 3. 去内联 HTML    | 移除思源嵌入的 span 标签    | `<span data-type="text">📄</span>` → `📄` |
| 4. 块引用转换     | `((id "文本"))` → 内联引用  | `「文本」[↗](siyuan://blocks/id)`         |
| 5. 嵌入块清理     | `{{{row ...}}}` → 引用块    | `> 内容`                                  |
| 6. 去重 H1        | 移除与标题重复的 H1         | `# 标题` → 移除                           |
| 7. 双链提取       | 收集 siyuan:// 链接到元数据 | `metadata.links`                          |

搜索结果头部显示信息条：

```
> 📔 日记本 · 示例文档标题
> 📅 3天前 · 📝 2,400 字 · ⏱ 6 分钟
> 🏷️ #标签1 #标签2 #标签3
```

## Prerequisites / 前置要求

- **Gety** v0.5.1 or newer
- **SiYuan Note** running locally with the kernel HTTP API enabled (default
  `http://localhost:6806`)
- **Deno** v2.x (only required to rebuild `dist/main.js`; a prebuilt bundle is
  included)

## Install in Gety / 安装

1. Open **Gety → Settings → Connectors**.
2. Click **Install connector**.
3. Select this connector's root folder (the one containing `manifest.json`).
4. Fill in the two required config fields (below).
5. Confirm install, then click **Update now** for the first index.

安装后在 Gety → Settings → Connectors 中点击 **Update now** 触发首次索引
（视文档数量而定，通常 1-2 分钟）。之后默认每 30 分钟增量同步一次。

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
   - `tags` — 思源 `#标签`
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

### Exercise the lifecycle locally / 本地试跑

```bash
cp .env.example .env
# 编辑 .env 填入 GETY_CONFIG_API_URL 和 GETY_CONFIG_API_TOKEN
deno task runner -- --reset-state
```

输出快照在 `dev/runs/<timestamp>/`，可用 `--polls 2` 验证增量同步。

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

## Repository structure / 项目结构

```text
manifest.json          # Connector manifest (id/name/config/icon/schedule)
src/index.ts           # Connector implementation (poll lifecycle)
src/siyuan-client.ts   # SiYuan kernel HTTP API client
src/utils.ts           # Pure content-cleaning helpers
src/index.test.ts      # Unit tests (37)
dist/main.js           # Built bundle loaded by Gety
icon.svg / icon.png    # SiYuan logo icons
scripts/               # Build tooling (esbuild bundler)
dev/                   # SDK + local runner + test harness
```

## Version history / 版本历史

- **v0.3.2** — 修复单引号块引用转换、内联块引用破坏文本流、HTML span 清理
- **v0.3.1** — 更换思源 logo 图标；配置精简为 2 字段
- **v0.3.0** — 最小单位改为文档级索引（移除块级索引）
- **v0.2.0** — 中英双语配置、相对日期、字数统计、阅读时间、标签条
- **v0.1.0** — 初始版本：基础索引 + 增量同步 + 删除检测

## License / 许可证

[MIT](LICENSE) © 2026 WorkBuddy User
