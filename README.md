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

**Thrust vector control** (optional): send `tvc_pitch_deg` / `tvc_yaw_deg` for
the commanded gimbal angles, plus `tvc_pitch_fb_deg` / `tvc_yaw_fb_deg` for
servo feedback and `tvc_enabled` (0/1). The **TVC Test** widget plots deflection
against the mechanical limit and computes RMS tracking error — the number you
tune a gimbal loop against. Aliases: `gimbal_pitch`, `servo_yaw`, and friends.

**Canard fins** (optional): send `canard_1_deg`..`canard_4_deg` for per-fin
deflection and `roll_rate_dps` for the roll rate the fins are damping (plus
optional `canard_enabled`). The **Canard Fins** widget shows the fins working
from a nose-on view and flags when roll authority is lost. Aliases: `fin1`..
`fin4`, `roll_rate`.

**Air brakes** (optional): send `airbrake_pct` (0–100 deployment), optionally
`airbrake_fb_pct` (actuator feedback), and `airbrake_target_apogee_m` /
`airbrake_pred_apogee_m` for the apogee tracker. The **Air Brakes** widget shows
deployment and whether the predicted apogee is converging on the target — the
core loop for altitude-targeting competitions. Aliases: `speedbrake_pct`,
`target_apogee_m`, `pred_apogee_m` (`*_ft` variants convert).

Every widget has an **info (i) button** with wiring and troubleshooting help,
and a Learn-more link you point at your own tutorials site (Settings → Tools).

## Ingest formats & sharing

VX isn't limited to its own NDJSON. Pick a **data format** (Serial toolbar):
NDJSON, **CSV** (a header row is auto-mapped to the contract — most altimeter/
logger exports just work), or **key=value**. Anything unmapped is fixable in
**Field Map**.

**Events are gated properly.** Liftoff is accelerometer-gated, apogee is a
debounced fused-velocity zero-crossing (not fooled by a lone baro spike), and a
baro+accel Kalman filter yields a smoothed altitude and the velocity most
flight computers don't transmit.

**Share a flight.** From the Flight Log, **Share** produces a self-contained
HTML replay (interactive, works offline — send it or host it) or a compact link
that carries the flight in its own URL and opens straight into playback. No
server, nothing uploaded.

**Real motor curves.** In **Sim Setup**, import a RASP `.eng` or RockSim `.rse`
motor file (from thrustcurve.org) and the simulator flies the actual thrust
curve — real spike, max-Q, and burnout velocity — not a flat average. A `.ork`
importer pulls diameter/mass/motor from an OpenRocket design as a starting
point.

**Templates.** First launch opens a template picker (HPR dual-deploy, TVC test
stand, canard, airbrake, competition) so you start on a populated dashboard.
Reachable anytime from Settings → Display.

Optional wire integrity: append an NMEA-style checksum — `{...}*1A2B` where
the hex digits are **CRC-16/CCITT-FALSE** over the UTF-8 JSON text before the
`*`. Corrupt lines are dropped and counted (Link Quality widget). Optional
`seq` packet counters give true loss statistics.

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
