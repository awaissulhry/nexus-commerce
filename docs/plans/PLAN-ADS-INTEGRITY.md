# Plan: Amazon Ads integrity: drift that never closes, and a false "sync never ran"

Status: PLAN ONLY (no code). Base: `origin/main` 074c1cf54. Prod serves build 93215463, an ancestor of main; the 6 commits since it touch no ads, health or cron files.
Measured 2026-09-26 19:18–19:26 UTC from the public `/api/health` and read-only aggregate queries on prod (one READ ONLY transaction per query; no names, ids or money read out).
Two business profiles are active. **A** has 0 campaigns and 0 Ads connections. **B** has 220 campaigns and 9 active Ads connections. Paths below are under `apps/api/src/`.

## 1. What each finding means, cause, counts

**`ADS_SETTINGS_SYNC_NEVER` (CRITICAL) is a false alarm from profile A.**
- Health runs the check once per profile and merges the findings without saying which profile each came from (`routes/health.ts:88-99`).
- The check fires when `max(Campaign.settingsSyncedAt)` is null (`services/ads-core/ads-sync-integrity.ts:166-172`; collected at `services/advertising/ads-sync-integrity.service.ts:28,56`). Profile A has no campaigns, so it can never have a sync time.
- A's sync cron is fine: 504 of 504 runs SUCCESS in 7 days, each reporting `profiles=0 campaigns=0`.
- B last synced 1 minute before the probe (503 of 504 runs SUCCESS in 7 days). All 200 of B's SP campaigns that are not archived were synced within the last 70 minutes.
- The same false alarm is latent for a profile with only SD or SB campaigns. The settings sync reads only the SP API, so those campaigns (15 SD and 4 SB today) are never stamped.

**`ADS_DRIFT_OPEN` (CRITICAL, 452) is all in profile B.** All 452 rows are child entities. All are classed EXTERNAL_CHANGE. All were first detected between 2026-07-30 and 2026-08-14.

| Entity / field | Open | What the row says, and the current local state | Last seen by the reconcile |
|---|---|---|---|
| AD_TARGET `state` (SD product targets) | 236 | Ours "archived" vs Amazon "enabled". The local target is now ENABLED. | 2026-08-05; 203 SUCCESS runs since |
| AD_TARGET `existence` (SP keywords) | 6 | "never sent", but the keywords now have Amazon ids | 2026-08-13; 173 SUCCESS runs since |
| AD_TARGET `existence` (SP keywords) | 206 | "never sent". Archived locally, no Amazon id (162 in ENABLED campaigns, 44 in PAUSED) | every run (latest 18:35) |
| AD_TARGET + PRODUCT_AD `existence` | 3 + 1 | "never sent". ENABLED locally, no Amazon id: **genuine** | every run |

All 324 resolved rows are CAMPAIGN rows; no child row has ever closed. All 145 reconcile runs since 09-01 were SUCCESS with 0 errors. The latest summary reads `entities=7963 mismatch=207 notPushed=210 driftResolved=193`; those 193 are CAMPAIGN rows (see "Not in scope").

**Cause 1: the resolve pass looks only at CAMPAIGN rows.** `services/advertising/ads-structural-reconcile.service.ts:194-196` selects only `entityType:'CAMPAIGN', entityId in <campaign ids>`. Child rows are keyed by the child's own id (`:154`, `:166`), so they never match. The 242 rows that now agree (236 + 6) can never close.

**Cause 2: a keyword that is archived locally and was never pushed still counts as drift.** In `services/ads-core/launch-verify.ts:85`, "no Amazon id" always means `NOT_PUSHED`, whatever the local state. The reconcile records that as an `existence` row and re-opens it on every run. There are 206 of these.

**Cause 3: rows can close without evidence (latent; 0 rows affected today).**
- (a) The resolve pass treats "no delta" as "agrees", even for fields Amazon did not report. `verifyEntity` skips those fields silently (`launch-verify.ts:92-93`).
- (b) Two kinds of observed delta are never marked as seen, so the pass would close their rows: a bid delta (`:159`), and a delta whose upsert throws (`:165-170`; this does not set `ok=false`).
- (c) The settings sync closes every CAMPAIGN row whose field it did not diff, including rows the reconcile owns such as `name`, `state` and `existence` (`services/advertising/ads-campaign-settings-sync.service.ts:117-123`).

**Wrong class.** A "never sent" row is classed EXTERNAL_CHANGE (`ads-structural-reconcile.service.ts:228-235`: `classifyDrift` gets no write time). The health text then says "someone edited it on Amazon", which is untrue for these rows.

## 2. Fix design

**Rule: a row closes only on evidence from a clean reconcile run in its own profile.** All four must hold:
1. The run has `ok` (unchanged). Every run since 09-01 qualifies.
2. The entity is in that run's verified results, meaning it was actually compared. Entities that were uncovered, skipped, not batched or deleted stay open.
3. The row's field was **compared** in that run. For `existence`, "compared" means Amazon returned the entity under our id (verdict VERIFIED or MISMATCH).
4. The comparison observed **no delta** for that key.

**Mechanics.**
- `verifyEntity` returns `compared: string[]`, the fields where both sides were read.
- `seenKeys` records every observed delta, including suppressed bid deltas and deltas whose upsert failed.
- The resolve pass covers every entity type in the run's results. It queries open rows by `(entityType, entityId in a chunk of 1000)` and closes the keys that pass the rule.
- The settings sync closes only fields it actually compared (`CAMPAIGN_DRIFT_FIELDS` that Amazon reported), so it no longer closes rows the reconcile owns.

**Archived locally and never sent means Amazon agrees with us.** The local intent is "not live" and Amazon holds nothing, so `verifyEntity` returns VERIFIED with `compared:['existence']` (Owner decision D1). A never-sent entity that is still live locally stays a finding, now classed **WRITE_FAILED** ("one of our writes never landed").

**Only the scheduled job closes rows.** After deploy, the 6-hourly reconcile closes rows as normal job behaviour. There are **no manual data writes, scripts or backfill**. No Amazon writes are added, nothing is paused, bids are untouched, and the cron switch (`NEXUS_ENABLE_AMAZON_ADS_CRON`) is unchanged.

**Honest, attributed health.**
- The snapshot gains two counts: `settingsSyncScope` (SP campaigns that are not ARCHIVED and have an Amazon id) and `activeAdsConnections`.
- A profile with no campaigns and no active connections is `applicable:false`. It reports `NOT_APPLICABLE`, is never CRITICAL, and never raises the overall severity.
- The two settings-sync checks (NEVER and STALE) run only when `settingsSyncScope > 0`. With a scope above 0 and no sync time, the check stays CRITICAL.
- `runSyncIntegrityCheck` returns `profile`: the first 8 hex characters of the sha256 of the profile id, the same pattern as `amazonTokenFp` (Owner decision D2).
- Health output becomes `adsIntegrity.profiles: [{profile, severity}]`, and every finding carries `profile`. Overall severity is the worst across applicable profiles.
- `GET /advertising/trust` returns the same `profile` value so an operator can match the two. There is no UI change.

## 3. Slices (one PR each, in this order; no migration, no env change)

**S1: Honest per-profile health**
- Files: `services/ads-core/ads-sync-integrity.ts`; `services/advertising/ads-sync-integrity.service.ts` (counts, `profile`, log lines tagged with `profile`); `routes/health.ts`; `routes/advertising.routes.ts` (trust returns `integrity.profile`); one line in `docs/ads-amazon/AX2-REPLICATION-RUNBOOK.md`.
- Tests, red first, in `ads-sync-integrity.vitest.test.ts`: scope 0 with no sync time → no NEVER finding and `applicable:false` (red today); positive control: scope above 0 with no sync time → still CRITICAL; an SD-only profile → no settings finding.
- Tests in `health.vitest.test.ts`: A not applicable and B CRITICAL → CRITICAL, with the finding tagged with B's fingerprint; the response body contains no raw profile id; all profiles not applicable → `NOT_APPLICABLE`.
- Prod on deploy: `ADS_SETTINGS_SYNC_NEVER` disappears at once and `profiles` appears. Severity stays CRITICAL because of the drift.

**S2: Child drift closes on evidence (Causes 1 and 3)**
- Files: `launch-verify.ts` (`compared`); `ads-structural-reconcile.service.ts` (`seenKeys`, resolve pass); `ads-campaign-settings-sync.service.ts:117-123`.
- Tests in `launch-verify.vitest.test.ts`: `compared` leaves out unreported and unset fields.
- New `ads-structural-reconcile-postgres.vitest.test.ts`: real PostgreSQL via `test-support/concurrent-database.ts` with production policies and two profiles; the Amazon read (`verifyLaunch`) is mocked.
  - Red today: an SD target `state` row that now agrees → it closes.
  - Must stay open: a re-detected row; a field Amazon did not report; an entity not in the run; a run with a read error; a bid row with a live bid delta; a row whose upsert failed; the other profile's identical key.
  - Also red today: the settings sync leaves a reconcile-owned `name` row open.
- Prod on deploy: nothing changes until the next reconcile tick (00:35, 06:35, 12:35 or 18:35 UTC). That run in B should close **242** rows, leaving 210 open (still CRITICAL).

**S3: Archived never-sent entities count as agreement; live never-sent entities are WRITE_FAILED (Cause 2)**
- Files: `launch-verify.ts` (`verifyEntity`); `ads-structural-reconcile.service.ts` (`openDrift` classification).
- Tests: pure, ARCHIVED with no Amazon id → VERIFIED and ENABLED with no Amazon id → NOT_PUSHED; in the Postgres suite, an archived never-sent row closes while an enabled one stays open and is reclassified WRITE_FAILED.
- Prod: the next tick should close **206** rows and reclassify **4**. Health then shows `ADS_DRIFT_OPEN` as **WARN, 4** (the threshold is 25), so `adsIntegrity` becomes **WARN**. Launch receipts also count archived never-sent children as verified.

**For every slice.**
- Run tsc and the area tests from `apps/api`, printing the DB host first; run a scoped tsc after every import or export hunk. The Postgres suite needs a local `NEXUS_TEST_CONCURRENT_PG_URL`.
- Write the predicted counts in the PR before merging. After the tick, check them with the same read-only probe and the public health endpoint. Positive control: the rows re-detected every run (4 after S3) stay open.

**Risks.**
- Closing on ignorance: guarded by `compared`, the clean-run gate and the per-profile tests. A mass close hiding a real fault: 170+ successful runs have not re-detected the 242 rows.
- Retention deletes resolved rows after 90 days (`jobs/ads-retention.job.ts:50`; existing behaviour). The health shape change is additive; its only consumers are the runbook and the tests. Cost: about 8 extra chunked queries per reconcile run, and no extra Amazon reads.

**Not in scope.**
- 193 SP campaign `biddingStrategy` rows re-open as WRITE_LAG and are closed by the reconcile about 15 minutes later (median 924 occurrences). They do not affect severity but need a separate look.
- The 4 genuine never-sent entities (the operator should push or archive them), and rows for deleted entities or archived campaigns (0 today).

## 4. Owner decisions

- **D1.** Should the 206 SP keywords that are archived in Nexus and never reached Amazon count as agreement, so their rows close and are no longer recorded? **Recommended: yes.** Archived is the recorded intent, and Amazon holds nothing. If no, S3 only reclassifies them, and health stays CRITICAL (210 is above 25).
- **D2.** Should the public `/api/health` name each profile by an 8-hex fingerprint, which can be matched on the signed-in Ads trust page? **Recommended: yes**, the same pattern as `amazonTokenFp`. The alternative is counts only in public, with the detail behind login.

## 5. Estimate

| Slice | Build, test and review |
|---|---|
| S1 | about 0.5 day |
| S2 | about 1 day (includes the Postgres suite) |
| S3 | about 0.5 day |

S2 and S3 each also wait for one reconcile tick (up to 6 hours) before they can be verified. Elapsed time is about 3 working days.
