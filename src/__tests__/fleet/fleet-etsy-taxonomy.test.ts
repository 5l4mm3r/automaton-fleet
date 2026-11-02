/** v127 — the Etsy category search the agent's lookup returns (pure; no network). */
import { describe, it, expect } from "vitest";
import { searchTaxonomy, TAXONOMY_RESULTS } from "../../fleet/channels/clients.js";

const tree = [
  { id: 1, name: "Paper & Party Supplies", level: 1, children: [
    { id: 2, name: "Paper", level: 2, children: [{ id: 2078, name: "Calendars & Planners", children: [] }, { id: 2079, name: "Stationery", children: [] }] }] },
  { id: 3, name: "Books, Movies & Music", children: [{ id: 4, name: "Planners Guides", children: [] }] },
  { id: "bad", name: "Planners junk" }, { id: 9, name: 42 }, { id: -1, name: "Planners negative" },
];

describe("searchTaxonomy", () => {
  it("matches every word against the full path, case-insensitively, deepest first, with ids and paths", () => {
    expect(searchTaxonomy(tree, "PLANNERS")).toEqual([
      { id: 2078, path: "Paper & Party Supplies > Paper > Calendars & Planners", level: 3 },
      { id: 4, path: "Books, Movies & Music > Planners Guides", level: 2 },
    ]);
    expect(searchTaxonomy(tree, "paper calendars").map((n) => n.id)).toEqual([2078]);
    expect(searchTaxonomy(tree, "paper stationery").map((n) => n.id)).toEqual([2079]);
  });
  it("skips malformed nodes; an empty or one-letter query finds nothing; results are bounded", () => {
    expect(searchTaxonomy(tree, "junk")).toEqual([]);
    expect(searchTaxonomy(tree, "")).toEqual([]);
    expect(searchTaxonomy(tree, "a")).toEqual([]);
    const wide = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `Planner ${i}` }));
    expect(searchTaxonomy(wide, "planner")).toHaveLength(TAXONOMY_RESULTS);
    const deep: any = { id: 1, name: "n0", children: [] }; let cur = deep;
    for (let i = 1; i < 40; i++) { const nx = { id: i + 1, name: `n${i}`, children: [] }; cur.children.push(nx); cur = nx; }
    expect(searchTaxonomy([deep], "n0").length).toBeLessThanOrEqual(TAXONOMY_RESULTS);
    expect(Math.max(...searchTaxonomy([deep], "n0", 100).map((n) => n.level))).toBeLessThanOrEqual(13);
  });
});
