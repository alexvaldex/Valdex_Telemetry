import type { TelemetryFrameV1 } from "./types";

/**
 * Sensor fusion + flight-event detection.
 *
 * Barometric altitude is absolute but noisy; the accelerometer is smooth but
 * drifts. A constant-acceleration Kalman filter over the baro track (using
 * vertical accel as the process input when a valid orientation is available)
 * yields a de-noised altitude AND a velocity estimate — the velocity most hobby
 * flight computers don't transmit.
 *
 * Events are then gated the way real avionics do it, not with the naive
 * "altitude passed a threshold" / "global-max = apogee" heuristics:
 *   - pad zero is the MEAN of the pad-phase baro (not one sample),
 *   - liftoff is an accelerometer gate (sustained high-g), baro slope fallback,
 *   - apogee is the fused-velocity sign change (debounced), not a lone spike,
 *   - landing requires being low AND at rest for a sustained window.
 *
 * Pure functions over a frame array — no React, unit-testable, and used both by
 * the live dashboard (event derivation) and the tests.
 */

const G = 9.80665;

function rawAccelMag(f: TelemetryFrameV1): number | null {
  const { ax, ay, az } = f;
  if (typeof ax !== "number" || typeof ay !== "number" || typeof az !== "number") return null;
  const m = Math.sqrt(ax * ax + ay * ay + az * az);
  return Number.isFinite(m) ? m : null;
}

/** Decide accel units from the pad-rest magnitude: ~9.8 ⇒ m/s², ~1 ⇒ g.
    Returns the divisor that converts the raw magnitude to g. */
export function accelUnitDivisor(frames: TelemetryFrameV1[]): number {
  const mags: number[] = [];
  for (const f of frames.slice(0, 60)) {
    const m = rawAccelMag(f);
    if (m !== null) mags.push(m);
  }
  if (!mags.length) return 1;
  mags.sort((a, b) => a - b);
  const med = mags[Math.floor(mags.length / 2)];
  return med > 4 ? G : 1;
}

/** Vertical (world-up) specific force in m/s², rotating body accel by the
    orientation quaternion when present. Returns null if unavailable. */
function verticalAccel(f: TelemetryFrameV1, divisor: number): number | null {
  const { ax, ay, az } = f;
  if (typeof ax !== "number" || typeof ay !== "number" || typeof az !== "number") return null;
  // Convert to m/s² regardless of source units.
  const s = divisor === 1 ? G : 1; // if data was in g, scale up to m/s²
  const bx = ax * s, by = ay * s, bz = az * s;

  const { q_w, q_x, q_y, q_z } = f;
  if ([q_w, q_x, q_y, q_z].every((n) => typeof n === "number" && Number.isFinite(n))) {
    // World-up (Y) component of R·b, where R is the body→world rotation from q.
    // Row 2 of the standard quaternion rotation matrix:
    //   Ry = 2(xy+wz)·bx + (1−2(x²+z²))·by + 2(yz−wx)·bz
    const w = q_w as number, x = q_x as number, y = q_y as number, z = q_z as number;
    const upY =
      2 * (x * y + w * z) * bx +
      (1 - 2 * (x * x + z * z)) * by +
      2 * (y * z - w * x) * bz;
    return upY - G; // remove gravity to get inertial vertical accel
  }
  // No orientation: assume the body Z axis is roughly vertical (common mount).
  return bz - G;
}

export type FusedTrack = { altF: number[]; velF: number[] };

/**
 * Constant-acceleration Kalman filter over baro altitude, driven by vertical
 * accel when available. Returns fused altitude + velocity aligned to `frames`
 * (values are NaN before the first baro sample).
 */
export function fuseAltVel(frames: TelemetryFrameV1[]): FusedTrack {
  const n = frames.length;
  const altF = new Array<number>(n).fill(NaN);
  const velF = new Array<number>(n).fill(NaN);
  if (!n) return { altF, velF };

  const divisor = accelUnitDivisor(frames);

  // State [alt, vel], covariance P.
  let alt = NaN, vel = 0;
  let p00 = 4, p01 = 0, p10 = 0, p11 = 4;
  let lastT = frames[0].t_ms;
  let started = false;

  const R = 4; // baro measurement variance (≈ (2 m)²)

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const z = typeof f.alt_m === "number" ? (f.alt_m as number) : NaN;

    if (!started) {
      if (Number.isFinite(z)) { alt = z; started = true; lastT = f.t_ms; }
      altF[i] = alt; velF[i] = 0;
      continue;
    }

    let dt = (f.t_ms - lastT) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.05;
    dt = Math.min(0.5, dt);
    lastT = f.t_ms;

    const u = verticalAccel(f, divisor) ?? 0;

    // Predict.
    alt = alt + vel * dt + 0.5 * u * dt * dt;
    vel = vel + u * dt;

    // Process noise grows with dt; extra velocity noise absorbs accel error.
    const q = 0.6;
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt2 * dt2;
    const Q00 = q * dt4 / 4, Q01 = q * dt3 / 2, Q11 = q * dt2;
    p00 = p00 + dt * (p10 + p01) + dt2 * p11 + Q00;
    p01 = p01 + dt * p11 + Q01;
    p10 = p10 + dt * p11 + Q01;
    p11 = p11 + Q11;

    // Update with baro when present.
    if (Number.isFinite(z)) {
      const y = z - alt;
      const s = p00 + R;
      const k0 = p00 / s, k1 = p10 / s;
      alt = alt + k0 * y;
      vel = vel + k1 * y;
      const np00 = (1 - k0) * p00;
      const np01 = (1 - k0) * p01;
      const np10 = p10 - k1 * p00;
      const np11 = p11 - k1 * p01;
      p00 = np00; p01 = np01; p10 = np10; p11 = np11;
    }

    altF[i] = alt;
    velF[i] = vel;
  }

  return { altF, velF };
}

export type FlightEvents = {
  liftoffIdx: number;
  burnoutIdx: number;
  apogeeIdx: number;
  landingIdx: number;
  baselineAlt: number; // averaged pad zero (MSL, same units as alt_m)
};

/** Median of a numeric array (ignores NaN). */
function median(vals: number[]): number {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[Math.floor(v.length / 2)];
}

/**
 * Detect liftoff / burnout / apogee / landing with proper gating. Indices are
 * into `frames`; −1 means not detected.
 */
export function detectFlightEvents(frames: TelemetryFrameV1[]): FlightEvents {
  const n = frames.length;
  const none: FlightEvents = { liftoffIdx: -1, burnoutIdx: -1, apogeeIdx: -1, landingIdx: -1, baselineAlt: 0 };
  if (!n) return none;

  const divisor = accelUnitDivisor(frames);
  const hasAccel = frames.some((f) => rawAccelMag(f) !== null);
  const { altF, velF } = fuseAltVel(frames);

  // Provisional pad baseline from the first ~2 s of baro (pad phase).
  const early: number[] = [];
  for (let i = 0; i < Math.min(n, 40); i++) {
    if (typeof frames[i].alt_m === "number") early.push(frames[i].alt_m as number);
  }
  let baseline = early.length ? median(early) : 0;

  // ---- Liftoff: accel gate (sustained high-g), baro-slope fallback ----
  let liftoffIdx = -1;
  if (hasAccel) {
    const NEED = 3; // consecutive samples above threshold
    const THRESH_G = 2.5; // total specific force; rest ≈ 1 g
    let run = 0;
    for (let i = 0; i < n; i++) {
      const raw = rawAccelMag(frames[i]);
      const g = raw === null ? null : raw / divisor;
      if (g !== null && g > THRESH_G) {
        run++;
        if (run >= NEED) { liftoffIdx = i - NEED + 1; break; }
      } else {
        run = 0;
      }
    }
  }
  if (liftoffIdx < 0) {
    // Baro fallback: altitude climbs and stays >baseline+3 m.
    for (let i = 0; i < n; i++) {
      const a = frames[i].alt_m;
      if (typeof a === "number" && a > baseline + 3) { liftoffIdx = i; break; }
    }
  }

  // Refine baseline from everything strictly before liftoff.
  if (liftoffIdx > 2) {
    const pad: number[] = [];
    for (let i = 0; i < liftoffIdx; i++) {
      if (typeof frames[i].alt_m === "number") pad.push(frames[i].alt_m as number);
    }
    if (pad.length) baseline = median(pad);
  }

  if (liftoffIdx < 0) return { ...none, baselineAlt: baseline };

  // ---- Burnout: specific force falls back toward coast (<1.3 g) ----
  let burnoutIdx = -1;
  if (hasAccel) {
    for (let i = liftoffIdx + 1; i < n; i++) {
      const raw = rawAccelMag(frames[i]);
      const g = raw === null ? null : raw / divisor;
      if (g !== null && g < 1.3) { burnoutIdx = i; break; }
    }
  }

  // ---- Apogee: fused velocity crosses + → − (debounced), but only after
  // ascent is confirmed so the KF's start-of-boost jitter can't trigger it. ----
  let apogeeIdx = -1;
  {
    const NEED = 3;
    let run = 0;
    let ascended = false;
    for (let i = liftoffIdx + 1; i < n; i++) {
      if (Number.isFinite(velF[i]) && velF[i] > 10) ascended = true;
      if (ascended && Number.isFinite(velF[i]) && velF[i] <= 0) {
        run++;
        if (run >= NEED) { apogeeIdx = i - NEED + 1; break; }
      } else {
        run = 0;
      }
    }
    // Fallback: global max of fused altitude after liftoff.
    if (apogeeIdx < 0) {
      let mx = -Infinity;
      for (let i = liftoffIdx; i < n; i++) {
        if (Number.isFinite(altF[i]) && altF[i] > mx) { mx = altF[i]; apogeeIdx = i; }
      }
    }
  }

  // ---- Landing: low AND at rest, sustained ----
  let landingIdx = -1;
  if (apogeeIdx >= 0) {
    const NEED = 5;
    let run = 0;
    for (let i = apogeeIdx + 1; i < n; i++) {
      const low = Number.isFinite(altF[i]) && altF[i] < baseline + 3;
      const slow = Number.isFinite(velF[i]) && Math.abs(velF[i]) < 2;
      if (low && slow) {
        run++;
        if (run >= NEED) { landingIdx = i - NEED + 1; break; }
      } else {
        run = 0;
      }
    }
    // Fallback: last sample below baseline+2 after apogee.
    if (landingIdx < 0) {
      for (let i = n - 1; i > apogeeIdx; i--) {
        const a = frames[i].alt_m;
        if (typeof a === "number" && a < baseline + 2) { landingIdx = i; break; }
      }
    }
  }

  return { liftoffIdx, burnoutIdx, apogeeIdx, landingIdx, baselineAlt: baseline };
}
