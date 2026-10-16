# Agent capability map: workflow → capability (2026-10-16)

From the code, the installed host and the tests. **The deciding fact:** both agents run runtime **b60e262** (12 October,
doctrine founder-v6, toolset-2). Its exec sandbox has no access to the installed toolchain (no `toolsDir`), and it lacks
`offer`, `customers`, `deliverable`, `independent_review`, `business`, `view_image` and the browser's file and render
operations. **Everything below marked "toolset-5" reaches Agent-1 only after its runtime upgrade.**

Tools installed for Claude Code are not Fleet tools. An agent has exactly its runtime's tool list, its sandbox (Landlock:
workspace-only writes, no network, 30 s per exec) and the controller's gateways.

## Matrix

| Workflow | Implementation | Runtime | Installed / provider | Limits | Evidence |
|---|---|---|---|---|---|
| Demand discovery, sources | `web_fetch` (HTTPS GET, 2 MB, 20 s; text/HTML/JSON), `opportunity`, `open_decision` with evidence; each fetch kept with its sha256 | all | no search API; sites' own search pages only | no PDF via web_fetch (the browser can, toolset-4+); per-agent quotas | `fleet-research.test.ts` |
| Browser research; account / profile operation | `browser` (worker), identity accounts and vault fill | basic: all; files, render, download: toolset-4+ | worker installed and isolated | outward actions held until sales open or a release; CAPTCHA, selfie and passkey need a human; platforms' terms decide | `fleet-browser-pg`, `fleet-v79-business-operator-pg` |
| Official platform APIs | `business api` → channel gateway (Etsy v3, Pinterest v5) | toolset-5 | gateway installed; **no account connected** | tested against simulated platforms only | `fleet-v80-channels-pg` |
| Brand assets, graphics, visual inspection | Pillow; HTML/SVG rendered in the browser (`set_content` → screenshot / pdf); `view_image` | toolset-4+ | installed | **no image-generation model** (PROVIDER); a view costs about 1,600 tokens | `fleet-v79-vision-tools`, inspector tests |
| Spreadsheets | openpyxl, XlsxWriter, `formulas` (recalculation), numpy / scipy / numpy-financial; inspector: macros and external links refused, recalculation errors and saved≠recalculated values FAIL, agent "cases" | toolset-3+ | installed | charts counted, not rendered; 60 s / 50k-formula recalculation cap | `fleet-qa-inspector`, `fleet-v76-e2e-demonstrations-pg` (12-month forecast) |
| PDF, Word, courses, zip | reportlab, pypdf / pypdfium2, python-docx, pyspellchecker; inspector: PDF text, fonts and first pages rendered (blank page FAILs), DOCX structure, placeholders and spelling, zip safety | toolset-3+ | installed | DOCX not rendered; no matplotlib, EPUB builder, OCR or LibreOffice | inspector tests; e2e course bundle |
| Presentations | python-pptx builds them | toolset-3+ | installed | **.pptx is not a deliverable or upload type; slides are not text-checked or rendered; independent review sees "(binary file)"** → deliver as PDF (guidance v9) | none for pptx |
| Software development and maintenance | `exec` in the sandbox | all | — | no network (no git remote, no package install), 30 s, intake only a ≤5 MB zip from the buyer, no secret channel, no deploy authority | `fleet-exec-sandbox` |
| Briefs, quotes, revisions, delivery, support, refunds | `customers`, `offer` (capacity, revisions, terms), `deliverable review` gates publishing; `wallet deliver` / `refund`; mail via Proton | toolset-3+ | installed; mail running | **refunds need PayPal money-out (custody), which is OFF**; nothing proven live | `fleet-v76-market-fulfilment-pg`, `fleet-refunds-v59-pg` |
| Attribution, conversion, costs, net profit | business channels and links, presence, leads, report_sale / claim_payout, `fleet_business_performance`, venture P&L | toolset-4+ | installed | no page-view analytics; **no support-burden metric; AI cost not attributed to venture / channel** | `fleet-v79-business-operator-pg`, F2 accounting |
| Shared learning vs private records | `economic_knowledge` (reviewed proposals, personal data scrubbed), private `field_journal`; customer data stays with orders / leads | all | — | keyword search only; the scrub does not remove names | `fleet-lifecycle-knowledge-pg`, `fleet-v67-foundation-pg` |

## Before Agent-1 makes customer commitments: the baseline

**Owner, blocking:**
- Agent-1's runtime upgrade (agents paused);
- public site and legal seller;
- a controlled release for the proof;
- PayPal money-out for refunds.

**Build (the agent capabilities package), local and testable:**
1. **Capability check before quoting:** an agent tool that reports its runtime toolset, installed libraries, inspector
   version, deliverable and upload file types and size caps, exec limits, network status, and channel and money-out
   states. The doctrine requires it before `customers quote` and `offer create`.
2. **Justified capability request:** an agent-callable op that records the need, the evidence and the offer or venture it
   blocks (extending `fleet_capability_demands`). Today `record_external_dependency` only accepts identity / KYC / legal /
   constitutional / credential kinds. This is a request, never an approval gate on ordinary business.
3. **Presentations as a real deliverable:** .pptx in the delivery, storefront and upload types; inspector checks (slides,
   text placeholders and spelling, empty slides, overflow, alt text); a pptx branch in independent review; rendering of
   DOCX / PPTX to images (a pinned headless converter).
4. **Toolchain additions, pinned and hash-verified:** matplotlib (chart images for PDFs and courses), Tesseract + pytesseract
   (scanned briefs), an EPUB builder. The inspector gets EPUB OPF / nav checks and renders xlsx charts.
5. **Support burden and AI cost per order and venture**, so net profitability includes the work each sale took.
6. **Provider adapters with setup screens, not connected:** web search API and image generation. Paid; chosen by the owner
   when evidence shows the need.

**Software maintenance: an assessment, no ban.** Offering it needs:
- scoped customer authority (a per-order repository grant in the vault, used without the agent seeing it, expiring with
  the order);
- a separate build sandbox with egress allowed only to the repository host and package registries, and longer limits;
- the buyer's tests as acceptance evidence bound into the review;
- delivery as a patch or branch, never a direct production deploy, with a rollback note.

Until those exist, the feasible scope is "zip in, patch and tests out, offline".

## Initial offers the machine can genuinely produce and verify (after the upgrade)
Spreadsheets and workbooks (recalculated and case-tested), PDF guides and documents (rendered and checked), downloadable
courses (PDF + workbook bundles), templates, and presentations delivered as PDF. Each offer must pass `deliverable review`
on the exact files. The Fleet refuses to publish without it.
