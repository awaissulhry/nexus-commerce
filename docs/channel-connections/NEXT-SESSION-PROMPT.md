Continue the remaining Nexus channel-connections work. Scope: Amazon, eBay and Etsy. Preserve connected Shopify. P8/new channels remain deferred. Implement and prove the remaining requirements; do not restart another planning-only exercise or trust historical “all built” labels.

1. Start with git status in both worktrees:
   - Work only in /private/tmp/nexus-channel-connections-20260922, branch fix/channel-connections-20260922.
   - /Users/awais/nexus-commerce belongs to another session on pes/phase-0. Never push its history, stash its changes, use git add -A, or bypass hooks.
   - Preserve the two original untracked cx-production-*.mts scripts; do not blindly stage or execute them.
   - Stage files by name, commit per slice and push once per reviewed, approved package. Inspect actual history and remote main before integrating.

2. Latest release is DEPLOYED AND VERIFIED, not pending approval:
   - Main/code release: 439d9e3d34ed79a09d76981da08de5d2ca0190e2.
   - Final Railway deployment: 0f89aa53-ce89-4518-91b6-76a5c2d68507, SUCCESS.
   - At 2026-09-22 21:58 UTC, /api/health and /api/health/ready returned 200 and build439d9e3d. Protected diagnostic GET returned401.
   - GitHub CI35788316974 and Deploy API35788316766, including its smoke test, are SUCCESS.
   - The Owner explicitly instructed “Deploy it all and push to production.” This covered C1–C8 and necessary release repairs. Do not ask for that approval again or redeploy unchanged code.
   - The isolated branch may have a subsequent evidence-only commit. Read its diff; do not mistake documentation for an unshipped code slice.
   - Evidence: docs/channel-connections/build/RELEASE-2026-09-22-EVIDENCE.json. Current origin: https://nexusapi-production-b7bb.up.railway.app. api.xavia.it was not serving.

3. Read PROGRESS.md §0, 2026-09-22-HANDOVER.md, COMPLETION-MATRIX.md, FINAL-PLAN.md and build/CX-COMPLETION.md. Then the relevant original build records. All paths are under docs/channel-connections in the isolated worktree. The matrix distinguishes implementation, deployment, enablement and production proof. Keep it current.

4. Do not reconnect or relocate Etsy:
   - ItalianHideCraft, shop57783036, belongs to Motovento workspacebf0047bf-e1d9-48d0-8cc6-20e94bb734dd, connectioncmubtwtad00ctmu01w4qsruxt.
   - Its externalAccountId1051233836 is a USER identifier, not the shop identifier.
   - Production migration20260922a_cx_etsy_shop_alias finished with its exact committed checksum. The shop alias resolves exclusively to Motovento; this is production-proven.
   - All18 pre-existing connections retain compared owner/state/scopes/key-ID/credential-presence fields; non-Etsy aliases are unchanged. Xavia Shopify remains connected (93 stored scopes); Etsy retains12 scopes.
   - Credential presence is not proof of unchanged credential contents or validity. Never decrypt/expose credentials for diagnostics.
   - Earlier signed-in Etsy portal inspection showed zero endpoints and four actual events: order.paid, order.canceled, order.shipped, order.delivered. The census showed zero local listings/events and37 successful account-attributed calls in24h. These are dated observations; publishing mode and signing-secret configuration still lack proof. Browser access later became unavailable; do not infer absence from that.

5. Completed safety slices—do not rebuild them:
   - C1 rejects unverified manual/worker replay.
   - C2 uses the official Etsy event/resource URL contract, binds receipt reads to the account/shop and adds the verified shop alias.
   - C3 repairs eBay payload selection, bounded pagination, destination/subscription contracts and truthful reconciliation status.
   - C4 corrects Amazon ORDER_ID/provider transaction identity and account/window traversal; comparison measures identity/order overlap only. Unsafe Finances2024 writes are held; v0 remains operational.
   - C5 preserves auth-hold retry budgets and the original Shopify dispatch mapping.
   - C6 fixes Amazon test fixtures and Vitest console-RPC transport while retaining real unhandled-error failure.
   - C7 adds private rotation-failure owner notifications and conservative static queue-policy checks.
   - C8 honestly holds every currently incomplete eBay topic before any setup call and requires exact NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1 for scheduling. Startup proves setup OFF. Rotation startup proves OFF because no credential queue is configured.
   - Release repairs: compiler-only4GiB old-space limit; CPU-aware file workers, capped1–4. Runtime, tests, assertions, timeouts and hooks were not weakened. Local18CPUs→4workers; actual CI2CPUs→1worker.

6. Remaining engineering is substantial and still authorized locally:
   - eBay: durable receipt insertion and fenced execution claims, crash recovery, scoped dispatcher/replay, persisted ownership after route removal, recoverable revocation and a newer-grant fence. Current order ingestion inserts lines before stock and swallows stock failures; merely awaiting it is unsafe. Build one transactional writer shared by polling and webhook replay. Parse notification.data.order.orderId. Never sweep every account for one replay. Erasure remains unimplemented; preserve authoritative buyer identifiers and settle fiscal-retention policy before destructive anonymization. Keep handlerMissing until actual behavior is proved.
   - Etsy: transactional receipt normalization/ingestion/polling is still missing; the current receiver reads a receipt then logs the missing ingester. Use exact money/divisors, validated quantities, stable line identities, monotonic state, account/shop checks and atomic stock effects. Owner questions about reserve/consume timing and historical opening boundary remain unanswered. Finish freshness accounting and supported publishing proof before activation.
   - Finances: approved overlap measurement, exact monetary mapping, durable identity uniqueness, historical null account attribution, legacy/new race proof and safe cutover remain. Never double-write production money to compare.
   - Contract coverage is partial, eBay price readback is missing, the studio error pane remains unfinished, and Orders/secret/KMS/security/portal/environment-token operational items still need their individual proof and approvals. Respect other programmes’ ownership.

7. Approval boundaries still apply to remaining actions:
   - Local investigation, implementation, tests, independent review and justified reversible amendments are authorized.
   - Separate vendor probes, live channel activation/writes, exact-ten deletion, future deployment packages and each P7 drop need their existing approvals. The completed release approval is not blanket approval for these.
   - scripts/channel-connections-read-probe.mts describes two reviewed reads; neither was executed. Amazon: Xavia accountcmothu9bo0000nz01asw6wx8j, IT/APJ6JRA9NG5V4, Sep20 00:00Z–Sep21 00:00Z, dryRun only; four legacy rows lack account attribution. eBay: application topics/destinations/subscriptions; USER subscriptions remain separate. Execution needs approval including ordinary OAuth/gateway bookkeeping.
   - Exact-ten deletion list is build/CX-DELETE-LIST.md. Preserve cmr4aaqb00025nz016k18rup9, cmt0ksbbs01r4mo01c9diw1qp and cmt142bli01vcp4010fjo2k13. Shared eligibility, encrypted-presence checks, locked fresh dependent counts and isSafeToDelete must remain. Never clear credentials or detach dependents to pass guards.
   - The13/12 eBay discrepancy is explained by the retained transferred Motovento tombstone and the Accounts query. Browser count was not freshly re-measured.
   - Each P7 drop needs a green week after dependency retirement and its own approval. P8 is deferred. Do not reconnect Amazon Ads/eBay because an old note asks for it.
   - Prepare concrete reviewed actions before asking, and continue independent authorized work while waiting.

8. Verification discipline:
   - Full API on C1–C8:11215 passed,137 existing skips,zero failures/unhandled errors. Canonical gates on every push passed both builds,4591web,124security,106realPostgreSQL/zero skips,RBAC2724/zero unmapped. Profiles-ON ratchet:41 known failing files/217tests,none new/worse—not an all-green profiles-mode suite.
   - Final actual CI:1904 API regressions/4 existing skips and3093web regressions, all passing. Retain the earlier failed runs and documented repairs; do not relabel them green.
   - Reproduce defects, retain positive/negative controls, use real PostgreSQL for RLS/locks/races, apply-and-restore critical guard mutations, and obtain independent review. Never weaken assertions, timeouts, ratchets, tests or hooks.
   - Tests/migrations stay local. Run API tests from apps/api, print the target host and honor database guards. Shared-root .env is production. Authorized production inspection uses pinned targets and read-only transactions; no credential disclosure.
   - pg’s default parser previously subtracted two hours from UTC timestamp-without-time-zone columns. The probe now parses UTC explicitly and checks the database clock. Old counts/identities were unaffected; do not infer a scheduler outage from those old serialized timestamps.
   - Existing Ads integrity alerts and five quantity mismatches remain. No zero-error, full SLO, credential-validity or channel end-to-end claim follows from public health. Runtime log samples are bounded, not a complete error census.
   - For UI changes read DESIGN.md/AGENTS.md, use the shared design system, mirror required factory changes, and verify keyboard/responsive/light-dark behavior in a real browser.

9. Finish each next package with specific evidence, a current matrix/handover and precise remaining approval/observation dependencies. After an approved future deployment, verify Railway SUCCESS, exact serving build, protected routes and the affected business profiles before calling it deployed. Do not claim the whole plan complete or “best in industry” without proof.
