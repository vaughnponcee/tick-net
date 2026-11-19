/**
 * Headless experiment: one server, a "raw" client and a "predicted" client
 * driven by the same scripted input over the same simulated bad link, on a
 * virtual clock. Measures what the player actually sees.
 */
import { GameServer, botInput } from "./server.ts";
import { ClientCore, type Mode } from "./client.ts";
import { Link, type LinkConfig } from "./linksim.ts";
import { encode, decodeServer, type ClientMsg, type ServerMsg } from "./protocol.ts";
import { applyInput, DT, TICK_HZ, type PlayerState } from "./sim.ts";

export interface Report {
  mode: Mode;
  /** ms from pressing a key until the player's own avatar first moves on screen */
  inputLatencyMs: number;
  /** mean distance between where the player's avatar is drawn and where their
   *  own inputs say it should be (the "ideal" zero-latency path) */
  meanDriftPx: number;
  corrections: number;
  maxCorrectionPx: number;
  /** final drawn position vs. server authoritative after the link drains */
  finalErrorPx: number;
  remoteJitterPx: number;   // mean frame-to-frame acceleration of a remote bot (smoothness)
  snapshots: number;
  outOfOrder: number;
}

export function script(tick: number): { dx: number; dy: number } {
  // idle 0.5 s, then a square path with stops: exercises start/stop latency
  const t = tick / TICK_HZ;
  if (t < 0.5) return { dx: 0, dy: 0 };
  const phase = Math.floor((t - 0.5) / 0.8) % 5;
  return [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: -1 }][phase];
}

export function run(mode: Mode, link: LinkConfig, seconds = 12, seed = 7, bots = 2, reorderWait = 3): Report {
  const server = new GameServer(reorderWait);
  for (let b = 0; b < bots; b++) server.connect(true);
  const client = new ClientCore(mode, 100);
  const { id, hello } = server.connect();
  client.onMessage(hello, 0);
  const up = new Link<string>(link, seed);          // client -> server
  const down = new Link<string>(link, seed + 1000); // server -> client
  const ticks = seconds * TICK_HZ;
  const tickMs = 1000 / TICK_HZ;
  const frameMs = 1000 / 60;
  // ideal = where the avatar would be with zero latency
  let ideal: PlayerState | null = null;
  let firstMoveTick = -1, firstDrawMoveMs = -1;
  let drift = 0, driftN = 0;
  let lastRemote: PlayerState | null = null, prevVel: { x: number; y: number } | null = null;
  let jitter = 0, jitterN = 0;
  let start: PlayerState | null = null;
  let now = 0, nextTick = 0, tick = 0;
  const endMs = ticks * tickMs + 2000;               // let the link drain
  while (now <= endMs) {
    // network delivery
    for (const raw of up.receive(now)) server.receive(id, raw, now);
    for (const raw of down.receive(now)) client.onMessage(decodeServer(raw) as ServerMsg, now);
    // fixed ticks (client and server share the tick clock here)
    if (now >= nextTick) {
      nextTick += tickMs;
      tick++;
      if (tick <= ticks) {
        const s = script(tick);
        if (firstMoveTick < 0 && (s.dx || s.dy)) firstMoveTick = tick;
        const msg: ClientMsg = client.tickInput(s.dx, s.dy);
        up.send(now, encode(msg));
        if (ideal) ideal = applyInput(ideal, { seq: 0, ...s });
      }
      for (const o of server.step(botInput)) down.send(now, encode(o.msg));
    }
    // render frame
    const drawn = client.render(1);
    if (!ideal && client.lastSnapTick > 0) { ideal = { ...drawn }; start = { ...drawn }; }
    if (start && firstMoveTick > 0 && firstDrawMoveMs < 0 && Math.hypot(drawn.x - start.x, drawn.y - start.y) > 0.5) {
      firstDrawMoveMs = now - firstMoveTick * tickMs + tickMs;
    }
    if (ideal && tick <= ticks && firstMoveTick > 0) { drift += Math.hypot(drawn.x - ideal.x, drawn.y - ideal.y); driftN++; }
    const r = client.remotes(now).get(1);
    if (r && lastRemote) {
      const v = { x: r.x - lastRemote.x, y: r.y - lastRemote.y };
      if (prevVel) { jitter += Math.hypot(v.x - prevVel.x, v.y - prevVel.y); jitterN++; }
      prevVel = v;
    }
    if (r) lastRemote = r;
    now += frameMs;
  }
  const auth = server.state(id) as PlayerState;
  const fin = client.render(1);
  return {
    mode,
    inputLatencyMs: Math.round(firstDrawMoveMs),
    meanDriftPx: +(drift / Math.max(1, driftN)).toFixed(2),
    corrections: client.stats.corrections,
    maxCorrectionPx: +client.stats.maxCorrection.toFixed(2),
    finalErrorPx: +Math.hypot(fin.x - auth.x, fin.y - auth.y).toFixed(3),
    remoteJitterPx: +(jitter / Math.max(1, jitterN)).toFixed(3),
    snapshots: client.stats.snapshots,
    outOfOrder: client.stats.outOfOrder,
  };
}

/** Same as run() but with `remotes` interpolation turned off for comparison. */
export function runNoInterp(link: LinkConfig, seed = 7): Report {
  return run("raw", link, 12, seed);
}

export { DT };
