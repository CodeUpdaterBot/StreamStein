#!/usr/bin/env node
/** Quick check: sync Hidden Knowledge folder counts (read-only dry run). */
const path = require("path");
const os = require("os");
const { syncCatalogFromDisk, walkMediaFiles } = require("../src/ipc/youtubeCatalogScan");

const root = path.join(os.homedir(), "Downloads", "YouTube");
const hk = path.join(root, "Hidden Knowledge");
const catalogPath = path.join(root, "youtube-catalog.json");

const disk = walkMediaFiles(hk, 2);
console.log("Hidden Knowledge on disk:", disk.videos.length, "videos");
disk.videos.forEach((p) => console.log(" ", path.basename(p)));

const result = syncCatalogFromDisk(root, catalogPath);
console.log("\nSync result:", JSON.stringify(result, null, 2));
