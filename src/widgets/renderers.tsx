// src/widgets/renderers.tsx
import React, { useMemo } from "react";
import type { WidgetId } from "./registry";
import type { TelemetryFrameV1 } from "../telemetry/types";
import type { UnitSystem } from "../units";

import { lazy, Suspense, useState } from "react";

// Heavy three.js viewer, code-split so it downloads only when a 3D widget shows.
const RocketViewer = lazy(() => import("./RocketViewer"));

/** --------- Pre-flight checklist (L3-style) --------- */
type ChecklistItem = { id: string; text: string; done: boolean };

const DEFAULT_CHECKLIST = [
  "Motor assembled per manufacturer spec",
  "Recovery harness secured & inspected",
  "Drogue packed, chute protector in place",
  "Main packed, chute protector in place",
  "Ejection charges sized & installed",
  "Altimeter armed — continuity verified",
  "GPS tracker on — fix acquired",
  "Rail buttons / launch lugs secured",
  "CG verified against CP (stable margin)",
  "Igniter installed at the pad only",
  "RSO / LCO clearance — range is GO",
];

function loadChecklist(): ChecklistItem[] {
  try {
    const raw = localStorage.getItem("vx.checklist");
    if (raw) return JSON.parse(raw) as ChecklistItem[];
  } catch {
    // fall through to defaults
  }
  return DEFAULT_CHECKLIST.map((text, i) => ({ id: `c${i}`, text, done: false }));
}

function ChecklistPanel() {
  const [items, setItems] = useState<ChecklistItem[]>(loadChecklist);
  const [newText, setNewText] = useState("");

  function persist(next: ChecklistItem[]) {
    setItems(next);
    localStorage.setItem("vx.checklist", JSON.stringify(next));
  }

  const done = items.filter((i) => i.done).length;
  const allGo = items.length > 0 && done === items.length;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr auto", gap: 10, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span className="vx-num" style={{ fontSize: 13, color: "var(--vx-fg-dim)" }}>{done}/{items.length}</span>
        <span
          style={{
            fontFamily: "var(--vx-font-display)", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em",
            color: allGo ? "var(--vx-go)" : "var(--vx-caution)",
          }}
        >
          {allGo ? "● ALL SYSTEMS GO" : "● HOLD — ITEMS OPEN"}
        </span>
      </div>

      <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
        <div
          style={{
            width: `${items.length ? (done / items.length) * 100 : 0}%`, height: "100%",
            background: allGo ? "var(--vx-go)" : "var(--vx-blue)", transition: "width 0.25s ease",
          }}
        />
      </div>

      <div style={{ overflow: "auto", minHeight: 0, display: "grid", gap: 4, alignContent: "start" }}>
        {items.map((item) => (
          <label
            key={item.id}
            style={{
              display: "flex", gap: 10, alignItems: "center", padding: "7px 9px", borderRadius: 3,
              border: "1px solid var(--vx-line)", background: item.done ? "rgba(36,224,138,0.06)" : "rgba(10,16,30,0.5)",
              cursor: "pointer", fontSize: 13,
              color: item.done ? "var(--vx-fg-dim)" : "var(--vx-fg)",
              textDecoration: item.done ? "line-through" : "none",
            }}
          >
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => persist(items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
            />
            <span style={{ flex: 1 }}>{item.text}</span>
            <button
              onClick={(e) => { e.preventDefault(); persist(items.filter((i) => i.id !== item.id)); }}
              style={{ background: "none", border: "none", color: "var(--vx-fg-faint)", cursor: "pointer", fontSize: 14 }}
              title="Remove item"
            >
              ×
            </button>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="vx-input"
          style={{ flex: 1 }}
          placeholder="Add checklist item…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newText.trim()) {
              persist([...items, { id: `c${Date.now()}`, text: newText.trim(), done: false }]);
              setNewText("");
            }
          }}
        />
        <button
          className="vx-btn"
          onClick={() => persist(loadChecklistDefaults())}
          title="Reset all items to unchecked defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function loadChecklistDefaults(): ChecklistItem[] {
  return DEFAULT_CHECKLIST.map((text, i) => ({ id: `c${i}`, text, done: false }));
}

import { FlightSummaryWidget } from "./flightSummary";
import { RangeMapWidget } from "./rangeMap";
import { PyroPanelWidget } from "./pyroPanel";



/** --------- unit helpers (local, minimal) --------- */
function mToFt(m: number) { return m * 3.280839895; }
function mpsToFps(v: number) { return v * 3.280839895; }

function fmt(n: number | undefined, digits = 2): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/** --------- shared instrument primitives --------- */
function seriesStats(frames: TelemetryFrameV1[], key: string, xform?: (v: number) => number) {
  let min = Infinity, max = -Infinity, n = 0;
  for (const f of frames) {
    const raw = (f as any)[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const v = xform ? xform(raw) : raw;
    if (v < min) min = v;
    if (v > max) max = v;
    n++;
  }
  return n ? { min, max } : null;
}

function BigReadout(props: {
  value: string;
  unit: string;
  accent?: string;
  sub?: React.ReactNode;
  stats?: { min: number; max: number } | null;
  statFmt?: (v: number) => string;
}) {
  const sf = props.statFmt ?? ((v: number) => v.toFixed(0));
  return (
    <div style={{ display: "grid", gap: 10, height: "100%", alignContent: "center" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontFamily: "var(--vx-font-mono)",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 800,
            // Scales with the widget (container query units), clamped for sanity.
            fontSize: "clamp(26px, min(13cqw, 26cqh), 72px)",
            lineHeight: 1,
            color: props.accent ?? "var(--vx-fg)",
          }}
        >
          {props.value}
        </span>
        <span style={{ fontSize: "clamp(11px, 4cqw, 16px)", color: "var(--vx-fg-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          {props.unit}
        </span>
      </div>

      {props.stats ? (
        <div style={{ display: "flex", gap: 16, fontSize: 11 }}>
          <span style={{ color: "var(--vx-fg-dim)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            MIN <b style={{ fontFamily: "var(--vx-font-mono)", color: "var(--vx-fg)" }}>{sf(props.stats.min)}</b>
          </span>
          <span style={{ color: "var(--vx-fg-dim)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            PK <b style={{ fontFamily: "var(--vx-font-mono)", color: "var(--vx-blue-bright)" }}>{sf(props.stats.max)}</b>
          </span>
        </div>
      ) : null}

      {props.sub ? <div style={{ fontSize: 11, color: "var(--vx-fg-dim)", letterSpacing: "0.06em" }}>{props.sub}</div> : null}
    </div>
  );
}

function GaugeBar(props: { pct: number; accent?: string }) {
  const pct = Math.max(0, Math.min(1, props.pct));
  return (
    <div style={{ height: 10, borderRadius: 2, border: "1px solid var(--vx-line)", background: "rgba(0,0,0,0.35)", overflow: "hidden" }}>
      <div style={{ width: `${pct * 100}%`, height: "100%", background: props.accent ?? "var(--vx-blue)", boxShadow: "0 0 10px var(--vx-blue-glow)" }} />
    </div>
  );
}

/** --------- plotting (simple SVG) --------- */
function PlotLine(props: {
  frames: TelemetryFrameV1[];
  yKey: string;
  yLabel: string;
  color?: string;
  height?: number;
  fill?: boolean; // fill the available height instead of a fixed px height
  transformY?: (v: number) => number;
}) {
  const h = props.height ?? 160;

  const points = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < props.frames.length; i++) {
      const f = props.frames[i] as any;
      const yRaw = f[props.yKey];
      const y = typeof yRaw === "number" ? yRaw : NaN;
      if (!Number.isFinite(y)) continue;
      xs.push(i);
      ys.push(props.transformY ? props.transformY(y) : y);
    }
    if (xs.length < 2) return null;

    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const span = (yMax - yMin) || 1;

    const W = 1000; // normalize, then scale via viewBox
    const H = 1000;

    const path = xs.map((x, idx) => {
      const px = (idx / (xs.length - 1)) * W;
      const py = H - ((ys[idx] - yMin) / span) * H;
      return `${idx === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`;
    }).join(" ");

    // Flight-event markers, positioned on the same x-scale as the trace.
    // xs[k] is the original frame index of the k-th plotted point; map each
    // event frame to the nearest plotted point so markers line up with data.
    const markers: Array<{ frac: number; label: string }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < props.frames.length; i++) {
      const ev = (props.frames[i] as any)?.event;
      if (typeof ev !== "string" || !ev.trim()) continue;
      const label = ev.trim().toUpperCase();
      if (seen.has(label)) continue;
      seen.add(label);
      let k = 0, best = Infinity;
      for (let j = 0; j < xs.length; j++) {
        const d = Math.abs(xs[j] - i);
        if (d < best) { best = d; k = j; }
      }
      markers.push({ frac: k / (xs.length - 1), label });
    }

    return { path, yMin, yMax, markers };
  }, [props.frames, props.yKey, props.transformY]);

  return (
    <div
      style={{
        borderRadius: 3, border: "1px solid var(--vx-line)", background: "rgba(4,7,14,0.6)", padding: 10,
        ...(props.fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : {}),
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flex: "0 0 auto" }}>
        <div className="vx-label">{props.yLabel}</div>
        {points ? (
          <div style={{ fontSize: 11, color: "var(--vx-fg-dim)", fontFamily: "var(--vx-font-mono)" }}>
            {points.yMin.toFixed(1)} / {points.yMax.toFixed(1)}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--vx-fg-faint)" }}>NO DATA</div>
        )}
      </div>

      <div style={{ position: "relative", ...(props.fill ? { flex: 1, minHeight: 60 } : {}) }}>
        <svg viewBox="0 0 1000 1000" width="100%" height={props.fill ? "100%" : h} preserveAspectRatio="none" style={{ display: "block", ...(props.fill ? { position: "absolute", inset: 0 } : {}) }}>
          <path
            d={points?.path ?? ""}
            fill="none"
            stroke={props.color ?? "var(--vx-blue-bright)"}
            strokeWidth={8}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.95}
          />
        </svg>

        {/* Event markers overlaid on the trace */}
        {points?.markers.map((m) => (
          <div
            key={m.label}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${(m.frac * 100).toFixed(2)}%`,
              borderLeft: "1px dashed var(--vx-caution)",
              opacity: 0.7,
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: m.frac > 0.85 ? "auto" : 3,
                right: m.frac > 0.85 ? 3 : "auto",
                fontSize: 9,
                letterSpacing: "0.08em",
                fontFamily: "var(--vx-font-mono)",
                color: "var(--vx-caution)",
                background: "rgba(4,7,14,0.75)",
                padding: "1px 3px",
                borderRadius: 2,
                whiteSpace: "nowrap",
              }}
            >
              {m.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** --------- quaternion -> euler --------- */
function quatToEuler(qw?: number, qx?: number, qy?: number, qz?: number) {
  if (![qw, qx, qy, qz].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const w = qw as number, x = qx as number, y = qy as number, z = qz as number;

  // roll (x-axis rotation)
  const sinr_cosp = 2 * (w * x + y * z);
  const cosr_cosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr_cosp, cosr_cosp);

  // pitch (y-axis rotation)
  const sinp = 2 * (w * y - z * x);
  let pitch: number;
  if (Math.abs(sinp) >= 1) pitch = Math.sign(sinp) * (Math.PI / 2);
  else pitch = Math.asin(sinp);

  // yaw (z-axis rotation)
  const siny_cosp = 2 * (w * z + x * y);
  const cosy_cosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny_cosp, cosy_cosp);

  const rad2deg = 180 / Math.PI;
  return { roll: roll * rad2deg, pitch: pitch * rad2deg, yaw: yaw * rad2deg };
}

/** --------- attitude instrument (SVG artificial horizon) --------- */
function ArtificialHorizon(props: { rollDeg?: number; pitchDeg?: number }) {
  const roll = Number.isFinite(props.rollDeg as number) ? (props.rollDeg as number) : 0;
  const pitch = Number.isFinite(props.pitchDeg as number) ? (props.pitchDeg as number) : 0;

  // scale pitch into pixels
  const pitchPx = (-pitch / 45) * 80; // 45deg -> 80px
  const cx = 160, cy = 110;
  const r = 96;

  return (
    <div style={{ borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.12)", padding: 10 }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>Artificial Horizon</div>

      <svg width="100%" viewBox="0 0 320 240" style={{ display: "block" }}>
        <defs>
          <clipPath id="clip">
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>

        {/* outer ring */}
        <circle cx={cx} cy={cy} r={r + 10} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="8" />

        {/* clipped horizon */}
        <g clipPath="url(#clip)">
          <g transform={`translate(${cx},${cy}) rotate(${roll}) translate(${-cx},${-cy})`}>
            {/* sky */}
            <rect x="0" y="0" width="320" height="240" fill="rgba(90,160,255,0.25)" />
            {/* ground */}
            <rect x="0" y={cy + pitchPx} width="320" height="240" fill="rgba(255,190,90,0.22)" />
            {/* horizon line */}
            <line
              x1="0"
              y1={cy + pitchPx}
              x2="320"
              y2={cy + pitchPx}
              stroke="rgba(255,255,255,0.75)"
              strokeWidth="3"
            />

            {/* pitch ladder */}
            {[-30, -20, -10, 10, 20, 30].map((p) => {
              const y = cy + pitchPx + (-p / 45) * 80;
              const w = p % 20 === 0 ? 120 : 80;
              return (
                <g key={p} opacity={0.8}>
                  <line x1={cx - w / 2} y1={y} x2={cx + w / 2} y2={y} stroke="rgba(255,255,255,0.5)" strokeWidth="2" />
                  <text x={cx + w / 2 + 10} y={y + 4} fontSize="12" fill="rgba(255,255,255,0.65)">
                    {p}
                  </text>
                </g>
              );
            })}
          </g>
        </g>

        {/* fixed aircraft symbol */}
        <g>
          <line x1={cx - 50} y1={cy} x2={cx - 10} y2={cy} stroke="rgba(255,255,255,0.8)" strokeWidth="4" />
          <line x1={cx + 10} y1={cy} x2={cx + 50} y2={cy} stroke="rgba(255,255,255,0.8)" strokeWidth="4" />
          <line x1={cx - 10} y1={cy} x2={cx + 10} y2={cy} stroke="rgba(255,255,255,0.95)" strokeWidth="6" />
          <line x1={cx} y1={cy} x2={cx} y2={cy + 18} stroke="rgba(255,255,255,0.85)" strokeWidth="4" />
        </g>

        {/* roll ticks */}
        {[ -60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60 ].map((a) => {
          const ang = (a - 90) * (Math.PI / 180);
          const r1 = r + 2;
          const r2 = r + (a % 30 === 0 ? 18 : 10);
          const x1 = cx + r1 * Math.cos(ang);
          const y1 = cy + r1 * Math.sin(ang);
          const x2 = cx + r2 * Math.cos(ang);
          const y2 = cy + r2 * Math.sin(ang);
          return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.35)" strokeWidth="3" />;
        })}
      </svg>
    </div>
  );
}

/** --------- 3D rocket (quaternion-driven) --------- */

/** --------- renderer entry --------- */
export function renderWidget(args: {
  widgetId: WidgetId;
  latest?: TelemetryFrameV1;
  telemetry: { frames: TelemetryFrameV1[]; rawLines: string[] };
  unitSystem: UnitSystem;
  view: "card" | "instrument" | "plot";
}) {
  const { widgetId, latest, telemetry, unitSystem, view } = args;
  const frames = telemetry.frames ?? [];

  if (widgetId === "altitude.card") {
    const altM = latest?.alt_m;
    const v = typeof altM === "number" ? (unitSystem === "imperial" ? mToFt(altM) : altM) : undefined;
    const u = unitSystem === "imperial" ? "ft" : "m";

    if (view === "plot") {
      return <PlotLine fill frames={frames} yKey="alt_m" yLabel={`Altitude (${u})`} transformY={(m) => (unitSystem === "imperial" ? mToFt(m) : m)} />;
    }

    if (view === "instrument") {
      const value = typeof v === "number" ? v : NaN;
      const pct = Number.isFinite(value) ? Math.max(0, Math.min(1, value / (unitSystem === "imperial" ? 5000 : 1500))) : 0;
      return (
        <div style={{ display: "grid", gap: 12, alignContent: "center", height: "100%" }}>
          <BigReadout value={fmt(v, 0)} unit={u} />
          <GaugeBar pct={pct} />
          <div className="vx-label">Full scale ~{unitSystem === "imperial" ? "5000 ft" : "1500 m"}</div>
        </div>
      );
    }

    return (
      <BigReadout
        value={fmt(v, 1)}
        unit={u}
        stats={seriesStats(frames, "alt_m", (m) => (unitSystem === "imperial" ? mToFt(m) : m))}
        sub={`MET ${fmt(latest?.t_ms, 0)} ms`}
      />
    );
  }

  if (widgetId === "velocity.card") {
    const vel = latest?.vel_mps;
    const v = typeof vel === "number" ? (unitSystem === "imperial" ? mpsToFps(vel) : vel) : undefined;
    const u = unitSystem === "imperial" ? "ft/s" : "m/s";

    if (view === "plot") {
      return <PlotLine fill frames={frames} yKey="vel_mps" yLabel={`Velocity (${u})`} transformY={(mps) => (unitSystem === "imperial" ? mpsToFps(mps) : mps)} />;
    }

    if (view === "instrument") {
      const value = typeof v === "number" ? v : NaN;
      const max = unitSystem === "imperial" ? 2000 : 600;
      const pct = Number.isFinite(value) ? Math.max(0, Math.min(1, Math.abs(value) / max)) : 0;
      const accent = Number.isFinite(value) && value < 0 ? "var(--vx-caution)" : "var(--vx-blue-bright)";
      return (
        <div style={{ display: "grid", gap: 12, alignContent: "center", height: "100%" }}>
          <BigReadout value={fmt(v, 1)} unit={u} accent={accent} />
          <GaugeBar pct={pct} accent={accent} />
          <div className="vx-label">Full scale ~{max} {u}</div>
        </div>
      );
    }

    const ascending = typeof vel === "number" && vel >= 0;
    // Mach from local speed of sound: a = sqrt(γ·R·T), T from onboard temp when present.
    const tempC = typeof latest?.temp_c === "number" ? latest.temp_c : 15;
    const mach = typeof vel === "number" ? Math.abs(vel) / Math.sqrt(1.4 * 287.05 * (tempC + 273.15)) : undefined;
    const dirText = typeof vel === "number" ? (ascending ? "▲ ASCENDING" : "▼ DESCENDING") : "+ up / − down";
    return (
      <BigReadout
        value={fmt(v, 1)}
        unit={u}
        accent={typeof vel === "number" ? (ascending ? "var(--vx-fg)" : "var(--vx-caution)") : undefined}
        stats={seriesStats(frames, "vel_mps", (mps) => (unitSystem === "imperial" ? mpsToFps(mps) : mps))}
        sub={
          mach !== undefined && mach >= 0.3 ? (
            <span>
              {dirText} · <b style={{ color: mach >= 1 ? "var(--vx-caution)" : "var(--vx-blue-bright)", fontFamily: "var(--vx-font-mono)" }}>MACH {mach.toFixed(2)}</b>
            </span>
          ) : (
            dirText
          )
        }
      />
    );
  }

  if (widgetId === "battery.card") {
    const bv = latest?.batt_v;

    if (view === "plot") {
      return <PlotLine fill frames={frames} yKey="batt_v" yLabel={`Battery (V)`} transformY={(v) => v} />;
    }

    if (view === "instrument") {
      const v = typeof bv === "number" ? bv : NaN;
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - 3.2) / (4.2 - 3.2))) : 0;
      const accent = pct < 0.15 ? "var(--vx-crit)" : pct < 0.35 ? "var(--vx-caution)" : "var(--vx-go)";
      return (
        <div style={{ display: "grid", gap: 12, alignContent: "center", height: "100%" }}>
          <BigReadout value={fmt(bv, 2)} unit="V" accent={accent} />
          <GaugeBar pct={pct} accent={accent} />
          <div className="vx-label">Per-cell scale 3.2–4.2 V · Settings for pack %</div>
        </div>
      );
    }

    return (
      <BigReadout
        value={fmt(bv, 2)}
        unit="V"
        stats={seriesStats(frames, "batt_v")}
        statFmt={(x) => x.toFixed(2)}
        sub="Set battery profile in Settings for pack % + alerts"
      />
    );
  }

  if (widgetId === "attitude.card") {
    const e = quatToEuler(latest?.q_w, latest?.q_x, latest?.q_y, latest?.q_z);

    if (view === "plot") {
      // build pseudo-frames with derived roll/pitch/yaw in custom renderer
      const rollFrames = frames.map((f) => ({ ...f, __roll: quatToEuler(f.q_w, f.q_x, f.q_y, f.q_z)?.roll } as any));
      const pitchFrames = frames.map((f) => ({ ...f, __pitch: quatToEuler(f.q_w, f.q_x, f.q_y, f.q_z)?.pitch } as any));
      const yawFrames = frames.map((f) => ({ ...f, __yaw: quatToEuler(f.q_w, f.q_x, f.q_y, f.q_z)?.yaw } as any));

      return (
        <div style={{ display: "grid", gap: 10 }}>
          <PlotLine frames={rollFrames as any} yKey="__roll" yLabel="Roll (deg)" />
          <PlotLine frames={pitchFrames as any} yKey="__pitch" yLabel="Pitch (deg)" />
          <PlotLine frames={yawFrames as any} yKey="__yaw" yLabel="Yaw (deg)" />
        </div>
      );
    }

    if (view === "instrument") {
      return (
        <div style={{ display: "grid", gap: 10 }}>
          <ArtificialHorizon rollDeg={e?.roll} pitchDeg={e?.pitch} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, opacity: 0.85, border: "1px solid rgba(255,255,255,0.10)", padding: "6px 10px", borderRadius: 999 }}>
              Roll {e ? e.roll.toFixed(1) : "—"}°
            </span>
            <span style={{ fontSize: 12, opacity: 0.85, border: "1px solid rgba(255,255,255,0.10)", padding: "6px 10px", borderRadius: 999 }}>
              Pitch {e ? e.pitch.toFixed(1) : "—"}°
            </span>
            <span style={{ fontSize: 12, opacity: 0.85, border: "1px solid rgba(255,255,255,0.10)", padding: "6px 10px", borderRadius: 999 }}>
              Yaw {e ? e.yaw.toFixed(1) : "—"}°
            </span>
          </div>
        </div>
      );
    }

    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Attitude (Euler derived)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div style={{ borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)", padding: 10, background: "rgba(0,0,0,0.10)" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Roll</div>
            <div style={{ fontWeight: 900, fontSize: 24 }}>{e ? e.roll.toFixed(1) : "—"}°</div>
          </div>
          <div style={{ borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)", padding: 10, background: "rgba(0,0,0,0.10)" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Pitch</div>
            <div style={{ fontWeight: 900, fontSize: 24 }}>{e ? e.pitch.toFixed(1) : "—"}°</div>
          </div>
          <div style={{ borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)", padding: 10, background: "rgba(0,0,0,0.10)" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Yaw</div>
            <div style={{ fontWeight: 900, fontSize: 24 }}>{e ? e.yaw.toFixed(1) : "—"}°</div>
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Driven from q_w/q_x/q_y/q_z.</div>
      </div>
    );
  }

  if (widgetId === "vehicle.3d") {
    const qOk =
      typeof latest?.q_w === "number" &&
      typeof latest?.q_x === "number" &&
      typeof latest?.q_y === "number" &&
      typeof latest?.q_z === "number";

    const q = qOk ? { w: latest!.q_w!, x: latest!.q_x!, y: latest!.q_y!, z: latest!.q_z! } : null;

    if (view === "plot") {
      // for this widget, plot view is just euler
      const e = quatToEuler(latest?.q_w, latest?.q_x, latest?.q_y, latest?.q_z);
      return (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 900 }}>3D Orientation Source</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            q={q ? `${q.w.toFixed(3)}, ${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}` : "—"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            roll/pitch/yaw={e ? `${e.roll.toFixed(1)}°, ${e.pitch.toFixed(1)}°, ${e.yaw.toFixed(1)}°` : "—"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>Switch to Instrument view for 3D.</div>
        </div>
      );
    }

    if (view === "card") {
      const e = quatToEuler(latest?.q_w, latest?.q_x, latest?.q_y, latest?.q_z);
      return (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>3D Vehicle</div>
          <div style={{ fontWeight: 900, fontSize: 18 }}>{q ? "Quaternion OK" : "No quaternion"}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {e ? `R ${e.roll.toFixed(1)}° / P ${e.pitch.toFixed(1)}° / Y ${e.yaw.toFixed(1)}°` : "—"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>Use Instrument view to see the 3D model.</div>
        </div>
      );
    }

    return (
      <div style={{ height: "calc(100% - 4px)", display: "grid", gridTemplateRows: "auto 1fr", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontWeight: 900 }}>3D Rocket</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{q ? "LIVE orientation" : "Waiting for q_w/x/y/z"}</div>
        </div>
        <Suspense fallback={<div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--vx-fg-dim)", fontSize: 12, letterSpacing: "0.14em" }}>LOADING 3D…</div>}>
          <RocketViewer q={q} frames={frames} tMs={latest?.t_ms ?? 0} />
        </Suspense>
      </div>
    );
  }

  if (widgetId === "flight.summary") {
    return <FlightSummaryWidget frames={frames} unitSystem={unitSystem} />;
  }

  if (widgetId === "pyro.panel") {
    return <PyroPanelWidget frames={frames} latest={latest} />;
  }

  // GPS: offline range map + recovery bearing/distance (with a fix header)
  if (widgetId === "gps.map") {
    const fix = latest?.gps_fix;
    const sats = latest?.gps_sats;
    const fixState = typeof fix === "number" ? (fix >= 3 ? "var(--vx-go)" : fix >= 1 ? "var(--vx-caution)" : "var(--vx-crit)") : "var(--vx-fg-faint)";

    if (view === "card") {
      return (
        <div style={{ display: "grid", gap: 12, height: "100%", alignContent: "start" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <StatTile label="LATITUDE" value={fmt(latest?.lat, 6)} unit="°" />
            <StatTile label="LONGITUDE" value={fmt(latest?.lon, 6)} unit="°" />
            <StatTile label="FIX" value={fix !== undefined ? String(fix) : "—"} accent={fixState} />
            <StatTile label="SATS" value={sats !== undefined ? String(sats) : "—"} />
          </div>
          <div className="vx-label">Switch to Instrument/Plot view for the range map</div>
        </div>
      );
    }

    return <RangeMapWidget frames={frames} latest={latest} unitSystem={unitSystem} />;
  }

  if (widgetId === "imu.card") {
    const accMag =
      typeof latest?.ax === "number" && typeof latest?.ay === "number" && typeof latest?.az === "number"
        ? Math.sqrt(latest.ax ** 2 + latest.ay ** 2 + latest.az ** 2) / 9.80665
        : undefined;
    return (
      <div style={{ display: "grid", gap: 12, height: "100%", alignContent: "start" }}>
        <BigReadout value={accMag !== undefined ? accMag.toFixed(2) : "—"} unit="g total" accent="var(--vx-blue-bright)" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          <StatTile label="AX" value={fmt(latest?.ax, 2)} />
          <StatTile label="AY" value={fmt(latest?.ay, 2)} />
          <StatTile label="AZ" value={fmt(latest?.az, 2)} />
          <StatTile label="GX" value={fmt(latest?.gx, 2)} />
          <StatTile label="GY" value={fmt(latest?.gy, 2)} />
          <StatTile label="GZ" value={fmt(latest?.gz, 2)} />
        </div>
      </div>
    );
  }

  if (widgetId === "env.card") {
    const tc = latest?.temp_c;
    const pa = latest?.pressure_pa;
    const rh = latest?.humidity_pct;

    const tVal = typeof tc === "number" ? (unitSystem === "imperial" ? (tc * 9) / 5 + 32 : tc) : undefined;
    const tUnit = unitSystem === "imperial" ? "°F" : "°C";
    const hpa = typeof pa === "number" ? pa / 100 : undefined;
    const psi = typeof pa === "number" ? pa * 0.00014503773773 : undefined;

    if (view === "plot") {
      return (
        <div style={{ display: "grid", gap: 10 }}>
          <PlotLine frames={frames} yKey="temp_c" yLabel={`Temperature (${tUnit})`} transformY={(c) => (unitSystem === "imperial" ? (c * 9) / 5 + 32 : c)} />
          <PlotLine frames={frames} yKey="pressure_pa" yLabel="Pressure (hPa)" transformY={(p) => p / 100} color="var(--vx-go)" />
        </div>
      );
    }

    return (
      <div style={{ display: "grid", gap: 12, height: "100%", alignContent: "start" }}>
        <BigReadout value={tVal !== undefined ? tVal.toFixed(1) : "—"} unit={tUnit} accent="var(--vx-blue-bright)" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          <StatTile label="PRESS hPa" value={hpa !== undefined ? hpa.toFixed(1) : "—"} />
          <StatTile label="PRESS psi" value={psi !== undefined ? psi.toFixed(2) : "—"} />
          <StatTile label="HUMIDITY" value={typeof rh === "number" ? `${rh.toFixed(0)}%` : "—"} />
        </div>
      </div>
    );
  }

  if (widgetId === "checklist.panel") {
    return <ChecklistPanel />;
  }

  return (
    <div style={{ fontSize: 12, opacity: 0.75 }}>
      No renderer for <code>{widgetId}</code>
    </div>
  );
}

function StatTile(props: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div style={{ border: "1px solid var(--vx-line)", borderRadius: 3, background: "rgba(10,16,30,0.5)", padding: "8px 10px", display: "grid", gap: 4 }}>
      <span className="vx-label" style={{ fontSize: 9 }}>{props.label}</span>
      <span style={{ fontFamily: "var(--vx-font-mono)", fontVariantNumeric: "tabular-nums", fontWeight: 700, fontSize: 18, color: props.accent ?? "var(--vx-fg)" }}>
        {props.value}
        {props.unit ? <span style={{ fontSize: 11, color: "var(--vx-fg-dim)", marginLeft: 2 }}>{props.unit}</span> : null}
      </span>
    </div>
  );
}