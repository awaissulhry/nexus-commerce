---
name: factory-desk
description: Daily desk for the Nexus factory app - late and urgent orders, the quote pipeline, work orders in production and what blocks them, materials running short, shipments, open inbox threads and (with permission) the money - then, when asked and when the connection may draft, prepare drafts the Owner finishes in the factory app (a DRAFT quote, a DRAFT purchase order, an internal comment, one work-order stage step). Use when the person asks how the factory is doing, what is late, what to produce or order, about quotes, materials, shipments or the factory inbox.
---

# Factory desk

Works with the factory's own local server (`nexus-factory`), on the factory machine only. The connection acts as one factory user, chosen when its token was made, and sees only what that person may see: prices, costs and margins only with their permission. Nothing leaves the factory from here: sending a quote or a purchase order, converting a quote, buying labels, invoices and payments stay the Owner's click in the factory app.

## Ground rules

- **Say whose connection it is.** The server's instructions name the person it acts as and whether it may draft. Say it before any draft ("This factory connection acts as <name> and may draft").
- **Read first, show the draft, ask.** Read what is there now, show exactly what the draft will hold, and ask a plain question. Go on only after a clear yes.
- **A draft is the request.** The factory has no approval page: the draft itself is what the Owner checks and finishes in the factory app. Make one draft per thing asked for; never a run of drafts nobody asked for. A connection may make at most 100 drafts a day.
- **Never** send, convert, invoice, charge, buy or void a label, answer a mail, or change users, roles or settings: no tool does it, and Claude never tells the person it was done.
- **Commerce is separate.** Nexus commerce (Amazon, eBay, Shopify, Etsy listings, stock and orders) is the `nexus` plugin, with its own connection. Never carry an id between the two.
- **When something is missing.** If the factory tools are not there, the server did not start. Its log names the reason: the factory must run with `FACTORY_RBAC_MODE=enforce`, its database in WAL mode, and a valid token (Settings › Integrations › Claude in the factory app). Say so and stop. A tool that answers "this connection may only read" needs a drafting token from the Owner.

## 1. Read

| Question | Tool |
|---|---|
| The day at a glance | `factory-overview` (no arguments): orders by state and late, quotes by state, work orders in progress and blocked, materials below reorder level, shipments on the way, open threads |
| Orders | `factory-orders` (`state`, `search`, `lateOnly`; pages with `limit` and `cursor`) and `factory-order` (`order`: its number, e.g. ORD-214, or id) |
| Quotes | `factory-quotes` (`state`: DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED): pipeline, how long a sent quote has waited, whether the customer viewed it |
| Production | `factory-production` (`blockedOnly`): work orders still to finish, late first, the stage each is at and why a blocked one is blocked |
| Materials | `factory-materials` (`lowOnly`, `search`): in stock, committed, on order, available, short |
| Shipments | `factory-shipments` (`state`) |
| Inbox | `factory-inbox` (`state`: OPEN, SNOOZED, CLOSED): thread summaries only, no message bodies or e-mail addresses |
| Money | `factory-financials` (`months`): needs permission to see all money |
| Trends | `factory-analytics` (`days`, default 90): throughput, stage times and the bottleneck, on-time rate, quote win/loss, margins |

Report in a few lines: late orders and the oldest promise date, blocked work orders and why, materials that will run short for open work, quotes waiting for an answer, open threads waiting on the factory. Then ask what the person wants to do.

## 2. Draft (only when asked, and only with a drafting token)

| Draft | Tool |
|---|---|
| A quote for a customer, unpriced | `factory-draft-quote` (`customer`: exact name or id, optional `conversationId` from `factory-inbox`, up to 20 `lines` with a `description` and optional `templateId`). The Owner prices and sends it in the quote rail. |
| A purchase order for a supplier | `factory-draft-purchase-order` (`supplier`, optional `expectedAt` YYYY-MM-DD, 1 to 50 `lines`: `material`, `qty` in the material's unit, `unitCostCents`). A person checks and sends it from the factory app. |
| An internal note | `factory-add-comment` (`on`: order, quote, workorder or purchaseorder; `ref`: its number or id; `body`; `@first.last` mentions a colleague inside the app). It starts with "(from Claude)"; nothing reaches a customer or supplier. |
| A work order's current stage | `factory-advance-work-order` (`workOrder`, `action`: start, pause, resume or finish). Forward only, exactly as the floor does: a stage starts only after the earlier ones finished, QC finishes only with a valid certificate. |

- Show the draft before making it (customer or supplier, every line, quantities, unit costs, the total when visible) and ask.
- After it is made, give its number and say plainly what the Owner still does in the factory app (price and send the quote, check and send the purchase order).
