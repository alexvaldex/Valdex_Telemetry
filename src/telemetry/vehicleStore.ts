/**
 * Vehicle configuration + 3D model storage.
 *
 * Rocket config is small and lives in localStorage. CAD models can be several
 * MB, so they live in their own IndexedDB (separate DB from the flight log to
 * avoid version coupling). Same-tab consumers can't rely on the `storage`
 * event, so writes dispatch a `vx:vehicleChanged` window event the viewer
 * listens to for live refresh.
 */

import type { Model3D, UpAxis } from "../widgets/rocketModel";

export type StageRole = "sustainer" | "booster";
export type RecoveryType = "drogue-main" | "main-only" | "none";
export type SeparationEvent = "BURNOUT" | "APOGEE" | "NONE";

export type RocketConfig = {
  name: string;
  stages: 1 | 2;
  separationEvent: SeparationEvent; // when the booster falls away (2-stage)
  recovery: RecoveryType;
  modelScale: number;               // user size multiplier
  upAxis: UpAxis;                   // which CAD axis is "nose up"
};

export const DEFAULT_ROCKET_CONFIG: RocketConfig = {
  name: "My Rocket",
  stages: 1,
  separationEvent: "BURNOUT",
  recovery: "drogue-main",
  modelScale: 1,
  upAxis: "y",
};

const CONFIG_KEY = "vx.rocketConfig";
export const VEHICLE_CHANGED_EVENT = "vx:vehicleChanged";

export function getRocketConfig(): RocketConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_ROCKET_CONFIG };
    return { ...DEFAULT_ROCKET_CONFIG, ...(JSON.parse(raw) as Partial<RocketConfig>) };
  } catch {
    return { ...DEFAULT_ROCKET_CONFIG };
  }
}

export function saveRocketConfig(cfg: RocketConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  notifyVehicleChanged();
}

export function notifyVehicleChanged() {
  window.dispatchEvent(new CustomEvent(VEHICLE_CHANGED_EVENT));
}

/* ---------------- IndexedDB model store ---------------- */

const DB_NAME = "vx-vehicle";
const STORE = "models";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "role" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type StoredModel = { role: StageRole } & Model3D;

export async function saveVehicleModel(role: StageRole, model: Model3D): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ role, ...model } as StoredModel);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyVehicleChanged();
}

export async function getVehicleModel(role: StageRole): Promise<Model3D | null> {
  const db = await openDB();
  const result = await new Promise<StoredModel | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(role);
    req.onsuccess = () => resolve(req.result as StoredModel | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!result) return null;
  const { role: _role, ...model } = result;
  return model;
}

export async function deleteVehicleModel(role: StageRole): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(role);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  notifyVehicleChanged();
}

/* ---------------- Flight phase ---------------- */

export const PHASES = ["PAD", "BOOST", "COAST", "APOGEE", "DROGUE", "MAIN", "LANDED"] as const;
export type FlightPhase = (typeof PHASES)[number];

function eventToPhase(ev: string): FlightPhase | null {
  const u = ev.toUpperCase();
  if (u.includes("LIFT")) return "BOOST";
  if (u.includes("BURN")) return "COAST";
  if (u.includes("APOG")) return "APOGEE";
  if (u.includes("DROG")) return "DROGUE";
  if (u.includes("MAIN")) return "MAIN";
  if (u.includes("LAND")) return "LANDED";
  return null;
}

/** Current phase = phase begun by the last event at/before the display time. */
export function derivePhase(frames: Array<{ t_ms: number; event?: string }>, tMs: number): FlightPhase {
  let phase: FlightPhase = "PAD";
  for (const f of frames) {
    if (f.t_ms > tMs) break;
    if (typeof f.event === "string" && f.event.trim()) {
      const p = eventToPhase(f.event);
      if (p) phase = p;
    }
  }
  return phase;
}

export function phaseIndex(p: FlightPhase): number {
  return PHASES.indexOf(p);
}
