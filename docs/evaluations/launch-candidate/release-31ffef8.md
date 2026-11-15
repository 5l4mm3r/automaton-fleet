# Release 31ffef8 — schema 77 → 78 (legal seller + agent storefronts) · DEPLOYED 2026-10-15 13:53Z

## Deployment (owner's instruction, 2026-10-15: "Deploy the rehearsed 31ffef8 package, schema 77→78, using its verified pins")
- `fleet-release.sh` 13:51:50Z → **DEPLOYED 13:53:37Z**; outage 13:52:43–13:53:28Z (45 s); one `production_deployed` event.
  Live: commit 31ffef8, build `94a1bf2b…aeb8` (= pins, = local), lockfile `1df54e35…a2c1`, schema **78**, UI 0.19.0 reused (no switch).
  Cutover reconciliation OK (3019 events preserved).
- Rollback points: pre-migration dump `~/automaton_fleet-v77-pre-v78-20261015T135303Z.dump`, `runtime.env.pre-31ffef8`, release
  12c9f67; UI `dashboard.env.before-release-31ffef8-20261015T135150Z`. Before live money: `bash ~/rlc78/fleet-rollout.sh revert
  ~/rlc78/pins.txt 77 78 <reason>`; after real money: freeze and fix forward.
- **Preservation** (row count + content hash of every table, `~/rlc78/{pre,post}-tables.txt`, 13:51Z vs 13:54Z): identical except
  the expected — migration 78 (new empty `fleet_seller_identity`); runtime identity 12c9f67 → 31ffef8 (`fleet_state`); heartbeats /
  timestamps (agents, mail providers, notification scan watermark, replication evaluation, nonces, +4 health challenges); +2 PayPal
  balance readings; Fleet Command +1 (deploy). Events 3019 → 3037: 22 added (14 role grants, `runtime_approved`,
  `production_deployed`, 4 `session_opened`, the usual 2 heartbeat `api_auth_failed` refused across the outage — replay
  protection), 4 temporary rows aged out by 7-day retention. Ledger verifies: 812 journals, 0 unbalanced, head `723c7ea3…3e81`.
  Capital policy unchanged (version 1, `sizing` = `fixed`; contextual NOT applied).
- **State after**: Agent-1 / Agent-2 cognition paused (754p/20h, 3000p/60h unchanged) on b60e262; seller not set; no public site
  (sales closed, 0 storefronts); 0 custody activations; custody execution off; no signer file; `REAL_PAYMENTS_ENABLED` /
  `REAL_REPLICATION_ENABLED` / `OWNER_SWEEP_ENABLED` / `FLEET_DRY_RUN_CHILD` false, remote listen true; survival protection ON;
  sweep policy off; no launch boundary; cap 2, DEVELOPMENT. Loopback readyz 200 (schema v78, runtime 31ffef8), public healthz 200,
  admin 200; all units active.

Before deployment (verified live 2026-10-15 11:53Z, release-12c9f67.md): 12c9f67, schema 77, UI 0.19.0; Agent-1 and Agent-2 paused
on b60e262; no public site (sales closed); 0 custody activations; real payments off; survival protection on; capital sizing
`fixed`; no launch boundary. Nothing here is authorised by this record.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=31ffef89039037ac09ca1e91799827621cf8ca30
FLEET_RUNTIME_BUILD_ID=94a1bf2b6639557dff9cfae7109627292c677f4764d82356f9a3f08e5557aeb8
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc78/pins.txt` = independent local build. UI unchanged: 0.19.0 `890f7b07…244e` (staged `~/rlc78/ui-0.19.0-31ffef8.tgz`).
- Data rehearsal 77 → 78 **PASSED** 12:29:56Z (`~/rlc78/rehearse.log`): wouldApply [78]; reconciliation OK (812 journals; 3036
  events preserved); ledger verifies; re-run no-op; rollback dump restores 77 with the same ledger head; live untouched. (Live kept
  writing heartbeats during the dump — noted, not a failure.)
- Services + rollback rehearsal **PASSED** 12:50:54Z (`upgrade-rehearsal.log`): 12c9f67 refuses 78; candidate controller, Operator
  API, dashboard ready on 78; Fleet Command / history checks clean; ledger head unchanged; rollback restores 77 and 12c9f67.
  The first attempt (12:30Z) stopped at the v45 history check: 14 routine events had crossed 7 days minutes earlier and live's
  hourly retention pass had not yet run (live showed the same 14; the copy's own pass expired exactly those). Re-run right after
  live's 12:50Z pass: copies 0. Check left unchanged.
- Tests (affected only): v78 6/6; v76 market + fulfilment 9/9 (incl. the new one-agent / two-ventures case); v76 e2e
  demonstrations 3/3; founder tools 7/7 (93312fb); migration paths 2/2; tsc clean. Founder runtime changed (agent tool text):
  local founder upgrade rehearsal b60e262 → 31ffef8 **11/11** (1 skipped: specific to an older base).
- Unchanged since 12c9f67 and not re-run: treasury / custody / capital / ledger suites (no money path touched).

## What v78 does (spec §31.8)
- **Owner, once**: `economy-seller-set <json>` — only legal facts: `legalForm` (individual | company), `legalName`, `tradingName`
  (own registered one, if any), `postalAddress`, `vatNumber` (if registered), `companyNumber` + `registeredOffice` (company).
  Reused for every agent brand; the event records changed field names, never values. `economy-seller` shows it and each storefront.
- **Agents, on their own**: brand name + description = the venture identity they create; support = that venture's routing address.
- **Buyers see** on every page and buyer email: "Sold by <legal name> [trading as …] [(company no. …)] under the brand <brand>." +
  address, registered office, customer-support address, VAT number, then the owner's optional extra notice.
- **Company suffixes** (corrected): any brand is free unless it ends in a legal-entity suffix (Ltd, Limited, LLP, PLC, Inc, LLC,
  GmbH, Corp…); such a brand must be the legal seller company's registered name or registered trading name (Ltd = Limited, Inc =
  Incorporated, Corp = Corporation) — otherwise `FLEET_STOREFRONT_NAME`. "Limited Edition Prints", "Incline Studio" are free; a
  brand that stops matching after a seller change is simply not shown as a brand.
- **Several ventures per agent**: pages, orders, buyer replies / quotes / messages and deliveries each use their own venture's
  identity and routing address (Reply-To and "Customer support"), else the agent's general address — never another venture's.
  Found and fixed while verifying: a general address sorted ahead of the venture's own (NULL ordering) — now covered by the test.
- **Publishing needs**: public site, legal seller (`FLEET_PUBLIC_SITE_SELLER_UNSET`), the venture's identity with a 40+ character
  description (`FLEET_STOREFRONT_PROFILE`), allowed brand name, routing address, receiving rail, passing review.

## Deployment package (deployed 13:53Z — see above)
1. Deploy: `bash ~/rlc78/fleet-release.sh ~/rlc78/pins.txt 77 78 0.19.0 ~/rlc78/ui-0.19.0-31ffef8.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`
   (rehearsals valid until **2026-10-16 12:29Z**; re-rehearse after). Changes nothing else: agents stay paused, sales closed, money-out off.
2. After your seller facts arrive (separately): `economy-seller-set '<json>'`, then `economy-public-site https://api.agentfleet.vip`
   (no extra notice needed). Sales stay closed — the preparation hold applies.
3. Rollback before any live money: `bash ~/rlc78/fleet-rollout.sh revert ~/rlc78/pins.txt 77 78 <reason>`. After real money:
   freeze and fix forward.

## Remaining (unchanged from release-12c9f67.md §B–E)
Seller facts (yours, pending → then `economy-seller-set`, `economy-public-site`); webhook delivery log; Payouts approval (only for PayPal-paid suppliers); card / identity seals;
AI auto-reload; controlled proof (Agent-1: upgrade to 31ffef8, resume, it creates its venture identity + routing address,
publishes, you `economy-offer-proof`, pay, refund); funding; final activation incl. `economy-capital-policy '{"sizing":"contextual"}'`.
