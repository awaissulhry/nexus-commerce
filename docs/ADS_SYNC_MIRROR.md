# Amazon Ads ↔ Nexus mirror

How faithfully and how quickly the local platform reflects what's on Amazon's advertising console, and how to operate it. Goal: **whatever is on the Amazon campaign advertising page is on our platform.**

There are two directions:

- **Outbound (local → Amazon)** — our edits/creates are written locally **instantly** (the "gated-local" pattern) and pushed to Amazon through `OutboundSyncQueue` + the BullMQ `ads-sync.worker` (with a 1-min `ads-sync-drain` cron fallback), guarded by `checkAdsWriteGate` (env=live + connection `writesEnabledAt` + per-campaign allowlist + per-write €cap). A locally-created entity is visible in the app immediately; the live push happens when the gate is open.
- **Inbound (Amazon → local)** — pulled on a schedule via the Amazon Ads APIs (Amazon offers no usable real-time push for *structure*; AMS streams *metrics* only — see below). Frequent polling is the freshness lever.

## Inbound mirror — what syncs and how fresh

| Entity | Source | Cadence (default) | Env override |
|---|---|---|---|
| Campaigns / ad groups / product ads | v1 export ingest | **every 2h** (was 6h — H.10) | `NEXUS_ADS_V1_EXPORT_CREATE_SCHEDULE` |
| Positive keywords + **ad-group negatives** + product/auto targets + bids | v3 list resync (`resyncAllCampaignKeywords`) | **hourly** at :45 (was 6h — H.10) | `NEXUS_ADS_KEYWORD_BID_RESYNC_SCHEDULE` |
| **Campaign-level negatives** | v3 `/sp/campaignNegativeKeywords/list` (in the hourly resync — H.8) | **hourly** | (same as above) |
| Budgets / bid strategy / placement bids | v3 campaign-settings sync | every 20 min | `NEXUS_ADS_SETTINGS_SYNC_SCHEDULE` |
| Performance metrics | Reports API | T+1 (daily); hourly via AMS if enabled | `NEXUS_ADS_REPORT_*` |

**On-demand refresh** — to pull Amazon's current keywords, negatives (both levels), targets, and reconcile deletions *right now* without waiting for the tick:

```
POST /api/advertising/cron/keyword-resync/trigger
```

## What H.7–H.10 changed

- **H.7** — harvest negatives (waster + isolation) now persist a **local mirror row** the instant they're created (campaign-scoped `AdTarget`, `negativeLevel='CAMPAIGN'`), consistent with how graduated keywords already persisted. The Amazon push (`createNegative`) still fires first, so its idempotency probe isn't pre-empted.
- **H.8** — campaign-level negatives now **sync FROM Amazon** (`/sp/campaignNegativeKeywords/list`), folded into the hourly resync. They reconcile against H.7 local rows by Amazon id, then by `(campaign, matchType, text)` — so a locally-created negative gets its Amazon id **stamped, not duplicated**, and Amazon-native campaign negatives appear locally.
- **H.9** — **deletion reflection**: a keyword / negative we hold locally *with an Amazon id* that Amazon's current list no longer returns is **archived** (soft, reversible). Two safety guards:
  - **Fetch-success gating** — a failed/errored list call never drives deletion (empty-on-error ≠ deleted).
  - **Circuit-breaker** (`archiveAllowed`) — never archive an implausible fraction of a scope's live rows in one pass; a suspicious bulk "deletion" is skipped + logged instead.
  - **Gated-local rows are never archived** — entities with no Amazon id yet (created locally, not pushed) are exempt; their absence from Amazon is expected.
- **H.10** — freshness: hourly v3 resync (carries the negative mirror + deletions), 2h structure export, plus the on-demand refresh trigger above.

## Real-time caveats (Amazon-imposed)

- **Structure** (campaigns/ad-groups/keywords created or deleted on Amazon) has **no usable real-time push** — Amazon's entity-change stream is gateway-blocked in this account. Frequent polling (hourly / 2h) is the lever; use the on-demand trigger when you need it now.
- **Metrics** *can* be real-time via **Amazon Marketing Stream (AMS)** — hourly performance pushed through AWS Firehose. It's implemented (`ads-marketing-stream.service.ts`) but **dormant by default**.

### Enabling AMS hourly metrics (ops)

1. Provision an AWS Firehose delivery stream per the Amazon Marketing Stream onboarding.
2. Set `NEXUS_AMS_DESTINATION_ARN` (Railway env) to the Firehose ARN and redeploy.
3. Subscribe the SP/SB/SD traffic + conversion datasets (the service config in `ads-marketing-stream.service.ts`).
4. Verify via `amsStatus()` (`configured: true` + a recent `lastReportedDate`).

Until then, metrics freshness stays at the Reports-API T+1 cadence; **structure and keyword/negative fidelity are unaffected** (those are the polling paths above).

## Safety summary

- Soft-archive only (status `ARCHIVED`), reversible.
- Deletion never runs in sandbox (the v3 lists short-circuit).
- Deletion never runs on a failed fetch, and never exceeds the circuit-breaker fraction.
- Gated-local (un-pushed) rows are exempt from archival.
- All cadences are env-overridable to dial back under rate limits.
