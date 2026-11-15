/**
 * The phone-push sender (schema v83): claims due deliveries (px_push_claim), sends each through the provider, records the
 * outcome (px_push_result), cancels repeating alarms the owner has acknowledged (px_push_cancel_due / px_push_cancelled)
 * and reports that it is alive and whether it holds provider credentials (px_push_heartbeat).
 *
 * Lock-screen rule: what is sent is built here from a severity word, the notification's code and a short id, plus a link
 * to the authenticated dashboard. The claim never returns a title, a detail, a customer or a document.
 */
import pg from "pg";
import type { PushMessage, PushProvider } from "./pushover.js";

export interface PushClaim {
  deliveryId: string;
  kind: "alert" | "test";
  priority: -1 | 0 | 1 | 2;
  provider: string;
  target: string | null;
  class: string | null;
  code: string | null;
  notificationId: string | null;
  attempt: number;
}

export class PgPushGateway {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, options: `-c search_path=${schema}` });
    this.pool.on("error", () => {});
  }
  private async one<T>(sql: string, args: unknown[]): Promise<T> { return (await this.pool.query(sql, args)).rows[0].r as T; }
  heartbeat(provider: string, configured: boolean) { return this.one<{ ok: boolean; schemaVersion?: number }>(`SELECT px_push_heartbeat($1, $2) AS r`, [provider, configured]); }
  claim(limit: number) { return this.one<PushClaim[]>(`SELECT px_push_claim($1) AS r`, [limit]); }
  result(id: string, ok: boolean, receipt: string | null, error: string | null, retryAfterS: number | null, permanent = false) {
    return this.one(`SELECT px_push_result($1, $2, $3, $4, $5, $6) AS r`, [id, ok, receipt, error, retryAfterS, permanent]);
  }
  cancelDue(limit: number) { return this.one<Array<{ deliveryId: string; receipt: string; provider: string }>>(`SELECT px_push_cancel_due($1) AS r`, [limit]); }
  cancelled(id: string, ok: boolean, error: string | null) { return this.one(`SELECT px_push_cancelled($1, $2, $3) AS r`, [id, ok, error]); }
  close() { return this.pool.end(); }
}

const SEVERITY: Record<number, string> = { 2: "URGENT", 1: "Alert", 0: "Notice", [-1]: "Info" };

/** The only text a phone shows. */
export function pushMessage(c: PushClaim, dashboardOrigin: string): PushMessage {
  const origin = dashboardOrigin.replace(/\/+$/, "");
  if (c.kind === "test") {
    return { priority: 0, title: "Automaton Fleet · test", message: "Test alert. Open Fleet HQ and press “I received it” to confirm this phone gets alerts.",
      url: `${origin}/?push-test=${c.deliveryId}`, urlTitle: "Open Fleet HQ", device: c.target };
  }
  const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(c.code ?? "") ? c.code! : "NOTIFICATION";
  const short = (c.notificationId ?? "").slice(0, 8);
  return { priority: c.priority, title: `Automaton Fleet · ${SEVERITY[c.priority] ?? "Notice"}`, message: `${code} (${short}). Sign in to see the details.`,
    url: `${origin}/?notification=${c.notificationId}`, urlTitle: "Open Fleet HQ", device: c.target };
}

export class PushSender {
  constructor(private readonly gw: PgPushGateway, private readonly provider: PushProvider | null, private readonly origin: string,
    private readonly log: (level: string, event: string, detail: Record<string, unknown>) => void = () => {}) {}

  /** One pass: heartbeat; without credentials nothing is claimed (deliveries wait and the dashboard says so). */
  async tick(): Promise<{ sent: number; failed: number; cancelled: number }> {
    await this.gw.heartbeat("pushover", this.provider !== null);
    if (!this.provider) return { sent: 0, failed: 0, cancelled: 0 };
    let sent = 0, failed = 0, cancelled = 0;
    for (const c of await this.gw.claim(20)) {
      const out = await this.provider.send(pushMessage(c, this.origin));
      if (out.ok) { sent++; await this.gw.result(c.deliveryId, true, out.receipt ?? null, null, null); }
      else {
        failed++;
        // A permanent refusal (bad token, user or device) is final at once; anything else backs off and retries.
        await this.gw.result(c.deliveryId, false, null, out.error ?? "refused", out.retryAfterS ?? null, !!out.permanent);
        this.log("warn", "push_send_failed", { deliveryId: c.deliveryId, attempt: c.attempt, permanent: !!out.permanent, error: out.error });
      }
    }
    for (const d of await this.gw.cancelDue(20)) {
      const out = await this.provider.cancel(d.receipt);
      await this.gw.cancelled(d.deliveryId, out.ok, out.ok ? null : out.error ?? "cancel refused");
      if (out.ok) cancelled++;
    }
    return { sent, failed, cancelled };
  }
}
