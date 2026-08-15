# SUB — one substrate spec for eleven pages

**Date:** 2026-08-11
**Surface:** `/marketing/ads/rules-automation/*`
**Status (updated 2026-08-12, RA.SPINE):** **PARTLY BUILT.** S1 (`useAdsScope`), S2 (the poll
ratified) and S5 (`showMarket` + the provider's `'all'`) are shipped; S3 shipped its redirect half.
**S4 — the tab bar at eleven items — is NOT built**, and six of §0.0's corrections apply to the text
below. **Read §0.0 before acting on any section of this document.**
*(Original status, 2026-08-11: 🔴 PROPOSED — awaiting approval or rejection. Nothing built.)*
**Supersedes:** `2026-08-10-ads-rules-automation-ra.md` **Part 4** and **§4.0a-FINAL** (the 🔒 "six
pages, cull first" lock). The operator's 2026-08-11 direction is **eleven pages**; §4.0a-FINAL's
drop list is dead. Every other part of that document — the doctrine (Part 0.5), the laws (Part 5),
§3.0's control law, the retirement map (Part 6) — stands unchanged.

Read with: `2026-08-10-ra-session-locks.md` §0 (scope boundary), §3 (shared files), §5 (traps).

---

## 0 · Corrections before anything else

### 0.0 🔴 Read this first — corrections from the build (RA.SPINE, 2026-08-12)

> The two subsections after this one (§0.1, §0.2) were written on 2026-08-11 and are unchanged.
>
> This document was written on 2026-08-11 with nothing built. By the time the substrate was
> actually built, **eleven page sessions had shipped ten routed pages**, and they had settled
> several of these questions by measurement. Where the page sessions and this document disagree,
> **the page sessions are right in every case below.** The corrections are stated here rather than
> edited silently into the body, so the reasoning stays auditable.
>
> **(a) §1.3's `GET /advertising/pulse` is WITHDRAWN — falsified, not merely superseded.**
> The design was one account-wide cursor over the ledger, polled by one provider. Measured
> 2026-08-12 at 00:30 Rome: `max(AdTarget.updatedAt)` and the newest `AdvertisingActionLog` row
> were **134 minutes apart**, because `ads-keyword-bid-resync` overwrites `bidCents` with Amazon's
> value and leaves no log row and no `CampaignBidHistory` row. A ledger cursor would have sat
> reporting "nothing changed" through every bid edit made in Seller Central.
>
> §1.3 was right that the answer is a poll and not SSE — that half stands, and the SSE arithmetic
> behind it is unchanged. It was wrong that **one** cursor can serve eleven pages. What ships is
> `_shared/useCursorPoll.ts` (45 s, pauses on `visibilitychange`, silent on failure, **offers a
> button rather than yanking rows out from under a reader**), with **each page bringing a cursor
> whose fields move when ITS subject moves, measured rather than assumed.** Bid's measurement
> rejected the audit log as load-bearing; Budget's rejected the row timestamp
> (`Campaign.updatedAt` fires ~7×/day against ~3 real budget changes). *Neither could have used the
> other's shape* — which is the whole argument against one shared cursor, in one sentence.
>
> **(b) §7's phase order is overtaken by events, and the receipt is countable.**
> "Phase S — substrate. Nothing else starts." did not happen: ten routes and five section builds
> landed *before* the substrate did. What that cost, measured on the tree the substrate found:
>
> | duplicated thing | copies | where |
> |---|---|---|
> | `DEFAULT_MARKET` declarations | **9** across 8 files, **+2** more markets held in `useState` with no URL backing (`AutomationsClient:61`, `RulesAutomationClient:100`) | eleven declarations, ten files |
> | the client-side reach intersection | **4** | `ScopeForm` · `BidScopeBar` · `BudgetScopeBar` · `PlacementScopeBar`, against one server `resolveScopeReach` |
> | the `?tab=` redirect rule | **10** hand-written literals | `next.config.js`; **four sessions forgot theirs entirely**, so `?tab=automations`, `?tab=dayparting`, `?tab=keyword-tracker` and `?tab=share-of-voice` sat on production returning 200 and rendering the wrong page until SOV.1 fixed them |
>
> The cost was real but not catastrophic, and it bought something the phase order would not have:
> **the page sessions produced better answers than this document did**, twice (see (c) and (d)).
> The honest revision is not "S must come first" but "**a shared module is worth extracting on its
> second copy, not its eleventh**".
>
> The remaining shared components — the freshness chip, the refusal renderer, the actor resolver,
> the ledger route and the four empty states (§5.6, §6.3) — are **untouched and unstarted**.
>
> **(c) §6's "three broken tabs" is superseded by HV.1's derived map.** `RULE_TAB_ACTION_TYPES` is
> now derived from `ruleTypes.ts`'s `{ slug, tab }` rather than hand-written, which fixes a defect
> this document did not know about: `RuleBuilder.tsx:499` writes `actions: [{ type: slug }]` using
> the builder's URL segment (`keyword-harvesting`), not the action type (`promote_to_exact`) — so
> **the first rule an operator created through the builder would have been invisible on the tab it
> was created from.** Latent rather than live, because zero rules carry a builder slug today, which
> is exactly why it would have survived.
>
> **(d) §2.1's tab-key rename is superseded, and AR.S0's mechanism is better.** This document says
> *"The tab key `rules` is renamed to `apply-rules`. Only two places read it."* That undercounts:
> `?tab=rules`, `RULE_TAB_ACTION_TYPES`, the index client's fallback and every `active="rules"` all
> read it, and renaming one key in a file eleven pages share is the programme's highest-collision
> edit. AR.S0 added an optional `path?` to `RulesTab` instead, so the key stays `rules` and only its
> route is `apply-rules`. Every other tab's href is byte-identical. **Take the `path` field; do not
> add a second mechanism.**
>
> **(e) §3.1.7's reach claim is wrong.** *(The brief's numbering; this document's §2.3/§5.3.)* The
> claim that `GET /advertising/scope-options` "already returns enough … for the client to compute
> any combination's exact reach locally" holds for the **resolved** count and fails for the
> **writable** one: its campaign rows are `{id, name, marketplace, portfolioId, status}` and carry
> **no write-gate field at all**. The gate lives in `GET /advertising/control-room/guardrail-grid`,
> which is what `apply-rules/ApplyRulesClient` actually reads. Two numbers need two sources, so
> `ScopeReach.writable` is `number | null` and `null` means **"not known on this page"**. It must
> never render as `0`: the entire reason for two numbers is that "reaches nothing" and "not
> permitted to write" must not read the same, and a fabricated zero recreates that collision.
>
> **(f) §1.2.5's date-vocabulary count is wrong.** The mismatch between `_shell/DateRangePicker`'s
> `DATE_PRESETS` and the server's `RangePreset` is larger than "sharing only `today` and
> `yesterday`" and larger than the brief's "three with no equivalent". Measured across all fifteen
> picker keys: **seven map, eight do not.**
>
> | maps | `today` · `yesterday` · `thisMonth`→`mtd` · `lastMonth`→`last_month` · `thisQuarter`→`qtd` · `latest7`→`last7` · `latest30`→`last30` |
> |---|---|
> | **does not** | `thisWeek` (Sunday-start vs the server's Monday-ISO `wtd`) · `last12m` (trailing year vs `last_year`'s calendar year) · `lastWeek` · `last3m` · `last18m` · `last24m` · `lastQuarter` · `latest60` — **no server preset produces these windows** |
>
> Forwarding an unmapped key hits `resolveRange`'s `default:` branch and returns **seven days under
> whatever label the operator picked**. The adapter (`_shared/adsScope.ts`, `PICKER_TO_SERVER` +
> `datePatchFromPicker`) sends a mapped key as the server key — so the *server* anchors the window
> to Europe/Rome — and everything else as explicit `custom` dates, which is the only form that
> cannot mean two things. §1.2.5's "one adapter, in one file, at the boundary" is otherwise exactly
> right and is implemented as written.
>
> **What still stands, unchanged:** §4 (arbitration), §5 (display contracts), §6 (shared
> components), §1.1's cadence and SSE measurements, §1.2's URL-wins decision and its `'all'`
> sentinel, and §2.2's landing-redirect decision (**not yet built** — see the hand-off in
> `2026-08-10-ra-session-locks.md` §4).

### 0.1 🔴 Six of the eleven page-studies do not exist

The brief says eleven parallel sessions each produced a page-study containing "Requirements on the
shared layer". **Five exist on disk:**

| # | page | page-study | tab-study |
|---|---|---|---|
| 1 | Keyword Tracker | ✅ `…-kt-keyword-tracker-page.md` (§8, R1–R8) | ✅ |
| 2 | Share of Voice | ✅ `…-sov-share-of-voice-page.md` (§7, 1–11) | ✅ |
| 3 | Placement | ✅ `…-plc-placement-page.md` (§10, 1–14) | ✅ |
| 4 | Budget Schedules | ✅ `…-bs-budget-schedules-page.md` (§8, 1–9) | ✅ |
| 5 | Rank & Dayparting | ✅ `…-rd-rank-dayparting-page.md` (§8, 1–7) | ✅ |
| 6 | Budget | ❌ **missing** | ✅ `…-bud-budget-study.md` |
| 7 | Negative Targeting | ❌ **missing** | ✅ `…-neg-negative-targeting-study.md` |
| 8 | Keyword Harvest | ❌ **missing** | ✅ `…-hv-keyword-harvest-study.md` |
| 9 | Bid | ❌ **missing** | ✅ `…-bid-study.md` |
| 10 | Automations | ❌ **missing** | ✅ `…-auto-automations-study.md` |
| 11 | Apply Rules | ❌ **missing** | ✅ `…-ar-apply-rules-study.md` |

Consequence for §(e): **session 10 produced no "contracts the other ten pages must honour".** There
is nothing to ratify. I have written the display contracts from scratch, using study 10's findings.

Consequence for pages 6–11: their tab-studies carry the same measurements and a "What I need from
you", but no shared-layer section. Their requirements below are **inferred from findings** and
marked ⓘ. If those six sessions later produce page-studies, this document is the thing they must
argue against — not each other.

I did not wait for them. Every requirement they could plausibly state is already stated by one of
the five, or falls out of the code.

### 0.2 The brief's own text is truncated

Several sentences in the brief cut off mid-word (§2, §3, §4d, §4e, §5, §6). Where a sentence was
unreadable I resolved it from the surrounding documents and say so at the point of use. Nothing
below depends on a guess about an unreadable clause.

---

## 1 · 🔴 The sync decision

Two problems, deliberately two mechanisms. Deciding them together is what produced eleven deferrals.

### 1.1 What was measured, 2026-08-11 (`_sub-substrate.mts`, `_sub-cadence.mts`)

**How often does this account actually change?**

| | |
|---|---|
| `AdvertisingActionLog` rows, total | 45,972 (back to 2026-05-31) |
| in 60 days | 44,435 |
| in 24 hours | **1,672** — 69.7/hour |
| in the last hour | 55 |
| minutes in 48h carrying ≥1 write | **206 of 2,880 — 7%** |
| gap between consecutive writes, p50 / p99 / max | **1.2s / 890s / 240 min** |

Writes per five-minute slot of the hour, 48h sample:

```
:00-04  1397   :05-09   437   :10-14     0   :15-19   439   :20-24     0   :25-29     0
:30-34   744   :35-39   232   :40-44     0   :45-49   187   :50-54     2   :55-59     1
```

**The stream is bursty, not continuous.** It is the 15-minute cron boundary. 93% of minutes are
silent. The underlying data changes **four times an hour**.

**What can the SSE bus that already ships actually see?**

| | |
|---|---|
| `AutomationRuleExecution` rows, 7 days | 146,714 → **14.6 events/minute on the bus** |
| of which `DRY_RUN` | 120,981 (82%) |
| 60-day writes attributed to a rule execution — *the only thing the bus publishes* | **95 — 0.21%** |
| attributed to a `userId` (bus blind) | 34,743 — 78.2% |
| engine/system, no actor (bus blind) | 9,597 — 21.6% |

Top actors, 60 days:

| actor | writes |
|---|---|
| `automation:rank-defend-<id>` | **29,764** |
| `(null)` | 9,589 |
| `user:anonymous` | 2,388 |
| `automation:budget-manager-cron` | 1,165 |
| `automation:<opaque-id>` | 1,219 |
| `automation:auto-harvest` | 151 |

**The bus is inverted.** `publishAdsExecution()` has exactly two call sites, both in
`automation-rule.service.ts`. `ad-rank-defend`, `budget-manager-cron` and `auto-harvest` — 67%,
2.6% and 0.3% of all writes — publish nothing. The bus emits ~14.6 events a minute, four fifths of
them dry runs corresponding to no change at all, and is blind to 99.8% of what moves.

Two shipped consumers already pay for this: `SuggestionsClient.tsx:390` refetches on every event
behind a 1.2s debounce; `budget-manager/ControlPlane.tsx:269` calls `onCommitted()` on every event.
Point eleven pages at it and that is a refetch storm carrying no information.

### 1.2 Shared control state — **the URL is the source of truth; the provider mirrors it**

Market, date range and the four scope grains persist as I move between pages.

**What exists.** `AdsMarketplaceProvider` (`_shell/MarketplaceContext.tsx`) is mounted in
`marketing/ads/layout.tsx`, so it already wraps all eleven pages. It resolves from
`GET /advertising/connections`, persists to `localStorage['nexus.ads.marketplace']`, exposes
`ready` so no control reads a market still being guessed at, and distinguishes launchable
(DE/ES/FR/IT) from sandbox (IE/NL/PL/SE/UK). Its header comment names the exact defect the eleven
pages have: *"each analytics page kept its own local market filter … so nothing agreed with
anything else."* `MarketSelect` **already has an `allowAll` mode** and `marketLabel('all')` already
returns "All markets".

**The trap nobody caught.** The provider **cannot express "all markets"**. After `ready` it holds
one launchable code — persisted, else `IT`, else the first launchable. Adopting it as-is would
silently narrow every one of the eleven pages to IT, on an account whose 220 campaigns span four
markets and whose census is account-wide. The control models "all"; the provider does not.

**Decision.**

1. **The URL wins, always.** `?market=` present → that value, no exceptions. Absent → the
   provider's resolved default.
2. **The provider gains `'all'`** as a first-class value, and every one of the eleven pages passes
   `allowAll` — here a market is a *filter*, never a launch target.
3. **The sentinel is the string `'all'`, never `''`.** The reverted `ScopeBar` used `''`, which
   would have emitted `?marketplace=all` and filtered to a marketplace of that literal name:
   zero rows, no error (RA §3.5).
4. **`localStorage` is written only when the operator moves the control**, never by a deep link.
   Opening a colleague's `?market=DE` link must not repoint your own default. This single rule is
   what stops localStorage and the URL disagreeing — KT R2's requirement, satisfied without a new
   mechanism.
5. **Dates: the server owns the vocabulary.** The client sends a `RangePreset` key
   (`ads-core/date-range.ts` — 13 presets, Europe/Rome-anchored) and never its own computed dates
   for a preset. Resolved dates for display come from the response's own `range` echo.
   `_shell/DateRangePicker.tsx`'s `DATE_PRESETS` is a **different vocabulary** sharing only `today`
   and `yesterday`; forwarding a picker key hits `resolveRange`'s `default:` branch and returns
   **seven days under a "Last 30 days" label**. **One adapter, in one file, at the boundary.**
   Nothing else in the section may touch a picker key.
6. **One hook: `useAdsScope()`.** Market · preset/start/end · portfolio · line · campaign. No page
   holds its own copy. This is Part 5 law 5 — *"Nothing keeps its own copy of market, scope or
   date. One hook, one URL"* — and it is currently violated three times over:
   `RulesAutomationClient.tsx:93`, `AutomationsClient.tsx:346` and
   `DaypartingSchedulesClient.tsx:70` each hold a private `market` derived from whichever data
   happened to load.

**Cost:** every cross-page link must be built by a helper, not hand-written.
**Failure mode:** a page that forgets the helper drops the scope on navigation — visible on the
first click, and pinnable by a test asserting every `RULES_BASE` href goes through it.

### 1.3 Live data — **one shared 30-second poll of a cursor endpoint. Not SSE.**

> 🔴 **WITHDRAWN 2026-08-12 — see §0.0(a).** `GET /advertising/pulse` was never built and must
> not be. A ledger cursor is blind to the hourly inbound resync, which was measured **134 minutes**
> behind `max(AdTarget.updatedAt)`. The poll survives; the single shared cursor does not. What
> ships is `_shared/useCursorPoll.ts` with a **per-page, measured** cursor. Everything below about
> why-not-SSE still stands.

**Decision: `GET /advertising/pulse`, polled every 30s by one provider, shared by every open page.**
It returns cursors and counts, never data:

```jsonc
{
  "ts": 1754918400000,
  "actionLog": { "maxId": "clx…", "count24h": 1672, "byEntity": { "AD_TARGET": …, "CAMPAIGN": … },
                 "byActionType": { "AD_BID_UPDATE": …, "AD_BUDGET_UPDATE": … } },
  "engines":   { "rankDefend": { "lastEvaluatedAt": "…", "schedulesLive": 33 },
                 "budgetManagerCron": { … }, "autoHarvest": { … } },
  "rules":     { "total": 51, "auto": 9, "propose": 13, "byTab": { "bid": 18, … } },
  "queue":     { "pending": 225, "applied": 1 },
  "gate":      { "halted": false, "autonomy": "AUTO" },
  "freshness": { "sqp": …, "searchTerm": …, "daily": …, "placementIS": … }
}
```

A page refetches **its own rows only when a cursor it cares about moves** — Bid on
`byActionType.AD_BID_UPDATE`, Budget on `AD_BUDGET_UPDATE`, Placement on
`update_placement_bidding`, Automations on everything. This is precisely KT R4's constraint: its
day-one grid is a full `SearchQueryPerformance` scan joined to a 30-day `AmazonAdsSearchTerm`
groupBy, so it must refresh on a targeted signal rather than on every cross-page event.

**Why a poll and not the stream that already ships:**

| | 30s pulse | SSE bus as it exists |
|---|---|---|
| sees the 67% of writes made by `ad-rank-defend` | ✅ (it reads the ledger) | ❌ — engine publishes nothing |
| wakeups per minute per tab | 2 | **14.6**, 82% of them dry runs |
| worst-case staleness | 30s, on data that changes every 15 min | ~0s on 0.21% of changes |
| cost to fix the gap | none | publish from **four live money-moving jobs** |
| failure mode | a number ≤30s old, with a visible "as of" | a silently dead stream that looks exactly like "nothing is happening" — a plausible state here, therefore undetectable |
| bytes | ~1 KB × 120/hour | one held connection per tab per page |

Buying ≤30 seconds of latency on data that moves four times an hour is not worth four changes to
live engines plus a firehose.

**Keep SSE exactly where it already earns its place:** the one moment a human is waiting on a
specific rule they just triggered — Simulate, and the Automations rule drawer — filtered to that
`ruleId`. Do not add a twelfth global subscriber.

⚠ **One event class exists *only* on the bus, and that is a bug, not an argument for SSE.** Since
2026-08-04 a cap refusal writes no execution row — it publishes a `CAP_EXCEEDED` event into a
50-event, 5-minute ring buffer and nothing else (§5.2). So the one thing SSE can see that the ledger
cannot is a refusal, and the answer is **to persist refusals**, not to subscribe eleven pages to a
ring buffer that forgets in five minutes. Today the count is moot: the cap never trips.

Three facts the implementation must honour:

- **`GET /advertising/campaigns` sits behind `cached(key, 300)`** (`ads-cache.ts`, L1 memory + L2
  Redis). "Real-time" over that endpoint is capped at **five minutes** whatever the client does.
  `flushAdsCache()` exists and must run after every mutation; **`/advertising/pulse` must not be
  cached at all.**
- **Optimistic writes must not be clobbered by an inbound tick** (RD 7). A page holds its
  optimistic value for a row until `actionLog.maxId` advances **past that write's own log id** —
  which is why the pulse returns an id cursor and not only a timestamp.
- **EventSource is already credentialed app-wide.** `lib/auth/install-fetch.ts` patches both
  `window.fetch` and the `EventSource` constructor to add credentials for API-origin requests.
  Every ads route is RBAC-enforced — probed 2026-08-11, `GET /api/advertising/execution-events`
  returns **401 `{"required":"ads.view"}`** unauthenticated, so it is deployed and mapped. Do not
  "fix" the SSE consumers by adding `withCredentials`; it is already there.

---

## 2 · The URL contract

### 2.1 Routes

> 🔴 **SUPERSEDED 2026-08-12 — see §0.0(d).** All eleven tabs are routed now. The tab key `rules`
> was **not** renamed: AR.S0 added an optional `path?` to `RulesTab`, so the key stays `rules` and
> only its route is `/apply-rules`. The claim below that "only two places read it" is wrong.

All under `RULES_BASE = /marketing/ads/rules-automation`. `tabs.tsx` already models the migration
(`routed: true` → `/rules-automation/<key>`); two tabs have made the move.

| # | page | route | today |
|---|---|---|---|
| 11 | Apply Rules | `/apply-rules` | index, key `rules` |
| 10 | Automations | `/automations` | ✅ routed |
| 9 | Bid | `/bid` | `?tab=bid` |
| 8 | Keyword Harvest | `/keyword-harvest` | `?tab=keyword-harvest` |
| 7 | Negative Targeting | `/negative-targeting` | `?tab=negative-targeting` |
| 6 | Budget | `/budget` | `?tab=budget` |
| 5 | Rank & Dayparting | `/dayparting` | ✅ routed |
| 4 | Budget Schedules | `/budget-schedules` | `?tab=budget-schedules` |
| 3 | Placement | `/placement` | `?tab=placement` |
| 2 | Share of Voice | `/share-of-voice` | `?tab=share-of-voice` |
| 1 | Keyword Tracker | `/keyword-tracker` | `?tab=keyword-tracker` |

The tab key `rules` is renamed to `apply-rules`. Only two places read it
(`rulesTabHref`, and `RulesAutomationClient.tsx`'s `?? 'rules'` default), and the index client is
dismantled by this work anyway.

### 2.2 🔴 The landing question

> ✅ **BUILT 2026-08-15 — with a different destination.** The operator, asked directly on
> 2026-08-15, chose **Apply Rules**, superseding this section's Automations answer. The bare index
> 308s to `/apply-rules` (derived in `rulesTabRoutes.cjs`, AFTER the `?tab=` rules so it cannot
> swallow them), the five legacy `/marketing/advertising/automation*` paths point at
> `/automations` / `/builder` directly (no two-hop chains), and the index client + placeholder
> seeds + `SovTrackerTab`/`TrackerTab` are deleted. The redirect lives in `next.config.js` only —
> no one-line `redirect()` page, per the ACR Stage 6 precedent quoted below.

**`/marketing/ads/rules-automation` becomes a redirect, not a page.** ~~It 307s to
`/rules-automation/automations`~~ — superseded above: it 308s to `/rules-automation/apply-rules` —
preserving query params, and maps every legacy `?tab=<key>` to its new route.

Why not an overview page: it would be a **twelfth page nobody studied**, and its content is either
Automations' census or a second copy of it — which fails Part 5 law 1 (one subject, one page) and
§3.0's law (name the pixel that changes). Why Automations and not Apply Rules: the programme's own
boundary table already says the 51 automations *are* the subject of the section, and Apply Rules'
two working columns duplicate the Ad Manager.

This must be a redirect and not a stub page: `next.config.js` already redirects three
`/marketing/advertising/automation/*` paths here, and ACR Stage 6's precedent is explicit —
**redirect in `next.config.js`, never a tree of one-line `redirect()` files**, "because a tree of
one-line files is a tree that gets edited back into pages". Array order is load-bearing: literal
paths before parameterised ones.

### 2.3 Shared params — identical on all eleven

```
?market=all|IT|DE|ES|FR              sentinel 'all', never ''
?preset=<RangePreset>                server vocabulary only (last7 · last30 · wtd · mtd · …)
?start=YYYY-MM-DD&end=YYYY-MM-DD     with preset=custom
?portfolio=<externalPortfolioId>     reaches 72 of 220 campaigns — state the reach
?line=<Product.id>                   a parent (the line, 13 of them) or a child (a variation)
?campaign=<Campaign.id>
```

The four grains **AND** together, exactly as `ruleMatchesScope()` ANDs them. Portfolio ⇄ campaign
stay mutually exclusive and that is provably right under AND: a campaign has at most one portfolio.

### 2.4 Per-page params — one vocabulary, eleven pages

Each page owns its own list; the spec fixes only the **shape**, so eleven pages do not invent
eleven words for the same thing:

```
?row=<id>        the inspected row              ?drawer=<name>   a side panel
?q=<text>        search within the grid         ?sort=<col>&dir=asc|desc
?page=<n>        pagination                     ?view=<segment>  a segmented control
```

KT's `?kw=` becomes `?row=`; SOV's `?scope=<groupId>` becomes `?portfolio=`/`?line=`; RD's
`?drawer=activity|next24|versions|events` is the canonical form.

### 2.5 Date controls — §3.0's law applied page by page

*A control earns its place only if some pixel changes when you move it.* Named here so no page
re-litigates it.

| page | date control | the pixel |
|---|---|---|
| Apply Rules | **no** | the grid has no metric column; §3.0 stands |
| Automations | yes | runs · acted · refused in the window |
| Bid · Budget · Placement | yes | spend, ACoS, write counts |
| Negative Targeting · Keyword Harvest | yes | the term's performance window |
| Rank & Dayparting | **only in the activity drawer** | a schedule is not a time series |
| Budget Schedules | **weeks** | the heatmap endpoint's grain |
| Share of Voice | **weeks** | SQP is weekly |
| Keyword Tracker | **split, and labelled** | KT R5 — **week** for the share columns, **day** for the spend columns. One control may not silently move both grains. |

### 2.6 Refresh and deep-link-from-outside

Every absent param means its **documented default, never a stored preference** — a link must render
the same view for whoever opens it (KT §7.4).

**One deliberate exception: `market`.** Absent, it falls back to the provider's persisted choice,
because a market is a *place you are working in*, not a view of a dataset — which is what
`AdsMarketplaceProvider` was built for. A link that means DE must therefore say `?market=DE`, and
the "copy link" affordance on every page writes the resolved market in explicitly.

---

## 3 · The navigation shell

**The sticky tab bar survives.** No new rail children — the ads rail keeps its one
"Rules & Automation" line (`_shell/nav.ts:102`, one item with one child "Control Room"); locks §3
row 4 and RA Part 8 Q1 both settle this.

Four changes, all inside `_shared/tabs.tsx` and the CSS it uses.

**1. Eleven `routed: true` entries — landing once, in the substrate phase.** Every one of the
eleven studies asks for "one additive line in `tabs.tsx`". Eleven sessions each adding one line to
one shared file is the highest-collision change in the programme (locks §3 row 1). It lands **once,
in S6, before any page is built.** A `routed: true` entry whose page does not exist yet renders a
link to a 404 — so S6 also ships ten stub routes that render the shared chrome plus the current tab
body, and each page replaces its own stub. Sequencing, not design.

**2. Make the overflow visible.** Measured: `.h10-rules-tabs { gap: 30px; overflow-x: auto;
scrollbar-width: none }` with `::-webkit-scrollbar { display: none }` (`ads.css:2063-2064`). At
eleven items, with labels like "Rank & Dayparting Schedules", the row overflows its column and
**scrolls with no visible affordance** — the last tabs are unreachable-looking. Add an edge fade
and keyboard scroll. This is the one thing about the bar that must change at eleven items.
⚠ Verify the actual overflow width in a browser on prod before choosing the treatment; the CSS
fact is certain, the wrap point is not.

**3. Group the eleven into four clusters** in the existing row — a hairline separator between
groups, no new control, no state:

> **Act** Apply Rules · Automations ┊ **Bid & Place** Bid · Placement · Rank & Dayparting ┊
> **Spend** Budget · Budget Schedules ┊ **Terms** Keyword Harvest · Negative Targeting ·
> Share of Voice · Keyword Tracker

**4. Stop the tab bar fetching all 51 rules on every page.** `RulesTabs` fires
`GET /advertising/automation-rules` on mount to compute five counts — on **every one of the eleven
pages**. The counts come from the pulse payload instead: one shared fetch, not eleven.

---

## 4 · 🔴 Arbitration — one owner each

**One owner. Everyone else links.** Where a subject turns out to be two different objects, both get
an owner and the split is stated — that is a resolution, not a compromise.

| contested subject | claimants | **OWNER** | everyone else gets |
|---|---|---|---|
| **per-scope spend ceilings** (market · line · portfolio · campaign) | 4 · 6 · 9 · 11 | **Nobody yet — it does not exist at any layer.** Substrate build, enforced in `ads-write-gate.ts`; the *values* are set on Automations' scope form | a **refusal renderer**. Any page whose write is refused shows the same sentence naming the scope. No page implements a ceiling. |
| **a surface for `ad-rank-defend`** | 3 · 5 · 9 · 10 | **two objects, two owners.** **10 · Automations** owns the *actor row* (name, mode, scope, ceiling, health, last tick, 29,764 writes). **5 · Rank & Dayparting** owns the *plan* (which target governs which hour) | 3 and 9 render outcomes and link to both. RD's "one writer, three lenses" table is **ratified verbatim** and gains a fourth entry: Automations owns the actor, not a lens. |
| **harvest + negate as one transaction** | 7 · 8 | **8 · Keyword Harvest** — promotion is the decision, the negation is its consequence | **7 · Negative Targeting** owns the *inventory* (2,059 negatives), the retirement path and the protected-terms audit. A harvest-born negative appears in 7's inventory carrying its source. |
| **the write gate** (82 of 220 campaigns) | *nobody claimed it* | **11 · Apply Rules** | It is a per-campaign boolean on a campaign grid — which is exactly what that page is, and the only thing on it that is not a worse copy of the Ad Manager. Answers AR Q4 and gives the page a reason to exist. |
| **the proposal queue** (225 pending, 1 applied, oldest 52 days) | 7 · 8 · 10 | **10 · Automations** | 7 and 8 show *their own* pending items inline on the row they concern. No other page renders the queue. |
| **the SQP recency guard** | 1 · 2 · 5 | **substrate** — one guard in `sqp.service.ts`, one `GET /advertising/freshness` | all three read one endpoint, render one chip, share one definition of "stale". |
| **the change ledger** (45,972 rows) | 10 · most others | **10 · Automations** owns the account-wide view | every other page gets the *same route* filtered to its own entity type / action type. One query shape, eleven filters. |
| **the hourly cube** (`/dayparting/heatmap`, `heatMetrics.ts`, `DaypartingHeatmap`) | 4 · 5 | **5 · Rank & Dayparting** — it already owns `_schedule/` | 4 consumes it. Ratifies BS §8's own proposal. |
| **the window grammar** (`scheduleConfig.ts`, `TIME_OPTIONS`, the 23:00 hole) | 4 · 5 | **5** | one fix serves both schedule kinds. |
| **"which loop owns this campaign this hour"** | 3 · 5 · 9 | **substrate** — one endpoint over `resolveActiveTargetKey(windows, defaultTargetKey, day, hour)` + event overrides + per-scope merge | three pages render it, none computes it. `resolveActiveWindow` was extracted precisely to stop a second copy drifting (`rank-controller.ts:54-60`). |
| **the authority pin** | 3 · Control Room | **the dimension's own page**: `pinPlacement` → 3 · `pinBids` → 9 · `pinBudget` → 6 | Control Room's copy retires when those three ship. One pin, three homes, no fork — each page shows only its own dimension. |
| **monthly caps + pacing** (`AdBudgetPlan`, 5 rows) | 4 | **4 · Budget Schedules** | ratified — it currently lives on `/marketing/ads/budget-manager`, a different section. |
| **budget level and budget *rules*** | 4 · 6 | **6 · Budget** | ratified from BS §8. 4 shows the consequence, 6 owns the cause. |
| **the lane/blend editor** (`_rank/RankBlendEditor.tsx`) | 3 | **5** — it lives in `_rank/` | 3 links to it and must never fork it. A second three-lane editor is a second definition of a lane. Ratified from PLC 12. |
| **the curated keyword set** (`KeywordCoverageSet`, 97 terms, 1 set) | 1 · 2 | **1 · Keyword Tracker** | 2 reads it; an edit on 1 reaches 2 through the pulse cursor. |
| **"share" derived from `SearchQueryPerformance`** | 1 · 2 · 5 | **substrate** — one server-side derivation | ratified from SOV 3, including the week the value came from, its age, and "not covered" distinct from zero. |
| **freshness display** | 1 · 2 · 3 · 5 | **substrate** — one endpoint, one chip | ratified. Two implementations would disagree about what "stale" means. |
| **the conflict detector** | 10 | **10 · Automations**, rewritten | conflicts are by **entity**, not by trigger — see §5.4. |

### 4.1 The engine question — answered

AUTO's open question 1 (*"should the engines get rows on this page?"*) is the largest single
decision in the section, and the measurement answers it: **`ad-rank-defend` alone made 29,764 of
44,435 writes in 60 days — 67%** — and has no row, no dial, no ceiling, no scope and no conflict
entry anywhere in the product. **Yes. Engines get rows on Automations**, alongside rules, with the
actor-kind column of §5.7.

### 4.2 The one resolver every attribution needs — measured

Three pages need `automation:*` to become a human name, and there must be exactly one
implementation. Measured 2026-08-11:

```
automation:rank-defend-<id>   →  id is an AdSchedule.id     (ad-rank-defend.job.ts:680)
                              →  AdSchedule.groupId
                              →  RankScheduleGroup.name
```

Verified end to end: `automation:rank-defend-cmr2695n902ndp7016x3k2lv6` →
`AdSchedule{campaignId, groupId: cms9lvl1p0gboo4019us7adx8, enabled: true, lastApplied:
'own-top-allout', lastEvaluatedAt: 2026-08-11T13:00:01Z}` → `RankScheduleGroup "IT GALE JACKET"`.

⚠ **Two traps a hand-rolled resolver will hit.** The id is **not** a `RankScheduleGroup.id` —
33 distinct actor ids appear in 48h against only 16 groups, and a direct lookup returns nothing.
And `RankScheduleGroup.marketplace` is **null** on that group, so a page cannot read the market off
the group; it is derived from members (exactly SOV requirement 3). 45 `AdSchedule` rows exist, 33
enabled, all carrying a `groupId`.

---

## 5 · The display contracts

Session 10 produced none, so these are written, not ratified. Each is a rule about *what a pixel is
allowed to claim*.

### 5.1 A mode
`autonomyLevel` only — **OFF · OBSERVE · PROPOSE · AUTO** — resolved through `resolveAutonomy(rule)`
and `levelActs(level)`, never read off a column. **`dryRun` is never rendered anywhere**; it is
unreachable for all 51 rules and the PATCH handler does not accept it (RA Part 2). An engine has no
`autonomyLevel`: it renders its own posture (`enabled` + cron state) in the same four-notch shape
with the notches it actually has, and says which it is.

### 5.2 A ceiling
Three facts on one line, always: **the limit · the current position · what happens at the limit.**

> *"Daily cap 10 — 10 used, 1,947 refused today. Further matches are refused, not queued."*

Never a bare "10/day". All 51 rules carry a `maxExecutionsPerDay`.

🔴 **This contract cannot be honoured until the cap counter is repaired, and study 10's reading of
the caps is historically true but currently false.** Verified independently on prod today
(`_sub-cap.mts`):

| | |
|---|---|
| `DAILY_CAP_EXCEEDED` rows all-time / 60 d / **7 d** | 693,704 / 693,704 / **0** |
| newest cap row | **2026-08-03** |
| rule *"Scale budget-capped winners"*, cap **10/day**, today | counter as written → **0** · with the null branch spelled out → **265** · rows actually written → **265** |

`automation-rule.service.ts:568` counts with `NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' }`, which is
SQL `NOT (errorMessage = 'X')` → **NULL, not TRUE**, for the null `errorMessage` every SUCCESS and
DRY_RUN row carries. The counter sees only real failures, so **`maxExecutionsPerDay` never trips for
any rule.** The 693,704 rows are residue from before 2026-08-04, not a live condition.

Three consequences this spec must carry:

1. **A ceiling that renders "0 refused" for all 51 rules forever is a decorative control** — the
   exact class Part 5 law 10 exists to remove. Repairing the counter is a **precondition** of
   §5.2, not a follow-up. Always spell the null branch:
   `OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }]`.
2. **A refusal currently has no durable record anywhere.** Since 2026-08-04 a cap refusal writes no
   execution row — only an ephemeral `publishAdsExecution` event into a 50-event, 5-minute ring
   buffer. So §5.6's "refused" state and the ledger of §4 **cannot be sourced** until refusals are
   persisted. That is substrate work (S4/S5), not page work.
3. **`automation-rule-cap.vitest.test.ts:101` passes and pins the bug** — it mocks
   `prisma…count` and asserts the *shape* of the where clause. No query runs, so nothing observes
   that the clause matches nothing. Do not trust that test as evidence of a fix; re-measure against
   prod.

⚠ Re-size the caps before repairing the counter. Several are wrong for the shape of rule they sit
on, and a repair alone would take rules from unbounded to abruptly bounded at a number nobody chose.
*(Independently verified here; first recorded by a concurrent session, 2026-08-11.)*

### 5.3 A scope
Four dimensions, ANDed, each stating its reach **before** the action, and always **two numbers**:

> *"IT · GALE line → 27 of 220 campaigns · 22 writable."*

Two numbers because D3 means a rule can match campaigns it may not write to — *"matched 40, allowed
to act on 12"* is the honest reading, and no screen may let those be confused. A scope resolving to
zero is **refused, never stored** (409 `scope_matches_nothing`, naming which pair conflicts).
Measured today: of 51 rules, **8 are market-scoped and 0 use portfolio, campaign or product** — the
product grain shipped 2026-08-10 and nothing uses it.

### 5.4 A conflict
**By entity, not by trigger.**

> *"5 things can change this campaign's budget today: 2 rules, budget-manager-cron, a budget
> schedule, and you."*

The shipped detector's first line is `if (a.trigger !== b.trigger) continue`, and its `OPPOSED`
list holds eight opposite pairs. Run verbatim against the 22 live rules it flags **0**, and it
could not have caught the budget ratchet — the one thing it exists to prevent — because the two
rules fire on different triggers. **Same-action overlap is a conflict class**: N actors writing the
same field to the same entity. `ruleMatchesScope` already computes the entity set. The detector is
replaced, not tuned.

### 5.5 A refusal
**One sentence, quoting `GateDecision.reason` verbatim — never paraphrased — naming the gate that
refused and linking to the control that clears it.** `checkAdsWriteGate` already writes eight
distinct `deniedAt` values; each maps to one sentence and one link:

| `deniedAt` | clears at |
|---|---|
| `automation_halted` | account posture (Automations) |
| `connection` / `connection_writes` | Account settings — per-connection writes |
| `campaign_allowlist` | **the write gate, Apply Rules** |
| `authority_pin` | the dimension's page (3 / 6 / 9) |
| `entity_bounds` | min/max bid, Apply Rules |
| `keyword_protected` | protected terms, Negative Targeting |
| `value_cap` | env `NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS` |

⚠ **FOOTGUN to surface, not hide:** re-enabling a PAUSED campaign does **not** re-allowlist it —
the write is denied at `campaign_allowlist` and the fix is
`PATCH /advertising/campaigns/:id/live-writes`. The gate's own comment calls that "the intended
trade"; the UI must make it visible rather than let a campaign look quiet for no reason.

**A refusal is never rendered as a failure.**

### 5.6 Empty states — **four, not three**
BS 8 asked for three. The studies collectively need four, plus an orthogonal freshness axis.

| state | test | wording |
|---|---|---|
| **never ran** | `evaluationCount = 0` | *"This has never run. Created 2026-06-12, no executions."* |
| **ran, did nothing** | evaluations > 0, matches = 0 | *"Ran 3,710 times in 30 days and matched nothing"* + the likely reason |
| **broke** | failures > 0 | *"0 succeeded, 644 failed in 30 days."* Failures only — refusals excluded |
| **refused** ← the fourth | a `GateDecision` deny, or a cap refusal | *"Wanted to act 19,423 times; the daily cap refused all of them."* Not breakage, and never the same colour as it. ⚠ **Unsourceable today** — see §5.2.2: cap refusals persist nowhere since 2026-08-04 |

Orthogonal, and **not** an empty state: **stale data** — a freshness chip on the number itself.

And the distinction SOV §5.3 found, which must survive from query layer to cell: **"we hold none"
(a row exists, share is 0) is not "not covered" (no Brand Analytics row at all).** The API returns
`null` and `0` and **never coalesces**; a layer that coerces both to `0` — as `share()` does today —
makes the distinction unbuildable above it.

### 5.7 An engine displayed beside a rule
Same row shape; one column differs — **Actor kind: Rule | Engine**. An engine row carries: name ·
what it writes · cron cadence · last tick · writes in the window · which campaigns it can reach ·
its posture. Rules made 95 of 42,885 writes; a list showing only rules is a list of 0.2% of the
account.

### 5.8 An in-flight (`PENDING`) write
The row shows the **intended** value with a pending marker **beside** the current value, never
instead of it. This is a display contract *and* an engine fix: BUD's Tier 0 requires that a
`PENDING` outbound write be treated as the entity's current value, because re-reading the stale
value is what lets the trim loop cut the same campaign again on the next tick.

### 5.9 Attribution
Every changed value carries **actor · reason · old→new · timestamp**, resolved through the single
resolver of §4.2. Writes originating in the UI must carry an actor and a reason into the audit
spine — at least one shipped route (`PATCH /campaigns/:id/placements`) does not, and **the shared
write client must make omitting attribution impossible rather than merely discouraged** (PLC 6).
Measured motivation: 9,589 of 44,435 writes in 60 days carry a `null` actor.

---

## 6 · Shared components — reuse, not rebuild

### 6.1 Exists, use unchanged
`AdsDataGrid` — per-column sort with explicit `sortValue`, client search, `selectable` + a selection
bar via `selectionActions`, `toolbarLeft`/`toolbarRight` slots, `exportable` + `onExport`,
`editMode` (bulk **and** the inline hover-pencil popover), `storageKey` column customisation,
range/select/multiselect filters. **Every capability KT R8 lists is present.** Note: `exportable`
gives you the *button*; each page supplies `onExport`.

`AdsPageHeader` · `MarketSelect` (**`allowAll` already exists**) · `DateRangePicker` · `HoverCard` ·
`NoDataIllus` · `RulesTabs` · the `h10-*` cell markup · DS `FilterBar`, `GridToolbar`,
`SegmentedControl` — all shipped, all previously hand-rolled by someone who did not check.

### 6.2 Needs one additive prop
| component | change |
|---|---|
| `AdsMarketplaceProvider` | an `'all'` value + URL sync. **The one load-bearing change in this list.** |
| `AdsPageHeader` | `showMarket?: boolean`, defaulted `true` (byte-identical for every other page). ⚠ **It does not have this today** — the locks-doc §2 note is stale; the prop went with the ScopeBar revert (`7db1a4ed6`) and the RA ledger records the correction. Verified by reading the file. |
| `AdsDataGrid` | `columnNote` per column, so a column that can never render says why instead of printing `—` forever (BS 9 — two of Budget Schedules' seven columns are hard-coded `null` at the route). |
| `RulesTabs` | clusters · visible overflow · counts from the pulse instead of its own fetch. |

### 6.3 Genuinely new — five things, and only five
1. **`useAdsScope()`** — market · dates · four grains, URL-backed. One hook, one URL.
2. **`useAdsPulse()`** — the shared 30s poller and its cursors.
3. **`<FreshnessChip source=… />`** — age · row count against a trailing norm · four states. SOV 2
   is explicit that age alone is not enough.
4. **`<Refusal decision=… />`** — renders a `GateDecision` verbatim plus the link that clears it.
5. **`<ActorCell actor=… />`** — the one `automation:*` resolver of §4.2.

Everything else is new *content* in the existing shell (Part 5 law 6).

### 6.4 CSS constraints
`rules-automation.css` is **1,369 lines**, loaded by the `rules-automation/layout.tsx` subtree
layout, and therefore **shared with Rank Goals** (`_rank/RankGoalBuilder.tsx`, which also imports
`_schedule/ScheduleBuilder.tsx`) — off limits, behaviour and pixels.

- **Append at EOF, with a per-page prefix.** Source order beats specificity in that file; an
  override must sit at the end of what it overrides.
- **No `.dark` block.** `.h10-shell` sets `color-scheme: light` with hard-coded hex — a `.dark`
  block yields dark cards in a permanently light shell.
- **Portalled DS components escape the light pin.** A Drawer or a Select menu portalled to
  `document.body` leaves `.h10-shell` and goes dark; re-apply the pin at the portal root.
- The DS conformance ratchet **greps comments** — a comment can fail it.

---

## 7 · 🔴 The build order

### Phase S — substrate. Nothing else starts.

| # | unit | blocks |
|---|---|---|
| **S1** | `useAdsScope()` · provider `'all'` · URL sync · the `DATE_PRESETS`→`RangePreset` adapter | **all eleven** |
| **S2** | `GET /advertising/pulse` (uncached) + `useAdsPulse()` | **all eleven** |
| **S3** | `GET /advertising/freshness` + `<FreshnessChip>` + **the SQP recency guard** | 1 · 2 · 3 · 5 |
| **S4** | the ledger route — `GET /advertising/action-log` filtered by entityType · entityId · actionType · market · date, returning `payloadBefore`/`payloadAfter`/`evidence` | 3 · 4 · 6 · 9 · 10 |
| **S5** | `<Refusal>` · `<ActorCell>` · the four empty states · **refusals separated from failures everywhere** · 🔴 **repair the daily-cap counter and persist a refusal durably** (§5.2) | all eleven — and the ceiling contract is unbuildable without the repair |
| **S6** | `tabs.tsx`: eleven `routed: true` + ten stub routes · clusters · visible overflow · **the three action-type map corrections** | all eleven |

**S3 note — the freshness endpoint is half-built already.** `AmazonReportRun` (the R0.1 registry)
holds **5,882 rows, 5,264 with `freshAsOf`**, including **2,334 `GET_BRAND_ANALYTICS_SEARCH_QUERY_
PERFORMANCE_*`**. So SQP freshness reads from the registry; the three ads tables are a `MAX(date)`
each. One endpoint, four rows. Measured today:

| source | latest | age | rows |
|---|---|---|---|
| `SearchQueryPerformance.startDate` | 2026-07-26 | **16.5 d** | 15,075 |
| `AmazonAdsSearchTerm.date` | 2026-08-10 | 1.5 d | 10,826 |
| `AmazonAdsDailyPerformance.date` | 2026-08-10 | 1.5 d | 41,699 |
| `AmazonAdsPlacementReport.date` | 2026-08-10 | 1.5 d | 4,542 |
| …with `topOfSearchIS` non-null | 2026-08-09 | 2.5 d | 811 |

**S6 note — three broken tabs, not two.** `liveType="keyword-harvesting"`
(`RulesAutomationClient.tsx:391`) has no entry in `RULE_TAB_ACTION_TYPES`, which spells it
`keyword-harvest`; and `SovTrackerTab`'s slugs `sov` and `keyword-tracker` have no entries at all.
`ruleBelongsToTab` returns `false` for every rule on **three** tabs. One string fix plus two map
entries.

### Phase P — the page that proves the substrate: **3 · Placement**

Not the easiest. Chosen because it is the only page that exercises **every** substrate piece at
once: shared market + date + scope; the engine actor resolver; the freshness chip over two feeds of
different ages (`topOfSearchIS` at 2.5 d, SQP at 16.5 d); the refusal renderer for both pins and
bounds; the filtered ledger over **15,379 `update_placement_bidding` writes**; the pulse cursor on a
value the engine changes every 15 minutes; and a link-out to an editor it must not fork. If
Placement works, the substrate works. Keyword Tracker is the easy pick and would prove almost none
of it.

### Phase L — three lanes, in parallel. No shared files remain after S6.

| lane | order | why sequential within the lane |
|---|---|---|
| **A · bid & place** | 9 · Bid → 5 · Rank & Dayparting | the CPC ceiling lives on RD's `RankTarget` but is breached by base bids Bid owns |
| **B · spend** | 6 · Budget → 4 · Budget Schedules | 4 shows the consequence of the cause 6 owns |
| **C · terms** | 8 · Harvest ∥ 7 · Negatives ∥ 1 · Tracker → 2 · Share of Voice | 2 reads 1's `KeywordCoverageSet` |

### Phase F — the two that need everything else to exist

**10 · Automations** (every actor row links out to a page that must already exist) →
**11 · Apply Rules** (owns the write gate; widening it from 82 is the last act, one product family
at a time per D3).

### Fixes folded in — cheaper than the page, and they change what the page shows

| fix | lands in | why there |
|---|---|---|
| **SQP recency guard** in `sqpImpressionShareForAsins` | **S3** | measured **16.5 days** stale today, read by `ad-rank-defend` with no age check. Live, and moving money now. |
| 🔴 **repair the daily-cap counter** (+ re-size the caps first) | **S5, and arguably today** | verified on prod: a rule capped at **10/day ran 265 times today** and the counter read 0. The cap was **the only stated brake on the budget ratchet — so there is currently no brake at all.** |
| **budget-rule per-entity cooldown** + treat `PENDING` as current + a daily total-reduction cap | **before page 6** | the ratchet is still running: two AUTO rules compounding 15–20%/tick, 58 of 86 live campaigns at the €1 floor — ⚠ **corrected 2026-08-16 (BUD.8): 56 of those 58 were floored by the pacer in single writes, not by the rules; see the note below §871 and the [BUD.8 record](2026-08-16-bud-8-armed.md)** |
| **`keyword-harvesting` → `keyword-harvest`; add `sov`, `keyword-tracker`** | **S6** | three tabs filter every rule out of themselves |
| **negative retirement path** | **before 7 ships** | it is the code's own stated blocker on AUTO negation, and the whitelist precondition is already satisfied (10 terms) |
| **refusals separated from failures** | **S5** | the 693,704 historical rows read as breakage today, and every future refusal has nowhere to be recorded |
| `bid_down` rendering "+25%" | lane A | one string |
| delete `placeholderSeeds.ts`, `ComingSoon`, `tabs/NegativeTargetingTab.tsx` | S6 | three files, all unreachable |

### Blocked — and on what

| item | blocked on |
|---|---|
| **the per-scope spend ceiling** | **a decision, not a build.** It has no schema, no route and no gate check. Four pages claim it. Open question 2. |
| **precedence** (pacer vs budget rules vs budget schedule) | an operator decision. Open question 1. |
| product-line grain **in use** | the 27 uncatalogued ASINs (274 ad rows) — no picker can name them; the existing Amazon import is the fix |
| organic rank on Keyword Tracker | a purchase decision (KT §6) |
| competitor brands on Share of Voice | a purchase decision (SOV §6) |
| AMC / DSP anything | entitlement — blocked at Amazon. Do not build. |

---

## 8 · What NOT to build

**This list is as load-bearing as the rest.** Eleven independent sessions will each propose two of
these.

1. **A new scope-and-date bar.** Built, shipped, reverted (§3.0). Portfolio and Campaign already
   exist as grid filters; Market lives in the header. The revert's law governs everything here:
   *name the pixel that changes when you move the control, or it does not go there.*
2. **A twelfth "Overview" page.** `/rules-automation` redirects. Nobody studied an overview and its
   content is Automations' census or a copy of it.
3. **A React Query / SWR layer.** Neither is in `apps/web` — only `@tanstack/react-table` and
   `@tanstack/react-virtual`. Adopting a cache to satisfy eleven pages means adopting it across a
   623-file app. The pulse cursor gives targeted invalidation for a fraction of that.
4. **SSE for the eleven pages.** §1.1. Keep the one stream that exists, scoped to a rule a human is
   watching.
5. **Publishing to the SSE bus from the engines.** It is four changes to live money-moving jobs to
   buy ≤30 seconds on data that changes every 15 minutes.
6. **A second three-lane editor** on Placement. Link to `_rank/RankBlendEditor.tsx`.
7. **A second `resolveActiveTargetKey`.** One endpoint, three renderers.
8. **A second "share" aggregation.** One server-side derivation; three surfaces would disagree
   about our share within a quarter.
9. **A per-page freshness fetch.** One endpoint. Two implementations will disagree about "stale".
10. **A global spend ceiling.** The standing decision is per-scope. `AdsAutomationState.
    maxHourlySpendCentsEur` **is** the global one, it is **NULL**, and it does not refuse a write —
    it **halts the entire account**. Setting it is not a substitute for the per-scope ceiling.
11. **`dryRun` anywhere in the UI.** Dead field; `autonomyLevel` wins.
12. **A Simulate button on any page but Automations**, and not until
    `POST /automation-rules/:id/simulate` in `advertising-intel.routes.ts` is fixed — it still
    `void`s `runAdvertisingRuleEvaluatorOnce()`, i.e. all 21 triggers with no forced dry run.
    `simulateOneRule` is the fixed path.
13. **Row actions on computed grids** (SOV 5) — a "Remove" that mutates local state and lies. Same
    defect as `RuleListTab`'s Delete, which says "cannot be undone" and removes a row from
    `useState`.
14. **Retiring the Control Room, the `AutomationDock`, the Portfolios rail or ads-console as a side
    effect** of building a replacement. Locks §0: each retires in the session that owns it, after
    its replacement is live and verified.
15. **Touching Rank Goals** — `_rank/RankGoalBuilder.tsx`, `_schedule/CampaignSection.tsx`,
    `_schedule/dayparting.css`, and `_schedule/ScheduleBuilder.tsx` which Rank Goals imports for
    `?style=classic`.
16. **A `.dark` block in `rules-automation.css`.**
17. **Amazon-native budget rules with hours-of-day for IT/DE/ES/FR.** Native rules are
    INCREASE-only and SP-only, and hours-of-day is US/CA/UK/IN/JP — not our markets. Lane B will
    be tempted; it does not exist for us.
18. **Per-campaign `bidAlgorithm` and "Budget Rule" columns on Apply Rules.** Amazon exposes no
    per-campaign field for the first; the second is hard-coded `None` on all 220 rows. Delete
    rather than wire (Part 5 law 10 — never render what no executor reads).

---

## 9 · Where the eleven disagreed, and who wins

| # | disagreement | winner |
|---|---|---|
| 1 | **Who owns `ad-rank-defend`.** PLC 1 wants "exactly one name, one identity, one link target". RD proposes one-writer-three-lenses with itself owning the plan. BID Q5 asks whether it gets its own surface. AUTO Tier 0 says it needs a *row*. | **RD's split, plus AUTO's row.** They are two different objects: Automations owns the **actor**, RD owns the **plan**. Four claimants, two owners, and neither is a compromise. |
| 2 | **Where the authority pin lives.** PLC 11 poses it as either/or — once in the Control Room, or on every dimension's page — and says only that it must not fork. | **Every dimension's page, one dimension each.** A pin is a property of a dimension of a campaign; centralising all three makes two of them unfindable from the page where you notice the problem. |
| 3 | **A date control on Keyword Tracker.** KT R5: SQP is weekly, spend is daily, one range over both is "a two-vocabularies defect waiting to happen". SOV assumes weekly throughout. | **KT.** Two labelled grains on one page, and the control states which columns it moves. |
| 4 | **How many empty states.** BS 8 says three, worded identically across all eleven. | **BS amended, not rejected — four.** "Refused" is not "broke". 693,704 historical refusal rows are why the distinction exists; §5.2 is why it is not yet renderable. |
| 5 | **Precedence between budget writers.** BS 5 wants "a single answer it can display" and says it is not this page's to invent. BUD Q5 asks the operator who should win. | **Neither page.** It is an engine decision the operator must make — open question 1. Both pages then display the same answer. |
| 6 | **The conflict detector.** It ships; AUTO §3 shows it finds 0 and could not have caught the ratchet. | **AUTO.** Replaced, not tuned: by entity, and same-action overlap is a conflict class. |
| 7 | **`tabs.tsx`.** BS 2, PLC 13 and (implicitly) all eleven each ask for "one additive `routed: true`" in one shared file. | **Nobody edits it eleven times.** It lands once, in S6, with stub routes. |
| 8 | **The section's shape.** The programme doc's 🔒 §4.0a-FINAL locks a cull to six pages and DROPs Apply Rules, Bid, Harvest, Negatives, Budget and Placement, MERGEing Keyword Tracker into Share of Voice. | **The operator's 2026-08-11 direction wins.** Eleven pages; §4.0a-FINAL is dead. Recorded here because that section is marked LOCKED and the next reader will hit it. |
| 9 | **Market state.** KT R1 says "this page needs that guarantee; it does not need a new mechanism" — adopt `AdsMarketplaceProvider`. | **Half right.** The provider is the right home, but adopting it as-is silently narrows all eleven pages to IT, because it has no "all". Adopt it **and** give it `'all'` + URL sync. |

---

## 10 · Open questions for you

1. 🔴 **Precedence.** When the pacer, a budget rule and a budget schedule disagree about one
   campaign's budget, who wins? Three pages must display one answer and none may invent it.
   *(BS 5, BUD Q5 — open since yesterday.)*
2. 🔴 **The per-scope ceiling's numbers.** €/day at market · product line · portfolio · campaign.
   It has **no schema, no route and no gate check** — four pages claim a thing that exists nowhere.
   Give me one market's number and I will build the shape around it.
3. 🔴 **The ratchet is still running, and its only brake is broken.** Two AUTO rules compounding,
   58 of 86 live campaigns pinned at the €1 floor — and `maxExecutionsPerDay`, the one stated

> 🔴 **Correction, 2026-08-16 (BUD.8).** The attribution of the €1 floor to the two AUTO rules is
> wrong for 56 of the 58 campaigns. Measured on prod: **56 were floored by
> `automation:budget-manager-cron` in single writes** (`€100 → €1`), 55 of them inside one hour on
> 2026-08-05; only **2** reached €1 by rule compounding, and both were already at ~€1 when the
> rules reached them. The ratchet is real; it is not what emptied the account. Full derivation in
> [the study's §0 correction](2026-08-11-bud-budget-study.md) and
> [the BUD.8 record](2026-08-16-bud-8-armed.md).
   bound on them, **has not tripped for any rule since 2026-08-04** (verified today: cap 10, ran
   265). Stop it now — disable the two AUTO rules — or wait for the cooldown in lane B?
   *(BUD Q1, unanswered since yesterday; the cap finding makes it more urgent, not less.)*
4. **Engines get rows on Automations** — I have decided yes in §4.1, on the strength of 67% of
   writes. Confirm; it is the largest single change in the section.
5. **The landing page.** I am redirecting `/rules-automation` → `/automations` and mapping every
   legacy `?tab=` to its page. Confirm Automations and not Apply Rules.
6. **`maxHourlySpendCentsEur` is NULL** (`maxActionsPerHour` = 500). The global guard is the only
   spend guard that exists, and it halts rather than refuses. Leave it null while the per-scope
   ceiling is built, or set an interim number?

---

## Appendix — scripts

Read-only, no writes. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<file>` from
`apps/api`.

| script | measures |
|---|---|
| `_sub-substrate.mts` | ledger volume + rate · what fraction the SSE bus can see · per-source freshness · `AmazonReportRun` coverage · every guardrail column by grain · the proposal queue · the eleven pages' backing objects |
| `_sub-cadence.mts` | writes per five-minute slot over 48h · inter-arrival p50/p90/p99 · minutes-with-a-write · which actor touches which entity |
| `_sub-actor.mts` | the actor-prefix census over 60 days |
| `_sub-actor-resolve.mts` | `automation:rank-defend-<id>` → `AdSchedule` → `RankScheduleGroup` |
| `_sub-cap.mts` | the daily-cap counter's two filter forms run side by side against one live rule, plus the `DAILY_CAP_EXCEEDED` row census by window |

Code read, not re-derived: `ads-execution-events.service.ts` · `lib/sse.ts` ·
`advertising.routes.ts:6278` (the SSE route) and `:8034` (the autopilot stream, a 3-second DB poll
dressed as one) · `ads-cache.ts` · `ads-core/date-range.ts` · `_shell/MarketplaceContext.tsx` ·
`_shell/MarketSelect.tsx` · `_shell/DateRangePicker.tsx` · `_shell/AdsPageHeader.tsx` ·
`campaigns/_grid/AdsDataGrid.tsx` · `rules-automation/_shared/tabs.tsx` ·
`rules-automation/RulesAutomationClient.tsx` · `tabs/SovTrackerTab.tsx` · `tabs/RuleListTab.tsx` ·
`automation-rule-scope.ts` · `ads-write-gate.ts` · `ads-authority-pins.ts` ·
`ad-rank-defend.job.ts:680` · `lib/auth/install-fetch.ts` · `lib/auth/rbac-hook.ts`.

Prod probe: `GET /api/advertising/{execution-events,campaigns,automation-rules,connections,
portfolios,scope-options}` → **401 `{"code":"unauthenticated","required":"ads.view"}"`** — all six
deployed and RBAC-mapped, RBAC in **enforce** mode.
