---
name: reorder
description: Reorder stock in Nexus - read what needs reordering and from which supplier, draft the purchase orders, then submit, approve and send each one as its own request a person approves (sending e-mails the supplier and commits the spend), and receive the goods when they arrive. Use when the person asks what to reorder, to restock, to draft or send a purchase order, about suppliers, or about goods arriving.
---

# Reorder

Suggest, draft, approve, send — then receive. A draft goes nowhere. Sending a purchase order e-mails the supplier and commits the money: it is one request per PO, never automatic, and cannot be taken back. Supplier costs and PO totals show only to a person who may see them.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. What needs reordering

- `replenishment-suggestions` (`urgency`: CRITICAL, HIGH, …): per product how much and when, days of stock left, sales per day, lead time, Amazon's own restock number; with `productId`, its suppliers ranked for this order and when it runs out.
- `replenishment-forecast` (`productId`), `stock-levels` (`productId`) and `fba-inventory` for the detail. FBA stock is Amazon's number: read only.
- `supplier-search` (`supplierId` for one: products, cost, MOQ, case pack, lead time, recent POs) and `purchase-orders` (`status`, `supplierId`, `lateOnly`) for what is already on order.

Show per supplier: products, suggested quantities (rounded to MOQ and case pack), expected arrival, and the total when visible. Ask which to order.

## 2. Tidy the suggestions (optional)

`replenishment-action`: dismiss or restore a suggestion, choose a product's `preferred` supplier, link a `substitute`, or set the cash on hand. Supplier details and prices: `upsert-supplier` (a supplier is switched off, never deleted).

## 3. Draft

`draft-purchase-order`: a new PO for a `supplierId` from `lines` (`productId`, `quantity`, optional `unitCostCents`) or `fromSuggestions: true`; or change a DRAFT (`purchaseOrderId` + the `version` you read). Several suppliers: ONE `submit-change-plan` with one draft step each.

## 4. Submit, approve, send — one PO per request

After the draft ran, read it with `purchase-orders` (`purchaseOrderId`) for its id, total and `version`, show it, and ask. Then `advance-purchase-order` (`purchaseOrderId`, `transition`, `version`):

- `submit-for-review` (straight to approved when no approval is needed and the total is under the threshold), `approve`, `send` (e-mails the supplier with an acknowledgement link), `acknowledge` (the supplier confirmed).
- Each transition is its own request and its own card: the card shows the supplier's e-mail, the total and currency, and whether the e-mail really goes out. Never put several POs' sends in one plan.
- A PO not yet sent can be cancelled: `cancel-purchase-order` (`reason`). A sent PO is cancelled with the supplier.

## 5. When goods arrive

- `inbound-shipments` (`query`, `status`, `delayedOnly`) for what is on the way; `update-inbound-shipment` for reference, carrier, tracking, expected date, costs or status.
- `receive-stock` (`shipmentId` or a sent `purchaseOrderId`, `lines` with `qc` PASS / HOLD / FAIL): units that pass go into stock; never more than still expected. A shortage or damage: `action: "report-discrepancy"`.
- Landed cost: `set-product-costs` with the received `purchaseOrderId`.

Sending stock into Amazon FBA: `plan-fba-shipment` creates the plan at Amazon (no quantity changes anywhere); `fba-shipment-options` reads packing, placement and transport with Amazon's fees; confirming them stays a person's click in Nexus.
