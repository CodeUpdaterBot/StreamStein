#!/usr/bin/env python3
"""Add /live/<videoId> support to the YouTube downloader extension.

A live stream (in progress or a past one) is served at /live/<id>, and YouTube keeps that
path when the page is opened from the Live tab or a shared /live link. The extension only
recognised /watch?v= and /shorts/, so a perfectly good video produced "Active tab is not a
YouTube video." and the URL box stayed empty (reported 2026-11-12 on
https://www.youtube.com/live/AYivz_QumFo).

Three places had to agree, or the download would work but the catalog record and the comment
sidecar would have no video id:
  1. popup isYouTubeWatchUrl()  - decides whether the tab is a video at all
  2. popup extractVideoId()     - pulls the id out for the catalog/comments
  3. background extractVideoId() - same, on the download worker side
plus normalising the detected URL to the canonical watch form, so one video is not stored
under two different URLs depending on how it was opened.

Both files are CRLF; every replacement asserts it matched exactly once.
"""
import pathlib
import sys

POPUP = pathlib.Path(
    r"C:\Users\PC\Documents\Coding Projects\StreamStein\YoutubeDownloaderExtension\popup\popup.js"
)
BG = pathlib.Path(
    r"C:\Users\PC\Documents\Coding Projects\StreamStein\YoutubeDownloaderExtension\background.js"
)
CRLF = "\r\n"


def edit(path: pathlib.Path, old: str, new: str, label: str) -> None:
    raw = path.read_bytes().decode("utf-8")
    n = raw.count(old)
    if n != 1:
        print(f"  FAIL {label}: matched {n} time(s), expected exactly 1")
        sys.exit(1)
    path.write_bytes(raw.replace(old, new).encode("utf-8"))
    print(f"  ok   {label}")


# ── 1. popup: is this tab a video? ───────────────────────────────────────────────────────
old = (
    '    const isWatch = u.pathname.startsWith("/watch") && !!u.searchParams.get("v");' + CRLF
    + '    const isShort = u.pathname.split("/").includes("shorts");' + CRLF
    + "    return isWatch || isShort;"
)
new = (
    '    const isWatch = u.pathname.startsWith("/watch") && !!u.searchParams.get("v");' + CRLF
    + '    const isShort = u.pathname.split("/").includes("shorts");' + CRLF
    + "    // A live stream - in progress, or a finished one - is served at /live/<videoId>," + CRLF
    + "    // and YouTube keeps that path when the page is opened from the Live tab or a" + CRLF
    + "    // shared /live link. It is an ordinary watchable video; without this the popup" + CRLF
    + '    // said "Active tab is not a YouTube video." on a perfectly good page.' + CRLF
    + '    const isLive = u.pathname.startsWith("/live/") && !!u.pathname.split("/")[2];' + CRLF
    + "    return isWatch || isShort || isLive;"
)
edit(POPUP, old, new, "popup: isYouTubeWatchUrl accepts /live/<id>")

# ── 2. popup: extract the id ─────────────────────────────────────────────────────────────
old = (
    '    const parts = u.pathname.split("/");' + CRLF
    + '    const shortsIndex = parts.indexOf("shorts");' + CRLF
    + "    if (shortsIndex !== -1 && parts[shortsIndex + 1]) {" + CRLF
    + "      return parts[shortsIndex + 1];" + CRLF
    + "    }" + CRLF
    + CRLF
    + "    return null;"
)
new = (
    '    const parts = u.pathname.split("/");' + CRLF
    + '    const shortsIndex = parts.indexOf("shorts");' + CRLF
    + "    if (shortsIndex !== -1 && parts[shortsIndex + 1]) {" + CRLF
    + "      return parts[shortsIndex + 1];" + CRLF
    + "    }" + CRLF
    + CRLF
    + "    // /live/<videoId> - same video, same id, live now or streamed earlier." + CRLF
    + '    const liveIndex = parts.indexOf("live");' + CRLF
    + "    if (liveIndex !== -1 && parts[liveIndex + 1]) {" + CRLF
    + "      return parts[liveIndex + 1];" + CRLF
    + "    }" + CRLF
    + CRLF
    + "    return null;"
)
edit(POPUP, old, new, "popup: extractVideoId accepts /live/<id>")

# ── 3. popup: canonical helper (one video, one URL in the library) ───────────────────────
old = "// Safe filename from video title" + CRLF + "function sanitizeFileName(name) {"
new = (
    "// The canonical watch URL for any video we accept. A /live/<id> page is the same video" + CRLF
    + "// as /watch?v=<id>, and everything downstream (catalog record, comment sidecar," + CRLF
    + "// transcript) is keyed to the watch URL - so normalise instead of storing two URLs for" + CRLF
    + "// one video depending on how the tab was opened." + CRLF
    + "function canonicalWatchUrl(url) {" + CRLF
    + "  const id = extractVideoId(url);" + CRLF
    + "  return id ? `https://www.youtube.com/watch?v=${id}` : url;" + CRLF
    + "}" + CRLF
    + CRLF
    + "// Safe filename from video title" + CRLF
    + "function sanitizeFileName(name) {"
)
edit(POPUP, old, new, "popup: add canonicalWatchUrl()")

# ── 4. popup: use it when the tab is detected ────────────────────────────────────────────
old = (
    "    if (url && isYouTubeWatchUrl(url)) {" + CRLF
    + "      videoUrlInput.value = url;" + CRLF
    + '      setSingleVideoStatusWithLibrary("Detected current tab as a YouTube video.", "success", null);' + CRLF
    + '      scheduleSingleVideoLibraryCheck(url, "Detected current tab as a YouTube video.", "success");'
)
new = (
    "    if (url && isYouTubeWatchUrl(url)) {" + CRLF
    + "      // Store the canonical watch URL even when the tab is a /live page." + CRLF
    + "      const canonical = canonicalWatchUrl(url);" + CRLF
    + "      videoUrlInput.value = canonical;" + CRLF
    + '      setSingleVideoStatusWithLibrary("Detected current tab as a YouTube video.", "success", null);' + CRLF
    + '      scheduleSingleVideoLibraryCheck(canonical, "Detected current tab as a YouTube video.", "success");'
)
edit(POPUP, old, new, "popup: normalise the detected URL")

# ── 5. background: the download worker's own id extraction ───────────────────────────────
old = (
    '    const segments = url.pathname.split("/").filter(Boolean);' + CRLF
    + '    if (segments[0] === "shorts" && segments[1]) return segments[1];'
)
new = (
    '    const segments = url.pathname.split("/").filter(Boolean);' + CRLF
    + '    if (segments[0] === "shorts" && segments[1]) return segments[1];' + CRLF
    + "    // /live/<videoId> - a live stream (current or past) is the same video as" + CRLF
    + "    // /watch?v=<id>; without this the catalog record and the comments sidecar would" + CRLF
    + "    // be written with a null video id." + CRLF
    + '    if (segments[0] === "live" && segments[1]) return segments[1];'
)
edit(BG, old, new, "background: extractVideoId accepts /live/<id>")

print("all edits applied")
