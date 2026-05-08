# Phase B verification — Amazon + eBay publish gate rollout

This is the operator-driven sequence for taking the syndication
channel-write surfaces from "shipped & gated" to "live & published."
The H.1 protocol called for **dryRun → sandbox → canary → graduated**
in that order. This doc is the 5-minute checklist + commands.

Code is ready as of commit `4ac79bd`. All three channel-write
surfaces (wizard publish, outbound sync, eBay markdown / campaign
push) honour the same env-var pair per channel. Defaults are gated
+ dry-run — every attempt writes to `ChannelPublishAttempt` with
`outcome='gated'` and never touches the channel API.

## Phase B.0 — sanity check

Before flipping anything, confirm the audit table is reachable + empty
(or contains only gated rows from the dormant default state):

```bash
node scripts/audit-channel-publish-attempts.mjs
```

Or from the UI (M.7):

> Open **`/listings/publish-status`** — same eight blocks as the CLI,
> polled every 30 seconds. The "Publish gate · env" card at the top
> shows what the running API thinks the master flag + mode are right
> now (handy for confirming a Railway env-var change has propagated).

Expected output: sections 1–3 should be empty or show only `gated`
outcomes. Sections 4–7 should be empty. If you see anything else,
something has been pushing real HTTP — investigate before
continuing.

## Phase B.1 — Amazon dry-run

Goal: prove the wizard composes a valid SP-API payload + emits
audit rows + does NOT make HTTP.

1. Open Railway → service environment → set:
   ```
   NEXUS_ENABLE_AMAZON_PUBLISH=true
   AMAZON_PUBLISH_MODE=dry-run
   ```
2. Wait for the service to redeploy (Railway auto-redeploys on env
   changes; verify by hitting `/api/health` returns `healthy`).
3. Open `/products/{id}/list-wizard` for one Xavia SKU. Pick AMAZON
   as the target channel + IT as the marketplace. Walk through every
   step. Submit.
4. Verify the wizard's submissions array shows
   `status='LIVE'` for the Amazon entry with a `submissionId` of
   `dry-run-…` (synthetic).
5. Run the audit:
   ```bash
   node scripts/audit-channel-publish-attempts.mjs
   ```
   Section 1 should show `AMAZON / dry-run / success` with attempt
   count = 1 + N (parent + children).
6. **Hard verify no HTTP:** Railway logs should NOT show
   `PUT listings item to SP-API` (only the dry-run log line:
   `SP-API putListingsItem (dry-run, no HTTP)`).

If section 1 is empty after a wizard submit, the env vars didn't
take. Section 1 with `outcome='gated'` instead of `success` means
the master flag didn't flip — verify the `NEXUS_ENABLE_AMAZON_PUBLISH`
spelling exactly.

## Phase B.2 — Amazon sandbox

Goal: real HTTP round-trip against `sandbox.sellingpartnerapi-eu-west-1.amazon.com`.

Prerequisite: set up an Amazon SP-API sandbox seller (separate set
of LWA credentials from production). See
[Amazon SP-API sandbox docs](https://developer-docs.amazon.com/sp-api/docs/the-selling-partner-api-sandbox).

1. Replace `AMAZON_LWA_CLIENT_ID` / `AMAZON_LWA_CLIENT_SECRET` /
   `AMAZON_REFRESH_TOKEN` on Railway with the sandbox credentials.
2. Set `AMAZON_PUBLISH_MODE=sandbox`. Leave the master flag at `true`.
3. Run another wizard submit on a low-risk test SKU.
4. Audit again:
   ```bash
   node scripts/audit-channel-publish-attempts.mjs
   ```
   Section 1: `AMAZON / sandbox / success` with a real `submissionId`
   (Amazon-issued, not `dry-run-`). Verify Railway logs show
   `PUT listings item to SP-API` with the sandbox host URL.
5. SP-API's sandbox returns deterministic test data — confirm the
   wizard's submission entry has the expected mock parentAsin /
   childAsinsByMasterSku.

## Phase B.3 — Amazon canary (live)

Goal: one real listing, monitored 24-48h.

1. Restore production LWA credentials on Railway.
2. Set `AMAZON_PUBLISH_MODE=live`. Master flag still `true`.
3. Pick **one** low-risk SKU — ideally something you'd be OK seeing
   live on Amazon IT for a day. Run the wizard end-to-end.
4. Verify on Amazon Seller Central: the listing is visible with
   the expected attributes, ASIN, price, stock.
5. Audit again — `AMAZON / live / success` should appear.
6. **Wait 24–48 hours.** Monitor `ChannelPublishAttempt` for any
   downstream failures (the outbound-sync queue may push price/qty
   updates after the initial publish).
7. If clean: graduate to 5 SKUs, monitor, then 25, then full catalog.

## Phase B.4 — eBay (mirror of B.1–B.3)

Same shape as Amazon, with eBay env vars:

```
NEXUS_ENABLE_EBAY_PUBLISH=true
EBAY_PUBLISH_MODE=dry-run     # then sandbox, then live
```

eBay sandbox uses different OAuth credentials than production. The
operator workflow per the C.7 design: create a separate
`ChannelConnection` row for sandbox, mark it active when running
Phase B.4.2 (sandbox), switch back to the production connection
for Phase B.4.3 (canary).

eBay-specific verification: Phase B.4.3 canary should produce a real
eBay listing (visible in Seller Hub) with a 12-digit item ID. The
wizard's submissions array exposes that ID via
`submissions[i].submissionId` once the publish lands.

## Rollback

At any point, set the master flag back to `false`:

```
NEXUS_ENABLE_AMAZON_PUBLISH=false
NEXUS_ENABLE_EBAY_PUBLISH=false
```

After redeploy, every subsequent attempt logs `outcome='gated'` and
never touches the channel API. Existing audit rows are preserved
(forensic value); no DB rollback needed. Previously-pushed listings
on Amazon/eBay stay live — Nexus just stops touching them.

## Known gaps (deferred per roadmap)

- Real channel push for **Promoted Listings campaigns** (C.16) —
  CRUD UI ships local-only DRAFT campaigns; eBay Marketing API push
  lands as a follow-up commit gated behind the same flag.
- Real channel push for **markdowns** (C.17) — same shape as
  campaigns above.
- **AI suppression diagnosis** (V.3) — not strictly part of Phase B
  but planned to land alongside.
- **Best Offer manager + auto-relist** — needs new ChannelListing
  columns; scaffolding placeholder visible in the markdown manager.
