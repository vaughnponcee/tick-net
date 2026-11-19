/**
 * In-page server for static hosting (GitHub Pages has no WebSocket server).
 * Runs the same GameServer as bin/server.ts on a 30 Hz timer and hands out
 * socket-like objects, so app.ts works unchanged. The lossy link is still
 * applied by the client panels on top of this.
 */
import { GameServer, botInput } from "../src/server.ts";
import { encode } from "../src/protocol.ts";
import { TICK_HZ } from "../src/sim.ts";

export interface SocketLike { readonly readyState: number; send(text: string): void; onmessage: ((ev: { data: string }) => void) | null }

let game: GameServer | null = null;
const conns = new Map<number, SocketLike>();

function start() {
  game = new GameServer();
  for (let b = 0; b < 3; b++) game.connect(true);
  let next = performance.now();
  const tickMs = 1000 / TICK_HZ;
  const loop = () => {
    const now = performance.now();
    while (now >= next) {
      for (const o of game!.step(botInput)) conns.get(o.to)?.onmessage?.({ data: encode(o.msg) });
      next += tickMs;
    }
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();
}

export function connectLocal(): SocketLike {
  if (!game) start();
  const { id, hello } = game!.connect();
  const sock: SocketLike = {
    readyState: 1, // OPEN, like a connected WebSocket
    onmessage: null,
    send: (text) => {
      const reply = game!.receive(id, text, performance.now());
      if (reply) queueMicrotask(() => sock.onmessage?.({ data: encode(reply) }));
    },
  };
  conns.set(id, sock);
  // deliver the hello after the caller has attached onmessage
  setTimeout(() => sock.onmessage?.({ data: encode(hello) }), 0);
  return sock;
}
