#!/usr/bin/env node
/**
 * VX WebSocket bridge — turn any NDJSON telemetry source into a shared stream
 * that phones/laptops can watch in VX's Spectator mode over the local network.
 *
 * Dependency-free (raw RFC 6455, Node built-ins only). Reads NDJSON lines from
 * stdin and broadcasts each line to every connected WebSocket client.
 *
 * Usage:
 *   <your serial reader> | node tools/vx-ws-bridge.mjs [port]
 *   # e.g.  cat /dev/tty.usbserial-XXXX | node tools/vx-ws-bridge.mjs 8787
 *
 * Then, on every device on the same Wi-Fi, open VX → transport "Spectator
 * (WebSocket)" → ws://<this-machine-ip>:8787 → Connect.
 */
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import os from "node:os";

const PORT = Number(process.argv[2]) || 8787;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set();

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`VX WebSocket bridge — ${clients.size} spectator(s). Connect VX to ws://<ip>:${PORT}\n`);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

/** Encode a server→client text frame (unmasked). */
function frame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(line) {
  const buf = frame(line);
  for (const s of clients) {
    try { s.write(buf); } catch { clients.delete(s); }
  }
}

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  console.error(`[vx-ws-bridge] listening on ws://0.0.0.0:${PORT}`);
  for (const ip of ips) console.error(`[vx-ws-bridge]   spectators connect to  ws://${ip}:${PORT}`);
  console.error(`[vx-ws-bridge] piping stdin → ${clients.size} client(s)…`);
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const t = line.trim();
  if (t) broadcast(t);
});
