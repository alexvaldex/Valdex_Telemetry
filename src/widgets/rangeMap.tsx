import React, { useMemo } from "react";
import type { TelemetryFrameV1 } from "../telemetry/types";
import type { UnitSystem } from "../units";
import { getPadOrigin } from "../telemetry/padOrigin";

const M_PER_DEG_LAT = 111_320;
const M_TO_FT = 3.280839895;

type Pt = { e: number; n: number }; // meters east/north of pad

type Track = {
  label: string;
  color: string;
  pts: Pt[];
  last: Pt;
  lastLat: number;
  lastLon: number;
  distM: number;
  bearing: number;
};

const TRACK_COLORS = ["var(--vx-blue-bright)", "var(--vx-caution)", "var(--vx-go)", "#c792ea"];

/**
 * Offline "range map": projects GPS tracks into local meters around the pad
 * and draws them as SVG. No map tiles required — usable on a launch range with
 * no internet. Draws one colored track per vehicle stream (sustainer + booster
 * trackers land in different places), with the bearing + distance a recovery
 * crew needs for each.
 */
export function RangeMapWidget(props: { frames: TelemetryFrameV1[]; latest?: TelemetryFrameV1; unitSystem: UnitSystem }) {
  const imperial = props.unitSystem === "imperial";

  const model = useMemo(() => {
    const fixes = props.frames.filter((f) => typeof f.lat === "number" && typeof f.lon === "number");
    if (!fixes.length) return null;

    // Pad origin: prefer the session latch — "first fix in the buffer" drifts
    // once the ring buffer wraps on a long pad wait, corrupting recovery
    // bearing/distance. Only trust the latch if it's plausibly this flight's
    // site (within ~10 km of the buffered track, so replayed logs from other
    // ranges aren't skewed by the live session's latch).
    const firstFix = fixes[0];
    const latch = getPadOrigin();
    const nearLatch =
      latch &&
      Math.abs((firstFix.lat as number) - latch.lat) * M_PER_DEG_LAT < 10_000 &&
      Math.abs((firstFix.lon as number) - latch.lon) * M_PER_DEG_LAT < 10_000;
    const lat0 = nearLatch ? latch.lat : (firstFix.lat as number);
    const lon0 = nearLatch ? latch.lon : (firstFix.lon as number);
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    const toPt = (f: TelemetryFrameV1): Pt => ({
      e: ((f.lon as number) - lon0) * mPerDegLon,
      n: ((f.lat as number) - lat0) * M_PER_DEG_LAT,
    });

    // One track per vehicle stream (frames without vid form their own track).
    const byVid = new Map<string, TelemetryFrameV1[]>();
    for (const f of fixes) {
      const key = f.vid !== undefined ? String(f.vid) : "TRACK";
      const arr = byVid.get(key);
      if (arr) arr.push(f);
      else byVid.set(key, [f]);
    }

    let maxR = 10;
    const tracks: Track[] = Array.from(byVid.entries()).map(([label, fs], i) => {
      const pts = fs.map(toPt);
      const last = pts[pts.length - 1];
      const lastF = fs[fs.length - 1];
      const distM = Math.sqrt(last.e * last.e + last.n * last.n);
      let bearing = (Math.atan2(last.e, last.n) * 180) / Math.PI;
      if (bearing < 0) bearing += 360;
      for (const p of pts) maxR = Math.max(maxR, Math.abs(p.e), Math.abs(p.n));
      return {
        label,
        color: TRACK_COLORS[i % TRACK_COLORS.length],
        pts,
        last,
        lastLat: lastF.lat as number,
        lastLon: lastF.lon as number,
        distM,
        bearing,
      };
    });
    maxR *= 1.15;

    return { tracks, maxR };
  }, [props.frames]);

  const size = 260;
  const c = size / 2;

  if (!model) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--vx-fg-faint)" }}>
        <div className="vx-label">Awaiting GPS fix…</div>
      </div>
    );
  }

  const scale = (c - 18) / model.maxR;
  const px = (p: Pt) => ({ x: c + p.e * scale, y: c - p.n * scale });
  const pathFor = (pts: Pt[]) =>
    pts.map((p, i) => { const q = px(p); return `${i === 0 ? "M" : "L"} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`; }).join(" ");

  const fmtDist = (m: number) => (imperial ? `${(m * M_TO_FT).toFixed(0)} ft` : `${m.toFixed(0)} m`);
  const compassOf = (b: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8];

  // range rings at nice intervals
  const ringM = niceRing(model.maxR);
  const rings: number[] = [];
  for (let r = ringM; r <= model.maxR; r += ringM) rings.push(r);

  const multi = model.tracks.length > 1;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 14, height: "100%", alignItems: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ background: "rgba(4,7,14,0.6)", border: "1px solid var(--vx-line)", borderRadius: 3 }}>
        {/* range rings */}
        {rings.map((r, i) => (
          <circle key={i} cx={c} cy={c} r={r * scale} fill="none" stroke="var(--vx-line)" strokeWidth={1} />
        ))}
        {/* crosshair */}
        <line x1={c} y1={8} x2={c} y2={size - 8} stroke="var(--vx-line)" strokeWidth={1} />
        <line x1={8} y1={c} x2={size - 8} y2={c} stroke="var(--vx-line)" strokeWidth={1} />
        <text x={c + 4} y={16} fontSize={11} fill="var(--vx-fg-dim)" fontFamily="var(--vx-font-mono)">N</text>

        {/* tracks */}
        {model.tracks.map((t) => {
          const cur = px(t.last);
          return (
            <g key={t.label}>
              <path d={pathFor(t.pts)} fill="none" stroke={t.color} strokeWidth={2} strokeLinejoin="round" opacity={0.9} />
              <circle cx={cur.x} cy={cur.y} r={5} fill={t.color} stroke="#000" strokeWidth={0.5} />
              <circle cx={cur.x} cy={cur.y} r={9} fill="none" stroke={t.color} strokeWidth={1} opacity={0.5} />
              {multi && (
                <text x={cur.x + 10} y={cur.y + 3} fontSize={9} fill={t.color} fontFamily="var(--vx-font-mono)">{t.label}</text>
              )}
            </g>
          );
        })}

        {/* pad marker */}
        <g>
          <circle cx={c} cy={c} r={4} fill="var(--vx-go)" />
          <text x={c + 7} y={c + 4} fontSize={10} fill="var(--vx-go)" fontFamily="var(--vx-font-mono)">PAD</text>
        </g>
      </svg>

      {multi ? (
        <div style={{ display: "grid", gap: 10, alignContent: "center" }}>
          {model.tracks.map((t) => (
            <div key={t.label} style={{ border: "1px solid var(--vx-line)", borderRadius: 3, padding: "8px 10px", background: "rgba(10,16,30,0.5)" }}>
              <div className="vx-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, display: "inline-block" }} />
                {t.label}
              </div>
              <div style={{ fontFamily: "var(--vx-font-mono)", fontWeight: 800, fontSize: 20, color: t.color }}>
                {t.bearing.toFixed(0)}° {compassOf(t.bearing)} · {fmtDist(t.distM)}
              </div>
              <div style={{ fontFamily: "var(--vx-font-mono)", fontSize: 10, color: "var(--vx-fg-dim)" }}>
                {t.lastLat.toFixed(5)}, {t.lastLon.toFixed(5)}
              </div>
            </div>
          ))}
          <div className="vx-label" style={{ fontSize: 9 }}>Ring = {ringM >= 1000 ? `${(ringM / 1000).toFixed(1)} km` : `${ringM} m`}</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, alignContent: "center" }}>
          <div>
            <div className="vx-label">Recovery Bearing</div>
            <div style={{ fontFamily: "var(--vx-font-mono)", fontWeight: 800, fontSize: 30, color: "var(--vx-caution)" }}>
              {model.tracks[0].bearing.toFixed(0)}° <span style={{ fontSize: 16, color: "var(--vx-fg-dim)" }}>{compassOf(model.tracks[0].bearing)}</span>
            </div>
          </div>
          <div>
            <div className="vx-label">Distance from Pad</div>
            <div style={{ fontFamily: "var(--vx-font-mono)", fontWeight: 800, fontSize: 30, color: "var(--vx-fg)" }}>{fmtDist(model.tracks[0].distM)}</div>
          </div>
          <div style={{ fontFamily: "var(--vx-font-mono)", fontSize: 11, color: "var(--vx-fg-dim)" }}>
            {model.tracks[0].lastLat.toFixed(5)}, {model.tracks[0].lastLon.toFixed(5)}
          </div>
          <div className="vx-label" style={{ fontSize: 9 }}>Ring = {ringM >= 1000 ? `${(ringM / 1000).toFixed(1)} km` : `${ringM} m`}</div>
        </div>
      )}
    </div>
  );
}

function niceRing(maxR: number): number {
  const target = maxR / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow);
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1];
}
