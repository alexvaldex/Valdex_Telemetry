import type { Connection, ConnectOptions, ConnectionStatus } from "./types";

type Phase = "idle" | "boost" | "coast" | "drogue" | "main" | "landed";

const G = 9.81;
const BOOST_ACCEL = 100; // net m/s^2 during motor burn
const BOOST_DURATION_S = 2.5;
const COAST_DECEL = 25; // m/s^2 (gravity + drag) during coast to apogee
const DROGUE_VEL = -20; // m/s
const MAIN_DEPLOY_ALT_M = 300;
const MAIN_VEL = -5; // m/s
const TICK_MS = 50; // 20Hz emission rate
// Sim-seconds per real-second. 1 = true real time (the mission clock matches
// your wall clock; a full flight takes ~2¼ minutes like a real one would).
// Bump temporarily if you want a fast demo run.
const SIM_SPEED = 1;

// Launch pad location (near a typical HPR range) + wind drift for recovery realism
const PAD_LAT = 32.9903;   // ~ FAR / Mojave-ish
const PAD_LON = -106.9749;
const PAD_ALT_M = 1400;    // pad elevation above sea level (affects baro/temp)
const M_PER_DEG_LAT = 111_320;

/* Minimal quaternion helpers for the simulated attitude (w,x,y,z). */
type Quat = { w: number; x: number; y: number; z: number };
function qAxis(ax: number, ay: number, az: number, deg: number): Quat {
  const r = (deg * Math.PI) / 180;
  const s = Math.sin(r / 2);
  return { w: Math.cos(r / 2), x: ax * s, y: ay * s, z: az * s };
}
function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
const WIND_E_MPS = 4.5;    // eastward wind pushes vehicle downrange under chute
const WIND_N_MPS = 1.5;

export class SimulatorConnection implements Connection {
  status: ConnectionStatus = "disconnected";

  private timer: ReturnType<typeof setInterval> | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  private phase: Phase = "idle";
  private phaseStartMs = 0; // sim time (ms) at which current phase started
  private phaseStartAlt = 0;
  private phaseStartVel = 0;
  private simMs = 0; // total elapsed sim time
  private battV = 8.4;
  private armed = false;

  // Recovery / GPS drift state (meters east/north of pad)
  private posE = 0;
  private posN = 0;
  // Pyro continuity (1 = good/charge present, 0 = fired/open)
  private drogueCont: 0 | 1 = 1;
  private mainCont: 0 | 1 = 1;
  private drogueEventSent = false;
  private spinDeg = 0; // accumulated roll about the long axis

  // Separated booster — its own tracker stream (vid "BSTR") after staging.
  private booster: {
    phase: "coast" | "descent" | "landed";
    alt: number;
    vel: number;
    posE: number;
    posN: number;
    pendingEvent?: string;
  } | null = null;

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusListeners.forEach((cb) => cb(status));
  }

  async connect(_opts: ConnectOptions): Promise<void> {
    this.setStatus("connecting");

    this.phase = "idle";
    this.phaseStartMs = 0;
    this.phaseStartAlt = 0;
    this.phaseStartVel = 0;
    this.simMs = 0;
    this.battV = 8.4;
    this.armed = false;
    this.posE = 0;
    this.posN = 0;
    this.drogueCont = 1;
    this.mainCont = 1;
    this.drogueEventSent = false;
    this.spinDeg = 0;
    this.booster = null;

    this.setStatus("connected");

    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus("disconnected");
  }

  /** TX console support — the sim acknowledges commands like real firmware would. */
  async write(line: string): Promise<void> {
    const cmd = line.trim().toUpperCase();
    setTimeout(() => {
      if (this.status !== "connected") return;
      if (cmd === "PING") this.emitRaw("# PONG");
      else if (cmd === "STATUS") this.emitRaw(`# STATUS phase=${this.phase} batt=${this.battV.toFixed(2)}V alt=${this.lastAlt.toFixed(1)}m`);
      else if (cmd === "VERSION") this.emitRaw("# VX-SIM firmware 1.0.0");
      else this.emitRaw(`# ACK ${cmd}`);
    }, 120);
  }

  private emitRaw(line: string) {
    this.lineListeners.forEach((cb) => cb(line));
  }

  private pendingEvent: string | undefined;
  private lastAlt = 0;
  private lastVel = 0;

  private tick() {
    this.simMs += TICK_MS * SIM_SPEED;
    const dt = (this.simMs - this.phaseStartMs) / 1000; // seconds into current phase

    let alt = this.phaseStartAlt;
    let vel = this.phaseStartVel;
    let ax = 0, ay = 0, az = G; // accel including gravity reaction, at rest az ~= +1g

    switch (this.phase) {
      case "idle": {
        if (!this.armed && dt >= 1) {
          this.armed = true;
          this.pendingEvent = "ARMED";
        }
        if (dt >= 3) {
          this.pendingEvent = "LIFTOFF";
          this.phase = "boost";
          this.phaseStartMs = this.simMs;
          alt = 0;
          vel = 0;
        }
        break;
      }
      case "boost": {
        if (dt <= BOOST_DURATION_S) {
          vel = this.phaseStartVel + BOOST_ACCEL * dt;
          alt = this.phaseStartAlt + this.phaseStartVel * dt + 0.5 * BOOST_ACCEL * dt * dt;
          az = G + BOOST_ACCEL;
        } else {
          this.pendingEvent = "BURNOUT";
          this.phase = "coast";
          this.phaseStartMs = this.simMs - (dt - BOOST_DURATION_S) * 1000;
          this.phaseStartAlt = this.lastAlt;
          this.phaseStartVel = this.lastVel;
          alt = this.phaseStartAlt;
          vel = this.phaseStartVel;

          // Staging: the spent booster separates and flies its own profile,
          // transmitting on its own tracker (vid "BSTR").
          this.booster = {
            phase: "coast",
            alt: this.lastAlt,
            vel: this.lastVel * 0.85, // separation scrubs a little velocity
            posE: this.posE,
            posN: this.posN,
            pendingEvent: "SEPARATION",
          };
        }
        break;
      }
      case "coast": {
        vel = this.phaseStartVel - COAST_DECEL * dt;
        if (vel <= 0) {
          const tApogee = this.phaseStartVel / COAST_DECEL;
          alt = this.phaseStartAlt + this.phaseStartVel * tApogee - 0.5 * COAST_DECEL * tApogee * tApogee;
          vel = 0;
          this.pendingEvent = "APOGEE";
          this.drogueCont = 0; // drogue charge fires at apogee -> continuity opens
          this.phase = "drogue";
          this.phaseStartMs = this.simMs;
          this.phaseStartAlt = alt;
          this.phaseStartVel = DROGUE_VEL;
        } else {
          alt = this.phaseStartAlt + this.phaseStartVel * dt - 0.5 * COAST_DECEL * dt * dt;
        }
        az = 0.7 * G; // light deceleration signature under thrust-free coast
        break;
      }
      case "drogue": {
        vel = DROGUE_VEL;
        alt = this.phaseStartAlt + DROGUE_VEL * dt;
        az = G;
        // Emit a distinct DROGUE event ~1s after apogee (drogue canopy inflating).
        if (!this.drogueEventSent && dt >= 1) {
          this.drogueEventSent = true;
          this.pendingEvent = "DROGUE";
        }
        if (alt <= MAIN_DEPLOY_ALT_M) {
          alt = MAIN_DEPLOY_ALT_M;
          this.pendingEvent = "MAIN";
          this.mainCont = 0; // main charge fires -> continuity opens
          this.phase = "main";
          this.phaseStartMs = this.simMs;
          this.phaseStartAlt = alt;
          this.phaseStartVel = MAIN_VEL;
        }
        break;
      }
      case "main": {
        vel = MAIN_VEL;
        alt = this.phaseStartAlt + MAIN_VEL * dt;
        az = G;
        if (alt <= 0) {
          alt = 0;
          vel = 0;
          this.pendingEvent = "LANDING";
          this.phase = "landed";
          this.phaseStartMs = this.simMs;
          this.phaseStartAlt = 0;
          this.phaseStartVel = 0;
        }
        break;
      }
      case "landed": {
        alt = 0;
        vel = 0;
        az = G;
        break;
      }
    }

    this.lastAlt = alt;
    this.lastVel = vel;

    // slow battery drain over the flight
    this.battV = Math.max(6.6, 8.4 - this.simMs / 400000);

    // Horizontal drift under wind: strongest while descending under chutes.
    const dtSec = (TICK_MS * SIM_SPEED) / 1000;
    const descending = vel < -0.5;
    const driftFactor = descending ? 1 : this.phase === "boost" || this.phase === "coast" ? 0.15 : 0;
    this.posE += WIND_E_MPS * driftFactor * dtSec;
    this.posN += WIND_N_MPS * driftFactor * dtSec;

    const lat = PAD_LAT + this.posN / M_PER_DEG_LAT;
    const lon = PAD_LON + this.posE / (M_PER_DEG_LAT * Math.cos((PAD_LAT * Math.PI) / 180));

    const jitter = () => (Math.random() - 0.5) * 0.08;
    const gpsJitter = () => (Math.random() - 0.5) * 0.00002;

    // Environment from the International Standard Atmosphere (troposphere model),
    // referenced to the pad altitude so it reads realistically through the flight.
    const altAbs = PAD_ALT_M + Math.max(0, alt);
    const temp_c = 15.0 - 0.0065 * altAbs + (Math.random() - 0.5) * 0.3;
    const pressure_pa = 101325 * Math.pow(1 - 2.25577e-5 * altAbs, 5.25588);
    const humidity_pct = Math.max(8, Math.min(95, 55 - alt / 60 + (Math.random() - 0.5) * 2));

    // Simulated attitude: roll about the long axis + phase-dependent tilt.
    // Identity quaternion = nose straight up.
    let tiltDeg = 0.4 * Math.sin(this.simMs / 900); // slight breathing on the pad
    let tiltAxisDeg = 25;
    let spinRateDps = 0; // roll rate about the long axis, deg/s (emitted as gy)
    switch (this.phase) {
      case "boost":
        spinRateDps = 220;                       // fast roll under thrust
        tiltDeg = Math.min(4, dt * 2);           // small weathercock into the wind
        break;
      case "coast":
        spinRateDps = 50;                        // roll decays after burnout
        tiltDeg = Math.min(26, 4 + dt * 1.6);    // gravity turn builds
        break;
      case "drogue":
        spinRateDps = 18;
        tiltDeg = 14 * Math.sin(2 * Math.PI * 0.35 * dt); // pendulum swing under drogue
        tiltAxisDeg = 25 + dt * 30;                        // swing plane precesses
        break;
      case "main":
        spinRateDps = 6;
        tiltDeg = 6 * Math.sin(2 * Math.PI * 0.5 * dt);   // gentler swing under main
        tiltAxisDeg = 25 + dt * 15;
        break;
      case "landed":
        tiltDeg = 84; // resting on its side in the dirt
        tiltAxisDeg = 10;
        break;
    }
    this.spinDeg += spinRateDps * dtSec;
    const axR = (tiltAxisDeg * Math.PI) / 180;
    const q = qMul(qAxis(Math.cos(axR), 0, Math.sin(axR), tiltDeg), qAxis(0, 1, 0, this.spinDeg % 360));
    const r4 = (n: number) => Math.round(n * 10000) / 10000;

    const frame: Record<string, unknown> = {
      v: 1,
      vid: "SUST",
      t_ms: Math.round(this.simMs),
      alt_m: Math.round(Math.max(0, alt) * 100) / 100,
      vel_mps: Math.round(vel * 100) / 100,
      batt_v: Math.round(this.battV * 100) / 100,
      rssi_dbm: Math.round(-58 + (Math.random() - 0.5) * 6),
      ax: Math.round((ax + jitter()) * 1000) / 1000,
      ay: Math.round((ay + jitter()) * 1000) / 1000,
      az: Math.round((az + jitter()) * 1000) / 1000,
      gx: Math.round((Math.random() - 0.5) * 4 * 100) / 100,
      gy: Math.round((spinRateDps + (Math.random() - 0.5) * 6) * 100) / 100,
      gz: Math.round((Math.random() - 0.5) * 4 * 100) / 100,
      lat: Math.round((lat + gpsJitter()) * 1e6) / 1e6,
      lon: Math.round((lon + gpsJitter()) * 1e6) / 1e6,
      gps_fix: 3,
      gps_sats: 9 + Math.round((Math.random() - 0.5) * 2),
      gps_alt_m: Math.round((PAD_ALT_M + Math.max(0, alt) + (Math.random() - 0.5) * 6) * 10) / 10,
      temp_c: Math.round(temp_c * 10) / 10,
      pressure_pa: Math.round(pressure_pa),
      humidity_pct: Math.round(humidity_pct),
      snr_db: Math.round(Math.max(1, 15 - Math.max(0, alt) / 250 + (Math.random() - 0.5) * 3) * 10) / 10,
      current_a:
        Math.round(
          ((this.phase === "boost" ? 0.95 : this.phase === "coast" ? 0.6 : this.phase === "idle" ? 0.35 : 0.5) +
            (Math.random() - 0.5) * 0.06) * 100
        ) / 100,
      q_w: r4(q.w), q_x: r4(q.x), q_y: r4(q.y), q_z: r4(q.z),
      pyro_drogue_cont: this.drogueCont,
      pyro_main_cont: this.mainCont,
    };

    if (this.pendingEvent) {
      frame.event = this.pendingEvent;
      this.pendingEvent = undefined;
    }

    const line = JSON.stringify(frame);
    this.lineListeners.forEach((cb) => cb(line));

    this.tickBooster(dtSec);
  }

  /** Integrate + emit the separated booster's own tracker stream. */
  private tickBooster(dtSec: number) {
    const b = this.booster;
    if (!b) return;

    if (b.phase === "coast") {
      b.vel -= 32 * dtSec; // draggier without the sustainer's nose
      b.alt += b.vel * dtSec;
      if (b.vel <= 0) {
        b.phase = "descent";
        b.pendingEvent = "APOGEE";
      }
    } else if (b.phase === "descent") {
      b.vel = -22; // tumbling / drogue-less terminal-ish descent
      b.alt += b.vel * dtSec;
      b.posE += WIND_E_MPS * 0.7 * dtSec;
      b.posN += WIND_N_MPS * 0.7 * dtSec;
      if (b.alt <= 0) {
        b.alt = 0;
        b.vel = 0;
        b.phase = "landed";
        b.pendingEvent = "LANDING";
      }
    }
    // landed: keep beaconing for recovery

    const lat = PAD_LAT + b.posN / M_PER_DEG_LAT;
    const lon = PAD_LON + b.posE / (M_PER_DEG_LAT * Math.cos((PAD_LAT * Math.PI) / 180));

    const frame: Record<string, unknown> = {
      v: 1,
      vid: "BSTR",
      t_ms: Math.round(this.simMs),
      alt_m: Math.round(Math.max(0, b.alt) * 100) / 100,
      vel_mps: Math.round(b.vel * 100) / 100,
      batt_v: 7.9,
      rssi_dbm: Math.round(-72 - Math.max(0, b.alt) / 400 + (Math.random() - 0.5) * 6),
      snr_db: Math.round(Math.max(1, 10 - Math.max(0, b.alt) / 400 + (Math.random() - 0.5) * 2) * 10) / 10,
      lat: Math.round((lat + (Math.random() - 0.5) * 0.00002) * 1e6) / 1e6,
      lon: Math.round((lon + (Math.random() - 0.5) * 0.00002) * 1e6) / 1e6,
      gps_fix: 3,
      gps_sats: 8 + Math.round((Math.random() - 0.5) * 2),
      gps_alt_m: Math.round((PAD_ALT_M + Math.max(0, b.alt) + (Math.random() - 0.5) * 6) * 10) / 10,
    };
    if (b.pendingEvent) {
      frame.event = b.pendingEvent;
      b.pendingEvent = undefined;
    }
    this.lineListeners.forEach((cb) => cb(JSON.stringify(frame)));
  }
}
