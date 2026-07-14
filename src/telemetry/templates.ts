import { WIDGETS, type WidgetId } from "../widgets/registry";

/**
 * Ready-made dashboard templates for the first run (and the Settings picker).
 * Each is a curated widget set; `templateLayout` flows them into a 12-column
 * react-grid-layout using each widget's registry default size, so the user
 * lands on a sensible, populated dashboard instead of a blank grid.
 */

export type DashTemplate = {
  id: string;
  name: string;
  desc: string;
  widgets: WidgetId[];
};

export const TEMPLATES: DashTemplate[] = [
  {
    id: "hpr",
    name: "HPR dual-deploy",
    desc: "The standard high-power layout: altitude, velocity, GPS recovery map, pyro continuity, battery, flight summary, and a pre-flight checklist.",
    widgets: ["altitude.card", "velocity.card", "battery.card", "gps.map", "pyro.panel", "flight.summary", "checklist.panel", "raw.console"],
  },
  {
    id: "tvc",
    name: "TVC test stand",
    desc: "For thrust-vector bench tests and hops: gimbal deflection, attitude, IMU, tilt & spin, battery, and the raw console.",
    widgets: ["tvc.panel", "attitude.card", "tilt.spin", "imu.card", "battery.card", "raw.console"],
  },
  {
    id: "canard",
    name: "Canard / roll control",
    desc: "Active roll-control tuning: canard fins, tilt & spin, attitude, IMU, and the raw console.",
    widgets: ["canard.panel", "tilt.spin", "attitude.card", "imu.card", "raw.console"],
  },
  {
    id: "airbrake",
    name: "Airbrake altitude target",
    desc: "Altitude-targeting flights: air brakes with the apogee tracker, altitude, velocity, and flight summary.",
    widgets: ["airbrake.panel", "altitude.card", "velocity.card", "flight.summary", "raw.console"],
  },
  {
    id: "competition",
    name: "Competition altitude",
    desc: "Clean data for scoring: altitude, velocity, flight summary, link quality, and the GPS range map.",
    widgets: ["altitude.card", "velocity.card", "flight.summary", "link.quality", "gps.map", "raw.console"],
  },
  {
    id: "blank",
    name: "Blank",
    desc: "Start with just the raw console and build your own layout.",
    widgets: ["raw.console"],
  },
];

export type GridItem = { i: string; x: number; y: number; w: number; h: number };

/** Flow a widget list into a 12-column grid using registry default sizes. */
export function templateLayout(widgetIds: WidgetId[]): { instances: Array<{ key: string; widgetId: WidgetId }>; layout: GridItem[] } {
  const COLS = 12;
  const instances: Array<{ key: string; widgetId: WidgetId }> = [];
  const layout: GridItem[] = [];
  let curX = 0, curY = 0, rowH = 0;
  const seen: Record<string, number> = {};

  for (const id of widgetIds) {
    const def = WIDGETS.find((w) => w.id === id);
    const w = Math.min(COLS, def?.defaultSize.w ?? 4);
    const h = def?.defaultSize.h ?? 6;
    if (curX + w > COLS) { curY += rowH; curX = 0; rowH = 0; }
    const n = (seen[id] = (seen[id] ?? 0) + 1);
    const key = `${id.replace(/\./g, "-")}-${n}`;
    instances.push({ key, widgetId: id });
    layout.push({ i: key, x: curX, y: curY, w, h });
    curX += w;
    rowH = Math.max(rowH, h);
  }
  return { instances, layout };
}
