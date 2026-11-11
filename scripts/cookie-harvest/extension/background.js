/**
 * Temporary extension for the StreamStein comment fetcher: hand yt-dlp the YouTube cookies.
 *
 * Why an extension instead of reading the profile: Chrome 157 encrypts cookies with
 * App-Bound Encryption, so no outside process can decrypt the cookie database (yt-dlp gets
 * "Failed to decrypt with DPAPI"), and Chrome 136+ ignores --remote-debugging-port on the
 * default profile. An extension does not fight any of that: it asks CHROME for the cookies
 * through the supported chrome.cookies API, and Chrome decrypts them properly because it is
 * the application that owns the key.
 *
 * The cookies are POSTed to a listener on localhost and never leave the machine. Values are
 * written straight to the output file by the listener, never logged.
 */

const ENDPOINT = "http://127.0.0.1:8799/cookies";

async function harvest() {
  const [yt, gg] = await Promise.all([
    chrome.cookies.getAll({ domain: "youtube.com" }),
    chrome.cookies.getAll({ domain: "google.com" }),
  ]);
  const cookies = [...yt, ...gg];
  const payload = cookies.map((c) => ({
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate || 0,
    name: c.name,
    value: c.value,
  }));
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: payload }),
    });
    console.log("harvest posted", payload.length, "cookies ->", res.status);
  } catch (err) {
    console.log("harvest post failed:", String(err));
  }
}

chrome.runtime.onStartup?.addListener(harvest);
chrome.runtime.onInstalled?.addListener(harvest);
// Also run immediately: with --load-extension into an already-starting browser, the
// startup event may have fired before the worker was registered.
harvest();
setTimeout(harvest, 4000);
