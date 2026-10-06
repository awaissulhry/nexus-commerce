---
name: handle-return
description: Handle a return in Nexus from request to refund - open the return, authorize or reject it, receive and inspect it, restock or scrap the items, refund the buyer within what is still refundable, and number the credit note - each step a request a person approves, refunds always by a person. Use when a buyer wants to return something, a return arrived, a return needs inspecting or restocking, or a refund is due.
---

# Handle a return

A return moves step by step: REQUESTED → AUTHORIZED → RECEIVED → INSPECTING → RESTOCKED or SCRAPPED, and the refund on its own. Each step needs the one before it to have run, so each is its own request. Returns of orders Amazon ships (FBA) are handled by Amazon: Nexus only reads them.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

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
