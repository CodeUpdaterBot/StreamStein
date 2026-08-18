// ── Movie/TV download auth (cookies + captured stream headers) ───────────────
// CDN HLS often 403s without the same Cookie/Referer the in-app player used.
// Layers: (1) headers from the live m3u8 request, (2) Electron persist:player
// Netscape cookie jar, (3) optional Chrome --cookies-from-browser (Profile 69).

const { app, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFS_FILE = () =>
  path.join(app.getPath("userData"), "download-auth.json");

const DEFAULT_PREFS = {
  useBrowserCookies: true,
  cookiesFromBrowser: "chrome:Profile 69",
};

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE())) {
      const raw = JSON.parse(fs.readFileSync(PREFS_FILE(), "utf8"));
      return {
        useBrowserCookies:
          raw.useBrowserCookies !== undefined
            ? !!raw.useBrowserCookies
            : DEFAULT_PREFS.useBrowserCookies,
        cookiesFromBrowser: String(
          raw.cookiesFromBrowser || DEFAULT_PREFS.cookiesFromBrowser,
        ).trim(),
      };
    }
  } catch {}
  return { ...DEFAULT_PREFS };
}

function savePrefs(partial = {}) {
  const next = { ...loadPrefs(), ...partial };
  next.useBrowserCookies = !!next.useBrowserCookies;
  next.cookiesFromBrowser = String(
    next.cookiesFromBrowser || DEFAULT_PREFS.cookiesFromBrowser,
  ).trim();
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch {}
  return next;
}

function normalizeHeaderMap(input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v == null || k.startsWith("_")) continue;
    const val = Array.isArray(v) ? v.join("; ") : String(v);
    if (!val) continue;
    out[String(k)] = val;
  }
  return out;
}

function headerGet(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) {
      return Array.isArray(v) ? v.join("; ") : String(v || "");
    }
  }
  return "";
}

function parseCookieHeader(cookieHeader, pageUrl) {
  const cookies = [];
  if (!cookieHeader || !pageUrl) return cookies;
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return cookies;
  }
  const domain = host.startsWith(".") ? host : `.${host}`;
  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({
      domain,
      path: "/",
      secure: String(pageUrl).startsWith("https"),
      expirationDate: 0,
      name,
      value,
    });
  }
  return cookies;
}

function electronCookieToNetscape(c) {
  const domain = c.domain || "";
  if (!domain || !c.name) return null;
  const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
  const cookiePath = c.path || "/";
  const secure = c.secure ? "TRUE" : "FALSE";
  const expires =
    c.expirationDate && Number.isFinite(c.expirationDate)
      ? Math.floor(c.expirationDate)
      : 0;
  return [
    domain,
    includeSub,
    cookiePath,
    secure,
    String(expires),
    c.name,
    c.value || "",
  ].join("\t");
}

function writeNetscapeCookieFile(cookies, filePath) {
  const lines = ["# Netscape HTTP Cookie File", "# Streamstein download auth", ""];
  const seen = new Set();
  for (const c of cookies) {
    const row = electronCookieToNetscape(c);
    if (!row || seen.has(row)) continue;
    seen.add(row);
    lines.push(row);
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function exportPlayerSessionCookies(m3u8Url, streamHeaders = {}) {
  const filePath = path.join(
    os.tmpdir(),
    `streamstein_cookies_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const merged = [];

  try {
    const ses = session.fromPartition("persist:player");
    const all = await ses.cookies.get({});
    for (const c of all || []) merged.push(c);
  } catch {}

  const cookieHeader = headerGet(streamHeaders, "Cookie");
  if (cookieHeader && m3u8Url) {
    merged.push(...parseCookieHeader(cookieHeader, m3u8Url));
  }

  if (!merged.length) return null;
  try {
    writeNetscapeCookieFile(merged, filePath);
    return filePath;
  } catch {
    return null;
  }
}

function shellToken(value) {
  const s = String(value ?? "");
  if (!s) return '""';
  if (!/[\s"'\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @returns {Promise<{ argString: string, cookieFile: string|null, cookiesFromBrowser: string|null, notes: string[] }>}
 */
async function buildDownloadAuthYtdlpArgs({
  m3u8Url,
  sourceId,
  streamHeaders,
  playerHeaders,
} = {}) {
  const notes = [];
  const prefs = loadPrefs();
  const captured = normalizeHeaderMap(streamHeaders);
  const fallback = playerHeaders || {};

  const origin = headerGet(captured, "Origin") || fallback.Origin || "";
  const referer = headerGet(captured, "Referer") || fallback.Referer || "";
  const ua =
    headerGet(captured, "User-Agent") ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const cookieHeader = headerGet(captured, "Cookie");

  const parts = [];
  if (origin) parts.push(`--add-header ${shellToken(`Origin:${origin}`)}`);
  if (referer) parts.push(`--add-header ${shellToken(`Referer:${referer}`)}`);
  if (ua) parts.push(`--add-header ${shellToken(`User-Agent:${ua}`)}`);
  if (cookieHeader) {
    parts.push(`--add-header ${shellToken(`Cookie:${cookieHeader}`)}`);
    notes.push("live player Cookie header");
  }

  let cookieFile = null;
  try {
    cookieFile = await exportPlayerSessionCookies(m3u8Url, captured);
    if (cookieFile) notes.push("Electron persist:player cookie jar");
  } catch {}

  // Prefer the in-app player jar for CDN streams — Chrome profile cookies rarely
  // include ironwallnet/videasy CDN tokens.
  let cookiesFromBrowser = null;
  if (cookieFile) {
    parts.push(`--cookies ${shellToken(cookieFile)}`);
    if (prefs.useBrowserCookies && prefs.cookiesFromBrowser) {
      notes.push(
        `(Chrome ${prefs.cookiesFromBrowser} available; session jar preferred for CDN)`,
      );
    }
  } else if (prefs.useBrowserCookies && prefs.cookiesFromBrowser) {
    cookiesFromBrowser = prefs.cookiesFromBrowser;
    parts.push(`--cookies-from-browser ${shellToken(cookiesFromBrowser)}`);
    notes.push(`cookies-from-browser ${cookiesFromBrowser}`);
  }

  return {
    argString: parts.join(" "),
    cookieFile,
    cookiesFromBrowser,
    notes,
    sourceId: sourceId || null,
  };
}

module.exports = {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  buildDownloadAuthYtdlpArgs,
  exportPlayerSessionCookies,
  headerGet,
  normalizeHeaderMap,
};
