/**
 * Real server: HTTP (serves web/ and dist/) + WebSocket game endpoint on one
 * port. Ticks at 30 Hz with a drift-free accumulator.
 *   node bin/server.ts [--port 8090] [--bots 3]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { GameServer, botInput } from "../src/server.ts";
import { upgrade, type WsConn } from "../src/ws.ts";
import { encode } from "../src/protocol.ts";
import { TICK_HZ } from "../src/sim.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const port = opt("port", Number(process.env.PORT) || 8090);
const root = process.cwd();
const game = new GameServer();
for (let b = 0; b < opt("bots", 3); b++) game.connect(true);
const conns = new Map<number, WsConn>();
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const rel = url.pathname === "/" ? "web/index.html" : url.pathname.slice(1);
  const path = normalize(join(root, rel));
  if (!path.startsWith(root) || !(rel.startsWith("web/") || rel.startsWith("dist/"))) {
    res.writeHead(404).end();
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(path);   // read first: headers must not be sent before we know it exists
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(body);
});

http.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  const ws = upgrade(req, socket);
  if (!ws) return;
  const { id, hello } = game.connect();
  conns.set(id, ws);
  ws.send(encode(hello));
  ws.onText = (text) => {
    const reply = game.receive(id, text, performance.now());
    if (reply) ws.send(encode(reply));
  };
  ws.onClose = () => { conns.delete(id); game.disconnect(id); };
});

let next = performance.now();
const tickMs = 1000 / TICK_HZ;
function loop() {
  const now = performance.now();
  while (now >= next) {
    for (const o of game.step(botInput)) conns.get(o.to)?.send(encode(o.msg));
    next += tickMs;
  }
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();
http.listen(port, "127.0.0.1", () => console.log(`tick-net server on http://127.0.0.1:${port}/  (ws: /ws, ${TICK_HZ} Hz)`));
