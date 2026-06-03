#!/usr/bin/env node
/**
 * CLI wrapper — core logic lives in src/ipc/runYoutubeCatalogEnrich.js
 * (also used by the Streamstein desktop app via IPC).
 */
const { main } = require("../src/ipc/runYoutubeCatalogEnrich.js");

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
