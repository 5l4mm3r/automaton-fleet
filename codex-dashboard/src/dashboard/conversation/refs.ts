/**
 * Reference codes with their titles (owner, 2026-10-18: "I need the reference codes to be titled so we know what the
 * reference code is referring to"). An agent writes "request 62cbe1b7"; the owner reads
 * "request “Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7)". Only codes that match a record in
 * this agent's own thread are titled; any other text is left exactly as written.
 */
export type RefTitles = Map<string, string>;

/** The 8-character prefix of every record id in the thread → its title (requests, card requests). */
export function refTitles(items: Array<Record<string, unknown>>): RefTitles {
  const out: RefTitles = new Map();
  for (const i of items) {
    const id = typeof i.requestId === "string" ? i.requestId.toLowerCase() : "";
    if (!/^[0-9a-f]{8}/.test(id)) continue;
    const title = i.itemType === "request" ? String(i.title ?? i.action ?? "").replace(/^Owner request:\s*/i, "")
      : i.itemType === "card_request" ? `card purchase at ${String(i.merchant ?? "a merchant")}${i.purpose ? ` — ${String(i.purpose)}` : ""}` : "";
    if (title.trim()) out.set(id.slice(0, 8), title.trim().replace(/^./, (c) => c.toUpperCase()));
  }
  return out;
}

/** The text with every known code (a full id or its 8-character prefix) followed by nothing but its title in quotes. */
export function withTitles(text: string, titles: RefTitles): string {
  if (!titles.size) return text;
  return text.replace(/\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b(?:…|\.\.\.)?/gi, (code, prefix: string) => {
    const title = titles.get(prefix.toLowerCase());
    return title ? `“${title}” (${prefix.toLowerCase()})` : code;
  });
}
