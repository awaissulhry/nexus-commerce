---
name: nexus-business-check
description: Say which Nexus business this connection works in before any change, and keep work in one business at a time - read business-overview, name the business, pick the right Nexus connection when several are connected, and never carry an id, SKU or approval from one business to another. Use at the start of Nexus work, whenever the person names a business, has more than one Nexus connection, mentions shared stock between businesses, or a tool says "this connection works in ...".
---

# Nexus business check

Each Nexus connection works in exactly ONE business (Nexus calls a business a "business profile"). Claude sees and changes nothing else through it. Two businesses can hold the same SKU (shared stock is matched by SKU), so a SKU alone never says which business is meant.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Which business is this?

- Every Nexus answer carries `business` (its id and name), and the connection's own title reads "Nexus — <business>".
- `business-overview` (no arguments) gives the name, country, currency, time zone, main market, company details, the markets it sells on with their languages, and how many channel accounts are connected per channel.
- Say it in one line before any change: "This connection works in <business> (sells on <markets>)."

## 2. More than one business

- One Nexus connection per business. In Claude they show as separate servers ("Nexus — Acme Racing", "Nexus — Acme Moto"), each with its own tools.
- Use the tools of the server whose business the person means. If it is not clear which one, ask before reading or changing anything.
- If the business the person means has no connection here, say so and stop: they add it with that business's own Nexus address (see the plugin README). Do not do the work in another business instead.

## 3. Never across businesses

- Read SKUs, product ids, listing ids, campaign ids and approvalIds again on the connection you are about to change through. An id from another connection is refused or, worse, can match something else.
- Channel item ids (eBay Item ID, ASIN, Shopify product, Etsy listing) never move between businesses.
- `shared-stock` shows what this business lends to and borrows from others, and where each product's listings take their number from. Sharing itself (offering, accepting, ending) is done by an owner in Nexus, never by Claude.
- An answer from one business is never added to another's ("total sales of both") unless the person asks, and then each number is labelled with its business.

## 4. Before every change

- Pass the business name as `business` on every change tool and on `submit-change-plan`. It is a check, not a choice: another name is refused with "This connection works in X; you named Y. Nothing was queued."
- If you get that refusal, stop and check with the person. Never retry with the other name just to get the request through.
- What Claude may do here also depends on the business: a tool can be turned off for Claude, wait for a person (ask), wait for the asker's authenticator code (confirm), or run by the business's rule (auto). The Owner sets this in Nexus, Settings › AI › Claude; Claude cannot change it.
