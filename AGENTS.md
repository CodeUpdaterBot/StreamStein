# StreamStein app managed project runbook

## Identity

- Project name: StreamStein desktop app
- GitHub repo: `CodeUpdaterBot/StreamStein`
- Visibility: public
- Managed path: `C:/Users/PC/Documents/Coding Projects/StreamStein`
- Website repo: `CodeUpdaterBot/StreamStein_WEBSITE`

## Scope

This is the actual cross-platform Electron/Vite desktop app source. The marketing website is managed separately.

## Setup and verification

```bash
npm ci
npm run test:media-playback
node node_modules/vite/bin/vite.js build
```

Installer/package builds use `npm run dist:*` and can be long-running or platform-specific. Do not claim installer readiness unless that exact target was built and verified.

## Workflow

Use repo-local identity `Steven <runcomps@gmail.com>`. Keep generated binaries, downloads, catalogs, packaged installers, local cookies, and `resources/bin` outputs out of git unless a release task explicitly requires them.
