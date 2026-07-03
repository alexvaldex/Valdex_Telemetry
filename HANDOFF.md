# VX Telemetry — Handoff for Testing & Final Development

Paste this whole file into the new Claude Code chat as the first message. It's
the minimum context needed to continue effectively — everything else is
discoverable by reading the code.

## What this is

**VX Telemetry** — a universal ground station + flight simulator for high-power
rocketry (up to L3). Open-core: free software, revenue comes from a companion
"VX" flight computer board (hardware not built yet, only planned/BOM'd).

Built for **Valdex LLC**, explicitly a **separate product from Salus V1/VxS**
(a different drone-safety project in a sibling directory) — don't touch that
one, don't merge concerns.

## Location & how to run

```
/Users/alexvaldez/startups/valdex-telemetry
```

This directory is **outside** the primary VxS V1 project root, so if this
session is rooted at VxS V1, this folder shows up as an "additional working
directory" — same as the prior session. **The Claude Code preview tool cannot
reach this directory** (it's hard-scoped to the primary project root). Do not
waste time trying `preview_start` here — verify via `npm test`, `npx tsc
--noEmit`, `npm run build`, and manual Node scripts instead (see Verification
below).

```sh
npm install
npm run dev              # web version → http://localhost:5180 (see gotcha below)
npm test                 # vitest, 31 tests, should all pass
npx tsc --noEmit          # should be silent (0 errors)
npm run build             # production web build
```

Desktop app (Tauri) is already built:
```
src-tauri/target/release/bundle/macos/VX Telemetry.app
src-tauri/target/release/bundle/dist-out/VX-Telemetry_0.9.0_aarch64.dmg
```
Rust toolchain is installed via rustup but **not on default PATH** — every
Tauri command needs:
```sh
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build --bundles app     # the plain `tauri build` DMG step fails headless, see gotcha below
```

## Architecture (one direction only)

```
Transport (serial/sim) → Ingest (parse/normalize/validate) → Store (ring buffer) → UI (widgets @ ~16Hz)
```

- `src/transport/` — `Connection` interface. `SimulatorConnection` (physics-driven,
  real-time), `WebSerialConnection` (browser, Chrome/Edge only), `TauriSerialConnection`
  (native, Rust `serialport` crate backend in `src-tauri/src/lib.rs`) — **never tested
  against real hardware**, this is priority #1 for this phase.
- `src/telemetry/` — schema/validate/ingest/store/capabilities/fieldMap/alertRules/
  flightLog/flightSim/crc/vehicleStore/padOrigin/ghost. This is the tested core (vitest
  suite lives in `src/__tests__/core.test.ts`).
- `src/widgets/` — 14 widget renderers + registry (`src/widgets/registry.ts`).
- `src/App.tsx` — ~4,700 lines, the whole UI shell (header, grid, all modals). Not
  unit-tested — only manually/visually verified. This is priority #2.

Frame contract (NDJSON over the wire): `{"v":1,"t_ms":...,"alt_m":...,...}` optionally
suffixed with a CRC-16 checksum `*XXXX`. Full field list + aliases in `README.md`.

## Current state (as of commit `b5f048b`)

- 22 commits, clean tree, no remote configured yet (needs `git remote add origin`
  + push when ready for CI/public release).
- 31/31 tests passing, `tsc --noEmit` clean, web build ~442KB main + lazy 953KB
  3D chunk, desktop app 8.6MB.
- Feature-complete per the original spec + several rounds of "make it SpaceX/Blue
  Origin worthy": mission clock w/ countdown+holds, GO/NO-GO board, multi-vehicle
  streams, physics-based flight simulator (Sim Setup modal — real rocket/motor/
  weather/season → live apogee/drift/landing predictions), Google Maps recovery
  route rehearsal, radio config panel (SiK/RFD900 AT commands), flight comparison
  ghost overlays, crash-safe recording, per-widget crash isolation, native serial
  in the desktop app, CI release workflow (`.github/workflows/release.yml`,
  untested — no repo pushed yet).

## What's NOT done — real gaps for this phase

1. **Zero real hardware testing.** Every byte ever ingested has come from the
   simulator or unit tests. This is the biggest unknown — test with actual serial
   hardware (even a cheap Arduino + BMP280 emitting fake NDJSON) before trusting
   the native/WebSerial transports.
2. **Desktop app is unsigned.** Gatekeeper will warn on install. Needs an Apple
   Developer cert to fix properly (signing secrets are already stubbed as comments
   in the release workflow).
3. **No public GitHub repo.** Needed for the CI release pipeline to mean anything,
   and for anyone else to test it.
4. **No UI test coverage.** `App.tsx` (~4,700 lines) is entirely manually verified.
   Consider component tests for the highest-risk logic: event derivation
   (`derivedEvents`), vehicle filtering (`matchVid`/`display` memo), alert gating.
5. **Bundle**: three.js loaders (GLTF/STL/OBJ) all ship in one lazy chunk even
   though a flight only needs one — could split further if bundle size matters.

## Known gotchas / lessons already paid for — don't rediscover these

- **Preview tool can't reach this directory** (see above) — always verify via
  Bash/Node, never try `preview_start`.
- **`npm run dev` default port 5173 is usually occupied by an unrelated project**
  on this machine — use `npm run dev -- --port 5180 --strictPort` (or whatever's
  free) and `curl` to confirm instead of assuming.
- **`npx tauri build`'s DMG step fails headless** (`bundle_dmg.sh` needs a GUI/
  Finder). Use `npx tauri build --bundles app` then manually:
  `hdiutil create -volname "VX Telemetry" -srcfolder ".../VX Telemetry.app" -ov -format UDZO out.dmg`
- **`npx tauri icon` requires a square source image.** Pad first with
  `sips --padToHeightWidth`, don't redraw/recreate the art.
- **If a user attaches an image, ask them to drop the actual file on disk** —
  don't hand-trace/recreate it from the chat preview. (This was tried once,
  corrected once — the real file now lives at `public/vx-logo.png`, used as-is.)
- **CRC suffixes break naive `JSON.parse(line)`.** Any new code that reads raw
  NDJSON lines (playback, flight-log summarize, exports) MUST go through
  `verifyAndStrip()` from `src/telemetry/crc.ts` first. Getting this wrong once
  already broke playback/flight-log metadata for a full round — grep for
  `JSON.parse(` before adding a new raw-line consumer.
- **The frame ring buffer wraps** (`MAX_FRAMES` in `store.ts`) on long pad waits.
  Flight events (LIFTOFF etc.) are latched separately in `TelemetryState.events`
  specifically so they survive wrap — don't derive "did liftoff happen" purely
  from scanning `frames`, use the latched event log too (see `derivedEvents` in
  App.tsx for the merge pattern).
- **Widget pin state lives in its own persisted Set** (`vx.pinnedWidgets`), not
  in the react-grid-layout layout object — storing it in the layout caused a
  hard-to-repro "glitchy lock" bug because RGL's `onLayoutChange` round-trips
  and silently drops extra fields.
- **`voiceOn` / countdown state ordering matters** — the countdown clock block in
  App.tsx must be declared AFTER the `voiceOn` state (hit a real TDZ compile
  error moving it once).

## Verification recipe (no preview tool available here)

```sh
npm test && npx tsc --noEmit && npm run build
```
For anything touching the transport/ingest/simulator path, write a throwaway
esbuild-bundled Node script (pattern used throughout this project — search git
log for `esbuild` in commit messages for examples) that imports
`SimulatorConnection` + `ingestLineInPlace`, runs a real flight, and asserts on
the output. This has repeatedly caught real bugs that `tsc`/unit tests alone
missed (e.g. confirmed live sim telemetry matches the physics predictor to
0.1m/0.1m/s).

## Suggested direction for this phase

1. Real hardware test (native serial + WebSerial) — this is the thing that's
   never been proven.
2. Push to GitHub, add signing secrets when available, cut a v0.9.0 release.
3. UI test coverage for `App.tsx`'s riskiest logic.
4. First-run onboarding flow (currently opens to an empty grid — not obvious
   you should hit "Add Widget" or try the Simulator).
5. Everything else is polish — the software is feature-complete for its stated
   scope (ground station + flight simulator + recovery planning).
