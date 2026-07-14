/**
 * Device profiles — multi-format line ingest so hardware that doesn't speak
 * VX's native NDJSON still works. Sits in front of the schema normalizer: a
 * profile turns one raw wire line into a loose object, which then flows through
 * the existing field-map + normalize pipeline.
 *
 * Formats:
 *   - json    : one JSON object per line (VX native)
 *   - csv     : comma-separated; a header row is learned automatically and its
 *               column names are fuzzy-mapped to V1 keys (see autoMapHeader)
 *   - keyval  : "k=v" / "k:v" tokens separated by spaces or commas
 *   - auto    : sniff each line (json → csv → keyval)
 *
 * The fuzzy header mapper is the workhorse: most altimeter/logger CSV exports
 * (Eggtimer, Featherweight, generic dataloggers) have headers like
 * "Altitude (ft)" or "Vel_mps" that it recognizes without any per-device code.
 * Anything it misses is still correctable in the Field Map UI.
 */

import { getFieldMap } from "./fieldMap";

export type LineFormat = "json" | "csv" | "keyval" | "auto";

export type DeviceProfile = {
  id: string;
  name: string;
  format: LineFormat;
  note: string;
};

export const DEVICE_PROFILES: DeviceProfile[] = [
  { id: "vx", name: "VX / auto-detect", format: "auto", note: "NDJSON native; also sniffs CSV and key=value automatically." },
  { id: "csv", name: "Generic CSV", format: "csv", note: "Comma-separated with a header row. Column names are auto-mapped; refine in Field Map." },
  { id: "keyval", name: "Key = Value", format: "keyval", note: "Tokens like alt=123 vel=45, space or comma separated." },
  { id: "eggtimer", name: "Eggtimer (CSV export)", format: "csv", note: "Eggtimer flight-data CSV. Header is read from the file; check the Field Map if a column doesn't line up." },
  { id: "featherweight", name: "Featherweight (CSV export)", format: "csv", note: "Featherweight Blue Raven / GPS CSV export. Header-mapped; verify in Field Map." },
  { id: "altus", name: "Altus Metrum (key=value)", format: "keyval", note: "AltOS-style key/value telemetry. Verify mappings in Field Map." },
];

const KEY = "vx.deviceProfile";
let activeId = "vx";
let csvHeader: string[] | null = null;

export function loadDeviceProfile(): string {
  try {
    activeId = localStorage.getItem(KEY) || "vx";
  } catch {
    activeId = "vx";
  }
  return activeId;
}

export function getDeviceProfileId(): string {
  return activeId;
}

export function setDeviceProfile(id: string) {
  activeId = DEVICE_PROFILES.some((p) => p.id === id) ? id : "vx";
  csvHeader = null; // a new device means a new header
  try { localStorage.setItem(KEY, activeId); } catch { /* ignore */ }
}

function activeFormat(): LineFormat {
  return DEVICE_PROFILES.find((p) => p.id === activeId)?.format ?? "auto";
}

/* ---------------- Parsers ---------------- */

function parseJson(payload: string): Record<string, unknown> | null {
  const t = payload.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isNumeric(s: string): boolean {
  return s !== "" && Number.isFinite(Number(s));
}

function coerce(s: string): unknown {
  const t = s.trim();
  if (t === "") return undefined;
  return isNumeric(t) ? Number(t) : t;
}

function parseCsv(payload: string): Record<string, unknown> | null {
  const line = payload.trim();
  if (!line.includes(",")) return null;
  const tokens = line.split(",").map((t) => t.trim());
  if (tokens.length < 2) return null;

  const numeric = tokens.filter(isNumeric).length;
  if (numeric === 0) {
    // All-text row → treat as a header and learn the columns.
    csvHeader = tokens;
    return null;
  }
  if (!csvHeader) return null; // data before any header — can't map yet

  // Emit RAW header keys. The fuzzy header → V1 mapping happens later
  // (applyAutoHeaderMap in ingest) so the user's own Field Map overrides win
  // and the raw column names stay visible for verification.
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < csvHeader.length && i < tokens.length; i++) {
    const v = coerce(tokens[i]);
    if (v !== undefined) obj[csvHeader[i]] = v;
  }
  return Object.keys(obj).length ? obj : null;
}

/** The most recently learned CSV header row (for the mapping preview UI). */
export function getLastCsvHeader(): string[] | null {
  return csvHeader;
}

/**
 * Fill in V1 fields from recognizable raw header names — the gap-filling step
 * after the user's Field Map has had first pick. Only adds a mapped key when
 * its target isn't already present, so user overrides and real V1 keys win.
 */
export function applyAutoHeaderMap(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  // Columns the user has explicitly mapped are off-limits — their choice wins.
  const userMapped = new Set(getFieldMap().map((m) => m.source));
  for (const key of Object.keys(obj)) {
    if (userMapped.has(key)) continue;
    const target = matchHeader(key);
    if (target && obj[target] === undefined && obj[key] !== undefined) {
      obj[target] = obj[key];
    }
  }
  return obj;
}

function parseKeyVal(payload: string): Record<string, unknown> | null {
  const obj: Record<string, unknown> = {};
  let found = false;
  for (const tok of payload.split(/[\s,]+/)) {
    const m = tok.match(/^([A-Za-z_][\w.]*)[=:](.+)$/);
    if (m) {
      obj[m[1]] = coerce(m[2]);
      found = true;
    }
  }
  return found ? obj : null;
}

/** Parse one raw (CRC-stripped) line into a loose object per the active profile. */
export function parseLine(payload: string): Record<string, unknown> | null {
  const fmt = activeFormat();
  if (fmt === "json") return parseJson(payload);
  if (fmt === "csv") return parseCsv(payload);
  if (fmt === "keyval") return parseKeyVal(payload);
  // auto: try each in turn.
  return parseJson(payload) ?? parseCsv(payload) ?? parseKeyVal(payload);
}

/* ---------------- Fuzzy header → V1 mapper ---------------- */

/**
 * Best-effort map from arbitrary CSV header names to V1 alias keys the schema
 * normalizer understands. Heuristic, not exhaustive — anything it misses shows
 * up in Field Map for manual mapping.
 */
export function autoMapHeader(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const key = matchHeader(h);
    if (key) out[h] = key;
  }
  return out;
}

function matchHeader(header: string): string | null {
  const raw = header.toLowerCase();
  const h = raw.replace(/[^a-z0-9]/g, ""); // strip units/punct: "altitude(ft)" → "altitudeft"
  const hasFt = /ft|feet/.test(raw);

  // Time — only map when it's clearly milliseconds (seconds can't be converted
  // by a rename alone; those fall back to arrival-time ordering).
  if (/(t_?ms|timems|millis|timestampms)/.test(h)) return "t_ms";

  // Altitude
  if (h.includes("gpsalt") || (h.includes("gps") && h.includes("alt"))) return hasFt ? "gps_alt_ft" : "gps_alt_m";
  if (h.includes("baroalt") || h.includes("alt") || h.includes("agl") || h.includes("height")) return hasFt ? "alt_ft" : "alt_m";

  // Velocity / speed
  if (h.includes("vel") || h.includes("speed")) return /fps|ftps|ft_s/.test(raw) ? "vz_fps" : "vel_mps";

  // Battery / current  (Altus: battery_voltage; Featherweight: Batt V)
  if (h.includes("batt") || h.includes("vbat") || h === "vbat" || h.includes("voltage")) return "batt_v";
  if (h.includes("current") || h.includes("amps") || h.includes("ibatt")) return "current_a";

  // Radio
  if (h.includes("rssi")) return "rssi_dbm";
  if (h.includes("snr")) return "snr_db";

  // IMU — per-axis first, then a bare vertical "acceleration" (Altus/Featherweight).
  if (h === "ax" || h.includes("accelx") || h.includes("accx")) return "ax";
  if (h === "ay" || h.includes("accely") || h.includes("accy")) return "ay";
  if (h === "az" || h.includes("accelz") || h.includes("accz") || h.includes("vertaccel") || h.includes("axialaccel")) return "az";
  if (h === "accel" || h === "acceleration") return "az"; // single vertical-accel column
  if (h === "gx" || h.includes("gyrox")) return "gx";
  if (h === "gy" || h.includes("gyroy") || h.includes("rollrate")) return "gy";
  if (h === "gz" || h.includes("gyroz")) return "gz";

  // GPS
  if (h.includes("lat")) return "lat";
  if (h.includes("lon") || h.includes("lng")) return "lon";
  if (h.includes("sat")) return "gps_sats";
  if (h.includes("fix")) return "gps_fix";

  // Orientation quaternion
  if (h === "qw" || h.includes("quatw")) return "q_w";
  if (h === "qx" || h.includes("quatx")) return "q_x";
  if (h === "qy" || h.includes("quaty")) return "q_y";
  if (h === "qz" || h.includes("quatz")) return "q_z";

  // Environment
  if (h.includes("temp")) return /f\b|fahren/.test(raw) ? "temp_f" : "temp_c";
  if (h.includes("press") || h.includes("baro")) return /hpa|mbar|millibar/.test(raw) ? "pressure_hpa" : "pressure_pa";
  if (h.includes("humid")) return "humidity_pct";

  // Events
  if (h.includes("event") || h.includes("state") || h.includes("phase")) return "event";

  return null;
}
