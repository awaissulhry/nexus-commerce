# Reviewed safety release — C1 through C8

Final serving deployment: `0f89aa53-ce89-4518-91b6-76a5c2d68507`, **SUCCESS**,
commit `439d9e3d34ed79a09d76981da08de5d2ca0190e2`. Both GitHub jobs and the deployment
smoke test are **SUCCESS**. Final public/database verification repeated at **21:58 UTC**.
Sanitized release evidence: `build/RELEASE-2026-09-22-EVIDENCE.json` (kept locally; not in the public repo). This supersedes
older pending-deployment notes; the full channel plan remains open.

**Approved and deployed.** The Owner instructed: “Deploy it all and push to production.”
Final release commit: `439d9e3d34ed79a09d76981da08de5d2ca0190e2` on main. It contains
C1–C8 through `571371bfc`, compiler-memory repair `c54406b47` and CPU-aware test-worker
repair `439d9e3d3`. Each package passed independent review and normal push hooks.
At 21:54Z the native Railway deployment was SUCCESS and served `439d9e3d`; public
health/readiness returned 200 and protected diagnostics returned 401. GitHub CI is
SUCCESS. The Deploy API workflow and its final smoke test are also SUCCESS.
Full production evidence and remaining limitations are recorded below and in the
completion matrix.
The deployable range starts after `7c70556ea` and includes the inherited guarded
connection-delete package. Review/test detail: [CX-COMPLETION](build/CX-COMPLETION.md).
The full plan remains open in [COMPLETION-MATRIX](COMPLETION-MATRIX.md).

## Approved action (executed)

Recheck both worktrees and remote main, verify a fast-forward from the recorded base,
then make **one normal push from the isolated worktree to origin/main** with hooks.
This starts the existing deployment pipelines. Do not include shared `pes/phase-0`
history. Do not force-push, change environment variables or bypass a hook.

The API startup applies one additive migration:
`20260922a_cx_etsy_shop_alias`. It extends the existing alias function to include
connector-verified Etsy shop IDs and backfills only Etsy routing aliases. It preserves
the existing Shopify/eBay expressions, connection ownership and credentials.

Production behavior included in this approval:

- Reject execution of unverified replays; due rejected deliveries can move to DLQ.
- Resume non-dead auth-held queue work after account recovery, even when ordinary
  retries were exhausted. Existing stock/price/content work can consequently send
  under its existing account/publishing gates. The 20:38:30Z read found **zero** such
  FAILED/AUTH_REQUIRED rows in both profiles; that is a snapshot, not a permanent zero.
- Correct Etsy shop routing and event parsing; a valid configured delivery can read
  its receipt through the named account. Receipt ingestion is still unfinished.
- Hold unsafe Finances 2024 writes, retaining v0; comparison remains explicitly dry-run.
- Enforce conservative queue-policy checks and private owner rotation-failure notices
  if the existing rotation job is configured. No new rotation is manually requested.
- Correct eBay transport/status, but hold all currently unready topics before any
  setup call. Automatic provisioning also requires exact setup flag `1`.
- Expose the guarded delete capability, without executing any deletion.

This approval does not include running the separately prepared vendor probes,
creating subscriptions/webhooks, changing publish/Orders/token switches, exact-ten
deletion, reconnecting accounts, Finances cutover or any P7 drop.

## Verification and limits

Final full API on the release code: **11215 passed / 137 existing skips / zero failures
or unhandled errors**, 89.20s. Focused regressions, critical applied/restored mutations
and independent reviews are recorded per slice. The final canonical gate **passed on 571371bfc**: both builds, 4591 web tests,
124 security tests, 106 real PostgreSQL tests/zero skips, RBAC2724/zero unmapped,
and profiles-ON887files/41known failing/217tests, none new or worse. That last ratchet
retains existing unrelated failures; it is not an all-green profiles-ON claim.
All three normal pushes passed the unchanged hook. Actual GitHub CI on the final
commit also passed: 1,904 API regressions with four existing skips and 3,093 web
regressions. The runner reported one file worker for two CPUs. The earlier failed
runs are retained in CX-COMPLETION; no timeouts or assertions were relaxed.

The following production checks passed on the final commit at 21:54Z;
the existing `/api/health/ready` gate also passed. Read-only evidence:

1. The migration is finished with its exact committed checksum, and shop alias `57783036` maps exclusively to
   Motovento connection `cmubtwtad00ctmu01w4qsruxt`.
2. All 18 pre-existing connections retain their compared ownership, activity,
   primary/management state, external IDs, scopes, key IDs, auth state and encrypted
   credential-presence booleans. Non-Etsy route sets and aliases are unchanged.
   Shopify remains connected. All ten deletion candidates remain.
3. Protected diagnostic GET refuses anonymous access. Startup confirms automatic
   eBay setup disabled and Amazon rotation off because no credential queue is
   configured. No event or controlled failure was injected; actual replay/recovery/
   owner-notification outcomes still require observation or approved tests.
4. Browser-based interaction, Etsy publishing mode/signing-secret presence, real
   webhook delivery, stock/publication round trips and complete SLO evidence remain
   unverified. The database checks prove presence/state preservation, not token
   contents or validity. Existing Ads integrity alerts remain visible.

The baseline still served `7c70556e` at **20:49:11Z**, with existing critical Ads
integrity findings. Those are not a new-package regression or proof of complete health.

## Prepared rollback

If the new deployment fails readiness, retain the old serving deployment. For a new
serving regression in authorization, profile isolation, migration/routing or normal
request handling, restore the pinned Railway deployment:
`19ccdbb5-379e-4e17-b270-edca4b07e13f` (`7c70556ea631be3bcca0fcbd25d9397b719eca9e`).
Read-only API proof at **20:51:37Z**: SUCCESS, `canRollback:true`, `canRedeploy:true`.
Recheck availability immediately before recovery. Railway's documented
`deploymentRollback(id)` restores that image and its custom variables; the CLI's
ordinary `redeploy` targets the latest deployment and is not the rollback action.
If the image expires, the documented `deploymentRedeploy(id)` rebuilds that exact
deployment. Any recovery mutation needs the Owner's approval, either with this
release or separately. Source: https://docs.railway.com/integrations/api/manage-deployments .

The additive alias migration can remain on rollback; baseline code is compatible.
Do not remove applied migration history, undo production data or reset git history.
After recovery verify SUCCESS, serving build and the same profile controls, and
record that baseline code restores its older limitations, including setup scheduling.
