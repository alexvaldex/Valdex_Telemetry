/**
 * User-defined alert rules: numeric thresholds on any telemetry field,
 * evaluated against the latest frame and fed into the app's alert bar +
 * master-caution system.
 */

export type AlertRuleOp = ">" | "<";
export type AlertRuleLevel = "warn" | "crit";

export type AlertRule = {
  id: string;
  field: string;      // numeric V1 frame key
  op: AlertRuleOp;
  value: number;
  level: AlertRuleLevel;
  title: string;      // shown in the alert bar
};

/** Numeric fields a rule can watch. */
export const RULE_FIELDS = [
  "alt_m",
  "vel_mps",
  "batt_v",
  "rssi_dbm",
  "ax", "ay", "az",
  "gx", "gy", "gz",
  "gps_sats",
  "temp_c", "pressure_pa", "humidity_pct",
] as const;

const KEY = "vx.alertRules";

export function loadAlertRules(): AlertRule[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as AlertRule[];
  } catch {
    return [];
  }
}

export function saveAlertRules(rules: AlertRule[]) {
  localStorage.setItem(KEY, JSON.stringify(rules));
}

/** True when the rule's condition is met on this frame. */
export function ruleFires(rule: AlertRule, frame: Record<string, unknown> | undefined): boolean {
  if (!frame) return false;
  const v = frame[rule.field];
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  return rule.op === ">" ? v > rule.value : v < rule.value;
}
