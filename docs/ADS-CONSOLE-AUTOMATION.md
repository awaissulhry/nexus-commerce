# Ads Console — Automation Suite

Operator guide for the advertising automation suite at
**`/marketing/ads-console/automation`**.

The suite turns Amazon Ads management into a set of always-on rules that watch
live campaign data and act for you — bidding, budgeting, harvesting, negating,
defending rank, guarding retail-readiness, and more — inside guardrails you set.
It is a standalone console (no Nexus chrome) and renders entirely on **live
data**; there is no mock content.

---

## 1. Core model — distinct, configurable automations (not threshold twins)

The Library holds **distinct automations**: each is one concept (e.g. "Cut bids
on high ACOS", "Harvest & negate", "Floor bids on profit breach"), not many
near-duplicate copies of the same idea at different thresholds. Every automation
exposes its own parameters, so one template covers unlimited variations through
configuration rather than duplication.

- **Library** — browse/search/sort all automations; filter by category; bulk-add
  several at once.
- **Configurator** — tune an automation's parameters with a live plain-English
  preview of exactly what it will do, then create it.
- **Rule Builder** — compose a fully custom rule from scratch (trigger +
  conditions + actions) when no template fits.

Every automation maps onto the engine's real vocabulary (see §8). The catalogue
covers **all** supported engine actions across every supported trigger.

## 2. Safety model — nothing acts without your say-so

- Anything created from the Library, a Playbook, the Composer, or Rank Control
  is created **disabled + dry-run**. It will not spend or change anything until
  you enable it and switch it from Dry-run to Live in **Active rules**.
- **Dry-run** evaluates and logs what the rule *would* do, with no write to
  Amazon.
- Per-rule **max executions per day** and **max daily ad-spend** caps bound the
  blast radius.
- **Guardrails** tab — account-wide autonomy level, global thresholds, and a
  **kill-switch** that halts all automation immediately.
- Switching a rule to **Live** is a deliberate, explicit action (with a confirm).

## 3. Active rules — operate the fleet

- Search, and quick-filter by **All / Live / Dry-run / Off**.
- Per-rule: enable/disable toggle, Dry-run⇄Live toggle, **Test** (evaluate
  against current data), delete, and inline observability — **matches** count and
  **runs** count with a relative last-run time.
- A **per-trigger effectiveness rollup** groups rules by trigger with rule count,
  total runs, matches, and an "% acted" (runs ÷ matches) rate. Click a trigger to
  filter the list to it.
- **Bulk actions**: select rules (or Select-all) → Enable / Pause / Dry-run /
  Set live / Delete in one go.

## 4. Playbooks & the Composer

- **Playbooks** — one-click strategy bundles (Profit Autopilot, Margin Defender,
  Aggressive Growth, Waste Eliminator, Launch Mode, Inventory-Safe, Tight Budget,
  Set & Forget Lite). Activating a playbook creates all its automations at once
  (still disabled + dry-run).
- **Composer** — a drag-and-drop canvas: drag automations from the palette into
  an ordered strategy stack, reorder by dragging, then activate the whole stack.
  Save any stack as a **custom playbook** (stored locally) and re-activate it
  later from the Playbooks tab.

## 5. Rank Control — where, how hard, when, which market

Pick the slot you want to win and the engine bids to take and defend it:

1. **Market** — a single EU market or all markets.
2. **Where** — Top of search / Product pages / Rest of search.
3. **How hard** — Defend / Aggressive / Dominate (placement multiplier + a
   rank-defense bid step).
4. **When** — All day / Business hours / Evenings / Custom (day-of-week chips +
   hour range). The chosen window **biases your Dayparting schedule** (merged up,
   never lowered) so the push lands in the hours you choose.

Optional: a max €/day ceiling, and a "boost shoppers who viewed the product page"
toggle (runs via Sponsored Display view-remarketing **where your account supports
it**). Amazon is an auction — Rank Control targets and defends a slot maximally;
it cannot literally pin a fixed position.

## 6. Dayparting

A 7×24 hour-of-week grid with **drag-to-paint** bid modifiers (−50% … +50%),
live day-of-week performance intel with bid-up/keep/bid-down recommendations,
presets (business hours / evenings / weekends-off / always-on), **Run now**, and
save-as-schedule.

## 7. Analytics, intelligence & reports

- **Analytics** — KPIs, automation-posture chart, spend/sales trend, action
  leaderboard, CSV export.
- **Efficiency** — CPC / CPA / CVR / AOV / ROAS with deltas and trend charts.
- **Competitive (Share of Voice)** — SoV by query with cannibalisation flags.
- **Harvest** — search terms to graduate to exact keywords + wasteful terms to
  negate, with one-click apply.
- **Negative mining** — wasted-spend terms with bulk-negate.
- **Anomalies** — trend-based anomaly detection.
- **Retail readiness** — stock / Buy Box health that should gate ad spend.
- **Budgets** — monthly budget plans with pacing.
- **Health** — automation health + activity log.

Most analytical tabs share **dynamic controls**: a market selector and a date
range (presets or custom start/end). Competitive, Negatives and Harvest tables
export to **CSV**.

## 8. Navigation references

Where an insight relates to a campaign, it links straight to that campaign's
cockpit (`/marketing/trading-desk/campaigns/:id`), and the market is shown
alongside. Harvest, Negative mining, Competitive and Recommendations all carry
these references. (Ad-group ids are shown for context; there is no standalone
ad-group page to link to.)

## 9. Engine vocabulary (what rules are built from)

**Triggers** (when a rule evaluates): scheduled cadence plus event/metric
triggers such as ACOS spike, CVR drop, wasted spend, zero impressions, low CTR,
underperforming target, profitability breach, performance/budget, price change,
and inventory signals. The E-series expansion added five more: high-ACOS
keyword (converts but inefficiently), keyword scale-opportunity (proven winner
with headroom), ad-group underperforming (coarser lens), new-to-brand winner
(campaigns acquiring new customers), and campaign-no-sales (dead spend). Each
new trigger's context-builder is fault-isolated and inert until a rule uses it.

**Actions** (what a rule does): bid up / bid down / bid to target ACOS / lower
to floor / raise for rank defense / scale for price change; adjust or set daily
budget; set target ACOS; pause or resume campaign / ad group / all campaigns;
enable campaign; add negative exact; promote to exact; harvest & negate; sync
negatives across campaigns; set placement multiplier; reroute marketplace
budget; archive keyword; retail guard; liquidate aged stock; create Amazon
promotion; alert operator; notify.

## 10. Recommendations

The **Recommendations** tab surfaces engine-generated opportunities with an
estimated €/month impact. Apply one, **bulk-apply selected**, or **apply all**;
each applies independently so one failure cannot abort the batch, and the result
("Applied N · M could not be applied") is reported. Where a recommendation
targets a campaign, it links to it.

## 11. Going live safely (recommended flow)

1. Add automations from the Library (or a Playbook / Composer stack). They start
   **disabled + dry-run**.
2. Open **Active rules**, **Test** each rule against current data; review matches.
3. Enable a rule while still in **Dry-run**; watch its matches/runs accrue.
4. When confident, switch it to **Live**. Keep a daily-spend cap on first.
5. Set account-wide **Guardrails** (autonomy + kill-switch) as your backstop.

---

*UI conventions: standalone Amazon-styled shell, no emoji, no horizontal page
scroll (the tab bar wraps), live data end-to-end. The Amazon-flat-file editors
and the trading-desk campaign cockpit are separate surfaces and are not modified
by this suite.*
