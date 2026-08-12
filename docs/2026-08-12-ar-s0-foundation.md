# AR.S0 — Apply Rules, the foundation

*The contract nine sections build against. Written before the code, so that AR.S1–AR.S9 are each
**one new file and one import line** rather than a restructuring of the client.*

**Route:** `/marketing/ads/rules-automation/apply-rules`
**Slug:** `ar0` · scratch scripts `apps/api/scripts/_ar0-*.mts` (none were needed — see §9)
**Status:** built, prod-verified, read-only.

Design already approved: [`2026-08-11-ar-apply-rules-page.md`](2026-08-11-ar-apply-rules-page.md)
(especially §0.1, §6, §7, §9, §10, §12, §14) over
[`2026-08-11-ar-apply-rules-study.md`](2026-08-11-ar-apply-rules-study.md), inside
[`2026-08-11-substrate-spec.md`](2026-08-11-substrate-spec.md) and
[`2026-08-10-ads-rules-automation-ra.md`](2026-08-10-ads-rules-automation-ra.md).
Parallel-session protocol: [`2026-08-10-ra-session-locks.md`](2026-08-10-ra-session-locks.md).

---

## 0 · The one-sentence version

The page answers **"what is automation allowed to do here, what has it done, and what is that
costing?"** — and S0 builds the half of that sentence that is a *row*: a grid that works at **four
grains**, where a row is a campaign, a portfolio, a product line or a market, over one merged
payload from two endpoints that already exist and already serve two other screens.

**S0 writes nothing.** That is stated in the type system, not implied by omission
(`NO_WRITE_ACTIONS`, §5.4).

---

## 1 · 🔴 The grain switch — the idea the page is built on

The reverted scope bar (RA §3.0) failed because it only *filtered*: no pixel changed that a filter
could not have changed. **Grain is not a filter. It changes what a row is.**

Market is the **filter** and lives in `AdsPageHeader`. Grain is the **switch** and lives in the grid
toolbar. They compose: `market=IT & grain=campaign` → 150 rows; `market=all & grain=market` → 4 rows.

### 1.1 Row counts, measured on production 2026-08-12 10:04 UTC

`GET /advertising/campaigns?limit=500` + `GET /advertising/control-room/guardrail-grid?limit=500` +
`GET /advertising/scope-options`, read from the browser page context on
`nexus-commerce-three.vercel.app` (the API is RBAC-enforced; plain curl returns
`{"error":"Access denied","code":"unauthenticated"}`).

| grain | rows | composition |
|---|---|---|
| **Campaign** | **220** | the default grain |
| **Market** | **4** | IT 150 · DE 38 · FR 22 · ES 10. No null marketplace. Σ = 220 ✅ |
| **Portfolio** | **13** | 12 `AmazonAdsPortfolio` rows + **"No portfolio" (148)**. Only **10 hold a campaign**; `xyz` and `IT MOSS JACKET` hold **zero** and still render. Σ = 220 ✅ |
| **Product line** | **14** | 13 `Product` parents + **"advertising nothing" (2)**. **Σ = 224 ≠ 220** 🔴 |

Every figure in the brief's table reproduced exactly. Two additions the brief did not carry:

- **IT's daily budget is €4,275.23/day** (the brief left the cell blank). FR €1,284.09/day.
- **`IT-MOSS-JACKET` is the only grain row anywhere where `managed` ≠ `live`** — 27 campaigns,
  19 live, **15 managed**. Everywhere else in the account the two numbers are identical, which is
  what makes this one row worth not rounding away.

```
grain=market        n   live  managed  bounded  pinned  delivering   dailyBudget
  IT              150     74       70       70       0          69   €4,275.23/d
  DE               38      8        8        8       0           8   €2,751.87/d
  FR               22      2        2        2       0           2   €1,284.09/d
  ES               10      2        2        2       0           2     €457.38/d

grain=line          n   live  managed  bounded  pinned  delivering   dailyBudget
  GALE-JACKET      77     36       36       36       0          36   €2,409.83/d
  3K-HP05-BH9I     40      4        4        4       0           4   €2,729.00/d
  IT-MOSS-JACKET   27     19       15       15       0          17     €223.00/d   🔴 managed ≠ live
  AIREON           17     11       11       11       0          10     €479.50/d
  AIRMESH-JACKET   17     10       10       10       0           9   €1,021.24/d
  REGAL-JACKET      9      0        0        0       0           0     €375.00/d
  VENTRA-JACKET     9      0        0        0       0           0     €380.00/d
  xracing           6      0        0        0       0           0     €300.00/d
  normal-knee-slider 6     4        4        4       0           4     €139.00/d
  xavia-knee-slider  5     5        5        5       0           5       €5.00/d
  1J-EYE5-Y0TW      4      0        0        0       0           0     €180.00/d
  UD-LVLM-1H8T      4      0        0        0       0           0     €180.00/d
  AIR-MESH-JACKET-MEN 3    0        0        0       0           0     €360.00/d
  «advertising nothing» 2  1        1        1       0           0      €11.00/d
                        ────
                  Σ n = 224 against 220 campaigns

grain=portfolio     n   live      grain=portfolio        n   live
  Auto_FBM_Gale_…   3      2        Misano_Jacket         3      2
  DE_Gale           6      5        Moss_Jacket           7      3
  ES_Gale           6      2        Xavia GALE IT        11     11
  FR_Gale           6      2        IT MOSS JACKET        0      0   ← renders, empty
  IT AIREON        11     11        xyz                   0      0   ← renders, empty
  IT AIRMESH       10     10        «No portfolio»      148     30
  IT_Gale           9      8                           ────
                                                   Σ n = 220
```

### 1.2 Three properties that bite anyone who assumes otherwise

1. **Line rows OVERLAP.** A campaign advertises products from more than one line, so
   Σ(per-line campaigns) = **224** against **220** campaigns. A line-grain total is a
   double-counting total. The page states this at the control and carries it on the row
   (`reachNote`), and **never prints a line-grain sum as an account total**.
2. **Two pairs of lines look like one line and are not.** `AIRMESH-JACKET` (17) vs
   `AIR-MESH-JACKET-MEN` (3); `normal-knee-slider` (6) vs `xavia-knee-slider` (5). This is an
   **open operator decision** (RA ledger). Both render separately with their own counts. **They are
   not merged on a guess.**
3. **Portfolio ⇄ campaign are mutually exclusive; the other three AND.** Verified: every
   `Campaign.portfolioId` in the payload resolves to a portfolio `scope-options` knows
   (0 dangling ids), and a campaign has at most one portfolio, so holding both is redundant or
   contradictory. Exactly as `ruleMatchesScope()` ANDs them.

### 1.3 An aggregate row states fractions, never a boolean

A market does not have a `managed` boolean. `AggregateRow` therefore carries `n / live / managed /
bounded / pinned / delivering / dailyBudgetCents` and a `campaignIds[]`, so any later action can
resolve its own blast radius from the row it was launched from — and a reach preview computed
client-side off `scope-options` can never disagree with what enforcement will do.

---

## 2 · The read — one merged payload, no third endpoint

```
GET /advertising/campaigns?limit=500              identity · status · delivery · budget · strategy
GET /advertising/control-room/guardrail-grid?limit=500   authority: gate · bounds · pins · suppression
GET /advertising/scope-options                     product-line membership, ~220 campaigns
```

Merged on `Campaign.id` — **0 of 220 campaigns missing from the guardrail grid**, measured.

`guardrail-grid` is already read by the Ad Manager and by the Control Room's Guardrails tab,
explicitly *"so they cannot drift apart — they are the same rows."* **This page is the third
consumer, not a fourth author.**

**Everything is fetched once, unfiltered, and every grain is resolved client-side.** 220 rows is
small; the grain aggregates need the whole account anyway; and it makes the `marketplace=all`
trap (§2.1 trap 7) *structurally impossible* rather than merely avoided — no market value ever
reaches the API from this page.

### 2.1 The eight traps, each re-checked

| # | trap | state on 2026-08-12 |
|---|---|---|
| 1 | **no `minMaxBid` key** in the payload | ✅ confirmed — `'minMaxBid' in items[0]` is `false`. `centsToEur` is copied from `CampaignsGrid.tsx:850-856` into `types.ts` so S2/S3 inherit it right. S0 renders no bid column. |
| 2 | **`Campaign.spend` is an unlabelled ~30-day window** | honoured by rendering **no metric column at all**. `types.ts` carries the warning where S4 will read it. |
| 3 | **`deliveryStatus` is volatile** | confirmed. **Measured 10:04 UTC: DELIVERING 81 · NOT_DELIVERING 138 · null 1** — against the brief's 79/140 and its own later 66/…. `status` stable at ENABLED 86 · PAUSED 133 · ARCHIVED 1. Verified against a same-minute read, never against a number in a prompt. |
| 4 | **`cpcCeiling` only when enabled** | not rendered in S0; noted for S7's drawer. |
| 5 | **`accountWideRules` (22) ignores market scope** | confirmed 22. Recorded in the contract as `accountWideRulesIncludesMarketScoped: true` so S6 cannot inherit it silently. |
| 6 | **`GET /advertising/campaigns` is `cached(key, 300)`** | honoured: **5-minute staleness is stated on the page**, not hidden behind a spinner. |
| 7 | **`marketplace=all` matches nothing** | 🔴 **still live.** Probed today: `?marketplace=all` → **HTTP 200, `items: []`, no error.** The param is never constructed on this page. |
| 8 | **`GET /advertising/portfolios` returns `portfolios`, not `items`** | avoided entirely — portfolio names come from `guardrail-grid`'s `portfolioName` and `scope-options`, and this page never calls that route. |

### 2.2 A ninth, which the brief did not name

🔴 **`Campaign.dailyBudget` is in EUROS.** It sits in a payload whose neighbouring money fields —
`minBidCents`, `maxBidCents`, `dailyBudgetCents` on the guardrail row, `trueProfitCents` — are all
**cents**, and its own name carries no unit. Summing it as cents overstates the account by 100×.
Same shape as the action-log-budgets-are-euros trap. This page converts once, at the boundary
(`Math.round(dailyBudget * 100)`), and every field it stores afterwards is named `…Cents`.

---

## 3 · The URL is the single source of truth

```
?market=all|IT|DE|ES|FR     sentinel 'all', never ''     default: the provider's persisted choice
?grain=campaign|portfolio|line|market                     default: campaign
?portfolio=<externalPortfolioId>   ?line=<Product.id>   ?campaign=<Campaign.id>
?q=<text>        ?sort=<col>&dir=asc|desc
?row=<id>        the inspected row      (S7)
?drawer=<name>   a side panel           (S7)
```

One `push()` writes them all; nothing else writes page state. An absent param means its documented
default, never a stored preference — with the one deliberate exception the substrate names
(`market`, which falls back to `AdsMarketplaceProvider`, because a market is a *place you are
working in*).

**`?page=` is deliberately NOT emitted.** `AdsDataGrid` holds `page`, `rowsPerPage` and `search` in
private `useState` with no seed and no callback, so a `?page=` this page wrote could not restore the
view it names. PLC.0 reached the same conclusion; emitting a param that does not round-trip is worse
than not having one. See §7.

---

## 4 · Live-ness — the cursor, and the honest thing to say about it

Not SSE: the ads bus carries **0.21%** of writes, the engines publish nothing to it, and writes are
bursty. `_shared/useCursorPoll` is reused **unchanged** — no fork, identical signature.

🔴 **The brief locates that hook at `bid/useCursorPoll.ts`. It is not there.** BUD.1 promoted it to
`…/rules-automation/_shared/useCursorPoll.ts` when Budget became its second caller. Reuse-as-is is
therefore already the shared path.

🔴 **And this page has no cursor endpoint yet, so the poll cannot fire today — stated, not implied.**
The hook is wired at `GET /advertising/apply-rules/cursor`, which **does not exist**. By the hook's
own rule 3 a failed poll is silent, so today: no banner can ever appear, no error reaches the page,
`lastCheckedAt` stays `null`. `ApplyRulesSlotProps.lastCheckedAt` is the armed signal — **a later
section must not render an "as of" or "live" claim while it is null.** The route AR.S5 (or whoever
first writes) must add returns three fields and only three:

```ts
{ campaignsAt: string | null,   // max(Campaign.updatedAt) in scope
  loggedAt:    string | null,   // max(AdvertisingActionLog.loggedAt) where entityType='CAMPAIGN'
  n:           number }         // row count — neither timestamp moves on a create or a delete
```

Do not copy Bid's or Budget's cursor shape without re-measuring: Bid's measurement rejected the
audit log as load-bearing, Budget's rejected the row timestamp, and this page's subject (the write
gate, the bounds, the pins) moves on a third path again.

---

## 5 · The seam — `apply-rules/slot-contract.ts`

### 5.1 The build order

| # | section | what it adds |
|---|---|---|
| **S1** | population band | replaces `RuleImpactStrip`'s "0 bids adjusted" grain lie |
| **S2** | governance columns | Managed · Bid bounds · Pins — **display only** |
| **S3** | settings columns | Bidding Strategy · Target ACoS · Bid Automation |
| **S4** | performance + time | spend/sales/ACoS/budget/utilisation + the date control |
| **S5** | writes | gate · bounds · pins · the confirm sentence · undo |
| **S6** | automations column | the Managed / Off-limits verdict, engines included |
| **S7** | row drawer | ceilings · write counts · pin note · changes · refusals |
| **S8** | views & export | saved views · column sets · smart search · export resolved ids |
| **S9** | assignment | bind automations at the grain a selection implies |

### 5.2 The exact shape

```ts
export type ApplyRulesGrain = 'campaign' | 'portfolio' | 'line' | 'market'

export interface ApplyRulesScope { market: string; line: string; portfolio: string; campaign: string }

export interface ApplyRulesSlotProps {
  scope: ApplyRulesScope
  grain: ApplyRulesGrain
  rows: CampaignRow[]            // the scope's campaign-grain truth, at EVERY grain
  allRows: CampaignRow[]         // all 220, unscoped — the band's denominator
  aggregates: AggregateRow[]     // [] when grain === 'campaign'
  totals: ApplyRulesTotals | null
  loading: boolean
  error: string | null           // kept, never swallowed — "no rows" ≠ "the fetch failed"
  stale: boolean                 // from the cursor poll
  lastCheckedAt: string | null   // null ⇒ the poll has never succeeded (§4)
  push: (patch: Record<string, string>) => void   // the ONLY writer of page state
  reload: () => void             // S5 onward call it; S0 never does
  row: string | null             // ?row=
  drawer: string | null          // ?drawer=
}

export const NO_WRITE_ACTIONS: ApplyRulesWriteActions = {
  selectionActions: null, onRowAction: null, editMode: null,
}
```

Three deltas from the brief's sketch, each with a reason:

1. **`allRows` added.** S1's band states the account population while the grid is scoped; without
   it every section re-fetches 220 rows to get a denominator.
2. **`error` added.** Substrate §5.6 needs four empty states and one of them is *broke*. A slot that
   cannot tell "0 rows" from "the request failed" renders the wrong one.
3. **`lastCheckedAt` added.** §4 — the armed signal for a poll that cannot fire yet.

### 5.3 Three rules the sections inherit

1. **Hidden, not disabled.** A section whose data does not exist renders nothing. A disabled button
   that will never enable is the same lie as a `Target ACoS` of 30.00% on 220 campaigns that have
   no target.
2. **Every column renders at all four grains.** A column that only makes sense on a campaign row
   must say what it shows on a market row, or it does not ship.
3. **Never render what no executor reads.** Grep for a reader before shipping a control. This page
   exists because five columns failed that test.

### 5.4 Read-only, stated

`NO_WRITE_ACTIONS` is passed **explicitly** into the grid, never omitted. The difference between
*"this page has not got round to writes"* and *"this page does not write"* is the whole of S0's
safety story, and an omitted prop cannot say the second thing. BID.S0's rule, copied with its
reasoning.

---

## 6 · What S0 renders, and nothing more

- **sticky first column** — name · market chip · "Open" link to the Ad Manager
- **Status** — ENABLED 86 · PAUSED 133 · ARCHIVED 1. 🔴 The old grid has **no status column at all**;
  status lives only inside a hover card.
- **Delivery** — `deliveryStatus`, in the payload since forever and rendered nowhere. Paired with
  Status, because they are different facts: **5 ENABLED campaigns are NOT_DELIVERING** today.
  The pairing carries the footgun the substrate names: **resuming a PAUSED campaign does not
  re-allowlist it** — the write is refused at `campaign_allowlist`, and the gate's own comment calls
  that "the intended trade". An ENABLED + NOT_DELIVERING + gate-shut row is exactly the shape that
  should be visible rather than quiet.
- **Managed / Off-limits**, read-only, from `guardrail-grid.managed` — 82 of 220. Measured today:
  **every one of the 82 is ENABLED**, so the gate is open on 82 of the 86 live campaigns and shut on
  all 133 paused ones.
- **an empty state per substrate §5.6** — four, not three, and **a refusal is never rendered as a
  failure and never in the same colour**.

### 6.1 The five legacy columns are NOT carried forward

Verified in a browser across 100 rendered rows: every one returns **one identical value on all 220**
— `Bid Rule "Target ACOS"`, `Target ACoS "30.00%"`, `Min/Max Bid "None"`, `Bid Automation` off,
`Budget Rule "None"`. S3 replaces them with the real fields (`biddingStrategy` is
**LEGACY_FOR_SALES 209 / AUTO_FOR_SALES 11**, re-measured today — a real varying field already in
the payload). **S0 carries none of them.**

### 6.2 The Status filter's placeholder lies — and S0 does not inherit the lie

An unset multiselect is skipped (`AdsDataGrid.tsx:249`) and `initialFilters` is never passed, so the
old grid renders all 220 rows while its Status control's resting label reads **"Enabled"**, inside a
panel that loads collapsed. This page adds **no hidden default filter** and states the population
honestly instead. S1 owns the band; S0's job was not to create the lie S1 would have to undo.

---

## 7 · Could `AdsDataGrid` be URL-bridged without editing it? — **yes, for sort and filters; no, for page and search**

- **Sort ✅** — `onSortChange` exists (BID.S0, additive, gated on the callback). `?sort=&dir=`
  round-trips.
- **Filters ✅** — `onFilterChange` + `initialFilters` exist (same commit). The seed **merges**
  rather than replaces, and the outward emit is suppressed for one tick after an inbound seed.
- **Page 🔴** — `page` / `rowsPerPage` are private `useState` (`:225-226`) with no seed and no
  callback. `?page=` cannot round-trip on any page in this section. **Not emitted here.**
- **Search 🔴** — `search` is private `useState` (`:582`). This page therefore **owns `?q=`
  itself**: its own input in `toolbarLeft`, filtering rows before they reach the grid. The grid's
  own `searchable` is not used, because two search boxes for one fact is the defect that sank the
  scope bar.

**What the shared layer needs, precisely:** `initialPage?: number` + `onPageChange?: (n: number) =>
void`, and `initialSearch?: string` + `onSearchChange?: (q: string) => void`, both gated on the
callback's presence exactly as BID.S0 gated sort and filters — so the ~20 existing grids stay
byte-identical. That is the whole ask. **AR.S0 did not make it**: `AdsDataGrid` is a §3 shared file
and a fifth session editing it this week is how a shared file breaks every session's push.

---

## 8 · Geometry and colour — measured, not eyeballed

Verified on production at `innerWidth 1728` after deploy (numbers in §10).

- **The page gutter inside `.h10-rules-page` is 0, not 24px.** `.h10-hdr`, `.h10-rules-tabs` and
  `.h10-am-card` all sit at **96 → 1698**; `h10-main`'s 30px padding *is* the gutter. `.h10-svt-seg`
  carries `margin: 10px 24px 0` (`rules-automation.css:523`) and is where the 24px pattern gets
  copied from — reusing it required zeroing that margin, or this page's toolbar would sit inset past
  everything else on it.
- **`.h10-am-grid td.nm .t` paints the first column `#1f6fde` at (0,3,1)**, with `cursor: pointer`
  and a hover underline, because every other consumer makes that column a link. This page's name
  cell is **not** a link (S7's drawer makes it one), so it does not use `.t` at all — it carries
  `.h10-ar-nm` and defines its own colour. No specificity fight, no `!important`, nothing for a
  later session to have to delete.
- **The section's link blue fails AA on the page ground.** The ground is `.h10-shell`'s **#f4f6f9**,
  not white; `#1f6fde` is 4.79:1 on white but **4.42:1** there. On-ground links use **#1a61c6**
  (5.33:1 on the ground). `getComputedStyle` reports the declared colour and calls both a pass —
  composite against the real ancestor background instead.

---

## 9 · Everything in the brief that turned out to be wrong

| # | the brief said | what is true |
|---|---|---|
| 1 | *"`bid/useCursorPoll.ts` … its header explains why polling and not SSE"* | The file is **`_shared/useCursorPoll.ts`**. BUD.1 promoted it out of `bid/` when Budget became the second caller. Reused unchanged; nothing forked. |
| 2 | *"tabs.tsx: the rules entry gains `routed: true` pointing at apply-rules"* | 🔴 **Not achievable with the boolean alone.** `rulesTabHref()` builds `${RULES_BASE}/${tab.key}`, so `routed: true` on `key: 'rules'` points at `/rules-automation/**rules**` — a 404. Keeping `key: 'rules'` (which the brief requires, and which is right: two sessions renaming one key in one shared file is the highest-collision change in this programme) needs **one additive optional field**, `path?: string`. No existing tab sets it, so all eleven hrefs are byte-identical. |
| 3 | delivery *"DELIVERING 79 · NOT_DELIVERING 140 · null 1"* | Volatile exactly as warned. **Same-minute read 2026-08-12 10:04 UTC: DELIVERING 81 · NOT_DELIVERING 138 · null 1.** The page compares against its own read, never against a constant. |
| 4 | *(page study §7.1)* *"7 ENABLED campaigns are not delivering"* | **5** today. The point survives; the figure moved, and it moves hourly. |
| 5 | the grain table left IT's and FR's budget blank | **IT €4,275.23/day · FR €1,284.09/day.** Everything else in the table reproduced to the cent. |
| 6 | *"`?page=<n>`"* in the per-page URL vocabulary | Cannot round-trip — `AdsDataGrid` owns pagination privately. **Not emitted.** §7. |
| 7 | *(unstated)* | 🔴 **`Campaign.dailyBudget` is EUROS** among cents-named neighbours. §2.2. |
| 8 | *(unstated)* | `IT-MOSS-JACKET` is the **only** aggregate row in the account where `managed` ≠ `live` (15 vs 19). Any code path that treats the two as interchangeable is wrong on exactly one row, which is the worst number of rows to be wrong on. |
| 9 | *(unstated)* | All **82 managed campaigns are ENABLED** — `managed ∩ ¬ENABLED = 0`. So "82 of 220" is really "82 of the 86 live ones". |

No scratch script was needed: everything above is one browser page-context read of three deployed
endpoints, which is also the read the page itself performs — so the numbers in this document and the
numbers on the page cannot drift.

---

## 10 · Verification — production, in a browser, measured

Web `https://nexus-commerce-three.vercel.app` · API `https://nexusapi-production-b7bb.up.railway.app`

| check | result |
|---|---|
| `grain=campaign` | **220 rows**, count text reads "Viewing 1-100 of 220 Campaigns" ✅ |
| `grain=market` | **4 rows** — IT 150 · DE 38 · FR 22 · ES 10 ✅ |
| `grain=portfolio` | **13 rows** — 12 portfolios + "No portfolio" 148; `IT MOSS JACKET` and `xyz` render n=0 ✅ |
| `grain=line` | **14 rows** — 13 lines + "advertising nothing" 2; Σ = 224 ≠ 220, stated on the row ✅ |
| Status | ENABLED 86 · PAUSED 133 · ARCHIVED 1 ✅ |
| Delivery | read from the API in the same minute and compared against that ✅ |
| governance totals | managed 82 · withMaxBid 82 · withMinBid 0 · pinned 0 · suppressed 0 ✅ |
| aggregate maths | every aggregate row recomputed from the campaign rows equals the grid's own figure ✅ |
| URL round-trip | every param set → reload → identical view; link pasted into a fresh tab renders identically ✅ |
| `marketplace=all` | never constructed — market never reaches the API from this page ✅ |
| geometry | measured against `.h10-am-card` with `getBoundingClientRect()`, no horizontal overflow ✅ |
| contrast | 0 failures across every text element, composited against the real ancestor background ✅ |

*(Filled in from the post-deploy probe — see the closing section of this document.)*

---

## 11 · What S0 did not touch

`RulesAutomationClient.tsx` (the index keeps its `rules` branch and keeps working — whether the bare
route eventually redirects is an open operator decision and is not this session's) ·
`AdsDataGrid.tsx` · `AdsPageHeader.tsx` · `MarketSelect` · `schema.prisma` · `next.config.js` ·
any route · any other page under `…/rules-automation/*`, `…/ads-console/*` or `apps/web/src/app/fleet/*`.

Two shared files, both claimed in the locks doc §2 and both strictly additive:
`_shared/tabs.tsx` (one `routed`, one `path`, one subtitle, one line in `rulesTabHref`) and
`rules-automation.css` (appended at EOF, every class prefixed `h10-ar-`, no `.dark` block).
