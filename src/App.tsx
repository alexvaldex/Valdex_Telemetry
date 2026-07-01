import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { deriveCapabilities } from "./telemetry/capabilities";
import type { TelemetryFrameV1 } from "./telemetry/types";

import { WIDGETS, WIDGETS_BY_CATEGORY, type WidgetId } from "./widgets/registry";
import type { UnitSystem } from "./units";
import { renderWidget } from "./widgets/renderers";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import type { Connection, ConnectionStatus } from "./transport/types";
import { WebSerialConnection, isWebSerialSupported } from "./transport/webSerial";
import { SimulatorConnection } from "./transport/simulator";
import { liveStore } from "./telemetry/liveStore";

/** ---------- Types ---------- */
type WidgetInstance = { key: string; widgetId: WidgetId };

type WidgetSettings = {
  units?: UnitSystem; // per-widget override (otherwise inherit global)
  accent?: string; // per-widget accent override
  view?: "card" | "instrument" | "plot";
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
};

type Model3D = {
  name: string;
  mime: string;
  dataUrl: string; // base64 data url
  uploadedAt: number;
};

/** ---------- Defaults / presets ---------- */
const DEFAULT_THEME: ThemeSettings = { bgA: "#060b16", bgB: "#04070e", consoleBg: "#03060d" };

const THEME_PRESETS: Array<{ name: string; theme: ThemeSettings }> = [
  { name: "Mission Control", theme: { bgA: "#060b16", bgB: "#04070e", consoleBg: "#03060d" } },
  { name: "Deep Space", theme: { bgA: "#050814", bgB: "#070b1b", consoleBg: "#050a16" } },
  { name: "Range Night", theme: { bgA: "#0a0f0c", bgB: "#05090a", consoleBg: "#040807" } },
  { name: "Graphite", theme: { bgA: "#0d0f14", bgB: "#090b10", consoleBg: "#0a0d13" } },
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
  return (
    <svg width="36" height="36" viewBox="0 0 40 40" fill="none" aria-hidden>
      <circle cx="20" cy="20" r="18" stroke="var(--vx-blue)" strokeWidth="1.4" opacity="0.45" />
      <circle cx="20" cy="20" r="13" stroke="var(--vx-line-strong)" strokeWidth="1" opacity="0.6" />
      <path d="M20 5 L27 31 L20 25 L13 31 Z" fill="var(--vx-blue-bright)" />
      <circle cx="20" cy="20" r="2.4" fill="var(--vx-go)" />
    </svg>
  );
}

export default function App() {
  /** Transport */
  const [transportKind, setTransportKind] = useState<"simulator" | "serial">("simulator");
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

  /** 3D model upload storage (NEW) */
  const [model3d, setModel3d] = useState<Model3D | null>(() => {
    try {
      const saved = localStorage.getItem("vx.model3d");
      return saved ? (JSON.parse(saved) as Model3D) : null;
    } catch {
      return null;
    }
  });
  function saveModel3D(m: Model3D | null) {
    setModel3d(m);
    if (m) localStorage.setItem("vx.model3d", JSON.stringify(m));
    else localStorage.removeItem("vx.model3d");
  }

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

  /** Determine frames/latest to DISPLAY */
  const display = useMemo(() => {
    if (playback.mode === "playback") {
      const frames = playback.frames;
      const idx = clamp(playback.idx, 0, Math.max(0, frames.length - 1));
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

    const frames = telemetry.frames ?? [];
    const latest = telemetry.latest;

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
  }, [playback, telemetry, frozen, freezeIdx]);

  const caps = useMemo(() => deriveCapabilities(display.latest), [display.latest]);

  /** Transport actions */
  async function connect() {
    if (connStatus !== "disconnected") return;
    if (transportKind === "serial" && !isWebSerialSupported()) {
      window.alert("Web Serial API not supported in this browser. Use Chrome or Edge, or switch to Simulator.");
      return;
    }

    sessionStartRef.current = Date.now();
    logLinesRef.current = [];
    setLogCount(0);

    lastLineAtRef.current = performance.now();
    lastFrameAtRef.current = 0;
    dtMsWindowRef.current = [];

    liveStore.reset();

    const conn: Connection = transportKind === "simulator" ? new SimulatorConnection() : new WebSerialConnection();

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
      await conn.connect({ baudRate });
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

    const nextLayout: Layout = [...layout, { i: key, x: 0, y: Infinity, w: sizeW, h: sizeH } as any];

    setInstances(nextInstances);
    setLayout(nextLayout);
    persist(nextInstances, nextLayout);

    const accent = def?.defaultTheme?.accent;
    const view = def?.defaultView;
    if (accent || view) saveWidgetSettings(key, { accent, view });

    return key;
  }

  function removeWidget(key: string) {
    if (flightMode) return; // hard lock: no removing

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
    if (!telemetry.frames.length) return;

    if (!frozen) {
      setFrozen(true);
      setFreezeIdx(telemetry.frames.length - 1);
    } else {
      setFrozen(false);
      setFreezeIdx(null);
    }
  }

  /** Playback loader (.jsonl) */
  async function onLoadLogFile(file: File) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const frames: TelemetryFrameV1[] = [];
    const rawLines: string[] = [];

    for (const line of lines) {
      rawLines.push(line);
      try {
        const obj = JSON.parse(line);
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
      filename: file.name,
      playing: false,
      speed: 1,
    });

    setFrozen(false);
    setFreezeIdx(null);
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

    const hasAlt = frames.some((f) => typeof f.alt_m === "number");
    if (hasAlt) {
      const alt = frames.map((f) => (typeof f.alt_m === "number" ? (f.alt_m as number) : NaN));
      const baseIdx = alt.findIndex((a) => Number.isFinite(a));
      const baseline = baseIdx >= 0 ? alt[baseIdx] : 0;

      let liftoffIdx = -1;
      for (let i = 0; i < alt.length; i++) {
        if (Number.isFinite(alt[i]) && alt[i] > baseline + 2) {
          liftoffIdx = i;
          break;
        }
      }
      if (liftoffIdx >= 0 && !events.some((e) => e.id === "LIFTOFF")) {
        events.push({ id: "LIFTOFF", label: "LIFTOFF (derived)", idx: liftoffIdx, t_ms: frames[liftoffIdx].t_ms });
      }

      let maxAlt = -Infinity;
      let apogeeIdx = -1;
      for (let i = 0; i < alt.length; i++) {
        const a = alt[i];
        if (Number.isFinite(a) && a > maxAlt) {
          maxAlt = a;
          apogeeIdx = i;
        }
      }
      if (apogeeIdx >= 0 && !events.some((e) => e.id === "APOGEE")) {
        events.push({ id: "APOGEE", label: "APOGEE (derived)", idx: apogeeIdx, t_ms: frames[apogeeIdx].t_ms });
      }

      let landingIdx = -1;
      for (let i = alt.length - 1; i >= 0; i--) {
        const a = alt[i];
        if (Number.isFinite(a) && a < baseline + 2) {
          landingIdx = i;
          break;
        }
      }
      if (landingIdx >= 0 && landingIdx > apogeeIdx && !events.some((e) => e.id === "LANDING")) {
        events.push({ id: "LANDING", label: "LANDING (derived)", idx: landingIdx, t_ms: frames[landingIdx].t_ms });
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
  }, [display.frames]);

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
    const frames = playback.mode === "playback" ? playback.frames : telemetry.frames;
    const started = new Date(sessionStartRef.current);
    const stamp = started.toISOString().replace(/[:.]/g, "-").split("Z")[0];
    const filename = `valdex_frames_${stamp}.csv`;
    downloadTextFile(filename, toCSV(frames), "text/csv");
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
  }, [linkHealth, playback.mode, battProfile]);

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
  const missionClock = useMemo(() => {
    const liftoff = derivedEvents.find((e) => e.id === "LIFTOFF");
    if (!liftoff) return { label: "T− --:--:--", counting: false };
    const met = display.t_ms - liftoff.t_ms;
    const sign = met >= 0 ? "+" : "−";
    const s = Math.abs(met) / 1000;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return { label: `T${sign} ${pad(hh)}:${pad(mm)}:${pad(ss)}`, counting: met >= 0 };
  }, [derivedEvents, display.t_ms]);

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
    return {
      apogeeM: Number.isFinite(maxAlt) ? maxAlt : undefined,
      maxVelMps: Number.isFinite(maxVel) ? maxVel : undefined,
      maxAccelG: Number.isFinite(maxAccel) ? maxAccel / 9.80665 : undefined,
    };
  }, [display.frames]);

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
            linear-gradient(180deg, rgba(31,157,255,0.03), transparent 240px),
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
          background: rgba(120,175,255,0.05);
          color: var(--vx-fg);
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .vx-xbtn:hover:not(:disabled) { border-color: var(--vx-crit); color: var(--vx-crit); background: rgba(255,59,71,0.1); }

        .vx-select {
          background: rgba(10,16,30,0.85);
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
        .vx-select:focus { border-color: var(--vx-blue); box-shadow: 0 0 0 2px var(--vx-blue-glow); }

        .vx-btn {
          padding: 8px 12px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(120,175,255,0.05);
          color: var(--vx-fg);
          cursor: pointer;
          font-family: var(--vx-font-display);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          transition: all 0.12s ease;
        }
        .vx-btn:hover:not(:disabled) { background: rgba(120,175,255,0.12); border-color: var(--vx-line-strong); }
        .vx-btn-primary {
          background: rgba(31,157,255,0.16);
          border-color: rgba(31,157,255,0.5);
          color: var(--vx-blue-bright);
        }
        .vx-btn-primary:hover:not(:disabled) { background: rgba(31,157,255,0.28); box-shadow: 0 0 14px var(--vx-blue-glow); }
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
          background: rgba(10,16,30,0.6);
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
          border-right: 2px solid var(--vx-blue);
          border-bottom: 2px solid var(--vx-blue);
        }

        .vx-menu {
          position: fixed;
          min-width: 250px;
          background: rgba(7,11,22,0.97);
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
        .vx-menu-item:hover { background: rgba(31,157,255,0.12); }
        .vx-menu-muted { opacity: 0.6; font-size: 12px; }

        .vx-modal-backdrop {
          position: fixed; inset: 0;
          background: rgba(2,4,9,0.78);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          backdrop-filter: blur(3px);
        }
        .vx-modal {
          width: min(1100px, 92vw);
          height: min(720px, 86vh);
          background: rgba(7,11,22,0.98);
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

        .vx-input {
          width: 100%;
          padding: 10px 10px;
          border-radius: 3px;
          border: 1px solid var(--vx-line);
          background: rgba(10,16,30,0.7);
          color: var(--vx-fg);
          outline: none;
          box-sizing: border-box;
          font-family: var(--vx-font-mono);
        }
        .vx-input:focus { border-color: var(--vx-blue); box-shadow: 0 0 0 2px var(--vx-blue-glow); }
        .vx-card {
          border: 1px solid var(--vx-line);
          background: rgba(10,16,30,0.5);
          border-radius: 4px;
          padding: 12px;
        }
        code {
          background: rgba(31,157,255,0.1);
          color: var(--vx-blue-bright);
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
          background: rgba(10,16,30,0.85);
          color: var(--vx-fg);
        }
        .vx-alert .vx-alert-title { text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; font-size: 13px; }
        .vx-alert.info { border-color: var(--vx-blue); }
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
          background: rgba(10,16,30,0.4);
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
          background: linear-gradient(180deg, rgba(31,157,255,0.05), rgba(10,16,30,0.5));
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
        .vx-brand-mark b { color: var(--vx-blue-bright); }
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
          background: var(--vx-blue);
          border-color: var(--vx-blue-bright);
          box-shadow: 0 0 14px var(--vx-blue-glow);
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
          background: rgba(10,16,30,0.5);
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
          background: rgba(8,13,24,0.9);
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
        .vx-readout.peak .v { color: var(--vx-blue-bright); }
      `}</style>

      {/* ---------- Mission Control Header ---------- */}
      <div className="vx-topbar">
        <div className="vx-hdr">
          {/* Brand */}
          <div className="vx-hdr-panel">
            <div className="vx-brand">
              <MissionLogo />
              <div>
                <div className="vx-brand-mark">VX<b>·</b>TELEMETRY</div>
                <div className="vx-brand-sub">Ground Station · {modeChip}</div>
              </div>
            </div>
          </div>

          {/* Mission clock + phase */}
          <div className="vx-hdr-panel vx-clock">
            <div className={`vx-clock-time ${missionClock.counting ? "counting" : ""}`}>{missionClock.label}</div>
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
            <Readout k="APOGEE" peak v={fmtUnit(peaks.apogeeM, globalUnits, "alt")} />
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

            <button className="vx-btn" onClick={() => setSettingsOpen(true)} title="Settings">Settings</button>
            <button className="vx-btn" onClick={() => setPaletteOpen(true)} title="Command Palette (Ctrl+K)">⌘K</button>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="vx-alertbar">
          {alerts.map((a) => (
            <div key={a.id} className={`vx-alert ${a.level}`}>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
                <span className={`vx-dot`} style={{ background: a.level === "crit" ? "var(--vx-crit)" : a.level === "warn" ? "var(--vx-caution)" : "var(--vx-blue)" }} />
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
            <option value="serial">Serial{isWebSerialSupported() ? "" : " (unsupported browser)"}</option>
          </select>

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
        </div>

        <div className="vx-toolbar-right">
          <button className="vx-btn" onClick={exportSessionJSONL} title={`Export raw telemetry (Ctrl+E) (${logCount})`}>Export JSONL</button>
          <button className="vx-btn" onClick={exportFramesCSV} title="Export frames as CSV (Ctrl+Shift+E)">Export CSV</button>

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
        <RGL
          {...({
            className: "layout",
            layout,
            cols: GRID_COLS,
            rowHeight: 30,
            width: 1200,
            compactType: "vertical",
            preventCollision: true,
            draggableHandle: ".vx-titlebar",
            resizeHandles: isLayoutEditable ? ["se", "s", "e", "n", "w", "ne", "nw", "sw"] : [],
            isDraggable: isLayoutEditable,
            isResizable: isLayoutEditable,
            onLayoutChange: (nextLayout: any) => {
              if (!isLayoutEditable) return;
              setLayout(nextLayout as Layout);
              persist(instances, nextLayout as Layout);
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
                theme={theme}
                model3d={model3d}
                onPatchSettings={(patch) => saveWidgetSettings(inst.key, patch)}
                onResetAccent={() => resetWidgetAccent(inst.key)}
                onRemove={() => removeWidget(inst.key)}
              />
            </div>
          ))}
        </RGL>
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
          model3d={model3d}
          onClose={() => setSettingsOpen(false)}
          onTheme={(p) => saveTheme(p)}
          onThemePreset={(t) => {
            setTheme(t);
            localStorage.setItem("vx.theme", JSON.stringify(t));
          }}
          onThemeReset={resetTheme}
          onBatt={(p) => saveBattProfile(p)}
          onUnits={(u) => saveGlobalUnits(u)}
          onModel3D={saveModel3D}
        />
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

/** ---------- SettingsModal ---------- */
function SettingsModal(props: {
  theme: ThemeSettings;
  battProfile: BatteryProfile;
  globalUnits: UnitSystem;
  model3d: Model3D | null;
  onClose: () => void;
  onTheme: (patch: Partial<ThemeSettings>) => void;
  onThemePreset: (t: ThemeSettings) => void;
  onThemeReset: () => void;
  onBatt: (patch: Partial<BatteryProfile>) => void;
  onUnits: (u: UnitSystem) => void;
  onModel3D: (m: Model3D | null) => void;
}) {
  const fg = autoTextColor(props.theme.bgB);

  async function uploadModel(file: File) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error("read failed"));
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });

    const model: Model3D = {
      name: file.name,
      mime: file.type || "application/octet-stream",
      dataUrl,
      uploadedAt: Date.now(),
    };

    // localStorage size can be tight. if it fails, we keep UI stable.
    try {
      props.onModel3D(model);
    } catch {
      alert("Model too large to store locally. Use a smaller GLB or we’ll add IndexedDB storage next.");
    }
  }

  return (
    <div className="vx-modal-backdrop" onMouseDown={props.onClose}>
      <div className="vx-modal" onMouseDown={(e) => e.stopPropagation()}>
        {/* Left: Theme + Units */}
        <div className="vx-pane">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Settings</div>
            <button className="vx-xbtn" onClick={props.onClose}>×</button>
          </div>

          <div className="vx-card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Units</div>
            <select className="vx-select" value={props.globalUnits} onChange={(e) => props.onUnits(e.target.value as UnitSystem)} style={{ width: "100%" }}>
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </div>

          <div className="vx-card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Theme</div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {THEME_PRESETS.map((p) => (
                <button key={p.name} className="vx-btn" onClick={() => props.onThemePreset(p.theme)}>
                  {p.name}
                </button>
              ))}
              <button className="vx-btn vx-btn-danger" onClick={props.onThemeReset}>Reset</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <ColorTile
                label="Background A"
                value={props.theme.bgA}
                onChange={(v) => props.onTheme({ bgA: v })}
                onReset={() => props.onTheme({ bgA: DEFAULT_THEME.bgA })}
              />
              <ColorTile
                label="Background B"
                value={props.theme.bgB}
                onChange={(v) => props.onTheme({ bgB: v })}
                onReset={() => props.onTheme({ bgB: DEFAULT_THEME.bgB })}
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <ColorTile
                label="Console Background"
                value={props.theme.consoleBg}
                onChange={(v) => props.onTheme({ consoleBg: v })}
                onReset={() => props.onTheme({ consoleBg: DEFAULT_THEME.consoleBg })}
              />
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              Auto text color: <code>{fg}</code>
            </div>
          </div>
        </div>

        {/* Middle: Battery */}
        <div className="vx-pane">
          <div className="vx-card">
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Battery Profile</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Chemistry</div>
                <select className="vx-select" value={props.battProfile.chem} onChange={(e) => props.onBatt({ chem: e.target.value as BatteryChem })} style={{ width: "100%" }}>
                  <option value="LiPo">LiPo</option>
                  <option value="LiIon">Li-Ion</option>
                  <option value="LiFe">LiFePO4</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Cells (S)</div>
                <input
                  className="vx-input"
                  type="number"
                  min={1}
                  max={12}
                  value={props.battProfile.cells}
                  onChange={(e) => props.onBatt({ cells: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Warn %</div>
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
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Critical %</div>
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

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
              This affects the battery % estimator using incoming <code>batt_v</code>.
            </div>
          </div>
        </div>

        {/* Right: 3D model */}
        <div className="vx-pane">
          <div className="vx-card">
            <div style={{ fontWeight: 900, marginBottom: 8 }}>3D Vehicle Model</div>

            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.6 }}>
              Upload a model to use in the 3D renderer (recommended: <code>.glb</code>).
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label className="vx-btn vx-btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                Upload Model
                <input
                  type="file"
                  accept=".glb,.gltf,.stl,.obj"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) await uploadModel(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>

              <button className="vx-btn vx-btn-danger" onClick={() => props.onModel3D(null)} disabled={!props.model3d}>
                Clear
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              {props.model3d ? (
                <div className="vx-card" style={{ background: "rgba(255,255,255,0.04)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Current model</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    <div><code>{props.model3d.name}</code></div>
                    <div style={{ marginTop: 6 }}>Stored key: <code>vx.model3d</code></div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.75 }}>No model uploaded.</div>
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              If your 3D widget isn’t using <code>vx.model3d</code> yet, tell me its widget id and I’ll wire it to load this automatically.
            </div>
          </div>

          <div className="vx-card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Shortcuts</div>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.8 }}>
              <div><code>Ctrl+K</code> Command Palette</div>
              <div><code>F</code> Freeze/Unfreeze</div>
              <div><code>Ctrl+E</code> Export JSONL</div>
              <div><code>Ctrl+Shift+E</code> Export CSV</div>
              <div><code>Esc</code> Close menus/modals</div>
            </div>
          </div>

          <div className="vx-card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Preview</div>
            <div
              style={{
                height: 120,
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.14)",
                background: `linear-gradient(135deg, ${props.theme.bgA}, ${props.theme.bgB})`,
                color: autoTextColor(props.theme.bgB),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 900,
              }}
            >
              Valdex Telemetry
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button className="vx-btn" onClick={props.onClose}>Done</button>
          </div>
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
          background: "rgba(10,14,30,0.96)",
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
  const [accent, setAccent] = useState<string>(() => selected?.defaultTheme?.accent ?? "#7aa2ff");
  const [view, setView] = useState<"card" | "instrument" | "plot">(() => selected?.defaultView ?? "card");

  useEffect(() => {
    const def: any = WIDGETS.find((x: any) => x.id === selectedId);
    if (!def) return;
    setW(def.defaultSize?.w ?? 6);
    setH(def.defaultSize?.h ?? 6);
    setAccent(def.defaultTheme?.accent ?? "#7aa2ff");
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
                    outline: isSel ? "2px solid rgba(90,160,255,0.55)" : "none",
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
function WidgetFrame(props: {
  instKey: string;
  widgetId: WidgetId;
  telemetry: any;
  latest: any;
  caps: any;
  globalUnits: UnitSystem;
  settings?: WidgetSettings;
  locked: boolean;
  theme: ThemeSettings;
  model3d: Model3D | null;
  onPatchSettings: (patch: WidgetSettings) => void;
  onResetAccent: () => void;
  onRemove: () => void;
}) {
  const def: any = WIDGETS.find((x: any) => x.id === props.widgetId);

  const requires = normalizeRequires(def?.requires);
  const enabled = requires.length === 0 || requires.every((r) => capHas(props.caps, r));

  const defaultAccent = def?.defaultTheme?.accent ?? "#7aa2ff";
  const accent = props.settings?.accent ?? defaultAccent;
  const unitSystem: UnitSystem = props.settings?.units ?? props.globalUnits;
  const view = props.settings?.view ?? def?.defaultView ?? "card";

  // RAW console special scrolling
  const rawRef = useRef<HTMLDivElement | null>(null);
  const rawPinnedTopRef = useRef(true);

  useEffect(() => {
    if (props.widgetId !== "raw.console") return;
    const el = rawRef.current;
    if (!el) return;
    if (rawPinnedTopRef.current) el.scrollTop = 0;
  }, [props.telemetry?.rawLines, props.widgetId]);

  // Pass model3d via localStorage for widgets to consume if they want.
  // Your 3D widget can read `vx.model3d`.
  useEffect(() => {
    // no-op: already stored by SettingsModal; this is just to keep the prop “used”.
    void props.model3d;
  }, [props.model3d]);

  const body = renderWidget({ widgetId: props.widgetId, latest: props.latest, telemetry: props.telemetry, unitSystem, view });

  const consoleFg = autoTextColor(props.theme.consoleBg);

  return (
    <div
      className="vx-widget vx-widget-outline"
      style={{
        border: `1px solid var(--vx-line)`,
        background: "linear-gradient(180deg, rgba(31,157,255,0.03), rgba(8,13,24,0.85))",
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        opacity: enabled ? 1 : 0.3,
      }}
      title={enabled ? "" : def?.hardwareHint ?? "Missing required telemetry"}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: accent }} />

      <div className="vx-widget-inner" style={{ paddingLeft: 12 }}>  
        <div className="vx-titlebar">
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", minWidth: 0 }}>
            <span style={{ fontSize: 16, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {def?.name ?? props.widgetId}
            </span>
            {requires.length ? (
              <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap" }}>
                requires: {requires.slice(0, 3).join(", ")}{requires.length > 3 ? "…" : ""}
              </span>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4 }}>
              <button className={`vx-btn ${view === "card" ? "vx-btn-primary" : ""}`} onClick={() => props.onPatchSettings({ view: "card" })} title="Card view" style={{ padding: "6px 8px" }}>NUM</button>
              <button className={`vx-btn ${view === "instrument" ? "vx-btn-primary" : ""}`} onClick={() => props.onPatchSettings({ view: "instrument" })} title="Instrument view" style={{ padding: "6px 8px" }}>GAUGE</button>
              <button className={`vx-btn ${view === "plot" ? "vx-btn-primary" : ""}`} onClick={() => props.onPatchSettings({ view: "plot" })} title="Plot view" style={{ padding: "6px 8px" }}>PLOT</button>
            </div>

            <select
              className="vx-select"
              value={(props.settings?.units ?? ("inherit" as any)) as any}
              onChange={(e) => {
                const v = e.target.value;
                props.onPatchSettings({ units: v === "inherit" ? undefined : (v as UnitSystem) });
              }}
              title="Per-widget units"
            >
              <option value="inherit">Units</option>
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>

            {/* Accent picker + reset */}
            <label
              title="Widget accent color"
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.18)",
                background: accent,
                cursor: "pointer",
                overflow: "hidden",
              }}
            >
              <input type="color" value={accent} onChange={(e) => props.onPatchSettings({ accent: e.target.value })} style={{ opacity: 0, width: "100%", height: "100%" }} />
            </label>

            <button className="vx-btn vx-btn-danger" onClick={props.onResetAccent} title={`Reset accent to default (${defaultAccent})`} style={{ padding: "6px 10px" }}>
              Reset
            </button>

            <button className="vx-xbtn" onClick={props.onRemove} title={props.locked ? "Locked" : "Remove widget"} disabled={props.locked}>
              ×
            </button>
          </div>
        </div>

        {props.widgetId === "raw.console" ? (
          <div
            ref={rawRef}
            style={{
              height: "calc(100% - 52px)",
              overflow: "auto",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.10)",
              background: props.theme.consoleBg,
              padding: 10,
              color: consoleFg,
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              rawPinnedTopRef.current = el.scrollTop <= 2;
            }}
          >
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.95 }}>
              {[...(props.telemetry.rawLines ?? [])].slice().reverse().join("\n")}
            </pre>
          </div>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

