---
name: order-desk
description: Run the daily order desk in Nexus - what must ship today, what is late, shipments waiting for a label, tracking that did not reach the channel, and returns whose refund is near the 14-day limit - then prepare the work (shipments, labels, confirmations, notes, invoice numbers) as requests a person approves. Use when the person asks what to ship, what is late or overdue, about the order queue, shipping labels, tracking, or refunds that are due.
---

# Order desk

Buyers are shown masked (first name, city, country, masked e-mail): never ask for or guess an address, phone or e-mail. Orders Amazon ships (FBA or Multi-Channel Fulfilment) are read only: Nexus never ships, cancels or labels them.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. The desk today

- `order-report` (`kind: "orders"`): orders by status, channel and market, to ship and late. `kind: "shipping"`: the queue by urgency, shipments and tracking uploads. `kind: "refund-deadlines"`: received returns against the 14-day refund rule. `kind: "sync-health"`: the newest order per channel (is each channel's order sync alive?).
- `shipping-queue` (`urgency`: OVERDUE, TODAY, TOMORROW, …; `channel`, `marketplace`): orders still to ship, most urgent first; Amazon-shipped orders are counted apart.
- `order-search` (`status`, `channel`, `shipByBefore`, `search`) and `order-detail` (`orderId`) for one order: lines, shipments and tracking, returns, invoice, timeline.
- `shipment-detail` (`shipmentId`) for a label or tracking problem; `shipping-rates` (`shipmentId`) for what a label would cost (reads, buys nothing).

Report in a few lines: overdue (how many, oldest), due today, waiting for a label, tracking not uploaded, refunds due in the next 3 days (see `handle-return`), and whether any channel's orders stopped coming in.

## 2. Prepare the work (only when asked)

| To | Tool |
|---|---|
| Make shipments for orders | `create-shipments` (`orderIds` up to 200; routing and shipping rules choose unless a warehouse or carrier is named; no label bought) |
| Hold, release, cancel a shipment, or set its service | `update-shipment` |
| Buy labels | `buy-shipping-label` (`shipmentIds`; costs money in live mode: the preview gives each price, the total, and live or dry run) |
| Void a label that has not left | `void-shipping-label` |
| Mark shipped with tracking | `confirm-shipment` (uploads tracking to the channel; cannot be undone) |
| Book a carrier pickup | `schedule-pickup` |
| Note, tag or mark delivered | `update-order` |
| Read new orders now | `sync-orders-now` (`channel`: AMAZON or EBAY; at most once per channel every 10 minutes) |
| Cancel an order that has not shipped | `cancel-order` (`reason`; on the channel too — a live cancel refunds the buyer; cannot be undone) |
| Number invoices and credit notes | `issue-fiscal-document` (`orderIds` / `refundIds`; numbers are permanent; refused while company details are missing in Settings › Company) |

- Group the day's work in ONE `submit-change-plan` where the steps do not depend on each other (for example shipments for 30 orders + notes). A label can only be bought for a shipment that exists: shipments first, labels after they ran.
- Show the money before asking: label totals per carrier, live or dry run.
- Messages to buyers: `buyer-message`. Returns and refunds: `handle-return`.
- Etsy tracking reaches Etsy only when the server's Etsy ship-confirm switch is on; otherwise the preview says nothing is sent.
