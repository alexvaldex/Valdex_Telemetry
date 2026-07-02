// src/telemetry/schema.ts
import type { TelemetryFrameV1 } from "./types";

/**
 * Valdex Telemetry V1 schema normalizer.
 * Accepts "loose" incoming JSON frames (different key names), outputs strict TelemetryFrameV1.
 *
 * Strategy:
 * - Prefer already-V1 frames (v=1, t_ms present)
 * - Otherwise, map common aliases into V1 fields
 * - Always require a valid t_ms; if missing, caller can supply wallclock
 */

type AnyObj = Record<string, any>;

function num(x: any): number | undefined {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : undefined;
}

function int(x: any): number | undefined {
  const n = num(x);
  return Number.isFinite(n) ? Math.trunc(n!) : undefined;
}

function pick<T>(obj: AnyObj, keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

export function normalizeTelemetryFrame(raw: AnyObj, fallbackTms?: number): TelemetryFrameV1 | null {
  if (!raw || typeof raw !== "object") return null;

  // If it's already V1, accept (with light validation)
  if (raw.v === 1 && typeof raw.t_ms === "number") {
    return raw as TelemetryFrameV1;
  }

  // Map aliases
  const t_ms =
    num(pick(raw, ["t_ms", "t", "time_ms", "timestamp_ms"])) ??
    (fallbackTms ?? undefined);

  if (!Number.isFinite(t_ms)) return null;

  // Altitude
  const alt_m =
    num(pick(raw, ["alt_m", "alt", "altitude_m", "altitude"])) ??
    (num(pick(raw, ["alt_ft", "altitude_ft"])) !== undefined
      ? (num(pick(raw, ["alt_ft", "altitude_ft"]))! * 0.3048)
      : undefined);

  // Velocity (vertical)
  const vel_mps =
    num(pick(raw, ["vel_mps", "vz_mps", "velocity_mps", "v_mps"])) ??
    (num(pick(raw, ["vel_fps", "vz_fps"])) !== undefined
      ? (num(pick(raw, ["vel_fps", "vz_fps"]))! * 0.3048)
      : undefined);

  // Battery + RSSI
  const batt_v = num(pick(raw, ["batt_v", "battery_v", "vbatt", "vbat"]));
  const current_a =
    num(pick(raw, ["current_a", "current", "amps", "i_batt", "batt_a"])) ??
    (num(pick(raw, ["current_ma", "i_ma"])) !== undefined ? num(pick(raw, ["current_ma", "i_ma"]))! / 1000 : undefined);
  const rssi_dbm = num(pick(raw, ["rssi_dbm", "rssi", "rssiDbm"]));
  const snr_db = num(pick(raw, ["snr_db", "snr", "snrDb"]));

  // IMU accel/gyro
  const ax = num(pick(raw, ["ax", "acc_x", "accel_x"]));
  const ay = num(pick(raw, ["ay", "acc_y", "accel_y"]));
  const az = num(pick(raw, ["az", "acc_z", "accel_z"]));

  const gx = num(pick(raw, ["gx", "gyro_x"]));
  const gy = num(pick(raw, ["gy", "gyro_y"]));
  const gz = num(pick(raw, ["gz", "gyro_z"]));

  // GPS
  const lat = num(pick(raw, ["lat", "latitude"]));
  const lon = num(pick(raw, ["lon", "lng", "longitude"]));
  const gps_fix = int(pick(raw, ["gps_fix", "fix", "gpsFix"]));
  const gps_sats = int(pick(raw, ["gps_sats", "sats", "satellites"]));
  const gps_alt_m =
    num(pick(raw, ["gps_alt_m", "gps_alt", "alt_gps", "gpsAlt"])) ??
    (num(pick(raw, ["gps_alt_ft"])) !== undefined ? num(pick(raw, ["gps_alt_ft"]))! * 0.3048 : undefined);

  // Quaternion
  const q_w = num(pick(raw, ["q_w", "qw", "quat_w", "w"]));
  const q_x = num(pick(raw, ["q_x", "qx", "quat_x", "x"]));
  const q_y = num(pick(raw, ["q_y", "qy", "quat_y", "y"]));
  const q_z = num(pick(raw, ["q_z", "qz", "quat_z", "z"]));

  // Vehicle / stream id
  const vidRaw = pick<unknown>(raw, ["vid", "node", "addr", "src_id"]);
  const vid = typeof vidRaw === "string" || typeof vidRaw === "number" ? vidRaw : undefined;

  // Environment: temperature (°C), pressure (Pa), humidity (%)
  const temp_c =
    num(pick(raw, ["temp_c", "temp", "temperature", "temperature_c", "tempC"])) ??
    (num(pick(raw, ["temp_f", "temperature_f", "tempF"])) !== undefined
      ? ((num(pick(raw, ["temp_f", "temperature_f", "tempF"]))! - 32) * 5) / 9
      : undefined);

  const pressure_pa =
    num(pick(raw, ["pressure_pa", "press_pa", "baro_pa", "pressure"])) ??
    (num(pick(raw, ["pressure_hpa", "press_hpa", "hpa", "mbar", "pressure_mbar"])) !== undefined
      ? num(pick(raw, ["pressure_hpa", "press_hpa", "hpa", "mbar", "pressure_mbar"]))! * 100
      : undefined);

  const humidity_pct = num(pick(raw, ["humidity_pct", "humidity", "rh", "hum"]));

  // Events / continuity
  const event = typeof raw.event === "string" ? raw.event : (typeof raw.ev === "string" ? raw.ev : undefined);
  const pyro_main_cont = raw.pyro_main_cont === 0 || raw.pyro_main_cont === 1 ? raw.pyro_main_cont : undefined;
  const pyro_drogue_cont = raw.pyro_drogue_cont === 0 || raw.pyro_drogue_cont === 1 ? raw.pyro_drogue_cont : undefined;

  const out: TelemetryFrameV1 = {
    v: 1,
    t_ms: t_ms!,
    vid,
    alt_m,
    vel_mps,
    batt_v,
    current_a,
    rssi_dbm,
    snr_db,
    ax, ay, az,
    gx, gy, gz,
    lat, lon,
    gps_fix,
    gps_sats,
    gps_alt_m,
    q_w, q_x, q_y, q_z,
    temp_c,
    pressure_pa,
    humidity_pct,
    event,
    pyro_main_cont,
    pyro_drogue_cont,
  };

  return out;
}