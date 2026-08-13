> ## ⚠ Superseded numbers — read this first
>
> **This document is committed unedited, as it was written on 2026-08-11.** It is the basis eight
> section briefs and eight execution records cite, so its body is left exactly as it was rather than
> quietly corrected. Five of its figures were superseded by measurement during NEG.0–NEG.9, and each
> was superseded because the number was **right in a different unit**, not because it was wrong.
>
> | this study says | superseded by | the correct reading |
> |---|---|---|
> | "132 negatives contain a protected term" | NEG.5 | **132 (negation × protected term) PAIRS across 128 distinct negations.** `_neg-study.mts:71-83` has no `break`, so four `xavia gale` rows are counted twice |
> | §6 "1 blocking conflict" | NEG.4 | **0** under the full blocking predicate; the overlapping negation is ARCHIVED. And the count is window-dependent: 0 at 30d, 2 at 60d, 6 at 120d |
> | §7.3 "`_EXACT` is a 62-row fringe" | NEG.1 | `expressionType` is **rewritten continuously** by two crons (~65 rows/min). It has no stable value; normalise at read time and never filter on the raw column |
> | §8 the n-gram `terms` column | NEG.6 | **overstates a 2-gram's reach by up to 4.7×** — the tokenizer strips stop words before pairing, so `moto protezioni` claims 61 terms where 13 queries contain the phrase |
> | §4.0 "archive is the only removal" | NEG.3b | Amazon **accepts `PAUSED`** on a negative — proven in practice. Its **semantics remain unresolved**: no documentation says whether a paused negative still excludes |
>
> A sixth, added by NEG.9: §2.2's account of the write paths the whitelist covers is correct about
> *our* paths and silent about the other door — **1,227 of 2,059 negatives (59.6%) arrive by the v1
> sync and pass no gate at all.** That gap is what NEG.9's third detector exists to surface.
>
> Full close-out: [`2026-08-13-neg-page-closing-note.md`](2026-08-13-neg-page-closing-note.md) ·
> open items: [`2026-08-13-neg-open-items.md`](2026-08-13-neg-open-items.md).

# NEG — Negative Targeting as its own page

*Page study 7 of 11. The tab study it builds on: [NEG tab study](2026-08-11-neg-negative-targeting-study.md).
Siblings that bound this one: [8 · Keyword Harvest](2026-08-11-hv-keyword-harvest-study.md) ·
[10 · Automations](2026-08-11-auto-automations-study.md) ·
[2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) ·
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md).*

**Read-only study. Nothing was changed. No code was written. No commit.**

Measured on production 2026-08-11 with `apps/api/scripts/_neg-page-{audit,conflict,shape}.mts`.
Where a fact is already established in the tab study or a sibling, it is cited rather than re-measured.
Where I doubted one, I say so and give the corrected number.

---

## 0 · The one-sentence version

The builder's headline safety promise — **"Never create a negative for a term that converted in the
last 30 days"**, a toggle that is **ON by default** — is written into the rule's action JSON and
**read by no executor in the system**; and beneath it sit 2,059 negatives of which **1,225 have no
author, no reason and no evidence**, **22 exist only in our database and not at Amazon**, and
**not one has ever been retired through this product** — which is why the graduation ceiling is
right to keep refusing AUTO, and exactly what the retirement path in §4 is for.

---

## 1 · (a) What exists — every wire

```
?tab=negative-targeting
└── RulesAutomationClient.tsx:402               ← tab === 'negative-targeting'
    ├── ProtectedTermsPanel.tsx                 (:406) the whitelist, above the rules
    └── RuleListTab liveType="negative-targeting"
        └── _shared/tabs.tsx:88  RULE_TAB_ACTION_TYPES['negative-targeting'] =
              ['harvest_and_negate','add_negative_exact','add_negative_phrase',
               'sync_negatives_across_campaigns']
            tabs.tsx:92  ruleBelongsToTab()      ← key and prop MATCH here (unlike SoV / Harvest)

Builder   builder/[type]/page.tsx → _shared/RuleBuilder.tsx
          :75   trigger  'negative-targeting' → SEARCH_TERM_WASTING
          :141  SETUP    "Negative Rule Setup" · targets panel · MATCH_TYPES_NEG
          :824  Negation Level  Ad Group | Campaign | Ad Group + Campaign
          :851  Protect converting  (toggle, DEFAULT ON) + :852 protectDays (default 30)
Adapter   ads-rule-adapter.service.ts:167-178   builder JSON → engine action
          :72   NEG_SCOPE = { adgroup:'AD_GROUP', campaign:'CAMPAIGN', both:'CAMPAIGN' }
          :174  protectConverting   :175 protectDays        ← written; see §2.1

Handlers  automation-action-handlers.ts
          :840   harvest_and_negate            → ads-harvest.service previewHarvest/applyHarvest
          :1011  add_negative_exact            → ads-negative-kw.service createNegative
          :1049  sync_negatives_across_campaigns → createNegative × every ENABLED campaign
          (none) add_negative_phrase           ← advertised on the tab, NO HANDLER (§2.5)

Write     ads-negative-kw.service.ts:138  createNegative  — idempotency probe → gate → SP v3
          ads-create.service.ts:1022  createNegativeKeywordLocal      (ad-group mirror)
          ads-create.service.ts:1065  createNegativeKeywordCampaignLocal (campaign mirror, NO gate)
          ads-create.service.ts:1001  createNegativeProductTargetLocal
          ads-keyword-funnel.service.ts:130  createNegative  ← the ONE caller that passes marketplace
          bulksheet/apply.ts:147,160,176     → the *Local helpers
          ads-v1-sync.service.ts:618         → inbound mirror of Amazon's own negatives

Gate      ads-write-gate.ts:300-337  AdKeywordProtection WHITELIST, matched EXACT|PREFIX|CONTAINS
          reached only when ctx.isNegation && ctx.keywordText  — one caller sets those (§2.2)

Storage   AdTarget { isNegative, kind, expressionType, expressionValue, negativeLevel, status,
                     externalTargetId, orphanedAt }        ← no author, no reason, no retiredAt
          AdKeywordProtection { mode, term, isPrefix, matchType, marketplace, campaignId, reason }
Audit     AdvertisingActionLog  actionType 'create_negative_keyword' | 'create_negative_product_target'
Undo      rollback.service.ts:151-168  invert-a-CREATE exists — gated on `bulksheet_create_*` only
Routes    advertising.routes.ts  :9812 GET · :9823 POST · :9848 DELETE  /keyword-protections
                                 :9928 PATCH /ad-targets/:id  (the only removal-shaped write)
                                 :7276 GET  /advertising/ngrams
Grids     campaigns/[id]/tabs/NegativeTargetsTab.tsx        ← campaign-scope negatives, on AdsDataGrid
          campaigns/[id]/ad-groups/[agId]/tabs/AgNegativesTab.tsx
Sibling   /marketing/advertising/ngrams — NgramClient.tsx, 47 lines, two tables + CSV
```

### Measured state, today

| | |
|---|---|
| negatives | **2,059** — KEYWORD 2,056 · PRODUCT 3 |
| distinct terms | **258**, across **109 campaigns** |
| level | AD_GROUP 2,037 · **CAMPAIGN 22** |
| status | ENABLED 1,997 · **ARCHIVED 62** |
| market | IT 1,542 · DE 282 · FR 170 · ES 65 |
| in an ENABLED campaign | **1,045** of 2,059 |
| never confirmed at Amazon (`externalTargetId` null) | **42** — all 22 CAMPAIGN-level + 20 ad-group |
| orphaned | **0** |
| rules on the tab | 7, **all PROPOSE, all ACCOUNT-WIDE**, 5 enabled |
| pending negation/harvest suggestions | **23** — 0 ever decided |
| protections | **10**, all WHITELIST, all `matchType=CONTAINS`, all seeded `adx:g4-seed` 2026-08-04 |

---

## 2 · (b) How it works — and the five things that do not

A negative in this system is **an `AdTarget` row with `isNegative = true`**, attached to an ad group,
carrying a match type in `expressionType` and a scope in `negativeLevel`. Nothing else marks it:
there is no author column, no reason column, no created-by-which-rule column, and no retired-at
column. Everything you would want to know about *why* a negative exists lives — if it lives at all —
in a separate `AdvertisingActionLog` row that must be joined by `entityId`.

### 2.1 🔴 "Protect converting search terms" is not implemented

`RuleBuilder.tsx:851-852` renders a switch, **on by default**, over this sentence:

> *"Never create a negative for a term that **converted** (≥1 order) in the last 30 days in any
> campaign — protects proven keywords from being blocked."*

`ads-rule-adapter.service.ts:174-175` faithfully carries it into the rule's action JSON as
`protectConverting` and `protectDays`.

`ACTION_HANDLERS.add_negative_exact` (`automation-action-handlers.ts:1011-1027`) reads
`action.keyword`, `action.externalCampaignId`, `action.scope`, `action.externalAdGroupId` — and
**nothing else**. `grep -rn protectConverting apps/api/src` returns exactly one hit: the adapter that
writes it. **There is no reader.** Same for `protectDays`.

This is the [stale-constant class](../.claude/projects/-Users-awais-nexus-commerce/memory/reference_fleet_stale_constant_class.md)
exactly: *a surface renders what no executor reads*. It matters more here than anywhere else it has
appeared, because:

- it is the **specific safety property** an operator would check before arming AUTO,
- it **defaults to on**, so its absence never announces itself, and
- it is the one control that would have prevented the finding the tab study led with.

Today it is harmless — every rule is on PROPOSE and no rule execution has ever created a negative
(tab study §2). It stops being harmless the moment you do what you asked for on 2026-08-10.

**Second defect in the same three lines:** `NEG_SCOPE` (`ads-rule-adapter.service.ts:72`) maps
`both → 'CAMPAIGN'`. Choosing **"Ad Group + Campaign"** in the builder produces one campaign-scope
negative, not two writes — the broader of the two, silently.

### 2.2 The whitelist binds one caller out of seven

The gate's own comment is right about where enforcement belongs:

> *"Checked here rather than in the harvest service because the harvest service is not the only
> thing that can negate a term, and a protection that only some callers honour is not a protection."*
> — `ads-write-gate.ts:300-303`

But the check only runs `if (ctx.isNegation && ctx.keywordText)` (`:304`), and **exactly one call
site in the repository sets those flags**: `ads-negative-kw.service.ts:171`. Every other path that
can create a negative reaches Amazon or the database another way:

| path | goes through the gate? | passes `isNegation`? |
|---|---|---|
| `createNegative` (ads-negative-kw) | yes | **yes** |
| `createNegativeKeywordLocal` (ads-create:1022) | yes — `{marketplace, payloadValueCents}` only | **no** |
| `createNegativeKeywordCampaignLocal` (ads-create:1065) | **no gate at all** | — |
| `createNegativeProductTargetLocal` (ads-create:1001) | yes, no `isNegation` | **no** |
| `bulksheet/apply.ts:147,160,176` | via the `*Local` helpers | **no** |
| `ads-blueprint-apply.service.ts:509` | via the `*Local` helpers | **no** |
| `ads-v1-sync.service.ts:618` (inbound mirror) | n/a — reads Amazon's truth | — |

And the two `*Local` helpers **write the local `AdTarget` row whether or not the gate allowed the
push** (`ads-create.service.ts:1030-1033` — the create is outside the `if (gate.allowed)` block).
So a denied write still produces a negative in our database, with `externalTargetId: null`.

**The protection is real, correctly placed, and covers the minority of the paths that can negate.**

### 2.3 🔴 The three rule paths cannot write at all — and the 22 rows prove it

`createNegative` needs `marketplace` for the gate. Three of its four callers omit it and suppress
the type error with `as never`:

```
automation-action-handlers.ts:1024   add_negative_exact               → no marketplace
automation-action-handlers.ts:1067   sync_negatives_across_campaigns  → no marketplace
ads-harvest.service.ts:98            applyHarvest campaign negation   → no marketplace
ads-keyword-funnel.service.ts:130    launchProductFunnel              → marketplace: mkt   ✓
```

`NEXUS_AMAZON_ADS_MODE=live` on production (verified). The gate's very first substantive check is
`if (!ctx.marketplace) return { allowed:false, deniedAt:'connection' }` (`ads-write-gate.ts:165-171`)
— **before** the protection check at `:304`. So those three paths are denied with
*"no marketplace on payload — cannot resolve AmazonAdsConnection"*, and their whitelist check never
executes.

The harvest path then writes the local mirror anyway (`ads-harvest.service.ts:99` →
`createNegativeKeywordCampaignLocal`, which has no gate), with `externalTargetId: null`.

**The data agrees exactly.** There are **22 CAMPAIGN-level negatives in the entire account. All 22
carry `expressionType = 'NEGATIVE_EXACT'` — the mirror-row spelling — and all 22 have no Amazon id.**
Every campaign-scope negative this system has ever created is **local-only; Amazon has never heard of
one.** They are counted by every screen, honoured by no auction.

### 2.4 Why the whitelist cannot see the base it governs

`ads-write-gate.ts:304-337` is a **decision made at write time on a term being negated**. It has no
sweep, no backfill, no reconciliation and no reader anywhere that walks `AdTarget` asking "does the
existing base contradict these ten rows?". `ProtectedTermsPanel` renders the ten protections and
nothing else; its only data call is `GET /advertising/keyword-protections`.

The ten were seeded on **2026-08-04**, by `adx:g4-seed`. The base was largely written on
**2026-05-20** (1,155 rows), **2026-07-31** (408), **2026-07-28** (204), **2026-07-01** (198).
The gate was installed two and a half months after the traffic it governs.

That is the whole mechanism. It is not a bug in the check; the check is correct. It is that
**"nothing can ever negate these" and "nothing currently negates these" are different sentences, and
only the first one is implemented.** §5 designs the second.

### 2.5 Two smaller wires that do not connect

- **`add_negative_phrase` has no handler.** It is listed on the tab (`tabs.tsx:88`), categorised
  (`rule-category.ts:35`), and ceilinged by graduation (`ads-graduation.ts:60,108`) — but
  `ACTION_HANDLERS` has no `add_negative_phrase`, so `automation-rule.service.ts:622-631` returns
  `Unknown action type` and marks the execution failed. No rule uses it today. Any rule that ever
  does will fail silently into the execution table.
- **`ProtectedTermsPanel.tsx:61` swallows a fetch failure into `setItems([])`.** An API outage
  renders "No protected terms yet" *plus* the red banner *"Nothing is protected. Auto harvest &
  negate is enabled…"*. The panel's alarm state and its offline state are the same pixels.
- **The panel cannot create the protection the gate wants.** `matchType` is the column that makes
  brand protection work — the schema comment says so at length (`schema.prisma:14103-14111`), the
  gate implements CONTAINS (`:322-327`), and all 10 live rows are CONTAINS. But `POST
  /advertising/keyword-protections` (`advertising.routes.ts:9823-9846`) **does not accept
  `matchType`**, and the migration backfilled `EXACT`/`PREFIX`
  (`20260804d_adx_g4_match_type/migration.sql`). The panel offers only a "Prefix" checkbox. **Every
  protection an operator adds through the UI is strictly weaker than the ten that are there** — it
  would catch `xavia` but not `giacca moto xavia`, which is the majority form.

---

## 3 · Corrections to the tab study

Four of its statements do not survive re-measurement. All four are mine.

| tab study said | measured today | why it matters |
|---|---|---|
| *"no UI lists a negative anywhere"* | **two grids exist** — `NegativeTargetsTab.tsx` (campaign) and `AgNegativesTab.tsx` (ad group), both on `AdsDataGrid`, both with **Archive / Pause / Enable bulk actions** | the retirement path is not a greenfield build; §4 extends what exists rather than inventing it |
| *"0 rollbacks"* | **9** `AdvertisingActionLog` rows rolled back all-time, across all action types — **0 of them on a negative**, and **0** `AD_ENTITY_STATE_UPDATE` logs exist on any negative | the original claim was right in substance and wrong in scope; the undo machinery works, it has just never been pointed at a negative |
| `_EXACT 1,416 · _PHRASE 591 · PHRASE 18 · EXACT 9` | **EXACT 1,393 · PHRASE 579 · _EXACT 32 · _PHRASE 30 · NEGATIVE_EXACT 22 · PRODUCT_EXACT 3** | still six spellings of two match types — but the leading-underscore forms are a **62-row fringe**, not 2,007 of them. Any normalisation is a much smaller job than the tab study implied |
| implied the whitelist might be weaker than advertised | **all 10 protections are `CONTAINS`** and **all 132 contradictions would be refused today** | I expected the opposite and checked. The going-forward gate is exactly as strong as the panel claims — for the one caller that reaches it (§2.2) |

One inference I refuse to publish: **62 negatives are ARCHIVED and all 62 share `updatedAt =
2026-08-11`** — which looks like "62 were retired today". It is not. **2,017 of 2,059 rows share that
same `updatedAt`**, because `ads-v1-sync.service.ts:622` stamps `lastSyncedAt` on every matched row
each ingest and `@updatedAt` follows. The column records the last ingest tick, not the last decision.
**There is no timestamp anywhere in this schema for when a negative was retired.**

---

## 4 · (c) 🔴 The retirement path, designed

This is the deliverable that unblocks AUTO. `ads-graduation.ts` refuses to let a structural action
self-arm because *"each needs a retirement path designed alongside it, and none has one yet"*
([study 10 §1](2026-08-11-auto-automations-study.md)). Here is the one.

### 4.0 What "undo" means for a negative — settle this first

Amazon has **no delete for a negative keyword. Archive is the delete, and archive is terminal.**
Two independent confirmations:

- our own code, in the one place that already inverts a create:
  *"Archive IS the delete on Amazon for these entities — there is no delete endpoint for a keyword or
  a product ad, and archive is terminal, which is exactly the semantics wanted here."*
  (`rollback.service.ts:151-156`)
- [Karooya, on removing an Amazon negative](https://www.karooya.com/blog/how-to-remove-negative-keyword-from-amazon-ads/):
  archiving is the only option, *"the archived keywords cannot be accessed again. If you want to add
  the same negative keyword again, you will have to add it to the account manually."*

**Therefore: "remove a negative" = archive at Amazon + keep our row with a retirement record.**
Un-archive is not available; re-negating the same term later is a *new* negative, and the page must
say so in the confirm dialog rather than implying a toggle. This is the honest shape and it is also
the safer one — it makes removal a decision with a record, which is precisely what the base lacks.

### 4.1 🔴 The trap that will break a naive implementation

The removal write already has rails: `PATCH /advertising/ad-targets/:id` with `status: 'ARCHIVED'`
→ `updateAdTargetWithSync` → `OutboundSyncQueue` → `ads-sync.worker`. **Do not use them unchanged.**

`ads-sync.worker.ts:200-206` routes an `AD_TARGET` write by `kind`:

```
DL.1 — the kind decides the endpoint: keyword ids live under /sp/keywords,
       product and auto target ids under /sp/targets.
```

`ads-api-client.ts:1187-1188` implements exactly that: `PRODUCT|AUTO → /sp/targets`, **everything
else → `/sp/keywords`**. A negative keyword has `kind = 'KEYWORD'`. Its id does **not** live under
`/sp/keywords` — it lives under `/sp/negativeKeywords` (ad-group scope) or
`/sp/campaignNegativeKeywords` (campaign scope), which is precisely where
`ads-negative-kw.service.ts:61-65` writes them in the first place.

So the archive would `PUT /sp/keywords` with a negative-keyword id, Amazon would answer
`entityNotFoundError` naming `$.keywords[0].keywordId`, and then:

- `isEntityGoneError(err, {kind:'KEYWORD'})` — `mentionsWrongEndpointFor` returns **false**, because
  the error is keyword-shaped and the kind *is* KEYWORD, so the DL.3 guard sees no contradiction
  (`amazon-entity-gone.ts:66-77`);
- the worker sets **`orphanedAt`** and stamps *"Amazon reports this entity no longer exists"*
  (`ads-sync.worker.ts:264-283`);
- `orphanedAt` then **blocks every future non-forced write to that row**
  (`ads-mutation.service.ts:966-983`), and `isContradictoryOrphan` cannot clear it — the reason says
  "keyword", the kind says KEYWORD, no contradiction to read (`amazon-entity-gone.ts:104-107`).

**The negative would remain live at Amazon, be marked dead in our database, and become permanently
unwritable.** The exact deadlock WF.1 was written to escape, re-created on a new entity class.

This has **not happened yet**: `orphanedAt = 0` across all 2,059 negatives, and there are **0
`AD_ENTITY_STATE_UPDATE` action logs on any negative** — nobody has ever pushed a state change to
one. The trap is latent, and it is latent *because* the feature is missing. Building the feature is
what springs it.

**The fix is one branch, not a rewrite:** route by `(kind, isNegative, negativeLevel)` rather than by
`kind` alone —

| kind | isNegative | negativeLevel | endpoint |
|---|---|---|---|
| KEYWORD | false | — | `PUT /sp/keywords` *(today)* |
| PRODUCT / AUTO | false | — | `PUT /sp/targets` *(today)* |
| KEYWORD | **true** | AD_GROUP | **`PUT /sp/negativeKeywords`** |
| KEYWORD | **true** | CAMPAIGN | **`PUT /sp/campaignNegativeKeywords`** |
| PRODUCT | **true** | — | **`PUT /sp/negativeTargets`** |

and widen `mentionsWrongEndpointFor` to treat a *positive*-keyword-shaped miss on a **negative** row
as a routing fault, so a mistake here suppresses an orphan mark instead of minting one.

**The 42 rows with no Amazon id need a different answer.** They are not at Amazon, so there is
nothing to archive; removing one is a local delete plus an audit row. The UI must distinguish
"retired at Amazon" from "removed a row Amazon never had" — they are different facts and conflating
them is how a split-brain becomes invisible.

### 4.2 The object: a negative, and a negation

The base is **2,059 rows over 258 terms**. That ratio is the design.

| rows per term | terms |
|---|---|
| 1 | 16 |
| 2–5 | 115 |
| 6–20 | 112 |
| 21–50 | 12 |
| **51+** | **3** |

`giacca moto` is negated in **72 rows, 49 ad groups, 41 campaigns**. `giacca moto uomo` in 66 / 47 /
40. `giubbotto moto` in 55 / 38 / 33.

An operator does not think "archive these 72 rows". They think **"stop blocking `giacca moto`"** — or
more often, "stop blocking it *here*". So the page needs two grains and must never blur them:

- **the negation** — one `AdTarget` row: term × match type × one ad group (or one campaign). This is
  what Amazon has and what gets archived.
- **the term** — a Nexus-side grouping over negations sharing `normaliseTerm(expressionValue)`. This
  is what the operator reasons about, filters by, and bulk-acts on.

Amazon cannot back the second one. [Karooya is explicit](https://www.karooya.com/negative-keywords-for-amazon-ads)
that *"Amazon Ads doesn't natively support … account-level negative keyword management"* and that
their shared negative lists are an emulation layer over per-campaign writes. Ours must be the same:
**a term is a view, a fan-out and an audit grouping — never a stored Amazon object.** Every bulk
action writes N real archives and reports N outcomes, not one.

### 4.3 The four operations

**1 · List.** `GET /advertising/negatives` — the inventory. One row per negation, groupable by term.

| column | source | note |
|---|---|---|
| term | `expressionValue` | the grouping key when grouped |
| match type | `expressionType`, **normalised** | six spellings collapse to EXACT / PHRASE / ASIN at read time — do not migrate the column (§7.3) |
| scope | `negativeLevel` + campaign › ad group | "campaign-wide" vs one ad group is the difference between blocked and funnelled |
| market | campaign.marketplace | |
| campaign state | campaign.status | **1,014 of 2,059 sit in PAUSED campaigns** — inert, and must not be counted as blocking |
| at Amazon | `externalTargetId != null` | **42 rows say no** |
| added | `createdAt` | |
| by | joined `AdvertisingActionLog.userId` | **null for 1,225 rows (59.5%)** — the column must render "unknown", not blank |
| why | `AdvertisingActionLog.evidence` | **0 rows carry it today** |
| term performance | `AmazonAdsSearchTerm`, 30/60d | impressions · clicks · spend · orders · sales · ACoS, **account-wide, not scoped to this ad group** — the number that tells you whether removing it is safe |
| conflict | §6 | badge, computed |

Default filter: **`status = ENABLED` AND campaign is ENABLED** → 1,045 of 2,059. Everything else is
one toggle away, because "what am I blocking *right now*" is the question the page exists to answer.

**2 · Remove one.** Row action → confirm → `PATCH /ad-targets/:id {status:'ARCHIVED'}` on the fixed
routing of §4.1. The confirm dialog carries three facts, all already computable:

> **Stop blocking `chaqueta moto verano hombre`** in `ES_Phrase_3_Keywords › Phrase - Keywords`?
> This term earned **€105.00 from 1 order** in the last 120 days and has taken **no impressions in
> the last 30**. It is also negated in **3 other ad groups**, which will keep blocking it.
> Archiving at Amazon **cannot be undone** — re-negating later creates a new negative.

**3 · Bulk-remove by term.** The 51+ cases make this mandatory. Select a term → the drawer lists all
N negations with per-row scope and campaign state → select all / only-live / only-this-market →
archive. **Progress and per-row outcome must be visible**: 72 writes will not all succeed, and a bulk
action that reports one number for 72 attempts is how the 42 orphan rows happened in the first place.
Reuse the existing `bulkPatch('ad-targets', ids, body)` used by `NegativeTargetsTab.tsx:70`.

**4 · Record the reason and the numbers at the time.** This is the part with no existing rails, and
the part that makes a review in a month possible.

`AdvertisingActionLog` already has the shape: `payloadBefore` / `payloadAfter` / `userId` /
`evidence`. `AdWriteEvidence` (`ads-evidence.ts`) already carries `metric · observed · threshold ·
windowDays · sampleSize · note`. **Nothing writes it for a negative — 0 of 856 create logs carry
evidence.** So:

- **on create**, every negation path stamps evidence: the metric that triggered it (`spend with 0
  orders`), the observed value, the threshold, the window, and the rule or actor. `createNegative`
  and both `*Local` helpers take an `evidence` argument and pass it to `audit()`.
- **on retire**, the same, plus the term's performance snapshot at the moment of removal, so
  "did removing this help?" is answerable later without reconstructing history.
- **backfill what can be backfilled**: 834 rows have a log with an author; 1,225 have nothing and
  never will. The list must render that honestly rather than inventing "system".

### 4.4 What must be true before AUTO — and it is not a long list

1. §2.1 fixed: `protectConverting` **read and enforced** in `add_negative_exact` and in
   `applyHarvest`, with a test that fails if the branch is removed.
2. §2.3 fixed: `marketplace` passed by all four `createNegative` callers, so the gate reaches its
   protection check instead of denying at `connection`.
3. §4.1 fixed: negative-aware endpoint routing, so a retirement lands.
4. §4.3 shipped: list, remove, bulk-remove, evidence on both create and retire.
5. **Scope bound.** All seven rules are ACCOUNT-WIDE today. `sync_negatives_across_campaigns` on IT
   would write **74 campaign-level negatives per execution** — the single widest blast radius in the
   section, from a rule whose daily cap is 20. On AUTO, unscoped, that is a structural change to the
   whole Italian account per tick.
6. The 132 whitelist contradictions triaged (§5), so AUTO is not appending to a base nobody has read.

Only then is the graduation ceiling's condition actually met. Until then it is correct and should
stay closed — and I would say that even if you had not already accepted it.

---

## 5 · (d) The whitelist audit, both ways

**132 negatives contain a protected term.** Verified: with all ten protections on `CONTAINS`, **all
132 would be refused if written today.** The gate is exactly as strong as the panel claims. The base
predates it.

Match semantics matter, and are worth putting on the screen:

| semantics | contradictions |
|---|---|
| EXACT | 32 |
| PREFIX | 96 |
| **CONTAINS** *(what is configured)* | **132** |

### The triage, and why the study cannot make this call

The tab study sampled nine rows and read six as deliberate funnel architecture. Over all 132, with
the campaign name as the classifier:

| | rows | reading |
|---|---|---|
| the protected term **is the line the campaign is named for**, in a **brand** campaign | **54** | 🔴 hard to defend |
| a **different** line's term, in a brand campaign | **45** | ⚠ plausible cross-line routing |
| not a brand campaign at all (Auto / Category / Generic) | **33** | ✓ standard funnel |

The 54 are the ones that read as accidents: `airmesh` negated in `IT-AIRMESH-SP-Brand-Broad`,
`aireon` in `IT-AIREON-SP-Brand-Broad`, `gale` in `GALE | IT | Broad | Brand`, `moss` in
`IT-MOSS-SP-Brand-Phrase`. A campaign whose name says it exists to capture a brand term, negating
that brand term, leaves the traffic nowhere to go.

The 45 are genuinely ambiguous and **I am not going to guess**. XAVIA is the house brand; AIREON,
AIRMESH, GALE, MOSS, MISANO are lines. `xavia` negated inside `IT-AIRMESH-SP-Brand-Broad` could be
sloppiness or could be a deliberate decision to route bare-brand queries to a house-brand campaign
and keep the AIRMESH campaign for `xavia airmesh`. **Only you know which.** That is the whole reason
the audit needs a marking action rather than a verdict.

### The design: two lists and one mark

On the page, under the protections:

- **"Will be blocked"** — what the ten terms refuse going forward. Static, cheap, already true.
- **"Already contradicts"** — the 132, grouped by protected term, each row showing the negation's
  campaign › ad group, its scope, whether the campaign is live, and the term's 30-day performance.
- **one action per row: `Intended funnel` | `Remove`.**
  - `Intended funnel` writes an exemption — I would store it as an `AdKeywordProtection` row with
    `mode='WHITELIST'`, the same `term`, and `campaignId` set to that campaign, plus a `reason`.
    That reuses the existing table and its existing gate semantics (`ads-write-gate.ts:308-313`
    already ANDs `campaignId IS NULL OR campaignId = ctx.campaignId`) — but note it currently
    *narrows* protection rather than exempting from it, so this needs either an
    `mode='EXEMPT'` variant or an explicit `exempt` boolean. **A new enum value is the cleaner
    call**; the marking is a different concept from a protection and should not be spelled the same.
  - `Remove` runs §4.3's removal.
- **The counter must converge.** A whitelist audit that shows 132 forever is one an operator learns
  to ignore. Marked rows leave the list and land in a "reviewed" tab with who marked them and when.
  That is the difference between an audit and an alarm.

**And fix the panel while you are in there** (§2.5): expose `matchType` on the POST route and as a
three-way control, so a protection an operator adds is as strong as the ones that are there.

---

## 6 · (e) Conflict detection

*"Negated here, converting there"* is a named feature in the field —
[Adalysis ships "Keyword conflicts"](https://docs.adalysis.com/tools/audit/prebuilt-alert-list/keywords/keyword-conflicts),
which *"alerts you to negative keywords (ad group, campaign, or list-level) that are blocking a
regular keyword"*, shows the **matched search terms** in an expandable column with a **"show last 30
days performance"** toggle, and *"will flag if there's a potential conflict … when you're creating
new negative keywords"* — i.e. both a standing audit **and** an at-write warning. That is the right
shape and we should copy it.

But the naive version of it **cries wolf**, and this account proves it.

### The trap, measured

A negative is scoped to one ad group. "Negated" does not mean "blocked". Joining negated terms to
30-day search-term data at the **term** grain:

| | terms |
|---|---|
| negated terms with any traffic in 30d | **77** of 258 |
| — converting (≥1 order) | **12** |
| — clicks, no orders | **65** ← *the negatives working* |
| no traffic at all | **181** |

Twelve converting terms, **€2,834.76 of sales on €868.90 of spend**. Report that as "conflicts" and
you have twelve false alarms, because at the **ad-group** grain:

| term | negated in | took traffic in | **overlap** | orders | sales |
|---|---|---|---|---|---|
| motorrad jacke | 9 ag + 1 camp | 1 | **0** | 8 | €665.53 |
| motorrad jacke herren | 17 + 1c | 4 | **0** | 7 | €590.23 |
| motorradjacke herren | 19 + 2c | 3 | **0** | 6 | €499.14 |
| giacca moto estiva uomo | 17 + 1c | 8 | **0** | 3 | €285.21 |
| giacca moto uomo | 43 + 4c | 9 | **0** | 2 | €167.22 |
| giacca moto | 48 + 2c | 6 | **0** | 1 | €81.15 |
| **saponette moto** | **4** | **5** | **1** | 2 | €49.18 |

**One** of the twelve has a live overlap. The other eleven are the funnel doing exactly what it was
built to do. A term-grain alert would be wrong 92% of the time on this account; the ad-group-grain
join is right.

*(The campaign-scope negatives in that table — the `+Nc` column — are the 22 local-only rows of §2.3.
They block nothing at Amazon. A correct detector must exclude a negation with no `externalTargetId`,
or it will report a conflict that physically cannot exist.)*

### Two detectors, not one

**Detector A — live conflict.** For each negation with an Amazon id, in an ENABLED campaign: did its
own ad group take impressions for that exact term in the window? Today: **1** (`saponette moto`,
overlapping 1 of the 5 ad groups where it runs, 2 orders, €49.18).

**Detector B — suppressed earner.** The one that would have caught `xavia`. A term with **zero
traffic in 30 days** but **orders in the 120 days before**, still negated in a **live** campaign:

| term | negated in | of which live | orders (120d) | sales | ACoS |
|---|---|---|---|---|---|
| **xavia** | 16 | **16** | 1 | €122.91 | **1%** |
| chaqueta moto verano hombre | 4 | **1** | 1 | €105.00 | 13% |
| chaqueta moto hombre verano | 1 | **1** | 1 | €105.00 | 15% |
| giacca pelle moto | 3 | 0 | 1 | €122.91 | 5% |
| giacca in pelle moto uomo | 2 | 0 | 1 | €122.94 | 2% |

The last two resolve themselves: their campaigns are paused, so the negative is not the cause — and
the detector must say so on the row rather than making the operator work it out. Three genuine
candidates, one of them a protected brand term negated in sixteen live ad groups.

**Both are cheap.** One grouped read of `AmazonAdsSearchTerm` by `(query, adGroupId)` over the window,
joined in memory to the negation set — the exact query in `_neg-page-conflict.mts`, which returns 188
rows for this account. It belongs on the page as a standing count and in the create-confirm dialog as
a warning, as Adalysis does both.

**Do not report a euro figure as "lost revenue".** €2,834.76 is the sales those terms made *while
negated somewhere*; the loss is at most the overlap, and probably a fraction of it. The tab study's
conclusion flipped twice on precisely this, and the page should be built so it cannot flip a third
time: **show `negated in` / `runs in` / `overlap` as three separate numbers, always.**

---

## 7 · (f) How this page is supposed to be

> **Two questions: what am I blocking, and what is it costing me?**

### 7.1 The shape

Route `/marketing/ads/rules-automation/negative-targeting`, four sections, in this order — the
inventory first, because the base is the thing nobody can see:

**1 · Inventory** — the default view. `AdsDataGrid`, one row per negation, columns per §4.3,
grouped-by-term toggle. Toolbar: search · market · scope (campaign/ad group) · match type · campaign
state · "at Amazon" · "has conflict". Selection actions: **Remove**, **Mark intended**, **Export**.
Above it, a strip of four counts that are each a filter: **2,059 negatives · 258 terms · 1,045 live ·
42 not at Amazon**.

**2 · Attention** — three lists, each a count that can reach zero:
- **conflicts** (§6): live overlap **1** · suppressed earner **3**
- **whitelist contradictions** (§5): **132**, converging as they are marked
- **split-brain**: **42** negations Amazon has never confirmed

**3 · Protected terms** — the existing panel, plus the "already contradicts" list, plus `matchType`.
It keeps its position *above* the rules for the reason its own comment gives, and moves *below* the
inventory, because the inventory is what you came for.

**4 · Rules** — the seven, unchanged in function: `RuleListTab liveType="negative-targeting"`. Each
row shows its ceiling and, once §2.1 is fixed, whether `protectConverting` is on. A rule proposing
into a queue nobody empties (23 pending, 0 ever decided) should say so on its own row.

### 7.2 Proposals show the term's full history

Your ask, and the thing every serious tool does. A proposal to negate must render, before you
approve: impressions · clicks · spend · orders · sales · ACoS over the window, **which ad groups it
already runs in**, whether it is protected, and whether Detector A or B would fire. Every one of
those is available from `AmazonAdsSearchTerm` and `AdTarget` in two reads — `previewHarvest()`
already computes most of it and nothing renders it (study 8 §8).

### 7.3 The six spellings — read-time, not migration

`EXACT 1,393 · PHRASE 579 · _EXACT 32 · _PHRASE 30 · NEGATIVE_EXACT 22 · PRODUCT_EXACT 3`.

**Do not migrate this column.** Three services already carry correct dual-spelling probes that a
migration would silently invalidate (`ads-negative-kw.service.ts:83-88`,
`ads-create.service.ts:1069-1074`, `ads-coverage.service.ts:290-292`), and the underscore forms are a
62-row fringe, not the majority the tab study reported. **Normalise at read time in one exported
helper, use it everywhere the page displays or filters a match type, and leave the writes alone.**
The rule that must never be broken is the one already in memory and in three file headers:
**negativity is `isNegative`, never `expressionType`.**

### 7.4 The URL contract

Every view linkable, so a conflict can be pasted into a message:

```
/marketing/ads/rules-automation/negative-targeting
  ?market=IT|DE|FR|ES|all
  &scope=adgroup|campaign|all
  &match=exact|phrase|asin|all
  &state=live|paused|archived|all         (campaign state)
  &amazon=yes|no|all                      (externalTargetId)
  &view=negations|terms                   (the two grains of §4.2)
  &q=<search>
  &focus=<term>                           (opens the term drawer)
  &alert=conflict|suppressed|whitelist|splitbrain
  &window=30|60|120
```

`focus` and `alert` are the two that matter: they make "look at this" a link.

---

## 8 · (g) Should the n-gram page fold in?

**Yes — as a panel on this page, and the standalone route should redirect.**

`/marketing/advertising/ngrams` is `NgramClient.tsx`, **47 lines**: two tables (winning, wasteful),
a CSV button each, no negate action, no market filter, no link to or from this tab. It reads
`GET /advertising/ngrams` → `ads-ngram.service.ts`, which is genuinely good — it tokenises every
search term into 1- and 2-grams and aggregates account-wide, which is exactly the industry's primary
negation surface.

[Ad Badger's framing](https://www.adbadger.com/blog/amazon-ppc-education/negative-keywords-amazon-ppc/)
is the argument in one line: an n-gram tool *"scans your entire account at once instead of one
campaign at a time, so if a term like 'cheap' is wasting spend across twelve different campaigns, you
see that pattern in one place."*
[Adbrew ships it as a report you filter and act on](https://adbrew.io/blog/n-gram-analysis-for-amazon-ads):
*"filter your N-gram report for low-performing phrases that have received sufficient clicks but are
not driving orders, and add these keywords as negative phrases."*

Measured on our account, 60d, top wasteful grams:

| gram | spend | clicks | terms | already negated as a whole term |
|---|---|---|---|---|
| protezioni | €132.86 | 341 | 193 | no |
| dainese | €80.13 | 181 | 92 | **yes** |
| homologué | €73.06 | 149 | 45 | no |
| homme homologué | €63.86 | 130 | 34 | no |
| 5xl | €54.68 | 119 | 59 | no |
| moto protezioni | €49.87 | 127 | 63 | no |
| protecciones | €49.41 | 91 | 34 | no |
| 6xl / 7xl | €48.98 / €41.16 | 103 / 94 | 55 / 41 | no |

**Of the top 50 wasteful grams, 3 are covered by our 2,059 negatives.** The account has negated 258
whole phrases and left the *words* those phrases share almost untouched. `protezioni` alone spans
193 search terms and 341 clicks.

Two cautions the panel must carry, because they are not obvious:

- **`5xl` / `6xl` / `7xl` are not waste, they are a catalogue gap.** Negating them hides a demand
  signal. A wasteful-gram list without that caveat invites exactly the wrong action.
- **A gram is not a term.** Negating `protezioni` as a phrase blocks `giacca moto con protezioni`
  too. The winning-gram list is the safety rail and must sit beside it — `xavia` is the account's
  **top winning gram** at ROAS 57.5, and `rückenprotektor` (ROAS 39.6) is one edit away from
  `protezioni`'s neighbourhood.

So: fold it in as **"Wasteful words"**, beside the inventory, with per-gram *"show the N terms"*
expansion, a **negate-as-phrase** action that routes through the same confirm-and-evidence path as
everything else, and the winning grams visible in the same view. Keep the standalone route as a
redirect — it is the only account-wide surface we have and it should not be orphaned in another
section.

---

## 9 · (h) Industry research — features and interface

### 9.1 The field, on negation specifically

| platform | how negatives are proposed | scope | approval | pricing tier |
|---|---|---|---|---|
| **Pacvue** | rules over the search-query report; *"the moment a term crosses your spend threshold, it gets negated automatically"*; harvesting and negation configured **in the same rule screen as bids** | campaign-level in their own guide | enterprise **approval workflows**, portfolio-level controls | enterprise, spend-based |
| **Ad Badger** | named thresholds you can edit: **>2,500 impressions & <0.18% CTR & 0 conversions**, **>$35 spend & 0 conversions**, **>34 clicks & 0 conversions**; scans nightly over six months of history | campaign / ad group | rules run unattended once configured | mid-market SaaS |
| **Teikametrics Flywheel** | AI surfaces *"the lowest performing search terms … as negative keyword recommendations"*, **weekly**, at **$5 spend with no sales** | product / campaign | accept-per-recommendation | mid-market |
| **Scale Insights** | 12 stackable algorithms, operator owns the logic; ASIN-level | ASIN / campaign | rules | **$78/mo for 5 ASINs → $288 for 35; 1% of ad spend unlimited** — every plan has every feature |
| **Adbrew** | n-gram report → filter for clicks-without-orders → add as negative phrases; **a dedicated page for managing targets, campaigns, search terms, negatives and products** | bulk across all | bulk edit | **from $799/mo or % of spend**; aimed at $30k+/mo ad spend |
| **Karooya** | negative keywords **as its own discipline**: statistical analysis of the query archive, campaign *and* account-level recommendations, "custom negative terms" to test your own ideas, Excel export | campaign / ad group / **emulated shared lists** | review before applying; *"review actual search queries before blocking them"* | **free under $3k/mo spend**, then ~$100/mo; managed from $100/mo |
| **Helium 10 Adtomic** | rule type *"find poor performing search terms & ASINs"*, thresholds on clicks or spend | campaign | rules + suggestions | bundled — moved from Diamond to **Platinum** in 2026 |
| **Adalysis** *(Google/Bing, worth adding)* | **negative keyword conflict detection** — negatives blocking active keywords, flagged as a standing audit alert **and** at the moment you create a new negative | ad group / campaign / list | audit alert queue | mid-market |

**We are in Karooya's and Scale Insights' economic tier, not Pacvue's or Adbrew's.** €150/day on
GALE plus the rest puts the account nowhere near the $30k/month Adbrew's floor implies. That matters
for what to copy: the enterprise approval-workflow apparatus is not the model. Karooya's shape — a
focused negatives discipline with review-before-apply and a free tier under $3k — is.

### 9.2 What the screens look like

Consistent across the tools, and the four elements are all missing here:

- **A candidates queue** with tiering rather than a flat list — *"bulk-approve Must-Add and
  Recommended, ignore edge cases, add customs as needed, push to campaigns, ad groups, or shared
  lists, track impact, and iterate weekly"* is the 2026 workflow as described across several
  buyer's guides. Ours has 23 pending suggestions and no screen that renders one.
- **The threshold as a visible dial**, with the candidate count moving as you drag it. Ad Badger and
  Teikametrics both put their numbers on screen; ours are defaults buried in a service
  (`minSpendCents = 1000`, `minOrders = 2`).
- **A negatives inventory as a first-class grid** — Adbrew names "negatives" as one of its dedicated
  management pages. We have 2,059 negatives and two per-campaign grids you can only reach by already
  knowing which campaign to open.
- **Conflict warnings at the point of decision**, not only in a report (Adalysis).

### 9.3 What we have that no competitor in the research ships

**An account-wide never-negate whitelist enforced at the single write chokepoint.** Pacvue negates on
a threshold; nothing in the research sits above the rule saying *never this word, whatever the
numbers say, whichever engine asks*. Ad Badger mentions whitelisting competitor keywords as a
practice, not as an enforced object.

Pacvue's own guidance is the case for it, and reads as a description of our gap:
*"regularly monitor your existing list of negative keywords to ensure you're not accidentally
redirecting traffic from your listings and blocking potential customers"*, and *"avoid list
stuffing — including too many negative keywords can do more harm than good."*
**The field says to review the base. Nobody in the field gives you a tool that does it. We have the
better primitive and have never pointed it at our own data.**

### 9.4 One to steal, one to avoid

**Steal: Adalysis's two-place conflict check.** Standing audit alert *and* an at-create warning, with
the matched search terms expandable and a 30-day performance toggle. It is the same computation
surfaced at both moments a human can act on it, and it is precisely the feature that would have
surfaced `xavia` the day it was negated.

**Avoid: Pacvue's real-time auto-negate.** *"The moment a term crosses your spend threshold, it gets
negated automatically."* On an account where **the whole 60-day wasteful-gram spend of the top ten
grams is €638**, a real-time trigger optimises noise. Worse, it is the exact pattern that fills an
un-reviewable base — which is the situation we are now designing our way out of. **Batch it, review
it, apply it deliberately.** The equivalent trap already bit this section once: `sync_negatives_
across_campaigns` would write 74 campaign-level negatives per execution on IT, and it is enabled.

---

## 10 · (i) Requirements on the shared layer

Constraints, not solutions. A twelfth pass reconciles all eleven.

**R1 · `AdsDataGrid` must support a two-grain view.** 2,059 rows over 258 terms; the operator works
at the term grain and Amazon works at the negation grain. Either a group-by with expandable parents,
or a first-class detail drawer that itself contains a grid. *(Keyword Tracker and Share of Voice have
the same shape — terms with many per-market rows — so this is probably a shared need, not mine.)*

**R2 · Bulk actions must report per-row outcomes.** A term-level archive is 72 independent writes
with independent failure modes. A single "done" toast over 72 attempts is how the 42 unconfirmed
rows became invisible. The grid's `selectionActions` contract needs a results surface — count
succeeded / failed / skipped, with the failures listed.

**R3 · A confirm-with-evidence dialog.** Not a generic "are you sure": a slot for two or three
computed facts and an irreversibility warning. Negatives are irreversible at Amazon; so are archives
generally. This is not negative-specific and should not be built here alone.

**R4 · The URL contract must carry `focus` and `alert`.** Deep-linking to *one entity* and to *one
alert class* is what makes cross-page real-time sync worth anything — a conflict found here is a
link pasted into a message, not a description of where to click.

**R5 · Cross-page: a negative is created on at least three pages.** This one, Keyword Harvest (via
`harvest_and_negate`), and the campaign/ad-group grids. **Creation must funnel through one service
that stamps evidence and honours the protection**, or the audit trail forks again. This is a
requirement on the *write* layer, not the UI, and it is the single most important shared-layer ask I
have.

**R6 · The scope form must be usable at the ad-group grain.** RA.GRAIN shipped market · portfolio ·
product line · campaign (study 10 §2). A negation rule's natural scope is the **ad group** —
"harvest from these, negate in those" is already how the builder's source blocks work. If the shared
scope form cannot express it, negation rules stay account-wide, which §4.4 lists as a blocker for
AUTO.

**R7 · The real-time sync layer must invalidate on a *term*, not only on an entity id.** Removing
`giacca moto` touches 41 campaigns. Any page showing a campaign's negative count is stale the moment
that bulk action completes.

**R8 · Do not put the negatives count in the tab badge.** The tab badge counts *rules*
(`tabs.tsx:111-112`, computed from `RULE_TAB_ACTION_TYPES` so *"a label can never claim a number its
tab won't show"*). That invariant is good; the inventory count belongs in the page's own strip.

### The boundary with session 8 (Keyword Harvest)

`harvest_and_negate` appears on both tabs and will keep doing so. The split I want:

| | owns |
|---|---|
| **Harvest (8)** | the **candidates**: which search terms have earned promotion or negation, the thresholds that decide, the preview, the approve/reject queue. A harvested term's *negation at source* is part of the harvest transaction and belongs in their confirm dialog, not mine. |
| **Negatives (7)** | the **consequences**: the inventory of what is blocked, the protections, the conflicts, the retirement path, the n-grams. |

Concretely: **when Harvest promotes-and-negates, it calls the negation service this page owns** —
one service, one evidence stamp, one protection check (R5). Harvest decides *whether*; this page owns
*what it becomes and how it is undone*. Study 8 found that standalone `promote_to_exact` does not
negate the source while `harvest_and_negate` does; whichever way they resolve that, the write lands
in one place.

One shared object needs a single owner: **the pending-suggestion queue** (23 negation/harvest rows,
0 ever decided). It is one queue across both tabs and should be rendered once, filtered per page.
I do not need to own it; I need it to exist and to be filterable by action type.

### The boundary with session 10 (Automations)

Automations owns the **ceiling** and the **mode dial**. I am not asking to change either — I am
supplying the evidence for when the ceiling can lift, and §4.4 is that list. Three asks:

- the ceiling's stated reason (*"needs a retirement path"*) should become a **link to the built
  path**, and the readiness verdict should check the six conditions rather than a hard-coded family
  list;
- their conflict detector's blind spot (same-trigger only, study 10 §3) is not mine to fix, but
  **"how many rules can negate in this ad group today"** is the entity-grain question my page needs
  answered and theirs is designed to answer;
- `protectConverting` (§2.1) is a **rule-level safety property**. If it ends up rendered on the rule
  row rather than in my builder, that is fine — but it must be enforced in the handler either way.

---

## 11 · (j) Tiered implementation plan

### Tier 0 — stop the page misleading, and see the base *(hours; no new routes needed)*

- **Fix `protectConverting`** — read it in `add_negative_exact` and in `applyHarvest`, with a test.
  Nothing else on this list matters if the safety toggle stays decorative. *(§2.1)*
- **Pass `marketplace`** in the three `createNegative` callers, and delete the `as never` casts that
  hid it. *(§2.3)*
- **The inventory list**, read-only: `GET /advertising/negatives` + an `AdsDataGrid` with the columns
  of §4.3. 2,059 rows exist and no account-wide screen shows one. *(§4.3)*
- **The whitelist audit**, read-only: the 132, grouped, on the protections panel. One query.
  *(§5)*
- **The two conflict counts**, read-only: 1 live overlap, 3 suppressed earners. One query. *(§6)*
- **Surface the 42 split-brain rows** — a negative Amazon has never confirmed is not a negative.
- **Fix `matchType` on the protections POST** and expose it in the panel. *(§2.5)*
- **Fix `ProtectedTermsPanel.tsx:61`** so an API failure does not render as "nothing is protected".

### Tier 1 — the retirement path *(days; this is the gate for AUTO)*

- **Negative-aware endpoint routing** in `updateTarget` + the orphan guard. **Do this first** — every
  removal below is broken without it, and broken in a way that permanently poisons rows. *(§4.1)*
- **Remove one**, with the confirm-and-evidence dialog. *(§4.3)*
- **Bulk-remove by term**, with per-row outcomes. *(§4.3, R2)*
- **Evidence on create and on retire** — `AdWriteEvidence` through `createNegative` and both `*Local`
  helpers into `audit()`. *(§4.3)*
- **`Intended funnel` marking**, so the 132 converge. *(§5)*
- **Local-only removal** for the 42 rows Amazon never had. *(§4.1)*

### Tier 2 — the page as a page *(days)*

- The four sections of §7.1, the URL contract of §7.4, read-time match-type normalisation (§7.3).
- **Proposals rendered with the term's full history** — `previewHarvest()` already computes it (§7.2),
  in concert with session 8.
- **Fold in the n-grams** as "Wasteful words", with the winning grams beside them and the negate-as-
  phrase action on the same rails. Redirect the old route. *(§8)*
- **Conflict warning at create time**, the Adalysis pattern's second half. *(§6, §9.4)*

### Tier 3 — arm AUTO

**Only when all six conditions of §4.4 hold.** In order, and the order is not negotiable: the
protection must be enforced (2.1), the gate must be reachable (2.3), the removal must land (4.1), the
inventory and undo must exist (4.3), the rules must be scoped (74 campaign negatives per execution is
not an account-wide-rule kind of action), and the 132 must be triaged.

Then arm **one rule, at one scope, on OBSERVE first** — the ladder's second rung has never been used
by anybody (study 10 §2), and the first structural action in the account's history is the right place
to start using it.

---

## 12 · Open questions

1. **The 45 ambiguous whitelist rows** (§5) — `xavia` negated inside `IT-AIRMESH-SP-Brand-Broad` and
   the like. Deliberate cross-line routing, or fallout from the 2026-05-20 import? I have designed a
   marking action instead of guessing, but if the answer is "all accidents" the triage is one bulk
   action rather than 45 decisions.
2. **`xavia`, negated in 16 ad groups, all in live campaigns, ACoS 1%** (§6, Detector B). This is the
   one row I would remove today if you said so. It is also the strongest single argument for the
   whole path.
3. **The 22 campaign-scope negatives that exist only in our database** (§2.3). Push them to Amazon
   once `marketplace` is passed, or delete them as never-intended? They have been counted as real for
   months.
4. **`add_negative_phrase`** (§2.5) — implement the handler, or remove it from the tab, the category
   map and the graduation list? Right now it is a live action type that fails on execution.
5. **The suggestion queue** — 23 negation/harvest proposals, 0 ever decided, oldest 2026-08-03. Work
   it on this page, work it on Harvest's, or expire it? I have assumed it becomes a shared surface
   filtered per page (R5's neighbour), but the ownership is a decision.
6. **Spend ceilings per scope** — you have specified market · product line · portfolio · campaign,
   refuse-and-tell at the cap. A negation has **no monetary value** (`createNegative` passes
   `payloadValueCents: 0`), so a euro ceiling cannot bind it. **What is the equivalent unit for a
   structural change — negatives per day per scope?** I would propose that, but it is your call and
   it applies to every structural action, not just this page.

---

## Appendix — scripts

| script | measures |
|---|---|
| `_neg-page-audit.mts` | all 10 protections with every field · the base by kind/type/level/status/market · `externalTargetId` nulls · orphans · sync status · whether any negative was ever archived through Nexus · attribution coverage and evidence · rollbacks · spread per term · the whitelist audit under all three match semantics |
| `_neg-page-conflict.mts` | conflict detection at the **ad-group** grain (the overlap join) · suppressed earners over 120d · the whitelist contradictions classified by line ownership · n-grams vs the negatives we hold · the 62 archived rows' provenance |
| `_neg-page-shape.mts` | `updatedAt` distribution *(the check that killed a finding)* · creation cohorts · the four scope grains · the proposal queue · the seven rules' scope · `sync_negatives_across_campaigns` blast radius per market |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>.mts` from `apps/api`.
The tab study's `_neg-study.mts` and `_neg-study2.mts` are unchanged.

### Corrections collected

- two negatives grids **do** exist (tab study said none)
- **9** rollbacks all-time, none on a negative (tab study said 0)
- the six match-type spellings are **EXACT 1,393 / PHRASE 579** with a 62-row underscore fringe, not
  the reverse
- all 10 protections are **CONTAINS** — I expected `EXACT`/`PREFIX` from the migration and was wrong
- `updatedAt` on a negative is the **last ingest tick**, not a decision timestamp — which is why
  "62 archived today" is not a finding

### Sources

- [Karooya — How to remove a negative keyword from Amazon Ads](https://www.karooya.com/blog/how-to-remove-negative-keyword-from-amazon-ads/) ·
  [Karooya — Negative keywords for Amazon Ads](https://www.karooya.com/negative-keywords-for-amazon-ads) ·
  [Karooya vs Perpetua vs Pacvue](https://www.karooya.com/blog/karooya-vs-perpetua-vs-pacvue-amazon-ppc-optimization/)
- [Adalysis — Keyword conflicts](https://docs.adalysis.com/tools/audit/prebuilt-alert-list/keywords/keyword-conflicts) ·
  [Adalysis — Negative keywords from search terms](https://docs.adalysis.com/tools/audit/prebuilt-alert-list/search-terms/negative-keywords-from-search-terms)
- [Ad Badger — Amazon PPC negative keywords 2026](https://www.adbadger.com/blog/amazon-ppc-education/negative-keywords-amazon-ppc/)
- [Adbrew — N-gram analysis for Amazon Ads](https://adbrew.io/blog/n-gram-analysis-for-amazon-ads) ·
  [Adbrew — PPC software](https://adbrew.io/amazon-ppc-software-sponsored-ads-management-tool/)
- [Pacvue — Key to success in conquering negative keywords](https://pacvue.com/blog/key-to-success-in-conquering-negative-keywords/) ·
  [Pacvue — Real-time automation & optimization](https://pacvue.com/platform/real-time-automation-and-optimization/)
- [Teikametrics — AI-powered keyword & targeting](https://intercom.help/flywheel-20/en/articles/9260498-understanding-teikametrics-ai-powered-keyword-targeting)
- [Scale Insights pricing & plans 2026](https://revenuegeeks.com/scale-insights-pricing/)
- [Helium 10 Adtomic — what it is](https://revenuegeeks.com/helium10-adtomic/)
- [Keywordme — best negative keyword tools](https://www.keywordme.io/blog/best-negative-keyword-tools) ·
  [SalesDuo — Amazon negative keywords guide 2026](https://salesduo.com/blog/amazon-negative-keywords/) ·
  [Sequence Commerce — Amazon negative keywords 2026](https://sequencecommerce.com/amazon-negative-keywords/)

### Internal references

- [NEG tab study](2026-08-11-neg-negative-targeting-study.md) — the base, the 132, the funnel/blocked trap
- [HV — Keyword Harvest](2026-08-11-hv-keyword-harvest-study.md) — the shared `harvest_and_negate`,
  the €0.50 bid, the 225-row queue
- [AUTO — Automations](2026-08-11-auto-automations-study.md) — the graduation ceiling, the 0.2% write
  attribution, OBSERVE unused
- [RA plan](2026-08-10-ads-rules-automation-ra.md) · [session locks §0](2026-08-10-ra-session-locks.md)
- [Ads market research](2026-08-04-ads-market-research.md) · [competitor deep dives](2026-08-04-competitor-deep-dives.md)
