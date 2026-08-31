# Changelog

All notable changes to this project are documented in this file.

## [0.4.1] - 2026-08-31

### Fixed

- **Release zip was missing `dist/`** — the packaging step copied `dist/main.js`
  into the zip root, but the manifest `entry` points to `dist/main.js`, so the
  packaged connector could not be loaded. The zip now preserves the `dist/`
  directory structure.
- **Failed exports were never retried** — a document whose `exportMdContent`
  call failed was still recorded in the sync state, so the incremental query
  (keyed on `updated`) would skip it forever. Failed docs are now tracked in a
  `pendingRetry` state field and re-fetched by ID on the next poll.
- **Closing a notebook dropped its documents permanently** — deletion detection
  only looked at open notebooks, so closing (not deleting) a notebook marked
  every document as removed; reopening could not restore them because the
  incremental query had advanced past their timestamps. Live-ID detection now
  covers all notebooks including closed ones.

### Added

- **`listDocsByIds`** — new client method to re-fetch document metadata by ID,
  powering the failed-export retry.
- **`siyuan-client.test.ts`** — unit tests for `listDocsByIds` SQL construction,
  escaping, and empty-input handling (3 tests).

## [0.4.0] - 2026-08-31

### Added

- **Concurrent Markdown export** — up to 6 `exportMdContent` requests run in
  parallel during a poll, cutting first-time index time by roughly 3-5x
- **Incremental SQL query** (`listDocBlocksSince`) — steady-state polls fetch
  only documents whose `updated` timestamp advanced since the last sync, instead
  of scanning every notebook
- **Lightweight ID query** (`listDocIds`) — deletion detection now pulls only
  document IDs, avoiding a full metadata scan
- **Frontmatter tag extraction** — tags declared in the YAML frontmatter
  (`tags: [a, b]`) are now indexed; previously they were discarded with the
  frontmatter
- **Code-block protection** — fenced code, inline code, and math spans are
  shielded from all regex transforms so `==`, `(( ))`, HTML tags, and blank
  lines inside code are preserved verbatim
- **Unified block-ID pattern** — block references and links now match both
  legacy `YYYYMMDDHHmmss-hash` IDs and newer 20+ character pure-alphanumeric IDs
- **Local asset classification** — workspace files are marked by type: images 🖼,
  audio 🎵, video 🎬, other attachments 📎
- **Compact content header** — the blockquote header now shows only path and
  date by default, leaving more preview room for the document body
- **Buffered debug logging** — log lines accumulate in memory and flush in
  batches, eliminating per-line file IO

### Fixed

- **Code blocks were corrupted by cleaning passes** — `==` inside code became
  `**`, `((id))` was rewritten, HTML tags stripped, blank lines collapsed
- **Frontmatter tags were silently dropped** — `stripFrontmatter` removed the
  YAML block before tags could be read
- **`extractTags` matched code comments** — `#include`, Python `# comment`, and
  shell comments were indexed as tags
- **Block references with new-style IDs were left as raw markup**

### Changed

- Dynamic batch size (20–100) scales with the number of changed documents
- Content header uses compact mode (path + date only); word count, read time,
  and tags remain available via `metadata`
- `convertLocalImages` is now a thin alias for `convertLocalAssets`

### Removed

- Dead code: `buildBlockTitle`, `blockTypeEmoji`, `extractParentDocId`,
  `clampPositiveNumber`, `parseExcludeNotebooks`, `listContentBlocks` (leftovers
  from the removed block-level indexing mode)

### Tests

- Expanded from 37 to 56 unit tests, covering code-block protection, frontmatter
  tags, new ID formats, asset classification, compact headers, and end-to-end
  pipeline cleanliness

## [0.3.3] - 2026-08-31

### Fixed

- **No more duplicated context in search results** — the content header no
  longer repeats the notebook name and icon that the title already shows (this
  affected 100% of indexed documents)
- Breadcrumbs drop a leading segment equal to the notebook name and a trailing
  segment equal to the document title, since both appear in the title
- Bare block references `((id))` with no anchor text now convert to a link
  instead of printing the raw block ID
- Embed blocks with `col` layout, `id="..."` attributes, or empty bodies are now
  cleaned up; previously `{{{row id="..."}}}` leaked into previews
- `<div>` and `<br>` tags are stripped alongside `<span>`; `<br>` becomes a real
  line break instead of disappearing
- SiYuan highlight syntax `==text==` no longer renders as literal equals signs
- Workspace-local images (`![](assets/x.png)`) become a `🖼` text marker instead
  of rendering as broken images
- Empty documents no longer echo their own title back as the body
- `original_file_size` reports byte length instead of UTF-16 code units, which
  under-reported CJK-heavy documents by up to 3x

### Changed

- Reading time scores CJK (~400 chars/min) and Latin (~200 words/min) separately
  rather than applying a single rate to both
- Overlong titles truncate to 60 characters with an ellipsis so they cannot blow
  out the result row layout
- Thousands separators use a fixed locale for deterministic output
- **Debug logging is now opt-in** via `SIYUAN_CONNECTOR_DEBUG_LOG`

### Security

- Removed real company names and SiYuan block IDs that a previous revision had
  committed to `src/index.test.ts`
- Debug logging no longer writes to a hardcoded `C:\Users\<account>\...` path,
  which leaked a Windows account name and failed on other machines

## [0.3.2] - 2026-08-24

### Fixed

- Block references with single quotes (`((id 'text'))`) now convert correctly
  (previous regex only matched double quotes)
- Inline block references no longer break sentence flow — converted to
  `「text」[↗](siyuan://blocks/id)` instead of blockquote markup in mid-sentence
- Strip SiYuan-embedded inline HTML tags (`<span data-type="text">`) from
  content

### Changed

- Removed leftover `page_size` / `exclude_notebooks` config references after
  manifest simplification

## [0.3.1] - 2026-08-24

### Added

- SiYuan Note logo as connector icon (`icon.svg` / `icon.png`)

### Changed

- Config simplified to 2 fields: `api_url` and `api_token`
- Connector display name changed to "Siyuan Note"

## [0.3.0] - 2026-08-24

### Changed

- **Document-level indexing only** — removed `include_block_content` option; the
  minimum index unit is now the SiYuan document, not individual blocks
- Build size reduced from 20KB to 15.1KB

## [0.2.0] - 2026-08-24

### Added

- Bilingual (Chinese/English) config field labels and descriptions
- Relative date display (`刚刚` / `N小时前` / `N天前`)
- Word count and estimated reading time in content header
- Tag strip (`🏷️ #tag1 #tag2`) in content header
- `links` metadata field (outgoing siyuan:// block references)

### Changed

- Poll interval reduced from 3600s to 1800s (30 min)
- `api_token` now required at install time

## [0.1.0] - 2026-08-24

### Added

- Initial release: index SiYuan documents via local HTTP API
- Incremental sync via `knownDocs` state map
- Deletion detection for removed documents
- Content cleaning: YAML frontmatter, zero-width chars, duplicate H1
- Notebook icon/name in titles, path breadcrumbs in content header
- Block reference and embed block conversion to standard Markdown
