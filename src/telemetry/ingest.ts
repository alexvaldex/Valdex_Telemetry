import { MAX_EVENTS, MAX_FRAMES, MAX_RAW_LINES, type TelemetryState } from "./store";
import type { TelemetryFrameV1 } from "./types";
import { normalizeTelemetryFrame } from "./schema";
import { isTelemetryFrameV1 } from "./validate";
import { applyFieldMap, trackUnknownKeys } from "./fieldMap";
import { verifyAndStrip } from "./crc";
import { latchPadOrigin } from "./padOrigin";
import { parseLine, applyAutoHeaderMap } from "./deviceProfiles";

/** Wire-integrity counters for the current session (shown in Link Quality). */
let crcOk = 0;
let crcBad = 0;
export function getCrcStats() {
  return { ok: crcOk, bad: crcBad };
}
export function resetCrcStats() {
  crcOk = 0;
  crcBad = 0;
}

/**
 * Hot-path ingest: mutates the given state's arrays in place (no per-line
 * allocation). Used by the live store, which snapshots at its UI tick rate
 * instead of per line — at 20–40 Hz across multiple streams this matters.
 */
export function ingestLineInPlace(state: TelemetryState, line: string): void {
  if (!state.peaks) state.peaks = {}; // tolerate states built before peaks existed
  state.rawLines.push(line);
  if (state.rawLines.length > MAX_RAW_LINES) state.rawLines.shift();

  // Optional NMEA-style CRC suffix: verify, count, and drop corrupt lines.
  const { payload, crc } = verifyAndStrip(line);
  if (crc === "ok") crcOk++;
  else if (crc === "bad") {
    crcBad++;
    return;
  }

  // Parse per the active device profile (NDJSON / CSV / key=value / auto).
  // Header rows and unparseable lines return null and are skipped.
  const parsed = parseLine(payload);
  if (parsed === null) return;

  // User-defined field map wins first; then fuzzy header auto-mapping fills any
  // remaining recognizable raw CSV/text column names; then record leftovers.
  const raw = applyAutoHeaderMap(applyFieldMap(parsed));
  trackUnknownKeys(raw);

  const frame = normalizeTelemetryFrame(raw, Date.now());
  if (!frame || !isTelemetryFrameV1(frame)) return;

  // Drop physically impossible values (a garbled alt_m of 1e30 would blow up
  // every plot, the apogee predictor, and the auto-fit scales).
  sanitizeFrame(frame);

  // Monotonic MET: a firmware reboot resets t_ms mid-session. Detect a large
  // backward jump and rebase so the timeline keeps moving forward.
  const rawT = frame.t_ms;
  const off = state.tOffset ?? 0;
  if (state.lastTms !== undefined && rawT + off < state.lastTms - 2000) {
    state.tOffset = state.lastTms - rawT + 50;
  }
  frame.t_ms = rawT + (state.tOffset ?? 0);
  state.lastTms = frame.t_ms;

  state.frames.push(frame);
  if (state.frames.length > MAX_FRAMES) state.frames.shift();
  state.latest = frame;

  // Latch running maxima OUTSIDE the ring buffer (survive wrap → scoring safe).
  const pk = state.peaks;
  if (typeof frame.alt_m === "number") pk.maxAltM = pk.maxAltM === undefined ? frame.alt_m : Math.max(pk.maxAltM, frame.alt_m);
  if (typeof frame.vel_mps === "number") {
    const a = Math.abs(frame.vel_mps);
    pk.maxVelMps = pk.maxVelMps === undefined ? a : Math.max(pk.maxVelMps, a);
  }
  if (typeof frame.ax === "number" && typeof frame.ay === "number" && typeof frame.az === "number") {
    const mag = Math.sqrt(frame.ax * frame.ax + frame.ay * frame.ay + frame.az * frame.az);
    if (state.accelDivisor === undefined) state.accelDivisor = mag > 4 ? 9.80665 : 1; // first sample = pad rest
    const g = mag / state.accelDivisor;
    pk.maxAccelG = pk.maxAccelG === undefined ? g : Math.max(pk.maxAccelG, g);
  }

  // Latch flight events outside the ring buffer — they must survive wrap.
  if (typeof frame.event === "string" && frame.event.trim() && state.events.length < MAX_EVENTS) {
    state.events.push({ t_ms: frame.t_ms, event: frame.event.trim(), vid: frame.vid });
  }

  // Latch the session's pad origin from the first GPS fix.
  if (typeof frame.lat === "number" && typeof frame.lon === "number") {
    latchPadOrigin(frame.lat, frame.lon);
  }
}

/** Plausible bounds per field; a value outside its range (or non-finite) is
    dropped rather than kept, so one garbled packet can't corrupt the session. */
const FIELD_BOUNDS: Record<string, [number, number]> = {
  alt_m: [-1000, 150000], gps_alt_m: [-1000, 150000],
  vel_mps: [-8000, 8000],
  ax: [-2000, 2000], ay: [-2000, 2000], az: [-2000, 2000],
  gx: [-100000, 100000], gy: [-100000, 100000], gz: [-100000, 100000],
  batt_v: [0, 120], current_a: [-1000, 1000],
  rssi_dbm: [-200, 50], snr_db: [-100, 100],
  lat: [-90, 90], lon: [-180, 180],
  gps_sats: [0, 64], gps_fix: [0, 10],
  temp_c: [-150, 200], pressure_pa: [0, 200000], humidity_pct: [0, 100],
};

function sanitizeFrame(frame: TelemetryFrameV1): void {
  const f = frame as Record<string, unknown>;
  for (const key in FIELD_BOUNDS) {
    const v = f[key];
    if (typeof v !== "number") continue;
    const [lo, hi] = FIELD_BOUNDS[key];
    if (!Number.isFinite(v) || v < lo || v > hi) f[key] = undefined;
  }
}

/** Pure variant (playback, tests): returns a new state, original untouched. */
export function ingestLine(state: TelemetryState, line: string): TelemetryState {
  const next: TelemetryState = {
    connected: state.connected,
    latest: state.latest,
    frames: [...state.frames],
    rawLines: [...state.rawLines],
    events: [...state.events],
    peaks: { ...(state.peaks ?? {}) },
    accelDivisor: state.accelDivisor,
    lastTms: state.lastTms,
    tOffset: state.tOffset,
  };
  ingestLineInPlace(next, line);
  return next;
}
