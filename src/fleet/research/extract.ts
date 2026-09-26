/**
 * Readable-text extraction for founder web research. Pure string processing: nothing is executed, no
 * external entities are fetched, no DOM is built. Output is bounded and control-character free.
 */

import { RESEARCH_LIMITS } from "./policy.js";

export const TEXT_TYPES = new Set([
  "text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/csv", "application/json", "application/ld+json",
  "application/xml", "text/xml", "application/rss+xml", "application/atom+xml",
]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", euro: "€", pound: "£" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]/g, "");

function collapse(s: string): string {
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim();
}

export interface Extracted {
  title: string | null;
  text: string;
  truncated: boolean;
  links: Array<{ text: string; url: string }>;
}

export function extractHtml(html: string, baseUrl: string): Extracted {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1];
  // Non-content elements are removed with their contents (never executed, never returned).
  h = h.replace(/<(script|style|noscript|template|svg|math|iframe|object|embed|canvas|head|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ");
  h = h.replace(/<(script|style|noscript|template|iframe|object|embed)\b[^>]*\/?>/gi, " ");
  const links: Array<{ text: string; url: string }> = [];
  h = h.replace(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, d, s1, bare, inner) => {
    const text = collapse(decodeEntities(String(inner).replace(/<[^>]+>/g, " ")));
    if (links.length < 50) {
      try {
        const u = new URL(decodeEntities(d ?? s1 ?? bare ?? ""), baseUrl);
        if (u.protocol === "https:" && text) links.push({ text: text.slice(0, 120), url: u.href.slice(0, 500) });
      } catch {
        // relative junk ignored
      }
    }
    return ` ${inner} `;
  });
  h = h.replace(/<(br|hr)\b[^>]*>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption|form)>/gi, "\n")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n").replace(/<\/?(td|th)\b[^>]*>/gi, " | ").replace(/<[^>]*>/g, " ");
  const text = collapse(clean(decodeEntities(h)));
  return bound({ title: title ? collapse(clean(decodeEntities(title.replace(/<[^>]+>/g, " ")))).slice(0, 300) : null, text, truncated: false, links });
}

function bound(e: Extracted): Extracted {
  if (e.text.length <= RESEARCH_LIMITS.maxTextChars) return e;
  return { ...e, text: e.text.slice(0, RESEARCH_LIMITS.maxTextChars), truncated: true };
}

export function extractText(body: string, mediaType: string, baseUrl: string): Extracted {
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return extractHtml(body, baseUrl);
  if (mediaType === "application/json" || mediaType === "application/ld+json") {
    try {
      return bound({ title: null, text: clean(JSON.stringify(JSON.parse(body), null, 1)), truncated: false, links: [] });
    } catch {
      return bound({ title: null, text: clean(body), truncated: false, links: [] });
    }
  }
  if (mediaType.endsWith("xml")) {
    // Text content only; no DTD/entity expansion (entities are decoded literally, never resolved externally).
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const t = body.replace(/<!DOCTYPE[\s\S]*?>/gi, " ").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<\/(item|entry|title|description|summary)>/gi, "\n").replace(/<[^>]+>/g, " ");
    return bound({ title: title ? collapse(clean(decodeEntities(title))).slice(0, 300) : null, text: collapse(clean(decodeEntities(t))), truncated: false, links: [] });
  }
  return bound({ title: null, text: collapse(clean(body)), truncated: false, links: [] });
}
