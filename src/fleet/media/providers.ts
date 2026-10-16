/**
 * Media providers for the agents' web_search and generate_image (schema v85). Each adapter is given only the job's request
 * (a query, or a prompt and size) and its own API key; it returns plain results. Candidates, not choices: the owner picks
 * the provider (docs/operations/media-providers.md); until then the gateway reports "not configured" and agents are told so.
 *
 *   search: Brave Search API (GET https://api.search.brave.com/res/v1/web/search, header X-Subscription-Token)
 *   image:  OpenAI Images API (POST https://api.openai.com/v1/images/generations, model gpt-image-1, b64_json)
 */
export const BRAVE_SEARCH_API = "https://api.search.brave.com/res/v1/web/search";
export const OPENAI_IMAGES_API = "https://api.openai.com/v1/images/generations";

export type MediaHttp = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }>;
export interface SearchResult { title: string; url: string; snippet: string; age: string | null }
export interface MediaOutcome<T> { ok: boolean; value?: T; error?: string; retryable?: boolean }

export interface SearchProvider { readonly name: string; search(q: { query: string; count: number }): Promise<MediaOutcome<SearchResult[]>> }
export interface ImageProvider { readonly name: string; generate(r: { prompt: string; size: string }): Promise<MediaOutcome<{ pngB64: string }>> }

const clean = (s: unknown, n: number) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  constructor(private readonly key: string, private readonly http: MediaHttp, private readonly base = BRAVE_SEARCH_API) {}
  async search(q: { query: string; count: number }): Promise<MediaOutcome<SearchResult[]>> {
    const url = `${this.base}?q=${encodeURIComponent(q.query)}&count=${Math.min(Math.max(q.count, 1), 10)}&safesearch=moderate`;
    let r: Awaited<ReturnType<MediaHttp>>;
    try { r = await this.http(url, { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": this.key } }); }
    catch (e) { return { ok: false, retryable: true, error: "network: " + String((e as Error).message ?? e).slice(0, 120) }; }
    if (r.status !== 200) return { ok: false, retryable: r.status === 429 || r.status >= 500, error: `provider ${r.status}` };
    const j = (await r.json().catch(() => ({}))) as { web?: { results?: Array<Record<string, unknown>> } };
    const results = (j.web?.results ?? []).filter((x) => typeof x.url === "string" && /^https?:\/\//.test(x.url as string)).slice(0, 10)
      .map((x) => ({ title: clean(x.title, 200), url: String(x.url).slice(0, 500), snippet: clean(x.description, 400), age: x.age ? clean(x.age, 40) : null }));
    return { ok: true, value: results };
  }
}

export class OpenAiImages implements ImageProvider {
  readonly name = "openai";
  constructor(private readonly key: string, private readonly http: MediaHttp, private readonly base = OPENAI_IMAGES_API, private readonly model = "gpt-image-1") {}
  async generate(req: { prompt: string; size: string }): Promise<MediaOutcome<{ pngB64: string }>> {
    let r: Awaited<ReturnType<MediaHttp>>;
    try {
      r = await this.http(this.base, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, prompt: req.prompt, size: req.size, n: 1 }) });
    } catch (e) { return { ok: false, retryable: true, error: "network: " + String((e as Error).message ?? e).slice(0, 120) }; }
    if (r.status !== 200) {
      const j = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
      return { ok: false, retryable: r.status === 429 || r.status >= 500, error: `provider ${r.status}${j.error?.code ? " " + clean(j.error.code, 60) : ""}` };
    }
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }> };
    const b64 = j.data?.[0]?.b64_json ?? "";
    if (!/^[A-Za-z0-9+/=]{100,}$/.test(b64) || !Buffer.from(b64.slice(0, 16), "base64").subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return { ok: false, error: "the provider did not return a PNG" };
    }
    return { ok: true, value: { pngB64: b64 } };
  }
}
