---
name: ads-playbook
description: Build and run a product's Amazon Sponsored Products ads from its playbook in Nexus, one product in one market at a time - read the playbook (ads-playbook - templates, what a product follows, the dry run of a build, the builds, and, where Nexus offers them, the phase check, drift and winners), keep templates and playbook rows (set-ads-playbook - capture a template from campaigns that run, include a product with its terms, budget and base bid), and apply it (apply-ads-playbook - build through the SP Super Wizard's own launch, born at the floor and off the live-write allowlist; adopt campaigns the product already runs; start with the approver's authenticator code; stop with low bids; and, where Nexus offers them, switch phase, sync drift by adding only, and give a winning term a campaign of its own). Goals & limits are the ads strategy (the ads-strategy skill); the playbook is how the ads are built and run. Use when the person wants to include a product in a playbook, build or adopt its campaigns, start or stop them, move a product to another phase, see or fix where its ads drifted from the playbook, look after its winning search terms, or make a template from campaigns that run.
---

# Ads playbook

Nexus keeps a product's Amazon ads in two halves, per market, and per category or product inside a market:

- **Goals & limits** — the ads strategy: what to aim at and how far the engines and Claude may go (goal, target, monthly cap, bid limits, harvest and negate thresholds, what Claude may do alone). Read it with `ads-strategy`; changing it is the `ads-strategy` skill. Every number the engines obey lives there.
- **Playbook** — how the ads are built and run: the campaign set (slots: Auto; brand, competitor and category keywords by match type; product targeting), names and portfolio, how the product's daily budget splits, start bids, placements, how winning search terms flow between campaigns, the negatives that keep the product's own campaigns apart, the playbook's own hourly bid plans per rank role, and the phases.

A **template** is made once and reused. A **playbook row** for a market, a category or a product names a template and replaces whole parts of it; the most specific wins (the product, then its parent, then its deepest primary category, then the market, then the template). A product is in only when its own row says **enrolled**: a category or market row is a default for the products under it, never a build. A playbook does nothing by itself: no engine reads it, and it reaches Amazon only through an approved `apply-ads-playbook`.

This file holds steps only. Every number (budgets, bids, targets, thresholds, money) is read from Nexus. Amounts are minor units of each market's own currency: never convert, never add markets together.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids, never an FBA quantity. Follow them. Read `business-overview` for the exact market codes before you name one.

- **Build only with Nexus's own builder.** A playbook's campaigns are built by `apply-ads-playbook`, through the SP Super Wizard's own launch: never piece by piece with `create-ad-campaign`. A build is born at Amazon's 2-cent floor (its planned bids remembered), off the live-write allowlist and without placements: it serves next to nothing until START.
- **START is real spend.** It always needs the approver's authenticator code: in Nexus, or, where the business set it to confirm in Claude, the person who asked confirms it with `confirm-change`. Never guess, store or reuse a code. A campaign a playbook built, or one its STOP holds, gets its bids back only through START: `restore-campaign` refuses it.
- **A stop is low bids.** STOP lowers bids to the floor and takes the campaigns off the allowlist. Never pause or archive as a tactic. The undo of a build archives its campaigns for good (`archive-ads`): to stop spending, STOP instead.
- **Winning search terms stay where they win.** A term that converts where it runs is never negated there and never moved. When it declines: its bid first, then its campaign's placements, and only then a campaign of its own. Once that campaign proves itself, the term's old exact keyword is lowered to the floor bid by a proposal (`bulk-ad-bid-change`, a person approves it), never negated.
- **Isolation is per product only.** The negatives that stop campaigns bidding against each other go only inside one product's own campaigns. Two products may buy the same keyword: never negate or skip a term because another product buys it.
- **The Owner's own hourly bid plans are his.** The playbook's own hourly plans switch on and off only with its START, STOP and phase switch. An hourly plan the playbook did not make is never touched; a campaign it holds is reported, never changed.
- **Never change an Amazon FBA quantity.** Stock problems lower bids.
- **Adopting a live campaign set is the Owner's call.** Capturing a template from campaigns that run, and binding them to a product's slots, sends nothing to Amazon, but it decides how they are run from then on. Ask the Owner first, name the campaigns, and wait for his yes.
- **What Claude may do alone** is the strategy's `claude` level per kind, where the change lands: a build or a campaign of its own counts as `create`, a start as `restore` and `allowlist`, a stop as `stop`, a phase switch as `phase`; a sync runs by rule only as the negatives it adds (`negative`). An adopt is Nexus only. A raise never runs by rule unless the business allowed it with its code (the tool's limits say).
- **Where Nexus offers it.** Phase switches, drift and sync, and winners with campaigns of their own come in steps. If `ads-playbook` refuses a view or `apply-ads-playbook` refuses an op, say so in plain words and carry on with what there is.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason and carry on with the rest.

## 1. Read

1. `ads-playbook` `view: "templates"`: the templates, their status (DRAFT, ACTIVE, RETIRED) and version; with `templateId`, one template's whole doc.
2. `ads-playbook` `view: "rows"` (`market`): every playbook row of the market, each with its version.
3. `ads-playbook` `view: "effective"` (`market`, and `productId` or `sku`; or `categoryId`; or the market alone): every part with the row or template it came from (`source`), enrolled, state (DRAFT, BUILDING, BUILT, RUNNING, STOPPED), terms, daily budget, base bid, phase recipes, the slots, the links (which campaign plays which slot), why it cannot compile yet, and the ads strategy in force beside it (its goal is the phase). Where Nexus offers it, `phaseCheck` too (6).
4. `ads-playbook` `view: "compile"` (`market`, product): the dry run of a build — every campaign, ad group, keyword, negative, product ad, budget and start bid it would create, the terms the product's own other campaigns already buy (skipped or accepted, as the template says), the terms other products buy too (kept, only listed), the monthly caps, the portfolio and the gate's blockers. Nothing is created.
5. `ads-playbook` `view: "build"` (`market`, product; or `applicationId`): the builds, their progress, the campaigns each made, what failed, what START will apply.
6. `ads-playbook` `view: "history"`: the recorded changes of a template or a market's rows.
7. `ads-strategy` (`view: "effective"`, the market and the product): the numbers in force.

Show per product and market: enrolled, state, template and version, phase, each slot with its campaign (or missing), and what a build would make. A person without the ad-spend money permission sees no budgets, bids or targets: say so.

## 2. Make a template from campaigns that run

1. Ask the Owner first (see the ground rules). Then ask which campaigns: their ids (`campaignIds`, from `ad-campaigns`), an Amazon `portfolioId`, or a `namePrefix`; the `market`; the product's token in the campaign names (`productToken`); rival brand words (`competitorTokens`) where the names do not say.
2. `ads-playbook` `view: "capture"` with the same: the slots, naming, budget shares, bid ladder, placements, hourly plans by rank role and the product's terms it would hold. Nothing is saved. Show it with its warnings.
3. On his yes: `set-ads-playbook` `kind: "template"`, `op: "capture"`, the same arguments and a `name`. Nexus only.
4. Later edits: `set-ads-playbook` `kind: "template"`, `op: "set"`, `templateId`, with `sections` (each replaced whole) or `status`. A template reaches every product that follows it: say how many (`affects`). Remove one only while no row names it; else retire it (`status: "RETIRED"`).

## 3. Include a product

1. Read `view: "effective"` and `view: "compile"` for the product in the market.
2. Its product row: `set-ads-playbook` `kind: "playbook"`, `level: "product"`, `market`, `productId` or `sku` (a parent covers its variations), `values`: `templateId` (or inherit it), `nameToken`, `portfolioName` (no "·": Amazon refuses it), `dailyBudgetCents`, `baseBidCents`, `terms` (brand, category with its exact-at-start marks, competitor, competitor ASINs, negatives), `overrides` (whole sections; `skipSlots` for optional slots it leaves out). Ask the person for each value; never offer numbers of your own as theirs.
3. Enroll: `set-ads-playbook` `op: "enroll"`, only once the playbook compiles. Its phase recipes are made absolute from the product's break-even ACoS, the market's target and its base bid: the preview says from what. Enrolling is a raise: it is approved with the authenticator code.
4. Out again: `op: "leave"`. Nothing at Amazon moves: campaigns it built stay as they are (STOP them first if they should not spend).

- Pass `expectVersion` from the read. The preview lists every change from → to and names what raises (`raises`, `stepUp`).
- Category and market rows (`level: "category"` with `categoryId`, or `"market"`) are defaults only: they never enroll.

## 4. Build or adopt

**Adopt first** where the product already runs campaigns that could play its slots, then build only what is still missing.

Adopt (ask the Owner first):
1. `apply-ads-playbook` `op: "adopt"`, `market`, product, `bind` (`[{ slot, campaignId }]`) for the campaigns you name; the rest are matched by name, then by shape. The preview lists the bindings, `ambiguous` (name one with `bind`), `outside` (campaigns that play no free slot: left as they are) and `empty` slots.
2. Nexus only: no bid, allowlist or rule changes. The playbook's own hourly plans follow the slots, switched off until START; a campaign another hourly plan holds is never moved into them.
3. Undo is the opposite adopt (`unbind`).

Build:
1. Show `view: "compile"` per slot.
2. `apply-ads-playbook` `op: "build"`, `market`, product, optionally `slots` (only these missing ones), `expectVersion`, `why`. The preview gives each campaign, the daily budget in all, the product ads, the portfolio, the compiled parts (harvest rule, isolation rule, hourly plans: off until START), `reach` (live or sandbox) and the limits. Refused, and not queued, when the product is not enrolled, nothing is missing, the gate refuses it, or a build of it is running.
3. Once approved it runs on its own: read `view: "build"` with its `applicationId` once later, never in a loop.

## 5. Start and stop

- **START** — `apply-ads-playbook` `op: "start"` (optionally `slots`): the built campaigns go on the live-write allowlist with their planned bids back (never above what was planned; a bid moved since, an engine's floor and an ad group's own floor stay), the placements the build held back, then the playbook's own hourly plans and rules switched on. A campaign paused at Amazon stays paused; an adopted one is left as it is. Show what starts spending (`spends`, `stepUp`): the approver's code, every time, unless the business set a start to run by its rule (with its code).
- **STOP** — `op: "stop"`: the built campaigns' bids to the 2-cent floor (remembered) and off the allowlist, the playbook's hourly plans and rules off; the floors an hourly plan set stay, held by the stop. No code: it lowers spend. Never a pause, never an archive: a START brings it back in about a minute.
- Undo: a start is undone by a stop, a stop by a start (with the code again).

## 6. Phases (where Nexus offers it)

The phase is the strategy's goal: LAUNCH, GROW, PROFIT, CLEAR_STOCK or DEFEND.
1. Read `phaseCheck` in `view: "effective"`: the phase and since when, the hold (the least days in a phase), each exit rule with its numbers, and the move Nexus proposes (`proposal`). A number Nexus cannot measure is null and its rule is not met. Organic rank is not measured: DEFEND starts and ends on the Owner's word.
2. `apply-ads-playbook` `op: "phase"`, `phase`, optionally `rankFloors` (`keep`, the default, or `giveBack`, a raise). The preview gives the strategy row's changes field by field with raise or lower, each slot to the floor or back, the playbook's hourly plans on, off or light, the harvest cadence, and `direction`. Anything that adds spend makes the whole switch a raise: the approver's code. A move Nexus does not propose, or one inside the hold, is the person's own: say so.
3. Switch an enrolled product's phase here, not with the strategy's goal alone: the switch carries the phase's numbers, slots, hourly plans and cadence together. Undo switches back to the phase before.

## 7. Drift and sync (where Nexus offers it)

1. `ads-playbook` `view: "drift"` (`market` alone: every enrolled product counted; with the product: its items). Each item has a `key`, what it says, and its `fix`: `sync`, another tool, or none. Bids and budgets the engines moved are not drift, and neither are the Owner's own hourly plans. `heldBack` lists what is left alone on purpose (a winning term, a protected term); `notChecked` what Nexus does not check.
2. `apply-ads-playbook` `op: "sync"`, `fix` (item keys; by default every item sync fixes that no person made himself). It only adds: never deletes, archives or pauses. Negatives (they lower spend) may run by the business's rule; keywords, product targets and product ads (added at the floor, their bids at START), missing slots (built as a build builds them) and compiled parts saved again wait for a person.
3. **A change a person made himself** (`byPerson`) is never put back silently. Show it and ask: **keep** it (`set-ads-playbook` with the item's `keep`: into the product's playbook row) or **revert** it (`op: "sync"` with its key in `revert`).
4. An item another tool fixes: that tool, as the item names it, once the person agrees. A campaign outside every slot is listed only; adopting it is the Owner's call.
5. Undo of a sync retires the negatives it added (`undo-ad-change`); a slot it built is archived only with `archive-ads`.

## 8. Winners (where Nexus offers it)

1. `ads-playbook` `view: "winners"` (`market`, product): the product's search terms in its own campaigns — `winning` where they run (kept, nothing proposed), `declining` or `lost` — each with its `nextStep`, judged on the strategy's harvest bar and the target auto-bid steers by.
2. The next step, in the Owner's order:
   - `bid`: auto-bid already moves its bid toward the target. Nothing to ask.
   - `placement`: `set-placement-multipliers` on its campaign. It is a campaign setting: the entry says how many other terms it touches.
   - `ownCampaign`: `apply-ads-playbook` `op: "hero"`, `term` — one campaign with one exact keyword, born like a build (at the floor, off the allowlist). The term keeps running where it runs now. Once that campaign proves itself, the term's old exact keyword is lowered to the floor bid by a proposal (`bulk-ad-bid-change`, a person approves it), never negated. START with `slots: ["hero:<term>"]` makes it spend (the code). One per term, product and market.
   - `none`: an hourly plan or a performance slot holds its campaign: report it only.

## 9. After

`approval-status` per request; then read again (`view: "effective"`, `"build"`, `"drift"`) and show the new state. The daily and weekly ads run is `ads-daily-manager`; targets and limits are `ads-strategy`; what Claude changed and undo are `review-and-undo`.
