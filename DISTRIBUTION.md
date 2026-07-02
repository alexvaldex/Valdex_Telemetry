# VX Telemetry — Distribution Plan

Goal: ship VX Telemetry the way OpenRocket ships — a website with a big Download
button, installers for macOS / Windows / Linux, plus a browser demo. The
architecture was built for this from day one: the UI never touches hardware
directly, everything goes through the `Connection` interface in
`src/transport/`, so swapping the browser's Web Serial for a native serial
backend touches **one layer only**.

## Path: Tauri desktop app (recommended)

Tauri wraps the existing Vite build in a tiny native shell (2–8 MB installers,
vs ~100 MB for Electron) and gives real native serial access.

When you're ready, the steps are:

1. **Install the Rust toolchain** (one-time): `curl https://sh.rustup.rs -sSf | sh`
2. **Add Tauri to the project:**
   ```sh
   npm install -D @tauri-apps/cli
   npx tauri init            # point devUrl at http://localhost:5173, build dir at dist/
   npm install @tauri-apps/plugin-serialplugin   # native serial
   ```
3. **Implement `TauriSerialConnection`** in `src/transport/tauriSerial.ts`
   implementing the same `Connection` interface (`connect / disconnect /
   onLine / onStatusChange / write`). Detect the shell at runtime:
   ```ts
   const isTauri = "__TAURI__" in window;
   // transport picker offers: Simulator | Web Serial (browser) | Serial (native)
   ```
   Nothing above the transport layer changes.
4. **Build installers:** `npx tauri build` → `.dmg` (macOS), `.msi`/`.exe`
   (Windows), `.AppImage`/`.deb` (Linux). Cross-platform builds run in CI
   (GitHub Actions has ready-made Tauri workflows — build all three OSes on tag
   push and attach artifacts to a GitHub Release).

## Website + downloads

- The **web version is already shippable**: `npm run build` produces a static
  `dist/` you can host anywhere (Netlify/Vercel/GitHub Pages/S3). Web Serial
  works in Chrome/Edge over HTTPS, and the Simulator works everywhere — that's
  your live demo, exactly like OpenRocket's "try it" story but better.
- Download page pattern: detect OS → show the matching installer button, with
  the other platforms below. Link the GitHub Releases assets directly.

## Signing & updates (before public launch)

- **macOS:** Apple Developer ID ($99/yr), sign + notarize in CI or Gatekeeper
  will block the app. Tauri handles both via config.
- **Windows:** code-signing cert (or accept the SmartScreen warning early on).
- **Auto-update:** Tauri's built-in updater checks a static JSON manifest —
  host it next to the downloads; releases become "bump version, tag, CI does
  the rest."

## Checklist before first public build

- [ ] App icon set (icon.icns / icon.ico / PNGs) — reuse `public/vx-logo.svg` art
- [ ] `tauri.conf.json` identifier: `com.valdex.vxtelemetry`
- [ ] TauriSerialConnection + transport picker entry
- [ ] CI workflow: tag → build 3 platforms → GitHub Release
- [ ] Landing page with OS-detecting download button + web demo link
- [ ] Privacy note: all data stays local (IndexedDB/localStorage), no telemetry-about-telemetry
