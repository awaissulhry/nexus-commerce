# AX-IE.0 + AX-IE.1 — Plan (AWAITING GATE)

Date: 2026-07-28 · Scope: **AX-IE.0 (P0 correctness) and AX-IE.1 (canonical model) only.**
Brief: `obsidian-vault/30 - Amazon Ads Platform Audit.md`, `31 - Competitor Teardown`, `32 - Import-Export & Sync Spec`.

Evidence harnesses (read-only, untracked): `apps/api/scripts/_axie1-model-census.mts`,
`_axie0-conn-probe.mts`, `_axie0-export-blast.mts`, `_axie0-e4-proof.mts`,
`_axie1-metric-collision.mts`.

## Status

| Phase | State |
|---|---|
| **AX-IE.0** P0 correctness | ✅ shipped 2026-07-28, verified on prod |
| **AX-IE.1** canonical model | ✅ shipped 2026-07-28, parity green |
| **AX-IE.2** schema + adapter | ✅ shipped 2026-07-28 — one schema in `@nexus/shared/ads-bulksheet` drives export, Dictionary and validation on both server and browser; ExcelJS behind `SpreadsheetWriter`/`SpreadsheetReader` |
| **AX-IE.3** exporter rewrite | ◐ **mostly done** — all 9 SP entity types, Portfolios, README, `_meta`, `_row_key`, `_baseline`, and the SP sheet now matches Amazon's **real 53-column layout column-for-column** after the owner supplied two genuine bulksheets (see `docs/AMAZON-BULKSHEET-SCHEMA.md`). Remaining: emit the **SB / SB-multi / SD sheets** — no longer blocked, their column sets are now known |
| **AX-IE.4** importer | ✅ shipped 2026-07-28 — `POST /advertising/bulk/upload` takes a real file, streams it, validates every row, stages into `ImportJob`/`ImportJobRow`, writes nothing. 202 + poll |
| **AX-IE.5** dry-run preview | ✅ shipped 2026-07-28 — field-level diff, blast radius, per-field conflict detection, `planToken` handshake. `POST /advertising/bulk/import/:id/preview` |
| **AX-IE.6** apply + rollback | ✅ shipped 2026-07-28 — planToken handshake, writes only through `ads-write-gate`, whole-upload rollback via `rollbackByChangeSetId`. Verified: 9 applied → 9 reversed → 0 failed |
| **AX-IE.7** annotated workbook | ✅ shipped 2026-07-28 — `_status`/`_errors`/`_applied_at`, red offending cell keeping the operator's original text, grouped Errors sheet, `_baseline` refreshed so the correction loop closes |
| **AX-IE.8** bulk UI page | ✅ shipped 2026-07-28 — `/marketing/ads/bulk`: Import staircase, blast-radius review, History with deep-linked Review + Undo |

| **AX-ZD.5** data vintage | ✅ shipped 2026-07-28 — settlement state as a pure function of date, `isRuleSafe` guard, stamped into every export's `_meta` and README, plus `GET /advertising/data-vintage` |

| **AX-ZD.4** drift detection | ✅ shipped 2026-07-28 — rides the existing settings sync (zero extra API calls), classifies every difference, `GET /advertising/drift` |

**AX-IE is complete .0 → .8; AX-ZD.4 and .5 are done.** Remaining in the programme: the SB / SB-multi / SD sheets
in the exporter (columns known, see `docs/AMAZON-BULKSHEET-SCHEMA.md`), consolidating the
CREATE path (still only in the older `/bulk/apply`), predicate selection in `AdsDataGrid`,
and the rest of **AX-ZD**: **.1** typed `AdMutation` queue + 423/`Retry-After`, **.2** the
five missing Marketing Stream datasets, **.3** intended/observed/reported, **.4** three-tier
reconciliation, **.6** scheduled imports.

**ZD.4's first live run is the argument for doing .1 next.** It classified drift into
WRITE_PENDING / WRITE_LAG / WRITE_FAILED / EXTERNAL_CHANGE, but the pending-write lookup
has to find in-flight mutations by parsing a JSON blob on `OutboundSyncQueue`, because
that model has no campaign/ad-group/target foreign key (audit §3.2). The typed
`AdMutation` queue is what makes that lookup exact instead of best-effort.

**.1 and .2 are gated on an explicit conversation** — both change how live writes queue
and how we consume Amazon's push feed, which is a different risk class from everything
shipped so far.

### Measured, and what it changed

| Finding | Number | Consequence |
|---|---|---|
| Buffered ExcelJS read | **1.4 GB RSS** for a 5.5 MB / 100k-row file (~260x) | switched to streaming: **354 MB and faster** (1.2s vs 2.2s), identical verdicts |
| Validation vs staging | validate 100k = **1.3s**; stage 100k = **~110s** | staging is Neon round trips, not CPU → upload returns **202 in 0.2s**, work continues behind the job |
| Real account file | 9,288 rows, **~8s** end to end | the 100k ceiling is the documented edge, not the normal case |
| ExcelJS streaming reader | crashes on part-order (`workbook-reader.js:303` reads `this.model.sheets` unguarded, one line after guarding `this.workbookRels`) | detected + bounded fallback to the buffered reader; `entries:'emit'` dropped |

**Spec conflict #13 — Italian error text.** Spec §3 says localise import errors to
Italian. Not done, deliberately: the house rule is operator-facing UI in English, with
Italian reserved for listing content, and these messages are operator-facing.

**Conflict #12 update:** the spec's `entries: 'emit'` recommendation is wrong for this
usage — entries that nothing consumes only add a stall path. Removed.

**AX-IE.5 — what the first run taught.** The `_baseline` design was wrong twice, and
both only showed up end to end:

| Symptom | Cause | Fix |
|---|---|---|
| 57 of 57 rows CONFLICT | the hash covered every editable column, including `Operation` — which the operator fills in to request a change, so each row conflicted with itself | baseline is per-ENTITY (`BASELINE_FIELDS`), only fields that entity owns |
| 5 campaigns still conflict, budget delta reads 0 | exporter hashed raw DB values (`100`, `LEGACY_FOR_SALES`), preview hashed what it read back (`"100.00"`, `"Dynamic bids – down only"`) | both normalise through the schema inside `computeBaseline` |
| an unrelated field's drift blocked 5 valid edits | row-level conflict | baseline stored **per field**; a row conflicts only when drift collides with what is being edited, otherwise it is a note |

The third was found because the settings-sync cron genuinely moved `Bidding strategy`
between an export and its preview — real drift, correctly detected, wrong response.

**AX-IE.6 design notes.** `AdvertisingActionLog.executionId` is an indexed column with
**no foreign key** — rule executions were simply its first user — so it takes any
change-set id. That let apply reuse the existing `reverseOne` inversion logic instead of
building a second rollback path; `rollbackByChangeSetId` is a sibling of
`rollbackByExecutionId`, not a replacement. Idempotency uses `ImportJobRow.status`
rather than the spec's proposed `import_operation` table — the staging row already
records what happened, and a second table would be a second truth.

Reversal runs **newest-first** so a field written twice inside one change set lands back
on its original value rather than an intermediate one.

The rest of this document is the original .0/.1 plan, kept as the evidence record,
with corrections marked inline where implementation proved something different.

---

## 0. Headline

Both phases are **smaller and differently-shaped than the spec assumes**, and I can now say so with prod data rather than line numbers.

- **AX-IE.1 is not a migration.** The two "generations" are two disjoint subsystems with **zero shared readers**. Gen B's Amazon content is an explicitly-labelled read-only shadow. The real defect is that the shadow is **two months stale and holds a known-bad pre-dedup snapshot**, and one live page reads it. Fix = quarantine + refresh, not migrate-and-delete.
- **AX-IE.0 bug E6 (ID coercion) does not reproduce.** I generated the exporter's actual XLSX and read the XML: IDs are already string cells. But the same probe found a **worse, unreported bug immediately next to it** — `Bid` is written as *text*, which is the mechanism that makes I4's silent €0.50 fire in the first place. E6 and I4 are one causal chain.
- **AX-IE.0 bug E4 is harder than "read the real field."** There is no real field. `Campaign` has no `targetingType`, `AdGroup.targetingType` is never written by the sync, and the v1 Exports record doesn't carry it. Fixing E4 needs a schema column, a sync change, and one live probe.

---

## 1. Evidence

### 1.1 Prod row census (2026-07-28)

| Generation A — Amazon Ads cockpit | Rows | | Generation B — Unified Marketing OS | Rows |
|---|---|---|---|---|
| `Campaign` | **196** | | `MarketingCampaign` | **338** |
| `AdGroup` | 265 | | `MarketingCampaignLink` | 169 |
| `AdTarget` | 4,506 (1,649 negative) | | `AmazonAdsCampaignDetail` | 338 |
| `AdProductAd` | 4,015 | | `CampaignTarget` | **0** |
| `AmazonAdsDailyPerformance` | 25,192 | | `CampaignMetric` | 1,459 |
| `AmazonAdsHourlyPerformance` | 9,728 | | `CampaignBudget` | **0** |
| `BudgetPool` | **0** | | `CampaignBudgetAllocation` | **0** |
| `BudgetPoolAllocation` / `Rebalance` | **0** / **0** | | `CampaignBudgetRebalance` | **0** |

### 1.2 Code reference census (`prisma.<model>.` across `apps/api`, `apps/web`, `packages`)

| Model | Calls | Files | Who reads it |
|---|---|---|---|
| `campaign` | 148 | 46 | ads cockpit, everywhere |
| `adTarget` | 82 | 24 | ads cockpit |
| `adGroup` | 63 | 16 | ads cockpit |
| `adProductAd` | 35 | 15 | ads cockpit |
| `budgetPool*` | 16 | 4 | `advertising.routes.ts`, `budget-pool-rebalance.job.ts`, `budget-pool-rebalancer.service.ts` |
| `campaignMetric` | 16 | 5 | **marketing-os only** |
| `campaignBudget*` | 10 | 2 | **marketing-os only** (`marketing-os.routes.ts`, `marketing-budget.service.ts`) |
| `amazonAdsCampaignDetail` | **0** | **0** | nobody |
| `campaignTarget` | **0** | **0** | nobody |

**No file reads both generations for the same fact.** The sets are disjoint by subsystem, not contended.

### 1.3 The actual inconsistency, located

`amazon-backfill.service.ts` header states it plainly:

> "Mirrors Campaign / AmazonAdsDailyPerformance → the new MarketingCampaign tables; **legacy stays authoritative until the P8 cutover**." … "read-only **shadow** backfill" … "delete-then-insert scoped to channel=AMAZON".

Its only caller is a **manual endpoint** (`marketing-os.routes.ts:759`). **There is no cron.** Consequence, measured:

| | Gen A `Campaign` | Gen B `MarketingCampaign` (AMAZON) |
|---|---|---|
| Rows | 196 | **338** |
| Newest `updatedAt` | **2026-07-28 04:20** | **2026-05-28 23:27** |

`2026-05-28` is the date of migration `20260528_um1_marketing_os_core` — the shadow was populated once at migration time and never refreshed.

**338 is the pre-dedup campaign count from AF.1d** ("Duplicate campaign merge (338 → 169; marketplace short-code vs Amazon ID split)"), and `MarketingCampaignLink` = **169** = the post-dedup count. The shadow is a frozen snapshot of a **state we already know to be wrong**.

And it is on screen — **corrected during implementation**. My first reading named
`/marketing/campaigns`, but that route is retired: it `redirect()`s to
`/marketing/advertising/campaigns`, and `MarketingCampaignsClient` is referenced only
from a comment. The exposure is real but sits elsewhere, and is **broader** than one page.
These live routes all read the shadow via `/api/marketing/os/*`:

| Route | Reads | Shows |
|---|---|---|
| **`/marketing/analytics`** | `CampaignMetric` grouped by channel | **Amazon spend/sales/ROAS frozen at 2026-05-28, blended into cross-channel totals** |
| `/marketing/calendar` | `MarketingCampaign` | stale Amazon campaign set |
| `/marketing/budgets` | `MarketingCampaign` | stale Amazon budgets |
| `/marketing/automation-os` | `MarketingCampaign` | stale Amazon campaign set |
| `/marketing/campaigns/[id]` | `MarketingCampaign` | stale detail for deep links |

**`/marketing/ads/campaigns` — the current console — reads `/api/advertising/*`, i.e.
Generation A, and is correct.**

**Console lineage** (confirmed by the owner 2026-07-28, and worth writing down because
three ad surfaces are routed simultaneously and only one is current):

| Route | Status |
|---|---|
| **`/marketing/ads/*`** | **current console — build here, link here** |
| `/marketing/ads-console/*` | previous console (holds a bulk screen, see §4 #11) |
| `/marketing/advertising/*` | earlier surface |

All three are routed (none redirect), so "it loads" is not evidence a surface is current.

> **So: `/marketing/analytics` reports Amazon money two months stale inside totals that
> look current, while the ads cockpit shows live figures.** That is the reproducible
> inconsistency, and the count mismatch (338 vs 196) is the same root cause.

### 1.4 Budgets are a non-issue

`BudgetPool*` (0 rows, 16 call sites, ads) and `CampaignBudget*` (0 rows, 10 call sites, marketing-os) are **both empty and both wired**. There is no data to disagree, nothing to migrate, and no user-visible symptom. The spec ranks this P0; on the evidence it is not.

---

## 2. AX-IE.1 — Canonical model decision

### 2.1 The decision

| Domain | Canonical | Status of the other |
|---|---|---|
| Amazon ad campaign / ad group / target / product ad | **`Campaign` · `AdGroup` · `AdTarget` · `AdProductAd`** (Gen A) | `MarketingCampaign` + `AmazonAdsCampaignDetail` = **shadow**, non-authoritative until UM P8 |
| Amazon ad performance | **`AmazonAdsDailyPerformance` / `AmazonAdsHourlyPerformance`** | `CampaignMetric` = shadow for Amazon; **canonical for eBay** (its own writers) |
| Ad targeting | **`AdTarget`** | `CampaignTarget` = **dead**, 0 rows, 0 refs |
| Amazon budget pooling | **`BudgetPool*`** | `CampaignBudget*` = cross-channel successor, adopt at UM P8 |

**Evidence for Gen A:** it is the only generation with live data (196/265/4,506/4,015/25,192 rows updated today), the only one the 276-route ads surface reads, the only one the write path mutates, and the one the shadow's own source comment defers to.

**This is not a new decision — it is already the decision in code.** `CampaignTarget` was declared a dead model in-schema on 2026-07-28 (commit `5719901a5`). What is missing is enforcement, not a verdict.

### 2.2 Read sites that must migrate

**None.** That is the finding. `AmazonAdsCampaignDetail` and `CampaignTarget` have zero readers; `CampaignBudget*` and `CampaignMetric` have readers that are correct for their own domain (marketing-os / eBay). No ads-cockpit read site points at Gen B.

The work is therefore **containment of one stale surface**, not migration:

| # | Change | File |
|---|---|---|
| 1 | Schedule `backfillAmazonShadow` on a cron so the shadow cannot silently rot | new `.job.ts` + scheduler registration |
| 2 | Stamp + surface shadow freshness; banner on `/marketing/campaigns` when the Amazon slice is older than the cadence | `marketing-os.routes.ts`, `MarketingCampaignsClient.tsx` |
| 3 | Purge the 169 orphan pre-dedup Amazon rows the backfill's delete-then-insert will drop anyway (verify it actually scopes to `channel=AMAZON` before relying on it) | backfill run |
| 4 | Write the verdict into the schema as comments on all four Gen B model blocks, matching the existing `CampaignTarget` precedent | `schema.prisma` |
| 5 | Record the verdict in `docs/` as the canonical reference | new `docs/CANONICAL-ADS-MODELS.md` |

### 2.3 Migration order

1. **Document** (§2.2 #4, #5) — zero risk, no behaviour change. Ship first, alone.
2. **Freshness banner** (#2) — read-only UI + one route field. Reversible by revert.
3. **Cron the backfill** (#1) — starts with `apply:false` (dry run) for one cycle; inspect the report; then flip to `apply:true`. This is the only step that writes.
4. **Verify** #3 resolves as a side effect of the first real `apply:true` run; if it doesn't, the delete-then-insert scoping is wrong and step 3 becomes its own gated task.

**Not in scope, deliberately:** dropping `CampaignTarget` / `AmazonAdsCampaignDetail` / `CampaignBudget*`. All are destructive migrations on empty or shadow tables with no payoff today, and your standing rule sends destructive migrations to a separate gate. They cost nothing to leave.

### 2.4 Rollback

| Step | Rollback |
|---|---|
| 1 Documentation | `git revert`. No runtime effect. |
| 2 Freshness banner | `git revert`. No data touched. |
| 3 Cron | Remove the scheduler registration (or set the cron disabled flag). The shadow simply returns to being stale — which is the current state, so the failure mode of rollback is exactly today's behaviour. |
| 4 Backfill `apply:true` | The backfill is idempotent delete-then-insert scoped to `channel=AMAZON`. Re-running restores. **Gen A is never written by this path**, so the ads cockpit cannot be damaged by any of it. |

The whole phase is rollback-safe because nothing in it writes to Gen A and nothing drops a table.

---

## 3. AX-IE.0 — The correctness bugs

### 3.1 Token expiry — `AmazonAdsConnection`

**Confirmed:** the model has no `tokenIssuedAt` / expiry field of any kind (full model read; fields are `credentialsEncrypted`, `mode`, `writesEnabledAt`, `lastWriteAt`, `isActive`, `lastVerifiedAt`, `lastErrorAt`, `lastError`).

**10 connections**: 4 production (IT, FR, ES, DE), 6 sandbox (SE, PL, NL, IE, UK, +1). **All 10 have `createdAt` = 2026-05-17 02:45:45**, sub-second apart — a seeded batch, therefore *not* real consent timestamps.

> **We cannot recover the true consent dates.** Any backfill is an assumption, and it must be labelled as one.

**Fix:** additive columns `tokenIssuedAt DateTime?` + `tokenExpiresAt DateTime?` + `tokenIssuedAtIsEstimate Boolean @default(false)`; stamp at consent (`amazon-ads-auth.routes.ts:376–404`) and on every refresh-token rotation; backfill existing rows to `createdAt` flagged as an estimate; surface days-to-expiry on `/marketing/ads/account-settings` and `/health`; alert at 30 days. Additive migration — pre-approved under your standing rule.

**Urgency, honestly:** 2026-07-30 is when Amazon's *policy* starts, not when these tokens die. On the conservative floor (365d from row creation) the earliest death is **~2027-05-17**. This is a real landmine that must be instrumented, but it is not a two-day emergency. See open item **B2**.

### 3.2 E4 — targeting type by regex

`advertising.routes.ts:4074`: `isAuto = /\bauto|close match|loose match|substitute|complement/i.test(name)`.

**Measured impact: 26 of 196 campaigns export as `auto` on name alone.** (Graded against
Amazon's real values after the fix shipped: the regex was **wrong on 12 of 176** — see §5.)

**The audit says "read the real field." There is no real field:**

- `Campaign` has **no** `targetingType` column.
- `AdGroup.targetingType` exists but is written **only by our own campaign builders** (`ads-create.service`, `ads-architect.service`, `ads-keyword-funnel.service`). `ads-v1-sync.service.ts` upserts ad groups (`:478–511`) and **never writes it** — so all 265 synced ad groups sit at the schema default `MANUAL`. The census confirms: 196/196 campaigns read `MANUAL`, 0 mixed. That is the default, not the truth.
- `V1Campaign` — the v1 Exports record type — **has no `targetingType` field.**

**Available source:** v3 `POST /sp/campaigns/list`, already implemented as `listCampaignsV3` (`ads-api-client.ts:400`) and already run every cycle by `ads-campaign-settings-sync.service.ts`. The `V3CampaignSettings` interface simply doesn't declare the field.

**Fix:** declare `targetingType` on `V3CampaignSettings`; add `Campaign.targetingType String?` (additive); populate in the existing settings sync; exporter reads it and **emits blank when unknown rather than guessing**. Deleting the regex without a source would emit `manual` for all 196 — the same class of bug, quieter. Gated on probe **B1**.

### 3.3 E6 — ID coercion: **does not reproduce**

I ran the exporter's exact ExcelJS calls and read the resulting sheet XML:

```xml
<c r="A2" t="s"><v>3</v></c>   <!-- Campaign ID  → shared STRING -->
<c r="B2" t="s"><v>4</v></c>   <!-- Bid          → shared STRING -->
<c r="C2"><v>25.5</v></c>      <!-- Daily budget → number -->
```

IDs are already string cells. There is no numeric coercion, no scientific notation, no float64 loss — and max external campaign ID length in prod is **15 digits**, below 2^53 regardless. **The audit's E6 is incorrect as written.**

**What the probe found instead, and it is worse:**

`Bid: (t.bidCents / 100).toFixed(2)` produces a **string**, so the bid column is *text* in Excel and Numbers — not summable, not sortable. And it is the trigger for I4:

> text cell → operator edits it in `it-IT` and types `1,25` → stays literal text `1,25` → re-import runs `Number("1,25")` → `NaN` → **`bidEur = 0.5`.**

**E6 and I4 are one causal chain. Fixing I4's fallback alone leaves the trigger in place.** Fix both: write `Bid` and budget as real numbers with `numFmt:'#,##0.00'`, and pin IDs/SKU/ASIN with explicit `numFmt:'@'` (prophylactic — Numbers re-saves can flip an unpinned text cell).

### 3.4 I4 — silent €0.50

`const bidEur = Number.isFinite(bid) && bid > 0 ? bid : 0.5` — confirmed at the line. **Fix:** an unparseable or missing bid is a **row error**, never a default. `it-IT`-aware numeric parsing on the CSV path only (XLSX numbers are locale-invariant). Must ship together with §3.3.

### 3.5 I5 — silent EXACT

`mt.includes('PHRASE') ? 'PHRASE' : mt.includes('BROAD') ? 'BROAD' : 'EXACT'` — confirmed. **Fix:** strict enum + alias table; unrecognised = row error. Match type is immutable on Amazon, so a wrong value costs archive-and-recreate and destroys performance history — this must fail loudly.

### 3.6 E1 — silent truncation, sharper than reported

`Math.max(1, Math.min(500, Number(q.limit ?? 200)))` — the **default is 200**, not 500.

> **The account has 196 campaigns. It is 4 campaigns from silently dropping data on the default call.**

Silently absent regardless of `limit`, measured:

| Missing | Rows |
|---|---|
| Negative targets (`where: { isNegative: false }`) | **1,649** |
| Product ads (no Product Ad entity emitted) | **4,015** |
| Portfolio memberships (`Portfolio ID` column emitted, never populated) | **62** of 196 |
| Bidding adjustments / placement modifiers | all |

Per-ad-group target cap (`take: 200`) is not biting yet — max observed is 96.

**Proposed for .0: make it loud, not complete.** Raise the default to cover the account, and return an explicit truncation signal (response header + a visible banner row) whenever any cap or filter drops rows. Completeness — negatives, product ads, portfolios, placements, SB/SD sheets — is the AX-IE.3 rewrite and shouldn't be smuggled into a correctness phase.

---

## 4. Where the spec conflicts with the code

Source is authoritative; these are the disagreements.

| # | Spec / audit says | Code says |
|---|---|---|
| 1 | **E6**: IDs written as raw values, Excel coerces to scientific notation, float64 loses precision | **Disproven.** IDs are already `t="s"` string cells; max ID is 15 digits. Real bug is `Bid` as text (§3.3). |
| 2 | **E4**: "Read the real field" | No such field exists on `Campaign`; `AdGroup.targetingType` is unpopulated for all synced rows; `V1Campaign` doesn't carry it. Needs schema + sync + probe. |
| 3 | Audit §3.6: two generations, "inconsistency is structural" | Disjoint subsystems, **zero shared readers**; Gen B's Amazon slice is a labelled shadow. Real defect is staleness on one page (§1.3). |
| 4 | Spec §7: `CampaignTarget` canonical-ness is an open decision | Already declared a dead model **in-schema** (commit `5719901a5`, 2026-07-28), 0 rows, 0 refs. |
| 5 | Audit §2.3: "exporter emits columns the importer cannot consume" | **Headers match exactly** (`Campaign ID`, `Ad group ID`, `Keyword text`, `Match type`, `State`, `Daily budget`). The break is semantic: the exporter never emits an `Operation` value, and `Product targeting` rows have no importer branch. |
| 6 | Spec §2.2: adopt Amazon-native header casing (`Campaign Id`, `Ad Group Id`, `Campaign Name`) | Would **break the existing importer**, which matches the current casing literally. The alias table (spec §3 Stage 3) must land *before* any header rename. |
| 7 | Spec §7 ranks `BudgetPool*` vs `CampaignBudget*` as P0 | Both tables are **empty**. No data, no symptom, nothing to migrate. |
| 8 | Spec §2.5: swap to `@protobi/exceljs` | `exceljs ^4.4.0` is a dependency of **both** `apps/api` and `apps/web`. Not an api-only swap; needs a web-side plan too. |
| 9 | Audit §3.5: refresh-token expiry is "two days from this audit date" | 2026-07-30 is the **policy** start. Conservative earliest death for these connections is ~2027-05-17 (§3.1). Instrument now; not a two-day emergency. |
| 10 | Spec §0: reuse `ImportJob`/`ImportJobRow`/`ExportJob`/`BulkActionJob` | **Unverified.** These are product/listing-shaped. Fit for ad entities needs checking at AX-IE.4 — not a .0/.1 concern, but flagging it early because it's load-bearing for the whole import phase. |
| 11 | Audit §2.3: "there is no bulk/import/export UI page under `/marketing/ads` at all" | Literally true, but misleading. **`/marketing/ads-console/bulk` exists and is routed** — it downloads via `GET /advertising/bulk/export`, parses .xlsx/.csv client-side with exceljs, and validates rows against its OWN per-entity grammar. It sits on the *previous* console, so AX-IE.8's `/marketing/ads/bulk` is still the right target — but the second grammar was real and had already drifted from the server's (8 entities and required-fields but no value checks, against the server's 4 entity×operation combinations with strict value checks). AX-IE.2 resolves that by making the schema shared. |
| 12 | Spec §2.5: adopt `@protobi/exceljs` | Fork verified real (MIT, `4.4.0-protobi.10`); upstream last published **2024-12-20**, not Oct 2023. But `exceljs` is a direct dependency of `apps/web` **and 12+ files in `apps/api`, including the untouchable flat-file substrate** — swapping it is not an ads change. `npm audit` shows only a *moderate* transitive advisory via `uuid`, with no non-downgrade fix. AX-IE.2 therefore puts every call behind `SpreadsheetWriter`/`SpreadsheetReader` so the swap is a one-file change, and defers the swap itself. |

---

## 5. Open items — what blocks .0/.1 and what waits

### Blocks AX-IE.0

| | Item | How to close | Status |
|---|---|---|---|
| **B1** | Does v3 `POST /sp/campaigns/list` return `targetingType` for this account? | Made a **non-gate** instead: 0.d captures the field when present, stores null when absent, and exports blank either way — correct under both answers. The deployed sync then answered it empirically. | ✅ **YES.** First cycle after deploy populated **176 of 196** (140 MANUAL, 36 AUTO). The 20 nulls are all ARCHIVED — outside the sync's ENABLED+PAUSED scope, so they correctly export blank rather than a guess. |
| **B2** | Do pre-2026-07-30 refresh tokens get 365 days from consent, or from the policy date? | *Soft block.* Changes the alert date, not the design. Proceeded on the conservative floor. | ⏳ Open. All 10 connections now read 292 days left, flagged `isEstimate`. Revise the window if Amazon clarifies. |

**E4, now scored against ground truth.** With Amazon's real values in hand, the old
name-regex can be graded rather than estimated: over the 176 campaigns Amazon reports,
it was **wrong on 12 (6.8%)** — 11 genuinely-AUTO campaigns exported as `manual`, and 1
genuinely-MANUAL exported as `auto`.

The failure mode is worth recording: the misses are named `DE_Auto_Close`,
`ES_Auto_Loose`, `FR_Auto_Close` and so on. `\bauto` requires a word boundary, and `_`
is a word character — so `DE_Auto_Close` never matched, and every underscore-separated
auto campaign in the account was silently exported as manual. A heuristic that reads as
obviously-correct failed on the account's dominant naming convention.

### Blocks AX-IE.1

**Nothing.** All evidence is in hand; the phase can start on approval.

### Deferrable — needed later, not now

| Item | Needed by | How to close |
|---|---|---|
| ~~Exact SP full-download column list~~ | ~~AX-IE.2/.3~~ | ✅ **CLOSED 2026-07-28.** Two real downloads supplied; identical structure. Recorded in `docs/AMAZON-BULKSHEET-SCHEMA.md`, encoded in `packages/shared/ads-bulksheet.ts`. Eight of our guessed values were wrong — see that doc. |
| ~~SB + SD bulksheet schemas~~ | ~~AX-IE.3~~ | ✅ **CLOSED** — SB 51 cols, SB Multi Ad Group 75, SD 47, Portfolios 12, all captured. Emitting those sheets is the remaining .3 work. |
| Per-resource batch maxima | AX-IE.6 (apply batching), AX-ZD.1 (rate limiting) | One live API probe, escalating batch sizes until 429/413. |
| `@protobi/exceljs` swap incl. `apps/web` | AX-IE.2 | Dependency review. |
| `ImportJob*` fit for ad entities | AX-IE.4 | Schema read (conflict #10). |

---

## 6. Proposed sequence

Each step is independently shippable and independently revertible.

| Step | Work | Verification |
|---|---|---|
| **0.a** | I5 strict match-type; I4 reject-don't-default; `Bid`/budget as numeric cells with `numFmt`; IDs pinned `numFmt:'@'` | Round-trip an export through Numbers in `it-IT`, edit a bid to `1,25`, re-import → row applies at €1.25, or errors. Never €0.50. |
| **0.b** | E1 loud truncation + default raised above account size | Export with `limit=1` → explicit truncation signal, not a silent short file. |
| **0.c** | Token expiry columns + stamping + `/health` + `/account-settings` countdown + 30-day alert | Countdown visible for all 10 connections, estimates labelled as estimates. |
| **0.d** | E4 — *gated on B1*: `V3CampaignSettings.targetingType`, `Campaign.targetingType`, settings-sync populates, exporter reads it, blank when unknown | The 26 false-`auto` campaigns export correctly or blank; zero guesses. |
| **1.a** | Canonical-model docs + schema comments | `docs/CANONICAL-ADS-MODELS.md` exists; four Gen B blocks annotated. |
| **1.b** | Shadow freshness surfaced on `/marketing/campaigns` | Page shows the Amazon slice is stale rather than presenting 338 as current. |
| **1.c** | Backfill on a cron — dry run first, then `apply:true` | `/marketing/campaigns` and `/marketing/ads/campaigns` agree on campaign count. |

Additive migrations only (§3.1, §3.2). No destructive migration anywhere in .0/.1.

---

## 7. What I need from you

1. **Approve or amend** the AX-IE.1 verdict in §2.1 — in particular that we *quarantine and refresh* the shadow rather than migrate/drop, and that `BudgetPool*` vs `CampaignBudget*` is explicitly deferred as a non-issue.
2. **Approve the E6 reinterpretation** in §3.3 — I'm proposing to fix the Bid-as-text chain instead of the reported (non-reproducing) ID coercion, and to pin ID formats prophylactically.
3. **Say whether E4 (0.d) ships in .0 or moves to .2** — it needs a schema column and a sync change, which is more than a bug fix.
4. **Green-light probe B1** (read-only live call on the IT production profile).
5. **When convenient:** one real Seller Central bulksheet download (SP, and SB/SD if available) — it unblocks AX-IE.2/.3 and nothing else can substitute for it.
