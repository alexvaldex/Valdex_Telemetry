import { describe, it, expect, beforeAll } from "vitest";
import { analyzeLine, exampleFrameLine } from "../telemetry/analyzeLine";
import { appendChecksum, crc16ccitt } from "../telemetry/crc";

// getFieldMap tolerates a missing localStorage, but stub it so the field-map
// path is exercised deterministically (empty map).
beforeAll(() => {
  if (typeof (globalThis as any).localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }
});

describe("analyzeLine", () => {
  it("accepts a valid v1 NDJSON frame", () => {
    const a = analyzeLine('{"v":1,"t_ms":1000,"alt_m":120.5,"vel_mps":60,"batt_v":7.8}', false);
    expect(a.format).toBe("json");
    expect(a.valid).toBe(true);
    expect(a.wouldIngest).toBe(true);
    expect(a.trustedV1).toBe(true);
    expect(a.fields.alt_m).toBe(120.5);
    expect(a.unknownKeys).toEqual([]);
    expect(a.crc).toBe("none");
  });

  it("verifies a good CRC suffix and rejects a bad one", () => {
    const good = appendChecksum('{"v":1,"t_ms":10,"alt_m":5}');
    const okA = analyzeLine(good, false);
    expect(okA.crc).toBe("ok");
    expect(okA.wouldIngest).toBe(true);

    const badA = analyzeLine('{"v":1,"t_ms":10,"alt_m":5}*FFFF', false);
    expect(badA.crc).toBe("bad");
    expect(badA.droppedByCrc).toBe(true);
    expect(badA.wouldIngest).toBe(false);
  });

  it("maps aliases on a non-v1 frame (altitude_ft -> alt_m, rssi -> rssi_dbm)", () => {
    const a = analyzeLine('{"t_ms":500,"altitude_ft":1000,"rssi":-80}', false);
    expect(a.trustedV1).toBe(false);
    expect(a.recognized).toContain("altitude_ft");
    expect(a.recognized).toContain("rssi");
    expect(a.unknownKeys).toEqual([]);
    // 1000 ft -> ~304.8 m
    expect(a.frame?.alt_m).toBeCloseTo(304.8, 1);
    expect(a.frame?.rssi_dbm).toBe(-80);
    expect(a.wouldIngest).toBe(true);
  });

  it("flags unrecognized keys", () => {
    const a = analyzeLine('{"t_ms":1,"alt_m":10,"wingflap_deg":7,"mystery":3}', false);
    expect(a.unknownKeys).toContain("wingflap_deg");
    expect(a.unknownKeys).toContain("mystery");
    expect(a.recognized).toContain("alt_m");
  });

  it("blanks physically implausible values via field bounds", () => {
    const a = analyzeLine('{"v":1,"t_ms":1,"alt_m":1e30,"vel_mps":50}', false);
    const dropped = a.droppedByBounds.find((d) => d.key === "alt_m");
    expect(dropped).toBeTruthy();
    expect(dropped?.reason).toBe("out-of-range");
    expect(a.fields.alt_m).toBeUndefined();
    // vel_mps is in range and survives
    expect(a.fields.vel_mps).toBe(50);
  });

  it("parses key=value framing", () => {
    const a = analyzeLine("t_ms=200 alt_m=33 vel_mps=12", false);
    expect(a.format).toBe("keyval");
    expect(a.frame?.alt_m).toBe(33);
    expect(a.wouldIngest).toBe(true);
  });

  it("reports an empty line", () => {
    const a = analyzeLine("   ", false);
    expect(a.empty).toBe(true);
    expect(a.wouldIngest).toBe(false);
  });

  it("fails a non-v1 frame with no t_ms when arrival stamping is off", () => {
    const a = analyzeLine('{"alt_m":10}', false);
    expect(a.frame).toBeNull();
    expect(a.wouldIngest).toBe(false);
    expect(a.notes.join(" ")).toMatch(/t_ms/);
  });

  it("stamps arrival time for a t_ms-less frame when enabled", () => {
    const a = analyzeLine('{"alt_m":10}', true);
    expect(a.frame).not.toBeNull();
    expect(typeof a.frame?.t_ms).toBe("number");
    expect(a.valid).toBe(true);
  });

  it("round-trips the built-in example (plain and with CRC)", () => {
    expect(analyzeLine(exampleFrameLine(false), false).wouldIngest).toBe(true);
    const withCrc = analyzeLine(exampleFrameLine(true), false);
    expect(withCrc.crc).toBe("ok");
    expect(withCrc.wouldIngest).toBe(true);
  });

  it("treats a non-telemetry string as unparseable", () => {
    const a = analyzeLine("hello world this is not telemetry", false);
    expect(a.frame).toBeNull();
    expect(a.wouldIngest).toBe(false);
  });
});

describe("firmware CRC contract (app agrees with the reference emitters)", () => {
  it("matches the CCITT-FALSE conformance value", () => {
    // The C (vx_frame_arduino.ino) and Python (vx_frame.py) emitters both hit
    // this same value, so all three agree byte for byte.
    expect(crc16ccitt("123456789")).toBe(0x29b1);
  });

  it("accepts the exact checksummed line the reference firmware emits", () => {
    // hardware/firmware/vx_frame.py prints this for {v:1,t_ms:123,alt_m:5}.
    const a = analyzeLine('{"v":1,"t_ms":123,"alt_m":5}*14E7', false);
    expect(a.crc).toBe("ok");
    expect(a.wouldIngest).toBe(true);
    expect(a.frame?.alt_m).toBe(5);
  });
});
