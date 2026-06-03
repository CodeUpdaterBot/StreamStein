/**
 * Early theme apply for extension popup (MV3: must be external — no inline scripts).
 * Keeps <html data-theme="dark"> until a saved preference exists in localStorage.
 * popup.js reconciles with chrome.storage.sync after load.
 */
(function () {
  var KEY = "ytSaverTheme";
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {
    // storage blocked — default dark from popup.html remains
  }
})();
