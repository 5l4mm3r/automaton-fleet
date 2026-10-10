/**
 * UI 0.13.2, unit level: the Proton Bridge login is checked in the browser before it is sealed (the three mistakes that
 * left mail silently unusable on 2026-10-10: a certificate without its BEGIN/END lines, a Gmail address, an @proton.com
 * address), and the Mail page describes each message's state in plain words.
 */
import { describe, it, expect } from "vitest";
import { protonLoginProblem } from "../../../codex-dashboard/src/dashboard/money/MoneyPanels";
import { mailStatus, MAIL_VIEWS } from "../../../codex-dashboard/src/dashboard/mail/MailPage";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIDkjCCAnqgAwIBAgIQ\n-----END CERTIFICATE-----";
const good = { address: "fleet.treasury@proton.me", username: "fleet.treasury@proton.me", password: "bridge-generated-pw", certPem: PEM };

describe("protonLoginProblem", () => {
  it("accepts a complete login on a Proton address", () => {
    expect(protonLoginProblem(good)).toBeNull();
    expect(protonLoginProblem({ ...good, address: " Fleet.Treasury@PM.me " })).toBeNull();
    expect(protonLoginProblem({ ...good, address: "fleet@protonmail.com" })).toBeNull();
    expect(protonLoginProblem({ ...good, address: "shop@agentfleet.vip" })).toBeNull(); // a custom domain on Proton
  });
  it("refuses a certificate without its BEGIN / END lines", () => {
    expect(protonLoginProblem({ ...good, certPem: "MIIDkjCCAnqgAwIBAgIQ" })).toMatch(/BEGIN CERTIFICATE/);
    expect(protonLoginProblem({ ...good, certPem: "-----BEGIN CERTIFICATE-----\nMIID" })).toMatch(/END CERTIFICATE/);
  });
  it("refuses addresses Bridge cannot send from", () => {
    expect(protonLoginProblem({ ...good, address: "fleet.treasury@gmail.com" })).toMatch(/not from Gmail/);
    expect(protonLoginProblem({ ...good, address: "fleet@outlook.com" })).toMatch(/Proton account's own addresses/);
    expect(protonLoginProblem({ ...good, address: "fleet.treasury@proton.com" })).toMatch(/@proton\.me/);
    expect(protonLoginProblem({ ...good, address: "fleet+shop@proton.me" })).toMatch(/letters, digits/);
  });
  it("refuses a missing username and a too-short password", () => {
    expect(protonLoginProblem({ ...good, username: " " })).toMatch(/username/);
    expect(protonLoginProblem({ ...good, password: "short" })).toMatch(/Bridge generated/);
  });
});

describe("mailStatus", () => {
  it("says what happened to each message", () => {
    expect(mailStatus({ direction: "in", agentId: "a1" })).toEqual({ text: "Received", tone: "info" });
    expect(mailStatus({ direction: "in", agentId: null, routingReason: "no deterministic owner" })).toEqual({ text: "Unassigned: no deterministic owner", tone: "wait" });
    expect(mailStatus({ direction: "out", sendStatus: "sent", sentAt: "2026-10-11T07:00:05Z" })).toEqual({ text: "Sent 2026-10-11 07:00 UTC", tone: "ok" });
    expect(mailStatus({ direction: "out", sendStatus: "failed", sendError: "FLEET_MAIL_PROVIDER_AUTH" })).toEqual({ text: "Send failed: FLEET_MAIL_PROVIDER_AUTH", tone: "bad" });
    expect(mailStatus({ direction: "out" }).tone).toBe("wait");
  });
  it("offers exactly the views the mail_feed read accepts", () => {
    expect(MAIL_VIEWS.map(([k]) => k).sort()).toEqual(["all", "inbox", "outbox", "security", "unassigned"]);
  });
});
