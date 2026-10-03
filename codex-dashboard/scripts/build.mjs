// Build the static export in one mode: `node scripts/build.mjs live` (the owner's production frontend: the Fleet gateway,
// real sign-in, no fictional data) or `node scripts/build.mjs simulation` (fictional data, no network). Portable (no
// shell env syntax), then records the artifact's digest.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "live" && mode !== "simulation") { console.error("usage: node scripts/build.mjs live|simulation"); process.exit(2); }
const env = { ...process.env, NEXT_PUBLIC_FLEET_MODE: mode, NEXT_TELEMETRY_DISABLED: "1" };
// Always from a clean cache: a warm .next from the other mode would mix the two builds' modules.
for (const d of [".next", "out"]) fs.rmSync(d, { recursive: true, force: true });
const r = spawnSync(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "build", "--webpack"], { stdio: "inherit", env });
if (r.status !== 0) process.exit(r.status ?? 1);
for (const f of ["index.html", path.join("login", "index.html")]) if (!fs.existsSync(path.join("out", f))) { console.error(`missing out/${f}`); process.exit(1); }
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk("out");
files.sort();
const h = createHash("sha256");
for (const f of files) h.update(`${path.relative("out", f).split(path.sep).join("/")}\0${createHash("sha256").update(fs.readFileSync(f)).digest("hex")}\n`);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const artifact = { name: pkg.name, version: pkg.version, mode, files: files.length, sha256: h.digest("hex") };
fs.writeFileSync(`artifact-${mode}.json`, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify(artifact));
