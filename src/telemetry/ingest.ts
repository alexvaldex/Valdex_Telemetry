import { MAX_EVENTS, MAX_FRAMES, MAX_RAW_LINES, type TelemetryState } from "./store";
import { normalizeTelemetryFrame } from "./schema";
import { isTelemetryFrameV1 } from "./validate";
import { applyFieldMap, trackUnknownKeys } from "./fieldMap";
import { verifyAndStrip } from "./crc";
import { latchPadOrigin } from "./padOrigin";

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
  state.rawLines.push(line);
  if (state.rawLines.length > MAX_RAW_LINES) state.rawLines.shift();

  // Optional NMEA-style CRC suffix: verify, count, and drop corrupt lines.
  const { payload, crc } = verifyAndStrip(line);
  if (crc === "ok") crcOk++;
  else if (crc === "bad") {
    crcBad++;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return;
  }

  // User-defined firmware field remapping, then record unmapped keys for the UI.
  raw = applyFieldMap(raw as Record<string, unknown>);
  trackUnknownKeys(raw as Record<string, unknown>);

  const frame = normalizeTelemetryFrame(raw as Record<string, unknown>, Date.now());
  if (!frame || !isTelemetryFrameV1(frame)) return;

  state.frames.push(frame);
  if (state.frames.length > MAX_FRAMES) state.frames.shift();
  state.latest = frame;

  // Latch flight events outside the ring buffer — they must survive wrap.
  if (typeof frame.event === "string" && frame.event.trim() && state.events.length < MAX_EVENTS) {
    state.events.push({ t_ms: frame.t_ms, event: frame.event.trim(), vid: frame.vid });
  }

  // Latch the session's pad origin from the first GPS fix.
  if (typeof frame.lat === "number" && typeof frame.lon === "number") {
    latchPadOrigin(frame.lat, frame.lon);
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
  };
  ingestLineInPlace(next, line);
  return next;
}
