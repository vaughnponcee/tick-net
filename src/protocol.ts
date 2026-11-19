/** Wire messages (JSON text frames). */
import type { Input } from "./sim.ts";

export interface Hello { t: "hello"; id: number; tick: number; tickHz: number }
export interface Snapshot {
  t: "snap";
  tick: number;            // server tick this state belongs to
  you: number;             // recipient's id: a lost "hello" must not strand the client
  ack: number;             // last input seq the server applied for *this* client
  players: { id: number; x: number; y: number }[];
}
export interface InputMsg {
  t: "input";
  // the newest input plus a few older unacked ones: one lost packet then
  // costs nothing because the next packet repeats it
  inputs: Input[];
}
export interface Ping { t: "ping"; c: number }
export interface Pong { t: "pong"; c: number; s: number }

export type ServerMsg = Hello | Snapshot | Pong;
export type ClientMsg = InputMsg | Ping;

const MAX_INPUTS_PER_MSG = 8;

export function encode(m: ServerMsg | ClientMsg): string {
  return JSON.stringify(m);
}

/** Validates shape; returns null for anything malformed (never throws on wire data). */
export function decodeClient(raw: string): ClientMsg | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (o.t === "ping" && typeof o.c === "number") return { t: "ping", c: o.c };
  if (o.t === "input" && Array.isArray(o.inputs) && o.inputs.length <= MAX_INPUTS_PER_MSG) {
    const inputs: Input[] = [];
    for (const i of o.inputs as Record<string, unknown>[]) {
      if (!i || !Number.isInteger(i.seq) || typeof i.dx !== "number" || typeof i.dy !== "number") return null;
      inputs.push({ seq: i.seq as number, dx: i.dx as number, dy: i.dy as number });
    }
    return { t: "input", inputs };
  }
  return null;
}

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.t === "string" ? (m as ServerMsg) : null;
  } catch {
    return null;
  }
}
