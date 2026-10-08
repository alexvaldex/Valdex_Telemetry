// VX Telemetry - reference frame emitter (Arduino / C++)
//
// Produces valid VX NDJSON telemetry over Serial that the VX Telemetry app
// ingests with no app-side changes. Written for 32-bit cores (RP2040, ESP32,
// Teensy, SAMD, STM32) where snprintf supports %f. On 8-bit AVR, format floats
// with dtostrf() instead of %.2f.
//
// As shipped it flies a tiny synthetic climb so you can verify the link on a
// bare board. Replace the SYNTHETIC block with your real sensor reads: keep the
// field names and units from hardware/firmware/README.md and you are done.

#include <Arduino.h>
#include <string.h>
#include <stdio.h>

static const uint32_t RATE_HZ = 20;           // telemetry rate
static const bool APPEND_CRC  = true;          // NMEA-style *XXXX suffix

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflect, no final xor).
// Must match src/telemetry/crc.ts byte for byte. Check("123456789") == 0x29B1.
static uint16_t crc16_ccitt_false(const char *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)((uint8_t)data[i]) << 8;
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

// Write one framed line (optional checksum) and terminate with '\n'.
static void emit_line(const char *json) {
  if (APPEND_CRC) {
    uint16_t c = crc16_ccitt_false(json, strlen(json));
    char suffix[8];
    snprintf(suffix, sizeof(suffix), "*%04X", c);
    Serial.print(json);
    Serial.println(suffix);        // println adds '\n' (a trailing '\r' is fine)
  } else {
    Serial.println(json);
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { /* wait for USB CDC on native-USB boards */ }
}

void loop() {
  static uint32_t seq = 0;
  uint32_t t_ms = millis();

  // ---- SYNTHETIC flight (replace this block with real sensor reads) ----
  float phase = (float)t_ms / 1000.0f;
  float alt_m = phase < 8.0f ? 0.5f * 60.0f * phase * phase * 0.12f : 0.0f; // rough climb
  float vel_mps = phase < 8.0f ? 60.0f * phase * 0.12f : 0.0f;
  float az = 9.81f + (phase < 3.0f ? 40.0f : 0.0f);                          // boost spike
  float batt_v = 7.9f;
  const char *event = (seq == 0) ? "ARMED" : ((phase >= 3.0f && phase < 3.1f) ? "LIFTOFF" : "");
  // ----------------------------------------------------------------------

  // Build the JSON line. Keep "v":1 only if every key is an exact V1 name.
  // Include the event field only when there is one (empty strings are omitted).
  char line[320];
  if (event && event[0]) {
    snprintf(line, sizeof(line),
      "{\"v\":1,\"t_ms\":%lu,\"seq\":%lu,\"alt_m\":%.2f,\"vel_mps\":%.2f,"
      "\"az\":%.2f,\"batt_v\":%.2f,\"event\":\"%s\"}",
      (unsigned long)t_ms, (unsigned long)seq, alt_m, vel_mps, az, batt_v, event);
  } else {
    snprintf(line, sizeof(line),
      "{\"v\":1,\"t_ms\":%lu,\"seq\":%lu,\"alt_m\":%.2f,\"vel_mps\":%.2f,"
      "\"az\":%.2f,\"batt_v\":%.2f}",
      (unsigned long)t_ms, (unsigned long)seq, alt_m, vel_mps, az, batt_v);
  }

  emit_line(line);
  seq++;

  delay(1000 / RATE_HZ);
}
