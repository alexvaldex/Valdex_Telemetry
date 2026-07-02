/**
 * Launch-pad origin latch. The range map projects the GPS track around the
 * pad; deriving the pad from "the first fix in the buffer" breaks on long pad
 * waits — the ring buffer wraps and the origin silently drifts to wherever the
 * buffer now starts, corrupting recovery bearing/distance. The first fix of
 * the SESSION is latched here instead, outside the ring buffer.
 */

export type PadOrigin = { lat: number; lon: number };

let origin: PadOrigin | null = null;

export function latchPadOrigin(lat: number, lon: number) {
  if (origin === null && Number.isFinite(lat) && Number.isFinite(lon)) {
    origin = { lat, lon };
  }
}

export function getPadOrigin(): PadOrigin | null {
  return origin;
}

export function resetPadOrigin() {
  origin = null;
}
