---
name: buyer-message
description: Write to a buyer from Nexus, as the business, in the language of the order's market - a shipping update, a delay apology, an address check or a message of your own - through the right route (e-mail for Shopify, Etsy and own-shop buyers; the marketplace's own messaging for Amazon and eBay), plus replies to eBay feedback and Amazon review requests. Every message waits for a person and cannot be recalled. Use when the person wants to message, e-mail, answer or update a customer, reply to feedback, or ask for a review.
---

# Buyer message

Buyers are shown masked (first name, city, country, masked e-mail). Never ask for, guess or write out an address, phone number or e-mail. A message once sent cannot be recalled, so every message waits for a person in Nexus.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read the order

`order-search` (order number, buyer name or SKU) and `order-detail` (`orderId`): status, promised dates, shipments and tracking, returns, and the channel and market (they decide the route and the language).

## 2. Write

- `send-customer-message`: `orderId`, a `template` (`shipping-update`, `delay-apology`, `address-check`) and/or a free `message` (with a template it goes below it), `language` (`it` or `en`; default the order market's language).
- Routes: Shopify, Etsy, WooCommerce and own-shop buyers get an e-mail. Amazon and eBay buyers are written to ONLY through their marketplace's own messaging; on Amazon only with a template (it picks one of Amazon's message kinds). An opted-out buyer is refused an e-mail.
- Amazon and eBay messages go out only when the server's messaging switches are on; otherwise the preview says "dry run" and nothing reaches the buyer. Say which it is.
- No links, no incentives, no asking to change a review. Short, polite, factual, signed as the business.
- Show the person the message in the buyer's language and what it says in English, then ask.
- Several buyers: ONE `submit-change-plan` with one `send-customer-message` step per order; show every message first.

## 3. Reviews and feedback

- Read: `review-search` (`channel`, `minRating` / `maxRating`, `unanswered`, `sku`).
- `reply-to-review` (`reviewId`, `body`): a public reply under an eBay feedback, at most 80 characters, one per feedback. Amazon and Shopify have no reply call: the person posts there.
- `request-review` (`orderId`): Amazon's "Request a Review" for an order delivered 4 to 30 days ago, with no open return or refund, once per order. Amazon writes the message.
- `triage-reviews`: set status, assignee, tags and notes on the review desk (Nexus only; nothing is sent).

## 4. After

`approval-status` says whether it was sent, and live or dry run. Nothing is sent before a person approves it.
