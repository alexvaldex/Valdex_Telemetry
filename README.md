# VX Telemetry

**Universal ground station for rocketry telemetry.** Plug in a flight computer,
altimeter, GPS, or radio — VX recognizes the stream and your data appears live
on a mission-control dashboard. No parsing code required.

Built for hobbyist high-power rocketeers and competition teams (IREC, FAR,
NASA Student Launch), up to HPR L3 flight standards.

## Features

- **Live mission-control dashboard** — mission clock (T±), flight-phase track
  (PAD → BOOST → COAST → APOGEE → DROGUE → MAIN → LANDED), GO/NO-GO board,
  peak readouts, drag-aware apogee prediction during ascent, touchdown ETA
  during descent.
- **Widgets** — altitude / velocity (with Mach) / battery, artificial-horizon
  attitude, IMU, environment (temp/baro/humidity), offline GPS range map with
  recovery bearing + distance, pyro continuity panel, flight summary,
  pre-flight checklist, raw console with TX command line.
- **3D vehicle** — upload your own rocket CAD (`.glb`/`.stl`/`.obj`); it flies
  live from telemetry attitude and animates stage separation, drogue/main
  deploy, and boost through the actual flight events. Single or two-stage.
- **Safety systems** — master-caution alarm (audio + flashing banner + ACK),
  custom alert rules on any field, voice callouts for flight events.
- **Data** — session auto-archive (IndexedDB flight log) with replay/scrub,
  JSONL/CSV/KML/GPX export, print-ready mission report (PDF via browser print),
  flight-event markers on every plot.
- **Hardware-agnostic** — NDJSON frame contract with alias mapping plus an
  in-app Field Map UI, so third-party firmware works without code changes.
- **Simulator** — a full scripted flight (with GPS drift, attitude, pyro
  events) built in, so the entire app works with nothing plugged in.

## Quick start

```sh
npm install
npm run dev      # open http://localhost:5173 in Chrome or Edge
```

Pick **Simulator** → **Connect** and watch a full flight. For real hardware,
pick **Serial**, choose your baud rate, and hit Connect (Web Serial requires
Chrome/Edge). `npm run build` produces a static `dist/` you can host anywhere.

## Telemetry contract

One JSON object per line (NDJSON), `t_ms` required, everything else optional:

```json
{"v":1,"t_ms":123456,"alt_m":102.4,"vel_mps":58.1,"batt_v":7.9,"lat":28.6,"lon":-80.6,"ax":0.1,"ay":0.0,"az":9.8,"q_w":1,"q_x":0,"q_y":0,"q_z":0,"temp_c":21.2,"pressure_pa":98120,"event":"LIFTOFF","pyro_main_cont":1,"pyro_drogue_cont":1}
```

Common aliases (`alt`, `altitude_ft`, `vz_fps`, `temp_f`, `pressure_hpa`, …)
map automatically; anything else can be mapped in-app via **Field Map**.

## Architecture

Strictly layered, one direction only — the UI never touches hardware:

```
Transport (serial/sim) → Ingest (parse, normalize, validate) → Store (ring buffer) → UI (widgets subscribe @ ~16 Hz)
```

`Transport` is an interface (`src/transport/types.ts`) with `WebSerialConnection`
and `SimulatorConnection` today; a native `TauriSerialConnection` drops in later
with zero changes above the transport layer. See [DISTRIBUTION.md](DISTRIBUTION.md)
for the desktop-app packaging plan.

## License

ISC © Valdex
