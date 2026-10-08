/**
 * Frame diagnostics: run one candidate telemetry line through the SAME pipeline
 * the live link uses, and report exactly what the app understood, what it
 * dropped, and why. This is the hardware bring-up tool: paste a line your
 * firmware emits and see whether it will appear live before you ever connect.
 *
 * The pipeline mirrored here (see ingest.ts) is:
 *   verifyAndStrip (CRC) -> parseLine (NDJSON/CSV/key=value) -> field map ->
 *   auto header map -> normalizeTelemetryFrame -> isTelemetryFrameV1 -> bounds
 *
 * Everything is pure: no module state is mutated, so it is safe to run on every
 * keystroke in the tester UI and straightforward to unit test.
 */

import { verifyAndStrip, appendChecksum, type CrcResult } from "./crc";
import { parseLine, applyAutoHeaderMap } from "./deviceProfiles";
import { applyFieldMap, getFieldMap } from "./fieldMap";
import { normalizeTelemetryFrame } from "./schema";
import { isTelemetryFrameV1 } from "./validate";
import { FIELD_BOUNDS } from "./ingest";
import type { TelemetryFrameV1 } from "./types";

/** Every key a strict V1 frame may carry (the output contract of schema.ts). */
export const V1_FRAME_KEYS = new Set<string>([
  "v", "t_ms", "vid", "seq",
  "alt_m", "vel_mps",
  "batt_v", "current_a", "rssi_dbm", "snr_db",
  "ax", "ay", "az", "gx", "gy", "gz",
  "lat", "lon", "gps_fix", "gps_sats", "gps_alt_m",
  "q_w", "q_x", "q_y", "q_z",
  "tvc_pitch_deg", "tvc_yaw_deg", "tvc_pitch_fb_deg", "tvc_yaw_fb_deg", "tvc_enabled",
  "canard_1_deg", "canard_2_deg", "canard_3_deg", "canard_4_deg",
  "canard_roll_cmd_deg", "roll_rate_dps", "canard_enabled",
  "airbrake_pct", "airbrake_fb_pct", "airbrake_target_apogee_m", "airbrake_pred_apogee_m", "airbrake_enabled",
  "temp_c", "pressure_pa", "humidity_pct",
  "event", "pyro_main_cont", "pyro_drogue_cont",
]);

/** Raw key names that feed t_ms, plus the version key — recognized but they
    don't show up as a distinct frame field in the per-key probe. */
const TIME_KEYS = new Set<string>(["t_ms", "t", "time_ms", "timestamp_ms"]);

export type FieldDrop = {
  key: string;
  value: number;
  reason: "non-finite" | "out-of-range";
  range?: [number, number];
};

export type LineFormat = "json" | "csv" | "keyval" | "header-or-unparseable" | "empty";

export type LineAnalysis = {
  input: string;
  empty: boolean;
  /** CRC suffix result: "ok", "bad" (app drops the line), or "none". */
  crc: CrcResult;
  payload: string;
  /** True when the app would discard this line before parsing (bad CRC). */
  droppedByCrc: boolean;
  format: LineFormat;
  /** The loose object parseLine produced, or null (header row / unparseable). */
  parsed: Record<string, unknown> | null;
  parsedKeys: string[];
  /** Raw keys that reach a V1 field (directly, via alias, or via a field map). */
  recognized: string[];
  /** Raw keys that map nowhere — fix in firmware or map in Field Map. */
  unknownKeys: string[];
  /** The normalized frame after bounds sanitation, or null if unparseable. */
  frame: TelemetryFrameV1 | null;
  /** Populated V1 fields on the frame (what widgets will actually see). */
  fields: Record<string, number | string>;
  /** Numeric fields the app would blank out as physically implausible. */
  droppedByBounds: FieldDrop[];
  /** True when this is a trusted v:1 frame, so alias mapping is skipped. */
  trustedV1: boolean;
  /** isTelemetryFrameV1 after normalization. */
  valid: boolean;
  /** The bottom line: would this line show up live? */
  wouldIngest: boolean;
  notes: string[];
};

function detectFormat(payload: string): LineFormat {
  const t = payload.trim();
  if (!t) return "empty";
  if (t.startsWith("{")) return "json";
  if (t.includes(",") && t.split(",").some((tok) => Number.isFinite(Number(tok.trim())) && tok.trim() !== "")) return "csv";
  if (/[A-Za-z_][\w.]*[=:]/.test(t)) return "keyval";
  return "header-or-unparseable";
}

/** Does a single raw key land on a V1 field (directly, by alias, or by map)? */
function keyIsRecognized(key: string, value: unknown, mapSources: Set<string>): boolean {
  if (V1_FRAME_KEYS.has(key)) return true;
  if (TIME_KEYS.has(key)) return true;
  if (mapSources.has(key)) return true;
  // Probe: normalize a minimal object carrying just this key and see whether
  // any V1 field other than the version/time lights up.
  const probe = normalizeTelemetryFrame({ t_ms: 0, [key]: value }, 0);
  if (!probe) return false;
  for (const k of Object.keys(probe)) {
    if (k === "v" || k === "t_ms") continue;
    if ((probe as Record<string, unknown>)[k] !== undefined) return true;
  }
  return false;
}

/**
 * Analyze one raw line exactly as the live ingest path would see it.
 * `stampArrivalTime` mirrors the live path, which stamps Date.now() when a
 * frame omits t_ms; pass false in tests for determinism.
 */
export function analyzeLine(rawLine: string, stampArrivalTime = true): LineAnalysis {
  const input = rawLine;
  const line = rawLine.trim();
  const notes: string[] = [];

  if (!line) {
    return {
      input, empty: true, crc: "none", payload: "", droppedByCrc: false,
      format: "empty", parsed: null, parsedKeys: [], recognized: [], unknownKeys: [],
      frame: null, fields: {}, droppedByBounds: [], trustedV1: false,
      valid: false, wouldIngest: false, notes: ["Empty line."],
    };
  }

  const { payload, crc } = verifyAndStrip(line);
  const droppedByCrc = crc === "bad";
  if (crc === "bad") {
    notes.push("CRC mismatch: the live link drops this line. The checksum must be CRC-16/CCITT-FALSE over the text before the '*'.");
  } else if (crc === "none") {
    notes.push("No checksum suffix (optional). Append '*XXXX' to get corruption detection and the Link Quality drop count.");
  }

  const format = detectFormat(payload);
  const parsed = parseLine(payload);

  if (parsed === null) {
    notes.push(
      format === "header-or-unparseable"
        ? "Not JSON, CSV, or key=value. Check framing: one record per line, newline terminated."
        : "No fields parsed. If this is a CSV header row it is learned for later rows, not plotted."
    );
    return {
      input, empty: false, crc, payload, droppedByCrc, format,
      parsed: null, parsedKeys: [], recognized: [], unknownKeys: [],
      frame: null, fields: {}, droppedByBounds: [], trustedV1: false,
      valid: false, wouldIngest: false, notes,
    };
  }

  const parsedKeys = Object.keys(parsed);
  const mapSources = new Set(getFieldMap().map((m) => m.source));

  // Mirror ingest: field map wins, then fuzzy header auto-map. Clone so we never
  // mutate the caller's object.
  const raw = applyAutoHeaderMap(applyFieldMap({ ...parsed }));

  const trustedV1 = raw.v === 1 && typeof raw.t_ms === "number";
  if (trustedV1) {
    notes.push("Trusted v:1 frame: alias mapping is skipped, so only exact V1 key names are read. Drop 'v' to let aliases apply, or use exact keys.");
  }

  const recognized: string[] = [];
  const unknownKeys: string[] = [];
  for (const k of parsedKeys) {
    const ok = trustedV1
      ? (V1_FRAME_KEYS.has(k) || TIME_KEYS.has(k) || mapSources.has(k))
      : keyIsRecognized(k, (parsed as Record<string, unknown>)[k], mapSources);
    (ok ? recognized : unknownKeys).push(k);
  }

  const hadT = parsedKeys.some((k) => TIME_KEYS.has(k));
  const fallback = stampArrivalTime ? Date.now() : undefined;
  const frame = normalizeTelemetryFrame(raw, fallback);

  if (!frame) {
    notes.push("No usable t_ms and no arrival-time fallback: the frame cannot be built. Send t_ms (milliseconds since power-on).");
    return {
      input, empty: false, crc, payload, droppedByCrc, format,
      parsed, parsedKeys, recognized, unknownKeys,
      frame: null, fields: {}, droppedByBounds: [], trustedV1,
      valid: false, wouldIngest: false, notes,
    };
  }

  if (!hadT) {
    notes.push("t_ms missing: the live link stamps arrival time so it still plots, but true timing is lost. Send t_ms for accurate plots.");
  }

  // Apply the same bounds the live path applies, recording what it would blank.
  const droppedByBounds: FieldDrop[] = [];
  const f = frame as Record<string, unknown>;
  for (const key of Object.keys(FIELD_BOUNDS)) {
    const v = f[key];
    if (typeof v !== "number") continue;
    const [lo, hi] = FIELD_BOUNDS[key];
    if (!Number.isFinite(v)) {
      droppedByBounds.push({ key, value: v, reason: "non-finite" });
      f[key] = undefined;
    } else if (v < lo || v > hi) {
      droppedByBounds.push({ key, value: v, reason: "out-of-range", range: [lo, hi] });
      f[key] = undefined;
    }
  }
  if (droppedByBounds.length) {
    notes.push(`${droppedByBounds.length} value(s) outside plausible range were blanked (${droppedByBounds.map((d) => d.key).join(", ")}). Check units and scaling.`);
  }

  // Collect the surviving populated V1 fields: what widgets will actually see.
  const fields: Record<string, number | string> = {};
  for (const k of Object.keys(f)) {
    const v = f[k];
    if (v === undefined || v === null || k === "v") continue;
    if (typeof v === "number" || typeof v === "string") fields[k] = v;
  }

  const valid = isTelemetryFrameV1(frame);
  const wouldIngest = !droppedByCrc && valid;

  if (unknownKeys.length) {
    notes.push(`${unknownKeys.length} field(s) not recognized: ${unknownKeys.join(", ")}. Rename in firmware to a V1 key or alias, or map them in Field Map.`);
  }
  if (wouldIngest && !unknownKeys.length && !droppedByBounds.length) {
    notes.push("Looks good: this line parses to a valid frame and will appear live.");
  }

  return {
    input, empty: false, crc, payload, droppedByCrc, format,
    parsed, parsedKeys, recognized, unknownKeys,
    frame, fields, droppedByBounds, trustedV1,
    valid, wouldIngest, notes,
  };
}

/** A canonical, valid example line for the tester's "insert example" action. */
export function exampleFrameLine(withCrc = false): string {
  const line = JSON.stringify({
    v: 1, t_ms: 123456,
    alt_m: 102.4, vel_mps: 58.1, batt_v: 7.9,
    lat: 28.6, lon: -80.6,
    ax: 0.1, ay: 0.0, az: 9.8,
    q_w: 1, q_x: 0, q_y: 0, q_z: 0,
    temp_c: 21.2, pressure_pa: 98120,
    rssi_dbm: -74, snr_db: 9.5,
    event: "LIFTOFF", pyro_main_cont: 1, pyro_drogue_cont: 1,
  });
  return withCrc ? appendChecksum(line) : line;
}
