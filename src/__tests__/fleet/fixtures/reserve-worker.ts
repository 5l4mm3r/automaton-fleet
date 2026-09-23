/**
 * Child-process worker for the cross-process fleet cap test.
 * Opens its own SQLite connection, waits for a shared start barrier,
 * then attempts one slot reservation and prints the outcome as JSON.
 */
import Database from "better-sqlite3";
import { FleetRegistry } from "../../../fleet/registry.js";

const [dbPath, startAtStr] = process.argv.slice(2);
const db = new Database(dbPath);
const registry = new FleetRegistry(db);
const startAt = Number(startAtStr);
while (Date.now() < startAt) {
  // busy-wait barrier so all processes contend at the same instant
}
const res = registry.reserveSlot({ parentAgentId: null, requestedBy: `proc-${process.pid}`, name: "worker" });
process.stdout.write(JSON.stringify({ ok: res.ok, code: res.ok ? null : res.code }));
db.close();
