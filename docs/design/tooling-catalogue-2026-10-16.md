# Tools, extensions and plugins for agents, Fleet Command and the machine: catalogue (2026-10-16)

**Status:** a catalogue for the owner to choose from, not a build plan. Nothing here is installed by this document.
"Have" means present in the repository (inventory of 2026-10-16); "not found" means searched for and absent.

**Position.** Yes to a broad, deliberate catalogue; no to installing everything.
- Every addition adds attack surface, cost, maintenance and failure modes. A tool the agents can call is also a tool that
  can be misused, and some tools would break the platform rules the agents must follow.
- So each item has a priority. The first controlled proof should decide most of the P2 items: add what the proof shows is
  missing, not what might help.
- **P1:** before real money or launch. **P2:** after the first proof, if evidence supports it. **P3:** later or at scale.

## A. Agent capability (thinking, producing, selling)

| Item | Today | Why | Risks / conditions | Priority |
|---|---|---|---|---|
| **Current agent runtime** | agents on b60e262 (12 Oct); the toolset-5 runtime is built | most of today's tools (offers, deliverable inspect, business, API channels, view_image) need it | upgrade with agents paused | **P1** |
| Web search API (through FleetController, budgeted) | not found; research uses page fetches and sites' own search | faster, cheaper market research and demand evidence | per-query cost; results are untrusted data; keep within research limits | P2 |
| Image generation model | not found; only code-drawn images | listing images, mockups, covers, course visuals | provider terms and licences; AI-image disclosure where platforms require it; never fake product photos | P2 |
| OCR in the toolchain (e.g. Tesseract) | the inspector flags "needs OCR" but cannot do it | reading scanned briefs and PDFs | small; pinned like the rest of the toolchain | P2 |
| Toolchain additions: charts (matplotlib), data (pandas), e-books (EPUB), SVG→PNG, QR codes, a set of open-licence fonts | spreadsheets, documents, slides, PDFs and images today | richer digital products and courses | each package pinned and hash-verified; no network in the sandbox | P2 |
| Own sending domain(s) with SPF, DKIM and DMARC | one shared Proton address | deliverability and credibility for delivery and outreach mail | DNS work; per-brand domains cost money | **P1** for launch credibility (owner decision) |
| Privacy-friendly analytics on the Fleet's own pages (self-hosted) | page views not measured | conversion data the doctrine asks agents to use | consent and cookie rules; self-host to avoid sharing buyer data | P2 |
| Semantic search (embeddings) over memory, journal and library | keyword search | better recall as memory grows | another model call and store; only once keyword recall proves insufficient | P3 |
| Gumroad gateway installation | built (v52), not installed, not connected | a merchant-of-record route for EU digital sales | owner onboarding; the £500 unlock rule | P2 |
| Other merchant-of-record or marketplace connectors | Etsy and Pinterest built, not connected | reach and EU tax handling | each platform's API terms; build only after evidence | P3 |
| Speech (text-to-speech, transcription), video assembly (ffmpeg) | not found | video and audio courses | large scope; licences; only if an agent's venture needs it | P3 |
| SMS | proposed, dormant | verification codes, customer contact | cost; few legitimate uses so far | P3 |

**Rejected on principle:**
- CAPTCHA-solving services, anti-detection or "stealth" browsers, rotating proxies, account farming, fake-review or
  follower tools, scraping where terms forbid it.
- Any browser extension that hides automation.

These would break platform rules and the Fleet's own doctrine (truthful identity, no bots posing as humans).

## B. Fleet Command (owner management)

| Item | Today | Why | Priority |
|---|---|---|---|
| Phone push alerts for P1 events (self-hosted ntfy, or a Telegram bot) | not found; email and dashboard only | a stuck payment approval, a hold or an incident needs minutes, not hours | **P1** |
| Controlled-proof control from the dashboard (create, see and end an `economy-outward` release) | command line only | the first proofs are run by the owner | P2 |
| Bank and card reconciliation queue | not built (see bank-debit-card-requirements.md) | needed only with a bank card rail | with the card work |
| Per-agent and per-venture P&L, conversion and refund views | partial (Treasury, business folders) | judging channels and the proof | P2 |
| Weekly operating report (sales, spend, refunds, incidents, AI cost) | daily notification report exists | one page to decide on | P2 |

## C. Machine reliability and security

| Item | Today | Why | Priority |
|---|---|---|---|
| **Scheduled, encrypted, off-site database backups** (e.g. pgBackRest or restic), with a monthly restore drill | dumps taken only during releases; none scheduled or off-site | once real money exists, losing the ledger is unrecoverable | **P1** |
| **External uptime monitoring** with an alert to the owner's phone | not found | the server alerting about itself fails exactly when the server is down | **P1** |
| systemd `OnFailure=` alerts and watchdogs for critical units | `Restart=on-failure` only | know when a service keeps failing | **P1** (small) |
| Disk, memory, PostgreSQL and certificate-expiry alerts | the doctor checks TLS expiry on demand | prevent silent degradation | P2 |
| Metrics (node and PostgreSQL exporters; Prometheus and Grafana, or a lighter agent) | not found | trends and capacity | P2 |
| Off-host log shipping | journald and rotated audit files | evidence survives an incident on the host | P2 |
| Intrusion prevention and integrity (fail2ban or CrowdSec, auditd, AIDE) | SSH key-only and a firewall exist | defence in depth | P2 |
| A separate staging server for rehearsals | rehearsals restore a copy on the production host | removes any rehearsal risk to production | P3 |
| Second-region failover | none | only at a larger scale | P3 |

## Suggested order
1. P1 now, alongside the launch checklist: runtime upgrade, backups, uptime monitoring, phone alerts, `OnFailure`, the
   sending domain decision.
2. After the first controlled proof: the P2 items the proof showed were needed.
3. P3 only with evidence of need.
