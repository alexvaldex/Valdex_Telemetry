import { beforeAll, describe, expect, it } from "vitest";

// The telemetry modules cache user prefs in localStorage; give Node a stub.
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

import { normalizeTelemetryFrame } from "../telemetry/schema";
import { isTelemetryFrameV1 } from "../telemetry/validate";
import { deriveCapabilities } from "../telemetry/capabilities";
import { applyFieldMap, saveFieldMap } from "../telemetry/fieldMap";
import { ruleFires, type AlertRule } from "../telemetry/alertRules";
import { derivePhase, phaseIndex } from "../telemetry/vehicleStore";
import { ingestLine, ingestLineInPlace } from "../telemetry/ingest";
import { initialTelemetryState } from "../telemetry/store";
import { computeFlightSummary } from "../widgets/flightSummary";
import { crc16ccitt, appendChecksum, verifyAndStrip } from "../telemetry/crc";
import { MAX_FRAMES, MAX_EVENTS } from "../telemetry/store";
import { getPadOrigin, resetPadOrigin } from "../telemetry/padOrigin";
import { summarizeRawLines } from "../telemetry/flightLog";
import { tiltDegFromQuat } from "../widgets/renderers";
import type { TelemetryFrameV1 } from "../telemetry/types";

describe("schema normalization", () => {
  it("trusts v1 frames as-is", () => {
    const f = normalizeTelemetryFrame({ v: 1, t_ms: 5, alt_m: 10, custom: 1 });
    expect(f?.alt_m).toBe(10);
    expect((f as any).custom).toBe(1);
  });

  it("maps imperial + unit aliases", () => {
    const f = normalizeTelemetryFrame({ t_ms: 5, alt_ft: 328.084, vz_fps: 32.8084, temp_f: 59, pressure_hpa: 1013.25, current_ma: 850, gps_alt_ft: 3280.84 })!;
    expect(f.alt_m).toBeCloseTo(100, 3);
    expect(f.vel_mps).toBeCloseTo(10, 3);
    expect(f.temp_c).toBeCloseTo(15, 6);
    expect(f.pressure_pa).toBeCloseTo(101325, 3);
    expect(f.current_a).toBeCloseTo(0.85, 6);
    expect(f.gps_alt_m).toBeCloseTo(1000, 2);
  });

  it("maps id/link aliases", () => {
    const f = normalizeTelemetryFrame({ t_ms: 5, node: "SUST", seq_no: 42, snr: 11.5 })!;
    expect(f.vid).toBe("SUST");
    expect(f.seq).toBe(42);
    expect(f.snr_db).toBe(11.5);
  });

  it("falls back to wallclock t_ms and rejects when absent", () => {
    expect(normalizeTelemetryFrame({ alt: 5 }, 1234)?.t_ms).toBe(1234);
    expect(normalizeTelemetryFrame({ alt: 5 })).toBeNull();
  });
});

describe("validation", () => {
  it("accepts a minimal frame", () => {
    expect(isTelemetryFrameV1({ v: 1, t_ms: 1 })).toBe(true);
  });
  it("rejects wrong types", () => {
    expect(isTelemetryFrameV1({ v: 1, t_ms: "x" })).toBe(false);
    expect(isTelemetryFrameV1({ v: 1, t_ms: 1, alt_m: "high" })).toBe(false);
    expect(isTelemetryFrameV1({ v: 1, t_ms: 1, vid: {} })).toBe(false);
  });
});

describe("capabilities", () => {
  it("includes raw frame keys (registry `requires` contract) and semantic caps", () => {
    const caps = deriveCapabilities({ v: 1, t_ms: 1, alt_m: 5, temp_c: 20, q_w: 1 } as TelemetryFrameV1);
    expect(caps.has("alt_m")).toBe(true);
    expect(caps.has("altitude")).toBe(true);
    expect(caps.has("environment")).toBe(true);
    expect(caps.has("orientation")).toBe(true);
    expect(caps.has("vel_mps")).toBe(false);
  });
});

describe("field map", () => {
  it("copies mapped fields without overwriting existing targets", () => {
    saveFieldMap([
      { source: "altitude_agl", target: "alt_m" },
      { source: "spin", target: "gy" },
    ]);
    const out = applyFieldMap({ altitude_agl: 512.5, spin: 90, gy: 1 });
    expect(out.alt_m).toBe(512.5);
    expect(out.gy).toBe(1); // existing target wins
    saveFieldMap([]);
  });
});

describe("alert rules", () => {
  const rule = (op: ">" | "<", value: number): AlertRule => ({ id: "r", field: "batt_v", op, value, level: "warn", title: "" });
  it("evaluates thresholds", () => {
    expect(ruleFires(rule("<", 7), { batt_v: 6.9 })).toBe(true);
    expect(ruleFires(rule("<", 7), { batt_v: 8.4 })).toBe(false);
    expect(ruleFires(rule(">", 3000), { batt_v: 3200 })).toBe(true);
  });
  it("ignores missing/non-numeric fields", () => {
    expect(ruleFires(rule("<", 7), {})).toBe(false);
    expect(ruleFires(rule("<", 7), { batt_v: "low" as unknown as number })).toBe(false);
    expect(ruleFires(rule("<", 7), undefined)).toBe(false);
  });
});

describe("flight phase derivation", () => {
  const frames = [
    { t_ms: 1000, event: "ARMED" },
    { t_ms: 3000, event: "LIFTOFF" },
    { t_ms: 5500, event: "BURNOUT" },
    { t_ms: 15000, event: "APOGEE" },
    { t_ms: 16000, event: "DROGUE" },
    { t_ms: 70000, event: "MAIN" },
    { t_ms: 130000, event: "LANDING" },
  ];
  it("tracks the phase begun by the latest event at/before t", () => {
    expect(derivePhase(frames, 0)).toBe("PAD");
    expect(derivePhase(frames, 4000)).toBe("BOOST");
    expect(derivePhase(frames, 6000)).toBe("COAST");
    expect(derivePhase(frames, 15500)).toBe("APOGEE");
    expect(derivePhase(frames, 20000)).toBe("DROGUE");
    expect(derivePhase(frames, 200000)).toBe("LANDED");
  });
  it("orders phases canonically", () => {
    expect(phaseIndex("COAST")).toBeLessThan(phaseIndex("APOGEE"));
    expect(phaseIndex("APOGEE")).toBeLessThan(phaseIndex("MAIN"));
  });
});

describe("ingest pipeline", () => {
  it("parses, normalizes, and buffers valid lines; drops garbage quietly", () => {
    let st = initialTelemetryState();
    st = ingestLine(st, JSON.stringify({ v: 1, t_ms: 1, alt_m: 10 }));
    st = ingestLine(st, "not json at all");
    st = ingestLine(st, JSON.stringify({ t_ms: 2, altitude_ft: 328.084 }));
    expect(st.frames.length).toBe(2);
    expect(st.rawLines.length).toBe(3);
    expect(st.latest?.alt_m).toBeCloseTo(100, 2);
  });

  it("in-place variant matches pure variant results", () => {
    const a = initialTelemetryState();
    ingestLineInPlace(a, JSON.stringify({ v: 1, t_ms: 1, alt_m: 5 }));
    const b = ingestLine(initialTelemetryState(), JSON.stringify({ v: 1, t_ms: 1, alt_m: 5 }));
    expect(a.frames).toEqual(b.frames);
    expect(a.latest).toEqual(b.latest);
  });
});

describe("tilt from quaternion", () => {
  it("is 0° upright, 90° on its side, null when attitude missing", () => {
    expect(tiltDegFromQuat(1, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(tiltDegFromQuat(Math.SQRT1_2, Math.SQRT1_2, 0, 0)).toBeCloseTo(90, 6);
    expect(tiltDegFromQuat(undefined, 0, 0, 0)).toBeNull();
  });
  it("is spin-invariant (roll about the long axis is not tilt)", () => {
    // 90° rotation about Y (the long axis) leaves the nose pointing up.
    expect(tiltDegFromQuat(Math.SQRT1_2, 0, Math.SQRT1_2, 0)).toBeCloseTo(0, 6);
  });
});

describe("wire checksum (CRC-16/CCITT-FALSE)", () => {
  it("matches the standard check vector", () => {
    expect(crc16ccitt("123456789")).toBe(0x29b1);
  });
  it("round-trips append/verify and detects tampering", () => {
    const line = '{"v":1,"t_ms":123,"alt_m":100.5}';
    const summed = appendChecksum(line);
    expect(verifyAndStrip(summed)).toEqual({ payload: line, crc: "ok" });
    const tampered = summed.replace('"alt_m":100.5', '"alt_m":900.5');
    expect(verifyAndStrip(tampered).crc).toBe("bad");
    expect(verifyAndStrip(line)).toEqual({ payload: line, crc: "none" });
  });
  it("drops corrupt lines in ingest but accepts unsummed + valid-summed", () => {
    let st = initialTelemetryState();
    const good = appendChecksum(JSON.stringify({ v: 1, t_ms: 1, alt_m: 10 }));
    st = ingestLine(st, good);
    st = ingestLine(st, good.replace('"alt_m":10', '"alt_m":99')); // corrupt vs CRC
    st = ingestLine(st, JSON.stringify({ v: 1, t_ms: 2, alt_m: 20 })); // no CRC — fine
    expect(st.frames.map((f) => f.alt_m)).toEqual([10, 20]);
  });
});

describe("ring-buffer survival (long pad wait)", () => {
  it("latches events so LIFTOFF survives frame-buffer wrap", () => {
    const st = initialTelemetryState();
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 1, event: "LIFTOFF", alt_m: 0 }));
    // Flood the buffer well past capacity — the LIFTOFF frame scrolls out…
    for (let i = 0; i < MAX_FRAMES + 50; i++) {
      ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 10 + i, alt_m: i }));
    }
    expect(st.frames.length).toBe(MAX_FRAMES);
    expect(st.frames.some((f) => f.event === "LIFTOFF")).toBe(false); // gone from the buffer
    expect(st.events.some((e) => e.event === "LIFTOFF" && e.t_ms === 1)).toBe(true); // …but latched
  });

  it("caps the event latch", () => {
    const st = initialTelemetryState();
    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: i, event: `E${i}` }));
    }
    expect(st.events.length).toBe(MAX_EVENTS);
  });

  it("latches the pad origin from the session's first GPS fix", () => {
    resetPadOrigin();
    const st = initialTelemetryState();
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 1, lat: 32.99, lon: -106.97 }));
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 2, lat: 33.05, lon: -106.9 })); // drifted later fix
    expect(getPadOrigin()).toEqual({ lat: 32.99, lon: -106.97 });
    resetPadOrigin();
    expect(getPadOrigin()).toBeNull();
  });
});

describe("flight log metadata with CRC-summed lines", () => {
  it("summarizes checksummed recordings and skips corrupt lines", () => {
    const mk = (t: number, alt: number) => appendChecksum(JSON.stringify({ v: 1, t_ms: t, alt_m: alt }));
    const lines = [mk(0, 0), mk(1000, 50), mk(2000, 120), mk(3000, 80)];
    lines.push(mk(4000, 999).replace('"alt_m":999', '"alt_m":111')); // corrupt vs its CRC
    const s = summarizeRawLines(lines);
    expect(s.frameCount).toBe(4);
    expect(s.apogeeM).toBe(120);
    expect(s.durationMs).toBe(3000);
  });
});

describe("flight summary", () => {
  it("computes apogee and total time from a triangular profile", () => {
    const frames: TelemetryFrameV1[] = [];
    for (let t = 0; t <= 20000; t += 100) {
      const alt = t <= 5000 ? (t / 5000) * 100 : Math.max(0, 100 * (1 - (t - 5000) / 15000));
      const f: TelemetryFrameV1 = { v: 1, t_ms: t, alt_m: alt };
      if (t === 1000) f.event = "LIFTOFF";
      if (t === 5000) f.event = "APOGEE";
      if (t === 20000) f.event = "LANDING";
      frames.push(f);
    }
    const s = computeFlightSummary(frames);
    expect(s.apogeeM).toBeCloseTo(100, 1);
    expect(s.totalS).toBeGreaterThan(15);
  });
});
