/**
 * Notification detail (V2.4.2): the Fleet daily report opens as a readable report built from the REAL stored payload
 * (the 2026-10-07 production report's exact shape), not as JSON; a malformed payload is "Report unavailable"; other
 * notifications read as facts; secret-looking fields are withheld; hostile strings render as inert text; the raw
 * payload is only behind "View technical data". Rendered with React's server renderer (the real components).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { codeText, dailyReport, detailFacts, isTestNotice, technicalText } from "../../../codex-dashboard/src/dashboard/notifications/report";
import { NotificationDetail, NotificationInbox } from "../../../codex-dashboard/src/dashboard/notifications/NotificationInbox";
import { factsOf } from "../../../codex-dashboard/src/dashboard/command/panels";
import type { Notice } from "../../../codex-dashboard/src/dashboard/model";

/** The production daily report of 2026-10-07 (fleet_daily_report() as stored in the notification). */
const REAL = {
  flows: { spendMinor: 0, revenueMinor: 0, ownerFundingMinor: 0, profitContributionMinor: 0 },
  agents: [{ mode: "NORMAL", name: "founder-1", status: "active", agentId: "01M3F50SH7PNX2E3GST13J52AS", cashMinor: 9125, valueMinor: 9125 }],
  window: "24h",
  treasury: { basis: "Fleet-generated realised wealth = …", treasuryCashMinor: 0, fleetGeneratedMinor: 0, ownerWithdrawnMinor: 0, ownerContributedMinor: 10000 },
  alerts24h: null, deaths24h: 0, generatedAt: "2026-10-07T07:01:11.067735+00:00",
  replication: { phase: "idle", pendingSince: null, nextThresholdMinor: 100000, thresholdsConsumed: 0 },
  birthsQueued: 0, decisions24h: 0, breakerTripped: false, missionsActive: 0, venturesClosed24h: 0, venturesOpened24h: 0, accountsCreated24h: 0, identityActionsPending: 0,
};
const notice = (over: Partial<Notice>): Notice => ({ id: "n1", title: "Fleet daily report 2026-10-07", level: "INFO", acknowledged: false, time: "07:01",
  code: "DAILY_REPORT", cls: "DAILY", detail: REAL, agentId: null, createdAt: "2026-10-07T07:01:11Z", acknowledgedAt: null, ...over });
const render = (n: Notice) => renderToStaticMarkup(createElement(NotificationDetail, { n, agentName: (id: string) => id, close: () => {}, run: async () => {}, live: true }));

describe("notification detail: the daily report is a report, not code", () => {
  it("builds readable sections from the real production payload (money formatted, Agent-1 named, nothing invented)", () => {
    const r = dailyReport(REAL)!;
    expect(r.date).toBe("2026-10-07");
    expect(r.generatedAt).toBe("2026-10-07 07:01 UTC");
    const all = Object.fromEntries(r.sections.flatMap((s) => s.facts));
    expect(all["External revenue"]).toBe("£0.00");
    expect(all["Owner contributed"]).toBe("£100.00");
    expect(all["Next threshold"]).toBe("£1,000.00");
    expect(all["Security breaker"]).toBe("not tripped");
    expect(all["Alerts in the window"]).toBe("none");
    expect(r.agents).toEqual([{ name: "Agent-1", status: "active", mode: "NORMAL", cash: "£91.25", value: "£91.25" }]);
  });

  it("renders the report view: headings and values, no raw keys or JSON as the primary content", () => {
    const html = render(notice({}));
    expect(html).toContain("Fleet daily report · 2026-10-07");
    expect(html).toContain("External revenue");
    expect(html).toContain("Agent-1");
    const primary = html.split("View technical data")[0];
    expect(primary).not.toMatch(/revenueMinor|"flows"|\{&quot;|generatedAt/);
    expect(html).toContain("View technical data"); // the payload is still available, collapsed
  });

  it("a malformed or missing report payload fails safely as 'Report unavailable'", () => {
    for (const bad of [null, {}, { generatedAt: "not a date", flows: {} }, { flows: {} }, "text", [1, 2]]) expect(dailyReport(bad)).toBeNull();
    const html = render(notice({ detail: { generatedAt: "x" } }));
    expect(html).toContain("Report unavailable");
  });

  it("other notifications read as facts; secret-looking fields are withheld at every depth", () => {
    const f = Object.fromEntries(detailFacts({ ip: "81.1.2.3", amountMinor: 1234, apiKeySecret: "sk_live_x", tokenValue: "t", nested: { a: 1 }, at: "2026-10-07T01:02:03Z" }));
    expect(f).toMatchObject({ ip: "81.1.2.3", amount: "£12.34", "api key secret": "withheld", "token value": "withheld" });
    const t = technicalText({ a: { password: "hunter2", deep: { privateKey: "k" } }, title: "ok" });
    expect(t).not.toMatch(/hunter2|"k"/);
    expect(t).toContain("(withheld)");
    expect(codeText("ADMIN_PASSKEY_ADDED")).toBe("Passkey added");
    expect(codeText("SOME_NEW_CODE")).toBe("Some new code");
  });

  it("hostile strings (title, agent name, payload) render as inert text", () => {
    const evil = `<img src=x onerror=alert(1)><script>alert("x")</script>`;
    const html = render(notice({ code: "HIGH_EXPOSURE_SPEND", level: "AMBER", title: evil, detail: { note: evil, agentId: evil }, agentId: evil }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("test notifications are labelled as such and never as a live daily report", () => {
    expect(isTestNotice("TEST_NOTICE")).toBe(true);
    expect(isTestNotice("DAILY_REPORT")).toBe(false);
    const html = render(notice({ code: "TEST_NOTICE", title: "Fleet daily report (fixture)", detail: { note: "fixture" } }));
    expect(html).toContain("TEST NOTIFICATION");
    expect(html).not.toContain("Fleet daily report ·");
  });

  it("the event feed reads a notification event in plain words, not class / code values", () => {
    expect(factsOf({ class: "DAILY", code: "DAILY_REPORT" })).toEqual([["kind", "Fleet daily report"], ["severity", "report"]]);
  });

  it("the inbox: acknowledged rows offer Delete, unread rows Acknowledge; bulk controls show FleetController's count", () => {
    const html = renderToStaticMarkup(createElement(NotificationInbox, { notices: [notice({ id: "a" }), notice({ id: "b", acknowledged: true, title: "Passkey added", code: "ADMIN_PASSKEY_ADDED", level: "AMBER" })],
      filter: "all", run: async () => {}, agentName: (id: string) => id, live: true, onAckRequest: () => {}, acknowledgedTotal: 14 }));
    expect(html).toContain("Delete all acknowledged (14)");
    expect(html).toContain("open the report");
    expect((html.match(/>Acknowledge</g) ?? []).length).toBe(1);
    expect((html.match(/>Delete</g) ?? []).length).toBe(1);
  });
});
