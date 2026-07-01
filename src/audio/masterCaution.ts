/**
 * Master-caution audible alarm (Web Audio).
 *
 * A two-tone beeping alarm, mission-control style, driven entirely in code so it
 * needs no asset files. The AudioContext is created lazily and resumed on start
 * — browsers require a prior user gesture (the operator will have clicked
 * Connect), otherwise the context stays suspended and the alarm is silent until
 * the next interaction.
 */

let ctx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;
let beat: ReturnType<typeof setInterval> | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

export function isAlarmRunning(): boolean {
  return osc !== null;
}

export function startAlarm() {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  if (osc) return; // already sounding

  osc = c.createOscillator();
  gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(880, c.currentTime);
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  osc.connect(gain).connect(c.destination);
  osc.start();

  let on = false;
  beat = setInterval(() => {
    if (!gain || !osc || !ctx) return;
    on = !on;
    gain.gain.setTargetAtTime(on ? 0.12 : 0.0001, ctx.currentTime, 0.008);
    osc.frequency.setValueAtTime(on ? 880 : 660, ctx.currentTime);
  }, 380);
}

export function stopAlarm() {
  if (beat) { clearInterval(beat); beat = null; }
  if (gain && ctx) gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.01);
  if (osc) {
    try { osc.stop(); } catch { /* already stopped */ }
    try { osc.disconnect(); } catch { /* noop */ }
    osc = null;
  }
  gain = null;
}
