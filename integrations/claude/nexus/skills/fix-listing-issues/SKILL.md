---
name: fix-listing-issues
description: Work through the listing problems Nexus reports for one channel or market (for example Amazon DE, eBay IT or Shopify) - explain each one in plain words and, where a Nexus tool can fix it, prepare the fix as a change request that a person approves in Nexus. Use when the person asks to fix listing errors, suppressed or blocked listings or failed pushes, or asks what is wrong with their Amazon, eBay, Shopify or Etsy listings.
---

# Fix listing issues

Works in the one business this Nexus connection was approved for, using only the Nexus tools. Claude cannot change anything in Nexus: a change tool only queues a request, and a person approves or rejects it in the Nexus Approvals page. There is no tool to approve. Never say a listing is fixed, updated or changed.

If no Nexus tools are available, Nexus is not connected, or its server is not switched on yet: say so and stop (to connect in Claude Code: `/mcp`, choose the Nexus server, Authenticate; in claude.ai: Customize > Connectors).

## 1. Choose the scope

Use the channel (`AMAZON`, `EBAY`, `SHOPIFY`, `ETSY`) and market (such as `DE` or `IT`; `GLOBAL` for Shopify and Etsy) the person named. If they named neither, call `listing-issues` with `severity: "error"` and `limit: 100`, show the counts per channel and market, and ask which one to work on.

## 2. Read the issues

Call `listing-issues` with `channel`, `market` and `severity: "error"`. Look at warnings only after the errors, or when the person asks.

- Each item is one listing: SKU, status, `draft` (Nexus has not sent it yet) and `linked` (it carries the channel's own item id; a draft can be linked), and up to 10 issues, errors first (`moreIssues` counts the rest). Never call a listing "published" or "live" from these fields alone: say draft or not, linked or not.
- `from` says where an issue came from: `channel` (the channel reported it), `suppression` (Amazon hides the listing from buyers), `status` (the listing is in an error or suppressed state), `sync` (the last push failed), `validation` (a Nexus check), `readiness` (required values are missing before it can publish; `missing` names them).
- To read on, call again with the same filters and `cursor` set to `nextCursor`; the list has ended only when `nextCursor` is null. Work through about 10 listings at a time and say how many are left (`total`).
- This reads what Nexus has saved; it does not ask the channel again. Something fixed directly on the channel can still show here until Nexus next reads the channel.

## 3. Explain, briefly

Group listings that share a problem (same `code` or message). For each group, in a few lines: what it means in plain words, what it costs (buyers cannot see it, cannot buy it, or it is only a warning), and the fix. Use `product-snapshot` or `listing-health` when you need one product's details.

## 4. Prepare the fixes a tool supports

Only these fixes can be prepared from Claude. Each one queues a request that a person approves in Nexus.

| Problem | Tool | What it asks for |
|---|---|---|
| Title, bullet points or description missing, too long or not allowed | `apply-content` | New text on the master product in Nexus. Draft it, show it, and let the person edit it first. A channel gets the new text only when the listing is sent again, and not where that listing has its own text in Nexus. |
| The last push failed, or the listing must be sent again after a fix | `publish-listing` | Sends the listing to that channel again through Nexus's normal publishing checks. It takes a product and a channel, not a market. Its preview shows the publish mode: if it is not `live` (for example `gated` or `dry-run`), say that approving it may send nothing to the channel. |
| Master price missing or wrong | `set-price` for one product; `bulk-price-change` for several | A new master price. A channel listing follows it only if it follows the master price. |
| Required attribute values missing or wrong | `bulk-attribute-change`, if this connection offers it | The same master attribute change for one or more products in Nexus only. Approval does not send it to a channel; a person must publish from Nexus afterwards. |

Everything else has no tool here: images, category or product type, variations, stock, shipping and returns, brand approval, documents a channel asks for. Say where to fix it (the product in Nexus, or the channel's own seller account) and move on.

Before each request:

- Show exactly what will be asked: SKU, field, from and to. Get a clear yes.
- Read the tool's own description for its exact arguments, then call it once.
- If the same fix is needed on many products and a bulk tool covers it, use the bulk tool: one request, one approval. Never loop single calls instead.
- If the person agrees to several single requests (new titles for 8 products, say), tell them first that this makes 8 separate approvals.

## 5. After each request

The answer has `status: "waiting_for_approval"`, an `approvalId`, `expiresAt`, `approveAt` (the link to the Approvals page) and a `preview`. Tell the person:

- Nothing has changed yet. Someone with the right permission must approve it in Nexus: give the `approveAt` link.
- It expires at `expiresAt` if nobody decides.
- The issue keeps showing until the change is approved, has run, and the channel reports back.

If a change tool is missing or refuses, say why in plain words: the connection may be read-only (connect Nexus again and allow "Ask for changes"), or the person's role in Nexus does not allow that change. Later, `approval-status` with the `approvalId` shows what became of a request; repeat its `meaning`.

## 6. Wrap up

A short list, one line per listing or group: the problem, then what was prepared (with its `approvalId`) or what the person has to do in Nexus or on the channel. Put the Approvals link once, at the end.
