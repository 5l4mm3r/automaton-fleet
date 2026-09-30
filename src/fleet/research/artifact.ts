/**
 * Evidence artifact (schema v24): what FleetController keeps of a fetched page so an experiment that later cites it can be
 * judged for relevance independently of the founder. Built at research-fetch time from the extracted text (never the raw
 * page): Unicode-normalized, control characters removed, whitespace collapsed, credential-shaped material redacted, and
 * bounded to ARTIFACT_LIMITS.excerptChars. If anything credential-shaped survives, no artifact is kept (fail closed): a
 * page without an artifact can never be assessed relevant.
 */

import { containsSecretShape } from "../cognition/gateway.js";
import { redactLongText } from "../redact.js";

export const ARTIFACT_LIMITS = Object.freeze({
  excerptChars: 6_000,
  titleChars: 200,
  /** Text examined before the cut: a secret that starts inside the excerpt is redacted whole before cutting. */
  scanChars: 8_000,
});

/**
 * The registry's own secret shapes (fleet_secret_shaped, schema v24), mirrored: the artifact must pass the registry's
 * check, which is stricter in places than the canonical redaction (e.g. a redacted "scheme://[redacted:userinfo]@" still
 * looks like URL credentials to it). Anything matching is neutralized before storage.
 */
const REGISTRY_SECRET_SHAPES = /(f[as]1\.[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|0x[0-9a-fA-F]{64}|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@)/g;

const neutralize = (t: string, count: () => void) => t.replace(REGISTRY_SECRET_SHAPES, () => {
  count();
  return "[redacted]";
});

export interface EvidenceArtifact {
  sha256: string;
  host: string;
  title: string | null;
  excerpt: string;
  sourceChars: number;
  truncated: boolean;
  redactions: number;
}

export function normalizeEvidenceText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildEvidenceArtifact(page: { sha256: string; finalUrl: string; title: string | null; text: string }): EvidenceArtifact | null {
  let host: string;
  try {
    host = new URL(page.finalUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  let redactions = 0;
  const count = () => {
    redactions++;
  };
  const normalized = normalizeEvidenceText(page.text);
  const excerpt = neutralize(redactLongText(normalized.slice(0, ARTIFACT_LIMITS.scanChars), count), count).slice(0, ARTIFACT_LIMITS.excerptChars).trim();
  const title = page.title ? neutralize(redactLongText(normalizeEvidenceText(page.title).slice(0, ARTIFACT_LIMITS.titleChars * 2), count), count).slice(0, ARTIFACT_LIMITS.titleChars).trim() : "";
  const shaped = (t: string) => containsSecretShape(t) || new RegExp(REGISTRY_SECRET_SHAPES.source).test(t);
  if (!excerpt || shaped(excerpt) || shaped(title)) return null;
  return { sha256: page.sha256, host, title: title || null, excerpt, sourceChars: page.text.length, truncated: normalized.length > excerpt.length, redactions };
}
