/**
 * FleetController side of founder web research (POST /v1/research/fetch, founder session):
 *
 *   1. input bounds (url ≤ 2048, purpose ≤ 300); the founder session is already verified;
 *   2. the founder must hold research.web (capability manifest) and be a founder;
 *   3. svc_research_authorize: owner switch, pause, lifecycle, per-founder and fleet quotas → an audited attempt
 *      (from here on the attempt COUNTS, whatever happens);
 *   4. the controller's own URL policy check (and a credential-shape check: a URL cannot carry a fleet
 *      credential out);
 *   5. the isolated fetcher (Unix socket) resolves, validates, pins, fetches, limits and extracts;
 *   6. svc_research_record appends the outcome;
 *   7. the result goes back to the founder as UNTRUSTED data with its provenance.
 * The controller itself never opens a connection to the requested site.
 */

import { containsSecretShape } from "../cognition/gateway.js";
import { RESEARCH_LIMITS, ResearchPolicyError, checkUrl, cleanPurpose } from "./policy.js";
import type { FetchResult } from "./fetcher.js";
import type { FetcherPort } from "./client.js";

export class ResearchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface ResearchPorts {
  capabilities(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  authorize(agentId: string, url: string, host: string, purpose: string): Promise<Record<string, unknown> & { ok: boolean }>;
  record(agentId: string, attemptId: string, r: ResearchRecord): Promise<Record<string, unknown> & { ok: boolean }>;
}

export interface ResearchRecord {
  outcome: "fetched" | "failed";
  failureCode: string | null;
  finalUrl: string | null;
  redirects: number;
  status: number | null;
  contentType: string | null;
  bytes: number;
  textChars: number;
  truncated: boolean;
  sha256: string | null;
  latencyMs: number;
}

export interface ResearchResponse {
  attemptId: string;
  untrusted: true;
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  fetchedAt: string;
  status: number;
  contentType: string;
  title: string | null;
  truncated: boolean;
  bytes: number;
  sha256: string;
  text: string;
  links: Array<{ text: string; url: string }>;
}

function failure(r: FetchResult & { ok: false }): ResearchRecord {
  return { outcome: "failed", failureCode: r.code, finalUrl: r.finalUrl, redirects: r.redirects.length, status: r.status, contentType: null, bytes: 0, textChars: 0, truncated: false, sha256: null, latencyMs: r.latencyMs };
}

export async function research(
  ports: ResearchPorts,
  fetcher: FetcherPort | null,
  agentId: string,
  token: string,
  body: Record<string, unknown>,
  opts: { fleetDomains?: string[] } = {},
): Promise<ResearchResponse> {
  const url = body.url;
  if (typeof url !== "string" || url.length === 0 || url.length > RESEARCH_LIMITS.maxUrlLength) throw new ResearchError(400, "FLEET_BAD_REQUEST", "url must be a string of at most 2048 characters");
  const purpose = cleanPurpose(body.purpose);
  if (!purpose) throw new ResearchError(400, "FLEET_BAD_REQUEST", "purpose is required");
  const caps = await ports.capabilities(agentId, token);
  if (!caps.ok) throw new ResearchError(401, String(caps.code ?? "FLEET_AUTH_FAILED"), "capabilities refused");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const auth = await ports.authorize(agentId, url, host, purpose);
  if (!auth.ok) {
    const code = String(auth.code);
    throw new ResearchError(/QUOTA/.test(code) ? 429 : 403, code, "research not authorized");
  }
  const attemptId = String(auth.attemptId);
  const refuse = async (code: string, detail: string, status = 422): Promise<never> => {
    await ports.record(agentId, attemptId, { outcome: "failed", failureCode: code, finalUrl: null, redirects: 0, status: null, contentType: null, bytes: 0, textChars: 0, truncated: false, sha256: null, latencyMs: 0 });
    throw new ResearchError(status, code, detail);
  };
  // The controller's own first check (the fetcher repeats it on every hop and address).
  try {
    checkUrl(url, opts.fleetDomains ?? []);
  } catch (err) {
    if (err instanceof ResearchPolicyError) return refuse(err.code, err.detail);
    throw err;
  }
  if (containsSecretShape(url)) return refuse("RESEARCH_SECRET_IN_URL", "the URL contains credential-shaped text");
  if (!fetcher) return refuse("RESEARCH_FETCHER_UNAVAILABLE", "no research fetcher is configured on this controller", 502);
  const r = await fetcher.fetch(url);
  if (!r.ok) {
    await ports.record(agentId, attemptId, failure(r));
    throw new ResearchError(r.code === "RESEARCH_FETCHER_UNAVAILABLE" || r.code === "RESEARCH_FETCHER_BUSY" ? 502 : 422, r.code, r.detail);
  }
  // Defence in depth: the fetcher's final URL must itself satisfy the policy.
  try {
    checkUrl(r.finalUrl, opts.fleetDomains ?? []);
  } catch {
    return refuse("RESEARCH_REDIRECT_INVALID", "the final URL does not satisfy the research policy");
  }
  const text = r.text.slice(0, RESEARCH_LIMITS.maxTextChars);
  await ports.record(agentId, attemptId, {
    outcome: "fetched", failureCode: null, finalUrl: r.finalUrl, redirects: r.redirects.length, status: r.status, contentType: r.contentType,
    bytes: r.bytes, textChars: text.length, truncated: r.truncated || text.length < r.text.length, sha256: r.sha256, latencyMs: r.latencyMs,
  });
  return {
    attemptId, untrusted: true, requestedUrl: r.requestedUrl, finalUrl: r.finalUrl, redirects: r.redirects, fetchedAt: r.fetchedAt,
    status: r.status, contentType: r.contentType, title: r.title, truncated: r.truncated || text.length < r.text.length, bytes: r.bytes,
    sha256: r.sha256, text, links: r.links.slice(0, 50),
  };
}
