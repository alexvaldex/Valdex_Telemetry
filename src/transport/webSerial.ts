import type { Connection, ConnectOptions, ConnectionStatus } from "./types";

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export class WebSerialConnection implements Connection {
  status: ConnectionStatus = "disconnected";

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readClosed: Promise<void> | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

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

  async connect(opts: ConnectOptions): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error("Web Serial API not supported in this browser. Use Chrome/Edge, or switch to Simulator.");
    }

    this.setStatus("connecting");

    try {
      // Must be called from a user-gesture handler (e.g. a click).
      const port = await navigator.serial!.requestPort();
      await port.open({ baudRate: opts.baudRate });
      this.port = port;
      if (port.writable) this.writer = port.writable.getWriter();
      this.setStatus("connected");
      this.readLoop();
    } catch (err) {
      this.setStatus("disconnected");
      throw err;
    }
  }

  private async readLoop() {
    if (!this.port?.readable) return;

    const textStream = this.port.readable.pipeThrough(
      new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>
    );
    this.reader = textStream.getReader();

    let buffer = "";

    this.readClosed = (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          if (!value) continue;

          buffer += value;
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) this.lineListeners.forEach((cb) => cb(line));
          }
        }
      } catch (err) {
        console.error("[WebSerialConnection] read loop error", err);
      } finally {
        if (this.status === "connected") this.setStatus("disconnected");
      }
    })();
  }

  async write(line: string): Promise<void> {
    if (!this.writer) throw new Error("Serial port is not writable");
    await this.writer.write(new TextEncoder().encode(line + "\n"));
  }

  async disconnect(): Promise<void> {
    try {
      this.writer?.releaseLock();
    } catch {
      // ignore
    }
    this.writer = null;

    try {
      await this.reader?.cancel();
    } catch {
      // ignore
    }
    this.reader?.releaseLock();
    this.reader = null;

    if (this.readClosed) {
      await this.readClosed.catch(() => {});
      this.readClosed = null;
    }

    try {
      await this.port?.close();
    } catch {
      // ignore
    }
    this.port = null;

    this.setStatus("disconnected");
  }
}
