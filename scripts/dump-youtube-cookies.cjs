/**
 * Dump YouTube/Google cookies out of a Chrome instance started with --remote-debugging-port.
 *
 * Why this exists: Chrome 127+ encrypts cookies with App-Bound Encryption, so yt-dlp's
 * --cookies-from-browser fails with "Failed to decrypt with DPAPI" (issue #10927) and the
 * cookies DB cannot be decrypted out-of-process at all. Chrome itself CAN decrypt them, so
 * we ask Chrome over CDP and convert the result to the Netscape cookies.txt yt-dlp reads.
 *
 * Cookie VALUES are secrets: they are written only to the output file, never printed.
 *
 * Usage: node dump-youtube-cookies.cjs [--port 9223] [--out <cookies.txt>]
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "9223"));
const OUT =
  arg("out", null) ||
  path.join(process.env.APPDATA || process.cwd(), "streamstein", "youtube-cookies.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page") || list[0];
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`no debuggable target on port ${PORT}`);
}

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("websocket error")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb(msg);
    }
  });

  await send("Network.enable");
  const { cookies } = await send("Network.getAllCookies");
  const keep = (cookies || []).filter((c) => /(^|\.)(youtube\.com|google\.com)$/.test(c.domain || ""));

  const header = [
    "# Netscape HTTP Cookie File",
    "# Extracted from Chrome via CDP (App-Bound Encryption means the DB cannot be read",
    "# out-of-process). Used by the StreamStein comment fetcher via yt-dlp --cookies.",
    "",
  ];
  const lines = keep.map((c) => {
    const domain = c.domain.startsWith(".") ? c.domain : c.domain;
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    return [domain, includeSub, c.path || "/", c.secure ? "TRUE" : "FALSE", expiry, c.name, c.value].join(
      "\t",
    );
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, [...header, ...lines].join("\n") + "\n", "utf8");

  // Names and counts only — never the values.
  const names = [...new Set(keep.map((c) => c.name))].sort();
  const session = keep.filter((c) => c.name === "SID" || c.name === "__Secure-1PSID");
  console.log(`wrote ${keep.length} cookies to ${OUT}`);
  console.log(`names: ${names.join(", ")}`);
  console.log(`logged-in session cookie present: ${session.length > 0 ? "YES" : "NO"}`);
  ws.close();
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
