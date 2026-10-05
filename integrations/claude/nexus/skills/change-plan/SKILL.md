---
name: change-plan
description: Bundle many Nexus changes into ONE change plan that a person approves once in Nexus (up to 200 steps - prices, text, stock counts, bids, tags, listings, anything with a Nexus change tool) - gather the facts, show the whole plan, ask, submit it with submit-change-plan, then follow each step with approval-status. Use when the person wants several changes at once ("do all of these", "fix these 40 listings", "apply this list"), or when another Nexus skill ends with more than one change.
---

# Change plan

One plan = one request = one card on the Nexus Approvals page, however many changes it holds. Every step is checked now, as the person, exactly as if it were asked for alone. Nothing changes until the plan is approved (or runs by the business's rule, when every step may).

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Gather the steps

- Read before you write: each step must rest on what Nexus holds now (the product, its current value, the listing's coordinate, the version of a purchase order). Use the read tools the other skills name.
- A step is `{ tool, args }`: the change tool's name and its own arguments **without** `business` (the plan names the business once). Read each tool's description for its exact arguments.
- Only change tools can be steps. Reads, `submit-change-plan`, `undo-change` and `confirm-change` cannot.
- Prefer one bulk step over many single ones: `bulk-price-change` / `set-master-prices` (250 products), `bulk-attribute-change` (250), `bulk-content-change` (25), `set-brand` (250), `set-stock` (250 rows), `bulk-ad-bid-change` (250 targets), `close-listing` (250 listings). A bulk step counts as one step.
- **Steps cannot wait for each other.** Each one is checked against Nexus as it is now. A step that needs an earlier step's result cannot be in the same plan: a new product's id, a draft listing not created yet, text a publish should send, a purchase order to send that is still being drafted. Ask for the later step after the earlier one has run.
- Up to 200 steps. More: split into several plans and say so before you send the first.

## 2. Show the plan, then ask

- A title a person understands on the Approvals page ("Raise helmet prices 5% and fix 12 titles").
- A table, one row per step (or per group of alike steps): what it changes, from → to, how many items, where it lands (Nexus only, a marketplace, a buyer, a supplier).
- Totals per kind ("120 price changes reach Amazon and eBay; 12 title changes stay in Nexus").
- Which steps cannot be undone (a message sent, a refund, a cancelled order, a confirmed shipment, a numbered invoice, a sent purchase order, a new campaign) — say so plainly.
- Then ask: "Shall I send this to Nexus as one plan for <business>?"

## 3. Submit it

`submit-change-plan` with `business`, `title` and `steps`.

- If any step is refused, **nothing** is stored. The answer lists each refusal (`refusals`: step, tool, error). Fix or drop those steps, show the changed plan, and ask again.
- Stored: `status: "waiting_for_approval"` with `plan` (how many steps, the summary Nexus wrote, `planHash`), or `runs_by_rule` when the business lets every step run by its rule, or a `confirm` part when it is set to "confirm in Claude".
- On the Approvals page a person can untick steps; the plan is then replaced by a smaller one (`approval-status` says `superseded`).

## 4. Follow it

`approval-status` with the plan's `approvalId`:

- `meaning` in plain words; `plan.byStatus` counts the steps; `plan.list` gives each step's status (done, skipped with its reason, failed) and its `changeId`.
- A skipped step: the facts moved between the approval and the run (someone changed the value, a listing's review changed). Read it again and, if still wanted, ask for that one step again.
- A failed step: pass on its reason; the other steps went on.
- To put the whole plan back: `undo-change` with the plan's `approvalId` (see `review-and-undo`).

Report in a few lines: the plan's title, the `approvalId`, how many steps, and the `approveAt` link once.
