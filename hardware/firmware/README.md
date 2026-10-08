# VX Telemetry — firmware integration guide

This is the contract your avionics stack emits against. Follow it and your board
connects to the VX Telemetry app with no code changes on the app side. The two
reference emitters here ([Arduino/C++](vx_frame_arduino.ino),
[CircuitPython/MicroPython](vx_frame.py)) already produce valid frames; start
from one of them.

## The one rule

Emit **one JSON object per line**, newline (`\n`) terminated, UTF-8 or ASCII:

```json
{"v":1,"t_ms":123456,"alt_m":102.4,"vel_mps":58.1,"batt_v":7.9,"lat":28.6,"lon":-80.6,"az":9.8,"event":"LIFTOFF"}
```

`t_ms` is the only required field. Everything else is optional and additive: send
what you have, add more later, nothing breaks. A trailing `\r` is fine (the app
trims it), so `println` on most boards works as-is.

## Transport

- The flight computer sends its NDJSON over the radio. The **Board B receiver**
  is a transparent radio-to-USB bridge: it writes each received line to USB CDC
  serial **verbatim**, so the app sees exactly what your flight computer emitted.
- In the app pick **Serial**, choose the receiver's port, and set the **baud** to
  match the receiver's USB CDC rate (default in the app is 115200).
- For a bench test with no radio, plug the flight computer straight into USB and
  connect to that port. Same frames, same result.

## Field reference (V1 contract)

All optional except `t_ms`. Units are SI. Unknown field names are ignored by the
app (and listed in Field Map), so a typo fails quietly rather than loudly: use
the Frame Tester to catch it.

| Field | Unit | Notes |
|---|---|---|
| `t_ms` | ms | **Required.** Milliseconds since power-on, monotonic. |
| `alt_m` | m | Altitude, usually baro AGL. `alt_ft` also accepted (non-v1 frames). |
| `vel_mps` | m/s | Vertical velocity. The app also fuses one from baro if omitted. |
| `batt_v` | V | Battery voltage. |
| `current_a` | A | Battery current. |
| `rssi_dbm` | dBm | Link RSSI. Usually added by the receiver, not the flight computer. |
| `snr_db` | dB | Link SNR. |
| `ax` `ay` `az` | m/s^2 or g | Accel. Be consistent: at pad rest `az` is ~9.81 (m/s^2) or ~1.0 (g). The app auto-detects the unit from the first sample. |
| `gx` `gy` `gz` | deg/s | Gyro rates. |
| `lat` `lon` | deg | Decimal degrees. |
| `gps_fix` | int | 0 = no fix, else fix type. |
| `gps_sats` | int | Satellites used. |
| `gps_alt_m` | m | GPS altitude (MSL). |
| `q_w` `q_x` `q_y` `q_z` | unit quat | Orientation. Drives the 3D vehicle and attitude. |
| `temp_c` | deg C | `pressure_pa` in Pa, `humidity_pct` in %. |
| `event` | string | Flight event, e.g. `LIFTOFF`, `BURNOUT`, `APOGEE`, `DROGUE`, `MAIN`, `LANDING`. Drives the mission clock and phase track. |
| `pyro_main_cont` | 0/1 | Main pyro continuity. `pyro_drogue_cont` likewise. |
| `seq` | int | Incrementing packet counter. Enables true packet-loss stats. |
| `vid` | string/int | Vehicle id. Send it to track more than one vehicle at once. |

Advanced (optional): `tvc_pitch_deg` / `tvc_yaw_deg`, `canard_1_deg`..`canard_4_deg`
+ `roll_rate_dps`, and `airbrake_pct` + `airbrake_target_apogee_m` /
`airbrake_pred_apogee_m`. See the app README for the full list.

## Two things that trip people up

1. **If you set `v:1`, use exact V1 key names.** A frame with `v:1` and a valid
   `t_ms` is trusted as-is, so alias mapping is skipped. `{"v":1,...,"altitude_ft":1000}`
   will **not** populate altitude, because the trusted path only reads `alt_m`.
   Either send exact V1 keys with `v:1`, or drop `v` to let aliases and unit
   conversions apply. The Frame Tester warns you when this happens.

2. **Send `t_ms` from your own clock.** If you omit it the app stamps arrival
   time so the line still plots, but your timing is then the link's timing, not
   the flight's. One `millis()` call fixes it.

## Optional: checksum for corruption detection

Append an NMEA-style suffix so the app can detect and drop corrupt lines and
count them in Link Quality:

```
{"v":1,"t_ms":123,"alt_m":5}*1A2B
```

The four uppercase hex digits are **CRC-16/CCITT-FALSE** (poly `0x1021`, init
`0xFFFF`, no reflection, no final XOR) over the UTF-8 bytes of the JSON text
**before** the `*`. Check value for the ASCII string `123456789` is `0x29B1`.
Both reference emitters implement it; copy that function verbatim so the app and
your firmware agree byte for byte.

## Bring-up checklist

Do these in order the first time you connect a new board:

1. **Bytes flowing.** Connect, open the **Raw Console** widget. You should see
   your lines scrolling. Nothing there means a wiring, port, or baud problem,
   not a format problem.
2. **Frames parsing.** Copy one line from the console into the **Frame Tester**
   (the **Test Line** button, Serial toolbar). Aim for the green **WILL INGEST**
   verdict. It shows every field it recognized, anything it did not, and any
   value it blanked as out of range. You can validate your format here before
   the board is even finished, by pasting a line you expect to send.
3. **Widgets lighting up.** Add the widgets you care about. Any that stay greyed
   out are telling you which field they need (for example the 3D vehicle wants
   `q_w..q_z`).

Rates of 10 to 40 Hz are typical and well within what the app handles. Keep each
line to a few hundred bytes; the app drops a single line that runs past 64 KB
with no newline, which is the signature of a missing `\n` terminator.
