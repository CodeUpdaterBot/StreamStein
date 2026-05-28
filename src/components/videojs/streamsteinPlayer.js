/**
 * Streamstein Video.js v10 player instance (React framework).
 *
 * Follows @videojs/react installation:
 * https://videojs.org/docs/framework/html/how-to/installation
 * (use framework=react → npm install @videojs/react)
 *
 * Do not use @videojs/html custom elements here; this app is React + Vite.
 * Local files play via loopback HTTP in the player webview (see src/ipc/localMedia.js).
 */
import "@videojs/react/video/skin.css";
import { createPlayer, videoFeatures } from "@videojs/react";

/** Single createPlayer() instance — Provider, VideoSkin, and usePlayer share this store. */
export const StreamsteinPlayer = createPlayer({ features: videoFeatures });
