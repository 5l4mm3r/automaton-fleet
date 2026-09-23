/**
 * Child-process worker for the cross-process shared-registry cap test.
 * Simulates an independent agent process: its own PostgreSQL pool, a shared
 * start barrier, then one slot reservation. Prints the outcome as JSON.
 * The connection string arrives via env (never argv).
 */
import { PgFleetStore } from "../../../fleet/postgres/store.js";

const [schema, parentAgentId, startAtStr, repo, commit] = process.argv.slice(2);
const store = new PgFleetStore({ connectionString: process.env.FLEET_TEST_DATABASE_URL!, schema, poolMax: 1, connectTimeoutMs: 30_000 });
await store.getState(); // connect before the barrier so all processes contend at once
const startAt = Number(startAtStr);
while (Date.now() < startAt) {
  // busy-wait barrier
}
const res = await store.reserveSlot({
  parentAgentId,
  requestedBy: `proc-${process.pid}`,
  name: `worker-${process.pid}`,
  runtime: { repo, commit },
});
process.stdout.write(JSON.stringify({ ok: res.ok, code: res.ok ? null : res.code }));
await store.close();
