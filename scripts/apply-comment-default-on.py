#!/usr/bin/env python3
"""Apply the comment-capture-default edits to the StreamStein YouTube extension.

These two files are CRLF, and the patch tool's multi-line matching does not normalise line
endings, so the edits are done here with explicit \r\n patterns. Every replacement asserts it
matched exactly once, so a silent no-op or a double-apply is impossible.
"""
import pathlib
import sys

EXT = pathlib.Path(r"C:\Users\PC\Documents\Coding Projects\StreamStein\YoutubeDownloaderExtension")
SERVER = EXT / "yt-saver-bridge" / "server.js"
POPUP = EXT / "popup" / "popup.js"


def edit(path: pathlib.Path, old: str, new: str, label: str) -> None:
    raw = path.read_bytes().decode("utf-8")
    n = raw.count(old)
    if n != 1:
        print(f"  FAIL {label}: matched {n} time(s), expected exactly 1")
        sys.exit(1)
    path.write_bytes(raw.replace(old, new).encode("utf-8"))
    print(f"  ok   {label}")


CRLF = "\r\n"

# ── server.js ────────────────────────────────────────────────────────────────────────────
# 1. The default itself: OFF -> ON, with the reason it is now the default.
old = (
    "  // with the catalog-updated notification it reacts to." + CRLF
    + "  saveCommentsOnDownload: false,"
)
new = (
    "  // with the catalog-updated notification it reacts to." + CRLF
    + "  //" + CRLF
    + "  // ON by default: a download is the one moment we already have the video in hand, and" + CRLF
    + "  // capturing then avoids ever needing a bulk catch-up pass over the library. The" + CRLF
    + "  // extension's settings pane turns it off per user; the value is posted here as" + CRLF
    + "  // saveCommentsOnDownload and rides along with each finished download." + CRLF
    + "  saveCommentsOnDownload: true,"
)
edit(SERVER, old, new, "server: default saveCommentsOnDownload = true")

# 2. Migration on load: a config written before CONFIG_VERSION 2 carries the old default.
old = (
    '          whisperCommand: typeof parsed.whisperCommand === "string" '
    '? parsed.whisperCommand : serverConfig.whisperCommand,' + CRLF
)
new = (
    old
    + "          // Comment capture flipped ON by default (CONFIG_VERSION 2). A config saved under" + CRLF
    + "          // the old default carries `false` through the spread above, freezing the old" + CRLF
    + "          // behaviour on every existing install even though the user never chose it - so" + CRLF
    + "          // an unversioned config is migrated once. At v2+ the stored value is honoured," + CRLF
    + "          // which is what makes an explicit OFF stick." + CRLF
    + "          saveCommentsOnDownload:" + CRLF
    + "            Number(parsed.configVersion || 1) >= CONFIG_VERSION"
    + " ? parsed.saveCommentsOnDownload === true : true," + CRLF
    + "          configVersion: Math.max(Number(parsed.configVersion || 1), CONFIG_VERSION)," + CRLF
)
edit(SERVER, old, new, "server: migrate unversioned config on load")

# 3. Stamp the version whenever the config is written, so the migration runs only once.
old = "    applyBundledYoutubeCookiesDefaults();" + CRLF + "    persistServerConfig();"
new = (
    "    applyBundledYoutubeCookiesDefaults();" + CRLF
    + "    serverConfig.configVersion = CONFIG_VERSION;" + CRLF
    + "    persistServerConfig();"
)
edit(SERVER, old, new, "server: persist configVersion on save")

# ── popup.js ─────────────────────────────────────────────────────────────────────────────
# 4. The extension-side default.
old = (
    "  // Capture each downloaded video's comments (sidecar + catalog record). Off by" + CRLF
    + "  // default: it adds a comment fetch to every download. Flipped on in the" + CRLF
    + "  // extension's settings pane; the bridge passes it to the app with each download." + CRLF
    + "  downloadComments: false,"
)
new = (
    "  // Capture each downloaded video's comments (sidecar + catalog record). ON by default:" + CRLF
    + "  // a download is the one moment we already have the video in hand, and capturing then" + CRLF
    + "  // avoids ever needing a bulk catch-up pass over the library. The settings pane turns it" + CRLF
    + "  // off, and that choice reaches the bridge as saveCommentsOnDownload." + CRLF
    + "  downloadComments: true,"
)
edit(POPUP, old, new, "popup: default downloadComments = true")

# 5. Version constant, so the migration below has one source of truth.
old = "let appSettings = { ...DEFAULT_SETTINGS };"
new = (
    "// Bumped when a stored settings object needs a one-time migration (see loadSettings)." + CRLF
    + "const SETTINGS_VERSION = 2;" + CRLF
    + CRLF
    + "let appSettings = { ...DEFAULT_SETTINGS };"
)
edit(POPUP, old, new, "popup: add SETTINGS_VERSION")

# 6. Migration on load (chrome.storage.sync persists the old default).
old = (
    "      appSettings = { ...DEFAULT_SETTINGS };" + CRLF
    + "    }" + CRLF
    + "    callback?.(appSettings);"
)
new = (
    "      appSettings = { ...DEFAULT_SETTINGS };" + CRLF
    + "    }" + CRLF
    + "    // Comment capture became ON by default for new downloads. An install that saved" + CRLF
    + "    // settings under the OLD default carries downloadComments:false forward through the" + CRLF
    + "    // spread above, which would silently keep the old behaviour forever - so migrate an" + CRLF
    + "    // unversioned stored object once. At v2+ the stored value is honoured, so a later" + CRLF
    + "    // explicit OFF from the user sticks." + CRLF
    + "    if (!stored || Number(stored.settingsVersion || 1) < SETTINGS_VERSION) {" + CRLF
    + "      appSettings.downloadComments = true;" + CRLF
    + "      appSettings.settingsVersion = SETTINGS_VERSION;" + CRLF
    + "      chrome.storage?.sync?.set?.({ ytSaverSettings: appSettings });" + CRLF
    + "    }" + CRLF
    + "    callback?.(appSettings);"
)
edit(POPUP, old, new, "popup: migrate stored settings on load")

# 7. Preserve the version through saves.
old = "    downloadComments: Boolean(newSettings.downloadComments),"
new = (
    "    downloadComments: Boolean(newSettings.downloadComments)," + CRLF
    + "    settingsVersion: SETTINGS_VERSION,"
)
edit(POPUP, old, new, "popup: carry settingsVersion through saveSettings")

print("all edits applied")
