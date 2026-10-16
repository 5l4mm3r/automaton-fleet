/**
 * Pushover adapter (schema v83 phone push). https://pushover.net/api — messages.json and receipts/{receipt}/cancel.json.
 * The adapter is given only lock-screen-safe text (a severity word, a notification code, a short id) and a link to the
 * authenticated dashboard; it never sees a notification's title or detail.
 */
export const PUSHOVER_API = "https://api.pushover.net/1";

export interface PushMessage {
  priority: -1 | 0 | 1 | 2;
  title: string;
  message: string;
  url: string;
  urlTitle: string;
  device: string | null;
}
export interface PushOutcome { ok: boolean; receipt?: string; retryAfterS?: number; permanent?: boolean; error?: string }
export interface PushProvider {
  readonly name: "pushover";
  send(m: PushMessage): Promise<PushOutcome>;
  cancel(receipt: string): Promise<PushOutcome>;
}
export type PushHttp = (url: string, body: URLSearchParams) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/**
 * An alarm (Pushover emergency priority) repeats every ALARM_RETRY_S until acknowledged on the phone or until ALARM_EXPIRE_S.
 * Pushover's limits: retry at least 30 s, expire at most 10800 s (3 h), and at most 50 repeats — 72 s × 50 = 1 hour, inside
 * all three. After that the phone stops ringing; the notification stays unresolved on the dashboard until acknowledged.
 */
export const ALARM_RETRY_S = 72;
export const ALARM_EXPIRE_S = 3600;
export const PUSHOVER_LIMITS = { minRetryS: 30, maxExpireS: 10800, maxRepeats: 50 } as const;

export class PushoverProvider implements PushProvider {
  readonly name = "pushover" as const;
  constructor(private readonly creds: { token: string; user: string }, private readonly http: PushHttp, private readonly base = PUSHOVER_API) {}

  private async post(path: string, body: URLSearchParams): Promise<PushOutcome & { json?: Record<string, unknown> }> {
    let r: Awaited<ReturnType<PushHttp>>;
    try {
      r = await this.http(`${this.base}${path}`, body);
    } catch (e) {
      return { ok: false, error: "network: " + String(e instanceof Error ? e.message : e).slice(0, 120) };
    }
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 200 && json.status === 1) return { ok: true, json };
    const errs = Array.isArray(json.errors) ? (json.errors as unknown[]).map(String).join("; ").slice(0, 160) : "";
    if (r.status === 429) return { ok: false, retryAfterS: Number(r.headers.get("Retry-After")) || 600, error: "rate limited" };
    // 4xx: the request itself is wrong (bad token, user or device) — retrying will not help.
    if (r.status >= 400 && r.status < 500) return { ok: false, permanent: true, error: `refused ${r.status}${errs ? ": " + errs : ""}` };
    return { ok: false, error: `provider ${r.status}${errs ? ": " + errs : ""}` };
  }

  async send(m: PushMessage): Promise<PushOutcome> {
    const b = new URLSearchParams({ token: this.creds.token, user: this.creds.user, title: m.title.slice(0, 250), message: m.message.slice(0, 1024),
      priority: String(m.priority), url: m.url, url_title: m.urlTitle.slice(0, 100) });
    if (m.device) b.set("device", m.device);
    if (m.priority === 2) { b.set("retry", String(ALARM_RETRY_S)); b.set("expire", String(ALARM_EXPIRE_S)); }
    const r = await this.post("/messages.json", b);
    if (!r.ok) return r;
    const receipt = typeof r.json?.receipt === "string" ? r.json.receipt : undefined;
    return { ok: true, receipt };
  }

  async cancel(receipt: string): Promise<PushOutcome> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(receipt)) return { ok: false, permanent: true, error: "bad receipt" };
    const r = await this.post(`/receipts/${receipt}/cancel.json`, new URLSearchParams({ token: this.creds.token }));
    return r.ok ? { ok: true } : r;
  }
}
