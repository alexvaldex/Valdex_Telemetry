import type { TelemetryFrameV1 } from "./types";

export function isTelemetryFrameV1(x: any): x is TelemetryFrameV1 {
  if (!x || x.v !== 1 || typeof x.t_ms !== "number") return false;

  if (x.vid !== undefined && typeof x.vid !== "string" && typeof x.vid !== "number") return false;

  if (x.lat !== undefined && typeof x.lat !== "number") return false;
  if (x.lon !== undefined && typeof x.lon !== "number") return false;

  if (x.alt_m !== undefined && typeof x.alt_m !== "number") return false;
  if (x.vel_mps !== undefined && typeof x.vel_mps !== "number") return false;

  if (x.temp_c !== undefined && typeof x.temp_c !== "number") return false;
  if (x.pressure_pa !== undefined && typeof x.pressure_pa !== "number") return false;
  if (x.humidity_pct !== undefined && typeof x.humidity_pct !== "number") return false;

  if (x.gps_fix !== undefined && typeof x.gps_fix !== "number") return false;
  if (x.gps_sats !== undefined && typeof x.gps_sats !== "number") return false;

  return true;
}