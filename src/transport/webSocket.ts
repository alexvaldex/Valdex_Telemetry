import type { Connection, ConnectOptions, ConnectionStatus } from "./types";

/**
 * Spectator transport — read a shared NDJSON telemetry stream over a WebSocket.
 *
 * This is how VX becomes a multi-device experience: one machine receives the
 * radio and rebroadcasts the lines over a WebSocket (a small bridge, or the
 * desktop app's built-in host), and every phone/laptop on the same network
 * opens VX in this mode pointed at `ws://<host>:<port>` to watch the same
 * flight live — a shared "mission control" at the pad.
 *
 * Incoming messages are split on newlines, so the server may batch lines or
 * send them one at a time. Reconnects with backoff on an unexpected drop.
 */
export class WebSocketConnection implements Connection {
  status: ConnectionStatus = "disconnected";

  private ws: WebSocket | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private url = "";
  private userClosed = false;
  private acc = "";
  private backoff = 0;

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusListeners.forEach((cb) => cb(status));
  }

  private emitLines(text: string) {
    this.acc += text;
    let idx: number;
    while ((idx = this.acc.indexOf("\n")) >= 0) {
      const line = this.acc.slice(0, idx).trim();
      this.acc = this.acc.slice(idx + 1);
      if (line) this.lineListeners.forEach((cb) => cb(line));
    }
    // Guard against a server that never sends newlines.
    if (this.acc.length > 65_536) this.acc = "";
  }

  async connect(opts: ConnectOptions): Promise<void> {
    let url = (opts.path || "").trim();
    if (!url) throw new Error("Enter a WebSocket URL, e.g. ws://192.168.1.20:8787");
    if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
    this.url = url;
    this.userClosed = false;
    this.acc = "";
    this.setStatus("connecting");
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Invalid WebSocket URL"));
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.backoff = 0;
        this.setStatus("connected");
        if (!settled) { settled = true; resolve(); }
      };
      ws.onmessage = (ev) => {
        const data = ev.data;
        if (typeof data === "string") this.emitLines(data);
        else if (data instanceof Blob) data.text().then((t) => this.emitLines(t)).catch(() => {});
        else if (data instanceof ArrayBuffer) this.emitLines(new TextDecoder().decode(data));
      };
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error(`Couldn't connect to ${this.url}`)); }
      };
      ws.onclose = () => {
        if (this.userClosed) { this.setStatus("disconnected"); return; }
        void this.reconnect();
      };
    });
  }

  private async reconnect() {
    this.setStatus("connecting");
    const delays = [1000, 2000, 4000, 8000];
    const d = delays[Math.min(this.backoff, delays.length - 1)];
    this.backoff++;
    await new Promise((r) => setTimeout(r, d));
    if (this.userClosed) return;
    try {
      await this.open();
    } catch {
      if (!this.userClosed && this.backoff < 8) void this.reconnect();
      else this.setStatus("disconnected");
    }
  }

  async write(line: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line + "\n");
  }

  async disconnect(): Promise<void> {
    this.userClosed = true;
    try { this.ws?.close(); } catch { /* ok */ }
    this.ws = null;
    this.setStatus("disconnected");
  }
}
