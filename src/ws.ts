/**
 * Minimal RFC 6455 WebSocket server pieces (Node only, zero dependencies):
 * the opening handshake and text/close/ping/pong framing. Enough for a game
 * server; no extensions (permessage-deflate) and no fragmented messages.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_FRAME = 1 << 20;

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Encode one unfragmented frame. Server frames are unmasked (RFC 6455 5.1). */
export function encodeFrame(payload: Buffer | string, opcode = 0x1, mask?: Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | opcode;                  // FIN + opcode
  if (len < 126) out[1] = len;
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2); }
  let off = head;
  if (mask) {
    out[1] |= 0x80;
    mask.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = data[i] ^ mask[i & 3];
  } else {
    data.copy(out, off);
  }
  return out;
}

export interface Frame { fin: boolean; opcode: number; payload: Buffer; masked: boolean }

/**
 * Parse as many complete frames as `buf` holds. Returns the frames and the
 * number of bytes consumed (the caller keeps the remainder for next time).
 * Throws on protocol violations.
 */
export function decodeFrames(buf: Buffer): { frames: Frame[]; used: number } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    if (b0 & 0x70) throw new Error("RSV bits set (no extensions negotiated)");
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_FRAME)) throw new Error("frame too large");
      len = Number(big);
      p += 8;
    }
    if (len > MAX_FRAME) throw new Error("frame too large");
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const payload = Buffer.from(buf.subarray(p + maskLen, p + maskLen + len));
    if (masked) {
      const m = buf.subarray(p, p + 4);
      for (let i = 0; i < len; i++) payload[i] ^= m[i & 3];
    }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, masked });
    off = p + maskLen + len;
  }
  return { frames, used: off };
}

export interface WsConn {
  send(text: string): void;
  close(code?: number): void;
  onText: (text: string) => void;
  onClose: () => void;
  readonly open: boolean;
}

/** Complete the upgrade on an HTTP 'upgrade' event; returns a connection or null. */
export function upgrade(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  let rest = Buffer.alloc(0);
  let isOpen = true;
  const conn: WsConn = {
    send(text) { if (isOpen) socket.write(encodeFrame(text)); },
    close(code = 1000) {
      if (!isOpen) return;
      isOpen = false;
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code);
      socket.end(encodeFrame(b, 0x8));
    },
    onText: () => {},
    onClose: () => {},
    get open() { return isOpen; },
  };
  socket.on("data", (chunk: Buffer) => {
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let res;
    try { res = decodeFrames(rest); } catch { conn.close(1002); return; }
    rest = rest.subarray(res.used);
    for (const f of res.frames) {
      if (!f.masked) { conn.close(1002); return; }   // clients MUST mask (RFC 6455 5.1)
      if (!f.fin) { conn.close(1003); return; }      // fragmentation unsupported
      if (f.opcode === 0x1) conn.onText(f.payload.toString("utf8"));
      else if (f.opcode === 0x8) { conn.close(); }
      else if (f.opcode === 0x9) socket.write(encodeFrame(f.payload, 0xa));
    }
  });
  const done = () => { if (isOpen) { isOpen = false; } conn.onClose(); };
  socket.on("close", done);
  socket.on("error", () => socket.destroy());
  return conn;
}
