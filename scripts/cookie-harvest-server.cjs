/**
 * Local listener that turns Chrome's cookie export into a Netscape cookies.txt for yt-dlp.
 *
 * Companion to scripts/cookie-harvest/extension — see background.js there for why an
 * extension is doing this at all (App-Bound Encryption).
 *
 * Binds to 127.0.0.1 only, accepts exactly one export, writes the file, then exits.
 * Cookie VALUES are written to the output file and never printed.
 *
 * Usage: node scripts/cookie-harvest-server.cjs [--port 8799] [--out <path>] [--timeout 180]
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "8799"));
const TIMEOUT_S = Number(arg("timeout", "180"));
const OUT =
  arg("out", null) ||
  path.join(process.env.APPDATA || process.cwd(), "streamstein", "youtube-cookies.txt");

function toNetscape(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Exported from Chrome via the chrome.cookies API (App-Bound Encryption makes the",
    "# cookie database unreadable by anything but Chrome itself).",
    "# Consumed by yt-dlp --cookies for the StreamStein comment fetcher.",
    "",
  ];
  for (const c of cookies) {
    if (!c.name || c.value === undefined) continue;
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    lines.push(
      [
        domain,
        includeSub,
        c.path || "/",
        c.secure ? "TRUE" : "FALSE",
        Math.floor(c.expirationDate || 0),
        c.name,
        c.value,
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8 * 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    let cookies = [];
    try {
      cookies = (JSON.parse(body).cookies || []).filter(Boolean);
    } catch (err) {
      console.error("bad payload:", String(err));
      res.writeHead(400).end("bad payload");
      return;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, toNetscape(cookies), "utf8");

    const names = [...new Set(cookies.map((c) => c.name))].sort();
    const session = cookies.filter(
      (c) => c.name === "SID" || c.name === "__Secure-1PSID" || c.name === "LOGIN_INFO",
    );
    console.log(`received ${cookies.length} cookies -> ${OUT}`);
    console.log(`session cookies present: ${session.map((c) => c.name).join(", ") || "NONE"}`);
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    setTimeout(() => process.exit(session.length ? 0 : 2), 250);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT} (timeout ${TIMEOUT_S}s)`);
});

setTimeout(() => {
  console.error("TIMED OUT waiting for the extension export");
  process.exit(1);
}, TIMEOUT_S * 1000);
