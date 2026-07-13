import type { TelemetryFrameV1 } from "./types";
import { verifyAndStrip } from "./crc";

/**
 * Shareable flight replays. Two outputs, both backend-free (this app is
 * local-first):
 *
 *   - a self-contained HTML file (embedded data + an inline viewer) that opens
 *     in any browser, offline — the "check out my flight" artifact, and
 *   - a compact URL (`#flight=…`, gzip in the hash) for small flights, which
 *     VX opens straight into playback.
 */

export type SharePoint = { t: number; alt?: number; vel?: number; lat?: number; lon?: number };
export type ShareEvent = { t: number; label: string };
export type ShareFlight = { name: string; startedAt?: number; pts: SharePoint[]; events: ShareEvent[] };

/** Parse stored NDJSON flight lines back into V1 frames. */
export function flightToFrames(rawLines: string[]): TelemetryFrameV1[] {
  const frames: TelemetryFrameV1[] = [];
  for (const line of rawLines) {
    if (!line || !line.trim()) continue;
    try {
      const { payload, crc } = verifyAndStrip(line);
      if (crc === "bad") continue;
      const o = JSON.parse(payload);
      if (o && o.v === 1 && typeof o.t_ms === "number") frames.push(o as TelemetryFrameV1);
    } catch {
      /* skip */
    }
  }
  frames.sort((a, b) => (a.t_ms ?? 0) - (b.t_ms ?? 0));
  return frames;
}

/** Downsample to at most `max` points, always keeping frames that carry an event. */
export function toShareFlight(name: string, frames: TelemetryFrameV1[], max = 600): ShareFlight {
  const events: ShareEvent[] = [];
  for (const f of frames) {
    if (typeof f.event === "string" && f.event.trim()) events.push({ t: f.t_ms, label: f.event.trim() });
  }
  const keep = new Set<number>();
  if (frames.length > max) {
    const step = frames.length / max;
    for (let i = 0; i < max; i++) keep.add(Math.floor(i * step));
    frames.forEach((f, i) => { if (typeof f.event === "string" && f.event.trim()) keep.add(i); });
  } else {
    frames.forEach((_, i) => keep.add(i));
  }
  const r = (n?: number, d = 2) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : undefined);
  const pts: SharePoint[] = [];
  Array.from(keep).sort((a, b) => a - b).forEach((i) => {
    const f = frames[i];
    pts.push({ t: f.t_ms, alt: r(f.alt_m, 1), vel: r(f.vel_mps, 1), lat: r(f.lat, 6), lon: r(f.lon, 6) });
  });
  return { name, startedAt: frames[0]?.t_ms, pts, events };
}

/** Summary stats computed once for the HTML header. */
function stats(sf: ShareFlight) {
  let apogee = 0, maxVel = 0, t0 = sf.pts[0]?.t ?? 0, tN = sf.pts[sf.pts.length - 1]?.t ?? 0;
  let hasGps = false;
  for (const p of sf.pts) {
    if (typeof p.alt === "number" && p.alt > apogee) apogee = p.alt;
    if (typeof p.vel === "number" && Math.abs(p.vel) > maxVel) maxVel = Math.abs(p.vel);
    if (typeof p.lat === "number" && typeof p.lon === "number") hasGps = true;
  }
  return { apogeeM: apogee, maxVelMps: maxVel, durationS: (tN - t0) / 1000, hasGps };
}

/* ---------------- Compact link (gzip in the hash) ---------------- */

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(str: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(str);
  if (typeof (globalThis as any).CompressionStream === "function") {
    const cs = new (globalThis as any).CompressionStream("gzip");
    const stream = new Response(new Blob([input as BlobPart]).stream().pipeThrough(cs));
    return new Uint8Array(await stream.arrayBuffer());
  }
  return input; // no gzip available — send uncompressed (marked by prefix)
}
async function gunzip(bytes: Uint8Array, gz: boolean): Promise<string> {
  if (gz && typeof (globalThis as any).DecompressionStream === "function") {
    const ds = new (globalThis as any).DecompressionStream("gzip");
    const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds));
    return new TextDecoder().decode(await stream.arrayBuffer());
  }
  return new TextDecoder().decode(bytes);
}

/** Columnar JSON keeps the payload small. */
function encodeColumnar(sf: ShareFlight): string {
  return JSON.stringify({
    n: sf.name,
    t: sf.pts.map((p) => p.t),
    a: sf.pts.map((p) => p.alt ?? null),
    v: sf.pts.map((p) => p.vel ?? null),
    la: sf.pts.map((p) => p.lat ?? null),
    lo: sf.pts.map((p) => p.lon ?? null),
    e: sf.events.map((e) => [e.t, e.label]),
  });
}
function decodeColumnar(json: string): ShareFlight {
  const o = JSON.parse(json);
  const pts: SharePoint[] = o.t.map((t: number, i: number) => ({
    t, alt: o.a[i] ?? undefined, vel: o.v[i] ?? undefined, lat: o.la[i] ?? undefined, lon: o.lo[i] ?? undefined,
  }));
  const events: ShareEvent[] = (o.e ?? []).map((e: [number, string]) => ({ t: e[0], label: e[1] }));
  return { name: o.n ?? "Shared flight", pts, events };
}

export type ShareLink = { url: string; chars: number; tooBig: boolean };

/** Build a `#flight=` URL. Flags tooBig when it exceeds a forum-safe length. */
export async function encodeShareLink(sf: ShareFlight): Promise<ShareLink> {
  const json = encodeColumnar(sf);
  const gz = typeof (globalThis as any).CompressionStream === "function";
  const bytes = await gzip(json);
  const payload = (gz ? "1" : "0") + bytesToB64url(bytes);
  const base = `${location.origin}${location.pathname}`;
  const url = `${base}#flight=${payload}`;
  return { url, chars: url.length, tooBig: url.length > 8000 };
}

/** Decode a `#flight=` hash back into a ShareFlight (or null). */
export async function decodeShareLink(hash: string): Promise<ShareFlight | null> {
  try {
    const m = hash.match(/flight=([^&]+)/);
    if (!m) return null;
    const raw = m[1];
    const gz = raw[0] === "1";
    const bytes = b64urlToBytes(raw.slice(1));
    const json = await gunzip(bytes, gz);
    return decodeColumnar(json);
  } catch {
    return null;
  }
}

/** Reconstruct NDJSON lines from a ShareFlight so it can feed playback. */
export function shareFlightToLines(sf: ShareFlight): string[] {
  const evByT = new Map<number, string>();
  for (const e of sf.events) evByT.set(e.t, e.label);
  return sf.pts.map((p) => {
    const f: Record<string, unknown> = { v: 1, t_ms: p.t };
    if (typeof p.alt === "number") f.alt_m = p.alt;
    if (typeof p.vel === "number") f.vel_mps = p.vel;
    if (typeof p.lat === "number") f.lat = p.lat;
    if (typeof p.lon === "number") f.lon = p.lon;
    const ev = evByT.get(p.t);
    if (ev) f.event = ev;
    return JSON.stringify(f);
  });
}

/* ---------------- Self-contained HTML replay ---------------- */

export function buildReplayHTML(sf: ShareFlight): string {
  const s = stats(sf);
  const data = JSON.stringify(sf).replace(/</g, "\\u003c");
  const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—");
  const date = sf.startedAt ? new Date(sf.startedAt).toISOString().slice(0, 10) : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(sf.name)} — VX Telemetry flight replay</title>
<style>
:root{--bg:#111112;--panel:#17171a;--line:rgba(190,193,200,.16);--fg:#e7e8ea;--dim:#9a9ca3;--faint:#62656c;--accent:#a2a6ae;--acc2:#d8dbe0;--go:#24e08a;--cau:#ffb02e;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;font-weight:600;margin:0 0 2px;letter-spacing:.02em}
.sub{color:var(--faint);font-size:13px;margin-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:22px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px}
.tile .k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.tile .v{font-family:var(--mono);font-size:22px;margin-top:4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:16px}
.card h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 10px;font-weight:600}
svg{width:100%;display:block}
.ctl{display:flex;align-items:center;gap:12px;margin-top:10px}
.ctl input[type=range]{flex:1;accent-color:var(--accent)}
.readout{font-family:var(--mono);font-size:13px;color:var(--acc2);min-width:150px;text-align:right}
button{font-family:var(--sans);background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}
.events{display:flex;flex-wrap:wrap;gap:6px}
.ev{font-family:var(--mono);font-size:11px;color:var(--faint);border:1px solid var(--line);border-radius:2px;padding:3px 8px}
.foot{color:var(--faint);font-size:12px;text-align:center;margin-top:26px}
.foot a{color:var(--accent)}
</style></head><body><div class="wrap">
<h1>${escapeHtml(sf.name)}</h1>
<div class="sub">Flight replay${date ? " · " + date : ""} · generated by VX Telemetry</div>
<div class="tiles">
  <div class="tile"><div class="k">Apogee</div><div class="v">${fmt(s.apogeeM)} m</div></div>
  <div class="tile"><div class="k">Max velocity</div><div class="v">${fmt(s.maxVelMps)} m/s</div></div>
  <div class="tile"><div class="k">Duration</div><div class="v">${fmt(s.durationS)} s</div></div>
  <div class="tile"><div class="k">Data points</div><div class="v">${fmt(sf.pts.length)}</div></div>
</div>
<div class="card"><h2>Altitude</h2><svg id="altc" viewBox="0 0 900 240" preserveAspectRatio="none"></svg></div>
<div class="card"><h2>Velocity</h2><svg id="velc" viewBox="0 0 900 200" preserveAspectRatio="none"></svg></div>
<div class="card" id="gpscard" style="display:none"><h2>Ground track</h2><svg id="gps" viewBox="0 0 900 320"></svg></div>
<div class="card"><h2>Replay</h2>
  <div class="ctl">
    <button id="play">Play</button>
    <input id="scrub" type="range" min="0" value="0" step="1">
    <div class="readout" id="ro">T+0.0s</div>
  </div>
</div>
<div class="card"><h2>Events</h2><div class="events" id="events"></div></div>
<div class="foot">Made with <a href="https://github.com/alexvaldex/valdex-telemetry-windows-linux">VX Telemetry</a> — universal ground station for rocketry.</div>
</div>
<script>
const D=${data};
const P=D.pts, EV=D.events||[];
const t0=P.length?P[0].t:0;
const num=(a,k)=>a.map(p=>typeof p[k]==='number'?p[k]:null);
const alt=num(P,'alt'),vel=num(P,'vel');
function ext(a){let mn=Infinity,mx=-Infinity;for(const v of a)if(v!=null){if(v<mn)mn=v;if(v>mx)mx=v}if(!isFinite(mn)){mn=0;mx=1}if(mn===mx)mx=mn+1;return[mn,mx]}
function path(a,w,h,pad){const[mn,mx]=ext(a);const n=a.length;let d='';let started=false;for(let i=0;i<n;i++){if(a[i]==null){started=false;continue}const x=pad+(i/(n-1))*(w-2*pad);const y=h-pad-((a[i]-mn)/(mx-mn))*(h-2*pad);d+=(started?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' ';started=true}return{d,mn,mx}}
function grid(svg,w,h,pad,mn,mx,unit){const g=[];for(let f=0;f<=4;f++){const y=h-pad-(f/4)*(h-2*pad);const val=Math.round(mn+(f/4)*(mx-mn));g.push('<line x1="'+pad+'" y1="'+y+'" x2="'+(w-pad)+'" y2="'+y+'" stroke="rgba(150,153,160,.1)"/>');g.push('<text x="6" y="'+(y-3)+'" fill="#62656c" font-size="11" font-family="ui-monospace">'+val+' '+unit+'</text>')}return g.join('')}
function draw(id,a,unit,color){const svg=document.getElementById(id);const w=900,h=+svg.getAttribute('viewBox').split(' ')[3],pad=24;const{d,mn,mx}=path(a,w,h,pad);svg.innerHTML=grid(svg,w,h,pad,mn,mx,unit)+'<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>'+'<line id="'+id+'cur" x1="'+pad+'" y1="'+pad+'" x2="'+pad+'" y2="'+(h-pad)+'" stroke="#d8dbe0" stroke-width="1"/>';return{mn,mx,pad,w,h}}
const A=draw('altc',alt,'m','#a2a6ae');const V=draw('velc',vel,'m/s','#ffb02e');
// GPS ground track
const gp=P.filter(p=>typeof p.lat==='number'&&typeof p.lon==='number');
if(gp.length>2){document.getElementById('gpscard').style.display='';const la=gp.map(p=>p.lat),lo=gp.map(p=>p.lon);const[laMn,laMx]=ext(la),[loMn,loMx]=ext(lo);const w=900,h=320,pad=20;const sx=v=>pad+((v-loMn)/((loMx-loMn)||1))*(w-2*pad);const sy=v=>h-pad-((v-laMn)/((laMx-laMn)||1))*(h-2*pad);let d='';gp.forEach((p,i)=>{d+=(i?'L':'M')+sx(p.lon).toFixed(1)+' '+sy(p.lat).toFixed(1)+' '});document.getElementById('gps').innerHTML='<path d="'+d+'" fill="none" stroke="#a2a6ae" stroke-width="1.4"/><circle cx="'+sx(lo[0]).toFixed(1)+'" cy="'+sy(la[0]).toFixed(1)+'" r="4" fill="#24e08a"/>'}
// events
document.getElementById('events').innerHTML=EV.length?EV.map(e=>'<span class="ev">'+e.label.replace(/</g,'')+' T+'+((e.t-t0)/1000).toFixed(1)+'s</span>').join(''):'<span class="ev">no events</span>';
// scrubber
const scrub=document.getElementById('scrub'),ro=document.getElementById('ro'),playB=document.getElementById('play');
scrub.max=P.length-1;
function setCur(id,X){const el=document.getElementById(id+'cur');if(el){el.setAttribute('x1',X);el.setAttribute('x2',X)}}
function update(i){const p=P[i]||{};const pad=24,w=900;const X=pad+(i/(P.length-1))*(w-2*pad);setCur('altc',X);setCur('velc',X);ro.textContent='T+'+((p.t-t0)/1000).toFixed(1)+'s  '+(p.alt!=null?p.alt.toFixed(0)+'m ':'')+(p.vel!=null?p.vel.toFixed(0)+'m/s':'')}
scrub.oninput=()=>update(+scrub.value);update(0);
let playing=false,tm=null;
playB.onclick=()=>{playing=!playing;playB.textContent=playing?'Pause':'Play';if(playing){tm=setInterval(()=>{let i=+scrub.value+2;if(i>=P.length-1){i=P.length-1;playing=false;playB.textContent='Play';clearInterval(tm)}scrub.value=i;update(i)},33)}else clearInterval(tm)};
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
