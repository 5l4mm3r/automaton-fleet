# Release c71ef0a (controller only; schema 96 unchanged; UI 0.26.2) — the consent form in a real browser; NOT INSTALLED

**Defect (live 2026-10-19, during the purchase proof):** ticking both "Before you pay" boxes and pressing Confirm answered
`{"ok":false,"reason":"cross-site request refused"}` before PayPal opened. **Reproduced** with Chrome (playwright-core,
/usr/bin/google-chrome) through `https://api.agentfleet.vip/order/<token>`: the browser sent `Origin: null`, no Referer and
`Sec-Fetch-Site: same-origin` (the pages' Referrer-Policy was no-referrer); the server answered 403. Not a proxy problem: Host
is the public name. The refused POST changed nothing (the order stayed unpaid, no consent recorded).

**Fix (c71ef0a):** pages send Referrer-Policy same-origin (the origin reaches this site only); a POST is accepted when its
Origin (or Referer) names this host, or with `Origin: null` when the browser marks it `Sec-Fetch-Site: same-origin`.
Cross-site, same-site (another subdomain), `none` and unmarked requests stay refused; a claimed origin never overrides the
browser's cross-site mark. Tests (both fail without the fix with the live error): the header matrix incl. exactly Chrome's
headers (fleet-v82-public-consent) and a **real Chrome submission of the consent form** against the real handler as the
service role, consent recorded (fleet-v96-public-routes-service-role-pg).

| Item | Result |
|---|---|
| Pins | commit c71ef0a191c2935bc0afe95b391e2d67c9d963d7 · build b55eec5e51dd561df41593f33317aaa1b2a73fef9e0e16e78b87752f5377a84d · lockfile 1df54e35… — VPS = local |
| Data rehearsal 96 → 96 | PASSED 14:43:54Z (no migration; reconciliation OK; ledger verifies; rollback dump restores the same head) |
| Services rehearsal 96 → 96 | PASSED 14:44:45Z (candidate ready on 96; history check: 28 copies due, none older than 7 d 2 h, none left after the pass; code-only rollback: cb23033 re-approved on the unrestored data, every candidate-era write kept) |
| Install | `ssh -t agentfleet-vps 'bash ~/rlc107/install-fix.sh'` (owner-run): controller only; Agent-1 stays on cb23033 with the running proof (order, run budget, watchdog) untouched; Agent-2 paused; no permission opened; the proof script learns the new controller after success. Verify: `bash ~/rlc107/verify-fix.sh` (public site; never submits consent on the real order) |
| Rollback | code-only: re-approve cb23033 (proven in the services rehearsal); the database is never restored over real transactions |
