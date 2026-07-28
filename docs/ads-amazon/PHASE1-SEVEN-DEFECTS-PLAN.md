# Phase 1 — the seven defects: implementation plan

> Written 2026-07-28. Every claim below was re-verified against source and, where possible, against the live
> database. **No code has been changed.** Awaiting approval.
>
> Where this plan differs from `obsidian-vault/33 - Cross-Channel Ads Review.md`, the source won and the
> difference is called out in §8.

---

## 0. Order of execution

D1 first and alone. It is live, silent, and total — not partial. Then D2 (silent data loss), then the
workbook trio D4/D5/D6 which share one file, then D3, then D7.

| | Defect | Severity | Files | Ship |
|---|---|---|---|---|
| 1 | **D1** eBay `SYSTEM_PAUSED` | live, silent, 100% of surface | 5 | alone |
| 2 | **D2** preview/apply mismatch | live, silent data loss | 2 + 1 test | alone |
| 3 | **D4/D5/D6** workbook correctness | corrupts round trip | 3 | together |
| 4 | **D3** `EBAY_GB` | wrong-market writes | 5 | with D1's constant work |
| 5 | **D7** `guardrails` | misleading, not harmful | 2 | last |

---

## D1 — eBay `SYSTEM_PAUSED` blindness

### Root cause

Two independent halves that only bite together:

1. `EbayCampaign.status` stores eBay's **raw** string — `status: c.campaignStatus ?? 'DRAFT'`
   (`ebay-ads-entity-sync.service.ts:72`). No normalisation on write.
2. `EBAY_CAMPAIGN_STATUS_MAP` (`ads-core/campaign-status.ts:28-34`) knows only
   `RUNNING|PAUSED|ENDED|SUSPENDED|DRAFT`. `normalizeCampaignStatus` falls back to `'DRAFT'` for anything else
   (`:36-43`), so `SYSTEM_PAUSED` normalises to `DRAFT` — wrong in a *second* way, wherever normalisation is used.

Every consumer then filters on raw literals rather than a predicate.

### Verified live impact — this is total, not partial

```
EbayCampaign by status:  ENDED=2   SYSTEM_PAUSED=11
matched by { in: ['RUNNING','PAUSED'] }:  0
ads hidden behind SYSTEM_PAUSED campaigns:  24
```

**Every non-ended eBay campaign in the account is `SYSTEM_PAUSED`.** Coverage KPI reads 0%, the products
rollup shows nothing promoted, the builder's conflict preflight sees none of the 24 ads, and every automation
rule evaluates an empty candidate set — with no error raised anywhere.

### Every affected call site — 14, in TWO variants

The review lists 14 lines and all 14 exist. They are **not one pattern**, which changes the fix.

**Variant A — `status: { in: ['RUNNING','PAUSED'] }` (7).** Intent: "campaigns we manage."

| Site | Purpose |
|---|---|
| `ebay-ads.routes.ts:128` | promoted-listing coverage KPI |
| `ebay-ads.routes.ts:441` | products rollup |
| `ebay-ads.routes.ts:1052` | move-collision lookup |
| `ebay-ads-dashboard.service.ts:45` | dashboard promoted count |
| `ebay-ads-builder.service.ts:62` | **conflict preflight** |
| `ebay-ads-automation.service.ts:737` | automation candidates |
| `ebay-ads-automation.service.ts:827` | automation candidates |

**Variant B — bare `status: 'RUNNING'` (7).** Intent is *not* uniform:

| Site | Purpose | Should `SYSTEM_PAUSED` be included? |
|---|---|---|
| `ebay-ads-automation.service.ts:277` | CPS ad candidates | **yes** — see below |
| `ebay-ads-automation.service.ts:364` | CPC keyword candidates | **yes** |
| `ebay-ads-automation.service.ts:694` | DYNAMIC-rate campaigns | **yes** |
| `ebay-ads-automation.service.ts:875` | rate-discovery plans | **yes** |
| `ebay-ads-dashboard.service.ts:49` | campaigns shown on the dashboard | **yes** — operator must see them |
| `ebay-ads-builder.service.ts:121` | `activeCampaigns` sprawl count | **yes** — they exist and count |
| `adapters/ebay.adapter.vitest.test.ts:23` | test fixture | no — leave |

### The fix

**Not** a single blanket predicate. Export **two** from `ads-core/campaign-status.ts`:

```ts
/** Campaigns we manage: exist, not ended/archived. Includes retailer-paused. */
export const EBAY_MANAGED_STATUSES = ['RUNNING', 'PAUSED', 'SYSTEM_PAUSED'] as const
/** Campaigns actually serving right now. SYSTEM_PAUSED is NOT serving. */
export const EBAY_SERVING_STATUSES = ['RUNNING'] as const
```

Then:
1. Add `SYSTEM_PAUSED: 'PAUSED'` to `EBAY_CAMPAIGN_STATUS_MAP` — it is a paused state, not a draft.
2. Replace all 14 sites with the appropriate constant. Every site above wants **MANAGED**; none of the current
   `'RUNNING'` sites genuinely means "serving" on inspection — they mean "a campaign that exists and isn't dead".
3. Add the `SYSTEM_PAUSED` pill to `_lib/status.ts:7-16` with distinct styling and a tooltip saying eBay set it,
   not us.

### Expectation to set before we ship it

**Fixing D1 will not make eBay automation start working. It will make it fail visibly.** The account is
`INELIGIBLE / NOT_IN_GOOD_STANDING` and every ads write returns `409 / 35077`. Today rules find zero candidates
and log success. After the fix they will find candidates and fail at the write gate with eBay's real reason —
which is the correct behaviour and the point of the fix, but it is a change from "silent green" to "loud red"
and should not be mistaken for a regression.

### Regression test that would have caught it

Pure, in `ads-core/campaign-status.vitest.test.ts`:
- `normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SYSTEM_PAUSED')` must not be `'DRAFT'`.
- **The invariant that actually prevents recurrence:** a source-scanning test asserting no file under
  `services/marketing/ebay-*` or `routes/ebay-ads.routes.ts` contains a raw campaign-status string literal
  in a Prisma `where`. Same shape as the AX2.0 chokepoint ratchet, which I verified bites before trusting it.

### Blast radius

5 files. **Read-path only** — no write, no schema, no migration. Risk is *widening* result sets: coverage,
rollup and dashboard counts will jump from 0, and automation will begin evaluating 24 ads it previously
ignored. Because the global automation dial ships `OFF`/`SUGGEST` and the channel is `INELIGIBLE`, nothing can
auto-write as a consequence. Verify by re-running the KPI before/after and expecting 0 → non-zero.

---

## D2 — preview promises what apply drops

### Root cause

Two hand-maintained lists that must agree and have no mechanism forcing them to.

`preview.ts:81-82`:
```ts
CAMPAIGN_FIELDS = ['State','Daily budget','Campaign name','Bidding strategy','Portfolio ID']
ADGROUP_FIELDS  = ['State','Ad group name','Ad Group Default Bid']
```
`apply.ts` Campaign branch sets only `status`, `dailyBudget`, `biddingStrategy`; Ad-group branch only `status`,
`defaultBidCents`. `CampaignPatch` already supports `name`/`portfolioId` (`ads-mutation.service.ts:202-210`) —
they are simply never assigned.

### Sharper than the review states

A **name-only** edit is *visible*: `if (!Object.keys(patch).length) rec('SKIPPED', 'No writable field changed')`
(`apply.ts`). The silent case is a **mixed** row — name **and** budget. The budget populates `patch`, the row
reports `APPLIED` + `_status: ok`, `_baseline` refreshes from the re-read entity, and the rename is gone with
the file now asserting success. Worth stating precisely, because "name edits are dropped" would send someone
looking in the wrong place.

### The fix — make the mismatch unrepresentable

Do **not** just add the missing mappings; that recreates the same two-list problem. Invert the dependency:

1. Define the apply mapping as data — `{ entity → { column → (patch, value) => void } }` — in `apply.ts`.
2. Derive `preview.ts`'s `*_FIELDS` from `Object.keys()` of that map.

A field that cannot be applied then **cannot appear in a preview diff**, by construction.

3. Extend the map to cover `Campaign name`, `Portfolio ID`, `Ad group name` (all already supported by the patch
   types), then `Start date`, `End date`, `Percentage`.
4. `Keyword text` / `Match type` are **immutable on Amazon** — archive+create, which resets the target id and
   destroys its performance history. Do **not** silently implement that as an update. Mark them
   `editable: false` in the schema for now and surface a typed `UNSUPPORTED` reason; the archive+create flow
   belongs with Phase 4a's Create work, where the history consequence can be shown to the operator.

### Regression test

Invariant #1 from Phase 6, pulled forward: **no field may appear in a preview `*_FIELDS` list without a
corresponding apply mapping.** Trivial once the map is the source of truth, and it is what makes D2 unrepeatable.
Plus an end-to-end case: a row editing name **and** budget must either apply both or report neither as applied.

### Blast radius

2 files + 1 test. Behaviour change is strictly *more* fields applied — an operator who previously lost a rename
now gets it. The `_baseline` refresh already re-reads the entity post-apply (`annotate.ts:85-131`), so the
correction loop closes correctly once the write actually happens.

---

## D3 — `EBAY_GB` marketplace mapping

### Root cause and the corrected count

The review says "six ad-hoc SHORT maps, three wrong". It is **seven maps, four defective**:

| # | Site | Has `EBAY_GB`? | Fallback | Verdict |
|---|---|---|---|---|
| 1 | `ebay-ads.routes.ts:25` `SHORT_BY_MKT` | ✅ `'UK'` | — | correct |
| 2 | `ebay-ads.routes.ts:632` inline | ❌ | **none** | **critical** |
| 3 | `ebay-ads.routes.ts:650` inline | ❌ | `?? 'IT'` | wrong market |
| 4 | `ebay-ads-automation.service.ts:282` | ❌ | `?? 'IT'` | wrong market |
| 5 | `ebay-ads-automation.service.ts:562` | ❌ | `?? 'IT'` | wrong market |
| 6 | `ebay-ads-builder.service.ts:24` | ✅ | — | correct |
| 7 | `ebay-ads-write.service.ts:131` | ✅ | — | correct |

Site 2 is the dangerous one and the review's analysis holds exactly: `undefined` flows into
`getLiveEbayItemIds(pid, undefined)`, which drops the marketplace predicate
(`ebay-listing-index.service.ts:276,285`) and **can resolve Italian item IDs into a GB campaign**.

`EBAY_MARKETS` (`_lib/presets.ts:6-12`) has no GB entry — confirmed — so the console cannot select a
marketplace the API half-serves.

### The fix

One exported constant in `ads-core/` (it is genuinely bi-channel data), all seven sites pointing at it, and a
`marketplaceShort()` that **throws on an unknown code** rather than returning `undefined` or defaulting to `'IT'`.
Silently defaulting a marketplace is how site 2 became capable of cross-market writes.

Then decide GB explicitly: either add it to `EBAY_MARKETS` and support it, or reject `EBAY_GB` at the API
boundary with a typed 400. Half-support is the current state and is the actual defect.

### Regression test

`marketplaceShort('EBAY_GB') === 'UK'`; `marketplaceShort('EBAY_XX')` throws. Plus a ratchet: no inline
`{ EBAY_IT: 'IT', … }` object literal anywhere outside the constant's own module.

### Blast radius

5 files. Sites 3–5 change behaviour for GB only (today they silently write to IT). Sites 1, 6, 7 are
consolidation with no behaviour change. **There are no GB campaigns today**, so live impact is nil — this is
prevention, and the right time to do it is before GB exists.

---

## D4 — annotated workbook highlights the wrong cell

### Root cause

An asymmetry between two coordinate systems.

- `import-validate.ts:228-232` computes the address from the **uploaded** sheet:
  `headerIndex.get(own)` → `columnLetter(i)`.
- `annotate.ts:160-167` decodes the letter back to an index and looks it up in the **canonical** `COLUMNS[n-1]`.

The importer explicitly supports reordered and extra columns (`import-validate.ts:192-194`), so on precisely
the files it advertises support for, the red highlight lands on an unrelated column.

### The fix

Carry the uploaded header map through to annotate rather than re-deriving it. Cleanest: have validation emit
the **header name** alongside (or instead of) the letter — `{ cell: 'Sheet!F412', column: 'Daily budget' }` —
so annotate never has to decode a coordinate at all. That removes the class, not just the instance.

### Regression test

Build a fixture workbook with **deliberately reordered columns**, run validate → annotate, assert the
highlighted cell resolves to the same header the error names. This needs the Phase 6 fixture, which is another
reason to pull fixture creation forward.

### Blast radius

2 files, annotation only. No effect on validate or apply outcomes — only on where the red mark lands.

---

## D5 — `Entity` dropdown exceeds Excel's 255-char limit

### Root cause, measured

`spreadsheet-adapter.ts:222` builds `` `"${c.allowedValues.join(',')}"` ``. The 16 `Entity` values
(`ads-bulksheet.ts:87-93`) sum to 261 characters of content + 15 commas + 2 quotes = **278**. Confirmed by
counting the actual array, matching the review exactly.

Excel repairs or silently drops list validations over 255 characters, and a repair prompt on open taints the
whole workbook in the operator's eyes.

**Second defect in the same three lines:** the validation object is constructed **per row**
(`for (let r = 2; r <= lastRow; r++)`), so it is O(rows × enum-columns) — the ~93k-object explosion the brief
notes. Both are fixed by the same change.

### The fix

Build the `Lists` sheet the spec always called for: one column per enum, a defined name per range
(`_Entity`, `_Operation`, …), and dropdowns sourced as `formulae: ['_Entity']`. A named range has no length
limit, and one validation can be applied to a whole column range instead of per cell.

### Regression test

Assert every generated `dataValidation.formulae[0]` either references a defined name or is ≤255 characters.
That single assertion covers every current and future enum.

### Blast radius

1 file + the workbook layout. Adds a sheet — hide it, and confirm the importer skips unknown sheets (it
already skips non-`Entity` sheets, `import-validate.ts:33`, which is why Portfolios is currently ignored).
**Verify that skip explicitly** so `Lists` cannot become a parse error.

---

## D6 — formula escaping corrupts the round trip

### Root cause

`escapeFormulaInjection` (`spreadsheet-adapter.ts:124-126`) returns `` `'${s}` `` — it prepends a literal
apostrophe **to the value**. Excel's convention is a *style* (`quotePrefix`), not a character: the apostrophe
is display-only and is not part of the cell value. Writing it into the string makes it real data.

Compounding it: `computeBaseline` is called with the **raw** row values (`build-workbook.ts:184`,
`(h) => r[h]`), so the fingerprint is taken pre-escape while the cell receives the escaped string. A campaign
named `-50% Sale` is hashed as `-50% Sale` and written as `'-50% Sale`; on re-upload the read value no longer
matches its own baseline, which the conflict detector correctly reports as an external change.

### The fix

Set ExcelJS `quotePrefix: true` in the cell style and write the **unescaped** value, so cell value ==
baseline input == what Amazon holds. Keep `escapeFormulaInjection` for the CSV path (Phase 4b), where prefixing
the value is the correct defence because CSV has no styling.

If `quotePrefix` proves unreliable across Excel/Numbers, the fallback is to strip a single leading `'` on read
before comparison — but that is second choice: it leaves the exported file wrong and only hides it.

### Regression test

Round-trip a campaign named `-50% Sale` through export → read → baseline compare, asserting `UNCHANGED`.
Add `=SUM(A1)`, `+1`, `@here` and a leading tab as siblings.

### Blast radius

2 files. Any workbook exported **before** the fix carries escaped values in its baseline; after the fix those
files will compare as changed on the first re-upload. That is a one-time migration artefact and must be stated
in the release note rather than discovered.

---

## D7 — `EbayAdsRule.guardrails` is write-only

### Root cause, verified

`guardrails` appears 17 times in `ebay-ads-automation.service.ts` — all of them storage, snapshot
(`ruleConfigOf:1136`), validation-of-shape (`validateRuleBody:1167`), version round-trip, or the
`STARTER_RULES` literals. A repo-wide search for a property read (`guardrails.<x>` / `guardrails?.<x>`) returns
**only unrelated `team-guardrails` hits**. It is never consulted during evaluation.

The rule *does* have real guardrails — break-even clamp, cooldowns, spend ceiling, per-campaign policy — but
they are hard-coded, not driven by this field. So the field is not merely unused; it **implies operator control
that does not exist**.

### The fix — decide, do not split the difference

Two honest options, and I recommend the first:

**A. Wire it (recommended).** Define a small typed schema — `maxBidChangePct`, `minBidCents`, `maxBidCents`,
`maxActionsPerRun`, `minClicks`, `minSpendCents` — validate it in `validateRuleBody`, and apply it in
`candidatesForRule` (as filters) and in the action closures (as clamps). This is also a prerequisite for
Phase 5 item 4 (blast-radius caps), so the work is not throwaway.

**B. Rename to `notes`** with a migration and a UI label change, and remove the implication.

What must **not** happen is leaving it as-is with a comment. That is the status quo.

### Regression test

A rule with `maxActionsPerRun: 1` over a 5-candidate set must produce exactly one action. A rule with
`maxBidChangePct: 10` must clamp a proposed +50% to +10%.

### Blast radius

2 files + tests, and — if we take option A — a behaviour change for any existing rule that already has
non-empty `guardrails`. **Audit those rows first**: a rule saved with restrictive guardrails that were being
ignored will suddenly start restricting. That is correct, but it is a live behaviour change and needs to be
enumerated before shipping, not after.

---

## 8. Where the documents and the source disagree

The review is unusually accurate — every `path:line` I checked resolved. Five corrections:

1. **D1 is two patterns, not one.** The 14 cited sites split into `{ in: ['RUNNING','PAUSED'] }` (7) and bare
   `status: 'RUNNING'` (7). The brief's instruction to "replace every literal filter with a shared `ACTIVE_ISH`
   predicate" would be a blanket change across sites whose intent differs. On inspection all 14 want *managed*,
   but that conclusion needs stating per-site rather than assumed — and a second `SERVING` predicate should
   exist so the distinction is available when it is next needed.
2. **D3 is seven maps with four defects, not six with three.** `ebay-ads-write.service.ts:131` is a seventh map
   and is correct; `ebay-ads-builder.service.ts:24` is also correct. The four defective sites are 632, 650,
   282, 562.
3. **D2's silent case is narrower and worse than described.** A name-only edit reports `SKIPPED` and is
   visible. Only a *mixed* row silently loses the rename while reporting `APPLIED`.
4. **D1's practical effect is total, not partial.** Live data: 11 of 11 non-ended campaigns are
   `SYSTEM_PAUSED`; the filter matches 0; 24 ads are hidden. The review says "coverage reads 0%" — that is
   literally true rather than illustrative.
5. **D5 has a second defect in the same lines** — per-row validation objects, O(rows × enum-columns) — which
   the same fix resolves. The review notes the char limit only.

Also: `EBAY_CAMPAIGN_STATUS_MAP` maps unknown statuses to `'DRAFT'`, so `SYSTEM_PAUSED` is not merely absent —
wherever normalisation *is* used it is actively mislabelled as a draft. Neither document mentions this.

---

## 9. Reordering Phases 2–6

Four changes, in order of conviction.

**1. Pull the two Phase 6 invariant tests into Phase 1.** They are ~a day. Invariant #1 (no preview field
without an apply mapping) *is* the D2 fix — writing it first proves the fix rather than describing it.
Invariant #2 (declared vs applied entities) makes the Phase 4a contradiction unshippable. Writing them after
the bugs they would have caught inverts their value. **This is my strongest recommendation.**

**2. Pull the fixture workbook forward too.** D4 and D6 cannot be regression-tested without one. Three of the
seven defects are workbook defects and none of them currently has a test surface. The Numbers-round-tripped
variant can come later; the plain fixture is needed now.

**3. Move Phase 5 item 9 (scheduled imports) up, next to Phase 2.** The brief itself says the models and the
job already exist and this is "wiring, not new infrastructure", and it is the concrete answer to "runs
unattended". It is the cheapest item in Phase 5 and the most aligned with the standing requirement.

**4. Split Phase 2b rather than running it whole.** AX-ZD.2 (subscribe the change datasets) is additive,
low-risk and independently valuable — it is the only push signal for Seller Central edits. AX-ZD.1 (the typed
`AdMutation` queue) is a rewrite of the live write path with dead-lettering, grace periods and gating to
preserve. Do ZD.2 first, get the change signal flowing, then do ZD.1 against a system that can already observe
its own drift. Doing them together means refactoring the write path while blind.

**One thing I would not reorder:** Phase 2's data-vintage enforcement should stay exactly where it is. It is
cheap, the module is already written and tested, and "unenforced safety machinery" is the worst category of
technical debt — it reads as protection in code review and provides none.

**One caution on Phase 3.** The capability descriptor is the right idea, but it is a framework, and frameworks
built before their second consumer tend to encode the first consumer's assumptions. I would build it from the
**four concrete divergences we can already name** — eBay CPS `PERCENT_OF_PRICE` with no budget object,
rate-at-sale, Amazon's immutable match types, and the two channels' different archive semantics — rather than
from the general schema in the brief. Same destination, less speculation.

---

## 10. What I have not done

- Not read `30 - Amazon Ads Platform Audit.md`, `AX-IE-0-1-PLAN.md`, `TECH_DEBT.md` or
  `AMAZON-BULKSHEET-SCHEMA.md` in full — I verified the seven defects directly against source instead, which
  the brief says is authoritative. If any of those contain a decision that contradicts this plan, it wins and I
  should read it before implementing.
- Not verified D4 against a real reordered workbook — no fixture exists. The reasoning is from source and is
  sound, but it is analysis, not observation.
- Not enumerated existing `EbayAdsRule.guardrails` values (D7 option A blast radius). That query must run
  before that fix ships.
