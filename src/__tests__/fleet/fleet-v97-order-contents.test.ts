/**
 * Schema v97 — what is inside a download, as the order page shows it before payment (read from the file itself, bounded),
 * and PayPal sending a buyer who cancels back to their own order page.
 */
import { describe, it, expect } from "vitest";
import { readContents, formatName } from "../../fleet/storefront/contents.js";
import { returnUrlFor } from "../../fleet/custody/paypal-treasury.js";
import { zip, trackerZip, README, PROPERTIES_CSV, RENT_CSV } from "./fixtures/tracker-zip.js";

describe("v97: a download's contents, read from the file", () => {
  it("a ZIP lists its members; CSVs show their columns and row count (quoted formulas parsed); text shows its first lines", () => {
    const c = readContents("tracker.zip", trackerZip())!;
    expect(c.format).toBe("ZIP archive");
    expect(c.members.map((m) => [m.name, m.kind, m.sizeBytes])).toEqual([["README.txt", "text", Buffer.byteLength(README)],
      ["properties.csv", "table", Buffer.byteLength(PROPERTIES_CSV)], ["rent_log.csv", "table", Buffer.byteLength(RENT_CSV)]]);
    const props = c.members[1] as Extract<typeof c.members[number], { kind: "table" }>;
    expect(props.columns).toHaveLength(14);
    expect(props.columns.slice(0, 3)).toEqual(["Property", "Tenant", "Tenancy start"]);
    expect(props.columns.at(-1)).toBe("EPC status");
    expect(props.rows).toBe(1);
    expect((c.members[2] as any).columns).toHaveLength(8);   // the deflated member is read too
    expect((c.members[0] as any).lines[0]).toBe("UK Landlord Compliance Tracker (England)");
    // Nothing of the rows themselves is shown — only the headings.
    expect(JSON.stringify(c)).not.toContain("12 Example St");
  });

  it("bounded: an over-cap or lying member is listed, never inflated; a broken ZIP or an unknown format shows nothing", () => {
    const bomb = Buffer.alloc(5_000_000, 0x41);   // 5 MB of one byte deflates to a few kB
    const c = readContents("x.zip", zip([{ name: "big.csv", data: bomb, deflate: true }, { name: "lies.csv", data: bomb, deflate: true, claim: 100 }]))!;
    expect(c.members).toEqual([{ kind: "file", name: "big.csv", sizeBytes: 5_000_000 }, { kind: "file", name: "lies.csv", sizeBytes: 100 }]);
    expect(readContents("x.zip", Buffer.from("not a zip at all"))).toBeNull();
    expect(readContents("x.zip", trackerZip().subarray(0, 120))).toBeNull();
    expect(readContents("guide.pdf", Buffer.from("%PDF-1.4"))).toBeNull();
    const many = readContents("m.zip", zip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.from("x") }))))!;
    expect(many.members).toHaveLength(50);
    expect(many.truncated).toBe(true);
    expect(formatName("a.xlsx")).toBe("Excel workbook (.xlsx)");
  });

  it("PayPal sends a buyer who cancels back to their own order page (same origin as the configured page); without one, the static page", () => {
    const t = "ab".repeat(32);
    expect(returnUrlFor("https://api.agentfleet.vip/v1/paypal/cancel", t)).toBe(`https://api.agentfleet.vip/order/${t}`);
    expect(returnUrlFor("https://api.agentfleet.vip/v1/paypal/cancel", null)).toBe("https://api.agentfleet.vip/v1/paypal/cancel");
    expect(returnUrlFor("https://api.agentfleet.vip/v1/paypal/cancel", "../../evil")).toBe("https://api.agentfleet.vip/v1/paypal/cancel");
  });
});
