/** node bench/bench.ts : netcode comparison table + server tick cost */
import { run } from "../src/harness.ts";
import { PRESETS } from "../src/linksim.ts";
import { GameServer, botInput } from "../src/server.ts";
import { encode } from "../src/protocol.ts";

const seeds = [1, 2, 3, 4, 5];
console.log("link   one-way(ms)  loss  mode       input->screen  mean drift  corrections  max corr  remote jitter  final err");
for (const [name, cfg] of Object.entries(PRESETS)) {
  for (const mode of ["raw", "predicted"] as const) {
    const rs = seeds.map((s) => run(mode, cfg, 12, s));
    const avg = (f: (r: (typeof rs)[number]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(
      `${name.padEnd(6)} ${`${cfg.latencyMs}-${cfg.latencyMs + cfg.jitterMs}`.padStart(11)}  ${(cfg.loss * 100).toFixed(0).padStart(3)}%  ` +
      `${mode.padEnd(9)} ${avg((r) => r.inputLatencyMs).toFixed(0).padStart(9)} ms  ${avg((r) => r.meanDriftPx).toFixed(1).padStart(7)} px  ` +
      `${avg((r) => r.corrections).toFixed(1).padStart(11)}  ${Math.max(...rs.map((r) => r.maxCorrectionPx)).toFixed(1).padStart(6)} px  ` +
      `${avg((r) => r.remoteJitterPx).toFixed(2).padStart(10)} px  ${Math.max(...rs.map((r) => r.finalErrorPx)).toFixed(1).padStart(6)} px`);
  }
}

console.log("\nserver tick cost (all clients send one input per tick, snapshot fan-out included, JSON encode)");
for (const n of [10, 50, 200]) {
  const s = new GameServer();
  const ids = Array.from({ length: n }, () => s.connect().id);
  let seq = 0, bytes = 0;
  const ticks = 300;
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) {
    seq++;
    for (const id of ids) s.receive(id, encode({ t: "input", inputs: [{ seq, dx: 1, dy: 0 }] }));
    for (const o of s.step(botInput)) bytes += encode(o.msg).length;
  }
  const ms = (performance.now() - t0) / ticks;
  console.log(`${String(n).padStart(4)} clients: ${ms.toFixed(3)} ms/tick (${(ms / 33.3 * 100).toFixed(1)}% of a 30 Hz tick), ` +
    `${(bytes / ticks / n / 1024).toFixed(2)} KiB/client/tick down`);
}
console.log(`\nnode ${process.version}, ${process.platform} ${process.arch}`);
