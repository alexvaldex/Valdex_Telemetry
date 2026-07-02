/**
 * Persistent flight log (IndexedDB).
 *
 * Each flight stores its raw NDJSON lines plus computed metadata so the log
 * list can show apogee / duration / frame count without re-parsing. Raw lines
 * are the source of truth — reloading a flight replays them through the same
 * ingest pipeline used for live telemetry.
 */

import { verifyAndStrip } from "./crc";

export type FlightMeta = {
  id: string;
  name: string;
  savedAt: number;      // epoch ms
  startedAt: number;    // epoch ms (session start)
  frameCount: number;
  rawCount: number;
  durationMs?: number;  // last t_ms - first t_ms
  apogeeM?: number;
};

export type FlightRecord = FlightMeta & {
  rawLines: string[];
};

const DB_NAME = "vx-telemetry";
const STORE = "flights";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

/** Derive metadata from raw NDJSON lines. */
export function summarizeRawLines(rawLines: string[]): { frameCount: number; durationMs?: number; apogeeM?: number } {
  let frameCount = 0;
  let firstT: number | undefined;
  let lastT: number | undefined;
  let apogeeM: number | undefined;

  for (const line of rawLines) {
    try {
      // Lines may carry a *XXXX CRC suffix — corrupt ones don't count.
      const { payload, crc } = verifyAndStrip(line);
      if (crc === "bad") continue;
      const o = JSON.parse(payload);
      if (o && o.v === 1 && typeof o.t_ms === "number") {
        frameCount++;
        if (firstT === undefined) firstT = o.t_ms;
        lastT = o.t_ms;
        if (typeof o.alt_m === "number" && (apogeeM === undefined || o.alt_m > apogeeM)) apogeeM = o.alt_m;
      }
    } catch {
      // ignore non-frame lines
    }
  }

  return {
    frameCount,
    durationMs: firstT !== undefined && lastT !== undefined ? lastT - firstT : undefined,
    apogeeM,
  };
}

export async function saveFlight(params: { name?: string; startedAt: number; rawLines: string[] }): Promise<FlightMeta> {
  const s = summarizeRawLines(params.rawLines);
  const savedAt = Date.now();
  const id = `flt_${savedAt}_${Math.random().toString(36).slice(2, 7)}`;
  const rec: FlightRecord = {
    id,
    name: params.name ?? new Date(params.startedAt).toLocaleString(),
    savedAt,
    startedAt: params.startedAt,
    frameCount: s.frameCount,
    rawCount: params.rawLines.length,
    durationMs: s.durationMs,
    apogeeM: s.apogeeM,
    rawLines: params.rawLines,
  };
  await tx("readwrite", (store) => store.put(rec));
  const { rawLines, ...meta } = rec;
  return meta;
}

export async function listFlights(): Promise<FlightMeta[]> {
  const all = await tx<FlightRecord[]>("readonly", (store) => store.getAll() as IDBRequest<FlightRecord[]>);
  return all
    .filter((r) => r.id !== LIVE_ID)
    .map(({ rawLines, ...meta }) => meta)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function getFlight(id: string): Promise<FlightRecord | undefined> {
  return tx<FlightRecord | undefined>("readonly", (store) => store.get(id) as IDBRequest<FlightRecord | undefined>);
}

/* ---------------- Crash-safe live checkpointing ----------------
 * The in-progress session is checkpointed under a fixed id every few seconds
 * while connected. A clean disconnect archives the flight and clears the
 * checkpoint; a crash / closed tab leaves it behind, and the next launch
 * recovers it into a normal flight-log entry. Flight data is never lost.
 */

const LIVE_ID = "__live_session__";

export async function checkpointLiveFlight(startedAt: number, rawLines: string[]): Promise<void> {
  const s = summarizeRawLines(rawLines);
  const rec: FlightRecord = {
    id: LIVE_ID,
    name: `LIVE ${new Date(startedAt).toLocaleString()}`,
    savedAt: Date.now(),
    startedAt,
    frameCount: s.frameCount,
    rawCount: rawLines.length,
    durationMs: s.durationMs,
    apogeeM: s.apogeeM,
    rawLines,
  };
  await tx("readwrite", (store) => store.put(rec));
}

export async function clearLiveCheckpoint(): Promise<void> {
  await tx("readwrite", (store) => store.delete(LIVE_ID) as unknown as IDBRequest<undefined>);
}

/** Recover an orphaned checkpoint into a real flight entry. Returns its meta, or null. */
export async function recoverLiveFlight(): Promise<FlightMeta | null> {
  const rec = await tx<FlightRecord | undefined>("readonly", (store) => store.get(LIVE_ID) as IDBRequest<FlightRecord | undefined>);
  if (!rec || !rec.rawLines?.length) return null;
  await tx("readwrite", (store) => store.delete(LIVE_ID) as unknown as IDBRequest<undefined>);
  return saveFlight({
    name: `Recovered · ${new Date(rec.startedAt).toLocaleString()}`,
    startedAt: rec.startedAt,
    rawLines: rec.rawLines,
  });
}

export async function deleteFlight(id: string): Promise<void> {
  await tx("readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
}
