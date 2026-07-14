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
import { DEFAULT_SIM_PROFILE, simulatePreflight, windEN, airDensity, type SimProfile } from "../telemetry/flightSim";
import { tiltDegFromQuat } from "../widgets/renderers";
import { detectFlightEvents, fuseAltVel, accelUnitDivisor } from "../telemetry/fusion";
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

describe("flight simulation physics", () => {
  const base = (): SimProfile => structuredClone(DEFAULT_SIM_PROFILE);

  it("predicts a plausible flight for the default J-motor rocket", () => {
    const pred = simulatePreflight(base());
    expect(pred.failsToLift).toBe(false);
    expect(pred.apogeeM).toBeGreaterThan(200);
    expect(pred.apogeeM).toBeLessThan(2000);
    expect(pred.maxVelMps).toBeGreaterThan(50);
    expect(pred.thrustToWeight).toBeGreaterThan(1);
    expect(pred.flightS).toBeGreaterThan(pred.apogeeS);
  });

  it("flies higher on a hot day (density altitude)", () => {
    const cold = base(); cold.env.tempC = 0;
    const hot = base(); hot.env.tempC = 38;
    expect(simulatePreflight(hot).apogeeM).toBeGreaterThan(simulatePreflight(cold).apogeeM);
  });

  it("flies lower when heavier", () => {
    const light = base();
    const heavy = base(); heavy.rocket.dryKg += 2;
    expect(simulatePreflight(heavy).apogeeM).toBeLessThan(simulatePreflight(light).apogeeM);
  });

  it("drifts further in stronger wind, downwind of the pad", () => {
    const calm = base(); calm.env.windMps = 2;
    const windy = base(); windy.env.windMps = 10; windy.env.windDirDeg = 270; // from the west
    const pc = simulatePreflight(calm);
    const pw = simulatePreflight(windy);
    expect(pw.driftM).toBeGreaterThan(pc.driftM);
    // wind FROM 270° blows the rocket east → landing bearing ≈ 90°
    expect(Math.abs(pw.driftBearingDeg - 90)).toBeLessThan(20);
    expect(pw.landLon).toBeGreaterThan(windy.env.padLon);
  });

  it("flags a rocket the motor cannot lift", () => {
    const brick = base(); brick.rocket.dryKg = 500;
    expect(simulatePreflight(brick).failsToLift).toBe(true);
  });

  it("air density falls with altitude and heat", () => {
    expect(airDensity(3000, 1400, 20)).toBeLessThan(airDensity(1400, 1400, 20));
    expect(airDensity(1400, 1400, 40)).toBeLessThan(airDensity(1400, 1400, 0));
  });

  it("wind vector points downwind", () => {
    const p = base(); p.env.windMps = 5; p.env.windDirDeg = 270;
    const w = windEN(p);
    expect(w.e).toBeGreaterThan(4.9); // blowing toward the east
    expect(Math.abs(w.n)).toBeLessThan(0.1);
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

describe("sensor fusion + event gating", () => {
  // Build a synthetic flight: 2 s pad, boost to apogee, ballistic-ish descent.
  function synthFlight(opts: { padBaroNoise?: number; spike?: boolean } = {}): TelemetryFrameV1[] {
    const frames: TelemetryFrameV1[] = [];
    const dt = 0.05; // 20 Hz
    const g = 9.80665;
    const padAlt = 1400;
    let t = 0;
    let alt = 0, vel = 0;
    // Pad: 2 s at rest, ~1g, optional baro noise.
    for (let i = 0; i < 40; i++) {
      const noise = opts.padBaroNoise ? (Math.sin(i) * opts.padBaroNoise) : 0;
      frames.push({ v: 1, t_ms: Math.round(t * 1000), alt_m: 0 + noise, ax: 0, ay: 0, az: g });
      t += dt;
    }
    // Boost 1.5 s at 6g total (≈ 5g net up).
    for (let i = 0; i < 30; i++) {
      const aUp = 5 * g;
      vel += aUp * dt; alt += vel * dt;
      frames.push({ v: 1, t_ms: Math.round(t * 1000), alt_m: alt, ax: 0, ay: 0, az: 6 * g });
      t += dt;
    }
    // Coast to apogee then fall — pure ballistic under gravity, ~1g? use ~0 (freefall).
    for (let i = 0; i < 400; i++) {
      vel += -g * dt; alt += vel * dt;
      if (alt < 0) { alt = 0; vel = 0; }
      let baro = alt;
      // Inject one spurious high baro spike well after apogee.
      if (opts.spike && i === 250) baro = alt + 5000;
      frames.push({ v: 1, t_ms: Math.round(t * 1000), alt_m: baro, ax: 0, ay: 0, az: 0.02 * g });
      t += dt;
      if (alt <= 0 && i > 50) break;
    }
    return frames;
  }

  it("detects accel units (m/s²) from pad rest", () => {
    const frames = synthFlight();
    expect(accelUnitDivisor(frames)).toBeCloseTo(9.80665, 1);
  });

  it("liftoff is accel-gated and ignores pad baro noise", () => {
    const frames = synthFlight({ padBaroNoise: 3 }); // ±3 m of pad baro jitter
    const fe = detectFlightEvents(frames);
    // Liftoff must land in the boost window (after the 40 pad samples), not on
    // a noisy pad sample.
    expect(fe.liftoffIdx).toBeGreaterThanOrEqual(40);
    expect(fe.liftoffIdx).toBeLessThan(72);
  });

  it("apogee is debounced and not fooled by a lone baro spike", () => {
    const clean = detectFlightEvents(synthFlight());
    const spiked = detectFlightEvents(synthFlight({ spike: true }));
    // The naive global-max would jump to the +5000 m spike sample; the fused
    // velocity zero-cross should put apogee near the real one in both cases.
    const tClean = synthFlight()[clean.apogeeIdx].t_ms;
    const tSpiked = synthFlight({ spike: true })[spiked.apogeeIdx].t_ms;
    expect(Math.abs(tSpiked - tClean)).toBeLessThan(1500); // within 1.5 s
  });

  it("fused velocity is positive during boost and negative after apogee", () => {
    const frames = synthFlight();
    const { velF } = fuseAltVel(frames);
    const fe = detectFlightEvents(frames);
    expect(velF[fe.liftoffIdx + 10]).toBeGreaterThan(0);
    expect(velF[fe.apogeeIdx + 20]).toBeLessThan(0);
  });

  it("averaged pad baseline is stable under noise", () => {
    const fe = detectFlightEvents(synthFlight({ padBaroNoise: 4 }));
    expect(Math.abs(fe.baselineAlt)).toBeLessThan(3); // near 0, not a single noisy sample
  });
});

describe("device profiles (multi-format ingest)", () => {
  it("auto-maps a CSV header and parses data rows", async () => {
    const { setDeviceProfile, parseLine } = await import("../telemetry/deviceProfiles");
    setDeviceProfile("csv");
    // Header row is learned, returns null (no frame).
    expect(parseLine("Time_ms,Altitude (ft),Vel_mps,Batt V,Lat,Lon")).toBeNull();
    const obj = parseLine("1500,328.084,42.5,7.9,28.6,-80.6")!;
    expect(obj).not.toBeNull();
    expect(obj.t_ms).toBe(1500);
    expect(obj.alt_ft).toBeCloseTo(328.084, 2); // "ft" header → alt_ft alias
    expect(obj.vel_mps).toBe(42.5);
    expect(obj.batt_v).toBe(7.9);
    expect(obj.lat).toBe(28.6);
    setDeviceProfile("vx");
  });

  it("CSV feeds the normal ingest → normalize pipeline (ft → m)", async () => {
    const { setDeviceProfile } = await import("../telemetry/deviceProfiles");
    setDeviceProfile("csv");
    let st = initialTelemetryState();
    ingestLineInPlace(st, "t_ms,alt_ft"); // header
    ingestLineInPlace(st, "500,328.084"); // 328.084 ft = 100 m
    expect(st.frames.length).toBe(1);
    expect(st.latest?.alt_m).toBeCloseTo(100, 2);
    setDeviceProfile("vx");
  });

  it("parses key=value lines", async () => {
    const { setDeviceProfile, parseLine } = await import("../telemetry/deviceProfiles");
    setDeviceProfile("keyval");
    const obj = parseLine("alt_m=123.4 vel_mps=56 batt_v=7.8")!;
    expect(obj.alt_m).toBe(123.4);
    expect(obj.vel_mps).toBe(56);
    setDeviceProfile("vx");
  });

  it("auto profile still parses NDJSON", async () => {
    const { setDeviceProfile, parseLine } = await import("../telemetry/deviceProfiles");
    setDeviceProfile("vx");
    const obj = parseLine('{"v":1,"t_ms":9,"alt_m":10}')!;
    expect(obj.alt_m).toBe(10);
  });
});

describe("shareable flight replay", () => {
  const frames: TelemetryFrameV1[] = [];
  for (let t = 0; t <= 4000; t += 100) {
    const alt = t <= 2000 ? (t / 2000) * 200 : Math.max(0, 200 * (1 - (t - 2000) / 2000));
    const f: TelemetryFrameV1 = { v: 1, t_ms: t, alt_m: alt, vel_mps: 10, lat: 28.6 + t * 1e-6, lon: -80.6 };
    if (t === 100) f.event = "LIFTOFF";
    if (t === 2000) f.event = "APOGEE";
    frames.push(f);
  }

  it("builds a self-contained HTML replay (no external resource refs)", async () => {
    const { toShareFlight, buildReplayHTML } = await import("../telemetry/shareFlight");
    const html = buildReplayHTML(toShareFlight("Test", frames));
    expect(html).toContain("<!doctype html>");
    // No external script/style/img src other than the footer GitHub link.
    const externals = html.match(/src=["']https?:\/\//g) || [];
    expect(externals.length).toBe(0);
  });

  it("link round-trips the flight through the hash", async () => {
    (globalThis as any).location = { origin: "https://vx.test", pathname: "/" };
    const { toShareFlight, encodeShareLink, decodeShareLink, shareFlightToLines } = await import("../telemetry/shareFlight");
    const sf = toShareFlight("RT", frames);
    const link = await encodeShareLink(sf);
    expect(link.url).toContain("#flight=");
    const decoded = await decodeShareLink("#flight=" + link.url.split("flight=")[1]);
    expect(decoded).not.toBeNull();
    expect(decoded!.pts.length).toBe(sf.pts.length);
    const lines = shareFlightToLines(decoded!);
    expect(JSON.parse(lines[0]).v).toBe(1);
    const apo = Math.max(...decoded!.pts.map((p) => p.alt ?? 0));
    expect(apo).toBeCloseTo(200, 0);
  });
});

describe("motor thrust-curve import", () => {
  const engJ350 = `; Cesaroni J350 test
J350 38 186 5-10-15 0.192 0.360 Cesaroni
0.02 420
0.1 500
0.5 380
1.0 360
1.9 340
2.0 0
`;
  it("parses a RASP .eng into a curve + derived impulse/avg", async () => {
    const { parseEng } = await import("../telemetry/motorFile");
    const m = parseEng(engJ350);
    expect(m.name).toContain("J350");
    expect(m.propKg).toBeCloseTo(0.192, 3);
    expect(m.curve!.length).toBeGreaterThan(3);
    expect(m.burnS).toBeCloseTo(2.0, 2);
    // Impulse ≈ area under the curve → J class (640–1280 Ns).
    expect(m.impulseNs).toBeGreaterThan(640);
    expect(m.impulseNs).toBeLessThan(1280);
  });

  it("thrustAtTime interpolates and returns 0 after burnout", async () => {
    const { parseEng } = await import("../telemetry/motorFile");
    const { thrustAtTime, motorBurnTime } = await import("../telemetry/flightSim");
    const m = parseEng(engJ350);
    expect(thrustAtTime(m, 0.06)).toBeGreaterThan(420); // between 420 and 500
    expect(thrustAtTime(m, 0.06)).toBeLessThan(500);
    expect(thrustAtTime(m, 3)).toBe(0);
    expect(motorBurnTime(m)).toBeCloseTo(2.0, 2);
  });

  it("the real curve changes predicted apogee vs the boxcar average", async () => {
    const { parseEng } = await import("../telemetry/motorFile");
    const { simulatePreflight, DEFAULT_SIM_PROFILE } = await import("../telemetry/flightSim");
    const m = parseEng(engJ350);
    const withCurve = structuredClone(DEFAULT_SIM_PROFILE);
    withCurve.motor = m;
    const boxcar = structuredClone(DEFAULT_SIM_PROFILE);
    boxcar.motor = { ...m, curve: undefined }; // same impulse, flat thrust
    const a = simulatePreflight(withCurve).apogeeM;
    const b = simulatePreflight(boxcar).apogeeM;
    expect(a).toBeGreaterThan(50);
    expect(Math.abs(a - b)).toBeGreaterThan(0.5); // the shape actually matters
  });
});

describe("dashboard templates", () => {
  it("every template produces a valid, non-overlapping 12-col layout", async () => {
    const { TEMPLATES, templateLayout } = await import("../telemetry/templates");
    for (const t of TEMPLATES) {
      const { instances, layout } = templateLayout(t.widgets);
      expect(instances.length).toBe(t.widgets.length);
      expect(layout.length).toBe(t.widgets.length);
      // Unique keys, all within 12 columns.
      const keys = new Set(instances.map((i) => i.key));
      expect(keys.size).toBe(instances.length);
      for (const it of layout) {
        expect(it.x).toBeGreaterThanOrEqual(0);
        expect(it.x + it.w).toBeLessThanOrEqual(12);
        expect(it.h).toBeGreaterThan(0);
      }
      // No two items overlap (rectangle intersection test).
      for (let a = 0; a < layout.length; a++) {
        for (let b = a + 1; b < layout.length; b++) {
          const A = layout[a], B = layout[b];
          const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe("ingest hardening + peak latching", () => {
  it("latches peak alt/vel/accel that survive a ring-buffer wrap", () => {
    const st = initialTelemetryState();
    // Push the true apogee early, then flood the buffer so it scrolls out.
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 1000, alt_m: 3000, vel_mps: 250, ax: 0, ay: 0, az: 60 }));
    for (let i = 0; i < MAX_FRAMES + 50; i++) {
      ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 2000 + i, alt_m: 10, vel_mps: 2 }));
    }
    // The apogee frame is gone from the buffer…
    expect(st.frames.some((f) => f.alt_m === 3000)).toBe(false);
    // …but the latched peaks kept it.
    expect(st.peaks.maxAltM).toBe(3000);
    expect(st.peaks.maxVelMps).toBe(250);
    expect(st.peaks.maxAccelG).toBeCloseTo(60 / 9.80665, 2);
  });

  it("drops physically impossible values instead of storing them", () => {
    const st = initialTelemetryState();
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 1, alt_m: 1e30, lat: 999, batt_v: 7.9 }));
    expect(st.latest?.alt_m).toBeUndefined(); // 1e30 dropped
    expect(st.latest?.lat).toBeUndefined();   // out-of-range dropped
    expect(st.latest?.batt_v).toBe(7.9);      // valid kept
    expect(st.peaks.maxAltM).toBeUndefined(); // the garbage never poisoned peaks
  });

  it("rebases the clock on a firmware reboot so MET stays monotonic", () => {
    const st = initialTelemetryState();
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 60000, alt_m: 100 }));
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 60050, alt_m: 101 }));
    // Reboot: t_ms jumps back to ~0.
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 0, alt_m: 102 }));
    ingestLineInPlace(st, JSON.stringify({ v: 1, t_ms: 50, alt_m: 103 }));
    const ts = st.frames.map((f) => f.t_ms);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]); // strictly increasing
  });
});
