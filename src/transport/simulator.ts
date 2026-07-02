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
const SIM_SPEED = 6; // sim-seconds per real-second, so a full flight plays out in ~20-30s

// Launch pad location (near a typical HPR range) + wind drift for recovery realism
const PAD_LAT = 32.9903;   // ~ FAR / Mojave-ish
const PAD_LON = -106.9749;
const M_PER_DEG_LAT = 111_320;
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

    this.setStatus("connected");

    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus("disconnected");
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

    const frame: Record<string, unknown> = {
      v: 1,
      t_ms: Math.round(this.simMs),
      alt_m: Math.round(Math.max(0, alt) * 100) / 100,
      vel_mps: Math.round(vel * 100) / 100,
      batt_v: Math.round(this.battV * 100) / 100,
      rssi_dbm: Math.round(-58 + (Math.random() - 0.5) * 6),
      ax: Math.round((ax + jitter()) * 1000) / 1000,
      ay: Math.round((ay + jitter()) * 1000) / 1000,
      az: Math.round((az + jitter()) * 1000) / 1000,
      lat: Math.round((lat + gpsJitter()) * 1e6) / 1e6,
      lon: Math.round((lon + gpsJitter()) * 1e6) / 1e6,
      gps_fix: 3,
      gps_sats: 9 + Math.round((Math.random() - 0.5) * 2),
      pyro_drogue_cont: this.drogueCont,
      pyro_main_cont: this.mainCont,
    };

    if (this.pendingEvent) {
      frame.event = this.pendingEvent;
      this.pendingEvent = undefined;
    }

    const line = JSON.stringify(frame);
    this.lineListeners.forEach((cb) => cb(line));
  }
}
