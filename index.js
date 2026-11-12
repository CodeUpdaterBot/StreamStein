// -- Streamstein main process entry point --------------------------------------
// Responsible for: window creation, session setup, ad-blocking, scheduled
// backup trigger, and app lifecycle. All heavy IPC logic lives in src/ipc/.

const { app, BrowserWindow, ipcMain, session, webContents, Notification, powerSaveBlocker } =
  require("electron");
const fs = require("fs");
const path = require("path");

function resolveAppIcon() {
  if (process.platform === "linux") {
    const linuxIcon = path.join(__dirname, "public", "sized", "256x256.png");
    if (fs.existsSync(linuxIcon)) return linuxIcon;
  }
  for (const rel of ["public/icon.png", "dist/icon.png"]) {
    const candidate = path.join(__dirname, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Chromium sometimes emits benign WidgetHost mojo rejections while native media
// elements/webviews are torn down. Keep real stderr output, filter only this noise.
if (process.env.STREAMSTEIN_CHROMIUM_NOISE !== "1") {
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (
      text.includes("interface_endpoint_client.cc:732") &&
      text.includes("rejected by interface blink.mojom.WidgetHost")
    ) {
      if (typeof cb === "function") cb();
      return true;
    }
    return stderrWrite(chunk, encoding, cb);
  };
}

// Before any userData access: migrate %APPDATA%\streambert → streamstein if needed.
const { configureUserDataPath } = require("./src/ipc/profileMigration");
configureUserDataPath(app);

// -- Playback keep-awake -------------------------------------------------------
let _psbId = null;
function setPlaybackKeepAwake(active) {
  try {
    if (active) {
      if (_psbId == null || !powerSaveBlocker.isStarted(_psbId)) {
        _psbId = powerSaveBlocker.start("prevent-display-sleep");
      }
    } else if (_psbId != null) {
      if (powerSaveBlocker.isStarted(_psbId)) powerSaveBlocker.stop(_psbId);
      _psbId = null;
    }
  } catch {}
}

// -- RAM / performance flags ---------------------------------------------------
// Low-RAM mode is ON by default; set STREAMSTEIN_LOW_RAM=0 (or the upstream name
// STREAMBERT_LOW_RAM=0) to run with Chromium's defaults.
//
// HardwareMediaKeyHandling and MediaSessionService are deliberately NOT disabled any
// more (upstream dropped this in 44682f5): it broke the media keys and the Media
// Session API for no measurable memory win. UseSandboxedXdgPortal is left alone too.
if (
  process.env.STREAMSTEIN_LOW_RAM === undefined &&
  process.env.STREAMBERT_LOW_RAM === undefined
) {
  process.env.STREAMSTEIN_LOW_RAM = "1";
}
const LOW_RAM =
  process.env.STREAMSTEIN_LOW_RAM !== "0" &&
  process.env.STREAMBERT_LOW_RAM !== "0";
console.log(LOW_RAM ? "LOW_RAM mode on" : "LOW_RAM mode off");
if (LOW_RAM) {
  app.commandLine.appendSwitch(
    "js-flags",
    "--max-old-space-size=256 --expose-gc",
  );
}
// The in-app player is always user initiated; don't let Chromium block the
// async handoff from React/IPC to the actual <video>.play() call.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// NOTE: enable-low-end-device-mode removed, it cuts the GPU texture tile budget
// and causes visible seams/stripes/dots on large images.
if (LOW_RAM) {
  // Run the network stack in the browser process → one less utility process
  app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
  // Cap disk cache and limit renderer processes (prevents RAM growth on multi-page
  // navigation)
  app.commandLine.appendSwitch("disk-cache-size", String(80 * 1024 * 1024));
  app.commandLine.appendSwitch("renderer-process-limit", "3");
}

// -- Startup benchmark ---------------------------------------------------------
const _t0 = Date.now();
const _bench = (label) =>
  console.log(`[boot] ${label}: +${Date.now() - _t0}ms`);

// -- Sub-modules ---------------------------------------------------------------
const blockStats = require("./src/ipc/blockStats");
const storageIpc = require("./src/ipc/storage");
const downloadsIpc = require("./src/ipc/downloads");
const subtitlesIpc = require("./src/ipc/subtitles");
const siteTweaks = require("./src/ipc/siteTweaks");
const hianimeIpc = require("./src/ipc/hianime");
const playerIpc = require("./src/ipc/player");
const castIpc = require("./src/ipc/cast");
const streamResolver = require("./src/ipc/streamResolver");
const playerSession = require("./src/ipc/playerSession");
const seriesDownloadIpc = require("./src/ipc/seriesDownload");
const localMediaIpc = require("./src/ipc/localMedia");
const youtubeLibraryIpc = require("./src/ipc/youtubeLibrary");
const youtubeCommentsIpc = require("./src/ipc/youtubeComments");
const youtubeCatalogEnrichIpc = require("./src/ipc/youtubeCatalogEnrich");
const toolPaths = require("./src/ipc/toolPaths");
const ytBridge = require("./src/ipc/ytBridge");
const ytDlpUpdater = require("./src/ipc/ytDlpUpdateService.cjs");
const libraryPathsMain = require("./src/ipc/libraryPathsMain");
toolPaths.bindElectronApp(app);
// Local playback uses loopback HTTP (started in app.whenReady)
localMediaIpc.registerPrivilegedScheme();

// -- Ad/tracker block list -----------------------------------------------------
const BLOCKED_HOSTS = [
  "*://www.google-analytics.com/*",
  "*://analytics.google.com/*",
  "*://googletagmanager.com/*",
  "*://www.googletagmanager.com/*",
  "*://googletagservices.com/*",
  "*://doubleclick.net/*",
  "*://*.doubleclick.net/*",
  "*://adservice.google.com/*",
  "*://adservice.google.de/*",
  "*://pagead2.googlesyndication.com/*",
  "*://stats.g.doubleclick.net/*",
  "*://yt3.ggpht.com/ytc/*",
  "*://fonts.googleapis.com/*",
  "*://fonts.gstatic.com/*",
  "*://googleapis.com/*",
  "*://gstatic.com/*",
  "*://cdn.adx1.com/*",
  "*://intelligenceadx.com/*",
  "*://adsco.re/*",
  "*://mc.yandex.com/*",
  "*://mc.yandex.ru/*",
  "*://bvtpk.com/*",
  "*://my.rtmark.net/*",
  "*://bvtpk.com/*",
  "*://b7510.com/*",
  "*://gt.unbrownunflat.com/*",
  "*://im.malocacomals.com/*",
  "*://users.videasy.net/*",
  "*://nf.sixmossin.com/*",
  "*://realizationnewestfangs.com/*",
  "*://acscdn.com/*",
  "*://lt.taloseempest.com/*",
  "*://pl26708123.profitableratecpm.com/*",
  "*://preferencenail.com/*",
  "*://protrafficinspector.com/*",
  "*://s10.histats.com/*",
  "*://weirdopt.com/*",
  "*://static.cloudflareinsights.com/*",
  "*://kettledroopingcontinuation.com/*",
  "*://wayfarerorthodox.com/*",
  "*://woxaglasuy.net/*",
  "*://adeptspiritual.com/*",
  "*://www.calculating-laugh.com/*",
  "*://amavhxdlofklxjg.xyz/*",
  "*://7jtjubf8p5kq7x3z2.u3qleufcm6vure326ktfpbj.cfd/*",
  "*://5mq.get64t9vqg8pnbex1y463o.rest/*",
  "*://usrpubtrk.com/*",
  "*://adexchangeclear.com/*",
  "*://rzjzjnavztycv.online/*",
  "*://tmstr4.cloudnestra.com/*",
  "*://tmstr4.neonhorizonworkshops.com/*",
  "*://cloudflareinsights.com/*",
  "*://*.cloudflareinsights.com/*",
  "*://hameltnoummos.com/*",
  "*://ancillammmm.com/*",
  "*://*.ancillammmm.com/*",
  "*://hubeamily.com/*",
  "*://*.hubeamily.com/*",
  "*://llvpn.com/*",
  "*://americanacademyofthermology.org/*",
  "*://d2pf0ys5xus6n.cloudfront.net/*",
  "*://gillyspencie.com/*",
  "*://soakysecrets.com/*",
  "*://*.soakysecrets.com/*",
  "*://mdstats.info/*",
  "*://ads-twitter.com/*",
  "*://*.ads-twitter.com/*",
  "*://connatix.com/*",
  "*://*.connatix.com/*",
  "*://imasdk.googleapis.com/*",
  "*://jwpltx.com/*",
  "*://*.jwpltx.com/*",
  "*://improving.duckduckgo.com/*",
  "*://openfpcdn.io/*",
  "*://phruk.org/*",
  "*://welcomingexpulsion.com/*",
  "*://pgo99.com/*",
  "*://todditehexarch.com/*",
  "*://*.todditehexarch.com/*",
  "*://uniolaicecaps.com/*",
  "*://*.uniolaicecaps.com/*",
  "*://alloha.tv/*",
  "*://*.alloha.tv/*",
  "*://pc.alloviewroll.com/*",
  "*://yadro.ru/*",
  "*://*.yadro.ru/*",
  "*://getaim.org/*",
  "*://*.getaim.org/*",
  "*://myangular.life/*",
  "*://*.myangular.life/*",
  "*://rstprgapipt.com/*",
  "*://*.rstprgapipt.com/*",
  "*://veselchaga.link/*",
  "*://webvisor.org/*",
  "*://*.webvisor.org/*",
  "*://datariaarpent.com/*",
  "*://*.datariaarpent.com/*",
  "*://gamesrevenue.com/*",
  "*://*.gamesrevenue.com/*",
  "*://73ed366d3137ec936bd60b1184467776.com/*",
  "*://shankedunwindy.cyou/*",
  "*://*.shankedunwindy.cyou/*",
  "*://908df012d9bb72e6d26b41054588d758.com/*",
  "*://asemquips.cfd/*",
  "*://*.asemquips.cfd/*",
  "*://epicgameshubham.com/*",
  "*://tantrajoni.cfd/*",
  "*://thatdisform.cyou/*",
  "*://vdrk.site/*",
  "*://*.vdrk.site/*",
  "*://*.adsco.re/*",
  "*://aarems.org/*",
  "*://*.aarems.org/*",
  "*://aerionvel.com/*",
  "*://*.aerionvel.com/*",
  "*://cdn4ads.com/*",
  "*://*.cdn4ads.com/*",
  "*://directyp.org/*",
  "*://*.directyp.org/*",
  "*://fakerstoterframing.qpon/*",
  "*://*.fakerstoterframing.qpon/*",
  "*://karthliunstagy.com/*",
  "*://*.karthliunstagy.com/*",
  "*://nresystems.com/*",
  "*://*.nresystems.com/*",
  "*://sainwertapr.com/*",
  "*://*.sainwertapr.com/*",
  "*://*.tantrajoni.cfd/*",
  "*://*.thatdisform.cyou/*",
  "*://pxltag.com/*",
  "*://*.pxltag.com/*",
  "*://runative-syndicate.com/*",
  "*://*.runative-syndicate.com/*",
  "*://saidairakas.com/*",
  "*://*.saidairakas.com/*",
  "*://coiffesreal.qpon/*",
  "*://*.coiffesreal.qpon/*",
  "*://solarcyclonesky.com/*",
  "*://*.solarcyclonesky.com/*",
  "*://bawrelcuttail.com/*",
  "*://*.bawrelcuttail.com/*",
  "*://tabaxirethnize.cyou/*",
  "*://*.tabaxirethnize.cyou/*",
  "*://thyriswh.cyou/*",
  "*://*.thyriswh.cyou/*",
  "*://ukankingwithea.com/*",
  "*://*.ukankingwithea.com/*",
  "*://uuidksinc.net/*",
  "*://*.uuidksinc.net/*",
  "*://blockadsnot.com/*",
  "*://*.blockadsnot.com/*",
  "*://canseealltheugline.org/*",
  "*://*.canseealltheugline.org/*",
  "*://eifitcannotke.org/*",
  "*://*.eifitcannotke.org/*",
  "*://embercascademaple.com/*",
  "*://*.embercascademaple.com/*",
  "*://bancadeltempoidea.org/*",
  "*://*.bancadeltempoidea.org/*",
  "*://1158060716.rsc.cdn77.org/*",
  "*://facebook.com/*",
  "*://tryedesign.com/*",
  "*://*.tryedesign.com/*",
  "*://ahacdn.me/*",
  "*://*.ahacdn.me/*",
  "*://autorepairworcester.com/*",
  "*://aelwynvel.com/*",
  "*://*.aelwynvel.com/*",
  "*://cometslourdy.cfd/*",
  "*://*.cometslourdy.cfd/*",
  "*://pusleybrand.cyou/*",
  "*://*.pusleybrand.cyou/*",
  "*://luugy.com/*",
  "*://*.luugy.com/*",
  "*://nimbusgrovelodge.com/*",
  "*://*.nimbusgrovelodge.com/*",
  "*://brushetenglandagacant.qpon/*",
  "*://*.brushetenglandagacant.qpon/*",
  "*://hyaloidsatury.com/*",
  "*://*.hyaloidsatury.com/*",
  "*://*.google-analytics.com/*",
  "*://stummelbeelbow.com/*",
  "*://*.stummelbeelbow.com/*",
  "*://mgid.com/*",
  "*://*.mgid.com/*",
  "*://deedwaifpleas.org/*",
  "*://*.deedwaifpleas.org/*",
  "*://pushaffiliate.net/*",
  "*://*.pushaffiliate.net/*",
  "*://imp-mintads.site/*",
  "*://*.imp-mintads.site/*",
  "*://oceanicdreamcove.com/*",
  "*://*.oceanicdreamcove.com/*",
  "*://xadsmart.com/*",
  "*://*.xadsmart.com/*",
  "*://srvqk3.com/*",
  "*://*.srvqk3.com/*",
  "*://1376341044.rsc.cdn77.org/*",
  "*://adright.xml-v4.ak-is2.net/*",
  "*://csp-reporting.cloudflare.com/*",
  "*://*.facebook.com/*",
  "*://cysyjucymudity.com/*",
  "*://*.cysyjucymudity.com/*",
  "*://pncloudfl.com/*",
  "*://*.pncloudfl.com/*",
  "*://cruzswim.org/*",
  "*://*.cruzswim.org/*",
  "*://darnobedienceupscale.com/*",
  "*://*.darnobedienceupscale.com/*",
  "*://derricknationtop.com/*",
  "*://*.derricknationtop.com/*",
  "*://e89d45b16370ee7e43daeaf6ce8d9547.com/*",
  "*://*.e89d45b16370ee7e43daeaf6ce8d9547.com/*",
  "*://tsyndicate.com/*",
  "*://*.tsyndicate.com/*",
  "*://rapidadexchange.com/*",
  "*://*.rapidadexchange.com/*",
  "*://cepesbritons.qpon/*",
  "*://*.cepesbritons.qpon/*",
  "*://sarplerlacunes.qpon/*",
  "*://*.sarplerlacunes.qpon/*",
  "*://usrpubtrck.com/*",
  "*://*.usrpubtrck.com/*",
  "*://ixiondartman.com/*",
  "*://*.ixiondartman.com/*",
  "*://varnishtala.cyou/*",
  "*://*.varnishtala.cyou/*",
  "*://1037973644.rsc.cdn77.org/*",
  "*://cdn.pncloudfl.com.cdn.cloudflare.net/*",
];

// -- Clean user agent ----------------------------------------------------------
// The real Chromium UA of this Electron build, minus the "Electron/x.y.z" and app
// tokens. Handed to the renderer for the few sources that block an obvious Electron
// UA (vidfast). The player session itself keeps Electron's untouched default UA —
// modifying that is what made Cloudflare Turnstile fail (error 600010); see
// src/ipc/playerSession.js.
function buildCleanUserAgent() {
  return app.userAgentFallback
    .replace(/\s?Electron\/\S+/i, "")
    .replace(/\s?streamstein\/\S+/i, "")
    .replace(/\s?streambert\/\S+/i, "")
    .trim();
}

// Synchronous: the renderer reads this while constructing a <webview>.
ipcMain.on("get-clean-user-agent", (event) => {
  event.returnValue = buildCleanUserAgent();
});

// -- Popup handling ------------------------------------------------------------
// Popups are denied. Some players (e.g. Vidrift) test window.open() on the first
// click and show "Remove sandboxing to enable playback" when it returns null, so for
// those hosts we hand out a real but hidden, stopped window instead. Add a host here
// if another player shows the same message.
const POPUP_STUB_HOSTS = ["vidrift.net", "vidrift.in"];

function urlMatchesHosts(url, hosts) {
  try {
    const host = new URL(url).hostname;
    return hosts.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function installPopupHandler(wc) {
  wc.setWindowOpenHandler(() => {
    if (!urlMatchesHosts(wc.getURL(), POPUP_STUB_HOSTS)) {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        show: false,
        width: 1,
        height: 1,
        skipTaskbar: true,
        webPreferences: { backgroundThrottling: true },
      },
    };
  });
  wc.on("did-create-window", (win) => {
    try {
      win.webContents.setAudioMuted(true);
      // Don't load the popup target; keep the object alive briefly so
      // `popup.closed` stays false for the opener's check.
      win.webContents.stop();
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 5000);
    } catch {}
  });
}

// -- Module-level state --------------------------------------------------------
let mainWindow = null;
const getMainWindow = () => mainWindow;

const playerWcIds = new Set();
playerSession.registerPlayerSessionDeps({
  getMainWindow,
  streamResolver,
  blockStats,
  blockedHosts: BLOCKED_HOSTS,
});
streamResolver.bindPlayerSession(playerSession);
// JIT stream resolve for queued series downloads (fresh m3u8 at spawn time)
downloadsIpc.setResolveStreamForDownload((ctx) =>
  streamResolver.resolveStreamWithFallback(ctx || {}),
);
// Seed default Chrome Profile 69 cookies for movie/TV downloads
try {
  const downloadAuth = require("./src/ipc/downloadAuth");
  const prefs = downloadAuth.loadPrefs();
  if (!prefs.cookiesFromBrowser) {
    downloadAuth.savePrefs(downloadAuth.DEFAULT_PREFS);
  }
} catch {}

function ensurePlayerSessions() {
  playerSession.ensurePlayerSessions();
}

function createWindow() {
  ensurePlayerSessions();
  storageIpc.applySecretMigrationIfNeeded();
  downloadsIpc.loadDownloads();
  blockStats.loadBlockStats();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    icon: resolveAppIcon(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
      // Caps the renderer's V8 heap + exposes gc() for manual GC hints after
      // navigation (low-RAM mode only)
      additionalArguments: LOW_RAM
        ? ["--js-flags=--max-old-space-size=256 --expose-gc"]
        : [],
    },
  });

  // Force long-lived disk caching for TMDB images in the default session.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["*://image.tmdb.org/*"] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers["cache-control"] = ["public, max-age=604800, immutable"]; // 7 days
      delete headers["pragma"];
      delete headers["expires"];
      callback({ responseHeaders: headers });
    },
  );

  // -- Lazy session setup ----------------------------------------------------
  // Player/trailer sessions are configured on the first webview attach or
  // when the pop-out window opens, whichever comes first.

  // Configure the player/trailer sessions BEFORE the guest is created, so the very
  // first player load already has ad blocking + document-start guards (upstream
  // 44682f5).
  mainWindow.webContents.on("will-attach-webview", () => {
    ensurePlayerSessions();
  });

  // Block popups from webviews, intercept fullscreen, lazy-init sessions
  mainWindow.webContents.on("did-attach-webview", (_, wc) => {
    ensurePlayerSessions();

    // Track player webviews for cleanup on player-stopped
    try {
      if (wc.session === session.fromPartition("persist:player")) {
        playerWcIds.add(wc.id);
        wc.once("destroyed", () => playerWcIds.delete(wc.id));
        // Per-site CSS (e.g. show only the player on KinoHub)
        siteTweaks.attach(wc);
      }
    } catch {}

    installPopupHandler(wc);
    wc.on("enter-html-full-screen", () =>
      mainWindow.webContents.send("webview-enter-fullscreen"),
    );
    wc.on("leave-html-full-screen", () =>
      mainWindow.webContents.send("webview-leave-fullscreen"),
    );
  });

  mainWindow.loadFile(path.join(__dirname, "dist/index.html"));

  // Trigger scheduled backup after load
  mainWindow.webContents.once("did-finish-load", () => {
    _bench("renderer loaded");
    const sbSettings = storageIpc.loadScheduledBackupSettings();
    if (storageIpc.shouldRunScheduledBackup(sbSettings)) {
      mainWindow.webContents.send("scheduled-backup-requested");
    }
  });

  // Intercept close if downloads are active
  let closeResponsePending = false;
  mainWindow.on("close", (e) => {
    const running = downloadsIpc
      .getDownloads()
      .filter(
        (d) =>
          d.status === "downloading" ||
          d.status === "queued" ||
          d.status === "resolving",
      );
    if (running.length === 0) return;
    e.preventDefault();
    if (closeResponsePending) return;
    closeResponsePending = true;
    mainWindow.webContents.send("confirm-close", { count: running.length });
  });

  ipcMain.on("close-response", (_, confirmed) => {
    closeResponsePending = false;
    if (confirmed) {
      downloadsIpc.killAllDownloads();
      mainWindow.destroy();
    }
  });

  mainWindow.on("closed", () => {
    setPlaybackKeepAwake(false);
    mainWindow = null;
    app.quit();
  });
}

// -- Register all IPC modules --------------------------------------------------
storageIpc.register();
downloadsIpc.register(getMainWindow);
subtitlesIpc.register({
  getDownloads: downloadsIpc.getDownloads,
  saveDownloads: downloadsIpc.saveDownloads,
});
hianimeIpc.register();
playerIpc.register(getMainWindow, {
  writeSecretMigration: storageIpc.writeSecretMigration,
});
blockStats.init(getMainWindow);
castIpc.register(getMainWindow);
localMediaIpc.register();
youtubeLibraryIpc.register();
youtubeCommentsIpc.register();
youtubeCatalogEnrichIpc.register(getMainWindow);
toolPaths.register(ipcMain);
ytBridge.register(ipcMain);
ytDlpUpdater.register({
  onUpdated: () => ytBridge.syncBridgeToolPaths(),
});
libraryPathsMain.register(ipcMain);
seriesDownloadIpc.register(getMainWindow, {
  cancelQueuedBySeriesBatch: (batchId) =>
    downloadsIpc.cancelQueuedBySeriesBatch(batchId),
});

ipcMain.handle("playback-keepawake", (_event, active) => {
  setPlaybackKeepAwake(!!active);
});

app.on("before-quit", () => setPlaybackKeepAwake(false));

// get-block-stats lives with its data
ipcMain.handle("get-block-stats", () => blockStats.getBlockStats());

// -- Player memory cleanup ---------------------------------------------
// Called by MoviePage / TVPage on component unmount.
// Mutes the tracked player webview WebContents and triggers GC hints.
ipcMain.on("player-stopped", () => {
  try {
    localMediaIpc.releaseLocalMediaPlayback();
  } catch {}

  // Step 1: Mute the tracked player WebContents ONLY. They must not be destroyed
  // with wc.destroy(): removing the <webview> element in the renderer already tears
  // the guest down cleanly, and destroying it by hand made every player reopen pay
  // for an unnecessary teardown (upstream 44682f5).
  for (const id of playerWcIds) {
    try {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.setAudioMuted(true);
        } catch {}
      }
    } catch {}
  }
  playerWcIds.clear();

  // Step 2: Flushing the player session's HTTP/shader caches was removed on
  // purpose (upstream 44682f5): it cost more than it saved, and the renderer-side
  // teardown already reclaims the memory.

  // Step 3: GC hints
  if (typeof global.gc === "function") global.gc();
  const mw = mainWindow;
  if (mw && !mw.isDestroyed()) {
    mw.webContents
      .executeJavaScript("if(typeof gc==='function') gc();")
      .catch(() => {});
  }
});

// -- Wyzie API Key Redemption Window ------------------------------------------
// Opens https://sub.wyzie.io/redeem in a child BrowserWindow, watches the DOM
// for the api-key-display element, extracts the key, and sends it back.
ipcMain.handle("wyzie-open-redeem", async () => {
  return new Promise((resolve) => {
    const { BrowserWindow: BW, session: electronSession } = require("electron");
    // Use a non-persistent session so NO cookies/storage are saved after the window closes
    const redeemSession = electronSession.fromPartition(
      "partition:wyzie-redeem",
    );
    // Strip restrictive CSP so the page styles load correctly
    redeemSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers["content-security-policy"];
      delete headers["Content-Security-Policy"];
      callback({ responseHeaders: headers });
    });

    const win = new BW({
      width: 960,
      height: 720,
      title: "Claim your Wyzie API Key",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        session: redeemSession,
      },
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
    });

    let resolved = false;
    let timeout = null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    win.on("closed", () => {
      if (!resolved) resolve({ ok: false, key: null, cancelled: true });
      clearTimeout(timeout);
    });

    // Start the 20 s timer only once the page has finished loading
    win.webContents.once("did-finish-load", () => {
      timeout = setTimeout(() => {
        finish({ ok: false, key: null, timeout: true });
      }, 20000);
    });

    // The redeem page redirects to /notice?key=wyzie-... after captcha success
    const checkUrl = (url) => {
      try {
        const u = new URL(url);
        if (u.hostname === "sub.wyzie.io" && u.pathname === "/notice") {
          const key = u.searchParams.get("key");
          if (key && key.startsWith("wyzie-") && key.length > 10) {
            finish({ ok: true, key });
            return true;
          }
        }
      } catch {}
      return false;
    };

    win.webContents.on("will-navigate", (_, url) => checkUrl(url));
    win.webContents.on("did-navigate", (_, url) => checkUrl(url));
    win.webContents.on("did-navigate-in-page", (_, url) => checkUrl(url));

    win.loadURL("https://sub.wyzie.io/redeem");
  });
});

// -- Wyzie API Key Validation --------------------------------------------------
ipcMain.handle("wyzie-validate-key", async (_, key) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    // Key goes as query-param, not Authorization header
    const res = await fetch(
      `https://sub.wyzie.io/search?id=550&format=srt&key=${encodeURIComponent(key)}`,
      { signal: controller.signal },
    ).finally(() => clearTimeout(timer));
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "Invalid or expired key" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// -- Desktop notifications -----------------------------------------------------
// Called from the renderer whenever it wants a native OS notification.
ipcMain.handle(
  "show-notification",
  (_event, { title, body, silent = false }) => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: String(title),
        body: String(body),
        silent,
      });
      n.show();
    } catch {}
  },
);

// -- Picture-in-Picture / Pop-Out window --------------------------------------
// Opens the player URL in a small always-on-top BrowserWindow (full site UI,
// with subtitles and controls). The Main Window closes the stream to avoid duplication.
let pipWindow = null;
const getPipWindow = () => pipWindow;
let pipUaCustom = false;

ipcMain.handle("open-pip-window", (_, { url, title, userAgent }) => {
  if (!url || url === "about:blank") return { ok: false, reason: "no-url" };

  ensurePlayerSessions();

  if (pipWindow && !pipWindow.isDestroyed()) {
    // Drop a previously applied custom UA when the new source uses the default
    if (pipUaCustom && !pipLoadOpts.userAgent) {
      pipWindow.webContents.setUserAgent(app.userAgentFallback);
    }
    pipUaCustom = !!pipLoadOpts.userAgent;
    pipWindow.loadURL(url, pipLoadOpts);
    pipWindow.focus();
    return { ok: true };
  }

  // Per-source UA (null = Electron default). loadURL's userAgent sticks to the
  // WebContents, so always pass the explicit value when reusing the window.
  const pipLoadOpts = {};
  if (typeof userAgent === "string" && userAgent) {
    pipLoadOpts.userAgent = userAgent;
  }

  pipWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 320,
    minHeight: 180,
    alwaysOnTop: true,
    title: title ? `${title} - Pop-out` : "Pop-out Player",
    backgroundColor: "#000000",
    // Same custom title bar as the main window
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      partition: "persist:player",
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "popout-preload.js"),
    },
  });

  // Block all popup windows from the streaming site and any nested frames
  installPopupHandler(pipWindow.webContents);
  siteTweaks.attach(pipWindow.webContents);

  // If the site uses <webview> elements (unlikely but safe), block there too
  pipWindow.webContents.on("did-attach-webview", (_, wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  pipUaCustom = !!pipLoadOpts.userAgent;
  pipWindow.loadURL(url, pipLoadOpts);

  // Push maximize state into the popout renderer so the title bar icon updates
  pipWindow.on("maximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", true);
  });
  pipWindow.on("unmaximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", false);
  });

  const notifyMain = (channel) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) mw.webContents.send(channel);
  };

  pipWindow.on("closed", () => {
    pipWindow = null;
    notifyMain("pip-window-closed");
  });

  notifyMain("pip-window-opened");
  return { ok: true };
});

ipcMain.handle("close-pip-window", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});

ipcMain.handle("get-pip-webcontents-id", () => {
  if (pipWindow && !pipWindow.isDestroyed()) return pipWindow.webContents.id;
  return null;
});

// -- Popout window controls (used by popout-preload.js title bar buttons) -----
ipcMain.handle("popout-window-minimize", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.minimize();
});
ipcMain.handle("popout-window-toggle-maximize", () => {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  if (pipWindow.isMaximized()) pipWindow.unmaximize();
  else pipWindow.maximize();
});
ipcMain.handle("popout-window-close", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});
ipcMain.handle("popout-window-is-maximized", () => {
  return pipWindow && !pipWindow.isDestroyed()
    ? pipWindow.isMaximized()
    : false;
});

// -- Single-instance lock ------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    localMediaIpc.ensureProtocolHandler();
    _bench("app ready");
    createWindow();

    const ytDlpUpdate = await ytDlpUpdater.runStartupUpdate();
    if (ytDlpUpdate.updated) {
      console.log(
        `[yt-dlp] Updated to ${ytDlpUpdate.currentVersion} before starting the YouTube backend`,
      );
    } else if (ytDlpUpdate.error) {
      console.warn(`[yt-dlp] Startup update skipped: ${ytDlpUpdate.error}`);
    }

    const tools = toolPaths.publishBundledEnv();
    _bench(
      `tools bundled=${tools.bundledBinDir ? "yes" : "no"} ffmpeg=${tools.ffmpeg ? "ok" : "missing"} yt-dlp=${tools.ytDlp ? "ok" : "missing"}`,
    );
    if (ytBridge.shouldStartOnLaunch()) {
      ytBridge.start().then((bridge) => {
        _bench(
          `yt-bridge=${bridge.running ? "ok" : "off"}${bridge.managed ? " (managed)" : bridge.running ? " (external)" : ""}`,
        );
      });
    } else {
      _bench("yt-bridge=skipped (start on launch disabled)");
    }
  });
  app.on("before-quit", () => {
    ytBridge.stop();
  });
  app.on("window-all-closed", () => {
    streamResolver.destroyResolverWindow();
    app.quit();
  });
  app.on("activate", () => {
    if (mainWindow === null) createWindow();
  });
}
