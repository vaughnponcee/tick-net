// Zero-dependency browser build: strip types with node:module and rewrite
// ".ts" import specifiers to ".js". Only browser-safe modules are emitted.
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const files = ["src/sim.ts", "src/protocol.ts", "src/linksim.ts", "src/client.ts", "web/app.ts"];
for (const f of files) {
  let js = stripTypeScriptTypes(readFileSync(f, "utf8"), { mode: "strip" });
  js = js.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  const out = join("dist", f.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js);
}
console.log(`built ${files.length} files into dist/`);
