// src/index.ts
import {
  Connector,
  del,
  upsert
} from "@gety-ai/connector-sdk";

// src/siyuan-client.ts
var SiYuanError = class extends Error {
  constructor(message, status, endpoint, code) {
    super(message);
    this.status = status;
    this.endpoint = endpoint;
    this.code = code;
    this.name = "SiYuanError";
  }
};
var SiYuanClient = class {
  baseUrl;
  token;
  signal;
  constructor(baseUrl, token, signal) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token && token.length > 0 ? token : void 0;
    this.signal = signal;
  }
  /** Ping the kernel and return its version string. */
  async version() {
    return await this.post("/api/system/version", {});
  }
  /** List all notebooks (open and closed). */
  async lsNotebooks() {
    const data = await this.post(
      "/api/notebook/lsNotebooks",
      {}
    );
    return data.notebooks ?? [];
  }
  /** List all document blocks for a notebook via SQL (full metadata). */
  listDocBlocks(notebookId) {
    const stmt = `SELECT id, content, type, subtype, hpath, path, box, updated, created FROM blocks WHERE type = 'd' AND box = '${this.escapeSql(notebookId)}' ORDER BY path ASC`;
    return this.query(stmt);
  }
  /**
   * List document blocks updated at or after a SiYuan timestamp
   * (YYYYMMDDHHmmss). The inclusive boundary prevents same-second updates
   * from being skipped; callers de-duplicate against their persisted state.
   * Used for incremental sync: only fetches docs whose `updated` advanced
   * since the last poll, avoiding a full metadata scan on steady state.
   */
  listDocBlocksSince(notebookId, sinceTimestamp) {
    const stmt = `SELECT id, content, type, subtype, hpath, path, box, updated, created FROM blocks WHERE type = 'd' AND box = '${this.escapeSql(notebookId)}' AND updated >= '${this.escapeSql(sinceTimestamp)}' ORDER BY path ASC`;
    return this.query(stmt);
  }
  /**
   * List only the IDs of all document blocks in a notebook.
   * Lighter than listDocBlocks (no content/path columns) — used purely for
   * deletion detection (IDs present in state but missing from source).
   */
  listDocIds(notebookId) {
    const stmt = `SELECT id FROM blocks WHERE type = 'd' AND box = '${this.escapeSql(notebookId)}' ORDER BY path ASC`;
    return this.query(stmt);
  }
  /**
   * Fetch full metadata for a specific set of document IDs. Used to retry
   * documents whose export previously failed: incremental queries keyed on
   * the `updated` timestamp cannot rediscover them once the cursor has
   * advanced, so we re-fetch them by ID instead.
   */
  listDocsByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    const quoted = ids.map((id) => `'${this.escapeSql(id)}'`).join(", ");
    const stmt = `SELECT id, content, type, subtype, hpath, path, box, updated, created FROM blocks WHERE type = 'd' AND id IN (${quoted}) ORDER BY path ASC`;
    return this.query(stmt);
  }
  /** Run an arbitrary SQL query against the SiYuan kernel. */
  async query(stmt) {
    return await this.post("/api/query/sql", { stmt });
  }
  /** Export a document as Markdown. */
  exportMdContent(docId) {
    return this.post("/api/export/exportMdContent", {
      id: docId
    });
  }
  async post(endpoint, body) {
    const url = this.baseUrl + endpoint;
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.token) {
      headers["Authorization"] = `token ${this.token}`;
    }
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: this.signal
      });
    } catch (err) {
      if (this.signal.aborted) {
        throw new SiYuanError(
          `Request aborted: ${endpoint}`,
          0,
          endpoint
        );
      }
      throw new SiYuanError(
        `Network error calling ${endpoint}: ${err.message}`,
        0,
        endpoint
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SiYuanError(
        `HTTP ${response.status} from ${endpoint}: ${text.slice(0, 200)}`,
        response.status,
        endpoint
      );
    }
    const payload = await response.json();
    if (typeof payload === "object" && payload !== null && "code" in payload && typeof payload.code === "number") {
      const code = payload.code;
      if (code !== 0) {
        throw new SiYuanError(
          `SiYuan error on ${endpoint}: ${payload.msg}`,
          response.status,
          endpoint,
          code
        );
      }
      if (!("data" in payload)) {
        throw new SiYuanError(
          `SiYuan response missing data on ${endpoint}`,
          response.status,
          endpoint,
          code
        );
      }
      return payload.data;
    }
    return payload;
  }
  escapeSql(value) {
    return value.replace(/'/g, "''");
  }
};

// src/utils.ts
var SIYUAN_ID = "(?:[0-9]{14}-[a-z0-9]+|[a-z0-9]{20,})";
function toRfc3339(ts) {
  if (!ts || ts.length !== 14) return void 0;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(8, 10);
  const mi = ts.slice(10, 12);
  const s = ts.slice(12, 14);
  const localIso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const ms = Date.parse(localIso);
  if (Number.isNaN(ms)) return void 0;
  return new Date(ms).toISOString();
}
var CODE_FENCE_RE = /```[\s\S]*?```/g;
var INLINE_CODE_RE = /`[^`\n]+`/g;
var MATH_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;
var MATH_INLINE_RE = /\$[^$\n]+\$/g;
var PLACEHOLDER_RE = /\x00(?:FENCE|INLINE|MATHB|MATHI)\d+\x00/g;
function protectCode(markdown) {
  const store = [];
  let result = markdown;
  const stash = (re, prefix) => {
    result = result.replace(re, (match) => {
      const idx = store.length;
      store.push(match);
      return `\0${prefix}${idx}\0`;
    });
  };
  stash(CODE_FENCE_RE, "FENCE");
  stash(MATH_BLOCK_RE, "MATHB");
  stash(INLINE_CODE_RE, "INLINE");
  stash(MATH_INLINE_RE, "MATHI");
  return {
    clean: result,
    restore: (text) => text.replace(PLACEHOLDER_RE, (token) => {
      const idx = parseInt(token.match(/\d+/)[0], 10);
      return store[idx] ?? token;
    })
  };
}
function extractTags(markdown) {
  if (!markdown) return "";
  const { clean, restore: _restore } = protectCode(markdown);
  const tags = /* @__PURE__ */ new Set();
  const tagRe = /(?:^|\s)#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g;
  let m;
  while ((m = tagRe.exec(clean)) !== null) {
    tags.add(m[1]);
    if (tags.size >= 20) break;
  }
  return Array.from(tags).join(",");
}
function extractFrontmatterTags(markdown) {
  if (!markdown) return "";
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const body = fm[1];
  let m = body.match(/^tags:\s*\[([^\]]*)\]/m);
  if (m) {
    return m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).join(",");
  }
  m = body.match(/^tags:\s*\n((?:\s*-\s+.+\n?)+)/m);
  if (m) {
    return m[1].split("\n").map(
      (line) => line.replace(/^\s*-\s+/, "").trim().replace(/^['"]|['"]$/g, "")
    ).filter(Boolean).join(",");
  }
  m = body.match(/^tags:\s*(.+)$/m);
  if (m) {
    return m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).join(",");
  }
  return "";
}
function stripFrontmatter(markdown) {
  if (!markdown) return "";
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return markdown.slice(match[0].length);
  }
  return markdown;
}
function stripInvisibleChars(text) {
  if (!text) return "";
  return text.replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, "");
}
function stripInlineHtml(markdown) {
  if (!markdown) return "";
  return markdown.replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href, text) => {
      const safe = /^(?:https?:|mailto:|siyuan:)/i.test(href.trim());
      return safe ? `[${text}](${href})` : text;
    }
  ).replace(/<br\s*\/?>/gi, "\n").replace(/<img\b[^>]*>/gi, "").replace(
    /<\/?(?:div|p|section|article|header|footer|nav|aside|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|blockquote|pre|h[1-6])\b[^>]*>/gi,
    "\n"
  ).replace(
    /<\/?(?:span|font|em|strong|b|i|u|s|del|ins|mark|sub|sup|small|big|label|code|abbr|kbd|samp|var|a|button|input|select|textarea|iframe|style|script|video|audio|source|track)\b[^>]*>/gi,
    ""
  );
}
function convertBlockRefs(markdown) {
  if (!markdown) return "";
  const re = new RegExp(
    `\\(\\((${SIYUAN_ID})(?:\\s+["']([^"']*)["'])?\\s*\\)\\)`,
    "gi"
  );
  return markdown.replace(
    re,
    (_, blockId, text) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return `[\u2197](siyuan://blocks/${blockId})`;
      return `\u300C${trimmed}\u300D[\u2197](siyuan://blocks/${blockId})`;
    }
  );
}
function cleanEmbedBlocks(markdown) {
  if (!markdown) return "";
  const re = /\{\{\{\s*(?:row|col)\b([^\n]*)\r?\n?([\s\S]*?)\r?\n?\}\}\}/gi;
  return markdown.replace(re, (_match, attrs, body) => {
    const inner = body.trim();
    if (inner) {
      return inner.split("\n").map((l) => `> ${l.trim()}`).join("\n");
    }
    const idMatch = attrs.match(new RegExp(SIYUAN_ID, "i"));
    if (idMatch) return `[\u2197](siyuan://blocks/${idMatch[0]})`;
    return "";
  });
}
function convertHighlights(markdown) {
  if (!markdown) return "";
  return markdown.replace(/==([^\n=]+)==/g, "**$1**");
}
function convertLocalAssets(markdown) {
  if (!markdown) return "";
  return markdown.replace(
    /!\[([^\]]*)\]\((?!https?:|\/\/|data:|siyuan:)([^)]+)\)/g,
    (_, alt, url) => {
      const caption = alt.trim();
      const cleanUrl = url.trim().replace(/^<|>$/g, "");
      const path = cleanUrl.split(/[?#]/, 1)[0];
      const ext = (path.split(".").pop() || "").toLowerCase();
      const name = path.split("/").pop() || path;
      if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(
        ext
      )) {
        return caption ? `\u{1F5BC} ${caption}` : "\u{1F5BC} \u56FE\u7247";
      }
      if (["mp3", "wav", "ogg", "flac", "aac", "m4a"].includes(ext)) {
        return `\u{1F3B5} ${caption || name}`;
      }
      if (["mp4", "webm", "mov", "avi", "mkv", "flv"].includes(ext)) {
        return `\u{1F3AC} ${caption || name}`;
      }
      return `\u{1F4CE} ${caption || name}`;
    }
  );
}
function extractLinks(markdown) {
  if (!markdown) return "";
  const ids = /* @__PURE__ */ new Set();
  const linkRe = new RegExp(`siyuan://blocks/(${SIYUAN_ID})`, "gi");
  let m;
  while ((m = linkRe.exec(markdown)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 50) break;
  }
  return Array.from(ids).join(",");
}
function cleanMarkdown(markdown) {
  if (!markdown) return "";
  const { clean, restore } = protectCode(markdown);
  let result = stripFrontmatter(clean);
  result = stripInvisibleChars(result);
  result = stripInlineHtml(result);
  result = convertBlockRefs(result);
  result = cleanEmbedBlocks(result);
  result = convertHighlights(result);
  result = convertLocalAssets(result);
  result = result.replace(/\n{3,}/g, "\n\n");
  return restore(result.trim());
}
function formatRelativeDate(rfc3339) {
  if (!rfc3339) return "";
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) return rfc3339.slice(0, 10);
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 6e4);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "\u521A\u521A";
  if (diffMin < 60) return `${diffMin}\u5206\u949F\u524D`;
  if (diffHr < 24) return `${diffHr}\u5C0F\u65F6\u524D`;
  if (diffDay < 7) return `${diffDay}\u5929\u524D`;
  return rfc3339.slice(0, 10);
}
function countWordsDetailed(text) {
  if (!text) return { cjk: 0, latin: 0 };
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
  return { cjk, latin };
}
function estimateReadTimeDetailed(cjk, latin) {
  const minutes = cjk / 400 + latin / 200;
  return Math.max(1, Math.ceil(minutes));
}
function truncateTitle(title, maxLength = 60) {
  const text = (title ?? "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)) + "\u2026";
}
function buildDisplayTitle(docTitle, notebookName) {
  if (!notebookName) return docTitle;
  return `${docTitle} \xB7 ${notebookName}`;
}
function formatPathBreadcrumb(hpath, opts) {
  if (!hpath) return "";
  let segments = hpath.split("/").filter(Boolean);
  if (opts?.dropFirst && segments[0] === opts.dropFirst) {
    segments = segments.slice(1);
  }
  if (opts?.dropLast && segments[segments.length - 1] === opts.dropLast) {
    segments = segments.slice(0, -1);
  }
  return segments.join(" / ");
}
function iconCodepointToEmoji(icon) {
  if (!icon) return "";
  try {
    const codepoints = icon.split("-").map((hex) => parseInt(hex, 16));
    if (codepoints.some((cp) => Number.isNaN(cp))) return "";
    return String.fromCodePoint(...codepoints);
  } catch {
    return "";
  }
}
function stripDuplicateH1(markdown, title) {
  if (!markdown || !title) return markdown;
  const lines = markdown.split("\n");
  if (lines.length === 0) return markdown;
  const firstLine = lines[0].trim();
  const titleCore = title.split(" \xB7 ")[0];
  if (firstLine === `# ${title}` || firstLine === `# ${titleCore}`) {
    return lines.slice(1).join("\n").replace(/^\n+/, "");
  }
  return markdown;
}
function buildContentHeader(pathBreadcrumb, updatedAt, content, tags, compact = false) {
  const lines = [];
  if (pathBreadcrumb) lines.push(`\u{1F4C1} ${pathBreadcrumb}`);
  if (!compact) {
    const metaParts = [];
    if (updatedAt) metaParts.push(`\u{1F4C5} ${formatRelativeDate(updatedAt)}`);
    if (content) {
      const { cjk, latin } = countWordsDetailed(content);
      const wc = cjk + latin;
      if (wc > 0) {
        metaParts.push(`\u{1F4DD} ${wc.toLocaleString("en-US")} \u5B57`);
        metaParts.push(`\u23F1 ${estimateReadTimeDetailed(cjk, latin)} \u5206\u949F`);
      }
    }
    if (metaParts.length > 0) lines.push(metaParts.join(" \xB7 "));
    if (tags) {
      const tagList = tags.split(",").filter(Boolean).slice(0, 10);
      if (tagList.length > 0) {
        lines.push("\u{1F3F7}\uFE0F " + tagList.map((t) => `#${t}`).join(" "));
      }
    }
  } else if (updatedAt) {
    lines.push(`\u{1F4C5} ${formatRelativeDate(updatedAt)}`);
  }
  if (lines.length === 0) return "";
  return `> ${lines.join("  \n> ")}

`;
}

// src/index.ts
var DOC_TYPE = "siyuan:doc";
var EXPORT_CONCURRENCY = 6;
var EMPTY_DOC_PLACEHOLDER = "*\uFF08\u6682\u65E0\u5185\u5BB9\uFF09*";
function readDebugLogPath() {
  try {
    const value = Deno.env.get("SIYUAN_CONNECTOR_DEBUG_LOG");
    return value && value.trim().length > 0 ? value.trim() : void 0;
  } catch {
    return void 0;
  }
}
var SiYuanConnector = class extends Connector {
  client;
  debugLogPath = readDebugLogPath();
  /** Buffered debug lines; flushed in batches to avoid per-line file IO. */
  debugBuffer = [];
  debug(msg) {
    const path = this.debugLogPath;
    if (!path) return;
    this.debugBuffer.push(`${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
    if (this.debugBuffer.length >= 50) this.flushDebug();
  }
  flushDebug() {
    const path = this.debugLogPath;
    if (!path || this.debugBuffer.length === 0) return;
    try {
      Deno.writeTextFileSync(path, this.debugBuffer.join(""), {
        append: true
      });
      this.debugBuffer = [];
    } catch {
    }
  }
  async onLoad() {
    const apiUrl = (this.config.api_url ?? "http://localhost:6806").trim();
    const apiToken = (this.config.api_token ?? "").trim();
    this.debug(
      `onLoad start. apiUrl=${apiUrl} apiToken.present=${apiToken.length > 0} apiToken.length=${apiToken.length} configKeys=${Object.keys(this.config).join(",")}`
    );
    this.client = new SiYuanClient(apiUrl, apiToken, this.signal);
    try {
      const ver = await this.client.version();
      this.debug(`version() ok: ${ver}`);
    } catch (err) {
      this.debug(`version() FAILED: ${err.message}`);
      this.flushDebug();
      throw new Error(
        `Could not reach SiYuan kernel at ${apiUrl}. Ensure SiYuan is running and the API URL is correct. Cause: ${err.message}`
      );
    }
    try {
      const nbs = await this.client.lsNotebooks();
      const open = nbs.filter((n) => !n.closed);
      this.debug(
        `lsNotebooks() ok: ${nbs.length} total, ${open.length} open [${open.map((n) => `${n.id}:${n.name}`).join(", ")}]`
      );
    } catch (err) {
      this.debug(`lsNotebooks() FAILED: ${err.message}`);
      this.flushDebug();
      throw new Error(
        apiToken === "" ? `SiYuan API token is required but not provided. Get it from SiYuan: Settings > About > API token. Cause: ${err.message}` : `SiYuan API token is invalid or rejected. Regenerate it in SiYuan: Settings > About > API token. Cause: ${err.message}`
      );
    }
  }
  async *poll() {
    this.debug(`poll start. concurrency=${EXPORT_CONCURRENCY}`);
    const allNotebooks = await this.client.lsNotebooks();
    const notebooks = allNotebooks.filter((nb) => !nb.closed);
    this.debug(
      `poll: ${notebooks.length} open notebooks of ${allNotebooks.length} total`
    );
    const notebookNames = /* @__PURE__ */ new Map();
    const notebookIcons = /* @__PURE__ */ new Map();
    for (const nb of allNotebooks) {
      notebookNames.set(nb.id, nb.name);
      if (nb.icon) notebookIcons.set(nb.id, nb.icon);
    }
    const liveIds = /* @__PURE__ */ new Set();
    for (const nb of allNotebooks) {
      if (this.signal.aborted) return;
      const ids = await this.client.listDocIds(nb.id);
      for (const b of ids) liveIds.add(b.id);
    }
    this.debug(`poll: ${liveIds.size} live doc IDs across all notebooks`);
    const previousDocs = this.lastState?.knownDocs ?? {};
    const previousIds = new Set(Object.keys(previousDocs));
    const previousCursors = this.lastState?.lastUpdatedByNotebook ?? {};
    const legacyCursor = this.lastState?.lastMaxUpdated;
    const previousRetryIds = this.lastState?.pendingRetry ?? [];
    const changedDocs = [];
    for (const nb of notebooks) {
      if (this.signal.aborted) return;
      let blocks;
      const cursor = previousCursors[nb.id] ?? legacyCursor;
      if (cursor) {
        blocks = await this.client.listDocBlocksSince(nb.id, cursor);
        this.debug(
          `poll: notebook ${nb.name} incremental since ${cursor} \u2192 ${blocks.length} docs`
        );
      } else {
        blocks = await this.client.listDocBlocks(nb.id);
        this.debug(
          `poll: notebook ${nb.name} full scan \u2192 ${blocks.length} docs`
        );
      }
      for (const b of blocks) {
        changedDocs.push(b);
      }
    }
    let retryDocs = [];
    if (previousRetryIds.length > 0) {
      retryDocs = await this.client.listDocsByIds(previousRetryIds);
      this.debug(
        `poll: retrying ${retryDocs.length} previously failed docs (wanted ${previousRetryIds.length})`
      );
    }
    const retryFoundIds = new Set(retryDocs.map((doc) => doc.id));
    const deletedDocIds = [];
    for (const id of previousIds) {
      if (!liveIds.has(id)) deletedDocIds.push(id);
    }
    const docsByID = /* @__PURE__ */ new Map();
    for (const doc of changedDocs) {
      const prevUpdated = previousDocs[doc.id];
      if (prevUpdated === void 0 || prevUpdated !== doc.updated) {
        docsByID.set(doc.id, doc);
      }
    }
    for (const doc of retryDocs) {
      docsByID.set(doc.id, doc);
    }
    const docsToFetch = Array.from(docsByID.values());
    this.debug(
      `poll: ${docsToFetch.length} docs to fetch (new/updated/retry), ${deletedDocIds.length} to delete`
    );
    const nextDocs = { ...previousDocs };
    for (const id of deletedDocIds) delete nextDocs[id];
    const nextRetry = new Set(previousRetryIds);
    for (const id of deletedDocIds) nextRetry.delete(id);
    for (const id of previousRetryIds) {
      if (!retryFoundIds.has(id)) nextRetry.delete(id);
    }
    const nextCursors = { ...previousCursors };
    if (legacyCursor) {
      for (const nb of notebooks) {
        if (nextCursors[nb.id] === void 0) nextCursors[nb.id] = legacyCursor;
      }
    }
    const checkpoint = () => ({
      knownDocs: { ...nextDocs },
      lastUpdatedByNotebook: { ...nextCursors },
      lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(),
      pendingRetry: Array.from(nextRetry)
    });
    if (deletedDocIds.length > 0) {
      this.debug(`poll: ${deletedDocIds.length} docs to delete`);
      yield {
        updates: deletedDocIds.map((id) => del(id)),
        state: checkpoint()
      };
    }
    let yielded = 0;
    for (let i = 0; i < docsToFetch.length; i += EXPORT_CONCURRENCY) {
      if (this.signal.aborted) return;
      const chunk = docsToFetch.slice(i, i + EXPORT_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (doc) => {
          try {
            const exported = await this.client.exportMdContent(doc.id);
            return {
              doc,
              markdown: exported.content ?? "",
              exported: true
            };
          } catch {
            return {
              doc,
              markdown: "",
              exported: false
            };
          }
        })
      );
      const batch = chunkResults.filter((r) => r.exported).map(
        (r) => this.buildDocUpsert(
          r.doc,
          r.markdown,
          notebookNames,
          notebookIcons
        )
      );
      for (const r of chunkResults) {
        if (r.exported) {
          if (r.doc.updated) nextDocs[r.doc.id] = r.doc.updated;
          const notebookId = r.doc.box ?? "";
          if (r.doc.updated && (!nextCursors[notebookId] || r.doc.updated > nextCursors[notebookId])) {
            nextCursors[notebookId] = r.doc.updated;
          }
          nextRetry.delete(r.doc.id);
        } else {
          nextRetry.add(r.doc.id);
          this.debug(`export failed for doc ${r.doc.id}; queued for retry`);
        }
      }
      yielded += batch.length;
      this.debug(
        `poll: yielding batch of ${batch.length} docs (total=${yielded})`
      );
      yield {
        updates: batch,
        state: checkpoint()
      };
    }
    if (docsToFetch.length === 0 && deletedDocIds.length === 0) {
      this.debug("poll: no changes, yielding empty state checkpoint");
      yield {
        updates: [],
        state: checkpoint()
      };
    }
    this.flushDebug();
    this.debug("poll: done");
    this.flushDebug();
  }
  buildDocUpsert(doc, rawMarkdown, notebookNames, notebookIcons) {
    const notebookId = doc.box ?? "";
    const notebookName = notebookNames.get(notebookId) ?? "";
    const notebookIcon = notebookIcons.get(notebookId);
    const rawTitle = doc.content || doc.hpath || doc.id;
    const iconEmoji = iconCodepointToEmoji(notebookIcon);
    const titleCore = buildDisplayTitle(
      rawTitle,
      notebookName || void 0
    );
    const titleWithIcon = iconEmoji ? `${iconEmoji} ${titleCore}` : titleCore;
    const title = truncateTitle(titleWithIcon);
    const updatedAt = toRfc3339(doc.updated);
    const createdAt = toRfc3339(doc.created);
    const pathBreadcrumb = formatPathBreadcrumb(doc.hpath, {
      dropFirst: notebookName || void 0,
      dropLast: rawTitle
    });
    const fmTags = extractFrontmatterTags(rawMarkdown);
    let content = cleanMarkdown(rawMarkdown);
    content = stripDuplicateH1(content, rawTitle);
    content = content.trim() || EMPTY_DOC_PLACEHOLDER;
    const bodyTags = extractTags(content);
    const tagSet = /* @__PURE__ */ new Set();
    for (const t of fmTags.split(",")) if (t) tagSet.add(t);
    for (const t of bodyTags.split(",")) if (t) tagSet.add(t);
    const tags = Array.from(tagSet).slice(0, 20).join(",");
    const header = buildContentHeader(
      pathBreadcrumb || void 0,
      updatedAt,
      void 0,
      void 0,
      true
      // compact
    );
    const fullContent = header + content;
    const links = extractLinks(fullContent);
    return upsert({
      id: doc.id,
      title,
      content: fullContent,
      content_format: "markdown",
      doc_type: DOC_TYPE,
      doc_updated_at: updatedAt,
      original_file_size: new TextEncoder().encode(fullContent).length,
      metadata: {
        url: `siyuan://blocks/${doc.id}`,
        created_at: createdAt,
        notebook: notebookId,
        notebook_name: notebookName,
        doc_path: pathBreadcrumb,
        tags,
        links
      }
    });
  }
};
export {
  SiYuanConnector as default
};
//# sourceMappingURL=main.js.map
