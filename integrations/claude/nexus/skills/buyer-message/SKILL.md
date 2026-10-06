---
name: buyer-message
description: Write to a buyer from Nexus, as the business, in the language of the order's market - a shipping update, a delay apology, an address check or a message of your own - through the right route (e-mail for Shopify, Etsy and own-shop buyers; the marketplace's own messaging for Amazon and eBay), plus replies to eBay feedback and Amazon review requests. Every message waits for a person and cannot be recalled. Use when the person wants to message, e-mail, answer or update a customer, reply to feedback, or ask for a review.
---

# Buyer message

Buyers are shown masked (first name, city, country, masked e-mail). Never ask for, guess or write out an address, phone number or e-mail. A message once sent cannot be recalled, so every message waits for a person in Nexus.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

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
