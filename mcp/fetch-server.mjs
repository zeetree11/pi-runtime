#!/usr/bin/env node
/**
 * Minimal MCP server exposing two tools: `fetch` and `search`.
 *
 * Why hand-rolled instead of @modelcontextprotocol/sdk: this runtime ships as one image with no
 * extra install step, and the SDK would pull dependencies into an image that already runs on a
 * 1.7 GB box. MCP's stdio transport is newline-delimited JSON-RPC, which is small enough to
 * implement correctly in one file — and the small surface is easier to audit than a dependency.
 *
 * Why only two tools: pi has no built-in network access, and `safe` mode excludes bash, so the
 * agent could not reach the web at all. Two tools (read a page, find a page) close that gap for
 * ~300 tokens of context; a general-purpose server with eight tools would cost five times that.
 *
 * Security: this is a server-side fetcher driven by a model. It refuses non-http(s) schemes and
 * any host that resolves to a private address, so a prompt-injected page cannot make the agent
 * read cloud metadata (169.254.169.254) or hit internal services.
 */
import { createServer } from "node:http";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const NAME = "fetch";
const VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

const TIMEOUT_MS = Number(process.env.MCP_FETCH_TIMEOUT_MS ?? 15_000);
const MAX_CHARS = Number(process.env.MCP_FETCH_MAX_CHARS ?? 20_000);

const TOOL = {
  name: "fetch",
  description:
    "Fetch a public web page and return its readable text. " +
    "Use for reading documentation, articles or a link the user pasted. " +
    "Returns plain text (tags stripped), truncated to a safe length.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/**
 * Search tool.
 *
 * Why a second tool instead of "let the model fetch a search engine": the model cannot reliably
 * scrape a result page — engines return markup that differs per request and are hostile to
 * naive parsing. Normalising here means the model sees a stable list and spends tokens on the
 * answer instead of on HTML.
 *
 * Backend: DuckDuckGo's HTML endpoint, which needs no API key. That is the whole trade-off —
 * no key and no billing, but it is best-effort: it can rate-limit a datacenter IP, and its
 * markup may change. Failures are reported as failures, never as "no results".
 */
const SEARCH_TOOL = {
  name: "search",
  description:
    "Search the web and return the top results (title, url, snippet). " +
    "Use when the user asks about something you do not know or that changes over time. " +
    "Follow up with `fetch` on a result URL to read the page.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "How many results (default 5)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const SEARCH_ENDPOINT = process.env.MCP_SEARCH_ENDPOINT ?? "https://html.duckduckgo.com/html/";
const SEARCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Decode a DuckDuckGo redirect link (`//duckduckgo.com/l/?uddg=...`) into the real URL. */
function decodeResultUrl(href) {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const url = new URL(absolute, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.href;
  } catch {
    return href;
  }
}

/**
 * Parse the HTML endpoint's results. Exported so the tests can pin behaviour against a fixture
 * without touching the network.
 */
export function parseDuckDuckGo(html, limit = 5) {
  const results = [];
  const blockRe = /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    const url = decodeResultUrl(match[1]);
    const title = toReadableText(match[2]);
    // The snippet lives after the title in the same result block; look ahead a bounded window
    // so a result without a snippet does not steal the next result's text.
    const window = html.slice(match.index, match.index + 3000);
    const snippetMatch = window.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? toReadableText(snippetMatch[1]) : "";
    if (!title || !url) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

export async function runSearch(query, options = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) throw new Error("搜索词为空");
  if (trimmed.length > 200) throw new Error("搜索词过长（上限 200 字符）");
  const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 10);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
      headers: { "user-agent": SEARCH_UA, accept: "text/html" },
    });
    if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
    const html = await response.text();
    const results = parseDuckDuckGo(html, limit);
    if (results.length === 0) {
      // Distinguish "the engine blocked us" from "genuinely nothing found".
      if (/anomaly|unusual traffic|captcha/i.test(html)) {
        throw new Error("搜索被限流（返回验证页）");
      }
      return `没有找到「${trimmed}」的结果。`;
    }
    const lines = results.map(
      (result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`,
    );
    return [`搜索：${trimmed}`, "", ...lines].join("\n");
  } finally {
    clearTimeout(timer);
  }
}

/** Private, loopback, link-local and metadata ranges — never legitimate for a model-driven fetch. */
function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return false;
  }
  return false;
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只允许 http/https，收到：${url.protocol}`);
  }
  // Test-only escape hatch: the fixture server runs on loopback, and the guard below is
  // exactly what the tests need to prove works. Never set this in a deployment.
  if (process.env.MCP_FETCH_ALLOW_LOCAL === "1") return url;
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("拒绝访问本机地址");
  }
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    throw new Error(`拒绝访问内网地址：${url.hostname}`);
  }
  // DNS rebinding: the name may resolve to a private address even if it looks public.
  try {
    const records = await lookup(url.hostname, { all: true });
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new Error(`拒绝访问隧道到内网的地址：${url.hostname} -> ${record.address}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("拒绝")) throw error;
    // Resolution failure is fine here; fetch will report it properly.
  }
  return url;
}

/** Strip everything that is not readable text. Deliberately regex-based: no DOM, no deps. */
export function toReadableText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runFetch(rawUrl, options = {}) {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "pi-runtime-mcp-fetch/1.0 (+personal assistant)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    const raw = await response.text();
    const text = toReadableText(raw);
    const limit = options.maxChars ?? MAX_CHARS;
    const body = text.length > limit
      ? `${text.slice(0, limit)}\n\n[已截断：原文 ${text.length} 字符，只保留前 ${limit}。]`
      : text;

    return [
      `# ${url.href}`,
      `状态：${response.status} ${response.statusText}`,
      "",
      body || "(页面没有可读文本)",
    ].join("\n");
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON-RPC over stdio (newline-delimited) ────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL, SEARCH_TOOL] });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === SEARCH_TOOL.name) {
      try {
        const text = await runSearch(args.query, { limit: args.limit });
        reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reply(id, { content: [{ type: "text", text: `搜索失败：${reason}` }], isError: true });
      }
      return;
    }

    if (name !== TOOL.name) {
      fail(id, `未知工具：${name}`);
      return;
    }
    const url = args.url;
    if (typeof url !== "string" || url.length === 0) {
      fail(id, "缺少参数 url");
      return;
    }
    try {
      const text = await runFetch(url);
      reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: "text", text: `抓取失败：${reason}` }], isError: true });
    }
    return;
  }

  if (typeof id !== "undefined") fail(id, `未知方法：${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        void handle(message).catch((error) => {
          if (message?.id !== undefined) fail(message.id, error.message);
        });
      } catch {
        // Malformed line: ignore rather than crash the server.
      }
    }
    index = buffer.indexOf("\n");
  }
});

// Keep the process alive when started detached, and expose nothing on the network.
if (process.env.MCP_FETCH_SELFTEST === "1") {
  createServer().close();
}
