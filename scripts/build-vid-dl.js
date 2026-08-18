#!/usr/bin/env node
/**
 * Build vid-dl from vendored vid-dl-cli-only-v.2.3.2/ (PyInstaller onedir)
 * and copy to resources/bin/<platform>-<arch>/vid-dl/
 *
 *   npm run build:vid-dl
 *   npm run build:vid-dl -- --force
 *   SKIP_VID_DL=1 npm run build:vid-dl   # skip
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const toolPaths = require("../src/ipc/toolPaths");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SRC = path.join(ROOT, "vid-dl-cli-only-v.2.3.2");

function parseArgs() {
  return {
    force: process.argv.includes("--force"),
    skip: process.argv.includes("--skip"),
  };
}

function resolvePythonCmd() {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3.12"]],
          ["py", ["-3"]],
          ["python"],
          ["python3"],
        ]
      : [
          ["python3.12"],
          ["python3"],
          ["python"],
        ];

  for (const [cmd, prefix] of candidates) {
    const r = spawnSync(cmd, [...prefix, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0) {
      return { cmd, prefix, version: (r.stdout || r.stderr || "").trim() };
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  // Do not use shell: true — paths with spaces (e.g. "Copy (6)") break argument parsing.
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    windowsHide: true,
    ...opts,
  });
  if (r.status !== 0) {
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    throw new Error(`Command failed (${r.status}): ${cmd} ${quoted}`);
  }
}

function runPython(py, args, opts = {}) {
  run(py.cmd, [...py.prefix, ...args], opts);
}

function vidDlExeName() {
  return process.platform === "win32" ? "vid-dl.exe" : "vid-dl";
}

function isValidVidDlDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (!fs.existsSync(path.join(dir, "_internal"))) return false;
  return fs.existsSync(path.join(dir, vidDlExeName()));
}

function findDistOutput(srcDir) {
  const onedir = path.join(srcDir, "dist", "vid-dl");
  if (isValidVidDlDir(onedir)) return onedir;
  return null;
}

function copyVidDl(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  if (process.platform !== "win32") {
    const exe = path.join(dest, "vid-dl");
    if (fs.existsSync(exe)) {
      try {
        fs.chmodSync(exe, 0o755);
      } catch {
        // ignore
      }
    }
  }
}

function resolveIcon(srcDir) {
  for (const candidate of [
    path.join(srcDir, "icon.png"),
    path.join(ROOT, "public", "icon.png"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const { force, skip } = parseArgs();
  if (skip || process.env.SKIP_VID_DL === "1") {
    console.log("Skipping vid-dl build (--skip / SKIP_VID_DL=1)");
    return;
  }

  const srcDir = path.resolve(process.env.VIDDL_SRC || DEFAULT_SRC);
  if (!fs.existsSync(path.join(srcDir, "cli.py"))) {
    throw new Error(`vid-dl source not found: ${srcDir} (expected cli.py)`);
  }

  const key = toolPaths.platformArchKey();
  const destDir = path.join(ROOT, "resources", "bin", key, "vid-dl");

  if (!force && isValidVidDlDir(destDir)) {
    console.log(`vid-dl already built at ${destDir} (use --force to rebuild)`);
    return;
  }

  const py = resolvePythonCmd();
  if (!py) {
    throw new Error(
      "Python 3 not found. Install Python 3.10+ and re-run npm run build:vid-dl.\n" +
        "Or set SKIP_VID_DL=1 to skip (you can still pick a vid-dl folder manually in the download dialog).",
    );
  }

  console.log(`Building vid-dl from ${srcDir}`);
  console.log(`Python: ${py.version}`);
  console.log(`Platform: ${key}`);

  runPython(
    py,
    ["-m", "pip", "install", "-r", "requirements.txt", "pyinstaller", "pillow"],
    { cwd: srcDir },
  );

  const pyInstallerArgs = [
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--onedir",
    "--clean",
    "--noupx",
    "--collect-all",
    "curl_cffi",
    "--exclude-module",
    "pycryptodomex.selftest",
    "--exclude-module",
    "pycryptodomex.tests",
    "--name",
    "vid-dl",
    "cli.py",
  ];

  const icon = resolveIcon(srcDir);
  if (icon) {
    pyInstallerArgs.push("--icon", icon);
    console.log(`Using icon: ${icon}`);
  } else {
    console.log("No icon.png found — building without custom icon");
  }

  runPython(py, pyInstallerArgs, { cwd: srcDir });

  const built = findDistOutput(srcDir);
  if (!built) {
    throw new Error(`PyInstaller finished but dist/vid-dl/ not found under ${srcDir}`);
  }

  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  copyVidDl(built, destDir);
  console.log(`✓ vid-dl → ${destDir}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
