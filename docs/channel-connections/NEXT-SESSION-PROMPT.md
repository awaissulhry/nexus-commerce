Continue and finish the original Nexus channel-connections plan within our agreed scope: Amazon, eBay and Etsy. Shopify is connected; preserve it. P8/new channels remain deferred. I want production-quality completion, with measurable AAA standards. Improve the approach where evidence supports something better; do not blindly preserve a flawed plan or claim industry leadership without evidence.

1. Work safely in the existing isolated worktree:
   /private/tmp/nexus-channel-connections-20260922
   Branch: fix/channel-connections-20260922
   Last verified base/deployed main: 7c70556ea

   Run git status first in both this worktree and /Users/awais/nexus-commerce. The latter belongs to another session on pes/phase-0. Never push its history, stash its changes, stage with add -A, or bypass hooks. Work only in the isolated tree; stage files by name, commit per slice, and push once per reviewed package after required approval. A push deploys production. Inspect current history and remote main before integrating; do not assume the recorded base is still current. Preserve the two untracked cx-production-*.mts read-only probe scripts; do not blindly stage or run them.

2. Read, in order, from the isolated worktree:
   - docs/channel-connections/PROGRESS.md §0
   - docs/channel-connections/2026-09-22-HANDOVER.md
   - docs/channel-connections/FINAL-PLAN.md, especially packages, acceptance criteria, quality bar, decisions and Owner actions
   - docs/channel-connections/build/CX-CLEANUP.md and CX-DELETE-LIST.md
   - Relevant build records, research and source code as each remaining item requires.

   Historical summaries contradict newer evidence. Reconcile them; “BUILT” does not mean deployed, enabled, or verified end to end.

3. Critical Owner correction: I HAVE ALREADY CONNECTED ETSY UNDER A DIFFERENT BUSINESS PROFILE. Discover its owning profile through authorized read-only inspection. Do not assume Xavia Racing owns Etsy, ask me to reconnect it, or infer global absence from one profile. Verify its current scopes, four webhook registrations, account/workspace routing, listing counts and publishing mode separately. Do not move or copy credentials between profiles. Xavia Racing / nexus_legacy_workspace is the observed eBay profile. Browser API paths begin /backend/api/.

4. Establish the actual completion gap, then implement it. Build a requirement-by-requirement completion matrix covering the original plan and approved amendments: implementation, tests, deployment, production evidence, remaining action and approval dependency. Audit supposedly completed rows too, with evidence proportionate to risk. Do not stop after the audit or produce another plan without executing the authorized work.

   Known unfinished work includes:
   - Deploy and verify the existing connections package. Its final code slice is 4abb1a371; subsequent commits document the gate and handover. Do not rebuild the completed fixes.
   - Finish Amazon Finances migration safely: the new reader and duplicate-counting dry run exist, but v0 and the new API use incompatible identifiers. Measure an overlapping window only through the approved dry run, then implement/validate a safe cutover or reconciliation. Never compare by double-writing production money.
   - Complete eBay notification coverage against the actual application catalogue and documented payloads. ORDER_CONFIRMATION is documented; ITEM_SOLD is a legacy replay alias. Some topics still have handlerMissing and are skipped. Establish actual missing behavior and implement/test it before enabling subscriptions. Do not clear flags to manufacture completion. Preserve replay and retry semantics; verify real delivery after approval.
   - Diagnose the eBay Accounts discrepancy: 13 database connections versus 12 displayed.
   - Finish Etsy operation in its actual profile, including missing webhook setup, supported flows and six-hour freshness requirements; verify what is already done first.
   - Close remaining Orders activation, secret rotation, sandbox contract accounts, environment-token retirement, security/portal setup and other Owner items through evidence and the required approvals.
   - Finish justified P7 cleanup; retain live dependencies. P8 remains deferred.

5. Preserve the completed cleanup safety work. Production reads found 13 eBay rows but only TEN deletion candidates; the exact IDs are in CX-DELETE-LIST.md. Retain cmr4aaqb00025nz016k18rup9, cmt0ksbbs01r4mo01c9diw1qp and cmt142bli01vcp4010fjo2k13. Encrypted credentials can exist with both plaintext refresh columns empty. hasEncryptedCredentials must remain boolean-only; never expose or decrypt credentials for diagnostics. Report and delete share dead-row eligibility; deletion also locks the row and reruns complete dependent counts with isSafeToDelete() in the same transaction. Never clear credentials or detach dependents merely to pass deletion guards. Saved evidence is timestamped, not fresh authorization.

6. Make AAA concrete. Use current official vendor contracts and supported versions. Prioritize correct money/stock calculations, strict account/profile isolation and RBAC, encrypted credentials, idempotency, concurrency safety, bounded retries/rate limits, accurate errors, recoverable event processing, and observable failures. Define measurable acceptance criteria before changing each flow. No silent success, invented API contracts, unsupported defaults, unbounded work, or cosmetic completion flags.

   Reproduce defects before fixing them. Use behavioral tests, positive/negative controls, real PostgreSQL tests for locking/RLS/races, applied-and-restored mutations for critical safety rules, and independent review. Follow the repository's test/database guards and print the target host before database work; tests and migrations stay local. Never weaken tests, timeouts, ratchets or hooks. For UI work, read DESIGN.md and relevant source, use apps/web/src/design-system, mirror shared changes into apps/factory, and verify keyboard, responsive and light/dark behavior in a real browser.

   Amend implementation decisions autonomously when reversible and within scope. Record material changes with the defect in the old approach, official evidence, alternatives, tradeoffs and acceptance tests. Do not add complexity merely to pursue “best in industry”; demonstrate improvements against explicit criteria. Scope changes and irreversible business decisions require agreement.

7. Verification baseline: 59 focused tests passed; independent review approved; canonical pre-push gate passed on 4abb1a371, including 101 real PostgreSQL tests across nine suites, zero skips. Full API: 11066 passed, six baseline Amazon failures, 132 skipped. A separate push-lock audit failure predates this package. One earlier full run had transient database-suite failures; the diagnostic rerun returned to the baseline. Details are in CX-CLEANUP.md. Reproduce/diagnose relevant failures; fix in-scope defects and report unrelated blockers honestly. Do not relabel new failures as baseline. Run appropriate checks after changes and retain the normal release hooks.

8. Approval boundaries remain in force. This prompt authorizes investigation, local implementation, tests, review and justified plan amendments. It does not approve deployment/production writes, exact-ten deletion, live channel calls, or P7 drops. No such approvals arrived in the preceding session. Preserve other Owner-only actions in the handover. Prepare concrete reviewed actions, explain why permission is required, and ask for bounded approvals; continue independent authorized work while waiting. Each P7 drop needs its own approval and evidence of the required green week. Do not reconnect Amazon Ads or eBay simply because an older plan says to.

9. Keep progressing until all authorized work is complete. After approved deployment, verify Railway SUCCESS and the exact serving commit at /api/health, then validate the relevant flows in the correct profiles. The last verified API origin was https://nexusapi-production-b7bb.up.railway.app; api.xavia.it had no DNS. Do not confuse a healthy baseline response with this package being deployed or every integration working. Record timestamps and limitations. Finish with an honest acceptance matrix: completed and proven, implemented but awaiting validation, awaiting explicit approval/observation, and deliberately deferred. Keep the plan and handover current throughout.
