/**
 * User-defined field remapping: arbitrary firmware field names -> V1 contract
 * keys, applied per line in the ingest pipeline BEFORE normalization. This
 * lets third-party firmware work without editing schema.ts.
 *
 * Mappings are cached in-module so the hot ingest path never touches
 * localStorage per line.
 */

export type FieldMapping = { source: string; target: string };

/** V1 contract keys a user can map onto. */
export const V1_TARGET_KEYS = [
  "t_ms",
  "alt_m",
  "vel_mps",
  "batt_v", "current_a",
  "rssi_dbm", "snr_db",
  "ax", "ay", "az",
  "gx", "gy", "gz",
  "lat", "lon",
  "gps_fix", "gps_sats", "gps_alt_m",
  "q_w", "q_x", "q_y", "q_z",
  "temp_c", "pressure_pa", "humidity_pct",
  "event",
  "pyro_main_cont", "pyro_drogue_cont",
] as const;

const KEY = "vx.fieldMap";
let cache: FieldMapping[] | null = null;

export function getFieldMap(): FieldMapping[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || "[]") as FieldMapping[];
  } catch {
    cache = [];
  }
  return cache;
}

export function saveFieldMap(mappings: FieldMapping[]) {
  cache = mappings.filter((m) => m.source.trim() && m.target.trim());
  localStorage.setItem(KEY, JSON.stringify(cache));
}

/** Copy mapped source values onto their target keys (target wins if already set). */
export function applyFieldMap(obj: Record<string, unknown>): Record<string, unknown> {
  const map = getFieldMap();
  if (!map.length || !obj || typeof obj !== "object") return obj;
  for (const { source, target } of map) {
    if (obj[source] !== undefined && obj[target] === undefined) {
      obj[target] = obj[source];
    }
  }
  return obj;
}

/**
 * Keys seen in incoming frames that are neither V1 keys nor mapped — surfaced
 * in the Field Map UI so users can see exactly what their firmware sends.
 */
const unknownKeys = new Set<string>();
const KNOWN = new Set<string>([...V1_TARGET_KEYS, "v", "ev", "t", "time_ms", "timestamp_ms"]);

export function trackUnknownKeys(obj: Record<string, unknown>) {
  if (!obj || typeof obj !== "object") return;
  const mapped = new Set(getFieldMap().map((m) => m.source));
  for (const k of Object.keys(obj)) {
    if (!KNOWN.has(k) && !mapped.has(k)) unknownKeys.add(k);
  }
  // keep it bounded
  if (unknownKeys.size > 40) {
    const first = unknownKeys.values().next().value;
    if (first !== undefined) unknownKeys.delete(first);
  }
}

export function getUnknownKeys(): string[] {
  return Array.from(unknownKeys).sort();
}

export function clearUnknownKeys() {
  unknownKeys.clear();
}
