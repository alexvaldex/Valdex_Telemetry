import type { TelemetryFrameV1 } from "./types";

/** A flight event, latched outside the frame ring buffer: on a long pad wait
    the buffer wraps and early frames (LIFTOFF!) scroll out — the mission
    clock, timeline, and phase logic must never lose them. */
export type TelemetryEvent = {
  t_ms: number;
  event: string;
  vid?: string | number;
};

/** Running maxima latched OUTSIDE the ring buffer so competition-critical
    numbers (apogee, max velocity, max-G) survive a long-flight buffer wrap.
    Deriving these from `frames` alone silently loses the peak once it scrolls
    out — exactly the frame that scoring cares about. */
export type TelemetryPeaks = {
  maxAltM?: number;
  maxVelMps?: number;
  maxAccelG?: number;
};

export type TelemetryState = {
  connected: boolean;
  latest?: TelemetryFrameV1;
  frames: TelemetryFrameV1[]; // ring buffer
  rawLines: string[];         // optional debug console
  events: TelemetryEvent[];   // latched flight events (survive ring wrap)
  peaks: TelemetryPeaks;      // latched maxima (survive ring wrap)
  /** Unit divisor for accel magnitude (9.80665 if m/s², 1 if g); latched from
      the first accel sample, which is pad rest. Internal to peak tracking. */
  accelDivisor?: number;
  /** Last effective (monotonic) timestamp + rebase offset for clock-reset
      handling (a firmware reboot that resets t_ms mid-session). */
  lastTms?: number;
  tOffset?: number;
};

// Sized for a full real-time dual-stream flight: ~2¼ min at 20 Hz × 2 vehicles.
export const MAX_FRAMES = 6000;
export const MAX_RAW_LINES = 500;
export const MAX_EVENTS = 200;

export function initialTelemetryState(): TelemetryState {
  return { connected: false, frames: [], rawLines: [], events: [], peaks: {} };
}

export function pushFrame(state: TelemetryState, frame: TelemetryFrameV1): TelemetryState {
  const frames = state.frames.length >= MAX_FRAMES
    ? [...state.frames.slice(1), frame]
    : [...state.frames, frame];

  return { ...state, latest: frame, frames };
}

export function pushRawLine(state: TelemetryState, line: string): TelemetryState {
  const rawLines = state.rawLines.length >= MAX_RAW_LINES
    ? [...state.rawLines.slice(1), line]
    : [...state.rawLines, line];

  return { ...state, rawLines };
}
