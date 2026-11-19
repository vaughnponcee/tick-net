import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { applyInput, ARENA, RADIUS, DT, SPEED, type PlayerState } from "../src/sim.ts";
import { decodeClient, encode } from "../src/protocol.ts";
import { Link, PRESETS } from "../src/linksim.ts";
import { GameServer, MAX_QUEUE, botInput } from "../src/server.ts";
import { ClientCore } from "../src/client.ts";
import { acceptKey, decodeFrames, encodeFrame, upgrade } from "../src/ws.ts";
import { run } from "../src/harness.ts";

test("sim: normalized diagonal, clamped to arena, garbage-safe", () => {
  const s = applyInput({ x: 400, y: 250 }, { seq: 1, dx: 1, dy: 1 });
  assert.ok(Math.abs(Math.hypot(s.x - 400, s.y - 250) - SPEED * DT) < 0.01);
  const edge = applyInput({ x: ARENA.w - RADIUS, y: 100 }, { seq: 1, dx: 1, dy: 0 });
  assert.equal(edge.x, ARENA.w - RADIUS);
  assert.deepEqual(applyInput({ x: 10 + RADIUS, y: 50 }, { seq: 1, dx: NaN, dy: Infinity }), { x: 10 + RADIUS, y: 50 });
  assert.deepEqual(applyInput({ x: 400, y: 250 }, { seq: 1, dx: 50, dy: 0 }), applyInput({ x: 400, y: 250 }, { seq: 1, dx: 1, dy: 0 }));
});

test("protocol: rejects malformed and oversized messages", () => {
  assert.equal(decodeClient("{not json"), null);
  assert.equal(decodeClient('{"t":"input","inputs":[{"seq":1.5,"dx":0,"dy":0}]}'), null);
  assert.equal(decodeClient(JSON.stringify({ t: "input", inputs: Array(9).fill({ seq: 1, dx: 0, dy: 0 }) })), null);
  assert.equal(decodeClient('{"t":"admin","cmd":"rm"}'), null);
  assert.deepEqual(decodeClient('{"t":"ping","c":5}'), { t: "ping", c: 5 });
});

test("link: latency bounds, loss rate, reordering, determinism", () => {
  const cfg = { latencyMs: 50, jitterMs: 250, loss: 0.1 };
  const l = new Link<number>(cfg, 3);
  for (let i = 0; i < 5000; i++) l.send(i, i);
  assert.equal(l.receive(49.99 + 0).length, 0);           // nothing before min latency
  const got = l.receive(1e9);
  assert.ok(Math.abs(l.dropped / 5000 - 0.1) < 0.015, `loss ${l.dropped / 5000}`);
  assert.equal(got.length + l.dropped, 5000);
  let inversions = 0;
  for (let i = 1; i < got.length; i++) if (got[i] < got[i - 1]) inversions++;
  assert.ok(inversions > 100, "jitter should reorder");
  const a = new Link<number>(cfg, 9), b = new Link<number>(cfg, 9);
  for (let i = 0; i < 100; i++) { a.send(i, i); b.send(i, i); }
  assert.deepEqual(a.receive(1e9), b.receive(1e9));
});

test("server: applies inputs in seq order, ignores duplicates, caps queue", () => {
  const s = new GameServer(0);
  const { id } = s.connect();
  const start = s.state(id) as PlayerState;
  s.receive(id, encode({ t: "input", inputs: [{ seq: 2, dx: 0, dy: 1 }, { seq: 1, dx: 1, dy: 0 }] }));
  s.receive(id, encode({ t: "input", inputs: [{ seq: 1, dx: 1, dy: 0 }] }));      // duplicate
  s.step();
  let expect = applyInput(applyInput(start, { seq: 1, dx: 1, dy: 0 }), { seq: 2, dx: 0, dy: 1 });
  assert.deepEqual(s.state(id), expect);
  assert.equal(s.lastAck(id), 2);
  assert.equal(s.stats.duplicateInputs, 1);
  for (let k = 0; k < 10; k++) {
    const inputs = Array.from({ length: 8 }, (_, j) => ({ seq: 3 + k * 8 + j, dx: 0, dy: 0 }));
    s.receive(id, encode({ t: "input", inputs }));
  }
  assert.ok(s.stats.queueOverflow > 0);
  assert.ok(s.stats.queueOverflow <= 80 - MAX_QUEUE);
  s.receive(id, "garbage");
  assert.equal(s.stats.malformed, 1);
  expect = s.state(id) as PlayerState;
});

test("server: reorder buffer waits for a missing input before skipping it", () => {
  const s = new GameServer(3);
  const { id } = s.connect();
  s.receive(id, encode({ t: "input", inputs: [{ seq: 1, dx: 1, dy: 0 }] }));
  s.step();
  s.receive(id, encode({ t: "input", inputs: [{ seq: 3, dx: 0, dy: 1 }] }));       // seq 2 late
  s.step();
  s.step();
  assert.equal(s.lastAck(id), 1, "should be waiting for seq 2");
  s.receive(id, encode({ t: "input", inputs: [{ seq: 2, dx: 1, dy: 0 }] }));
  s.step();
  assert.equal(s.lastAck(id), 3);
  assert.equal(s.stats.inputsSkipped, 0);
  s.receive(id, encode({ t: "input", inputs: [{ seq: 6, dx: 0, dy: 0 }] }));       // 4, 5 truly lost
  for (let i = 0; i < 5; i++) s.step();
  assert.equal(s.lastAck(id), 6);
  assert.equal(s.stats.inputsSkipped, 2);
});

test("client: reconciliation replays unacked inputs onto the authoritative state", () => {
  const c = new ClientCore("predicted");
  c.onMessage({ t: "hello", id: 1, tick: 0, tickHz: 30 }, 0);
  c.onMessage({ t: "snap", tick: 1, you: 1, ack: 0, players: [{ id: 1, x: 100, y: 100 }] }, 0);
  for (let i = 0; i < 5; i++) c.tickInput(1, 0);
  const predicted = { ...c.me };
  // server has applied 2 of the 5 inputs
  let auth = { x: 100, y: 100 };
  for (let i = 0; i < 2; i++) auth = applyInput(auth, { seq: i + 1, dx: 1, dy: 0 });
  c.onMessage({ t: "snap", tick: 3, you: 1, ack: 2, players: [{ id: 1, ...auth }] }, 50);
  assert.equal(c.pending.length, 3);
  assert.deepEqual(c.me, predicted);       // agrees: no visible correction
  assert.equal(c.stats.corrections, 0);
  // the server lost input 3 entirely (applied 4 & 5 on the old position)
  let lossy = auth;
  for (const seq of [4, 5]) lossy = applyInput(lossy, { seq, dx: 1, dy: 0 });
  c.onMessage({ t: "snap", tick: 6, you: 1, ack: 5, players: [{ id: 1, ...lossy }] }, 100);
  assert.deepEqual(c.me, lossy);           // snapped to the truth
  assert.equal(c.stats.corrections, 1);
});

test("client: stale snapshots are ignored, id recovered without hello", () => {
  const c = new ClientCore("predicted");
  c.onMessage({ t: "snap", tick: 5, you: 7, ack: 0, players: [{ id: 7, x: 10, y: 10 }] }, 0);
  assert.equal(c.id, 7);
  c.onMessage({ t: "snap", tick: 4, you: 7, ack: 0, players: [{ id: 7, x: 999, y: 999 }] }, 10);
  assert.equal(c.stats.outOfOrder, 1);
  assert.deepEqual(c.me, { x: 10, y: 10 });
});

test("client: remote interpolation renders between bracketing snapshots", () => {
  const c = new ClientCore("predicted", 100);
  c.onMessage({ t: "snap", tick: 1, you: 1, ack: 0, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 0, y: 0 }] }, 1000);
  c.onMessage({ t: "snap", tick: 2, you: 1, ack: 0, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 50 }] }, 1100);
  assert.deepEqual(c.remotes(1150).get(2), { x: 50, y: 25 });    // target 1050: halfway
  assert.deepEqual(c.remotes(1300).get(2), { x: 100, y: 50 });   // past the newest: hold, never extrapolate
  assert.equal(c.remotes(1150).has(1), false);                  // own player is not a remote
  const raw = new ClientCore("raw");
  raw.onMessage({ t: "snap", tick: 1, you: 1, ack: 0, players: [{ id: 2, x: 5, y: 5 }] }, 0);
  assert.deepEqual(raw.remotes(0).get(2), { x: 5, y: 5 });
});

test("harness: prediction removes input latency; final state always matches server", () => {
  for (const name of ["lan", "good", "bad", "awful"]) {
    const raw = run("raw", PRESETS[name], 8, 3);
    const pred = run("predicted", PRESETS[name], 8, 3);
    assert.equal(pred.inputLatencyMs, 0, name);
    assert.ok(raw.inputLatencyMs > PRESETS[name].latencyMs * 2 - 1, `${name} raw latency ${raw.inputLatencyMs}`);
    assert.equal(pred.finalErrorPx, 0, name);
    assert.ok(pred.meanDriftPx < raw.meanDriftPx, name);
    assert.ok(pred.remoteJitterPx < raw.remoteJitterPx, `${name}: interpolation should be smoother`);
  }
});

test("harness: reorder buffer eliminates corrections on the 50-300 ms / 5% loss link", () => {
  let without = 0, withBuf = 0;
  for (const seed of [1, 2, 3, 4]) {
    without += run("predicted", PRESETS.bad, 10, seed, 2, 0).corrections;
    withBuf += run("predicted", PRESETS.bad, 10, seed, 2, 3).corrections;
  }
  assert.ok(without > 4, `without buffer: ${without}`);
  assert.equal(withBuf, 0);
});

test("websocket: RFC 6455 accept key and framing (all length encodings, masking)", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");   // RFC 6455 section 1.3
  const mask = Buffer.from([1, 2, 3, 4]);
  for (const n of [0, 5, 125, 126, 65535, 65536, 70000]) {
    const text = "x".repeat(n);
    const f = encodeFrame(text, 0x1, mask);
    const half = decodeFrames(f.subarray(0, Math.floor(f.length / 2)));
    assert.equal(half.frames.length, n === 0 ? half.frames.length : 0);   // partial: wait for more
    const { frames, used } = decodeFrames(Buffer.concat([f, encodeFrame("tail", 0x1, mask)]));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].payload.toString(), text);
    assert.equal(frames[1].payload.toString(), "tail");
    assert.equal(used, f.length + 10);
  }
  assert.throws(() => decodeFrames(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])), /RSV/);
});

test("websocket: end-to-end over a real socket with Node's WebSocket client", async () => {
  const game = new GameServer();
  game.connect(true);
  const http = createServer();
  http.on("upgrade", (req, socket) => {
    const ws = upgrade(req, socket);
    if (!ws) return;
    const { id, hello } = game.connect();
    ws.send(encode(hello));
    ws.onText = (t) => { const r = game.receive(id, t, 1); if (r) ws.send(encode(r)); };
    setTimeout(() => { for (const o of game.step(botInput)) if (o.to === id) ws.send(encode(o.msg)); }, 30);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  const msgs: { t: string }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () => {
      ws.send(encode({ t: "ping", c: 42 }));
      ws.send(encode({ t: "input", inputs: [{ seq: 1, dx: 1, dy: 0 }] }));
    };
    ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); if (msgs.length >= 3) resolve(); };
  });
  ws.close();
  http.close();
  http.closeAllConnections();
  const types = msgs.map((m) => m.t).sort();
  assert.deepEqual(types, ["hello", "pong", "snap"]);
  const snap = msgs.find((m) => m.t === "snap") as unknown as { ack: number; players: unknown[] };
  assert.equal(snap.ack, 1);
  assert.equal(snap.players.length, 2);
});
