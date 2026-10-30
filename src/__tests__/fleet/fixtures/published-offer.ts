import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PgIdentityGateway } from "../../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../../fleet/identity/main.js";
import { expect } from "vitest";
import { autoCapabilityChecks, OWNER, READY_RUNTIME, type EconomyRegistry, type Founder } from "./economy-registry.js";
import { liveRail } from "./custody-signer.js";

/**
 * A real published offer for tests of listings (v111: a listing names the published offer it sells, and that offer's capability check
 * must cover it). It goes through the ordinary route: a file, an inspected review, a capability check, publication. Nothing is stubbed.
 */
export async function publishedOffer(R: EconomyRegistry, F: Founder, ventureKey: string): Promise<string> {
  autoCapabilityChecks(R);
  await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
  await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey, displayName: "Workbook Studio", bio: "Tested spreadsheet tools for freelancers, produced by an AI agent." });
  // Its routing mailbox, through the identity broker as in production (a simulated shared mailbox; no mail leaves).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offer-fixture-"));
  fs.chmodSync(dir, 0o700);
  initIdentityState(dir);
  const { vault, ownerVault } = openIdentityState(dir);
  const broker = new IdentityBroker(new PgIdentityGateway({ connectionString: R.pgc.identityUrl }), vault, { mail: new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test"), ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
  await broker.tick();
  const box = await R.econ(F, "mailbox.provision", { ventureKey, idempotencyKey: `k-${crypto.randomUUID()}` });
  expect(box.ok, JSON.stringify(box)).toBe(true);
  await broker.tick();
  await R.q(`SELECT fleet.fleet_admin_public_site_set($1, 'Automaton Fleet', $2)`, ["https://shop.fleet.test", OWNER]);
  await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, $2)`, [JSON.stringify({ legalForm: "individual", legalName: "A. Seller", postalAddress: "1 Example Street\nLondon\nEX1 1AA" }), OWNER]);
  const file = Buffer.from("a tested workbook, as bytes for the test");
  const sha = crypto.createHash("sha256").update(file).digest("hex");
  const deliverables = ["workbook"];
  const o = await R.econ(F, "offer.create", { venture: ventureKey, kind: "product", priceMinor: 1200, title: "A tested workbook", summary: "A workbook that forecasts cash flow.",
    description: "Formulas forecast twelve months. Produced by an AI agent.", audience: "freelancers", deliverables, terms: "Refunds if the file is faulty." });
  expect(o.ok, JSON.stringify(o)).toBe(true);
  const offerId = o.offer.offerId as string;
  const up = await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: "workbook.txt", contentType: "text/plain", contentB64: file.toString("base64") });
  expect(up.ok, JSON.stringify(up)).toBe(true);
  const rv = await R.econ(F, "review.record", { subject: "offer", offerId, files: [{ name: "workbook.txt", sha256: sha, sizeBytes: file.length }],
    automated: { inspector: "fleet-qa-3", ok: true, files: [{ path: "workbook.txt", sha256: sha, sizeBytes: file.length, detectedType: "text", ok: true, checks: [{ id: "opened", status: "pass", detail: "opened" }] }] },
    criteria: [{ criterion: "Calculations reconcile", met: true, evidence: "recalculated" }, { criterion: "workbook", met: true, evidence: "opened and checked" }, { criterion: "Promises match the listing", met: true, evidence: "read against the description" }], verdict: "pass" });
  expect(rv.ok, JSON.stringify(rv)).toBe(true);
  const p = await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId });
  expect(p.ok, JSON.stringify(p)).toBe(true);
  return offerId;
}

/** A new channel, mailbox or card invalidates an offer's capability check (correctly): the agent checks again, as a runtime would. */
export async function recheckOffer(R: EconomyRegistry, F: Founder, offerId: string): Promise<void> {
  const c = await R.econ(F, "capabilities.check", { runtime: READY_RUNTIME, offerId, deliverables: [{ format: "txt" }] });
  expect(c.ok, JSON.stringify(c)).toBe(true);
}
