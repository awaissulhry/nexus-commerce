# Reviewed safety release — C1 through C8

**Prepared, not deployed or approved.** Code is committed through `571371bfc` on
`fix/channel-connections-20260922`. Documentation may follow without code changes.
The deployable range starts after `7c70556ea` and includes the inherited guarded
connection-delete package. Review/test detail: [CX-COMPLETION](build/CX-COMPLETION.md).
The full plan remains open in [COMPLETION-MATRIX](COMPLETION-MATRIX.md).

## Concrete action for approval

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
The normal push will rerun the same hook. No push has occurred.

After an approved push, verify Railway SUCCESS and the exact commit from `/api/health`;
the existing `/api/health/ready` deployment health gate must pass. Then read-only:

1. Confirm the migration is finished and shop alias `57783036` maps exclusively to
   Motovento connection `cmubtwtad00ctmu01w4qsruxt`.
2. Confirm Xavia Shopify and both profiles' existing connections/credential-presence
   booleans retain their owners and state; all ten deletion candidates remain.
3. Check authorization on protected diagnostic reads, the eBay setup hold, new
   runtime errors, inbound outcomes and outbound recovery without injecting an event
   or invoking a vendor operation.
4. Record unavailable browser/runtime-switch observations explicitly. Database proof
   and health do not substitute for webhook delivery, publication or complete SLO proof.

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
