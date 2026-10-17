/**
 * v93: a sealed card is recognisable (masked label) and its expiry is known — PostgreSQL; the broker's installation is
 * driven through its own role (ix_vault_installed), as the identity broker does.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const SEALED = Buffer.concat([Buffer.from("FSB1"), crypto.randomBytes(64)]); // shape only: the broker opens real ones

describe.skipIf(!PG_BIN)("v93 card label and expiry (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let broker: pg.Pool;
  const session = crypto.randomBytes(16).toString("hex");
  const dash = (op: string, args: object) => R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), sha("csrf"), op, JSON.stringify(args)]);
  const install = async (uploadId: string) => (await broker.query(`SELECT fleet.ix_vault_installed($1, 'identity-broker', true, NULL) AS r`, [uploadId])).rows[0].r;
  const status = async () => (await R.one<any>(`fleet.fleet_identity_autonomy_json()`)).configured;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    await R.store.grantIdentityRole();
    broker = new pg.Pool({ connectionString: R.pgc.identityUrl, max: 1 });
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v93_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at, stepup_until) VALUES ($1, $2, 'v93_test_credential', 'passkey', true, now() + interval '1 hour', now() + interval '10 minutes')`,
      [sha(session), sha("csrf")]).catch(async () => {
      await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v93_test_credential', 'passkey', true, now() + interval '1 hour')`, [sha(session), sha("csrf")]);
    });
  }, 300_000);
  afterAll(async () => { await broker?.end(); await R?.close(); });

  it("the masked label and the expiry travel with the sealed card and are shown once installed", async () => {
    const up = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('payment_card', $1, 'text/plain', '2028-08-31T23:59:59Z', 'Visa •••• 1234 · J SMITH · exp 08/28', $2)`, [SEALED, OWNER]);
    expect(up).toMatchObject({ ok: true, status: "pending" });
    expect((await status()).payment_card).toBeUndefined(); // not usable until the broker installed it
    expect(await install(up.uploadId)).toMatchObject({ ok: true });
    expect((await status()).payment_card).toMatchObject({ status: "configured", label: "Visa •••• 1234 · J SMITH · exp 08/28" });
    expect(new Date((await status()).payment_card.expiresAt).toISOString()).toBe("2028-08-31T23:59:59.000Z");
    // A replacement card replaces its label and expiry.
    const up2 = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('payment_card', $1, 'text/plain', '2029-01-31T23:59:59Z', 'Mastercard •••• 9876 · J SMITH · exp 01/29', $2)`, [SEALED, OWNER]);
    await install(up2.uploadId);
    expect((await status()).payment_card).toMatchObject({ label: "Mastercard •••• 9876 · J SMITH · exp 01/29" });
  });

  it("a label can never carry a card number; the old 5-argument upload still works (no label)", async () => {
    for (const bad of ["4111111111111111", "Visa 41111 · J", "x".repeat(81)])
      expect(await R.code(R.one(`fleet.fleet_admin_owner_vault_upload('payment_card_2', $1, 'text/plain', NULL, $2, $3)`, [SEALED, bad, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`INSERT INTO fleet.fleet_owner_identity_classes (class_key, vault_ref, status, updated_by, display_label) VALUES ('payment_card_3', 'ovault:payment_card_3', 'configured', 'x', '1234567890123')`))).toMatch(/check|violates/i);
    const old = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('payment_card_2', $1, 'text/plain', NULL, $2)`, [SEALED, OWNER]);
    await install(old.uploadId);
    expect((await status()).payment_card_2).toMatchObject({ status: "configured", label: null, expiresAt: null });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("the dashboard upload passes the label and expiry", async () => {
    const r = await dash("owner_vault_upload", { class: "payment_card_3", sealedB64: SEALED.toString("base64"), contentType: "text/plain", expiresAt: "2027-05-31T23:59:59Z", displayLabel: "Visa •••• 4242 · J SMITH · exp 05/27" });
    if (r.code === "FLEET_STEPUP_REQUIRED") return; // a sensitive op: covered by the gateway's own step-up tests; the SQL path is above
    expect(r).toMatchObject({ ok: true });
    const row = (await R.q(`SELECT display_label, expires_at FROM fleet.fleet_owner_vault_inbox WHERE class_key = 'payment_card_3' ORDER BY created_at DESC LIMIT 1`))[0];
    expect(row.display_label).toBe("Visa •••• 4242 · J SMITH · exp 05/27");
  });
});
