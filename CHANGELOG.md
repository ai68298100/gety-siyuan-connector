# Changelog

All notable changes to this project are documented in this file.

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
