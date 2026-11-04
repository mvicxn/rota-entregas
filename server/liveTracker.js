import crypto from "crypto";
import { EventEmitter } from "events";

const MAX_EVENTS = 25;
const recentEvents = [];
const sseClients = new Set();
const wsClients = new Set();
const bus = new EventEmitter();

export function broadcastLiveEvent(payload) {
  const event = {
    id: `${Date.now()}-${recentEvents.length}`,
    ...payload,
    created_at: payload.created_at || new Date().toISOString(),
  };
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_EVENTS) recentEvents.pop();
  bus.emit("live", event);
  const data = JSON.stringify(event);
  for (const res of sseClients) {
    try {
      res.write(`event: live\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
  const frame = encodeWsTextFrame(data);
  for (const socket of wsClients) {
    try {
      socket.write(frame);
    } catch {
      wsClients.delete(socket);
    }
  }
  return event;
}

export function getRecentLiveEvents() {
  return [...recentEvents];
}

export function getLiveSummary(db) {
  const couriers = db
    .prepare(
      `SELECT id, name, phone, vehicle_type, vehicle_plate, status, current_lat, current_lng, last_ping_at FROM couriers ORDER BY id`
    )
    .all();
  return { events: getRecentLiveEvents(), couriers };
}

export function handleSseStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function computeWebSocketAccept(secKey) {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  return crypto.createHash("sha1").update(String(secKey) + GUID).digest("base64");
}

export function attachLiveTracking(httpServer) {
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url?.split("?")[0] || "";
    if (url !== "/ws/tracking") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = computeWebSocketAccept(key);
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n");
    socket.write(headers);
    wsClients.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => wsClients.delete(socket));
    socket.on("error", () => wsClients.delete(socket));
    if (head?.length) socket.unshift(head);
  });
}

export function verifyWebSocketAccept(secKey) {
  return computeWebSocketAccept(secKey);
}
