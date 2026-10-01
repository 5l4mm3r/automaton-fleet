/**
 * Fleet Hub static dashboard: renders the Hub views into one self-contained HTML file (no scripts, no external assets,
 * every value escaped). Written by `fleet:admin hub-render <file>` with mode 0600 — it is served by nobody; the owner
 * opens it locally. No new network listener exists for the Hub.
 */

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Minor units shown as money only where the key says so (…Minor); everything else as given. */
const cell = (k: string, v: unknown): string => {
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  if (typeof v === "number" && /Minor$/.test(k)) return `<span class="num">£${(v / 100).toFixed(2)}</span>`;
  if (typeof v === "number" && /Bp$/.test(k)) return `<span class="num">${(v / 100).toFixed(2)}%</span>`;
  if (typeof v === "object") return render(v, 2);
  return esc(v);
};

function render(v: unknown, depth = 0): string {
  if (depth > 4) return `<code>${esc(JSON.stringify(v).slice(0, 300))}</code>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '<span class="muted">none</span>';
    if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))].slice(0, 14);
      return `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${v.slice(0, 200).map((x) =>
        `<tr>${cols.map((c) => `<td>${cell(c, (x as Record<string, unknown>)[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    return v.map((x) => esc(typeof x === "object" ? JSON.stringify(x) : x)).join(", ");
  }
  if (v && typeof v === "object") {
    return `<dl>${Object.entries(v as Record<string, unknown>).map(([k, x]) => `<dt>${esc(k)}</dt><dd>${cell(k, x)}</dd>`).join("")}</dl>`;
  }
  return esc(v);
}

export function renderHub(sections: Record<string, unknown>, generatedAt = new Date()): string {
  const nav = Object.keys(sections).map((s) => `<a href="#${esc(s)}">${esc(s)}</a>`).join("");
  const body = Object.entries(sections).map(([s, v]) => `<section id="${esc(s)}"><h2>${esc(s)}</h2>${render(v)}</section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Hub</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#77756f;--line:#e2dfd7;--accent:#2f5d50}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#e9e7e1;--muted:#9a978f;--line:#2d2c29;--accent:#8cc5b2}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}nav a{color:var(--accent);text-decoration:none}
section{margin:0 0 28px;overflow-x:auto}h1{font-size:20px}h2{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:4px;text-transform:capitalize}
table{border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}dt{color:var(--muted)}dd{margin:0}
.num{font-variant-numeric:tabular-nums}.muted{color:var(--muted)}code{font-size:12px}
</style></head><body>
<h1>Fleet Hub</h1><p class="muted">Generated ${esc(generatedAt.toISOString())}. Observability and infrastructure administration — not a business approval queue. Real payments, owner sweeps and replication are disabled.</p>
<nav>${nav}</nav>
${body}
</body></html>
`;
}
