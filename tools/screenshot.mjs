// Dev tool: open a page in a headless Chromium (Edge/Chrome) over the DevTools
// protocol, wait in REAL time, print an expression's value, save a screenshot.
//   node tools/screenshot.mjs <url> <out.png> [waitMs] [jsExpr]
// Zero dependencies: Node's built-in fetch + WebSocket.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, wait = "6000", expr = "document.title"] = process.argv.slice(2);
const candidates = [
  process.env.CHROME,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error("no Chromium-based browser found; set CHROME=/path/to/chrome");
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "shot-"));
const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--window-size=1700,700", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });

await send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 700, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(Number(wait));
const val = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(JSON.stringify(val.result?.result?.value ?? val.result));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`saved ${out}`);
ws.close();
proc.kill();
