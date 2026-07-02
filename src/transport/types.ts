export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export type ConnectOptions = {
  baudRate: number;
};

export interface Connection {
  connect(opts: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void;
  /** Optional TX path: send a command line to the device (newline appended). */
  write?(line: string): Promise<void>;
  readonly status: ConnectionStatus;
}
