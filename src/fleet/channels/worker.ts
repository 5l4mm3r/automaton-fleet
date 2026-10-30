/**
 * The channel gateway's work loop (schema v80). Each pass:
 *  1. account check of every connection (at start, then every few hours; a failed one hourly): the owner-authorised token
 *     must reach exactly the registered provider account (Etsy: user and shop; Pinterest: a BUSINESS account of that
 *     username) with exactly the required scopes — otherwise the connection is failed and NO job runs for it;
 *  2. agents' API jobs on active connections (claimed under a lease; their file read for that job only);
 *  3. Etsy evidence polls: receipts → sale memos; payout ledger entries → payout claims on the owner's evidence chain;
 *  4. IndexNow notifications of the Fleet's own new / changed offer pages (sales open only; the controller has no egress).
 * Money never moves here; tokens never leave this process.
 */
import crypto from "crypto";
import { ChannelApiError, EtsyClient, PinterestClient, freshToken, type ChannelHttp, type TokenStore } from "./clients.js";
import { PROVIDER_SCOPES } from "../postgres/migrations-phase80.js";
import type { ChannelConnection, ChannelGatewayPort, ChannelJob } from "./gateway.js";
import { IndexNowPinger } from "../service/indexnow.js";

export interface ChannelWorkerOptions {
  worker?: string;
  checkEveryMs?: number;
  pollEveryMs?: number;
  now?: () => number;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

const codeOf = (err: unknown) => (err instanceof ChannelApiError ? err.code.split(":")[0] : /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_CHANNEL_API_ERROR");

export class ChannelWorker {
  private readonly worker: string;
  private readonly checkedAt = new Map<string, number>();
  private readonly polledAt = new Map<string, number>();
  private readonly indexNow: IndexNowPinger;

  constructor(private readonly gw: ChannelGatewayPort, private readonly store_: TokenStore, private readonly http: ChannelHttp, private readonly o: ChannelWorkerOptions = {}) {
    this.worker = o.worker ?? "channel-gateway";
    if (!/^[a-z0-9-]{3,40}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9-]{3,40}$");
    this.indexNow = new IndexNowPinger({ due: (n) => this.gw.indexNowDue(this.worker, n), done: (o, st) => this.gw.indexNowDone(this.worker, o, st) },
      async (url, init) => ({ status: (await this.http(url, init)).status }), { now: () => this.now() });
  }
  private now() { return (this.o.now ?? Date.now)(); }
  private log(level: string, event: string, detail?: Record<string, unknown>) { this.o.log?.(level, event, detail); }

  /** Exactly the registered account, exactly the required scopes — or the connection is failed (nothing runs for it). */
  async check(c: ChannelConnection): Promise<boolean> {
    let account: string | null = null;
    let scopes: string[] = [];
    let error: string | null = null;
    try {
      const t = await freshToken(this.http, this.store_, c.vaultRef, this.now());
      if (c.provider === "etsy") {
        const e = new EtsyClient(this.http, t);
        const w = await e.whoami();
        account = w.account;
        scopes = await e.scopes();
        if (w.shopId !== (c.shopId ?? null)) error = "the token reaches a different Etsy shop";
      } else {
        const p = new PinterestClient(this.http, t);
        const w = await p.whoami();
        account = w.account;
        scopes = [...t.scopes].sort();
        if (!w.business) error = "Pinterest requires a business account for commercial use";
      }
    } catch (err) {
      error = codeOf(err);
    }
    const r = await this.gw.connectionCheck(this.worker, c.connectionId, account, scopes, error);
    this.checkedAt.set(c.connectionId, this.now());
    return r.ok === true && r.active === true;
  }

  private async run(job: ChannelJob, lease: string): Promise<void> {
    const conns = await this.gw.connections(this.worker);
    const c = conns.find((x) => x.connectionId === job.connectionId);
    if (!c || c.status !== "active") { await this.gw.report(job.jobId, lease, false, null, null, null, "FLEET_CHANNEL_API_NOT_CONNECTED"); return; }
    try {
      const t = await freshToken(this.http, this.store_, c.vaultRef, this.now());
      const p = job.payload;
      const blob = job.hasBlob ? await this.gw.blob(job.jobId, lease) : null;
      if (job.provider === "etsy") {
        const e = new EtsyClient(this.http, t);
        const shop = String(c.shopId);
        const listing = String(p.listingId ?? "");
        switch (job.op) {
          case "etsy.listing.create": {
            const r = await e.createDraft(shop, p);
            await this.gw.report(job.jobId, lease, true, { listingId: r.listingId, state: "draft" }, r.listingId, r.url, null);
            return;
          }
          case "etsy.listing.update": {
            const f: Record<string, string> = {};
            if (typeof p.title === "string") f.title = p.title;
            if (typeof p.description === "string") f.description = p.description;
            if (typeof p.priceMinor === "number") f.price = (p.priceMinor / 100).toFixed(2);
            const r = await e.update(shop, listing, f);
            await this.gw.report(job.jobId, lease, true, { listingId: listing, state: r.state }, listing, r.url, null);
            return;
          }
          case "etsy.listing.image": case "etsy.listing.file": {
            if (!blob) throw new ChannelApiError("FLEET_CHANNEL_API_NO_FILE");
            const id = job.op === "etsy.listing.image" ? await e.image(shop, listing, String(job.blobName), String(job.blobType), blob)
              : await e.file(shop, listing, String(job.blobName), String(job.blobType), blob);
            await this.gw.report(job.jobId, lease, true, { listingId: listing, uploaded: id }, listing, null, null);
            return;
          }
          case "etsy.listing.activate": case "etsy.listing.deactivate": {
            const r = await e.update(shop, listing, { state: job.op === "etsy.listing.activate" ? "active" : "inactive" });
            await this.gw.report(job.jobId, lease, true, { listingId: listing, state: r.state }, listing, r.url, null);
            return;
          }
        }
      } else {
        const pi = new PinterestClient(this.http, t);
        if (job.op === "pinterest.board.create") {
          const id = await pi.board(String(p.name), String(p.description ?? ""));
          await this.gw.report(job.jobId, lease, true, { boardId: id }, id, null, null);
          return;
        }
        if (job.op === "pinterest.pin.create") {
          if (!blob) throw new ChannelApiError("FLEET_CHANNEL_API_NO_FILE");
          const r = await pi.pin(p, String(job.blobType), blob);
          await this.gw.report(job.jobId, lease, true, { pinId: r.id }, r.id, r.url, null);
          return;
        }
      }
      throw new ChannelApiError("FLEET_CHANNEL_API_OP");
    } catch (err) {
      // An unauthorised token fails the connection at its next check; the job reports the provider's code (never a body).
      if (err instanceof ChannelApiError && err.status === 401) this.checkedAt.delete(job.connectionId);
      await this.gw.report(job.jobId, lease, false, null, null, null, codeOf(err));
      this.log("warn", "channel_job_failed", { jobId: job.jobId, op: job.op, code: codeOf(err) });
    }
  }

  /**
   * One record, on its own: a record the database refuses (or throws on) is kept with its reason and retried by itself, so one bad record neither
   * stops the later ones nor is lost when the cursor moves on. Only a failure to keep it (the database itself is away) stops the pass, and the cursor with it.
   */
  private async storeRecord(c: ChannelConnection, kind: "sale" | "payout", raw: Record<string, unknown>): Promise<void> {
    // PostgreSQL cannot hold NUL or a lone surrogate in text or JSON; provider and buyer text can contain them.
    const record = JSON.parse(JSON.stringify(raw), (_k, v) => (typeof v === "string" ? v.replace(/\0/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") : v)) as Record<string, unknown>;
    const ref = typeof record.ref === "string" && /^[A-Za-z0-9:_-]{1,120}$/.test(record.ref) ? record.ref : `sha:${crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex").slice(0, 40)}`;
    let code: string, reason: string;
    try {
      const r = await (kind === "sale" ? this.gw.saleRecord(this.worker, c.connectionId, record) : this.gw.payoutRecord(this.worker, c.connectionId, record));
      if (r.ok) return;
      code = String(r.code ?? "FLEET_REJECTED"); reason = String(r.reason ?? r.code ?? "refused");
    } catch (err) {
      // The database being away, or a transient conflict, is not this record's fault: stop the pass, keep the cursor, read it all again.
      const sqlState = String((err as { code?: unknown }).code ?? "");
      reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      if (/^(08|53|57P|40)/.test(sqlState) || /^E[A-Z]+$/.test(sqlState) || /Connection terminated|timeout exceeded when trying to connect/i.test(reason)) throw err;
      code = /FLEET_[A-Z_]+/.exec(reason)?.[0] ?? (sqlState ? `SQL_${sqlState}` : "FLEET_RECORD_ERROR");
    }
    this.log("warn", "channel_record_rejected", { connectionId: c.connectionId, kind, record: ref, code });
    try {
      await this.gw.recordFailure(this.worker, c.connectionId, kind, ref, record, code, reason);
    } catch (err) {
      // A payload the table cannot hold must not hide the failure or stop the later records.
      const sqlState = String((err as { code?: unknown }).code ?? "");
      if (/^(08|53|57P|40)/.test(sqlState) || /^E[A-Z]+$/.test(sqlState)) throw err;
      await this.gw.recordFailure(this.worker, c.connectionId, kind, ref, { ref, unstorable: true }, code, reason);
    }
  }

  /** Etsy: receipts become sale memos; payout ledger entries become payout claims (bank route; the owner's evidence chain). */
  async poll(c: ChannelConnection): Promise<void> {
    if (c.provider !== "etsy" || c.status !== "active") return;
    for (const f of await this.gw.recordFailuresDue(this.worker, c.connectionId, 50)) await this.storeRecord(c, f.kind, f.payload);
    const t = await freshToken(this.http, this.store_, c.vaultRef, this.now());
    const e = new EtsyClient(this.http, t);
    const nowS = Math.floor(this.now() / 1000);
    for (const kind of ["receipts", "ledger"] as const) {
      // A failed read of one kind leaves its cursor where it was and does not stop the other.
      try {
        const since = Number(await this.gw.cursor(this.worker, c.connectionId, kind)) || nowS - 30 * 86_400;
        if (kind === "receipts") for (const s of await e.receipts(String(c.shopId), since - 2 * 86_400)) await this.storeRecord(c, "sale", s);
        else for (const p of await e.payouts(String(c.shopId), since - 2 * 86_400, nowS)) await this.storeRecord(c, "payout", p);
        await this.gw.cursorSet(this.worker, c.connectionId, kind, String(nowS));
      } catch (err) {
        this.log("warn", "channel_poll_failed", { connectionId: c.connectionId, kind, code: codeOf(err) });
      }
    }
  }

  async tick(maxJobs = 5): Promise<{ checked: number; jobs: number; polled: number }> {
    let checked = 0, jobs = 0, polled = 0;
    for (const c of await this.gw.connections(this.worker)) {
      const last = this.checkedAt.get(c.connectionId);
      const due = c.status === "pending_check" || last === undefined || this.now() - last > (c.status === "failed" ? 3_600_000 : this.o.checkEveryMs ?? 4 * 3_600_000);
      if (due) { await this.check(c); checked++; }
    }
    for (let i = 0; i < maxJobs; i++) {
      const lease = crypto.randomBytes(32).toString("base64url");
      const r = await this.gw.claim(this.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!r.ok || !r.job) break;
      await this.run(r.job, lease);
      jobs++;
    }
    for (const c of await this.gw.connections(this.worker)) {
      if (c.provider !== "etsy" || c.status !== "active" || this.now() - (this.polledAt.get(c.connectionId) ?? 0) < (this.o.pollEveryMs ?? 30 * 60_000)) continue;
      await this.poll(c).catch((err) => this.log("warn", "channel_poll_failed", { connectionId: c.connectionId, code: codeOf(err) }));
      this.polledAt.set(c.connectionId, this.now());
      polled++;
    }
    await this.indexNow.tick().catch((err) => this.log("warn", "indexnow_failed", { code: codeOf(err) }));
    return { checked, jobs, polled };
  }
}

export { PROVIDER_SCOPES };
