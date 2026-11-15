/**
 * UI 0.20.1 — the guided Launch & channels page's plain-English model (codex-dashboard/src/dashboard/launch/model.ts), unit
 * level: the readiness checklist (production's state: no seller, both agents paused → business details first; platforms are
 * never blockers), the seller checks and the conditional company fields, the permission builder (each action, its problems),
 * the scope described back in words with its consequences, and every connection-check failure explained with a recovery.
 * Backend parity (the preview is the backend's notice; built scopes are accepted) is in fleet-v81-launch-dashboard-pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import { PLATFORMS, buildScope, consequencesOf, defaultVaultRef, describeScope, emptyPermission, emptySeller, explainCheck, noticePreview, originsOf,
  providerOf, readiness, receivingState, recipientsOf, routes, rulesMissing, UNTRACKED, sellerFields, sellerProblems, type LaunchAgent } from "../../../codex-dashboard/src/dashboard/launch/model";

const A1: LaunchAgent = { id: "A1", name: "founder-1", status: "active", paused: true, pausedSince: "2026-10-10T12:37:00Z" };
const A2: LaunchAgent = { id: "A2", name: "agent-2", status: "active", paused: true, pausedSince: "2026-10-10T12:37:00Z" };
const DEPS = ["Etsy buyer messages: …", "Etsy payouts: …"];
const production = { seller: { ok: true, seller: null, storefronts: [] }, publicSite: { url: null, salesOpen: false }, releases: [], channels: [], dependencies: DEPS, discovery: { pingedTotal: 0 } };
const etsyChannel = (agentId: string, connection: Record<string, unknown> | null = null) =>
  ({ agentId, channelId: `c-${agentId}`, ventureKey: "ledgers", name: "Etsy", kind: "marketplace", status: "active", url: "https://www.etsy.com/shop/x", rulesRecorded: true, connection, liveItems: 0 });
const pinChannel = (agentId: string) => ({ ...etsyChannel(agentId, { provider: "pinterest", status: "active" }), channelId: `p-${agentId}`, name: "Pins", url: null });

const rail = (mode: string, verified: boolean, extra: Record<string, unknown> = {}) =>
  ({ rails: [{ railId: "r1", label: "Treasury", mode, status: "active", capabilities: ["receive_payments"], readiness: { capabilitiesReady: verified ? ["receive_payments"] : [] }, ...extra }] });
const READY = receivingState(rail("live", true));

describe("PayPal receiving (the backend's publish condition; unknown and sandbox never ready)", () => {
  it("ready only for an active live rail with receiving verified", () => {
    expect(READY.state).toBe("ready");
    expect(receivingState(rail("sandbox", true)).state).toBe("test_only");
    expect(receivingState(rail("live", false)).state).toBe("not_ready");
    expect(receivingState(rail("live", true, { status: "pending_setup" })).state).toBe("not_ready");
    expect(receivingState(rail("live", true, { capabilities: ["payouts"] })).state).toBe("not_ready");
    expect(receivingState({ rails: [] }).state).toBe("not_ready");
    expect(receivingState(null)).toMatchObject({ state: "unknown", detail: expect.stringMatching(/Not counted as ready/) });
    expect(receivingState(null, "The Fleet is unreachable.")).toMatchObject({ state: "unknown", detail: expect.stringMatching(/could not be read/) });
  });
  it("an unknown or test-only PayPal never makes a route ready", () => {
    for (const r of [receivingState(null), receivingState(rail("sandbox", true))]) {
      const own = routes(production, r).find((x) => x.key === "own_pages")!;
      expect(own.status).not.toBe("ready");
    }
  });
});

describe("routes: optional platforms block nothing; a failed connection blocks only its own route", () => {
  it("unused platforms are not in use and block nothing", () => {
    const rs = routes(production, READY);
    expect(rs.map((r) => [r.key, r.status])).toEqual([["own_pages", "ready"], ["etsy", "not_in_use"], ["pinterest", "not_in_use"]]);
  });
  it("a failed Etsy connection blocks the Etsy route only; own pages stay ready; Etsy never needs PayPal", () => {
    const d = { ...production, channels: [etsyChannel("A1", { provider: "etsy", status: "failed", checkError: "the token reaches a different Etsy shop" })] };
    const rs = routes(d, READY);
    expect(rs.find((r) => r.key === "etsy")).toMatchObject({ inUse: true, status: "blocked", detail: expect.stringMatching(/different shop.*Only this route waits/) });
    expect(rs.find((r) => r.key === "own_pages")?.status).toBe("ready");
    expect(rs.find((r) => r.key === "etsy")?.requirement).toMatch(/PayPal is not used/);
    // With PayPal not ready, an active Etsy connection is still a ready route of its own.
    const etsyOk = routes({ ...production, channels: [etsyChannel("A1", { provider: "etsy", status: "active" })] }, receivingState({ rails: [] }));
    expect(etsyOk.map((r) => [r.key, r.status])).toEqual([["own_pages", "blocked"], ["etsy", "ready"], ["pinterest", "not_in_use"]]);
  });
});

describe("readiness", () => {
  it("production today: business details first; preparation waits for the owner's resume; platforms are not blockers", () => {
    const r = readiness(production, [A1, A2], READY);
    expect(r.next).toEqual({ text: "Enter your business details", go: "business" });
    expect(r.prepare.find((c) => c.label === "At least one agent running")).toMatchObject({ done: false, blocker: true, detail: expect.stringMatching(/0 of 2 running \(paused by you\)/) });
    expect(r.prepare.find((c) => c.label === "Business details saved")).toMatchObject({ blocker: false });
    expect(r.proof.filter((c) => c.blocker && !c.done).map((c) => c.label)).toEqual(["Business details saved", "Fleet public address recorded", "At least one agent running"]);
    expect(r.proof.find((c) => c.label === "At least one sales route ready")).toMatchObject({ done: true });
    expect(r.proof.find((c) => c.label.startsWith("Proof permission"))).toMatchObject({ blocker: false });
    expect(r.launch.map((c) => [c.label, c.done, c.untracked === true])).toEqual([["Live proofs completed and reviewed with the operator", false, true], ["Final activation (opens sales)", false, false]]);
    expect(r.complete).toBe(1); // the own-pages route (live PayPal receiving verified)
    expect(r.needsInput).toBe(4); // agent running, seller, address, activation (the untracked proof is never counted)
    // Unknown PayPal: no route ready, so the route check is not done (never shown ready).
    expect(readiness(production, [A1, A2], receivingState(null)).proof.find((c) => c.label === "At least one sales route ready")).toMatchObject({ done: false, blocker: true });
  });
  it("a partial save (details saved, address not recorded) says so and points to the retry", () => {
    const r = readiness({ ...production, seller: { seller: { legalName: "Jane Smith" } } }, [A1], READY);
    expect(r.next).toEqual({ text: "Record the Fleet public address (one confirmation)", go: "business" });
    expect(r.proof.find((c) => c.label === "Fleet public address recorded")).toMatchObject({ done: false, detail: expect.stringMatching(/details are saved; record the address/) });
  });
  it("seller and address saved: resume first; then a failed connection; then a chosen platform; then proof permission", () => {
    const d = { ...production, seller: { seller: { legalName: "Jane Smith" } }, publicSite: { url: "https://api.agentfleet.vip", salesOpen: false } };
    expect(readiness(d, [A1, A2], READY).next.go).toBe("agents");
    const running = [{ ...A1, paused: false }, A2];
    expect(readiness({ ...d, channels: [etsyChannel("A1")] }, running, READY).next).toMatchObject({ go: "platforms" });
    expect(readiness({ ...d, channels: [etsyChannel("A1", { provider: "etsy", status: "failed", checkError: "FLEET_CHANNEL_API_NO_TOKEN" })] }, running, READY).next)
      .toMatchObject({ go: "platforms", text: expect.stringMatching(/failed its check/) });
    const r = readiness({ ...d, channels: [etsyChannel("A1", { provider: "etsy", status: "active" })] }, running, READY);
    expect(r.next).toMatchObject({ go: "readiness", text: expect.stringMatching(/proof permission/) });
    expect(r.proof.filter((c) => c.blocker).every((c) => c.done)).toBe(true);
    // No route ready (PayPal unknown, no platform): the next step says so.
    expect(readiness(d, running, receivingState(null)).next.text).toMatch(/sales route ready/);
  });
  it("after launch: no permission is needed and the launch stage is done", () => {
    const d = { ...production, seller: { seller: { legalName: "Jane Smith" } }, publicSite: { url: "https://api.agentfleet.vip", salesOpen: true } };
    const r = readiness(d, [{ ...A1, paused: false }], READY);
    // Open sales are a different fact from completed proofs: the proof stays untracked, never "done".
    expect(r.launch.find((c) => c.label.startsWith("Final activation"))).toMatchObject({ done: true });
    expect(r.launch.find((c) => c.label.startsWith("Live proofs"))).toMatchObject({ done: false, untracked: true, detail: expect.stringMatching(/whether sales are open or not/) });
    expect(UNTRACKED).toBe("Not tracked — operator verification required");
    expect(r.proof.find((c) => c.label.startsWith("Proof permission"))).toMatchObject({ done: true, detail: expect.stringMatching(/Not needed/) });
    expect(r.next.text).toMatch(/Launched/);
  });
});

describe("business details", () => {
  it("explains each problem in words, with the company fields only for a company", () => {
    expect(sellerProblems(emptySeller())).toEqual({ legalName: expect.stringMatching(/full legal name/), postalAddress: expect.stringMatching(/full postal address/) });
    const ok = { ...emptySeller(), legalName: "Jane Smith", postalAddress: "12 High Street, Leeds LS1 1AA" };
    expect(sellerProblems(ok)).toEqual({});
    expect(sellerProblems({ ...ok, vatNumber: "123456789" }).vatNumber).toMatch(/country code/);
    expect(sellerProblems({ ...ok, vatNumber: "gb 123 456 789" })).toEqual({});
    const co = sellerProblems({ ...ok, legalForm: "company" });
    expect(Object.keys(co).sort()).toEqual(["companyNumber", "registeredOffice"]);
    expect(sellerFields({ ...ok, companyNumber: "12345678", registeredOffice: "somewhere long enough" })).toMatchObject({ companyNumber: null, registeredOffice: null, tradingName: null, vatNumber: null });
  });
  it("previews the buyer-visible notice with placeholders for the agent's brand", () => {
    const lines = noticePreview({ ...emptySeller(), legalName: "Jane Smith", postalAddress: "12 High Street, Leeds" }, { extra: "Returns within 14 days." });
    expect(lines).toEqual(["Sold by Jane Smith under the brand [the agent’s brand].", "Address: 12 High Street, Leeds", "Customer support: [the brand’s support address]", "Returns within 14 days."]);
    const co = noticePreview({ ...emptySeller(), legalForm: "company", legalName: "Smith Ltd", postalAddress: "1 A St", registeredOffice: "1 A St", companyNumber: "123456", vatNumber: "GB123456789" },
      { brand: "Ledgerline", supportEmail: "help@ledgerline.example" });
    expect(co).toEqual(["Sold by Smith Ltd (company no. 123456) under the brand Ledgerline.", "Address: 1 A St", "Customer support: help@ledgerline.example", "VAT no. GB123456789"]);
  });
});

describe("proof permission", () => {
  const channels = [etsyChannel("A1", { provider: "etsy", status: "active" }), pinChannel("A1"), etsyChannel("A2", { provider: "etsy", status: "active" })];
  it("research and building need nothing; an empty choice is explained", () => {
    expect(buildScope(emptyPermission("A1"), channels).problems).toEqual(["Choose at least one outward action. Research and building need no permission."]);
    expect(buildScope(emptyPermission(""), channels).problems[0]).toMatch(/Choose the agent/);
  });
  it("each action builds exactly its scope", () => {
    expect(buildScope({ ...emptyPermission("A1"), profile: true, profileSites: "Etsy.com/sell https://www.gumroad.com" }, channels).scope)
      .toEqual({ actions: ["account_register"], origins: ["https://etsy.com", "https://www.gumroad.com"], expiresHours: 24 });
    // Browser work only inside accounts the owner ticks (the backend enforces it per session account), on their sites.
    expect(buildScope({ ...emptyPermission("A1"), profile: true, profileAccounts: ["acc-1"] }, channels, { "acc-1": ["https://www.gumroad.com"] }).scope)
      .toEqual({ actions: ["browser", "account_connector"], origins: ["https://www.gumroad.com"], accounts: ["acc-1"], expiresHours: 24 });
    expect(buildScope({ ...emptyPermission("A1"), profile: true, profileAccounts: ["acc-1"] }, channels, {}).problems.join(" ")).toMatch(/name the website/);
    expect(buildScope({ ...emptyPermission("A1"), draft: true, draftChannels: ["c-A1"] }, channels).scope)
      .toEqual({ actions: ["channel_api"], channels: ["c-A1"], apiOps: ["etsy.listing.create", "etsy.listing.update", "etsy.listing.image", "etsy.listing.file"], expiresHours: 24 });
    expect(buildScope({ ...emptyPermission("A1"), publish: true, publishChannels: ["p-A1"], hours: 4 }, channels).scope)
      .toEqual({ actions: ["channel_api"], channels: ["p-A1"], apiOps: ["pinterest.board.create", "pinterest.pin.create"], expiresHours: 4 });
    expect(buildScope({ ...emptyPermission("A1"), messages: true, mailTo: "Buyer@Example.com; @example.org" }, channels).scope)
      .toEqual({ actions: ["mail"], mailTo: ["buyer@example.com", "@example.org"], expiresHours: 24 });
  });
  it("refuses what the backend would refuse, before any request", () => {
    const p = (x: object) => buildScope({ ...emptyPermission("A1"), ...x }, channels).problems.join(" ");
    expect(p({ profile: true, profileSites: "http://plain.example" })).toMatch(/web addresses/);
    expect(p({ draft: true, draftChannels: [] })).toMatch(/choose at least one connected platform/);
    expect(p({ draft: true, draftChannels: ["p-A1"] })).toMatch(/no drafts/);
    expect(p({ publish: true, publishChannels: ["c-A2"] })).toMatch(/not one of this agent/);
    expect(p({ messages: true, mailTo: "not an address" })).toMatch(/email addresses/);
    expect(p({ messages: true, mailTo: "a@b.co", hours: 73 })).toMatch(/1 to 72 hours/);
    expect(originsOf("a.example, ftp://x.example")).toBeNull();
    expect(recipientsOf("x@y")).toBeNull();
  });
  it("says what a scope allows and what it means, in words", () => {
    const { scope } = buildScope({ ...emptyPermission("A1"), publish: true, publishChannels: ["c-A1", "p-A1"], messages: true, mailTo: "a@example.com" }, channels);
    const look = { channel: (id: string) => channels.find((c) => c.channelId === id) };
    expect(describeScope(scope!, look)).toEqual([
      "On Etsy (Etsy): save new draft listings, edit listings, add images, add download files, publish listings (public), withdraw listings",
      "On Pins (Pinterest): create boards, create Pins (public once Pinterest grants Standard access)",
      "Send email to a@example.com"]);
    const c = consequencesOf(scope!).join("\n");
    expect(c).toMatch(/public or delivered at once/);
    expect(c).toMatch(/Etsy charges your shop its listing fee/);
    expect(c).toMatch(/Spending is not part of this permission/);
    expect(c).toMatch(/replaces any permission/);
  });
});

describe("platforms and connection checks", () => {
  it("each platform says it is optional, what the agent manages and what stays manual, with exact steps", () => {
    for (const g of PLATFORMS) {
      expect(g.optional).toMatch(/^Optional/);
      for (const list of [g.agentManages, g.staysManual, g.youNeed, g.accountSteps, g.appSteps]) expect(list.length).toBeGreaterThan(0);
      expect(g.appSteps.join(" ")).toContain("https://api.agentfleet.vip/oauth/callback");
    }
    expect(PLATFORMS[0].staysManual.join(" ")).toMatch(/no messaging API/);
  });
  it("recognises a channel's platform and derives a valid vault name", () => {
    expect(providerOf({ url: "https://www.etsy.com/shop/x" })).toBe("etsy");
    expect(providerOf({ name: "Pinterest boards" })).toBe("pinterest");
    expect(providerOf({ name: "Own pages", url: "https://api.agentfleet.vip/o/x" })).toBeNull();
    expect(rulesMissing({ kind: "own_pages", rulesRecorded: false })).toBe(false);
    expect(rulesMissing({ kind: "marketplace", rulesRecorded: false })).toBe(true);
    for (const v of [defaultVaultRef("etsy", "Agent-1", "Etsy shop"), defaultVaultRef("pinterest", "Ágent 2 ✨", "A very long channel name that keeps going on and on")])
      expect(v).toMatch(/^vault:(etsy|pinterest)\/[a-z0-9_-]{1,40}$/);
  });
  it("explains every check failure with a recovery", () => {
    const errors = ["the token reaches a different Etsy shop", "Pinterest requires a business account for commercial use", "the token reaches a different account",
      "the token carries other scopes than exactly the required ones", "FLEET_CHANNEL_API_NO_TOKEN", "FLEET_CHANNEL_API_UNAUTHORIZED", "FLEET_CHANNEL_API_REFRESH",
      "FLEET_CHANNEL_API_RATE_LIMITED", "FLEET_CHANNEL_API_REJECTED: account check (500)", "something new"];
    const seen = new Set<string>();
    for (const e of errors) { const x = explainCheck(e); expect(x.what.length).toBeGreaterThan(10); expect(x.fix.length).toBeGreaterThan(10); seen.add(x.what); }
    expect(seen.size).toBe(errors.length);
    expect(explainCheck("FLEET_CHANNEL_API_RATE_LIMITED").automatic).toBe(true);
  });
});
