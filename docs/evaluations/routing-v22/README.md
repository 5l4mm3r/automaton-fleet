# v22 neutral cognition routing — controlled deployment and real-API verification (2026-09-30, VPS UTC)

Release `b8e8e9a` (build `d9aae683…039f`, lockfile `eee9dc2f…`), schema v21 → v22. Evidence: `models.json`,
`verify.json` (structure-only request observation; no content, no headers), `production-after.txt`.

## Models API (free), 10:43:55–56 — deployed runner as the service user
| Tier | Model | Status | Request id | Thinking types | Effort | Context / out |
|---|---|---|---|---|---|---|
| T1 | claude-haiku-4-5-20251001 | 200 | req_011CfZVBE2MmroLbAfnUXFKh | enabled only | none | 200K / 64K |
| T2 | claude-sonnet-5-5 | 200 | req_011CfZVBFjZ8CLJ3ZddFfYLq | adaptive | low…max | 1M / 128K |
| T3 | claude-opus-5-5 | 200 | req_011CfZVBGkpV8uFvTAZMaGF3 | adaptive | low…max | 1M / 128K |

## Real routed calls (deployed `inferRouted` + `routedProviderFactory`; in-memory ports: no founder/log/ledger)
Prompt cache: `prefix` as a verification-only override (controller setting: off). One HTTP attempt per call; every
response model = the authorized model.

| # | Route | Model / thinking / effort | In | Out | Thinking | Cache write | Cache read | Cost µ¢ | Request id |
|---|---|---|---|---|---|---|---|---|---|
| 1 | T1 extraction (compact context, 0 tools, 874 B) | Haiku / none / none | 160 | 35 | — | 0 | 0 | 33,500 | req_011CfZVCCUsUa5QdJdzRXTcm |
| 2 | T2 agent_step | Sonnet / adaptive / medium | 103 | 27 | 0 | 3,574 | 0 | 941,100 | req_011CfZVCGWi8wDmq2PiYBsdv |
| 3 | T2 agent_step (new tail) | Sonnet / adaptive / medium | 108 | 33 | 0 | 0 | 3,574 | 126,080 | req_011CfZVCMfmoKdAZScxCSNcj |
| 4 | T3 escalation (1 decision packet, scope question) | Opus / adaptive / medium | 699 | 527 | 293 | 3,574 | 0 | 3,120,600 | req_011CfZVCT1zN8tvoPnPdcKQR |
| 5 | T2 agent_step after escalation (3 msgs incl. Opus answer) | Sonnet / adaptive / medium | 346 | 195 | 132 | 0 | 3,574 | 335,680 | req_011CfZVD37LakVG8pYahcnm6 |

- **Total 4,556,960 µ¢ = $0.0455696** (ceiling $0.25); GBP equivalent £0.0344 at the controlled rate 0.754893
  (rate id 15, ECB 2026-09-29). Recorded as owner/evaluation provider-credit adjustment −$0.05 (rounded up; exact µ¢
  in the reference) at 10:44:50. Not founder expense/revenue/profit.
- Cost reconciles exactly to each tier's prices (e.g. #2: 103·200 + 27·1000 + 3574·250).
- **Cache:** the founder prefix (charter + 16 tools) is 3,574 tokens. Sonnet 5.5 wrote it once and read it on #3 and
  #5 (saving 643,320 µ¢ each vs uncached; net +1,107,940 µ¢ over three Sonnet calls after the write premium). Opus 5.5
  also cached it (model-scoped) but a single escalation never reads it back: −357,400 µ¢ write premium. Haiku (#1):
  compact 160-token prompt, below Haiku's 4,096 minimum, not padded, no cache write.
- **Thinking:** Opus produced a signed thinking block (#4); the Sonnet request (#5) carried no signature (stripped).
- **Routing returned downward:** #5 routed T2 after the T3 question.
