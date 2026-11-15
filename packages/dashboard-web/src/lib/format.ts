/** Ledger amounts are integer GBP minor units (pence); the UI shows pounds. */
export function money(minor: unknown): string {
  if (minor === null || minor === undefined || minor === "") return "—";
  const n = Number(minor);
  if (!Number.isFinite(n)) return "—";
  return (n < 0 ? "-£" : "£") + (Math.abs(n) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function when(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
export function duration(seconds: unknown): string {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} h ${m} min`;
}
