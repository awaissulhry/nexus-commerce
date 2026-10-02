---
name: handle-return
description: Handle a return in Nexus from request to refund - open the return, authorize or reject it, receive and inspect it, restock or scrap the items, refund the buyer within what is still refundable, and number the credit note - each step a request a person approves, refunds always by a person. Use when a buyer wants to return something, a return arrived, a return needs inspecting or restocking, or a refund is due.
---

# Handle a return

A return moves step by step: REQUESTED → AUTHORIZED → RECEIVED → INSPECTING → RESTOCKED or SCRAPPED, and the refund on its own. Each step needs the one before it to have run, so each is its own request. Returns of orders Amazon ships (FBA) are handled by Amazon: Nexus only reads them.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

- `return-search` (`status`, `channel`, `refundStatus`, `fba`, `search`: RMA, order number or SKU): each return with its lines, refunds, label and tracking, and its order (buyer masked).
- `order-detail` (`orderId`): the order's lines (`orderItemId`), what it paid and what was refunded.
- `order-report` (`kind: "refund-deadlines"`): received returns against the 14-day refund rule, so the nearest deadline goes first.

## 2. The steps

| Step | Tool |
|---|---|
| Open a return for a shipped order | `create-return` (`orderId`, `items`: `orderItemId` + `quantity`, `reason`, `returnType`: STANDARD, WARRANTY or DEFECT). Nexus only; the buyer and the channel are not told. |
| A prepaid return label | `buy-shipping-label` (`returnIds`; Sendcloud; costs money in live mode) |
| Authorize or reject; it arrived; inspect; warranty diagnosis | `update-return` (`returns`: each with `action` authorize, reject, receive, inspect or warranty; inspect grades each item NEW, LIKE_NEW, GOOD, DAMAGED or UNUSABLE). No stock moves and no money moves here. |
| Put items back in stock, or scrap them | `dispose-return-items` (`action`: restock or scrap; only after inspection; NEW, LIKE_NEW and GOOD go back, to the shared stock the order took them from when it did). Cannot be undone from Claude. |
| Refund the buyer | `issue-refund` (`returnId`, `amount` in the order's currency, `reason`) |
| Number the credit note | `issue-fiscal-document` (`refundIds`, each POSTED; numbers are permanent) |
| Tell the buyer | `buyer-message` skill |

Several returns at the same step: ONE `submit-change-plan` (`update-return` already takes up to 20 returns in one step).

## 3. Refunds

- Always a person's approval in Nexus: never by rule, never confirmed in Claude. Money leaves the business and it cannot be undone.
- Capped at what is still refundable on the order (what it paid less its refunds); one refund per return.
- eBay refunds are live. Shopify refunds only when Shopify's refund switch is live (in dry run the request is refused). Amazon refunds are made in Seller Central: say so and stop.
- Show before asking: the order, what it paid, what was refunded already, the amount now, the currency, and the deadline.
- If the return or the order changes before the approval runs, nothing is refunded: read again and ask again.
