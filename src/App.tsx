import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { deriveCapabilities } from "./telemetry/capabilities";
import type { TelemetryFrameV1 } from "./telemetry/types";
import { getPadOrigin } from "./telemetry/padOrigin";
import { tiltDegFromQuat } from "./telemetry/attitude";
import { detectFlightEvents } from "./telemetry/fusion";

import { WIDGETS, WIDGETS_BY_CATEGORY, type WidgetId } from "./widgets/registry";
import { WIDGET_HELP, learnMoreUrl } from "./widgets/widgetHelp";
import { TEMPLATES, templateLayout, type DashTemplate } from "./telemetry/templates";
import type { UnitSystem } from "./units";
import { renderWidget } from "./widgets/renderers";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import type { Connection, ConnectionStatus } from "./transport/types";
import { WebSerialConnection, isWebSerialSupported } from "./transport/webSerial";
import { SimulatorConnection } from "./transport/simulator";
import { TauriSerialConnection, isTauri, listNativePorts } from "./transport/tauriSerial";
import { liveStore } from "./telemetry/liveStore";
import { saveFlight, listFlights, getFlight, deleteFlight, checkpointLiveFlight, clearLiveCheckpoint, recoverLiveFlight, type FlightMeta } from "./telemetry/flightLog";
import { startAlarm, stopAlarm } from "./audio/masterCaution";
import {
  getRocketConfig,
  saveRocketConfig,
  saveVehicleModel,
  getVehicleModel,
  deleteVehicleModel,
  type RocketConfig,
  type StageRole,
  VEHICLE_CHANGED_EVENT,
  notifyVehicleChanged,
} from "./telemetry/vehicleStore";
import type { Model3D, UpAxis } from "./widgets/rocketModel";
import { getFieldMap, saveFieldMap, getUnknownKeys, V1_TARGET_KEYS, type FieldMapping } from "./telemetry/fieldMap";
import { DEVICE_PROFILES, loadDeviceProfile, setDeviceProfile } from "./telemetry/deviceProfiles";
import {
  flightToFrames,
  toShareFlight,
  buildReplayHTML,
  encodeShareLink,
  decodeShareLink,
  shareFlightToLines,
  type ShareFlight,
} from "./telemetry/shareFlight";
import { speak } from "./audio/voice";
import { loadAlertRules, saveAlertRules, ruleFires, RULE_FIELDS, type AlertRule } from "./telemetry/alertRules";
import { setGhost } from "./telemetry/ghost";
import { verifyAndStrip } from "./telemetry/crc";
import {
  loadSimProfile,
  saveSimProfile,
  simulatePreflight,
  recoveryRouteUrl,
  MOTORS,
  SEASON_PRESETS,
  type SimProfile,
  type MotorSpec,
} from "./telemetry/flightSim";
import { parseEng, parseRse, parseOrk, getUserMotors, addUserMotors } from "./telemetry/motorFile";
import { computeFlightSummary } from "./widgets/flightSummary";

/** ---------- Types ---------- */
type WidgetInstance = { key: string; widgetId: WidgetId };

type WidgetSettings = {
  units?: UnitSystem; // per-widget override (otherwise inherit global)
  accent?: string; // per-widget accent override
  view?: "card" | "instrument" | "plot";
  vid?: string; // per-widget vehicle override: undefined = follow global, "ALL" = every stream
};

type MenuState = { open: false } | { open: true; x: number; y: number; widgetKey?: string };

type PlaybackState = {
  mode: "live" | "playback";
  frames: TelemetryFrameV1[];
  rawLines: string[];
  idx: number;
  filename?: string;
  playing: boolean;
  speed: number; // 0.25, 0.5, 1, 2, 4
};

type Alert = {
  id: string;
  level: "info" | "warn" | "crit";
  title: string;
  detail?: string;
  ts: number;
};

type BatteryChem = "LiPo" | "LiIon" | "LiFe";
type BatteryProfile = {
  chem: BatteryChem;
  cells: number; // pack cell count (1S, 2S, 3S, 4S...)
  warnPct: number;
  critPct: number;
};

type ThemeSettings = {
  bgA: string; // shell gradient start
  bgB: string; // shell gradient end
  consoleBg: string; // raw console background
  appBg?: string; // outer app/page background (behind everything) — undefined = default
};


/** ---------- Defaults / presets ----------
 * Palette is sampled from the VX logo: #111112 field, #474747 mark. */
const DEFAULT_THEME: ThemeSettings = { bgA: "#16161a", bgB: "#0d0d0f", consoleBg: "#0b0b0d", appBg: "#111112" };

const THEME_PRESETS: Array<{ name: string; theme: ThemeSettings }> = [
  { name: "Graphite", theme: { bgA: "#16161a", bgB: "#0d0d0f", consoleBg: "#0b0b0d", appBg: "#111112" } },
  { name: "Carbon", theme: { bgA: "#1c1c1f", bgB: "#141416", consoleBg: "#101012", appBg: "#17171a" } },
  { name: "Ink", theme: { bgA: "#0b0b0c", bgB: "#050506", consoleBg: "#000000", appBg: "#0a0a0b" } },
  { name: "Slate", theme: { bgA: "#191b1e", bgB: "#101114", consoleBg: "#0d0e10", appBg: "#141518" } },
];

/** ---------- Battery tables (per-cell) ---------- */
const BATT_TABLES: Record<BatteryChem, Array<{ v: number; p: number }>> = {
  LiPo: [
    { v: 4.2, p: 100 },
    { v: 4.1, p: 90 },
    { v: 4.0, p: 80 },
    { v: 3.92, p: 70 },
    { v: 3.85, p: 60 },
    { v: 3.8, p: 50 },
    { v: 3.75, p: 40 },
    { v: 3.7, p: 30 },
    { v: 3.65, p: 20 },
    { v: 3.6, p: 12 },
    { v: 3.55, p: 6 },
    { v: 3.5, p: 3 },
    { v: 3.45, p: 1 },
    { v: 3.4, p: 0 },
  ],
  LiIon: [
    { v: 4.2, p: 100 },
    { v: 4.1, p: 92 },
    { v: 4.0, p: 84 },
    { v: 3.92, p: 76 },
    { v: 3.85, p: 68 },
    { v: 3.8, p: 60 },
    { v: 3.75, p: 52 },
    { v: 3.7, p: 44 },
    { v: 3.65, p: 36 },
    { v: 3.6, p: 28 },
    { v: 3.55, p: 20 },
    { v: 3.5, p: 12 },
    { v: 3.45, p: 7 },
    { v: 3.4, p: 3 },
    { v: 3.3, p: 0 },
  ],
  LiFe: [
    { v: 3.65, p: 100 },
    { v: 3.5, p: 90 },
    { v: 3.4, p: 80 },
    { v: 3.35, p: 70 },
    { v: 3.32, p: 60 },
    { v: 3.3, p: 50 },
    { v: 3.28, p: 40 },
    { v: 3.26, p: 30 },
    { v: 3.24, p: 20 },
    { v: 3.22, p: 12 },
    { v: 3.2, p: 6 },
    { v: 3.18, p: 3 },
    { v: 3.1, p: 0 },
  ],
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function persist(instances: WidgetInstance[], layout: Layout) {
  localStorage.setItem("vx.instances", JSON.stringify(instances));
  localStorage.setItem("vx.layout", JSON.stringify(layout));
}
function capHas(caps: any, key: string) {
  return !!caps?.has?.(key);
}
function normalizeRequires(req: unknown): string[] {
  if (!req) return [];
  if (Array.isArray(req)) return req.filter(Boolean).map(String);
  return [String(req)];
}

/** Mission-control style voice line for a flight event frame. */
function calloutText(f: TelemetryFrameV1, units: UnitSystem): string {
  const ev = (f.event || "").toUpperCase();
  const alt =
    typeof f.alt_m === "number"
      ? units === "imperial"
        ? `${Math.round(f.alt_m * 3.28084)} feet`
        : `${Math.round(f.alt_m)} meters`
      : "";
  if (ev.includes("ARM")) return "Vehicle armed";
  if (ev.includes("LIFT")) return "Liftoff";
  if (ev.includes("BURN")) return "Burnout";
  if (ev.includes("APOG")) return alt ? `Apogee, ${alt}` : "Apogee";
  if (ev.includes("DROG")) return "Drogue deployed";
  if (ev.includes("MAIN")) return alt ? `Main deployed, ${alt}` : "Main deployed";
  if (ev.includes("LAND")) return "Touchdown. Vehicle safe.";
  return f.event || "";
}

function batteryPercentFromCellV(cellV: number, chem: BatteryChem): number {
  const table = BATT_TABLES[chem].slice().sort((a, b) => b.v - a.v);
  if (!Number.isFinite(cellV)) return NaN;
  if (cellV >= table[0].v) return 100;
  if (cellV <= table[table.length - 1].v) return 0;

  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (cellV <= a.v && cellV >= b.v) {
      const t = (cellV - b.v) / (a.v - b.v);
      return Math.round(lerp(b.p, a.p, t));
    }
  }
  return NaN;
}
function batteryPercentFromPackV(packV: number, profile: BatteryProfile): number {
  if (!Number.isFinite(packV) || profile.cells <= 0) return NaN;
  return batteryPercentFromCellV(packV / profile.cells, profile.chem);
}

function downloadTextFile(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCSV(frames: TelemetryFrameV1[]) {
  const keys: (keyof TelemetryFrameV1)[] = [
    "t_ms",
    "vid",
    "seq",
    "alt_m",
    "vel_mps",
    "batt_v",
    "rssi_dbm",
    "lat",
    "lon",
    "gps_fix",
    "gps_sats",
    "ax",
    "ay",
    "az",
    "gx",
    "gy",
    "gz",
    "q_w",
    "q_x",
    "q_y",
    "q_z",
    "event",
    "pyro_main_cont",
    "pyro_drogue_cont",
  ];
  const header = keys.join(",");
  const rows = frames.map((f) =>
    keys
      .map((k) => {
        const v = (f as any)[k];
        if (v === undefined || v === null) return "";
        if (typeof v === "string") return `"${String(v).replace(/"/g, '""')}"`;
        return String(v);
      })
      .join(",")
  );
  return [header, ...rows].join("\n");
}

function safeHexString(input: unknown, fallback = "#0b1020") {
  if (typeof input !== "string") return fallback;
  const s = input.trim();
  if (!s) return fallback;
  return s;
}

function hexToRgb(hexInput: unknown): { r: number; g: number; b: number } | null {
  const hex = safeHexString(hexInput, "");
  if (!hex) return null;

  // accept: "#RRGGBB", "RRGGBB", "#RGB", "RGB"
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return null;

  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }

  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Darken a hex color toward black by `amount` (0–1) — used to derive the
    bottom stop of the app background gradient from a single user-picked color. */
function darkenHex(hexInput: unknown, amount: number): string {
  const rgb = hexToRgb(hexInput);
  if (!rgb) return "#04060c";
  const f = 1 - amount;
  const to2 = (v: number) => Math.round(Math.max(0, Math.min(255, v)) * f).toString(16).padStart(2, "0");
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
}

function relativeLuminance(hexInput: unknown): number {
  const rgb = hexToRgb(hexInput);
  if (!rgb) return 0; // treat invalid as dark
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => v / 255);
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}


function autoTextColor(bgHex: unknown): "#0b1020" | "#ffffff" {
  // threshold tuned for UI readability
  const L = relativeLuminance(bgHex);
  return L > 0.42 ? "#0b1020" : "#ffffff";
}

type DerivedEvent = {
  id: "ARMED" | "LIFTOFF" | "BURNOUT" | "APOGEE" | "DROGUE" | "MAIN" | "LANDING" | "CUSTOM";
  label: string;
  idx: number;
  t_ms: number;
};

const GRID_COLS = 12;
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

// Wrap GridLayout to avoid type errors in some TS setups
const RGL: any = GridLayout;

/** ---------- Header helpers ---------- */
const M_TO_FT = 3.280839895;

function fmtUnit(
  v: number | undefined,
  system: UnitSystem,
  kind: "alt" | "vel"
): { value: string; unit: string } {
  const unit =
    kind === "alt" ? (system === "imperial" ? "ft" : "m") : system === "imperial" ? "ft/s" : "m/s";
  if (typeof v !== "number" || !Number.isFinite(v)) return { value: "—", unit };
  if (kind === "alt") {
    return system === "imperial" ? { value: (v * M_TO_FT).toFixed(0), unit } : { value: v.toFixed(0), unit };
  }
  return system === "imperial" ? { value: (v * M_TO_FT).toFixed(0), unit } : { value: v.toFixed(1), unit };
}

function Readout(props: { k: string; v: { value: string; unit: string }; peak?: boolean }) {
  return (
    <div className={`vx-readout ${props.peak ? "peak" : ""}`}>
      <span className="k">{props.k}</span>
      <span className="v">
        {props.v.value}
        {props.v.unit ? <small>{props.v.unit}</small> : null}
      </span>
    </div>
  );
}

function MissionLogo() {
  // Renders the user-supplied official logo file (public/vx-logo.png) so the
  // header and the OS-level app icon/favicon are the exact same artwork.
  return (
    <img
      src="/vx-logo.png"
      alt="VX Rocketry"
      width={44}
      height={44}
      style={{ display: "block", objectFit: "contain", flex: "0 0 auto" }}
    />
  );
}

/**
 * Mission Model — a live launch-profile view.
 *
 * The vehicle is drawn rising from the pad coordinates (the GPS origin latched
 * at first fix, or the Sim Setup pad), positioned by real telemetry: altitude
 * on the vertical axis, GPS downrange on the horizontal. The vehicle points
 * along its own trajectory, so it noses over at apogee and comes down the way
 * a real one does — driven by the flight path, not a clamped tilt angle.
 *
 * If the user has captured a 2D side profile of their CAD (Vehicle setup), it's
 * used as the vehicle marker; otherwise a generic rocket glyph is drawn.
 *
 * Deliberately SVG rather than three.js: this panel is always on screen, and
 * the 3D CAD viewer is a ~950 KB lazy chunk.
 */

/** Simple centered moving average — kills GPS jitter in the downrange track
    without lagging the path noticeably at these sample rates. */
function smoothSeries(vals: number[], half = 2): number[] {
  if (vals.length < 3) return vals.slice();
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    let sum = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < vals.length) { sum += vals[j]; n++; }
    }
    out.push(sum / n);
  }
  return out;
}

function MissionModel(props: {
  events: DerivedEvent[];
  frames: TelemetryFrameV1[];
  latest?: TelemetryFrameV1;
  currentTms: number;
  phase: string;
  onJump: (id: DerivedEvent["id"]) => void;
}) {
  const { events, frames, latest } = props;
  const t0base = events.find((e) => e.id === "LIFTOFF")?.t_ms;

  const pad = getPadOrigin();

  // Captured CAD side profile (data URL) + aspect ratio, refreshed live.
  const [sideImg, setSideImg] = useState<{ url: string; ar: number } | null>(() => readSideProfile());
  useEffect(() => {
    const h = () => setSideImg(readSideProfile());
    window.addEventListener(VEHICLE_CHANGED_EVENT, h);
    return () => window.removeEventListener(VEHICLE_CHANGED_EVENT, h);
  }, []);

  /** Local-tangent-plane offset (meters east/north) of a fix from the pad. */
  const offsetM = (lat: number, lon: number) => {
    if (!pad) return { e: 0, n: 0 };
    const mPerDegLat = 111_320;
    return {
      e: (lon - pad.lon) * mPerDegLat * Math.cos((pad.lat * Math.PI) / 180),
      n: (lat - pad.lat) * mPerDegLat,
    };
  };

  /** Raw trajectory in (downrange, altitude) meters. Downrange is signed by the
      east component so the vehicle leans the way the wind actually pushes it. */
  const raw = frames
    .filter((f) => typeof f.alt_m === "number")
    .map((f) => {
      let downrange = 0;
      if (pad && typeof f.lat === "number" && typeof f.lon === "number") {
        const { e, n } = offsetM(f.lat, f.lon);
        downrange = Math.sign(e || 1) * Math.hypot(e, n);
      }
      return { x: downrange, y: f.alt_m as number, t: f.t_ms };
    });

  // Smooth the GPS-derived downrange (and lightly the baro altitude) so the
  // path reads as a clean arc instead of a jitter squiggle.
  const smX = smoothSeries(raw.map((p) => p.x), 3);
  const smY = smoothSeries(raw.map((p) => p.y), 1);
  const track = raw.map((p, i) => ({ x: smX[i], y: smY[i], t: p.t }));

  const altM = typeof latest?.alt_m === "number" ? latest.alt_m : 0;
  const tilt = tiltDegFromQuat(latest?.q_w, latest?.q_x, latest?.q_y, latest?.q_z);

  let downrangeM = 0;
  if (pad && typeof latest?.lat === "number" && typeof latest?.lon === "number") {
    const { e, n } = offsetM(latest.lat, latest.lon);
    downrangeM = Math.hypot(e, n);
  }

  // Auto-fit: keep the pad on screen and give the vehicle headroom.
  const maxAlt = Math.max(100, ...track.map((p) => p.y));
  const maxAbsX = Math.max(60, ...track.map((p) => Math.abs(p.x)));
  const VB_W = 1000;
  const VB_H = 260;
  const GROUND_Y = VB_H - 34;
  const TOP_Y = 18;

  const sx = (xm: number) => VB_W / 2 + (xm / (maxAbsX * 1.25)) * (VB_W / 2 - 40);
  const sy = (ym: number) => GROUND_Y - (ym / (maxAlt * 1.15)) * (GROUND_Y - TOP_Y);

  const poly = track.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const last = track.length ? track[track.length - 1] : { x: 0, y: 0, t: 0 };
  const cur = { x: sx(last.x), y: sy(altM) };

  /* Heading — point the vehicle along its own path (screen space), so it noses
     over at apogee and descends correctly. Uses a short look-back for a stable
     vector; falls back to nose-up on the pad or when barely moving. Vertical
     velocity sign disambiguates straight-up vs straight-down. */
  let headingDeg = 0;
  if (track.length >= 2) {
    const n = track.length;
    const back = track[Math.max(0, n - 6)];
    const dxs = sx(last.x) - sx(back.x);
    const dys = sy(last.y) - sy(back.y);
    const speed = Math.hypot(dxs, dys);
    const vel = typeof latest?.vel_mps === "number" ? latest.vel_mps : (last.y - back.y);
    if (speed > 2) {
      headingDeg = (Math.atan2(dxs, -dys) * 180) / Math.PI;
    } else if (vel < -0.5) {
      headingDeg = 180; // descending slowly / under chute — nose down
    }
  }

  const relLabel = (t: number) => {
    if (t0base === undefined) return "";
    const s = (t - t0base) / 1000;
    return `T${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(0)}s`;
  };

  const apogee = events.find((e) => e.id === "APOGEE");
  const apogeePt = apogee ? track.find((p) => p.t >= apogee.t_ms) : undefined;

  // Vehicle glyph size (viewBox units). Image height fixed; width by aspect.
  const IMG_H = 30;
  const IMG_W = sideImg ? Math.max(6, IMG_H * sideImg.ar) : 0;

  return (
    <div className="vx-model">
      <div className="vx-model-head">
        <div className="vx-label">Mission Model</div>
        <div className="vx-model-stats">
          <ModelStat label="ALT" value={`${altM.toFixed(0)} m`} />
          <ModelStat label="DOWNRANGE" value={pad ? `${downrangeM.toFixed(0)} m` : "—"} />
          <ModelStat label="TILT" value={tilt !== null ? `${tilt.toFixed(1)}°` : "—"} />
          <ModelStat label="PHASE" value={props.phase} />
        </div>
      </div>

      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="vx-model-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live launch profile">
        <line x1="0" y1={GROUND_Y} x2={VB_W} y2={GROUND_Y} stroke="var(--vx-line-strong)" strokeWidth="1" />
        <line x1={VB_W / 2} y1={TOP_Y} x2={VB_W / 2} y2={GROUND_Y} stroke="var(--vx-line)" strokeWidth="0.6" strokeDasharray="3 5" />

        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1="0" y1={sy(maxAlt * f)} x2={VB_W} y2={sy(maxAlt * f)} stroke="var(--vx-grid)" strokeWidth="0.6" />
            <text x="6" y={sy(maxAlt * f) - 3} fontSize="9" fill="var(--vx-fg-faint)" fontFamily="var(--vx-font-mono)">
              {Math.round(maxAlt * f)} m
            </text>
          </g>
        ))}

        {/* Pad */}
        <rect x={VB_W / 2 - 12} y={GROUND_Y - 3} width="24" height="3" fill="var(--vx-mark-lift)" />
        <text x={VB_W / 2} y={GROUND_Y + 14} fontSize="9" textAnchor="middle" fill="var(--vx-fg-faint)" fontFamily="var(--vx-font-mono)">
          {pad ? `${pad.lat.toFixed(5)}, ${pad.lon.toFixed(5)}` : "PAD — awaiting GPS fix"}
        </text>

        {track.length > 1 && <polyline points={poly} fill="none" stroke="var(--vx-accent)" strokeWidth="1.4" opacity="0.75" strokeLinejoin="round" strokeLinecap="round" />}

        {apogeePt && (
          <g>
            <circle cx={sx(apogeePt.x)} cy={sy(apogeePt.y)} r="3" fill="none" stroke="var(--vx-caution)" strokeWidth="1.2" />
            <text x={sx(apogeePt.x) + 7} y={sy(apogeePt.y) - 5} fontSize="9" fill="var(--vx-caution)" fontFamily="var(--vx-font-mono)">
              APOGEE {apogeePt.y.toFixed(0)} m
            </text>
          </g>
        )}

        {/* Vehicle — points along its trajectory (nose over at apogee) */}
        <g transform={`translate(${cur.x} ${cur.y}) rotate(${headingDeg})`}>
          {sideImg ? (
            <image
              href={sideImg.url}
              x={-IMG_W / 2}
              y={-IMG_H / 2}
              width={IMG_W}
              height={IMG_H}
              preserveAspectRatio="xMidYMid meet"
            />
          ) : (
            <>
              <polygon points="0,-11 3.4,-3 3.4,7 -3.4,7 -3.4,-3" fill="var(--vx-accent-bright)" />
              <polygon points="-3.4,7 -6.6,11 -3.4,2" fill="var(--vx-mark-lift)" />
              <polygon points="3.4,7 6.6,11 3.4,2" fill="var(--vx-mark-lift)" />
              {props.phase === "BOOST" && <polygon points="-2.4,8 2.4,8 0,19" fill="var(--vx-caution)" opacity="0.9" />}
            </>
          )}
        </g>
      </svg>

      {events.length > 0 && (
        <div className="vx-model-rail">
          {events.map((e) => {
            const reached = e.t_ms <= props.currentTms;
            return (
              <button
                key={e.id}
                className={`vx-model-ev ${reached ? "reached" : ""}`}
                onClick={() => props.onJump(e.id)}
                title={`${e.label} — jump to event`}
              >
                {e.id} <span className="vx-model-ev-t">{relLabel(e.t_ms)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Read the captured CAD side profile from localStorage (url + aspect ratio). */
function readSideProfile(): { url: string; ar: number } | null {
  try {
    const url = localStorage.getItem("vx.vehicleSideImage");
    if (!url) return null;
    const ar = Number(localStorage.getItem("vx.vehicleSideImageAR")) || 0.4;
    return { url, ar };
  } catch {
    return null;
  }
}

/**
 * Mission Timeline — the simple bar variant. A single horizontal rail with
 * event ticks; no trajectory. Chosen in Settings for users who want the
 * classic compact strip instead of the launch-profile model.
 */
function MissionTimelineBar(props: {
  events: DerivedEvent[];
  currentTms: number;
  onJump: (id: DerivedEvent["id"]) => void;
}) {
  const { events } = props;
  const t0base = events.find((e) => e.id === "LIFTOFF")?.t_ms;

  if (!events.length) {
    return (
      <div className="vx-timeline">
        <div className="vx-label" style={{ position: "absolute", top: 8, left: 16 }}>Mission Timeline</div>
        <div style={{ textAlign: "center", color: "var(--vx-fg-faint)", fontSize: 12, letterSpacing: "0.14em" }}>AWAITING LIFTOFF</div>
      </div>
    );
  }

  const ts = events.map((e) => e.t_ms);
  const tStart = Math.min(...ts, props.currentTms);
  const tEnd = Math.max(...ts, props.currentTms);
  const span = tEnd - tStart || 1;
  const pos = (t: number) => Math.max(0, Math.min(100, ((t - tStart) / span) * 100));
  const nowPct = pos(props.currentTms);

  const relLabel = (t: number) => {
    if (t0base === undefined) return "";
    const s = (t - t0base) / 1000;
    return `T${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(0)}s`;
  };

  return (
    <div className="vx-timeline">
      <div className="vx-label" style={{ position: "absolute", top: 8, left: 16 }}>Mission Timeline</div>
      <div className="vx-timeline-rail">
        <div className="vx-timeline-fill" style={{ width: `${nowPct}%` }} />
        <div className="vx-timeline-now" style={{ left: `${nowPct}%` }} />
        {events.map((e, i) => {
          const reached = e.t_ms <= props.currentTms;
          const above = i % 2 === 0;
          return (
            <button
              key={e.id}
              className={`vx-tl-event ${reached ? "reached" : ""}`}
              style={{ left: `${pos(e.t_ms)}%`, top: -4 }}
              onClick={() => props.onJump(e.id)}
              title={`${e.label} — jump to event`}
            >
              <span className="vx-tl-tick" />
              <span className={`vx-tl-lbl ${above ? "above" : "below"}`}>
                {e.id} <span className="vx-tl-time">{relLabel(e.t_ms)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelStat(props: { label: string; value: string }) {
  return (
    <div className="vx-model-stat">
      <span className="vx-label" style={{ fontSize: 9 }}>{props.label}</span>
      <span className="vx-num" style={{ fontSize: 13, color: "var(--vx-fg)" }}>{props.value}</span>
    </div>
  );
}

export default function App() {
  /** Transport */
  const [transportKind, setTransportKind] = useState<"simulator" | "serial">("simulator");
  const [nativePorts, setNativePorts] = useState<string[]>([]);
  const [nativePort, setNativePort] = useState("");
  async function refreshNativePorts() {
    try {
      const ports = await listNativePorts();
      setNativePorts(ports);
      if (!nativePort && ports[0]) setNativePort(ports[0]);
    } catch {
      setNativePorts([]);
    }
  }
  const [baudRate, setBaudRate] = useState(115200);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("disconnected");
  const connectionRef = useRef<Connection | null>(null);
  const connectionCleanupRef = useRef<(() => void) | null>(null);

  /** Live telemetry — external store, ticks independent of ingest rate */
  const telemetry = useSyncExternalStore(liveStore.subscribe, liveStore.getState);

  /** Display Freeze */
  const [frozen, setFrozen] = useState(false);
  const [freezeIdx, setFreezeIdx] = useState<number | null>(null);

  /** Playback */
  const [playback, setPlayback] = useState<PlaybackState>({
    mode: "live",
    frames: [],
    rawLines: [],
    idx: 0,
    filename: undefined,
    playing: false,
    speed: 1,
  });

  /** Flight Mode / Layout Lock */
  const [flightMode, setFlightMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("vx.flightMode") === "1";
    } catch {
      return false;
    }
  });
  function setFlightModePersist(next: boolean) {
    setFlightMode(next);
    localStorage.setItem("vx.flightMode", next ? "1" : "0");
  }

  /** Global units (moved to Settings UI) */
  const [globalUnits, setGlobalUnits] = useState<UnitSystem>(() => {
    const saved = localStorage.getItem("vx.units");
    return saved === "imperial" || saved === "metric" ? (saved as UnitSystem) : "metric";
  });
  function saveGlobalUnits(next: UnitSystem) {
    setGlobalUnits(next);
    localStorage.setItem("vx.units", next);
  }

  /** Battery profile */
  const [battProfile, setBattProfile] = useState<BatteryProfile>(() => {
    try {
      const saved = localStorage.getItem("vx.battProfile");
      return saved ? (JSON.parse(saved) as BatteryProfile) : { chem: "LiPo", cells: 1, warnPct: 20, critPct: 10 };
    } catch {
      return { chem: "LiPo", cells: 1, warnPct: 20, critPct: 10 };
    }
  });
  function saveBattProfile(patch: Partial<BatteryProfile>) {
    setBattProfile((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem("vx.battProfile", JSON.stringify(next));
      return next;
    });
  }

  /** Theme settings */
  const [theme, setTheme] = useState<ThemeSettings>(() => {
    try {
      const saved = localStorage.getItem("vx.theme");
      return saved ? (JSON.parse(saved) as ThemeSettings) : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });
  function saveTheme(patch: Partial<ThemeSettings>) {
    setTheme((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem("vx.theme", JSON.stringify(next));
      return next;
    });
  }
  function resetTheme() {
    setTheme(DEFAULT_THEME);
    localStorage.setItem("vx.theme", JSON.stringify(DEFAULT_THEME));
  }

  // Outer app background (behind the whole console, not just the dashboard
  // shell) — a single user-picked color, with a darker auto-derived bottom
  // stop so it keeps the same subtle vertical gradient feel.
  useEffect(() => {
    const root = document.documentElement.style;
    if (theme.appBg) {
      root.setProperty("--vx-app-bg-top", theme.appBg);
      root.setProperty("--vx-app-bg-bottom", darkenHex(theme.appBg, 0.45));
    } else {
      root.removeProperty("--vx-app-bg-top");
      root.removeProperty("--vx-app-bg-bottom");
    }
  }, [theme.appBg]);

  /** Vehicle (3D model + flight config) modal */
  const [vehicleOpen, setVehicleOpen] = useState(false);

  /** Field remapping modal */
  const [fieldMapOpen, setFieldMapOpen] = useState(false);

  /** Radio config panel */
  const [radioOpen, setRadioOpen] = useState(false);

  /** Flight-sim setup (rocket / motor / recovery / day) */
  const [simSetupOpen, setSimSetupOpen] = useState(false);


  /** Flight comparison overlay: a reference flight drawn as a dim dashed
      trace on every plot, liftoff-aligned to the current flight. */
  const [ghostFlight, setGhostFlight] = useState<{ name: string; frames: TelemetryFrameV1[] } | null>(null);
  function extractLiftoffTms(frames: TelemetryFrameV1[]): number | null {
    for (const f of frames) {
      if (typeof f.event === "string" && f.event.toUpperCase().includes("LIFT")) return f.t_ms;
    }
    return null;
  }

  /** Custom alert rules */
  const [alertRulesOpen, setAlertRulesOpen] = useState(false);
  const [alertRules, setAlertRules] = useState<AlertRule[]>(() => loadAlertRules());
  function updateAlertRules(next: AlertRule[]) {
    setAlertRules(next);
    saveAlertRules(next);
  }

  /** Layout presets */
  type LayoutPreset = { name: string; instances: WidgetInstance[]; layout: Layout; widgetSettings: Record<string, WidgetSettings> };
  const [layoutPresets, setLayoutPresets] = useState<LayoutPreset[]>(() => loadJSON<LayoutPreset[]>("vx.layoutPresets", []));
  const [selectedPreset, setSelectedPreset] = useState("");
  function persistPresets(next: LayoutPreset[]) {
    setLayoutPresets(next);
    localStorage.setItem("vx.layoutPresets", JSON.stringify(next));
  }
  function saveCurrentAsPreset() {
    const name = window.prompt("Preset name (e.g. Pad, Flight, Recovery):", selectedPreset || "");
    if (!name?.trim()) return;
    const preset: LayoutPreset = { name: name.trim(), instances, layout, widgetSettings };
    persistPresets([...layoutPresets.filter((p) => p.name !== preset.name), preset]);
    setSelectedPreset(preset.name);
  }
  function applyPreset(name: string) {
    const p = layoutPresets.find((x) => x.name === name);
    if (!p) return;
    setSelectedPreset(name);
    setInstances(p.instances);
    setLayout(p.layout);
    setWidgetSettings(p.widgetSettings);
    persist(p.instances, p.layout);
    localStorage.setItem("vx.widgetSettings", JSON.stringify(p.widgetSettings));
  }
  function deleteSelectedPreset() {
    if (!selectedPreset) return;
    if (!window.confirm(`Delete layout preset "${selectedPreset}"?`)) return;
    persistPresets(layoutPresets.filter((p) => p.name !== selectedPreset));
    setSelectedPreset("");
  }

  /** Voice callouts */
  const [voiceOn, setVoiceOn] = useState<boolean>(() => {
    try { return localStorage.getItem("vx.voice") !== "0"; } catch { return true; }
  });

  /** Field mode: maximum-contrast display for direct sunlight. */
  const [fieldMode, setFieldMode] = useState<boolean>(() => {
    try { return localStorage.getItem("vx.fieldContrast") === "1"; } catch { return false; }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("vx-field", fieldMode);
  }, [fieldMode]);
  function toggleFieldMode() {
    setFieldMode((v) => {
      const next = !v;
      localStorage.setItem("vx.fieldContrast", next ? "1" : "0");
      return next;
    });
  }

  /** Whole-console zoom (like browser zoom) — sizes every panel at once. */
  const [uiZoom, setUiZoom] = useState<number>(() => {
    const z = Number(localStorage.getItem("vx.uiZoom"));
    return Number.isFinite(z) && z >= 0.5 && z <= 1.6 ? z : 1;
  });
  useEffect(() => {
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(uiZoom);
  }, [uiZoom]);
  function adjustZoom(delta: number) {
    setUiZoom((z) => {
      const next = Math.round(Math.min(1.4, Math.max(0.6, z + delta)) * 100) / 100;
      localStorage.setItem("vx.uiZoom", String(next));
      return next;
    });
  }
  function resetZoom() {
    setUiZoom(1);
    localStorage.setItem("vx.uiZoom", "1");
  }
  function toggleVoice() {
    setVoiceOn((v) => {
      const next = !v;
      localStorage.setItem("vx.voice", next ? "1" : "0");
      return next;
    });
  }

  /** Countdown clock (T− with holds). Hands off to T+ at the LIFTOFF event. */
  type Countdown = { mode: "idle" } | { mode: "running"; t0Epoch: number } | { mode: "hold"; remainingMs: number };
  const [countdown, setCountdown] = useState<Countdown>({ mode: "idle" });
  const [, setClockTick] = useState(0); // re-render while the countdown runs
  const lastCalloutSecRef = useRef<number | null>(null);
  useEffect(() => {
    if (countdown.mode !== "running") return;
    const t = window.setInterval(() => {
      setClockTick((x) => x + 1);
      // Range-style voice callouts on the way down.
      const remS = Math.ceil((countdown.t0Epoch - Date.now()) / 1000);
      if (voiceOn && remS !== lastCalloutSecRef.current) {
        lastCalloutSecRef.current = remS;
        if (remS === 60 || remS === 30) speak(`T minus ${remS} seconds`);
        else if (remS === 10) speak("T minus 10");
        else if (remS >= 1 && remS <= 5) speak(String(remS));
        else if (remS === 0) speak("T zero");
      }
    }, 250);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, voiceOn]);

  function countdownRemainingMs(): number | null {
    if (countdown.mode === "running") return countdown.t0Epoch - Date.now();
    if (countdown.mode === "hold") return countdown.remainingMs;
    return null;
  }
  function startCountdown() {
    const raw = window.prompt("Countdown duration (minutes, e.g. 5 or 2.5):", "5");
    if (!raw) return;
    const mins = Number(raw);
    if (!Number.isFinite(mins) || mins <= 0) return;
    lastCalloutSecRef.current = null;
    setCountdown({ mode: "running", t0Epoch: Date.now() + mins * 60_000 });
  }
  function holdOrResumeCountdown() {
    if (countdown.mode === "running") {
      setCountdown({ mode: "hold", remainingMs: Math.max(0, countdown.t0Epoch - Date.now()) });
      if (voiceOn) speak("Hold hold hold");
    } else if (countdown.mode === "hold") {
      setCountdown({ mode: "running", t0Epoch: Date.now() + countdown.remainingMs });
      if (voiceOn) speak("Count resumed");
    }
  }
  function clearCountdown() {
    setCountdown({ mode: "idle" });
  }

  /** Grid width — measured from the shell so the layout spans the full viewport */
  const gridHostRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(1200);
  useEffect(() => {
    const el = gridHostRef.current;
    if (!el) return;
    const measure = () => setGridWidth(Math.max(480, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Crash-safe recording: checkpoint the live session every 5 s while
      connected, and recover any orphaned checkpoint from a previous crash. */
  const lastCheckpointCountRef = useRef(0);
  useEffect(() => {
    recoverLiveFlight()
      .then((m) => {
        if (m) pushAlert({ id: "recovered-flight", level: "info", title: "Flight recovered", detail: `${m.name} restored to the Flight Log after an unclean shutdown` });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A #flight=… share link opens straight into playback.
  useEffect(() => {
    if (!location.hash.includes("flight=")) return;
    decodeShareLink(location.hash)
      .then((sf) => {
        if (sf && sf.pts.length) {
          loadSharedFlight(sf);
          pushAlert({ id: "shared-flight", level: "info", title: "Shared flight loaded", detail: `${sf.name} — playing back from a shared link` });
        }
        history.replaceState(null, "", location.pathname + location.search);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (connStatus !== "connected") return;
    lastCheckpointCountRef.current = 0;
    const t = window.setInterval(() => {
      const lines = logLinesRef.current;
      if (lines.length > lastCheckpointCountRef.current) {
        lastCheckpointCountRef.current = lines.length;
        checkpointLiveFlight(sessionStartRef.current, lines.slice()).catch(() => {});
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, [connStatus]);

  /** Don't let an accidental tab close end a live session silently. */
  useEffect(() => {
    if (connStatus !== "connected") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // required for the browser confirm dialog
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [connStatus]);

  const fg = useMemo(() => autoTextColor(theme.bgB), [theme.bgB]);
  const chipFg = useMemo(() => autoTextColor("#1b2339"), []); // stable

  /** Per-widget settings */
  const [widgetSettings, setWidgetSettings] = useState<Record<string, WidgetSettings>>(() => {
    try {
      return JSON.parse(localStorage.getItem("vx.widgetSettings") || "{}");
    } catch {
      return {};
    }
  });
  function saveWidgetSettings(instKey: string, patch: WidgetSettings) {
    setWidgetSettings((prev) => {
      const next = { ...prev, [instKey]: { ...(prev[instKey] || {}), ...patch } };
      localStorage.setItem("vx.widgetSettings", JSON.stringify(next));
      return next;
    });
  }
  function resetWidgetAccent(instKey: string) {
    setWidgetSettings((prev) => {
      const next = { ...prev, [instKey]: { ...(prev[instKey] || {}) } };
      delete next[instKey].accent;
      localStorage.setItem("vx.widgetSettings", JSON.stringify(next));
      return next;
    });
  }

  /** Grid state */
  const [instances, setInstances] = useState<WidgetInstance[]>(() =>
    loadJSON<WidgetInstance[]>("vx.instances", [{ key: "raw-1", widgetId: "raw.console" }])
  );
  const [layout, setLayout] = useState<Layout>(() =>
    loadJSON<Layout>("vx.layout", [{ i: "raw-1", x: 0, y: 0, w: 12, h: 14 } as any])
  );

  /** Right-click context menu + advanced modal */
  const [menu, setMenu] = useState<MenuState>({ open: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /** Settings modal */
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** Export modal — one entry point, asks which file format to write. */
  const [exportOpen, setExportOpen] = useState(false);

  /** Active device profile (data-format parser). Restored from storage once. */
  const [deviceProfile, setDeviceProfileState] = useState<string>(() => loadDeviceProfile());

  /** Share dialog data (an archived flight prepped for HTML/link sharing). */
  const [shareData, setShareData] = useState<ShareFlight | null>(null);

  /** Mission overview: full launch-profile model, or the simple bar timeline. */
  const [missionView, setMissionView] = useState<"model" | "timeline">(() => {
    return localStorage.getItem("vx.missionView") === "timeline" ? "timeline" : "model";
  });
  function saveMissionView(v: "model" | "timeline") {
    setMissionView(v);
    localStorage.setItem("vx.missionView", v);
  }

  /** User's own docs/learning site — used for every widget's "Learn more" link.
      Left blank by default; the owner pastes their teaching site in Settings. */
  const [docsUrl, setDocsUrl] = useState<string>(() => localStorage.getItem("vx.docsUrl") ?? "");
  function saveDocsUrl(u: string) {
    setDocsUrl(u);
    localStorage.setItem("vx.docsUrl", u);
  }

  /** Widget help modal — shows connection/troubleshooting/about for one widget. */
  const [helpWidget, setHelpWidget] = useState<WidgetId | null>(null);

  /** First-run onboarding / template picker. Auto-opens only on a truly fresh
      install (no prior layout), so returning users are never interrupted. */
  const [onboardOpen, setOnboardOpen] = useState<boolean>(
    () => !localStorage.getItem("vx.onboarded") && !localStorage.getItem("vx.instances")
  );
  function applyTemplate(t: DashTemplate) {
    const { instances: ins, layout: lay } = templateLayout(t.widgets);
    setInstances(ins);
    setLayout(lay);
    setWidgetSettings({});
    persist(ins, lay);
    localStorage.setItem("vx.widgetSettings", "{}");
    localStorage.setItem("vx.onboarded", "1");
    setSelectedPreset("");
    setOnboardOpen(false);
  }
  function dismissOnboarding() {
    localStorage.setItem("vx.onboarded", "1");
    setOnboardOpen(false);
  }

  /** Flight log */
  const [flightLogOpen, setFlightLogOpen] = useState(false);
  const [flights, setFlights] = useState<FlightMeta[]>([]);

  /** Master caution / alarm */
  const [alarmMuted, setAlarmMuted] = useState<boolean>(() => {
    try { return localStorage.getItem("vx.alarmMuted") === "1"; } catch { return false; }
  });
  const [ackedSig, setAckedSig] = useState("");
  function toggleAlarmMute() {
    setAlarmMuted((m) => {
      const next = !m;
      localStorage.setItem("vx.alarmMuted", next ? "1" : "0");
      return next;
    });
  }

  /** Command Palette */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /** Alerts */
  const [alerts, setAlerts] = useState<Alert[]>([]);
  function pushAlert(a: Omit<Alert, "ts">) {
    setAlerts((prev) => {
      const now = Date.now();
      const next: Alert = { ...a, ts: now };
      const filtered = prev.filter((x) => x.id !== a.id);
      return [next, ...filtered].slice(0, 6);
    });
  }
  function clearAlert(id: string) {
    setAlerts((prev) => prev.filter((x) => x.id !== id));
  }

  /** Logging buffer (renderer-only) */
  const sessionStartRef = useRef<number>(Date.now());
  const logLinesRef = useRef<string[]>([]);
  const [logCount, setLogCount] = useState(0);

  /** Link/health tracking */
  const lastLineAtRef = useRef<number>(0);
  const lastFrameAtRef = useRef<number>(0);
  const dtMsWindowRef = useRef<number[]>([]);
  const [linkHealthTick, setLinkHealthTick] = useState(0);

  /** Disconnect any live connection on unmount */
  useEffect(() => {
    return () => {
      connectionRef.current?.disconnect();
      connectionCleanupRef.current?.();
    };
  }, []);

  /** Load persisted flight log once on mount */
  useEffect(() => {
    refreshFlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ---------- Multi-vehicle streams ---------- */
  // Distinct vehicle ids seen in the current source (one radio can carry
  // several transmitters: booster + sustainer trackers, multiple rockets).
  const sourceFrames = playback.mode === "playback" ? playback.frames : telemetry.frames;
  const seenVids = useMemo(() => {
    const s = new Set<string>();
    for (const f of sourceFrames) {
      if (f.vid !== undefined) s.add(String(f.vid));
    }
    return Array.from(s);
  }, [sourceFrames]);

  const [vehicleFilter, setVehicleFilter] = useState<string | null>(null);
  // Auto-select the first vehicle when a second stream appears (mixed plots
  // are meaningless), and drop a stale selection.
  useEffect(() => {
    if (!vehicleFilter && seenVids.length >= 2) setVehicleFilter(seenVids[0]);
    else if (vehicleFilter && seenVids.length && !seenVids.includes(vehicleFilter)) setVehicleFilter(null);
  }, [seenVids, vehicleFilter]);

  // Frames without a vid are shared/system data — visible under any selection.
  const matchVid = (f: TelemetryFrameV1) =>
    !vehicleFilter || f.vid === undefined || String(f.vid) === vehicleFilter;

  /** Determine frames/latest to DISPLAY */
  const display = useMemo(() => {
    if (playback.mode === "playback") {
      const all = playback.frames;
      const idxAll = clamp(playback.idx, 0, Math.max(0, all.length - 1));
      // Scrubber index addresses the full stream; show the filtered set up to it.
      const frames = (vehicleFilter ? all.filter(matchVid) : all);
      const upTo = all[idxAll]?.t_ms ?? 0;
      let idx = frames.length - 1;
      while (idx > 0 && frames[idx].t_ms > upTo) idx--;
      const latest = frames[idx];
      return {
        mode: "playback" as const,
        frames,
        rawLines: playback.rawLines,
        latest,
        idx,
        n: frames.length,
        t_ms: latest?.t_ms ?? 0,
      };
    }

    const frames = vehicleFilter ? (telemetry.frames ?? []).filter(matchVid) : (telemetry.frames ?? []);
    const latest = frames.length ? frames[frames.length - 1] : undefined;

    if (!frames.length) {
      return { mode: "live" as const, frames, rawLines: telemetry.rawLines ?? [], latest, idx: -1, n: 0, t_ms: 0 };
    }

    if (frozen) {
      const idx = freezeIdx ?? frames.length - 1;
      const clamped = clamp(idx, 0, frames.length - 1);
      return {
        mode: "live" as const,
        frames,
        rawLines: telemetry.rawLines ?? [],
        latest: frames[clamped],
        idx: clamped,
        n: frames.length,
        t_ms: frames[clamped]?.t_ms ?? 0,
      };
    }

    return {
      mode: "live" as const,
      frames,
      rawLines: telemetry.rawLines ?? [],
      latest,
      idx: frames.length - 1,
      n: frames.length,
      t_ms: latest?.t_ms ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, telemetry, frozen, freezeIdx, vehicleFilter]);

  const caps = useMemo(() => deriveCapabilities(display.latest), [display.latest]);

  /** Transport actions */
  async function connect() {
    if (connStatus !== "disconnected") return;
    if (transportKind === "serial" && !isTauri() && !isWebSerialSupported()) {
      window.alert("Web Serial API not supported in this browser. Use Chrome or Edge, the desktop app, or the Simulator.");
      return;
    }

    sessionStartRef.current = Date.now();
    logLinesRef.current = [];
    setLogCount(0);

    lastLineAtRef.current = performance.now();
    lastFrameAtRef.current = 0;
    dtMsWindowRef.current = [];
    lastCalloutTRef.current = -1;
    setVehicleFilter(null);

    liveStore.reset();

    const conn: Connection =
      transportKind === "simulator"
        ? new SimulatorConnection()
        : isTauri()
          ? new TauriSerialConnection() // native serial in the desktop app
          : new WebSerialConnection();

    const offLine = conn.onLine((line: string) => {
      logLinesRef.current.push(line);
      if (logLinesRef.current.length > 200000) logLinesRef.current = logLinesRef.current.slice(-200000);
      setLogCount(logLinesRef.current.length);

      lastLineAtRef.current = performance.now();

      const now = performance.now();
      const prevT = lastFrameAtRef.current;
      if (prevT > 0) {
        const dt = now - prevT;
        dtMsWindowRef.current.push(dt);
        if (dtMsWindowRef.current.length > 120) dtMsWindowRef.current.shift();
      }
      lastFrameAtRef.current = now;
      if (Math.random() < 0.08) setLinkHealthTick((x) => x + 1);

      liveStore.ingest(line);
    });

    const offStatus = conn.onStatusChange((status) => {
      setConnStatus(status);
      liveStore.setConnected(status === "connected");
    });

    connectionRef.current = conn;
    connectionCleanupRef.current = () => {
      offLine();
      offStatus();
    };

    try {
      await conn.connect({ baudRate, path: nativePort || undefined });
    } catch (err) {
      console.error("[connect] failed", err);
      connectionCleanupRef.current?.();
      connectionCleanupRef.current = null;
      connectionRef.current = null;
    }
  }

  async function disconnect() {
    await connectionRef.current?.disconnect();
    connectionCleanupRef.current?.();
    connectionCleanupRef.current = null;
    connectionRef.current = null;
    liveStore.setConnected(false);
    // Auto-archive the just-completed session to the persistent flight log.
    await saveCurrentFlight();
  }

  /** Widget ops */
  function addWidget(widgetId: WidgetId, w?: number, h?: number): string | null {
    if (flightMode) return null; // hard lock: no adding

    const def: any = WIDGETS.find((x: any) => x.id === widgetId);
    if (!def) return null;

    const key = `${widgetId}-${Date.now()}`;
    const nextInstances: WidgetInstance[] = [...instances, { key, widgetId }];

    const sizeW = w ?? def.defaultSize?.w ?? 6;
    const sizeH = h ?? def.defaultSize?.h ?? 6;

    const nextLayout: Layout = [...layout, { i: key, x: 0, y: Infinity, w: sizeW, h: sizeH, minW: 2, minH: 3 } as any];

    setInstances(nextInstances);
    setLayout(nextLayout);
    persist(nextInstances, nextLayout);

    const accent = def?.defaultTheme?.accent;
    const view = def?.defaultView;
    if (accent || view) saveWidgetSettings(key, { accent, view });

    return key;
  }

  /** Per-widget lock. Kept in its OWN persisted set and applied to the grid
      at render time — storing `static` inside the layout got round-tripped
      through RGL's onLayoutChange and intermittently lost (the "glitchy
      lock"). This way the pin can never be dropped by a grid update. */
  const [pinnedWidgets, setPinnedWidgets] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("vx.pinnedWidgets") || "[]") as string[]); } catch { return new Set(); }
  });
  function toggleWidgetPin(key: string) {
    setPinnedWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem("vx.pinnedWidgets", JSON.stringify([...next]));
      return next;
    });
  }

  // Layout handed to the grid: pin state overrides `static` deterministically.
  const rglLayout = useMemo(
    () => layout.map((l) => ({ ...l, static: pinnedWidgets.has(l.i) })),
    [layout, pinnedWidgets]
  );

  /** Send a command line to the connected device (TX console). */
  async function sendCommand(cmd: string) {
    const conn = connectionRef.current;
    liveStore.ingest(`> ${cmd}`); // echo into the raw console
    try {
      await conn?.write?.(cmd);
    } catch (err) {
      liveStore.ingest(`# TX ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function removeWidget(key: string) {
    if (flightMode) return; // hard lock: no removing

    if (pinnedWidgets.has(key)) {
      const next = new Set(pinnedWidgets);
      next.delete(key);
      setPinnedWidgets(next);
      localStorage.setItem("vx.pinnedWidgets", JSON.stringify([...next]));
    }

    const nextInstances = instances.filter((x) => x.key !== key);
    const nextLayout = layout.filter((l) => l.i !== key);

    setInstances(nextInstances);
    setLayout(nextLayout);
    persist(nextInstances, nextLayout);

    setWidgetSettings((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      localStorage.setItem("vx.widgetSettings", JSON.stringify(next));
      return next;
    });
  }

  /** Right-click handlers */
  function openMenuAt(evt: React.MouseEvent, widgetKey?: string) {
    evt.preventDefault();
    evt.stopPropagation();
    setMenu({ open: true, x: evt.clientX, y: evt.clientY, widgetKey });
  }
  function closeMenu() {
    setMenu({ open: false });
  }




  /** Close menu / escape + shortcuts */
  useEffect(() => {
    function onDown() {
      if (menu.open) setMenu({ open: false });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (menu.open) setMenu({ open: false });
        if (advancedOpen) setAdvancedOpen(false);
        if (settingsOpen) setSettingsOpen(false);
        if (paletteOpen) setPaletteOpen(false);
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }

      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
        toggleFreeze();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e" && !e.shiftKey) {
        e.preventDefault();
        exportSessionJSONL();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e" && e.shiftKey) {
        e.preventDefault();
        exportFramesCSV();
      }
    }

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu.open, advancedOpen, settingsOpen, paletteOpen, playback.mode, frozen, telemetry.frames.length]);

  /** Freeze toggle behavior */
  function toggleFreeze() {
    if (playback.mode === "playback") return;
    if (!display.frames.length) return;

    if (!frozen) {
      setFrozen(true);
      // Index into the DISPLAYED (vehicle-filtered) frame set, not the raw buffer.
      setFreezeIdx(display.frames.length - 1);
    } else {
      setFrozen(false);
      setFreezeIdx(null);
    }
  }

  /** Playback loader (.jsonl) */
  function loadLinesIntoPlayback(lines: string[], filename: string) {
    const frames: TelemetryFrameV1[] = [];
    const rawLines: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      rawLines.push(line);
      try {
        const { payload, crc } = verifyAndStrip(line);
        if (crc === "bad") continue; // corrupt on the wire — never replay it
        const obj = JSON.parse(payload);
        if (obj && obj.v === 1 && typeof obj.t_ms === "number") frames.push(obj as TelemetryFrameV1);
      } catch {
        // ignore
      }
    }

    frames.sort((a, b) => (a.t_ms ?? 0) - (b.t_ms ?? 0));

    setPlayback({
      mode: "playback",
      frames,
      rawLines,
      idx: 0,
      filename,
      playing: false,
      speed: 1,
    });

    setFrozen(false);
    setFreezeIdx(null);
  }

  async function onLoadLogFile(file: File) {
    const text = await file.text();
    loadLinesIntoPlayback(text.split(/\r?\n/), file.name);
  }

  /** ---------- Persistent flight log ---------- */
  async function refreshFlights() {
    try {
      setFlights(await listFlights());
    } catch (e) {
      console.error("[flightLog] list failed", e);
    }
  }

  async function saveCurrentFlight() {
    const raw = logLinesRef.current;
    if (!raw.length) return;
    try {
      await saveFlight({ startedAt: sessionStartRef.current, rawLines: [...raw] });
      await clearLiveCheckpoint().catch(() => {});
      await refreshFlights();
    } catch (e) {
      console.error("[flightLog] save failed", e);
    }
  }

  async function overlayFlightFromLog(id: string) {
    const rec = await getFlight(id);
    if (!rec) return;
    const frames: TelemetryFrameV1[] = [];
    for (const line of rec.rawLines) {
      try {
        const { payload, crc } = verifyAndStrip(line);
        if (crc === "bad") continue;
        const obj = JSON.parse(payload);
        if (obj && obj.v === 1 && typeof obj.t_ms === "number") frames.push(obj as TelemetryFrameV1);
      } catch { /* skip */ }
    }
    if (!frames.length) {
      window.alert("That flight has no parseable frames to overlay.");
      return;
    }
    frames.sort((a, b) => a.t_ms - b.t_ms);
    setGhostFlight({ name: rec.name, frames });
    setFlightLogOpen(false);
  }

  async function loadFlightFromLog(id: string) {
    try {
      const rec = await getFlight(id);
      if (rec) {
        loadLinesIntoPlayback(rec.rawLines, rec.name);
        setFlightLogOpen(false);
      }
    } catch (e) {
      console.error("[flightLog] load failed", e);
    }
  }

  async function deleteFlightFromLog(id: string) {
    try {
      await deleteFlight(id);
      await refreshFlights();
    } catch (e) {
      console.error("[flightLog] delete failed", e);
    }
  }

  /** Open the Share dialog for an archived flight. */
  async function shareFlightFromLog(id: string) {
    const rec = await getFlight(id);
    if (!rec) return;
    const frames = flightToFrames(rec.rawLines);
    if (!frames.length) { window.alert("That flight has no parseable frames to share."); return; }
    setShareData(toShareFlight(rec.name, frames));
  }

  /** Load a shared flight (from a #flight= link) straight into playback. */
  async function loadSharedFlight(sf: ShareFlight) {
    loadLinesIntoPlayback(shareFlightToLines(sf), sf.name);
  }

  function exitPlayback() {
    setPlayback({ mode: "live", frames: [], rawLines: [], idx: 0, filename: undefined, playing: false, speed: 1 });
  }

  /** Playback ticker (speed) */
  useEffect(() => {
    if (playback.mode !== "playback") return;
    if (!playback.playing) return;
    if (playback.frames.length <= 1) return;

    const intervalMs = Math.max(10, Math.floor(60 / playback.speed));
    const t = window.setInterval(() => {
      setPlayback((p) => {
        if (p.mode !== "playback" || !p.playing) return p;
        const next = p.idx + 1;
        if (next >= p.frames.length) return { ...p, idx: p.frames.length - 1, playing: false };
        return { ...p, idx: next };
      });
    }, intervalMs);

    return () => window.clearInterval(t);
  }, [playback.mode, playback.playing, playback.speed, playback.frames.length]);

  /** Derived events */
  const derivedEvents = useMemo<DerivedEvent[]>(() => {
    const frames = display.frames;
    if (!frames.length) return [];

    const events: DerivedEvent[] = [];

    for (let i = 0; i < frames.length; i++) {
      const ev = frames[i].event;
      if (typeof ev === "string" && ev.trim()) {
        const label = ev.trim();
        const upper = label.toUpperCase();
        const id =
          upper.includes("ARM") ? "ARMED" :
          upper.includes("LIFT") ? "LIFTOFF" :
          upper.includes("APOG") ? "APOGEE" :
          upper.includes("DROG") ? "DROGUE" :
          upper.includes("MAIN") ? "MAIN" :
          upper.includes("LAND") ? "LANDING" :
          "CUSTOM";
        events.push({ id, label, idx: i, t_ms: frames[i].t_ms });
      }
    }

    // Latched session events (live mode): the ring buffer wraps on long pad
    // waits and early event frames (LIFTOFF!) scroll out — without this the
    // mission clock would reset to T− mid-flight. Latched events map to the
    // nearest buffered frame for jump/freeze; dedupe below keeps the earliest.
    if (playback.mode !== "playback") {
      for (const le of telemetry.events) {
        if (!matchVid(le as unknown as TelemetryFrameV1)) continue;
        const label = le.event;
        const upper = label.toUpperCase();
        const id =
          upper.includes("ARM") ? "ARMED" :
          upper.includes("LIFT") ? "LIFTOFF" :
          upper.includes("BURN") ? "BURNOUT" :
          upper.includes("APOG") ? "APOGEE" :
          upper.includes("DROG") ? "DROGUE" :
          upper.includes("MAIN") ? "MAIN" :
          upper.includes("LAND") ? "LANDING" :
          "CUSTOM";
        let idx = 0;
        while (idx < frames.length - 1 && frames[idx].t_ms < le.t_ms) idx++;
        events.push({ id: id as DerivedEvent["id"], label, idx, t_ms: le.t_ms });
      }
    }

    // Fused, gated event detection (accel-gated liftoff, debounced apogee via
    // fused velocity, averaged pad-zero, at-rest landing). Firmware-sent events
    // above always win — these fill in only what the vehicle didn't report.
    const hasAlt = frames.some((f) => typeof f.alt_m === "number");
    if (hasAlt) {
      const fe = detectFlightEvents(frames);
      if (fe.liftoffIdx >= 0 && !events.some((e) => e.id === "LIFTOFF")) {
        events.push({ id: "LIFTOFF", label: "LIFTOFF (derived)", idx: fe.liftoffIdx, t_ms: frames[fe.liftoffIdx].t_ms });
      }
      if (fe.burnoutIdx >= 0 && !events.some((e) => e.id === "BURNOUT")) {
        events.push({ id: "BURNOUT", label: "BURNOUT (derived)", idx: fe.burnoutIdx, t_ms: frames[fe.burnoutIdx].t_ms });
      }
      if (fe.apogeeIdx >= 0 && !events.some((e) => e.id === "APOGEE")) {
        events.push({ id: "APOGEE", label: "APOGEE (derived)", idx: fe.apogeeIdx, t_ms: frames[fe.apogeeIdx].t_ms });
      }
      if (fe.landingIdx >= 0 && fe.landingIdx > fe.apogeeIdx && !events.some((e) => e.id === "LANDING")) {
        events.push({ id: "LANDING", label: "LANDING (derived)", idx: fe.landingIdx, t_ms: frames[fe.landingIdx].t_ms });
      }
    }

    const byId = new Map<string, DerivedEvent>();
    events
      .slice()
      .sort((a, b) => a.idx - b.idx)
      .forEach((e) => {
        if (!byId.has(e.id)) byId.set(e.id, e);
      });

    return Array.from(byId.values()).sort((a, b) => a.idx - b.idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display.frames, telemetry.events, playback.mode, vehicleFilter]);

  function jumpToEvent(id: DerivedEvent["id"]) {
    const e = derivedEvents.find((x) => x.id === id);
    if (!e) return;

    if (playback.mode === "playback") setPlayback((p) => ({ ...p, idx: e.idx, playing: false }));
    else {
      setFrozen(true);
      setFreezeIdx(e.idx);
    }
  }

  /** Export current session logs */
  function exportSessionJSONL() {
    const started = new Date(sessionStartRef.current);
    const stamp = started.toISOString().replace(/[:.]/g, "-").split("Z")[0];
    const filename = `valdex_session_${stamp}.jsonl`;
    downloadTextFile(filename, logLinesRef.current.join("\n"), "text/plain");
  }

  function exportFramesCSV() {
    const frames = display.frames; // filtered to the selected vehicle
    const started = new Date(sessionStartRef.current);
    const stamp = started.toISOString().replace(/[:.]/g, "-").split("Z")[0];
    const filename = `valdex_frames_${stamp}.csv`;
    downloadTextFile(filename, toCSV(frames), "text/csv");
  }

  /** Export the GPS track as KML for Google Earth / recovery planning. */
  function exportKML() {
    const src = display.frames; // filtered to the selected vehicle
    const gps = src.filter((f) => typeof f.lat === "number" && typeof f.lon === "number");
    if (!gps.length) {
      window.alert("No GPS data in this session to export.");
      return;
    }
    const coords = gps
      .map((f) => `${f.lon},${f.lat},${typeof f.alt_m === "number" ? f.alt_m.toFixed(1) : "0"}`)
      .join("\n            ");
    const events = gps.filter((f) => typeof f.event === "string" && f.event.trim());
    const placemarks = events
      .map(
        (f) => `
    <Placemark>
      <name>${(f.event as string).replace(/[<>&]/g, "")}</name>
      <Point><altitudeMode>relativeToGround</altitudeMode><coordinates>${f.lon},${f.lat},${typeof f.alt_m === "number" ? f.alt_m.toFixed(1) : "0"}</coordinates></Point>
    </Placemark>`
      )
      .join("");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>VX Telemetry flight track</name>
    <Style id="track"><LineStyle><color>ffff9d1f</color><width>3</width></LineStyle></Style>
    <Placemark>
      <name>Flight path</name>
      <styleUrl>#track</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>
            ${coords}
        </coordinates>
      </LineString>
    </Placemark>${placemarks}
  </Document>
</kml>`;
    const stamp = new Date(sessionStartRef.current).toISOString().replace(/[:.]/g, "-").split("Z")[0];
    downloadTextFile(`valdex_track_${stamp}.kml`, kml, "application/vnd.google-earth.kml+xml");
  }

  /** Export the GPS track as GPX — supported by nearly every GPS/mapping app. */
  function exportGPX() {
    const src = display.frames; // filtered to the selected vehicle
    const gps = src.filter((f) => typeof f.lat === "number" && typeof f.lon === "number");
    if (!gps.length) {
      window.alert("No GPS data in this session to export.");
      return;
    }
    const t0 = sessionStartRef.current;
    const firstT = gps[0].t_ms;
    const iso = (f: TelemetryFrameV1) => new Date(t0 + (f.t_ms - firstT)).toISOString();
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const trkpts = gps
      .map(
        (f) =>
          `      <trkpt lat="${f.lat}" lon="${f.lon}">${typeof f.alt_m === "number" ? `<ele>${f.alt_m.toFixed(1)}</ele>` : ""}<time>${iso(f)}</time></trkpt>`
      )
      .join("\n");
    const wpts = gps
      .filter((f) => typeof f.event === "string" && f.event.trim())
      .map(
        (f) =>
          `  <wpt lat="${f.lat}" lon="${f.lon}">${typeof f.alt_m === "number" ? `<ele>${f.alt_m.toFixed(1)}</ele>` : ""}<name>${esc(f.event as string)}</name></wpt>`
      )
      .join("\n");

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VX Telemetry" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk>
    <name>VX Telemetry flight track</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
    const stamp = new Date(sessionStartRef.current).toISOString().replace(/[:.]/g, "-").split("Z")[0];
    downloadTextFile(`valdex_track_${stamp}.gpx`, gpx, "application/gpx+xml");
  }

  /** Open a print-ready mission report (browser Print → Save as PDF). */
  function openFlightReport() {
    const frames = display.frames; // filtered to the selected vehicle
    if (!frames.length) {
      window.alert("No flight data to report.");
      return;
    }
    const s = computeFlightSummary(frames);
    const cfg = getRocketConfig();
    const m2ft = (m?: number) => (typeof m === "number" ? `${m.toFixed(1)} m / ${(m * 3.28084).toFixed(0)} ft` : "—");
    const mps = (v?: number) => (typeof v === "number" ? `${v.toFixed(1)} m/s / ${(v * 3.28084).toFixed(0)} ft/s` : "—");
    const secs = (x?: number) => (typeof x === "number" ? `${x.toFixed(1)} s` : "—");
    const liftoff = derivedEvents.find((e) => e.id === "LIFTOFF");
    const evRows = derivedEvents
      .map((e) => {
        const tPlus = liftoff ? ((e.t_ms - liftoff.t_ms) / 1000).toFixed(1) : "—";
        return `<tr><td>${e.id}</td><td>T+ ${tPlus} s</td><td>${e.label}</td></tr>`;
      })
      .join("");
    const rows = [
      ["Apogee", m2ft(s.apogeeM)],
      ["Max velocity", mps(s.maxVelMps)],
      ["Max acceleration", typeof s.maxAccelG === "number" ? `${s.maxAccelG.toFixed(1)} g` : "—"],
      ["Boost duration", secs(s.boostS)],
      ["Coast to apogee", secs(s.coastS)],
      ["Descent duration", secs(s.descentS)],
      ["Total flight time", secs(s.totalS)],
      ["Drogue descent rate", mps(s.drogueRateMps)],
      ["Main descent rate", mps(s.mainRateMps)],
      ["Frames analyzed", String(frames.length)],
    ]
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join("");

    const w = window.open("", "_blank", "width=760,height=900");
    if (!w) {
      window.alert("Popup blocked — allow popups to generate the report.");
      return;
    }
    w.document.write(`<!DOCTYPE html><html><head><title>VX Flight Report — ${cfg.name}</title>
<style>
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; margin: 40px; }
  h1 { font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; }
  .sub { color: #666; font-size: 12px; margin: 6px 0 24px; }
  h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #444; border-bottom: 2px solid #111; padding-bottom: 6px; margin-top: 28px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 7px 8px; border-bottom: 1px solid #ddd; }
  td:first-child { color: #555; width: 40%; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
  .footer { margin-top: 36px; font-size: 10px; color: #999; }
  .btn { margin: 24px 0; padding: 10px 18px; font-size: 13px; cursor: pointer; }
  @media print { .btn { display: none; } }
</style></head><body>
  <h1>Flight Report — ${cfg.name}</h1>
  <div class="sub">${new Date(sessionStartRef.current).toLocaleString()} · ${cfg.stages === 2 ? "Two-stage" : "Single-stage"} · Recovery: ${cfg.recovery} · ${playback.mode === "playback" ? `Playback: ${playback.filename ?? ""}` : "Live session"}</div>
  <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  <h2>Performance</h2>
  <table>${rows}</table>
  <h2>Flight Events</h2>
  <table>${evRows || "<tr><td colspan=3>No events recorded</td></tr>"}</table>
  <div class="footer">Generated by VX Telemetry — Valdex ground station</div>
</body></html>`);
    w.document.close();
  }

  /** Link health */
  const linkHealth = useMemo(() => {
    const now = performance.now();
    const msSinceLine = lastLineAtRef.current ? now - lastLineAtRef.current : Infinity;

    const dts = dtMsWindowRef.current;
    const median = dts.length ? [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)] : NaN;

    const stale = msSinceLine > 750;
    const veryStale = msSinceLine > 2000;

    let lossScore = 0;
    if (Number.isFinite(median) && median > 0 && dts.length > 10) {
      const spikes = dts.filter((dt) => dt > (median as number) * 1.8).length;
      lossScore = Math.round((spikes / dts.length) * 100);
    }

    const rssi = display.latest?.rssi_dbm as number | undefined;
    const batt = display.latest?.batt_v as number | undefined;
    const battPct = typeof batt === "number" ? batteryPercentFromPackV(batt, battProfile) : undefined;

    return {
      msSinceLine,
      stale,
      veryStale,
      medianDt: Number.isFinite(median) ? (median as number) : undefined,
      lossScore,
      rssi,
      batt,
      battPct,
    };
  }, [display.latest, linkHealthTick, playback.mode, playback.idx, battProfile]);

  /** Alerts engine */
  useEffect(() => {
    if (playback.mode === "playback") return;

    // Only meaningful while actually connected — otherwise a parked ground
    // station screams "link lost" forever (including at first app open).
    if (connStatus !== "connected") {
      for (const id of ["link-stale-crit", "link-stale-warn", "rssi-crit", "rssi-warn", "batt-crit", "batt-warn"]) clearAlert(id);
      return;
    }

    if (linkHealth.veryStale) {
      pushAlert({ id: "link-stale-crit", level: "crit", title: "Link lost / stale", detail: `No telemetry for ${Math.round(linkHealth.msSinceLine)} ms` });
    } else if (linkHealth.stale) {
      pushAlert({ id: "link-stale-warn", level: "warn", title: "Telemetry delayed", detail: `Last update ${Math.round(linkHealth.msSinceLine)} ms ago` });
    } else {
      clearAlert("link-stale-crit");
      clearAlert("link-stale-warn");
    }

    if (typeof linkHealth.rssi === "number") {
      if (linkHealth.rssi < -110) pushAlert({ id: "rssi-crit", level: "crit", title: "RF link very weak", detail: `RSSI ${linkHealth.rssi} dBm` });
      else if (linkHealth.rssi < -100) pushAlert({ id: "rssi-warn", level: "warn", title: "RF link weak", detail: `RSSI ${linkHealth.rssi} dBm` });
      else {
        clearAlert("rssi-crit");
        clearAlert("rssi-warn");
      }
    }

    if (typeof linkHealth.battPct === "number") {
      if (linkHealth.battPct <= battProfile.critPct) {
        pushAlert({ id: "batt-crit", level: "crit", title: "Battery critically low", detail: `${linkHealth.battPct}% (${typeof linkHealth.batt === "number" ? linkHealth.batt.toFixed(2) : "—"} V)` });
      } else if (linkHealth.battPct <= battProfile.warnPct) {
        pushAlert({ id: "batt-warn", level: "warn", title: "Battery low", detail: `${linkHealth.battPct}% (${typeof linkHealth.batt === "number" ? linkHealth.batt.toFixed(2) : "—"} V)` });
      } else {
        clearAlert("batt-crit");
        clearAlert("batt-warn");
      }
    } else if (typeof linkHealth.batt === "number") {
      if (linkHealth.batt < 3.45) pushAlert({ id: "batt-crit", level: "crit", title: "Battery critically low", detail: `${linkHealth.batt.toFixed(2)} V` });
      else if (linkHealth.batt < 3.65) pushAlert({ id: "batt-warn", level: "warn", title: "Battery low", detail: `${linkHealth.batt.toFixed(2)} V` });
      else {
        clearAlert("batt-crit");
        clearAlert("batt-warn");
      }
    }
  }, [linkHealth, playback.mode, battProfile, connStatus]);

  /** Custom alert rules engine (live + connected only). Debounced with
      hysteresis: a rule must hold for a few consecutive samples before it
      fires, and clear for a few before it releases — so one noisy packet can't
      trip master caution, and a value hovering on the threshold won't flicker. */
  const ruleDebounceRef = useRef<Record<string, { trueRun: number; falseRun: number; firing: boolean }>>({});
  const RULE_FIRE_N = 3;
  const RULE_CLEAR_N = 3;
  useEffect(() => {
    if (playback.mode === "playback") return;
    if (connStatus !== "connected") {
      for (const rule of alertRules) clearAlert(`rule-${rule.id}`);
      ruleDebounceRef.current = {};
      return;
    }
    const latest = telemetry.latest as Record<string, unknown> | undefined;
    const store = ruleDebounceRef.current;
    for (const rule of alertRules) {
      const id = `rule-${rule.id}`;
      const st = store[rule.id] ?? (store[rule.id] = { trueRun: 0, falseRun: 0, firing: false });
      if (ruleFires(rule, latest)) { st.trueRun++; st.falseRun = 0; } else { st.falseRun++; st.trueRun = 0; }

      if (!st.firing && st.trueRun >= RULE_FIRE_N) st.firing = true;
      else if (st.firing && st.falseRun >= RULE_CLEAR_N) st.firing = false;

      if (st.firing) {
        const v = latest?.[rule.field];
        pushAlert({
          id,
          level: rule.level,
          title: rule.title || `${rule.field} ${rule.op} ${rule.value}`,
          detail: `${rule.field} = ${typeof v === "number" ? v.toFixed(2) : "—"} (limit ${rule.op} ${rule.value})`,
        });
      } else {
        clearAlert(id);
      }
    }
  }, [telemetry.latest, alertRules, playback.mode, connStatus]);

  const modeChip = playback.mode === "playback" ? `PLAYBACK${playback.filename ? `: ${playback.filename}` : ""}` : "LIVE";

  // Hard disable layout mutation in flight mode OR playback.
  const isLayoutEditable = !flightMode && playback.mode !== "playback";

  /** ---------- Mission analytics ---------- */

  // Flight profile phases in canonical order (mirrors the sim / real flight sequence)
  const PHASE_SEQUENCE = ["PAD", "BOOST", "COAST", "APOGEE", "DROGUE", "MAIN", "LANDED"] as const;
  type Phase = (typeof PHASE_SEQUENCE)[number];

  // Map a derived-event id to the phase it *begins*.
  function eventToPhase(id: DerivedEvent["id"]): Phase | null {
    switch (id) {
      case "LIFTOFF": return "BOOST";
      case "BURNOUT": return "COAST";
      case "APOGEE": return "APOGEE";
      case "DROGUE": return "DROGUE";
      case "MAIN": return "MAIN";
      case "LANDING": return "LANDED";
      default: return null;
    }
  }

  // Current phase = phase begun by the latest event at/before the displayed frame index.
  const flightPhase: Phase = useMemo(() => {
    let phase: Phase = "PAD";
    const idx = display.idx;
    for (const e of derivedEvents) {
      if (e.idx > idx) continue;
      const p = eventToPhase(e.id);
      if (p) phase = p;
    }
    return phase;
  }, [derivedEvents, display.idx]);

  // Mission clock: T+ MET measured from LIFTOFF; T- countdown to it if not yet lifted off.
  const fmtClock = (ms: number) => {
    const sign = ms >= 0 ? "+" : "−";
    const s = Math.abs(ms) / 1000;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `T${sign} ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
  };

  // Mission clock: real T+ (from the LIFTOFF event) wins; otherwise the
  // operator countdown; otherwise idle. Not memoized — the countdown ticker
  // re-renders us 4×/s while running and the math is trivial.
  const missionClock = (() => {
    const liftoff = derivedEvents.find((e) => e.id === "LIFTOFF");
    if (liftoff) {
      const met = display.t_ms - liftoff.t_ms;
      return { label: fmtClock(met), counting: met >= 0, holding: false };
    }
    const rem = countdownRemainingMs();
    if (rem !== null) {
      return { label: fmtClock(-rem), counting: false, holding: countdown.mode === "hold" };
    }
    return { label: "T− --:--:--", counting: false, holding: false };
  })();

  // Flight peaks over the displayed frame history.
  const peaks = useMemo(() => {
    let maxAlt = -Infinity, maxVel = -Infinity, maxAccel = -Infinity;
    for (const f of display.frames) {
      if (typeof f.alt_m === "number" && f.alt_m > maxAlt) maxAlt = f.alt_m;
      if (typeof f.vel_mps === "number" && f.vel_mps > maxVel) maxVel = f.vel_mps;
      if (typeof f.ax === "number" && typeof f.ay === "number" && typeof f.az === "number") {
        const mag = Math.sqrt(f.ax * f.ax + f.ay * f.ay + f.az * f.az);
        if (mag > maxAccel) maxAccel = mag;
      }
    }
    let apogeeM = Number.isFinite(maxAlt) ? maxAlt : undefined;
    let maxVelMps = Number.isFinite(maxVel) ? maxVel : undefined;
    let maxAccelG = Number.isFinite(maxAccel) ? maxAccel / 9.80665 : undefined;

    // Live mode: fold in the latched peaks so a long-flight ring-buffer wrap
    // can't drop the competition-critical apogee / max-V / max-G.
    if (playback.mode !== "playback") {
      const lp = telemetry.peaks;
      if (lp) {
        if (typeof lp.maxAltM === "number") apogeeM = Math.max(apogeeM ?? -Infinity, lp.maxAltM);
        if (typeof lp.maxVelMps === "number") maxVelMps = Math.max(maxVelMps ?? -Infinity, lp.maxVelMps);
        if (typeof lp.maxAccelG === "number") maxAccelG = Math.max(maxAccelG ?? -Infinity, lp.maxAccelG);
      }
    }
    return { apogeeM, maxVelMps, maxAccelG };
  }, [display.frames, telemetry.peaks, playback.mode]);

  // Predicted apogee during ascent. During coast we measure the actual total
  // deceleration (gravity + drag) from the last ~1 s of frames, which folds the
  // vehicle's real drag into the estimate; during boost fall back to the
  // drag-free ballistic floor h + v²/2g.
  const predApogeeM = useMemo(() => {
    if (flightPhase !== "BOOST" && flightPhase !== "COAST") return undefined;
    const alt = display.latest?.alt_m;
    const vel = display.latest?.vel_mps;
    if (typeof alt !== "number" || typeof vel !== "number" || vel <= 0) return undefined;

    let decel = 9.80665;
    if (flightPhase === "COAST") {
      const fr = display.frames;
      const recent: Array<{ v: number; t: number }> = [];
      for (let i = Math.max(0, fr.length - 25); i < fr.length; i++) {
        const f = fr[i];
        if (typeof f.vel_mps === "number" && typeof f.t_ms === "number") recent.push({ v: f.vel_mps, t: f.t_ms });
      }
      if (recent.length >= 2) {
        const dv = recent[recent.length - 1].v - recent[0].v;
        const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
        if (dt > 0.2) {
          const a = -dv / dt;
          if (Number.isFinite(a) && a > 9.80665) decel = a; // drag can only add to gravity
        }
      }
    }
    return alt + (vel * vel) / (2 * decel);
  }, [flightPhase, display.latest, display.frames]);

  // Touchdown ETA while descending under canopy.
  const touchdownEtaS = useMemo(() => {
    if (flightPhase !== "DROGUE" && flightPhase !== "MAIN") return undefined;
    const alt = display.latest?.alt_m;
    const vel = display.latest?.vel_mps;
    if (typeof alt !== "number" || typeof vel !== "number" || vel >= -0.5 || alt <= 0) return undefined;
    return alt / -vel;
  }, [flightPhase, display.latest]);

  // Keep the ghost overlay aligned: shift its clock so its liftoff (or first
  // frame) lands on the current flight's liftoff (or first frame).
  const liveLiftoffTms = derivedEvents.find((e) => e.id === "LIFTOFF")?.t_ms ?? null;
  const firstFrameTms = display.frames[0]?.t_ms ?? null;
  useEffect(() => {
    if (!ghostFlight) {
      setGhost(null);
      return;
    }
    // Re-shift only when the alignment anchor actually moves (not per tick).
    const liveLift = liveLiftoffTms ?? firstFrameTms ?? 0;
    const ghostLift = extractLiftoffTms(ghostFlight.frames) ?? ghostFlight.frames[0]?.t_ms ?? 0;
    const offset = liveLift - ghostLift;
    setGhost({ name: ghostFlight.name, frames: ghostFlight.frames.map((f) => ({ ...f, t_ms: f.t_ms + offset })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostFlight, liveLiftoffTms, firstFrameTms === null]);

    // GO / NO-GO readiness board.
  type GoState = "go" | "caution" | "crit" | "nodata";
  const readiness = useMemo(() => {
    const live = playback.mode !== "playback";
    const hasData = display.frames.length > 0;

    // LINK
    let link: GoState = "nodata";
    if (!live) link = "go";
    else if (connStatus !== "connected") link = hasData ? "caution" : "nodata";
    else if (linkHealth.veryStale) link = "crit";
    else if (linkHealth.stale) link = "caution";
    else if (hasData) link = "go";

    // TELEMETRY (packets flowing)
    let telem: GoState = "nodata";
    if (!live) telem = hasData ? "go" : "nodata";
    else if (telemetry.packetsPerSec > 0) telem = "go";
    else if (connStatus === "connected") telem = "caution";

    // BATTERY
    let batt: GoState = "nodata";
    if (typeof linkHealth.battPct === "number") {
      if (linkHealth.battPct <= battProfile.critPct) batt = "crit";
      else if (linkHealth.battPct <= battProfile.warnPct) batt = "caution";
      else batt = "go";
    } else if (typeof linkHealth.batt === "number") {
      batt = linkHealth.batt < 3.45 ? "crit" : linkHealth.batt < 3.65 ? "caution" : "go";
    }

    // GPS
    let gps: GoState = "nodata";
    const fix = display.latest?.gps_fix;
    const sats = display.latest?.gps_sats;
    if (typeof fix === "number") {
      if (fix >= 3 || (typeof sats === "number" && sats >= 6)) gps = "go";
      else if (fix >= 1 || (typeof sats === "number" && sats >= 3)) gps = "caution";
      else gps = "crit";
    } else if (display.latest?.lat !== undefined) {
      gps = "go";
    }

    // RF
    let rf: GoState = "nodata";
    if (typeof linkHealth.rssi === "number") {
      if (linkHealth.rssi < -110) rf = "crit";
      else if (linkHealth.rssi < -100) rf = "caution";
      else rf = "go";
    }

    return { link, telem, batt, gps, rf };
  }, [playback.mode, display.frames.length, display.latest, connStatus, linkHealth, telemetry.packetsPerSec, battProfile]);

  const goStateText: Record<GoState, string> = { go: "GO", caution: "HOLD", crit: "NO-GO", nodata: "—" };

  /** Voice callouts on flight events (live only). Scans frames so batched
      ticks can't skip an event frame. */
  const lastCalloutTRef = useRef<number>(-1);
  useEffect(() => {
    if (playback.mode !== "live") return;
    const frames = telemetry.frames;
    if (!frames.length) return;
    // First sight of data: don't replay the backlog.
    if (lastCalloutTRef.current < 0) {
      lastCalloutTRef.current = frames[frames.length - 1].t_ms;
      return;
    }
    for (const f of frames) {
      if (f.t_ms <= lastCalloutTRef.current) continue;
      if (typeof f.event === "string" && f.event.trim()) {
        lastCalloutTRef.current = f.t_ms;
        // Only call out events for the vehicle currently being tracked.
        if (voiceOn && matchVid(f)) speak(calloutText(f, globalUnits));
      }
    }
    const last = frames[frames.length - 1];
    if (last.t_ms > lastCalloutTRef.current) lastCalloutTRef.current = last.t_ms;
  }, [telemetry.frames, voiceOn, playback.mode, globalUnits]);

  /** Master caution: active whenever any critical alert stands. */
  const critAlerts = useMemo(() => alerts.filter((a) => a.level === "crit"), [alerts]);
  const critSig = useMemo(() => critAlerts.map((a) => a.id).sort().join("|"), [critAlerts]);
  const cautionActive = critSig !== "";
  // Alarm sounds unless muted or the current caution set has been acknowledged.
  const alarmActive = cautionActive && !alarmMuted && critSig !== ackedSig;

  useEffect(() => {
    if (alarmActive) {
      startAlarm();
      if (voiceOn) speak("Master caution");
    } else stopAlarm();
    return () => stopAlarm();
  }, [alarmActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // A brand-new caution set clears any prior acknowledgement.
  useEffect(() => {
    if (critSig && critSig !== ackedSig) {
      // only reset ack if the signature grew/changed to something not acked
    }
    if (!critSig) setAckedSig("");
  }, [critSig]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: "relative", zIndex: 1, padding: 14, fontFamily: "var(--vx-font-display)", color: "var(--vx-fg)" }}>
      <style>{`
        :root {
          --vx-bgA: ${theme.bgA};
          --vx-bgB: ${theme.bgB};
          --vx-console: ${theme.consoleBg};
        }

        .vx-shell {
          background:
            linear-gradient(180deg, rgba(162, 166, 174,0.03), transparent 240px),
            linear-gradient(135deg, var(--vx-bgA), var(--vx-bgB));
          border-radius: 4px;
          padding: 12px;
          border: 1px solid var(--vx-line);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4), 0 20px 60px rgba(0,0,0,0.5);
          min-height: 650px;
          position: relative;
        }
        /* corner ticks on the shell */
        .vx-shell::before, .vx-shell::after {
          content: "";
          position: absolute;
          width: 14px; height: 14px;
          border-color: var(--vx-line-strong);
          pointer-events: none;
        }
        .vx-shell::before { top: 6px; left: 6px; border-top: 2px solid; border-left: 2px solid; }
        .vx-shell::after { bottom: 6px; right: 6px; border-bottom: 2px solid; border-right: 2px solid; }

        .vx-widget {
          height: 100%;
          border-radius: 4px;
          overflow: hidden;
          position: relative;
          color: var(--vx-fg);
        }

        .vx-widget-inner { height: 100%; padding: 10px 12px; box-sizing: border-box; }

        .vx-titlebar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: ${isLayoutEditable ? "move" : "default"};
          user-select: none;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          font-size: 12px;
          font-weight: 700;
          opacity: 0.98;
          padding-bottom: 8px;
          margin-bottom: 10px;
          border-bottom: 1px solid var(--vx-line);
          gap: 10px;
        }

        .vx-xbtn {
          width: 30px; height: 30px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(198, 201, 207,0.05);
          color: var(--vx-fg);
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .vx-xbtn:hover:not(:disabled) { border-color: var(--vx-crit); color: var(--vx-crit); background: rgba(255,59,71,0.1); }

        .vx-select {
          background: rgba(20, 20, 23,0.85);
          color: var(--vx-fg);
          border: 1px solid var(--vx-line);
          border-radius: 3px;
          padding: 7px 9px;
          outline: none;
          font-family: var(--vx-font-display);
          font-size: 12px;
          letter-spacing: 0.03em;
          transition: border-color 0.12s ease;
        }
        .vx-select:hover { border-color: var(--vx-line-strong); }
        .vx-select:focus { border-color: var(--vx-accent); box-shadow: 0 0 0 2px var(--vx-accent-glow); }

        .vx-btn {
          padding: 8px 12px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(198, 201, 207,0.05);
          color: var(--vx-fg);
          cursor: pointer;
          font-family: var(--vx-font-display);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          transition: all 0.12s ease;
        }
        .vx-btn:hover:not(:disabled) { background: rgba(198, 201, 207,0.12); border-color: var(--vx-line-strong); }
        .vx-btn-primary {
          background: rgba(162, 166, 174,0.16);
          border-color: rgba(162, 166, 174,0.5);
          color: var(--vx-accent-bright);
        }
        .vx-btn-primary:hover:not(:disabled) { background: rgba(162, 166, 174,0.28); box-shadow: 0 0 14px var(--vx-accent-glow); }
        .vx-btn-danger { background: rgba(255,59,71,0.14); border-color: rgba(255,59,71,0.45); color: #ff8b92; }
        .vx-btn-danger:hover:not(:disabled) { background: rgba(255,59,71,0.24); }
        .vx-btn:disabled { opacity: 0.32; cursor: not-allowed; }

        .vx-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 9px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23,0.6);
          font-family: var(--vx-font-mono);
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          color: var(--vx-fg);
        }

        .vx-widget-outline {
          outline: 1px solid var(--vx-line);
          outline-offset: -1px;
        }

        .react-resizable-handle {
          width: 18px; height: 18px;
          opacity: ${isLayoutEditable ? 0.95 : 0};
          pointer-events: ${isLayoutEditable ? "auto" : "none"};
          filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.7));
        }
        .react-resizable-handle::after {
          content: "";
          position: absolute;
          right: 0; bottom: 0;
          width: 12px; height: 12px;
          border-right: 2px solid var(--vx-accent);
          border-bottom: 2px solid var(--vx-accent);
        }

        .vx-menu {
          position: fixed;
          min-width: 250px;
          background: rgba(17, 17, 18,0.97);
          border: 1px solid var(--vx-line-strong);
          border-radius: 4px;
          box-shadow: 0 18px 50px rgba(0,0,0,0.7);
          padding: 6px;
          z-index: 9999;
          color: var(--vx-fg);
          backdrop-filter: blur(10px);
        }
        .vx-menu-item {
          padding: 10px 10px;
          border-radius: 3px;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          font-size: 13px;
        }
        .vx-menu-item:hover { background: rgba(162, 166, 174,0.12); }
        .vx-menu-muted { opacity: 0.6; font-size: 12px; }

        .vx-modal-backdrop {
          position: fixed; inset: 0;
          background: rgba(6, 6, 7,0.78);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          backdrop-filter: blur(3px);
        }
        .vx-modal {
          width: min(1100px, 92vw);
          height: min(720px, 86vh);
          background: rgba(17, 17, 18,0.98);
          border: 1px solid var(--vx-line-strong);
          border-radius: 4px;
          box-shadow: 0 22px 70px rgba(0,0,0,0.75);
          color: var(--vx-fg);
          display: grid;
          grid-template-columns: 360px 1fr 360px;
          overflow: hidden;
          backdrop-filter: blur(12px);
        }
        .vx-pane { padding: 16px; border-right: 1px solid var(--vx-line); overflow: auto; }
        .vx-pane:last-child { border-right: none; }

        /* ---- Settings / Export: single-column, tabbed, scrollable ---- */
        .vx-modal.vx-settings, .vx-modal.vx-export {
          display: flex;
          flex-direction: column;
          grid-template-columns: none;
        }
        .vx-modal.vx-settings { width: min(640px, 94vw); height: min(760px, 88vh); }
        .vx-modal.vx-export { width: min(560px, 94vw); height: auto; max-height: 86vh; }
        .vx-modal.vx-help-modal {
          display: flex; flex-direction: column; grid-template-columns: none;
          width: min(600px, 94vw); height: auto; max-height: 86vh;
        }
        .vx-modal.vx-onboard {
          display: flex; flex-direction: column; grid-template-columns: none;
          width: min(760px, 94vw); height: auto; max-height: 88vh;
        }
        .vx-tmpl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
        .vx-tmpl {
          text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 6px;
          background: rgba(20, 20, 23, 0.5); border: 1px solid var(--vx-line); border-radius: 4px; padding: 14px;
          color: var(--vx-fg); font-family: var(--vx-font-display);
        }
        .vx-tmpl:hover { border-color: var(--vx-accent); background: rgba(162, 166, 174, 0.08); }
        .vx-tmpl-name { font-size: 14px; font-weight: 600; }
        .vx-tmpl-desc { font-size: 12px; color: var(--vx-fg-dim); line-height: 1.55; }
        .vx-tmpl-count { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vx-fg-faint); margin-top: 2px; }

        .vx-settings-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 18px; border-bottom: 1px solid var(--vx-line); flex: 0 0 auto;
        }
        .vx-settings-tabs {
          display: flex; gap: 2px; padding: 0 12px;
          border-bottom: 1px solid var(--vx-line); flex: 0 0 auto;
        }
        .vx-tab {
          appearance: none; background: none; border: none;
          border-bottom: 2px solid transparent;
          color: var(--vx-fg-dim); cursor: pointer;
          padding: 12px 16px; font-family: var(--vx-font-display);
          font-size: 12px; font-weight: 600;
          letter-spacing: 0.14em; text-transform: uppercase;
        }
        .vx-tab:hover { color: var(--vx-fg); }
        .vx-tab.active { color: var(--vx-accent-bright); border-bottom-color: var(--vx-accent); }

        .vx-settings-body {
          flex: 1 1 auto; overflow: auto; padding: 16px 18px;
          display: flex; flex-direction: column; gap: 14px;
        }
        .vx-settings-foot {
          flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 10px;
          padding: 14px 18px; border-top: 1px solid var(--vx-line);
        }
        .vx-card-title {
          font-family: var(--vx-font-display); font-size: 11px; font-weight: 600;
          letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--vx-fg-dim); margin-bottom: 8px;
        }
        .vx-help { font-size: 12px; color: var(--vx-fg-faint); line-height: 1.6; }
        .vx-preset-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
        .vx-color-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .vx-field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

        .vx-row {
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          padding: 10px 0; border-bottom: 1px solid var(--vx-line);
        }
        .vx-row:last-child { border-bottom: none; padding-bottom: 0; }
        .vx-row-label { font-size: 13px; color: var(--vx-fg); font-weight: 500; }

        .vx-switch {
          position: relative; flex: 0 0 auto;
          width: 42px; height: 22px; border-radius: 11px;
          border: 1px solid var(--vx-line-strong);
          background: rgba(20, 20, 23, 0.9);
          cursor: pointer; padding: 0; transition: background 0.15s, border-color 0.15s;
        }
        .vx-switch.on { background: var(--vx-accent); border-color: var(--vx-accent-bright); }
        .vx-switch-knob {
          position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--vx-fg-dim); transition: transform 0.15s, background 0.15s;
        }
        .vx-switch.on .vx-switch-knob { transform: translateX(20px); background: #111112; }

        .vx-kbd-list { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
        .vx-kbd-list > div { display: flex; align-items: center; gap: 12px; }
        .vx-kbd-list code { min-width: 108px; text-align: center; }
        .vx-kbd-list span { color: var(--vx-fg-dim); }

        .vx-export-list { display: flex; flex-direction: column; gap: 8px; }
        .vx-export-opt {
          display: flex; align-items: flex-start; gap: 12px; text-align: left;
          padding: 12px; border-radius: 3px; cursor: pointer;
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23, 0.5);
          color: var(--vx-fg); font-family: var(--vx-font-display);
        }
        .vx-export-opt:hover:not(:disabled) { border-color: var(--vx-line-strong); }
        .vx-export-opt.active { border-color: var(--vx-accent); background: rgba(162, 166, 174, 0.1); }
        .vx-export-opt:disabled { opacity: 0.4; cursor: not-allowed; }
        .vx-export-radio {
          flex: 0 0 auto; margin-top: 3px;
          width: 13px; height: 13px; border-radius: 50%;
          border: 1px solid var(--vx-line-strong);
        }
        .vx-export-opt.active .vx-export-radio {
          border-color: var(--vx-accent-bright);
          box-shadow: inset 0 0 0 3px var(--vx-accent);
        }
        .vx-export-name { display: block; font-size: 13px; font-weight: 600; }
        .vx-export-ext {
          font-family: var(--vx-font-mono); font-size: 11px;
          color: var(--vx-fg-dim); margin-left: 6px;
        }
        .vx-export-desc { display: block; font-size: 12px; color: var(--vx-fg-faint); margin-top: 3px; }

        .vx-input {
          width: 100%;
          padding: 10px 10px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23,0.7);
          color: var(--vx-fg);
          outline: none;
          box-sizing: border-box;
          font-family: var(--vx-font-mono);
        }
        .vx-input:focus { border-color: var(--vx-accent); box-shadow: 0 0 0 2px var(--vx-accent-glow); }
        .vx-card {
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23,0.5);
          border-radius: 4px;
          padding: 12px;
        }
        code {
          background: rgba(162, 166, 174,0.1);
          color: var(--vx-accent-bright);
          padding: 1px 5px;
          border-radius: 3px;
          font-family: var(--vx-font-mono);
        }

        .vx-alertbar { margin: 10px 0 12px; display: flex; flex-direction: column; gap: 8px; }
        .vx-alert {
          padding: 10px 14px;
          border-radius: 3px;
          border: 1px solid;
          border-left-width: 4px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: rgba(20, 20, 23,0.85);
          color: var(--vx-fg);
        }
        .vx-alert .vx-alert-title { text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; font-size: 13px; }
        .vx-alert.info { border-color: var(--vx-accent); }
        .vx-alert.warn { border-color: var(--vx-caution); }
        .vx-alert.crit { border-color: var(--vx-crit); box-shadow: inset 0 0 30px rgba(255,59,71,0.12); }

        .vx-topbar { margin-bottom: 12px; }

        .vx-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 12px;
          padding: 8px 10px;
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23,0.4);
          border-radius: 4px;
        }
        .vx-toolbar-left, .vx-toolbar-right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        /* ---------- Mission Control header ---------- */
        .vx-hdr {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: stretch;
          gap: 10px;
          margin-bottom: 12px;
        }
        .vx-hdr-panel {
          border: 1px solid var(--vx-line);
          background: linear-gradient(180deg, rgba(162, 166, 174,0.05), rgba(20, 20, 23,0.5));
          border-radius: 4px;
          padding: 10px 14px;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .vx-brand {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .vx-brand-mark {
          font-family: var(--vx-font-display);
          font-weight: 700;
          font-size: 22px;
          letter-spacing: 0.16em;
          color: var(--vx-fg);
          line-height: 1;
        }
        .vx-brand-mark b { color: var(--vx-accent-bright); }
        .vx-brand-sub {
          font-size: 10px;
          letter-spacing: 0.28em;
          color: var(--vx-fg-dim);
          text-transform: uppercase;
          margin-top: 4px;
        }
        .vx-clock {
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
        }
        .vx-clock-time {
          font-family: var(--vx-font-mono);
          font-variant-numeric: tabular-nums;
          font-weight: 800;
          font-size: 40px;
          line-height: 1;
          letter-spacing: 0.02em;
          color: var(--vx-fg);
        }
        .vx-clock-time.counting { color: var(--vx-go); text-shadow: 0 0 20px var(--vx-go-glow); }
        .vx-phase-track {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          align-items: center;
        }
        .vx-phase-step {
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 3px 7px;
          border-radius: 2px;
          border: 1px solid var(--vx-line);
          color: var(--vx-fg-faint);
          background: transparent;
          white-space: nowrap;
        }
        .vx-phase-step.done { color: var(--vx-fg-dim); border-color: var(--vx-line); }
        .vx-phase-step.active {
          color: var(--vx-bg0);
          background: var(--vx-accent);
          border-color: var(--vx-accent-bright);
          box-shadow: 0 0 14px var(--vx-accent-glow);
          font-weight: 700;
        }

        /* GO / NO-GO status board */
        .vx-status-board {
          display: grid;
          grid-auto-flow: column;
          gap: 8px;
          align-items: stretch;
        }
        .vx-status-cell {
          border: 1px solid var(--vx-line);
          border-radius: 3px;
          padding: 6px 10px;
          min-width: 74px;
          background: rgba(20, 20, 23,0.5);
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .vx-status-cell .k { font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--vx-fg-dim); }
        .vx-status-cell .v {
          font-family: var(--vx-font-display);
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 0.06em;
          display: flex; align-items: center; gap: 6px;
        }
        .vx-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
        .vx-go .v { color: var(--vx-go); } .vx-go .vx-dot { background: var(--vx-go); box-shadow: 0 0 8px var(--vx-go-glow); }
        .vx-caution .v { color: var(--vx-caution); } .vx-caution .vx-dot { background: var(--vx-caution); box-shadow: 0 0 8px var(--vx-caution-glow); }
        .vx-crit .v { color: var(--vx-crit); } .vx-crit .vx-dot { background: var(--vx-crit); box-shadow: 0 0 8px var(--vx-crit-glow); }
        .vx-nodata .v { color: var(--vx-fg-faint); } .vx-nodata .vx-dot { background: var(--vx-fg-faint); }

        /* Telemetry readout strip */
        .vx-readouts {
          display: flex;
          gap: 1px;
          flex-wrap: wrap;
          border: 1px solid var(--vx-line);
          border-radius: 4px;
          overflow: hidden;
          background: var(--vx-line);
        }
        .vx-readout {
          background: rgba(20, 20, 23,0.9);
          padding: 8px 14px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 92px;
          flex: 1;
        }
        .vx-readout .k { font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--vx-fg-dim); }
        .vx-readout .v {
          font-family: var(--vx-font-mono);
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 18px;
          color: var(--vx-fg);
        }
        .vx-readout .v small { font-size: 11px; color: var(--vx-fg-dim); font-weight: 500; margin-left: 3px; }
        .vx-readout.peak .v { color: var(--vx-accent-bright); }

        /* ---------- Widget chrome ---------- */
        .vx-seg {
          display: inline-flex;
          border: 1px solid var(--vx-line);
          border-radius: 3px;
          overflow: hidden;
        }
        .vx-seg button {
          background: rgba(20, 20, 23,0.6);
          border: none;
          border-right: 1px solid var(--vx-line);
          color: var(--vx-fg-dim);
          font-family: var(--vx-font-display);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 5px 8px;
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .vx-seg button:last-child { border-right: none; }
        .vx-seg button:hover { color: var(--vx-fg); background: rgba(162, 166, 174,0.1); }
        .vx-seg button.on {
          background: rgba(162, 166, 174,0.25);
          color: var(--vx-accent-bright);
        }

        .vx-tbtn {
          min-width: 26px; height: 26px;
          padding: 0 6px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(20, 20, 23,0.6);
          color: var(--vx-fg-dim);
          font-family: var(--vx-font-display);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .vx-tbtn:hover:not(:disabled) { color: var(--vx-fg); border-color: var(--vx-line-strong); }
        .vx-tbtn:disabled { opacity: 0.3; cursor: not-allowed; }
        .vx-tbtn-danger:hover:not(:disabled) { color: var(--vx-crit); border-color: var(--vx-crit); }

        /* Size container: widget bodies can scale type with cqw units */
        .vx-body { container-type: size; }

        /* ---------- Master caution banner ---------- */
        @keyframes vx-caution-flash {
          0%, 100% { background: rgba(255,59,71,0.14); }
          50% { background: rgba(255,59,71,0.34); }
        }
        .vx-caution-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
          padding: 10px 16px;
          border: 1px solid var(--vx-crit);
          border-radius: 4px;
          animation: vx-caution-flash 0.9s ease-in-out infinite;
          box-shadow: inset 0 0 40px rgba(255,59,71,0.2);
        }
        .vx-caution-banner .lbl {
          font-family: var(--vx-font-display);
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          font-size: 16px;
          color: #ffd7da;
        }
        .vx-caution-banner .det { font-family: var(--vx-font-mono); font-size: 12px; color: #ffb3b8; }

        /* ---------- Mission timeline ---------- */
        /* ---- Mission Model: live launch profile ---- */
        .vx-model {
          margin-bottom: 12px;
          padding: 12px 14px 10px;
          border: 1px solid var(--vx-line);
          border-radius: 4px;
          background: rgba(20, 20, 23, 0.4);
        }
        .vx-model-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 16px; flex-wrap: wrap; margin-bottom: 6px;
        }
        .vx-model-stats { display: flex; gap: 18px; flex-wrap: wrap; }
        .vx-model-stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
        .vx-model-svg {
          width: 100%;
          height: clamp(150px, 22vh, 230px);
          display: block;
        }
        .vx-model-rail {
          display: flex; gap: 6px; flex-wrap: wrap;
          margin-top: 8px; padding-top: 8px;
          border-top: 1px solid var(--vx-line);
        }
        .vx-model-ev {
          cursor: pointer;
          background: rgba(20, 20, 23, 0.7);
          border: 1px solid var(--vx-line);
          border-radius: 2px;
          padding: 3px 8px;
          font-family: var(--vx-font-display);
          font-size: 9px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--vx-fg-faint);
        }
        .vx-model-ev:hover { color: var(--vx-accent-bright); border-color: var(--vx-line-strong); }
        .vx-model-ev.reached { color: var(--vx-fg); border-color: var(--vx-go); }
        .vx-model-ev-t { font-family: var(--vx-font-mono); color: var(--vx-fg-faint); margin-left: 4px; }

        /* ---- Mission Timeline: the simple bar variant ---- */
        .vx-timeline {
          position: relative;
          margin-bottom: 12px;
          padding: 26px 16px 24px;
          border: 1px solid var(--vx-line);
          border-radius: 4px;
          background: rgba(20, 20, 23, 0.4);
        }
        .vx-timeline-rail { position: relative; height: 2px; background: var(--vx-line-strong); margin: 0 6px; }
        .vx-timeline-fill { position: absolute; left: 0; top: 0; height: 100%; background: var(--vx-accent); }
        .vx-timeline-now {
          position: absolute; top: -5px; width: 2px; height: 12px;
          background: var(--vx-go); box-shadow: 0 0 8px var(--vx-go-glow); transform: translateX(-1px);
        }
        .vx-tl-event {
          position: absolute; transform: translateX(-50%);
          display: flex; flex-direction: column; align-items: center;
          cursor: pointer; background: none; border: none; padding: 0;
        }
        .vx-tl-tick { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--vx-bg0); background: var(--vx-accent-bright); }
        .vx-tl-event.reached .vx-tl-tick { background: var(--vx-go); }
        .vx-tl-lbl {
          position: absolute; font-family: var(--vx-font-display); font-size: 9px;
          letter-spacing: 0.1em; text-transform: uppercase; color: var(--vx-fg-dim); white-space: nowrap;
        }
        .vx-tl-event:hover .vx-tl-lbl { color: var(--vx-accent-bright); }
        .vx-tl-lbl.above { bottom: 14px; }
        .vx-tl-lbl.below { top: 14px; }
        .vx-tl-time { font-family: var(--vx-font-mono); color: var(--vx-fg-faint); }
      `}</style>

      {/* ---------- Mission Control Header ---------- */}
      <div className="vx-topbar">
        <div className="vx-hdr">
          {/* Brand */}
          <div className="vx-hdr-panel">
            <div className="vx-brand">
              <MissionLogo />
              <div>
                <div className="vx-brand-mark">TELEMETRY</div>
                <div className="vx-brand-sub">Valdex · Ground Station · {modeChip}</div>
                {seenVids.length >= 2 && (
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }} title="Multiple transmitters detected — pick which vehicle to track">
                    {seenVids.map((v) => (
                      <button
                        key={v}
                        className="vx-chip"
                        onClick={() => setVehicleFilter(v)}
                        style={{
                          cursor: "pointer",
                          fontSize: 10,
                          letterSpacing: "0.08em",
                          ...(vehicleFilter === v
                            ? { borderColor: "var(--vx-accent)", color: "var(--vx-accent-bright)", background: "rgba(162, 166, 174,0.15)" }
                            : { color: "var(--vx-fg-dim)" }),
                        }}
                      >
                        ▲ {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Mission clock + phase */}
          <div className="vx-hdr-panel vx-clock">
            <div
              className={`vx-clock-time ${missionClock.counting ? "counting" : ""}`}
              style={missionClock.holding ? { color: "var(--vx-caution)", textShadow: "0 0 20px var(--vx-caution-glow)" } : undefined}
            >
              {missionClock.holding ? "HOLD " : ""}{missionClock.label}
            </div>
            {/* Countdown controls — only before real liftoff */}
            {playback.mode !== "playback" && !derivedEvents.some((e) => e.id === "LIFTOFF") && (
              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                {countdown.mode === "idle" ? (
                  <button className="vx-tbtn" onClick={startCountdown} title="Start a T-minus countdown">SET COUNT</button>
                ) : (
                  <>
                    <button
                      className="vx-tbtn"
                      onClick={holdOrResumeCountdown}
                      style={countdown.mode === "hold" ? { color: "var(--vx-go)", borderColor: "var(--vx-go)" } : { color: "var(--vx-caution)", borderColor: "var(--vx-caution)" }}
                    >
                      {countdown.mode === "hold" ? "RESUME" : "HOLD"}
                    </button>
                    <button className="vx-tbtn vx-tbtn-danger" onClick={clearCountdown} title="Clear countdown">×</button>
                  </>
                )}
              </div>
            )}
            <div className="vx-phase-track">
              {PHASE_SEQUENCE.map((p) => {
                const active = p === flightPhase;
                const done = PHASE_SEQUENCE.indexOf(p) < PHASE_SEQUENCE.indexOf(flightPhase);
                return (
                  <span key={p} className={`vx-phase-step ${active ? "active" : done ? "done" : ""}`}>{p}</span>
                );
              })}
            </div>
          </div>

          {/* GO / NO-GO board */}
          <div className="vx-hdr-panel">
            <div className="vx-status-board">
              {([
                ["LINK", readiness.link],
                ["TELEM", readiness.telem],
                ["PWR", readiness.batt],
                ["GPS", readiness.gps],
                ["RF", readiness.rf],
              ] as Array<[string, GoState]>).map(([k, st]) => (
                <div key={k} className={`vx-status-cell vx-${st}`}>
                  <span className="k">{k}</span>
                  <span className="v"><span className={`vx-dot ${st === "go" || st === "crit" ? "" : ""}`} />{goStateText[st]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Telemetry readout strip + primary actions */}
        <div style={{ display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
          <div className="vx-readouts" style={{ flex: 1, minWidth: 320 }}>
            <Readout k="ALT" v={fmtUnit(display.latest?.alt_m, globalUnits, "alt")} />
            <Readout k="VEL" v={fmtUnit(display.latest?.vel_mps, globalUnits, "vel")} />
            {predApogeeM !== undefined ? (
              <Readout k="PRED AP" peak v={fmtUnit(predApogeeM, globalUnits, "alt")} />
            ) : touchdownEtaS !== undefined ? (
              <Readout
                k="TD ETA"
                peak
                v={{ value: `${Math.floor(touchdownEtaS / 60)}:${String(Math.floor(touchdownEtaS % 60)).padStart(2, "0")}`, unit: "min" }}
              />
            ) : (
              <Readout k="APOGEE" peak v={fmtUnit(peaks.apogeeM, globalUnits, "alt")} />
            )}
            <Readout k="MAX V" peak v={fmtUnit(peaks.maxVelMps, globalUnits, "vel")} />
            <Readout k="MAX G" peak v={peaks.maxAccelG !== undefined ? { value: peaks.maxAccelG.toFixed(1), unit: "g" } : { value: "—", unit: "" }} />
            <Readout k="RSSI" v={typeof linkHealth.rssi === "number" ? { value: String(linkHealth.rssi), unit: "dBm" } : { value: "—", unit: "" }} />
            <Readout k="RATE" v={{ value: String(telemetry.packetsPerSec), unit: "pkt/s" }} />
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {display.mode === "live" ? (
              <button className={`vx-btn ${frozen ? "vx-btn-danger" : ""}`} onClick={toggleFreeze} disabled={playback.mode === "playback"}>
                {frozen ? "● Frozen" : "Freeze"} (F)
              </button>
            ) : (
              <button className="vx-btn" onClick={exitPlayback}>Exit Playback</button>
            )}

            <button
              className={`vx-btn ${flightMode ? "vx-btn-danger" : "vx-btn-primary"}`}
              onClick={() => {
                if (!flightMode) setFlightModePersist(true);
                else {
                  const ok = window.confirm("Unlock layout? This enables dragging/resizing/adding/removing widgets.");
                  if (ok) setFlightModePersist(false);
                }
              }}
            >
              {flightMode ? "◆ Flight (Locked)" : "◇ Build Mode"}
            </button>

            <button className="vx-btn" onClick={() => setSettingsOpen(true)} title="Settings — display, vehicle, export, tools">Settings</button>
            <button className="vx-btn" onClick={() => setPaletteOpen(true)} title="Command Palette (Ctrl+K)">⌘K</button>
          </div>
        </div>
      </div>

      {/* Master Caution */}
      {cautionActive && (
        <div className="vx-caution-banner">
          <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
            <span className="vx-dot" style={{ width: 12, height: 12, background: "var(--vx-crit)", boxShadow: "0 0 12px var(--vx-crit-glow)" }} />
            <div style={{ minWidth: 0 }}>
              <div className="lbl">Master Caution</div>
              <div className="det" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {critAlerts.map((a) => a.title).join(" · ")}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="vx-btn vx-btn-danger" onClick={() => setAckedSig(critSig)} disabled={critSig === ackedSig} title="Acknowledge — silences the alarm for this caution">
              ACK
            </button>
            <button className={`vx-btn ${alarmMuted ? "vx-btn-danger" : ""}`} onClick={toggleAlarmMute} title="Master alarm mute">
              {alarmMuted ? "Muted" : "Audio"}
            </button>
          </div>
        </div>
      )}

      {/* Mission overview — live launch-profile model or the simple bar
          timeline, selectable in Settings → Display */}
      {missionView === "timeline" ? (
        <MissionTimelineBar events={derivedEvents} currentTms={display.t_ms} onJump={jumpToEvent} />
      ) : (
        <MissionModel
          events={derivedEvents}
          frames={display.frames}
          latest={display.latest}
          currentTms={display.t_ms}
          phase={flightPhase}
          onJump={jumpToEvent}
        />
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="vx-alertbar">
          {alerts.map((a) => (
            <div key={a.id} className={`vx-alert ${a.level}`}>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
                <span className={`vx-dot`} style={{ background: a.level === "crit" ? "var(--vx-crit)" : a.level === "warn" ? "var(--vx-caution)" : "var(--vx-accent)" }} />
                <div>
                  <div className="vx-alert-title">{a.title}</div>
                  {a.detail ? <div style={{ color: "var(--vx-fg-dim)", fontSize: 12, fontFamily: "var(--vx-font-mono)" }}>{a.detail}</div> : null}
                </div>
              </div>
              <button className="vx-btn" onClick={() => clearAlert(a.id)}>Dismiss</button>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar (left connect/add, right export/log/settings) */}
      <div className="vx-toolbar">
        <div className="vx-toolbar-left">
          <select
            className="vx-select"
            value={transportKind}
            onChange={(e) => setTransportKind(e.target.value as "simulator" | "serial")}
            disabled={playback.mode === "playback" || connStatus !== "disconnected"}
            title="Transport"
          >
            <option value="simulator">Simulator</option>
            <option value="serial">Serial{isTauri() ? " (native)" : isWebSerialSupported() ? "" : " (unsupported browser)"}</option>
          </select>

          {transportKind === "serial" && (
            <select
              className="vx-select"
              value={deviceProfile}
              onChange={(e) => { setDeviceProfile(e.target.value); setDeviceProfileState(e.target.value); }}
              title="Device / data format — how VX parses incoming lines"
            >
              {DEVICE_PROFILES.map((p) => (
                <option key={p.id} value={p.id} title={p.note}>{p.name}</option>
              ))}
            </select>
          )}

          {transportKind === "simulator" && (
            <button
              className="vx-btn"
              onClick={() => setSimSetupOpen(true)}
              disabled={connStatus !== "disconnected"}
              title="Configure the simulated flight — your rocket, motor, recovery, and the day's weather"
            >
              Sim Setup
            </button>
          )}

          {transportKind === "serial" && isTauri() && (
            <>
              <select
                className="vx-select"
                value={nativePort}
                onChange={(e) => setNativePort(e.target.value)}
                disabled={playback.mode === "playback" || connStatus !== "disconnected"}
                title="Native serial port"
              >
                <option value="" disabled>{nativePorts.length ? "Select port…" : "No ports — Refresh"}</option>
                {nativePorts.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button className="vx-btn" onClick={refreshNativePorts} disabled={connStatus !== "disconnected"} title="Scan for serial ports">
                Refresh
              </button>
            </>
          )}

          {transportKind === "serial" && (
            <select
              className="vx-select"
              value={String(baudRate)}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              disabled={playback.mode === "playback" || connStatus !== "disconnected"}
              title="Baud rate"
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>{b} baud</option>
              ))}
            </select>
          )}

          <button
            className="vx-btn vx-btn-primary"
            onClick={connect}
            disabled={playback.mode === "playback" || connStatus !== "disconnected"}
          >
            {connStatus === "connecting" ? "Connecting…" : "Connect"}
          </button>
          <button
            className="vx-btn"
            onClick={disconnect}
            disabled={playback.mode === "playback" || connStatus === "disconnected"}
          >
            Disconnect
          </button>
          <span className="vx-chip" title="Connection status">{connStatus.toUpperCase()}</span>
          {connStatus === "connected" && (
            <span className="vx-chip" title="Recording — session checkpointed to disk every 5 s" style={{ borderColor: "rgba(255,59,71,0.5)", color: "var(--vx-crit)" }}>
              <span className="vx-live-dot">●</span> REC
            </span>
          )}

          {/* Quick Add */}
          <select
            className="vx-select"
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value as WidgetId;
              if (!id) return;

              if (flightMode) {
                e.currentTarget.value = "";
                return;
              }

              const def: any = WIDGETS.find((x: any) => x.id === id);
              const requires = normalizeRequires(def?.requires);
              const enabled = requires.length === 0 || requires.every((req: string) => capHas(caps, req));
              if (!enabled) {
                e.currentTarget.value = "";
                return;
              }

              addWidget(id);
              e.currentTarget.value = "";
            }}
            disabled={flightMode}
            title={flightMode ? "Locked in Flight Mode" : "Add widget"}
          >
            <option value="" disabled>Add Widget…</option>
            {Object.entries(WIDGETS_BY_CATEGORY).map(([cat, defs]) => (
              <optgroup key={cat} label={cat}>
                {(defs as any[]).map((w: any) => {
                  const requires = normalizeRequires(w.requires);
                  const enabled = requires.length === 0 || requires.every((req: string) => capHas(caps, req));
                  return (
                    <option key={w.id} value={w.id} disabled={!enabled} title={w.hardwareHint ?? ""}>
                      {w.name}{enabled ? "" : " (needs hardware)"}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>

          {/* Layout presets */}
          <select
            className="vx-select"
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
            disabled={!isLayoutEditable}
            title="Load a saved dashboard layout"
          >
            <option value="" disabled>Layouts…</option>
            {layoutPresets.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button className="vx-btn" onClick={saveCurrentAsPreset} disabled={!isLayoutEditable} title="Save the current layout as a named preset">
            Save Layout
          </button>
          {selectedPreset && (
            <button className="vx-btn vx-btn-danger" onClick={deleteSelectedPreset} disabled={!isLayoutEditable} title={`Delete preset "${selectedPreset}"`}>
              ×
            </button>
          )}
        </div>

        <div className="vx-toolbar-right">
          <button
            className="vx-btn vx-btn-primary"
            onClick={() => { refreshFlights(); setFlightLogOpen(true); }}
            title="Browse saved flights"
          >
            Flight Log{flights.length ? ` (${flights.length})` : ""}
          </button>
          {ghostFlight && (
            <span className="vx-chip" style={{ borderColor: "var(--vx-accent)", color: "var(--vx-accent-bright)" }} title="Comparison overlay active on all plots">
              GHOST: {ghostFlight.name.slice(0, 24)}
              <button
                onClick={() => setGhostFlight(null)}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", marginLeft: 4 }}
                title="Remove overlay"
              >
                ×
              </button>
            </span>
          )}
          <button className="vx-btn" onClick={() => setExportOpen(true)} title="Export flight data — choose a file format">Export</button>

          <label className="vx-btn" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Load Log
            <input
              type="file"
              accept=".jsonl,.txt,.log"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onLoadLogFile(f);
                e.currentTarget.value = "";
              }}
            />
          </label>

          {/* Playback controls */}
          {playback.mode === "playback" && playback.frames.length > 0 && (
            <>
              <button className="vx-btn vx-btn-primary" onClick={() => setPlayback((p) => ({ ...p, playing: !p.playing }))}>
                {playback.playing ? "Pause" : "Play"}
              </button>

              <select className="vx-select" value={String(playback.speed)} onChange={(e) => setPlayback((p) => ({ ...p, speed: Number(e.target.value) }))}>
                <option value="0.25">0.25×</option>
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>

              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 420 }}>
                <span className="vx-chip">{playback.idx + 1}/{playback.frames.length}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, playback.frames.length - 1)}
                  value={playback.idx}
                  onChange={(e) => setPlayback((p) => ({ ...p, idx: Number(e.target.value), playing: false }))}
                  style={{ width: 300 }}
                />
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {derivedEvents.map((e) => (
                  <button key={e.id} className="vx-btn" onClick={() => jumpToEvent(e.id)} title={e.label}>
                    {e.id}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main dashboard */}
      <div className="vx-shell" onContextMenu={(e) => openMenuAt(e)}>
        <div ref={gridHostRef}>
        <RGL
          {...({
            className: "layout",
            layout: rglLayout,
            cols: GRID_COLS,
            rowHeight: 30,
            width: gridWidth,
            margin: [10, 10],
            containerPadding: [0, 0],
            compactType: "vertical",
            preventCollision: false, // dragging pushes neighbors out of the way instead of blocking
            draggableHandle: ".vx-titlebar",
            draggableCancel: "button, select, input, textarea, label, a",
            resizeHandles: isLayoutEditable ? ["se", "s", "e", "n", "w", "ne", "nw", "sw"] : [],
            isDraggable: isLayoutEditable,
            isResizable: isLayoutEditable,
            onLayoutChange: (nextLayout: any) => {
              if (!isLayoutEditable) return;
              // Strip the render-time pin override before persisting.
              const base = (nextLayout as any[]).map(({ static: _s, ...rest }) => rest) as Layout;
              setLayout(base);
              persist(instances, base);
            },
          } as any)}
        >
          {instances.map((inst) => (
            <div key={inst.key} onContextMenu={(e) => openMenuAt(e, inst.key)}>
              <WidgetFrame
                instKey={inst.key}
                widgetId={inst.widgetId}
                telemetry={{ frames: display.frames, rawLines: display.rawLines }}
                latest={display.latest}
                caps={caps}
                globalUnits={globalUnits}
                settings={widgetSettings[inst.key]}
                locked={!isLayoutEditable} // locked in flight + playback
                pinned={pinnedWidgets.has(inst.key)}
                connected={connStatus === "connected"}
                allFrames={sourceFrames}
                seenVids={seenVids}
                theme={theme}
                onPatchSettings={(patch) => saveWidgetSettings(inst.key, patch)}
                onResetAccent={() => resetWidgetAccent(inst.key)}
                onTogglePin={() => toggleWidgetPin(inst.key)}
                onSendCommand={sendCommand}
                onRemove={() => removeWidget(inst.key)}
                onHelp={() => setHelpWidget(inst.widgetId)}
              />
            </div>
          ))}
        </RGL>
        </div>
      </div>

      {/* Context Menu */}
      {menu.open && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          hasWidget={!!menu.widgetKey}
          locked={!isLayoutEditable}
          onClose={closeMenu}
          onAdvancedAdd={() => {
            closeMenu();
            if (isLayoutEditable) setAdvancedOpen(true);
          }}
          onRemoveWidget={() => {
            if (menu.widgetKey) removeWidget(menu.widgetKey);
            closeMenu();
          }}
          onExportJSONL={() => {
            exportSessionJSONL();
            closeMenu();
          }}
          onExportCSV={() => {
            exportFramesCSV();
            closeMenu();
          }}
          onOpenSettings={() => {
            closeMenu();
            setSettingsOpen(true);
          }}
        />
      )}

      {/* Advanced Add Widget Modal */}
      {advancedOpen && (
        <AdvancedAddModal
          latest={display.latest}
          caps={caps}
          globalUnits={globalUnits}
          onClose={() => setAdvancedOpen(false)}
          onAdd={(id, w, h, unitsOverride, accentOverride, viewOverride) => {
            const key = addWidget(id, w, h);
            if (key) {
              saveWidgetSettings(key, { units: unitsOverride ?? undefined, accent: accentOverride ?? undefined, view: viewOverride ?? undefined });
            }
            setAdvancedOpen(false);
          }}
        />
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal
          theme={theme}
          battProfile={battProfile}
          globalUnits={globalUnits}
          onClose={() => setSettingsOpen(false)}
          onTheme={(p) => saveTheme(p)}
          onThemePreset={(t) => {
            setTheme(t);
            localStorage.setItem("vx.theme", JSON.stringify(t));
          }}
          onThemeReset={resetTheme}
          onBatt={(p) => saveBattProfile(p)}
          onUnits={(u) => saveGlobalUnits(u)}
          voiceOn={voiceOn}
          onToggleVoice={toggleVoice}
          fieldMode={fieldMode}
          onToggleFieldMode={toggleFieldMode}
          uiZoom={uiZoom}
          onZoom={adjustZoom}
          onZoomReset={resetZoom}
          alarmMuted={alarmMuted}
          onToggleAlarmMute={toggleAlarmMute}
          alertRuleCount={alertRules.length}
          missionView={missionView}
          onMissionView={saveMissionView}
          docsUrl={docsUrl}
          onDocsUrl={saveDocsUrl}
          onOpenTemplates={() => { setSettingsOpen(false); setOnboardOpen(true); }}
          onOpenExport={() => setExportOpen(true)}
          onOpenVehicle={() => setVehicleOpen(true)}
          onOpenAlertRules={() => setAlertRulesOpen(true)}
          onOpenRadio={() => setRadioOpen(true)}
          onOpenFieldMap={() => setFieldMapOpen(true)}
        />
      )}

      {/* Export Modal — asks which file format, then writes it */}
      {exportOpen && (
        <ExportModal
          frameCount={display.frames.length}
          rawCount={logCount}
          hasGps={display.frames.some((f) => typeof f.lat === "number" && typeof f.lon === "number")}
          onClose={() => setExportOpen(false)}
          onExport={(fmt) => {
            if (fmt === "jsonl") exportSessionJSONL();
            else if (fmt === "csv") exportFramesCSV();
            else if (fmt === "kml") exportKML();
            else if (fmt === "gpx") exportGPX();
            else if (fmt === "report") openFlightReport();
            else if (fmt === "share") {
              const sf = toShareFlight("VX flight", display.frames);
              downloadTextFile("vx-flight-replay.html", buildReplayHTML(sf), "text/html");
            }
            setExportOpen(false);
          }}
        />
      )}

      {/* Widget help — connection, troubleshooting, and the operator's docs link */}
      {helpWidget && (
        <WidgetHelpModal widgetId={helpWidget} docsUrl={docsUrl} onClose={() => setHelpWidget(null)} />
      )}

      {/* First-run onboarding / template picker */}
      {onboardOpen && (
        <OnboardingModal
          onPick={applyTemplate}
          onClose={dismissOnboarding}
        />
      )}

      {/* Vehicle Modal */}
      {vehicleOpen && <VehicleModal onClose={() => setVehicleOpen(false)} />}

      {/* Field Map Modal */}
      {fieldMapOpen && <FieldMapModal onClose={() => setFieldMapOpen(false)} />}

      {/* Alert Rules Modal */}
      {alertRulesOpen && (
        <AlertRulesModal rules={alertRules} onChange={updateAlertRules} onClose={() => setAlertRulesOpen(false)} />
      )}

      {/* Sim Setup Modal */}
      {simSetupOpen && <SimSetupModal onClose={() => setSimSetupOpen(false)} />}

      {/* Radio Config Modal */}
      {radioOpen && (
        <RadioModal connected={connStatus === "connected"} onSend={sendCommand} onClose={() => setRadioOpen(false)} />
      )}

      {/* Command Palette */}
      {paletteOpen && (
        <CommandPalette
          locked={!isLayoutEditable}
          onClose={() => setPaletteOpen(false)}
          onOpenSettings={() => {
            setPaletteOpen(false);
            setSettingsOpen(true);
          }}
          onToggleMode={() => {
            setPaletteOpen(false);
            if (!flightMode) setFlightModePersist(true);
            else {
              const ok = window.confirm("Unlock layout? This enables dragging/resizing/adding/removing widgets.");
              if (ok) setFlightModePersist(false);
            }
          }}
          onExportJSONL={() => {
            setPaletteOpen(false);
            exportSessionJSONL();
          }}
          onExportCSV={() => {
            setPaletteOpen(false);
            exportFramesCSV();
          }}
        />
      )}

      {/* Flight Log Modal */}
      {flightLogOpen && (
        <FlightLogModal
          flights={flights}
          onClose={() => setFlightLogOpen(false)}
          onLoad={loadFlightFromLog}
          onOverlay={overlayFlightFromLog}
          onDelete={deleteFlightFromLog}
          onShare={shareFlightFromLog}
        />
      )}

      {/* Share dialog — download an HTML replay or copy a shareable link */}
      {shareData && <ShareModal flight={shareData} onClose={() => setShareData(null)} />}
    </div>
  );
}

/** ---------- FlightLogModal ---------- */
function FlightLogModal(props: {
  flights: FlightMeta[];
  onClose: () => void;
  onLoad: (id: string) => void;
  onOverlay: (id: string) => void;
  onDelete: (id: string) => void;
  onShare: (id: string) => void;
}) {
  function fmtDur(ms?: number) {
    if (typeof ms !== "number") return "—";
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  }
  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="vx-modal"
        style={{ gridTemplateColumns: "1fr", height: "min(640px, 82vh)", width: "min(820px, 92vw)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100%", overflow: "hidden" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--vx-line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Flight Log</div>
              <div className="vx-label" style={{ marginTop: 4 }}>{props.flights.length} archived flight{props.flights.length === 1 ? "" : "s"} · stored locally</div>
            </div>
            <button className="vx-btn" onClick={props.onClose}>Close</button>
          </div>

          <div style={{ overflow: "auto", padding: 14 }}>
            {props.flights.length === 0 ? (
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--vx-fg-faint)", textAlign: "center" }}>
                <div>
                  <div className="vx-label" style={{ fontSize: 12 }}>No saved flights yet</div>
                  <div style={{ fontSize: 12, marginTop: 8, color: "var(--vx-fg-dim)" }}>
                    Flights are archived automatically when you disconnect.
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {props.flights.map((f) => (
                  <div key={f.id} className="vx-card" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                      <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap", fontFamily: "var(--vx-font-mono)", fontSize: 12, color: "var(--vx-fg-dim)" }}>
                        <span>APOGEE <b style={{ color: "var(--vx-go)" }}>{typeof f.apogeeM === "number" ? `${f.apogeeM.toFixed(0)} m` : "—"}</b></span>
                        <span>DUR <b style={{ color: "var(--vx-fg)" }}>{fmtDur(f.durationMs)}</b></span>
                        <span>FRAMES <b style={{ color: "var(--vx-fg)" }}>{f.frameCount}</b></span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="vx-btn vx-btn-primary" onClick={() => props.onLoad(f.id)}>Load</button>
                      <button className="vx-btn" onClick={() => props.onShare(f.id)} title="Share this flight — download an HTML replay or copy a link">Share</button>
                      <button className="vx-btn" onClick={() => props.onOverlay(f.id)} title="Draw this flight as a dashed reference trace on every plot, liftoff-aligned">Overlay</button>
                      <button
                        className="vx-btn vx-btn-danger"
                        onClick={() => { if (window.confirm(`Delete flight "${f.name}"? This cannot be undone.`)) props.onDelete(f.id); }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- ShareModal ----------
 * Turn an archived flight into a shareable artifact: a self-contained HTML
 * replay (works offline, send it anywhere) or a compact link that opens VX
 * straight into playback. No backend — the link carries the (downsampled,
 * gzipped) flight in its hash. */
function ShareModal(props: { flight: ShareFlight; onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; chars: number; tooBig: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkErr, setLinkErr] = useState(false);

  useEffect(() => {
    encodeShareLink(props.flight).then(setLink).catch(() => setLinkErr(true));
  }, [props.flight]);

  function downloadHTML() {
    const html = buildReplayHTML(props.flight);
    const safe = props.flight.name.replace(/[^\w.-]+/g, "_").slice(0, 40) || "flight";
    downloadTextFile(`${safe}-replay.html`, html, "text/html");
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link:", link.url);
    }
  }

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal vx-help-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-settings-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Share flight</div>
            <div className="vx-help" style={{ marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.flight.name}</div>
          </div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div className="vx-settings-body">
          <div className="vx-card">
            <div className="vx-card-title">Replay file (recommended)</div>
            <div className="vx-help">
              A self-contained HTML page with an interactive replay — charts, ground track, event
              timeline, and a scrubber. Works offline; host it or send the file. Best for any flight.
            </div>
            <button className="vx-btn vx-btn-primary" style={{ marginTop: 10 }} onClick={downloadHTML}>
              Download replay (HTML)
            </button>
          </div>

          <div className="vx-card">
            <div className="vx-card-title">Shareable link</div>
            <div className="vx-help">
              The flight is packed into the link itself (no server). Great for a quick forum or chat
              share; long flights are downsampled to fit.
            </div>
            {linkErr ? (
              <div style={{ fontSize: 12, color: "var(--vx-caution)", marginTop: 10 }}>Couldn't build a link on this browser — use the HTML file.</div>
            ) : !link ? (
              <div className="vx-help" style={{ marginTop: 10 }}>Building link…</div>
            ) : (
              <>
                <input className="vx-input" style={{ marginTop: 10 }} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <button className="vx-btn" onClick={copyLink}>{copied ? "Copied ✓" : "Copy link"}</button>
                  <span className="vx-help">{(link.chars / 1000).toFixed(1)} kB{link.tooBig ? " · long — the HTML file is more reliable" : ""}</span>
                </div>
                {link.tooBig && (
                  <div style={{ fontSize: 12, color: "var(--vx-caution)", marginTop: 8 }}>
                    This link is long and some apps may truncate it. Prefer the HTML replay for this flight.
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="vx-settings-foot">
          <button className="vx-btn" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** ---------- ContextMenu ---------- */
function ContextMenu(props: {
  x: number;
  y: number;
  hasWidget: boolean;
  locked: boolean;
  onClose: () => void;
  onAdvancedAdd: () => void;
  onRemoveWidget: () => void;
  onExportJSONL: () => void;
  onExportCSV: () => void;
  onOpenSettings: () => void;
}) {
  const left = Math.min(props.x, window.innerWidth - 280);
  const top = Math.min(props.y, window.innerHeight - 280);

  return (
    <div className="vx-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {!props.locked && (
        <div className="vx-menu-item" onClick={props.onAdvancedAdd}>
          <div>
            <div style={{ fontWeight: 900 }}>Add widget (advanced)…</div>
            <div className="vx-menu-muted">Preview, size, requirements, units, view, color</div>
          </div>
          <div className="vx-chip">↵</div>
        </div>
      )}

      {props.hasWidget && !props.locked && (
        <div className="vx-menu-item" onClick={props.onRemoveWidget}>
          <div>
            <div style={{ fontWeight: 900 }}>Remove widget</div>
            <div className="vx-menu-muted">Deletes this widget from layout</div>
          </div>
          <div className="vx-chip">⌫</div>
        </div>
      )}

      <div className="vx-menu-item" onClick={props.onExportJSONL}>
        <div>
          <div style={{ fontWeight: 900 }}>Export JSONL</div>
          <div className="vx-menu-muted">Raw telemetry session</div>
        </div>
      </div>

      <div className="vx-menu-item" onClick={props.onExportCSV}>
        <div>
          <div style={{ fontWeight: 900 }}>Export CSV</div>
          <div className="vx-menu-muted">Parsed frames table</div>
        </div>
      </div>

      <div className="vx-menu-item" onClick={props.onOpenSettings}>
        <div>
          <div style={{ fontWeight: 900 }}>Settings</div>
          <div className="vx-menu-muted">Theme, units, battery, 3D model</div>
        </div>
      </div>

      <div className="vx-menu-item" onClick={props.onClose}>
        <div>
          <div style={{ fontWeight: 900 }}>Close</div>
          <div className="vx-menu-muted">Esc</div>
        </div>
      </div>
    </div>
  );
}

/** Tiny inline thrust-curve preview for an imported motor. */
function ThrustCurveSpark(props: { curve: Array<[number, number]> }) {
  const c = props.curve;
  const tMax = c[c.length - 1][0] || 1;
  const fMax = Math.max(...c.map((p) => p[1])) || 1;
  const W = 240, H = 46, pad = 3;
  const x = (t: number) => pad + (t / tMax) * (W - 2 * pad);
  const y = (f: number) => H - pad - (f / fMax) * (H - 2 * pad);
  const d = c.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(" ");
  return (
    <div title={`Peak ${Math.round(fMax)} N over ${tMax.toFixed(2)} s`} style={{ border: "1px solid var(--vx-line)", borderRadius: 3, background: "rgba(0,0,0,0.2)", padding: 4 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 46, display: "block" }} role="img" aria-label="Thrust curve">
        <path d={`${d} L${x(tMax).toFixed(1)} ${H - pad} L${x(0)} ${H - pad} Z`} fill="var(--vx-accent-glow)" stroke="none" />
        <path d={d} fill="none" stroke="var(--vx-accent-bright)" strokeWidth="1.2" />
      </svg>
      <div style={{ fontSize: 10, color: "var(--vx-fg-faint)", fontFamily: "var(--vx-font-mono)", textAlign: "center" }}>
        peak {Math.round(fMax)} N · {tMax.toFixed(2)} s
      </div>
    </div>
  );
}

/** ---------- SimSetupModal — flight simulation configuration ---------- */
function SimNum(props: { label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string; hint?: string }) {
  return (
    <label style={{ display: "grid", gap: 4 }} title={props.hint}>
      <span className="vx-label">{props.label}{props.unit ? ` (${props.unit})` : ""}</span>
      <input
        className="vx-input"
        type="number"
        step={props.step ?? "any"}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function SimSetupModal(props: { onClose: () => void }) {
  const [prof, setProf] = useState<SimProfile>(() => loadSimProfile());
  const [userMotors, setUserMotors] = useState<MotorSpec[]>(() => getUserMotors());
  const [importMsg, setImportMsg] = useState<string>("");
  const allMotors = useMemo(() => [...userMotors, ...MOTORS], [userMotors]);
  const isCustomMotor = !allMotors.some((m) => m.name === prof.motor.name);

  async function importMotorFile(file: File) {
    setImportMsg(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const motors = /\.rse$/i.test(file.name) ? parseRse(text) : [parseEng(text)];
      const merged = addUserMotors(motors);
      setUserMotors(merged);
      update({ motor: { ...motors[0] } }); // select the first imported motor
      setImportMsg(`Imported ${motors.length} motor${motors.length === 1 ? "" : "s"} · real thrust curve loaded`);
    } catch (e: any) {
      setImportMsg(e?.message ?? "import failed");
    }
  }

  async function importOrkFile(file: File) {
    setImportMsg(`Reading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const r = await parseOrk(buf);
      update({
        name: r.name ?? prof.name,
        rocket: { ...prof.rocket, ...(r.diameterMm ? { diameterMm: r.diameterMm } : {}), ...(r.dryKg ? { dryKg: r.dryKg } : {}) },
      });
      setImportMsg(r.note + (r.motorDesignation ? ` Motor in design: ${r.motorDesignation} — import its .eng for the real curve.` : ""));
    } catch (e: any) {
      setImportMsg(e?.message ?? "import failed");
    }
  }

  function update(patch: Partial<SimProfile>) {
    setProf((prev) => {
      const next: SimProfile = {
        ...prev,
        ...patch,
        rocket: { ...prev.rocket, ...(patch.rocket ?? {}) },
        motor: { ...prev.motor, ...(patch.motor ?? {}) },
        recovery: { ...prev.recovery, ...(patch.recovery ?? {}) },
        env: { ...prev.env, ...(patch.env ?? {}) },
      };
      saveSimProfile(next);
      return next;
    });
  }

  const pred = useMemo(() => {
    try { return simulatePreflight(prof); } catch { return null; }
  }, [prof]);

  const m2ft = (m: number) => `${m.toFixed(0)} m / ${(m * 3.28084).toFixed(0)} ft`;
  const compass = (b: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8];

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(920px, 96vw)", maxHeight: "90vh", overflow: "auto",
          background: "rgba(17, 17, 18,0.98)", border: "1px solid var(--vx-line-strong)",
          borderRadius: 4, boxShadow: "0 22px 70px rgba(0,0,0,0.75)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Flight Simulation Setup</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 14 }}>
          Model <b style={{ color: "var(--vx-fg)" }}>your</b> rocket on <b style={{ color: "var(--vx-fg)" }}>your</b> launch day. The Simulator
          transport flies this profile with real physics (thrust, mass depletion, drag against the day\u2019s air density, wind drift) —
          predictions update live as you tune it.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Left column: vehicle + recovery */}
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <div className="vx-card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="vx-label">Rocket</div>
                <label className="vx-btn" style={{ padding: "4px 10px", fontSize: 11 }} title="Import geometry from an OpenRocket .ork design (diameter, mass override, motor)">
                  Import .ork
                  <input type="file" accept=".ork" style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) importOrkFile(f); e.currentTarget.value = ""; }} />
                </label>
              </div>
              <input className="vx-input" value={prof.name} onChange={(e) => update({ name: e.target.value })} placeholder="Vehicle name" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SimNum label="Dry mass" unit="kg" step={0.1} value={prof.rocket.dryKg} onChange={(v) => update({ rocket: { ...prof.rocket, dryKg: v } })} hint="Mass without propellant" />
                <SimNum label="Diameter" unit="mm" step={1} value={prof.rocket.diameterMm} onChange={(v) => update({ rocket: { ...prof.rocket, diameterMm: v } })} />
                <SimNum label="Cd" step={0.05} value={prof.rocket.cd} onChange={(v) => update({ rocket: { ...prof.rocket, cd: v } })} hint="Drag coefficient — typical HPR 0.4–0.6" />
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--vx-fg-dim)" }}>
                <input type="checkbox" checked={prof.twoStage} onChange={(e) => update({ twoStage: e.target.checked })} />
                Two-stage (booster separates at burnout on its own tracker)
              </label>
            </div>

            <div className="vx-card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="vx-label">Motor</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <label className="vx-btn" style={{ padding: "4px 10px", fontSize: 11 }} title="Import a RASP .eng or RockSim .rse thrust curve (from thrustcurve.org)">
                    Import .eng/.rse
                    <input type="file" accept=".eng,.rse" style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) importMotorFile(f); e.currentTarget.value = ""; }} />
                  </label>
                </div>
              </div>
              <select
                className="vx-select"
                value={isCustomMotor ? "__custom" : prof.motor.name}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom") update({ motor: { ...prof.motor, name: "Custom", curve: undefined } });
                  else {
                    const m = allMotors.find((x) => x.name === v)!;
                    update({ motor: { ...m } });
                  }
                }}
              >
                {userMotors.length > 0 && (
                  <optgroup label="Imported (real thrust curve)">
                    {userMotors.map((m) => (
                      <option key={m.name} value={m.name}>{m.name} — {m.impulseNs} Ns ✓</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Built-in (approx)">
                  {MOTORS.map((m) => (
                    <option key={m.name} value={m.name}>{m.name} — {m.impulseNs} Ns</option>
                  ))}
                </optgroup>
                <option value="__custom">Custom…</option>
              </select>
              {prof.motor.curve && prof.motor.curve.length > 1 && (
                <ThrustCurveSpark curve={prof.motor.curve} />
              )}
              {importMsg && (
                <div style={{ fontSize: 11, color: "var(--vx-caution)", fontFamily: "var(--vx-font-mono)" }}>{importMsg}</div>
              )}
              {isCustomMotor && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <SimNum label="Total impulse" unit="Ns" step={10} value={prof.motor.impulseNs} onChange={(v) => update({ motor: { ...prof.motor, impulseNs: v, avgThrustN: prof.motor.burnS > 0 ? v / prof.motor.burnS : prof.motor.avgThrustN } })} />
                  <SimNum label="Burn time" unit="s" step={0.1} value={prof.motor.burnS} onChange={(v) => update({ motor: { ...prof.motor, burnS: v, avgThrustN: v > 0 ? prof.motor.impulseNs / v : prof.motor.avgThrustN } })} />
                  <SimNum label="Avg thrust" unit="N" step={5} value={prof.motor.avgThrustN} onChange={(v) => update({ motor: { ...prof.motor, avgThrustN: v } })} />
                  <SimNum label="Propellant" unit="kg" step={0.01} value={prof.motor.propKg} onChange={(v) => update({ motor: { ...prof.motor, propKg: v } })} />
                </div>
              )}
            </div>

            <div className="vx-card" style={{ display: "grid", gap: 10 }}>
              <div className="vx-label">Recovery</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SimNum label="Drogue rate" unit="m/s" step={1} value={prof.recovery.drogueDescentMps} onChange={(v) => update({ recovery: { ...prof.recovery, drogueDescentMps: v } })} />
                <SimNum label="Main rate" unit="m/s" step={0.5} value={prof.recovery.mainDescentMps} onChange={(v) => update({ recovery: { ...prof.recovery, mainDescentMps: v } })} />
                <SimNum label="Main deploy" unit="m AGL" step={10} value={prof.recovery.mainDeployAltM} onChange={(v) => update({ recovery: { ...prof.recovery, mainDeployAltM: v } })} />
              </div>
            </div>

            <div className="vx-card" style={{ display: "grid", gap: 10 }}>
              <div className="vx-label">Launch day · site & weather</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SEASON_PRESETS.map((sp) => (
                  <button
                    key={sp.name}
                    className={`vx-btn ${prof.env.month === sp.month ? "vx-btn-primary" : ""}`}
                    onClick={() => update({ env: { ...prof.env, month: sp.month, tempC: sp.tempC } })}
                    title={`${sp.name}: ${sp.tempC} °C surface`}
                  >
                    {sp.name}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SimNum label="Pad elev" unit="m MSL" step={10} value={prof.env.padAltM} onChange={(v) => update({ env: { ...prof.env, padAltM: v } })} hint="Higher pad + hotter day = thinner air = higher apogee" />
                <SimNum label="Temp" unit="°C" step={1} value={prof.env.tempC} onChange={(v) => update({ env: { ...prof.env, tempC: v } })} />
                <SimNum label="Wind" unit="m/s" step={0.5} value={prof.env.windMps} onChange={(v) => update({ env: { ...prof.env, windMps: v } })} />
                <SimNum label="Wind from" unit="°" step={5} value={prof.env.windDirDeg} onChange={(v) => update({ env: { ...prof.env, windDirDeg: ((v % 360) + 360) % 360 } })} hint="Meteorological: direction the wind blows FROM" />
                <SimNum label="Pad lat" step={0.0001} value={prof.env.padLat} onChange={(v) => update({ env: { ...prof.env, padLat: v } })} />
                <SimNum label="Pad lon" step={0.0001} value={prof.env.padLon} onChange={(v) => update({ env: { ...prof.env, padLon: v } })} />
              </div>
            </div>
          </div>

          {/* Right column: live predictions + recovery plan */}
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <div className="vx-card" style={{ display: "grid", gap: 10 }}>
              <div className="vx-label">Predicted flight — this rocket, this day</div>
              {pred ? (
                pred.failsToLift ? (
                  <div style={{ color: "var(--vx-crit)", fontWeight: 700, letterSpacing: "0.08em", fontSize: 13 }}>
                    WILL NOT LIFT — thrust/weight {pred.thrustToWeight.toFixed(2)} ≤ 1. Bigger motor or lighter rocket.
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontFamily: "var(--vx-font-mono)", fontSize: 13 }}>
                    <div><span className="vx-label">APOGEE</span><br /><b style={{ fontSize: 20, color: "var(--vx-accent-bright)" }}>{m2ft(pred.apogeeM)}</b></div>
                    <div><span className="vx-label">MAX VELOCITY</span><br /><b style={{ fontSize: 20 }}>{pred.maxVelMps.toFixed(0)} m/s{pred.maxMach >= 0.3 ? ` · M${pred.maxMach.toFixed(2)}` : ""}</b></div>
                    <div><span className="vx-label">MAX ACCEL</span><br /><b>{pred.maxAccelG.toFixed(1)} g</b></div>
                    <div>
                      <span className="vx-label">THRUST/WEIGHT</span><br />
                      <b style={{ color: pred.thrustToWeight < 3 ? "var(--vx-crit)" : pred.thrustToWeight < 5 ? "var(--vx-caution)" : "var(--vx-go)" }}>
                        {pred.thrustToWeight.toFixed(1)} {pred.thrustToWeight < 5 ? "· rail-exit caution" : ""}
                      </b>
                    </div>
                    <div><span className="vx-label">TO APOGEE</span><br /><b>{pred.apogeeS.toFixed(1)} s</b></div>
                    <div><span className="vx-label">TOTAL FLIGHT</span><br /><b>{(pred.flightS / 60).toFixed(1)} min</b></div>
                    <div><span className="vx-label">BURNOUT ALT</span><br /><b>{m2ft(pred.burnoutAltM)}</b></div>
                  </div>
                )
              ) : (
                <div style={{ color: "var(--vx-fg-faint)", fontSize: 12 }}>Prediction unavailable — check inputs.</div>
              )}
            </div>

            {pred && !pred.failsToLift && (
              <div className="vx-card" style={{ display: "grid", gap: 10 }}>
                <div className="vx-label">Recovery plan — where it lands</div>
                <div style={{ fontFamily: "var(--vx-font-mono)", fontSize: 13 }}>
                  Drift <b style={{ color: "var(--vx-caution)", fontSize: 18 }}>{m2ft(pred.driftM)}</b> at{" "}
                  <b>{pred.driftBearingDeg.toFixed(0)}° {compass(pred.driftBearingDeg)}</b> of the pad
                </div>
                <div style={{ fontFamily: "var(--vx-font-mono)", fontSize: 12, color: "var(--vx-fg-dim)" }}>
                  Predicted landing: {pred.landLat.toFixed(5)}, {pred.landLon.toFixed(5)}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <a
                    className="vx-btn vx-btn-primary"
                    style={{ textDecoration: "none" }}
                    href={recoveryRouteUrl(prof.env.padLat, prof.env.padLon, pred.landLat, pred.landLon)}
                    target="_blank"
                    rel="noreferrer"
                    title="Walking directions from your pad to the predicted landing point — rehearse the recovery"
                  >
                    Rehearse recovery route in Google Maps
                  </a>
                  <a
                    className="vx-btn"
                    style={{ textDecoration: "none" }}
                    href={`https://www.google.com/maps/search/?api=1&query=${pred.landLat.toFixed(6)},${pred.landLon.toFixed(6)}`}
                    target="_blank"
                    rel="noreferrer"
                    title="View the predicted landing area (satellite view for terrain)"
                  >
                    Landing area ↗
                  </a>
                </div>
                <div style={{ fontSize: 11, color: "var(--vx-fg-faint)" }}>
                  Re-run with the day\u2019s forecast wind before you fly — same rocket, different day, different walk.
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: "var(--vx-fg-faint)" }}>
              Saved automatically. The Simulator transport flies this profile on the next Connect — telemetry, events, GPS
              track, and landing point will match these predictions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- RadioModal — SiK/RFD900-family radio configuration ---------- */
function RadioModal(props: { connected: boolean; onSend: (cmd: string) => void; onClose: () => void }) {
  const [netId, setNetId] = useState("25");
  const [airSpeed, setAirSpeed] = useState("64");
  const [txPower, setTxPower] = useState("20");
  const [custom, setCustom] = useState("");
  const { connected, onSend } = props;

  function Btn({ cmd, label, title }: { cmd: string; label: string; title?: string }) {
    return (
      <button className="vx-btn" disabled={!connected} onClick={() => onSend(cmd)} title={title ?? `Send ${cmd}`}>
        {label}
      </button>
    );
  }

  function ParamRow({ label, reg, value, setValue, hint }: { label: string; reg: number; value: string; setValue: (v: string) => void; hint: string }) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "110px 1fr auto auto", gap: 8, alignItems: "center" }}>
        <span className="vx-label" title={hint}>{label}</span>
        <input className="vx-input" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))} />
        <button className="vx-btn" disabled={!connected || !value} onClick={() => onSend(`ATS${reg}=${value}`)} title={`ATS${reg}=${value}`}>Set</button>
        <button className="vx-btn" disabled={!connected} onClick={() => onSend(`ATS${reg}?`)} title={`Read current value (ATS${reg}?)`}>Read</button>
      </div>
    );
  }

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 94vw)", maxHeight: "86vh", overflow: "auto",
          background: "rgba(17, 17, 18,0.98)", border: "1px solid var(--vx-line-strong)",
          borderRadius: 4, boxShadow: "0 22px 70px rgba(0,0,0,0.75)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Radio Config</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 12 }}>
          For SiK / RFD900-family telemetry radios (RFD900x, HM-TRP, mRo SiK). Commands go out the serial TX line;
          <b style={{ color: "var(--vx-fg)" }}> responses appear in the Raw Console</b>. Enter command mode first —
          both radios of a pair must share NETID and air speed.
          {!connected && <div style={{ color: "var(--vx-caution)", marginTop: 6 }}>Not connected — connect a transport to send commands.</div>}
        </div>

        <div className="vx-card">
          <div className="vx-label" style={{ marginBottom: 8 }}>Command mode</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn cmd="+++" label="+++ Enter" title="Enter AT command mode (radio expects 1 s of silence around it)" />
            <Btn cmd="ATO" label="Exit" title="Leave command mode (ATO)" />
            <Btn cmd="AT&W" label="Save" title="Write parameters to EEPROM (AT&W)" />
            <Btn cmd="ATZ" label="Reboot" title="Reboot radio (ATZ) — applies saved parameters" />
          </div>
        </div>

        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Query</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn cmd="ATI" label="Version" />
            <Btn cmd="ATI5" label="All Parameters" />
            <Btn cmd="ATI7" label="Link Report" title="RSSI / noise / packet stats (ATI7)" />
          </div>
        </div>

        <div className="vx-card" style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <div className="vx-label">Set parameters</div>
          <ParamRow label="NETID (S3)" reg={3} value={netId} setValue={setNetId} hint="Network ID — both radios must match (0–499)" />
          <ParamRow label="AIR SPEED (S2)" reg={2} value={airSpeed} setValue={setAirSpeed} hint="Air data rate kbps (4–250). Lower = more range" />
          <ParamRow label="TX POWER (S4)" reg={4} value={txPower} setValue={setTxPower} hint="Transmit power dBm (0–30, check local regs)" />
          <div style={{ fontSize: 11, color: "var(--vx-fg-faint)" }}>Set → Save → Reboot to apply. Change the remote radio first or you'll lose the link.</div>
        </div>

        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Custom command</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="vx-input"
              style={{ flex: 1, fontFamily: "var(--vx-font-mono)" }}
              placeholder="e.g. ATS8?"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && custom.trim() && connected) { onSend(custom.trim()); setCustom(""); } }}
            />
            <button className="vx-btn" disabled={!connected || !custom.trim()} onClick={() => { onSend(custom.trim()); setCustom(""); }}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- AlertRulesModal — custom telemetry thresholds ---------- */
function AlertRulesModal(props: { rules: AlertRule[]; onChange: (rules: AlertRule[]) => void; onClose: () => void }) {
  const { rules } = props;

  function setRule(i: number, patch: Partial<AlertRule>) {
    props.onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRule() {
    props.onChange([
      ...rules,
      { id: String(Date.now()), field: "batt_v", op: "<", value: 7.0, level: "warn", title: "" },
    ]);
  }

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 94vw)", maxHeight: "86vh", overflow: "auto",
          background: "rgba(17, 17, 18,0.98)", border: "1px solid var(--vx-line-strong)",
          borderRadius: 4, boxShadow: "0 22px 70px rgba(0,0,0,0.75)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Alert Rules</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 12 }}>
          Fire a caution (yellow) or critical (red, triggers master-caution alarm) when a telemetry field crosses a
          threshold. Evaluated live on every update.
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {rules.map((r, i) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1.2fr auto 0.8fr 0.9fr 1.4fr auto", gap: 8, alignItems: "center" }}>
              <select className="vx-select" value={r.field} onChange={(e) => setRule(i, { field: e.target.value })}>
                {RULE_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select className="vx-select" value={r.op} onChange={(e) => setRule(i, { op: e.target.value as ">" | "<" })}>
                <option value=">">&gt;</option>
                <option value="<">&lt;</option>
              </select>
              <input
                className="vx-input"
                type="number"
                step="any"
                value={Number.isFinite(r.value) ? r.value : ""}
                onChange={(e) => setRule(i, { value: Number(e.target.value) })}
              />
              <select className="vx-select" value={r.level} onChange={(e) => setRule(i, { level: e.target.value as "warn" | "crit" })}>
                <option value="warn">Caution</option>
                <option value="crit">Critical</option>
              </select>
              <input
                className="vx-input"
                placeholder="Alert title (optional)"
                value={r.title}
                onChange={(e) => setRule(i, { title: e.target.value })}
              />
              <button className="vx-xbtn" onClick={() => props.onChange(rules.filter((_, j) => j !== i))} title="Delete rule">×</button>
            </div>
          ))}
          {!rules.length && (
            <div style={{ fontSize: 12, color: "var(--vx-fg-faint)", padding: "10px 0" }}>
              No rules yet — e.g. <code>batt_v &lt; 7.0 → Caution</code> or <code>gps_sats &lt; 5 → Critical</code>.
            </div>
          )}
        </div>

        <button className="vx-btn vx-btn-primary" style={{ marginTop: 12 }} onClick={addRule}>+ Add rule</button>
      </div>
    </div>
  );
}

/** ---------- FieldMapModal — map firmware field names to the V1 contract ---------- */
function FieldMapModal(props: { onClose: () => void }) {
  const [rows, setRows] = useState<FieldMapping[]>(() => {
    const existing = getFieldMap();
    return existing.length ? existing : [{ source: "", target: "" }];
  });
  const [unknown, setUnknown] = useState<string[]>(() => getUnknownKeys());

  // Refresh the unmapped-key suggestions while the modal is open.
  useEffect(() => {
    const t = window.setInterval(() => setUnknown(getUnknownKeys()), 1000);
    return () => window.clearInterval(t);
  }, []);

  function commit(next: FieldMapping[]) {
    setRows(next);
    saveFieldMap(next); // applies to the live ingest path immediately
  }

  function setRow(i: number, patch: Partial<FieldMapping>) {
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const mappedSources = new Set(rows.map((r) => r.source));
  const suggestions = unknown.filter((k) => !mappedSources.has(k)).slice(0, 12);

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 94vw)", maxHeight: "86vh", overflow: "auto",
          background: "rgba(17, 17, 18,0.98)", border: "1px solid var(--vx-line-strong)",
          borderRadius: 4, boxShadow: "0 22px 70px rgba(0,0,0,0.75)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Field Map</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 12 }}>
          If your flight computer sends different field names, map them here — e.g. <code>altitude_agl</code> →{" "}
          <code>alt_m</code>. Applied live to every incoming line; changes take effect immediately.
        </div>

        {/* Mapping rows */}
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 8, alignItems: "center" }}>
              <input
                className="vx-input"
                placeholder="firmware field (e.g. altitude_agl)"
                value={r.source}
                onChange={(e) => setRow(i, { source: e.target.value })}
              />
              <span style={{ color: "var(--vx-fg-dim)" }}>→</span>
              <select className="vx-select" value={r.target} onChange={(e) => setRow(i, { target: e.target.value })}>
                <option value="">— target field —</option>
                {V1_TARGET_KEYS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <button className="vx-xbtn" onClick={() => commit(rows.filter((_, j) => j !== i))} title="Remove mapping">×</button>
            </div>
          ))}
        </div>

        <button className="vx-btn" style={{ marginTop: 10 }} onClick={() => setRows([...rows, { source: "", target: "" }])}>
          + Add mapping
        </button>

        {/* Live suggestions from the incoming stream */}
        <div className="vx-card" style={{ marginTop: 14 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Unrecognized fields seen in this stream</div>
          {suggestions.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {suggestions.map((k) => (
                <button
                  key={k}
                  className="vx-chip"
                  style={{ cursor: "pointer" }}
                  title="Click to start mapping this field"
                  onClick={() => setRows([...rows.filter((r) => r.source || r.target), { source: k, target: "" }])}
                >
                  {k}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--vx-fg-faint)" }}>
              None — connect a stream and any unknown field names will appear here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** ---------- VehicleModal — CAD upload + flight configuration ---------- */
function VehicleModal(props: { onClose: () => void }) {
  const [cfg, setCfg] = useState<RocketConfig>(() => getRocketConfig());
  const [sustainerName, setSustainerName] = useState<string | null>(null);
  const [boosterName, setBoosterName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("");

  async function refreshModels() {
    const [s, b] = await Promise.all([getVehicleModel("sustainer"), getVehicleModel("booster")]);
    setSustainerName(s?.name ?? null);
    setBoosterName(b?.name ?? null);
  }
  useEffect(() => { refreshModels(); }, []);

  function update(patch: Partial<RocketConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveRocketConfig(next);
  }

  async function upload(role: StageRole, file: File) {
    setBusy(`Reading ${file.name}…`);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error("read failed"));
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(file);
      });
      const model: Model3D = { name: file.name, mime: file.type || "application/octet-stream", dataUrl, uploadedAt: Date.now() };
      await saveVehicleModel(role, model);
      await refreshModels();
      setBusy("");
    } catch (e: any) {
      setBusy(e?.message ?? "upload failed");
    }
  }

  async function clearModel(role: StageRole) {
    await deleteVehicleModel(role);
    await refreshModels();
  }

  // 2D side profile for the Mission Model — rendered from the sustainer CAD.
  const [profileMsg, setProfileMsg] = useState("");
  const [hasProfile, setHasProfile] = useState<boolean>(() => {
    try { return !!localStorage.getItem("vx.vehicleSideImage"); } catch { return false; }
  });

  async function captureProfile() {
    setProfileMsg("Rendering 2D profile…");
    try {
      const m = await getVehicleModel("sustainer");
      if (!m) { setProfileMsg("Upload a CAD model first."); return; }
      // Dynamic import keeps three.js out of the main bundle.
      const { captureSideProfile, saveSideProfile } = await import("./widgets/captureSideProfile");
      const { dataUrl, aspect } = await captureSideProfile(m, cfg.upAxis);
      saveSideProfile(dataUrl, aspect);
      notifyVehicleChanged();
      setHasProfile(true);
      setProfileMsg("Captured — the Mission Model now flies your rocket.");
    } catch (e: any) {
      setProfileMsg(e?.message ?? "capture failed");
    }
  }

  function clearProfile() {
    try {
      localStorage.removeItem("vx.vehicleSideImage");
      localStorage.removeItem("vx.vehicleSideImageAR");
    } catch { /* ignore */ }
    notifyVehicleChanged();
    setHasProfile(false);
    setProfileMsg("");
  }

  const UP_AXES: UpAxis[] = ["y", "-y", "z", "-z", "x", "-x"];

  function ModelSlot({ role, name }: { role: StageRole; name: string | null }) {
    const label = role === "sustainer" ? (cfg.stages === 2 ? "Sustainer (upper stage)" : "Airframe") : "Booster (lower stage)";
    return (
      <div className="vx-card" style={{ marginTop: 10 }}>
        <div className="vx-label" style={{ marginBottom: 8 }}>{label}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="vx-btn vx-btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Upload CAD
            <input
              type="file"
              accept=".glb,.gltf,.stl,.obj"
              style={{ display: "none" }}
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await upload(role, f); e.currentTarget.value = ""; }}
            />
          </label>
          <button className="vx-btn vx-btn-danger" onClick={() => clearModel(role)} disabled={!name}>Clear</button>
          <span style={{ fontSize: 12, fontFamily: "var(--vx-font-mono)", color: name ? "var(--vx-go)" : "var(--vx-fg-faint)" }}>
            {name ?? "— procedural fallback —"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 94vw)", maxHeight: "88vh", overflow: "auto",
          background: "rgba(17, 17, 18,0.98)", border: "1px solid var(--vx-line-strong)",
          borderRadius: 4, boxShadow: "0 22px 70px rgba(0,0,0,0.75)", padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15 }}>Vehicle Setup</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 12 }}>
          Upload your rocket CAD and describe the flight. The 3D Vehicle widget flies your model live from telemetry
          attitude and animates staging & recovery through the flight events.
        </div>

        {/* Name */}
        <div className="vx-card">
          <div className="vx-label" style={{ marginBottom: 6 }}>Vehicle name</div>
          <input className="vx-input" value={cfg.name} onChange={(e) => update({ name: e.target.value })} />
        </div>

        {/* Stages */}
        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Configuration</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={`vx-btn ${cfg.stages === 1 ? "vx-btn-primary" : ""}`} onClick={() => update({ stages: 1 })}>Single stage</button>
            <button className={`vx-btn ${cfg.stages === 2 ? "vx-btn-primary" : ""}`} onClick={() => update({ stages: 2 })}>Two stage</button>
          </div>

          {cfg.stages === 2 && (
            <div style={{ marginTop: 10 }}>
              <div className="vx-label" style={{ marginBottom: 6 }}>Stage separation at</div>
              <select className="vx-select" value={cfg.separationEvent} onChange={(e) => update({ separationEvent: e.target.value as any })}>
                <option value="BURNOUT">Booster burnout (staging)</option>
                <option value="APOGEE">Apogee</option>
                <option value="NONE">No separation</option>
              </select>
            </div>
          )}
        </div>

        {/* Recovery */}
        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 6 }}>Recovery</div>
          <select className="vx-select" value={cfg.recovery} onChange={(e) => update({ recovery: e.target.value as any })}>
            <option value="drogue-main">Dual deploy (drogue at apogee → main)</option>
            <option value="main-only">Single deploy (main only)</option>
            <option value="none">None / tumble</option>
          </select>
        </div>

        {/* Model orientation + scale */}
        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Model orientation & size</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--vx-fg-dim)" }}>
              NOSE (UP) AXIS
              <select className="vx-select" value={cfg.upAxis} onChange={(e) => update({ upAxis: e.target.value as UpAxis })}>
                {UP_AXES.map((a) => <option key={a} value={a}>+{a.toUpperCase()}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--vx-fg-dim)", flex: 1, minWidth: 180 }}>
              SIZE ×{cfg.modelScale.toFixed(2)}
              <input type="range" min={0.3} max={3} step={0.05} value={cfg.modelScale} onChange={(e) => update({ modelScale: Number(e.target.value) })} />
            </label>
          </div>
          <div style={{ fontSize: 11, color: "var(--vx-fg-faint)", marginTop: 8 }}>
            If your model lies on its side in the viewer, change the nose axis until it stands upright.
          </div>
        </div>

        {/* Model uploads */}
        <ModelSlot role="sustainer" name={sustainerName} />
        {cfg.stages === 2 && <ModelSlot role="booster" name={boosterName} />}

        {/* 2D side profile for the Mission Model */}
        <div className="vx-card" style={{ marginTop: 10 }}>
          <div className="vx-label" style={{ marginBottom: 8 }}>Mission Model profile</div>
          <div style={{ fontSize: 12, color: "var(--vx-fg-dim)", lineHeight: 1.6, marginBottom: 10 }}>
            Render a flat side view of your CAD to use as the vehicle in the Mission Model launch
            profile. Capture it after uploading the airframe and getting the nose axis upright.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="vx-btn vx-btn-primary" onClick={captureProfile} disabled={!sustainerName}>
              {hasProfile ? "Re-capture 2D profile" : "Capture 2D profile"}
            </button>
            {hasProfile && <button className="vx-btn vx-btn-danger" onClick={clearProfile}>Remove profile</button>}
            {hasProfile && (
              <img
                src={localStorage.getItem("vx.vehicleSideImage") ?? ""}
                alt="Captured side profile"
                style={{ height: 40, border: "1px solid var(--vx-line)", borderRadius: 3, background: "rgba(0,0,0,0.25)" }}
              />
            )}
          </div>
          {profileMsg && (
            <div style={{ fontSize: 11, marginTop: 8, fontFamily: "var(--vx-font-mono)", color: "var(--vx-caution)" }}>{profileMsg}</div>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: busy ? "var(--vx-caution)" : "var(--vx-fg-faint)", fontFamily: "var(--vx-font-mono)" }}>
          {busy || "Formats: .glb / .gltf (recommended), .stl, .obj · stored locally in your browser."}
        </div>
      </div>
    </div>
  );
}

/** ---------- SettingsModal ----------
 * Organized into tabs so the theme controls aren't fighting the rest of the app
 * config for space. Everything that used to clutter the top bar lives here. */
type SettingsTab = "display" | "flight" | "data" | "tools";

function SettingsModal(props: {
  theme: ThemeSettings;
  battProfile: BatteryProfile;
  globalUnits: UnitSystem;
  onClose: () => void;
  onTheme: (patch: Partial<ThemeSettings>) => void;
  onThemePreset: (t: ThemeSettings) => void;
  onThemeReset: () => void;
  onBatt: (patch: Partial<BatteryProfile>) => void;
  onUnits: (u: UnitSystem) => void;
  voiceOn: boolean;
  onToggleVoice: () => void;
  fieldMode: boolean;
  onToggleFieldMode: () => void;
  uiZoom: number;
  onZoom: (delta: number) => void;
  onZoomReset: () => void;
  alarmMuted: boolean;
  onToggleAlarmMute: () => void;
  alertRuleCount: number;
  missionView: "model" | "timeline";
  onMissionView: (v: "model" | "timeline") => void;
  docsUrl: string;
  onDocsUrl: (u: string) => void;
  onOpenTemplates: () => void;
  onOpenExport: () => void;
  onOpenVehicle: () => void;
  onOpenAlertRules: () => void;
  onOpenRadio: () => void;
  onOpenFieldMap: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("display");

  const TABS: Array<{ id: SettingsTab; label: string }> = [
    { id: "display", label: "Display" },
    { id: "flight", label: "Flight" },
    { id: "data", label: "Data" },
    { id: "tools", label: "Tools" },
  ];

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal vx-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-settings-head">
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: "0.06em", textTransform: "uppercase" }}>Settings</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div className="vx-settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`vx-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="vx-settings-body">
          {tab === "display" && (
            <>
              <div className="vx-card">
                <div className="vx-card-title">Theme</div>
                <div className="vx-help">Presets are graphite variants sampled from the VX logo.</div>
                <div className="vx-preset-row">
                  {THEME_PRESETS.map((p) => (
                    <button key={p.name} className="vx-btn" onClick={() => props.onThemePreset(p.theme)}>
                      {p.name}
                    </button>
                  ))}
                  <button className="vx-btn vx-btn-danger" onClick={props.onThemeReset}>Reset</button>
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Colors</div>
                <div className="vx-color-grid">
                  <ColorTile
                    label="App Background"
                    value={props.theme.appBg ?? "#111112"}
                    onChange={(v) => props.onTheme({ appBg: v })}
                    onReset={() => props.onTheme({ appBg: DEFAULT_THEME.appBg })}
                  />
                  <ColorTile
                    label="Panel Top"
                    value={props.theme.bgA}
                    onChange={(v) => props.onTheme({ bgA: v })}
                    onReset={() => props.onTheme({ bgA: DEFAULT_THEME.bgA })}
                  />
                  <ColorTile
                    label="Panel Bottom"
                    value={props.theme.bgB}
                    onChange={(v) => props.onTheme({ bgB: v })}
                    onReset={() => props.onTheme({ bgB: DEFAULT_THEME.bgB })}
                  />
                  <ColorTile
                    label="Console"
                    value={props.theme.consoleBg}
                    onChange={(v) => props.onTheme({ consoleBg: v })}
                    onReset={() => props.onTheme({ consoleBg: DEFAULT_THEME.consoleBg })}
                  />
                </div>
                <div className="vx-help" style={{ marginTop: 10 }}>
                  The technical grid overlay stays on top of whatever background color you pick.
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Preview</div>
                <div
                  style={{
                    height: 110,
                    borderRadius: 3,
                    border: "1px solid var(--vx-line)",
                    background: `linear-gradient(135deg, ${props.theme.bgA}, ${props.theme.bgB})`,
                    color: autoTextColor(props.theme.bgB),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  VX Telemetry
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Console</div>
                <ToggleRow
                  label="Field mode"
                  hint="Maximum contrast for direct sunlight"
                  on={props.fieldMode}
                  onToggle={props.onToggleFieldMode}
                />
                <div className="vx-row">
                  <div>
                    <div className="vx-row-label">Zoom</div>
                    <div className="vx-help">Scales the whole display</div>
                  </div>
                  <div style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
                    <button className="vx-tbtn" onClick={() => props.onZoom(-0.1)}>−</button>
                    <button className="vx-tbtn" onClick={props.onZoomReset} style={{ minWidth: 52 }}>
                      {Math.round(props.uiZoom * 100)}%
                    </button>
                    <button className="vx-tbtn" onClick={() => props.onZoom(0.1)}>+</button>
                  </div>
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Dashboard templates</div>
                <div className="vx-help">Swap to a ready-made layout — HPR dual-deploy, TVC, canard, airbrake, competition.</div>
                <button className="vx-btn" style={{ marginTop: 10 }} onClick={props.onOpenTemplates}>
                  Choose a template…
                </button>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Mission Overview</div>
                <div className="vx-help">How the launch is shown above the dashboard.</div>
                <div className="vx-seg" style={{ marginTop: 10, display: "inline-flex" }}>
                  <button
                    className={props.missionView === "model" ? "on" : ""}
                    onClick={() => props.onMissionView("model")}
                    title="Live launch-profile model with the vehicle flying its trajectory"
                  >
                    Model
                  </button>
                  <button
                    className={props.missionView === "timeline" ? "on" : ""}
                    onClick={() => props.onMissionView("timeline")}
                    title="Simple bar timeline of flight events"
                  >
                    Timeline
                  </button>
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Units</div>
                <select className="vx-select" value={props.globalUnits} onChange={(e) => props.onUnits(e.target.value as UnitSystem)} style={{ width: "100%" }}>
                  <option value="metric">Metric (m, m/s, °C)</option>
                  <option value="imperial">Imperial (ft, ft/s, °F)</option>
                </select>
              </div>
            </>
          )}

          {tab === "flight" && (
            <>
              <div className="vx-card">
                <div className="vx-card-title">Vehicle</div>
                <div className="vx-help">Upload rocket CAD, configure staging and recovery.</div>
                <button className="vx-btn vx-btn-primary" style={{ marginTop: 10 }} onClick={props.onOpenVehicle}>
                  Open Vehicle Setup
                </button>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Audio</div>
                <ToggleRow
                  label="Voice callouts"
                  hint="Spoken flight events — liftoff, apogee, main"
                  on={props.voiceOn}
                  onToggle={props.onToggleVoice}
                />
                <ToggleRow
                  label="Master alarm"
                  hint="Audible caution tone on critical alerts"
                  on={!props.alarmMuted}
                  onToggle={props.onToggleAlarmMute}
                />
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Battery Profile</div>
                <div className="vx-help">Drives the battery % estimator from incoming <code>batt_v</code>.</div>

                <div className="vx-field-grid" style={{ marginTop: 10 }}>
                  <div>
                    <div className="vx-row-label">Chemistry</div>
                    <select className="vx-select" value={props.battProfile.chem} onChange={(e) => props.onBatt({ chem: e.target.value as BatteryChem })} style={{ width: "100%" }}>
                      <option value="LiPo">LiPo</option>
                      <option value="LiIon">Li-Ion</option>
                      <option value="LiFe">LiFePO4</option>
                    </select>
                  </div>
                  <div>
                    <div className="vx-row-label">Cells (S)</div>
                    <input
                      className="vx-input"
                      type="number"
                      min={1}
                      max={12}
                      value={props.battProfile.cells}
                      onChange={(e) => props.onBatt({ cells: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
                    />
                  </div>
                  <div>
                    <div className="vx-row-label">Warn %</div>
                    <input
                      className="vx-input"
                      type="number"
                      min={1}
                      max={99}
                      value={props.battProfile.warnPct}
                      onChange={(e) => props.onBatt({ warnPct: Math.max(1, Math.min(99, Number(e.target.value) || 20)) })}
                    />
                  </div>
                  <div>
                    <div className="vx-row-label">Critical %</div>
                    <input
                      className="vx-input"
                      type="number"
                      min={0}
                      max={98}
                      value={props.battProfile.critPct}
                      onChange={(e) => props.onBatt({ critPct: Math.max(0, Math.min(98, Number(e.target.value) || 10)) })}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === "data" && (
            <>
              <div className="vx-card">
                <div className="vx-card-title">Export</div>
                <div className="vx-help">Choose a file format — raw telemetry, frames, GPS track, or a print-ready report.</div>
                <button className="vx-btn vx-btn-primary" style={{ marginTop: 10 }} onClick={props.onOpenExport}>
                  Export Flight Data…
                </button>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Alert Rules</div>
                <div className="vx-help">Custom thresholds on any telemetry field.</div>
                <button className="vx-btn" style={{ marginTop: 10 }} onClick={props.onOpenAlertRules}>
                  Edit Alert Rules{props.alertRuleCount ? ` (${props.alertRuleCount})` : ""}
                </button>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Field Map</div>
                <div className="vx-help">Map custom firmware field names onto the VX telemetry contract.</div>
                <button className="vx-btn" style={{ marginTop: 10 }} onClick={props.onOpenFieldMap}>
                  Open Field Map
                </button>
              </div>
            </>
          )}

          {tab === "tools" && (
            <>
              <div className="vx-card">
                <div className="vx-card-title">Learn &amp; docs link</div>
                <div className="vx-help">
                  Your own tutorials site. Every widget's help panel shows a “Learn more” button
                  that opens this link — the place to teach people how TVC, canards, and the rest work.
                  Leave blank to hide the button.
                </div>
                <input
                  className="vx-input"
                  style={{ marginTop: 10 }}
                  type="url"
                  placeholder="https://your-site.com/tutorials"
                  value={props.docsUrl}
                  onChange={(e) => props.onDocsUrl(e.target.value.trim())}
                />
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Radio</div>
                <div className="vx-help">Configure a SiK / RFD900-family telemetry radio over the serial link.</div>
                <button className="vx-btn" style={{ marginTop: 10 }} onClick={props.onOpenRadio}>
                  Open Radio Config
                </button>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Shortcuts</div>
                <div className="vx-kbd-list">
                  <div><code>Ctrl+K</code><span>Command palette</span></div>
                  <div><code>F</code><span>Freeze / unfreeze</span></div>
                  <div><code>Ctrl+E</code><span>Export JSONL</span></div>
                  <div><code>Ctrl+Shift+E</code><span>Export CSV</span></div>
                  <div><code>Esc</code><span>Close menus / modals</span></div>
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Privacy</div>
                <div className="vx-help">
                  All telemetry stays on this machine. Flights are archived to local browser storage
                  (IndexedDB); nothing is uploaded anywhere.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="vx-settings-foot">
          <button className="vx-btn vx-btn-primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** A labeled on/off row used throughout Settings. */
function ToggleRow(props: { label: string; hint?: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="vx-row">
      <div>
        <div className="vx-row-label">{props.label}</div>
        {props.hint ? <div className="vx-help">{props.hint}</div> : null}
      </div>
      <button
        className={`vx-switch ${props.on ? "on" : ""}`}
        onClick={props.onToggle}
        role="switch"
        aria-checked={props.on}
        aria-label={props.label}
      >
        <span className="vx-switch-knob" />
      </button>
    </div>
  );
}

/** ---------- ExportModal ----------
 * Single export entry point: pick a format, then write the file. */
type ExportFormat = "jsonl" | "csv" | "kml" | "gpx" | "report" | "share";

function ExportModal(props: {
  frameCount: number;
  rawCount: number;
  hasGps: boolean;
  onClose: () => void;
  onExport: (fmt: ExportFormat) => void;
}) {
  const [fmt, setFmt] = useState<ExportFormat>("jsonl");

  const OPTIONS: Array<{ id: ExportFormat; name: string; ext: string; desc: string; disabled?: boolean; note?: string }> = [
    { id: "share", name: "Shareable replay", ext: ".html", desc: "Self-contained interactive replay — send it or host it. Works offline." },
    { id: "jsonl", name: "Raw telemetry", ext: ".jsonl", desc: `Every received line, exactly as it arrived (${props.rawCount} lines).` },
    { id: "csv", name: "Frames", ext: ".csv", desc: `Parsed frames as a spreadsheet (${props.frameCount} frames).` },
    {
      id: "kml", name: "GPS track", ext: ".kml", desc: "Opens in Google Earth Pro or earth.google.com.",
      disabled: !props.hasGps, note: "No GPS fixes in this flight",
    },
    {
      id: "gpx", name: "GPS track", ext: ".gpx", desc: "Works with most GPS and mapping apps.",
      disabled: !props.hasGps, note: "No GPS fixes in this flight",
    },
    { id: "report", name: "Mission report", ext: "PDF", desc: "Print-ready summary — use Print → Save as PDF." },
  ];

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal vx-export" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-settings-head">
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: "0.06em", textTransform: "uppercase" }}>Export</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div className="vx-settings-body">
          <div className="vx-help" style={{ marginBottom: 12 }}>What file format do you want?</div>
          <div className="vx-export-list">
            {OPTIONS.map((o) => (
              <button
                key={o.id}
                className={`vx-export-opt ${fmt === o.id ? "active" : ""}`}
                onClick={() => !o.disabled && setFmt(o.id)}
                disabled={o.disabled}
                title={o.disabled ? o.note : o.desc}
              >
                <span className="vx-export-radio" aria-hidden="true" />
                <span style={{ minWidth: 0 }}>
                  <span className="vx-export-name">
                    {o.name} <span className="vx-export-ext">{o.ext}</span>
                  </span>
                  <span className="vx-export-desc">{o.disabled ? o.note : o.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="vx-settings-foot">
          <button className="vx-btn" onClick={props.onClose}>Cancel</button>
          <button className="vx-btn vx-btn-primary" onClick={() => props.onExport(fmt)}>Export</button>
        </div>
      </div>
    </div>
  );
}

/** ---------- OnboardingModal ----------
 * First-run welcome + template picker so a new user lands on a populated,
 * relevant dashboard instead of an empty grid. Also reachable from Settings. */
function OnboardingModal(props: { onPick: (t: DashTemplate) => void; onClose: () => void }) {
  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal vx-onboard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-settings-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Welcome to VX Telemetry</div>
            <div className="vx-help" style={{ marginTop: 2 }}>Pick a starting layout — then choose Simulator and hit Connect to watch a full flight.</div>
          </div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div className="vx-settings-body">
          <div className="vx-tmpl-grid">
            {TEMPLATES.map((t) => (
              <button key={t.id} className="vx-tmpl" onClick={() => props.onPick(t)}>
                <div className="vx-tmpl-name">{t.name}</div>
                <div className="vx-tmpl-desc">{t.desc}</div>
                <div className="vx-tmpl-count">{t.widgets.length} widget{t.widgets.length === 1 ? "" : "s"}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="vx-settings-foot" style={{ justifyContent: "space-between" }}>
          <span className="vx-help">You can switch layouts anytime in Settings → Display.</span>
          <button className="vx-btn" onClick={props.onClose}>Skip</button>
        </div>
      </div>
    </div>
  );
}

/** ---------- WidgetHelpModal ----------
 * Per-widget help: what it is, how to wire the hardware that feeds it,
 * troubleshooting, the exact telemetry fields it reads, and a Learn-more link
 * to the operator's own tutorials site (configured in Settings → Tools). */
function WidgetHelpModal(props: { widgetId: WidgetId; docsUrl: string; onClose: () => void }) {
  const def: any = WIDGETS.find((w: any) => w.id === props.widgetId);
  const help = WIDGET_HELP[props.widgetId];
  const learn = learnMoreUrl(props.docsUrl, props.widgetId);

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal vx-help-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-settings-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{def?.name ?? props.widgetId}</div>
            <div className="vx-help" style={{ marginTop: 2 }}>{def?.category} widget · how it works</div>
          </div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div className="vx-settings-body">
          {help ? (
            <>
              <div className="vx-card">
                <div className="vx-card-title">What it is</div>
                <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--vx-fg-dim)" }}>{help.about}</div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Connect your hardware</div>
                <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--vx-fg-dim)" }}>{help.connect}</div>
                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span className="vx-help">Reads:</span>
                  {help.fields.map((f) => (
                    <code key={f} style={{ fontSize: 11 }}>{f}</code>
                  ))}
                </div>
              </div>

              <div className="vx-card">
                <div className="vx-card-title">Troubleshooting</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: "var(--vx-fg-dim)" }}>
                  {help.troubleshoot.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            </>
          ) : (
            <div className="vx-card">
              <div style={{ fontSize: 13, color: "var(--vx-fg-dim)" }}>{def?.hardwareHint ?? "No help available for this widget yet."}</div>
            </div>
          )}
        </div>

        <div className="vx-settings-foot" style={{ justifyContent: "space-between" }}>
          {learn ? (
            <button className="vx-btn vx-btn-primary" onClick={() => window.open(learn, "_blank", "noopener,noreferrer")}>
              Learn more ↗
            </button>
          ) : (
            <span className="vx-help">Tip: add your tutorials site in Settings → Tools to show a Learn-more link here.</span>
          )}
          <button className="vx-btn" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** ---------- ColorTile (better UX + reset) ---------- */
function ColorTile(props: { label: string; value: string; onChange: (v: string) => void; onReset: () => void }) {
  const text = autoTextColor(props.value);
  return (
    <div className="vx-card" style={{ background: "rgba(255,255,255,0.04)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontWeight: 900 }}>{props.label}</div>
        <button className="vx-btn vx-btn-danger" onClick={props.onReset} style={{ padding: "6px 10px" }}>
          Reset
        </button>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "70px 1fr", gap: 10, alignItems: "center" }}>
        <label
          style={{
            width: 62,
            height: 40,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.16)",
            background: props.value,
            cursor: "pointer",
            overflow: "hidden",
            display: "inline-block",
          }}
          title="Pick color"
        >
          <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} style={{ opacity: 0, width: "100%", height: "100%" }} />
        </label>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.9 }}>
            <div><code>{props.value.toUpperCase()}</code></div>
            <div style={{ marginTop: 4, opacity: 0.8 }}>Auto text: <code style={{ color: text }}>{text}</code></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- CommandPalette ---------- */
function CommandPalette(props: {
  locked: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onToggleMode: () => void;
  onExportJSONL: () => void;
  onExportCSV: () => void;
}) {
  const [q, setQ] = useState("");

  const commands = [
    { id: "settings", name: "Open Settings", hint: "Theme, units, battery, 3D model", run: props.onOpenSettings },
    { id: "mode", name: props.locked ? "Unlock (Build Mode)" : "Lock (Flight Mode)", hint: "Toggle layout lock", run: props.onToggleMode },
    { id: "jsonl", name: "Export JSONL", hint: "Raw telemetry session", run: props.onExportJSONL },
    { id: "csv", name: "Export CSV", hint: "Parsed frames table", run: props.onExportCSV },
    { id: "close", name: "Close", hint: "Esc", run: props.onClose },
  ];

  const filtered = commands.filter((c) => (`${c.name} ${c.hint}`.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="vx-card"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 92vw)",
          borderRadius: 16,
          padding: 12,
          background: "rgba(20, 20, 23,0.96)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 22px 70px rgba(0,0,0,0.65)",
          color: "var(--vx-fg)",
        }}

      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Command Palette</div>
          <button className="vx-xbtn" onClick={props.onClose}>×</button>
        </div>

        <div style={{ marginTop: 10 }}>
          <input className="vx-input" placeholder="Type a command…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>

        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((c) => (
            <div key={c.id} className="vx-menu-item" style={{ background: "rgba(255,255,255,0.04)" }} onClick={c.run}>
              <div>
                <div style={{ fontWeight: 900 }}>{c.name}</div>
                <div className="vx-menu-muted">{c.hint}</div>
              </div>
              <div className="vx-chip">↵</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ---------- AdvancedAddModal ---------- */
function AdvancedAddModal(props: {
  latest: any;
  caps: any;
  globalUnits: UnitSystem;
  onClose: () => void;
  onAdd: (id: WidgetId, w: number, h: number, unitsOverride?: UnitSystem, accentOverride?: string, viewOverride?: "card" | "instrument" | "plot") => void;
}) {
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<WidgetId>(() => (WIDGETS[0]?.id as WidgetId));

  const selected = WIDGETS.find((x: any) => x.id === selectedId) as any;

  const [w, setW] = useState<number>(() => selected?.defaultSize?.w ?? 6);
  const [h, setH] = useState<number>(() => selected?.defaultSize?.h ?? 6);

  const [unitsMode, setUnitsMode] = useState<"inherit" | UnitSystem>("inherit");
  const [accent, setAccent] = useState<string>(() => selected?.defaultTheme?.accent ?? "#a2a6ae");
  const [view, setView] = useState<"card" | "instrument" | "plot">(() => selected?.defaultView ?? "card");

  useEffect(() => {
    const def: any = WIDGETS.find((x: any) => x.id === selectedId);
    if (!def) return;
    setW(def.defaultSize?.w ?? 6);
    setH(def.defaultSize?.h ?? 6);
    setAccent(def.defaultTheme?.accent ?? "#a2a6ae");
    setView(def.defaultView ?? "card");
    setUnitsMode("inherit");
  }, [selectedId]);

  const requires = normalizeRequires(selected?.requires);
  const enabled = requires.length === 0 || requires.every((r) => capHas(props.caps, r));

  const allDefs = Object.entries(WIDGETS_BY_CATEGORY).flatMap(([cat, defs]) => (defs as any[]).map((d) => ({ ...d, category: cat })));
  const filtered = allDefs.filter((d) => {
    const s = `${d.name ?? ""} ${d.id ?? ""} ${d.category ?? ""}`.toLowerCase();
    return s.includes(q.trim().toLowerCase());
  });

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vx-pane">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Add Widget (Advanced)</div>
            <button className="vx-xbtn" onClick={props.onClose}>×</button>
          </div>

          <div style={{ marginTop: 10 }}>
            <input className="vx-input" placeholder="Search widgets…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map((d: any) => {
              const req = normalizeRequires(d.requires);
              const ok = req.length === 0 || req.every((r) => capHas(props.caps, r));
              const isSel = d.id === selectedId;

              return (
                <div
                  key={d.id}
                  className="vx-card"
                  style={{
                    cursor: "pointer",
                    outline: isSel ? "2px solid rgba(168, 171, 177,0.55)" : "none",
                    opacity: ok ? 1 : 0.55,
                  }}
                  title={d.hardwareHint ?? ""}
                  onClick={() => setSelectedId(d.id)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>{d.name ?? d.id}</div>
                    <span className="vx-chip">{d.category}</span>
                  </div>

                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    id: <code>{d.id}</code>
                  </div>

                  {!ok && d.hardwareHint ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>{d.hardwareHint}</div> : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="vx-pane">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>{selected?.name ?? selectedId}</div>
            <span className="vx-chip">{enabled ? "Ready" : "Needs hardware/data"}</span>
          </div>

          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Units</div>
              <select className="vx-select" value={unitsMode} onChange={(e) => setUnitsMode(e.target.value as any)} style={{ width: "100%" }}>
                <option value="inherit">Inherit global ({props.globalUnits})</option>
                <option value="metric">Metric</option>
                <option value="imperial">Imperial</option>
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Accent Color</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: accent,
                    cursor: "pointer",
                    overflow: "hidden",
                    display: "inline-block",
                  }}
                >
                  <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} style={{ opacity: 0, width: "100%", height: "100%" }} />
                </label>
                <span className="vx-chip">{accent.toUpperCase()}</span>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Width (cols)</div>
              <input className="vx-input" type="number" min={1} max={GRID_COLS} value={w} onChange={(e) => setW(Math.max(1, Math.min(GRID_COLS, Number(e.target.value) || 1)))} />
            </div>
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Height (rows)</div>
              <input className="vx-input" type="number" min={2} max={60} value={h} onChange={(e) => setH(Math.max(2, Math.min(60, Number(e.target.value) || 2)))} />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Default View</div>
            <select className="vx-select" value={view} onChange={(e) => setView(e.target.value as any)} style={{ width: "100%" }}>
              <option value="card">Card</option>
              <option value="instrument">Instrument</option>
              <option value="plot">Plot</option>
            </select>
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button className="vx-btn" onClick={props.onClose}>Cancel</button>
            <button className="vx-btn vx-btn-primary" onClick={() => props.onAdd(selectedId, w, h, unitsMode === "inherit" ? undefined : (unitsMode as UnitSystem), accent, view)}>
              Add to dashboard
            </button>
          </div>
        </div>

        <div className="vx-pane">
          <div style={{ fontWeight: 900, fontSize: 16 }}>Learn & Wire</div>

          <div style={{ marginTop: 10 }} className="vx-card">
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Required telemetry fields</div>
            {requires.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {requires.map((r: string) => (
                  <span key={r} className="vx-chip">{r}</span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.75 }}>None (always available)</div>
            )}
          </div>

          <div style={{ marginTop: 10 }} className="vx-card">
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Hardware hint</div>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.6 }}>{selected?.hardwareHint ?? "Add hardware notes to registry for this widget."}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- WidgetFrame ---------- */
function WidgetBody(props: {
  widgetId: WidgetId;
  latest: any;
  telemetry: any;
  unitSystem: UnitSystem;
  view: "card" | "instrument" | "plot";
}) {
  return <>{renderWidget(props)}</>;
}

/** Isolates widget render crashes: one failing widget must never take down
    the console mid-flight. Resets when the widget id or view changes. */
class WidgetErrorBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "grid", placeItems: "center", height: "100%", gap: 8, alignContent: "center", textAlign: "center", padding: 12 }}>
          <div style={{ color: "var(--vx-crit)", fontWeight: 700, letterSpacing: "0.12em", fontSize: 12 }}>WIDGET FAULT — ISOLATED</div>
          <div style={{ fontFamily: "var(--vx-font-mono)", fontSize: 11, color: "var(--vx-fg-dim)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button className="vx-btn" onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function WidgetFrame(props: {
  instKey: string;
  widgetId: WidgetId;
  telemetry: any;
  latest: any;
  caps: any;
  globalUnits: UnitSystem;
  settings?: WidgetSettings;
  locked: boolean;
  pinned: boolean;
  connected: boolean;
  allFrames: TelemetryFrameV1[]; // unfiltered source, for per-widget vehicle overrides
  seenVids: string[];
  theme: ThemeSettings;
  onPatchSettings: (patch: WidgetSettings) => void;
  onResetAccent: () => void;
  onTogglePin: () => void;
  onSendCommand: (cmd: string) => void;
  onRemove: () => void;
  onHelp: () => void;
}) {
  const def: any = WIDGETS.find((x: any) => x.id === props.widgetId);

  const requires = normalizeRequires(def?.requires);
  const enabled = requires.length === 0 || requires.every((r) => capHas(props.caps, r));

  const defaultAccent = def?.defaultTheme?.accent ?? "#a2a6ae";
  const accent = props.settings?.accent ?? defaultAccent;
  const unitSystem: UnitSystem = props.settings?.units ?? props.globalUnits;
  const supportedViews: Array<"card" | "instrument" | "plot"> = def?.views ?? ["card"];
  const viewRaw = props.settings?.view ?? def?.defaultView ?? "card";
  const view = supportedViews.includes(viewRaw) ? viewRaw : supportedViews[0];

  // Per-widget unit override cycles inherit -> metric -> imperial.
  const unitsMode = props.settings?.units ?? "inherit";
  function cycleUnits() {
    const next = unitsMode === "inherit" ? "metric" : unitsMode === "metric" ? "imperial" : undefined;
    props.onPatchSettings({ units: next as UnitSystem | undefined });
  }

  // TX console (raw console widget only)
  const [txCmd, setTxCmd] = useState("");

  // RAW console special scrolling
  const rawRef = useRef<HTMLDivElement | null>(null);
  const rawPinnedTopRef = useRef(true);

  useEffect(() => {
    if (props.widgetId !== "raw.console") return;
    const el = rawRef.current;
    if (!el) return;
    if (rawPinnedTopRef.current) el.scrollTop = 0;
  }, [props.telemetry?.rawLines, props.widgetId]);

  // Per-widget vehicle override: undefined follows the global selection
  // (props.telemetry is already globally filtered); "ALL" shows every stream;
  // a specific vid re-filters from the unfiltered source.
  const widgetVid = props.settings?.vid;
  const effTelemetry = useMemo(() => {
    if (!widgetVid) return { telemetry: props.telemetry, latest: props.latest };
    const frames =
      widgetVid === "ALL"
        ? props.allFrames
        : props.allFrames.filter((f) => f.vid === undefined || String(f.vid) === widgetVid);
    return {
      telemetry: { ...props.telemetry, frames },
      latest: frames.length ? frames[frames.length - 1] : undefined,
    };
  }, [widgetVid, props.telemetry, props.latest, props.allFrames]);

  function cycleWidgetVid() {
    const order: Array<string | undefined> = [undefined, "ALL", ...props.seenVids];
    const idx = order.findIndex((v) => v === widgetVid);
    const next = order[(idx + 1) % order.length];
    props.onPatchSettings({ vid: next as string | undefined });
  }

  // Deferred into a child component so the error boundary can catch renderer throws.
  const body = (
    <WidgetBody widgetId={props.widgetId} latest={effTelemetry.latest} telemetry={effTelemetry.telemetry} unitSystem={unitSystem} view={view} />
  );

  const consoleFg = autoTextColor(props.theme.consoleBg);

  const VIEW_LABEL: Record<string, string> = { card: "NUM", instrument: "GAUGE", plot: "PLOT" };

  return (
    <div
      className="vx-widget vx-widget-outline"
      style={{
        border: `1px solid var(--vx-line)`,
        background: "linear-gradient(180deg, rgba(162, 166, 174,0.03), rgba(20, 20, 23,0.85))",
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        opacity: enabled ? 1 : 0.3,
      }}
      title={enabled ? "" : def?.hardwareHint ?? "Missing required telemetry"}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent, opacity: 0.9 }} />

      <div className="vx-widget-inner" style={{ paddingLeft: 13, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="vx-titlebar" style={{ flex: "0 0 auto" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            <span
              title={requires.length ? `Requires: ${requires.join(", ")}` : undefined}
              style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--vx-fg)" }}
            >
              {def?.name ?? props.widgetId}
            </span>
            {props.pinned && <span style={{ fontSize: 10, color: "var(--vx-caution)", letterSpacing: "0.1em" }}>LOCKED</span>}
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "0 0 auto" }}>
            {/* View switch — only the views this widget implements */}
            {supportedViews.length > 1 && (
              <div className="vx-seg">
                {supportedViews.map((v) => (
                  <button
                    key={v}
                    className={view === v ? "on" : ""}
                    onClick={() => props.onPatchSettings({ view: v })}
                    title={`${VIEW_LABEL[v]} view`}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                ))}
              </div>
            )}

            {/* Units: G (global) -> SI -> US */}
            <button
              className="vx-tbtn"
              onClick={cycleUnits}
              title={`Units: ${unitsMode === "inherit" ? "inherit global" : unitsMode} — click to cycle`}
            >
              {unitsMode === "inherit" ? "U:G" : unitsMode === "metric" ? "SI" : "US"}
            </button>

            {/* Vehicle: G (global selection) -> ALL -> each stream */}
            {props.seenVids.length >= 2 && (
              <button
                className="vx-tbtn"
                onClick={cycleWidgetVid}
                title={`Vehicle: ${widgetVid ?? "follow global selection"} — click to cycle`}
                style={widgetVid ? { color: "var(--vx-accent-bright)", borderColor: "var(--vx-accent)" } : undefined}
              >
                {widgetVid ? `▲${widgetVid === "ALL" ? "ALL" : widgetVid}` : "▲G"}
              </button>
            )}

            {/* Accent dot — pick color; right-click resets to default */}
            <label
              title="Accent color (right-click to reset)"
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); props.onResetAccent(); }}
              style={{
                width: 18, height: 18, borderRadius: "50%",
                border: "1px solid var(--vx-line-strong)",
                background: accent, cursor: "pointer", overflow: "hidden", flex: "0 0 auto",
              }}
            >
              <input type="color" value={accent} onChange={(e) => props.onPatchSettings({ accent: e.target.value })} style={{ opacity: 0, width: "100%", height: "100%" }} />
            </label>

            {/* Widget help — how to connect hardware, troubleshooting, and a
                Learn-more link to the operator's own tutorials site */}
            <button
              className="vx-tbtn"
              onClick={props.onHelp}
              title="How this widget works, wiring & troubleshooting"
              aria-label="Widget help"
              style={{ fontWeight: 700, fontFamily: "var(--vx-font-display)" }}
            >
              i
            </button>

            {/* Per-widget lock: freezes this widget's position/size so canvas
                interaction (e.g. orbiting the 3D model) can't move it */}
            <button
              className="vx-tbtn"
              onClick={props.onTogglePin}
              title={props.pinned ? "Unlock widget position/size" : "Lock widget position/size"}
              style={props.pinned ? { color: "var(--vx-caution)", borderColor: "var(--vx-caution)" } : undefined}
            >
              {props.pinned ? "🔒" : "🔓"}
            </button>

            <button className="vx-tbtn vx-tbtn-danger" onClick={props.onRemove} title={props.locked ? "Locked in Flight Mode" : "Remove widget"} disabled={props.locked}>
              ×
            </button>
          </div>
        </div>

        {/* Body — definite height + size container so content scales with the widget */}
        <div className="vx-body" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <WidgetErrorBoundary resetKey={`${props.widgetId}:${view}:${widgetVid ?? ""}`}>
          {props.widgetId === "raw.console" ? (
            <>
              <div
                ref={rawRef}
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "auto",
                  borderRadius: 3,
                  border: "1px solid var(--vx-line)",
                  background: props.theme.consoleBg,
                  padding: 10,
                  color: consoleFg,
                }}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  rawPinnedTopRef.current = el.scrollTop <= 2;
                }}
              >
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.95, fontFamily: "var(--vx-font-mono)" }}>
                  {[...(props.telemetry.rawLines ?? [])].slice().reverse().join("\n")}
                </pre>
              </div>

              {/* TX command line */}
              <div style={{ display: "flex", gap: 6, marginTop: 8, flex: "0 0 auto" }}>
                <input
                  className="vx-input"
                  style={{ flex: 1, fontFamily: "var(--vx-font-mono)", fontSize: 12 }}
                  placeholder={props.connected ? "TX command… (Enter to send)" : "Connect to send commands"}
                  disabled={!props.connected}
                  value={txCmd}
                  onChange={(e) => setTxCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && txCmd.trim()) {
                      props.onSendCommand(txCmd.trim());
                      setTxCmd("");
                    }
                  }}
                />
                <button
                  className="vx-btn"
                  disabled={!props.connected || !txCmd.trim()}
                  onClick={() => { props.onSendCommand(txCmd.trim()); setTxCmd(""); }}
                >
                  Send
                </button>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflow: view === "instrument" ? "hidden" : "auto", display: "flex", flexDirection: "column" }}>{body}</div>
          )}
          </WidgetErrorBoundary>
        </div>
      </div>
    </div>
  );
}

