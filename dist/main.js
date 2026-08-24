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
  /** List document blocks for a notebook via SQL. */
  listDocBlocks(notebookId) {
    const stmt = `SELECT id, content, type, subtype, hpath, path, box, updated, created FROM blocks WHERE type = 'd' AND box = '${this.escapeSql(notebookId)}' ORDER BY path ASC`;
    return this.query(stmt);
  }
  /** List content blocks (non-document) for a notebook via SQL. */
  listContentBlocks(notebookId) {
    const stmt = `SELECT id, content, type, subtype, hpath, path, box, updated, created, markdown FROM blocks WHERE type != 'd' AND box = '${this.escapeSql(notebookId)}' AND markdown != '' ORDER BY path ASC, sort ASC`;
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
    if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload && typeof payload.code === "number") {
      const code = payload.code;
      if (code !== 0) {
        throw new SiYuanError(
          `SiYuan error on ${endpoint}: ${payload.msg}`,
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
function extractTags(markdown) {
  if (!markdown) return "";
  const tags = /* @__PURE__ */ new Set();
  const tagRe = /(?:^|\s)#([a-zA-Z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g;
  let m;
  while ((m = tagRe.exec(markdown)) !== null) {
    tags.add(m[1]);
    if (tags.size >= 20) break;
  }
  return Array.from(tags).join(",");
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
function cleanMarkdown(markdown) {
  if (!markdown) return "";
  let result = stripFrontmatter(markdown);
  result = stripInvisibleChars(result);
  result = stripInlineHtml(result);
  result = convertBlockRefs(result);
  result = cleanEmbedBlocks(result);
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}
function convertBlockRefs(markdown) {
  if (!markdown) return "";
  return markdown.replace(
    /\(\(([0-9]{14}-[a-z0-9]+)\s+["']([^"']*)["']\)\)/g,
    (_, blockId, text) => {
      const trimmed = text.trim();
      if (!trimmed) return `[\u2197](siyuan://blocks/${blockId})`;
      return `\u300C${trimmed}\u300D[\u2197](siyuan://blocks/${blockId})`;
    }
  );
}
function stripInlineHtml(markdown) {
  if (!markdown) return "";
  return markdown.replace(/<\/?span[^>]*>/gi, "");
}
function cleanEmbedBlocks(markdown) {
  if (!markdown) return "";
  return markdown.replace(
    /\{\{\{row?\r?\n([\s\S]*?)\r?\n\}\}\}/g,
    (_, content) => {
      const lines = content.trim().split("\n").map((l) => `> ${l}`);
      return lines.join("\n");
    }
  );
}
function extractLinks(markdown) {
  if (!markdown) return "";
  const ids = /* @__PURE__ */ new Set();
  const linkRe = /siyuan:\/\/blocks\/([0-9]{14}-[a-z0-9]+)/g;
  let m;
  while ((m = linkRe.exec(markdown)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 50) break;
  }
  return Array.from(ids).join(",");
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
function countWords(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
  return cjk + latin;
}
function estimateReadTime(wordCount) {
  return Math.max(1, Math.ceil(wordCount / 400));
}
function buildDisplayTitle(docTitle, notebookName) {
  if (!notebookName) return docTitle;
  return `${docTitle} \xB7 ${notebookName}`;
}
function formatPathBreadcrumb(hpath) {
  if (!hpath) return "";
  const segments = hpath.split("/").filter(Boolean);
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
function buildContentHeader(notebookName, notebookIcon, pathBreadcrumb, updatedAt, content, tags) {
  const lines = [];
  const icon = iconCodepointToEmoji(notebookIcon);
  const nbLabel = [icon, notebookName].filter(Boolean).join(" ");
  const pathPart = pathBreadcrumb || "";
  const location = [nbLabel, pathPart].filter(Boolean).join(" \xB7 ");
  if (location) lines.push(location);
  const metaParts = [];
  if (updatedAt) metaParts.push(`\u{1F4C5} ${formatRelativeDate(updatedAt)}`);
  if (content) {
    const wc = countWords(content);
    if (wc > 0) {
      metaParts.push(`\u{1F4DD} ${wc.toLocaleString()} \u5B57`);
      metaParts.push(`\u23F1 ${estimateReadTime(wc)} \u5206\u949F`);
    }
  }
  if (metaParts.length > 0) lines.push(metaParts.join(" \xB7 "));
  if (tags) {
    const tagList = tags.split(",").filter(Boolean).slice(0, 10);
    if (tagList.length > 0) {
      lines.push("\u{1F3F7}\uFE0F " + tagList.map((t) => `#${t}`).join(" "));
    }
  }
  if (lines.length === 0) return "";
  return `> ${lines.join("  \n> ")}

`;
}

// src/index.ts
var DOC_TYPE = "siyuan:doc";
var SiYuanConnector = class extends Connector {
  client;
  /** Write a debug line to a file so we can see what happens inside Gety
   * (console is redirected to IPC and not visible in app logs). */
  debug(msg) {
    try {
      const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`;
      Deno.writeTextFileSync(
        "C:\\Users\\Admin\\siyuan-connector-debug.log",
        line,
        { append: true }
      );
    } catch {
    }
  }
  async onLoad() {
    const apiUrl = (this.config.api_url ?? "http://localhost:6806").trim();
    const apiToken = (this.config.api_token ?? "").trim();
    this.debug(
      `onLoad start. apiUrl=${apiUrl} apiToken.length=${apiToken.length} apiToken_prefix=${apiToken.slice(0, 4)}... configKeys=${Object.keys(this.config).join(",")}`
    );
    this.client = new SiYuanClient(apiUrl, apiToken, this.signal);
    try {
      const ver = await this.client.version();
      this.debug(`version() ok: ${ver}`);
    } catch (err) {
      this.debug(`version() FAILED: ${err.message}`);
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
      throw new Error(
        apiToken === "" ? `SiYuan API token is required but not provided. Get it from SiYuan: Settings > About > API token. Cause: ${err.message}` : `SiYuan API token is invalid or rejected. Regenerate it in SiYuan: Settings > About > API token. Cause: ${err.message}`
      );
    }
  }
  async *poll() {
    const pageSize = 50;
    this.debug(`poll start. pageSize=${pageSize}`);
    const notebooks = (await this.client.lsNotebooks()).filter(
      (nb) => !nb.closed
    );
    this.debug(`poll: ${notebooks.length} open notebooks`);
    const notebookNames = /* @__PURE__ */ new Map();
    const notebookIcons = /* @__PURE__ */ new Map();
    for (const nb of notebooks) {
      notebookNames.set(nb.id, nb.name);
      if (nb.icon) notebookIcons.set(nb.id, nb.icon);
    }
    const liveDocs = [];
    for (const nb of notebooks) {
      if (this.signal.aborted) return;
      const blocks = await this.client.listDocBlocks(nb.id);
      this.debug(
        `poll: notebook ${nb.name} (${nb.id}) \u2192 ${blocks.length} doc blocks`
      );
      liveDocs.push(...blocks);
    }
    this.debug(`poll: total ${liveDocs.length} live docs across all notebooks`);
    const previousDocs = this.lastState?.knownDocs ?? {};
    const previousIds = new Set(Object.keys(previousDocs));
    const liveIds = new Set(liveDocs.map((d) => d.id));
    const deletedDocIds = [];
    for (const id of previousIds) {
      if (!liveIds.has(id)) {
        deletedDocIds.push(id);
      }
    }
    if (deletedDocIds.length > 0) {
      yield {
        updates: deletedDocIds.map((id) => del(id))
      };
    }
    const docsToFetch = [];
    for (const doc of liveDocs) {
      const prevUpdated = previousDocs[doc.id];
      if (prevUpdated === void 0 || prevUpdated !== doc.updated) {
        docsToFetch.push(doc);
      }
    }
    this.debug(
      `poll: ${docsToFetch.length} docs to fetch (new/updated), ${deletedDocIds.length} to delete`
    );
    const nextDocs = { ...previousDocs };
    for (const id of deletedDocIds) {
      delete nextDocs[id];
    }
    let batch = [];
    for (let i = 0; i < docsToFetch.length; i++) {
      if (this.signal.aborted) return;
      const doc = docsToFetch[i];
      let markdown = "";
      try {
        const exported = await this.client.exportMdContent(doc.id);
        markdown = exported.content ?? "";
      } catch (err) {
        markdown = `<!-- export failed: ${err.message} -->`;
      }
      batch.push(
        this.buildDocUpsert(doc, markdown, notebookNames, notebookIcons)
      );
      if (batch.length >= pageSize || i === docsToFetch.length - 1) {
        this.debug(`poll: yielding batch of ${batch.length} docs (i=${i})`);
        for (let j = i - batch.length + 1; j <= i; j++) {
          const d = docsToFetch[j];
          if (d.updated) {
            nextDocs[d.id] = d.updated;
          }
        }
        yield {
          updates: batch,
          state: {
            knownDocs: nextDocs,
            lastSyncAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        };
        batch = [];
      }
    }
    if (docsToFetch.length === 0 && deletedDocIds.length === 0) {
      this.debug("poll: no changes, yielding empty state checkpoint");
      yield {
        updates: [],
        state: {
          knownDocs: nextDocs,
          lastSyncAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
    }
    this.debug("poll: done");
  }
  buildDocUpsert(doc, rawMarkdown, notebookNames, notebookIcons) {
    const notebookId = doc.box ?? "";
    const notebookName = notebookNames.get(notebookId) ?? "";
    const notebookIcon = notebookIcons.get(notebookId);
    const rawTitle = doc.content || doc.hpath || doc.id;
    const iconEmoji = iconCodepointToEmoji(notebookIcon);
    const titleWithNb = buildDisplayTitle(rawTitle, notebookName || void 0);
    const title = iconEmoji ? `${iconEmoji} ${titleWithNb}` : titleWithNb;
    const updatedAt = toRfc3339(doc.updated);
    const createdAt = toRfc3339(doc.created);
    const pathBreadcrumb = formatPathBreadcrumb(doc.hpath);
    let content = cleanMarkdown(rawMarkdown);
    content = stripDuplicateH1(content, rawTitle);
    content = content.trim() || rawTitle;
    const tags = extractTags(content);
    const header = buildContentHeader(
      notebookName || void 0,
      notebookIcon,
      pathBreadcrumb || void 0,
      updatedAt,
      content,
      tags
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
      original_file_size: fullContent.length,
      metadata: {
        url: `siyuan://blocks/${doc.id}`,
        created_at: createdAt,
        notebook: notebookId,
        notebook_name: notebookName,
        doc_path: pathBreadcrumb,
        tags: extractTags(content),
        links
      }
    });
  }
};
export {
  SiYuanConnector as default
};
//# sourceMappingURL=main.js.map
