# VX Telemetry - reference frame emitter (CircuitPython / MicroPython)
#
# Prints valid VX NDJSON telemetry to the USB serial console that the VX
# Telemetry app ingests with no app-side changes. Replace read_sensors() with
# your real reads, keeping the V1 key names and units from README.md.

import time

try:
    import ujson as json
except ImportError:
    import json

APPEND_CRC = True
RATE_HZ = 20


def crc16_ccitt_false(data):
    """CRC-16/CCITT-FALSE over bytes. Matches src/telemetry/crc.ts.
    poly 0x1021, init 0xFFFF, no reflection, no final xor. crc(b'123456789') == 0x29B1."""
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


def _dumps(obj):
    # Compact separators keep the line short; fall back if a port lacks the kwarg.
    try:
        return json.dumps(obj, separators=(",", ":"))
    except TypeError:
        return json.dumps(obj)


def frame_line(obj):
    s = _dumps(obj)
    if APPEND_CRC:
        s = "%s*%04X" % (s, crc16_ccitt_false(s.encode("utf-8")))
    return s


def read_sensors(t_ms, seq):
    # Replace with real sensor reads. Only t_ms is required; add fields freely.
    # Keep "v":1 only if every key is an exact V1 name (aliases are skipped for
    # trusted v:1 frames). Send t_ms from your own millisecond clock.
    return {
        "v": 1,
        "t_ms": t_ms,
        "seq": seq,
        "alt_m": 0.0,
        "vel_mps": 0.0,
        "az": 9.81,
        "batt_v": 7.9,
    }


def now_ms():
    # CircuitPython and most MicroPython ports have monotonic_ns; on a port that
    # does not, swap this for time.ticks_ms().
    return time.monotonic_ns() // 1_000_000


def main():
    seq = 0
    t0 = now_ms()
    while True:
        print(frame_line(read_sensors(now_ms() - t0, seq)))
        seq += 1
        time.sleep(1.0 / RATE_HZ)


if __name__ == "__main__":
    main()
