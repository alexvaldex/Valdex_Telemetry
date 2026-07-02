import type { TelemetryFrameV1 } from "./types";

export type TelemetryState = {
  connected: boolean;
  latest?: TelemetryFrameV1;
  frames: TelemetryFrameV1[]; // ring buffer
  rawLines: string[];         // optional debug console
};

// Sized for a full real-time dual-stream flight: ~2¼ min at 20 Hz × 2 vehicles.
export const MAX_FRAMES = 6000;
export const MAX_RAW_LINES = 500;

export function initialTelemetryState(): TelemetryState {
  return { connected: false, frames: [], rawLines: [] };
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

