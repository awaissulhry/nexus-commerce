---
name: fix-listing-issues
description: Work through the listing problems Nexus reports for one channel or market (for example Amazon DE, eBay IT or Shopify) - explain each one in plain words and, where a Nexus tool can fix it, prepare the fixes as one change plan that a person approves in Nexus, then re-publish the listings with only the field groups that changed. Use when the person asks to fix listing errors, suppressed or blocked listings or failed pushes, or asks what is wrong with their Amazon, eBay, Shopify or Etsy listings.
---

# Fix listing issues

Works in the one business this Nexus connection was approved for, using only the Nexus tools. A change tool changes nothing by itself: it stores one request, and a person approves it in Nexus (unless the business set that tool to run by its rule). Never say a listing is fixed, updated or live until `approval-status` (and for a publish, `publication-status`) says so.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Choose the scope

Use the channel (`AMAZON`, `EBAY`, `SHOPIFY`, `ETSY`) and market (such as `DE` or `IT`; `GLOBAL` for Shopify and Etsy) the person named. If they named neither, call `listing-issues` with `severity: "error"` and `limit: 100`, show the counts per channel and market, and ask which one to work on.

## 2. Read the issues

`listing-issues` with `channel`, `market` and `severity: "error"`; warnings only after the errors, or when asked.

- Each item is one listing: SKU, status, `draft` (Nexus has not sent it yet) and `linked` (it carries the channel's own item id; a draft can be linked), and up to 10 issues, errors first. Never call a listing "live" from these fields alone.
- `from` says where an issue came from: `channel` (the channel reported it), `suppression` (Amazon hides it from buyers), `status` (error or suppressed state), `sync` (the last push failed), `validation` (a Nexus check), `readiness` (required values missing before it can publish; `missing` names them).
- Page with `cursor` = `nextCursor` until it is null. Work through about 10 listings at a time and say how many are left (`total`).
- It reads what Nexus has saved, not the channel. To see what the channel holds now, use `listing-live-content` (one listing).

## 3. Explain, briefly

Group listings that share a problem (same `code` or message). For each group: what it means in plain words, what it costs (buyers cannot see it, cannot buy it, or only a warning), and the fix. For one product, `listing-health`, `product-content` (with a `coordinate`) and `publish-review` show the detail.

## 4. Prepare the fixes a tool supports

| Problem | Tool |
|---|---|
| Title, bullets, description or keywords missing, too long or not allowed | `set-content` (one product, one language), `bulk-content-change` (up to 25 products, one language), or `set-listing-content` (one Amazon or eBay listing's own text). Follow the `listing-content` skill: read `content-guidelines` first, give `englishMeaning` unless the language is English. |
| Required attribute values missing or wrong | `set-listing-fields` (`values` on one listing, keys as `product-content` lists them for that coordinate), or `bulk-attribute-change` (the same master attribute on up to 250 products) |
| Variation theme or which variations a listing includes (Amazon) | `set-listing-fields` (`variationTheme` or `variants`) |
| Barcode invalid or missing, brand spelled wrongly | `set-gtin`, `set-brand` (see `identity-check`) |
| Photos missing or in the wrong order | `add-photo-from-url`, `arrange-photos` (family on the media plan), then publish with `fields: "photos"` |
| Master price missing or wrong | `set-price` (one product) or `bulk-price-change` (see `bulk-reprice`); one market's price: `set-listing-price` with targets from `listing-matrix` |
| Quantity behind, or the stock sync paused | `set-listing-stock` (`push-now`, `set-follow`, `resume-sync`) with targets from `listing-matrix`; never an FBA quantity; Amazon's EU markets share ONE quantity (`AMAZON:EU`) |
| The last push failed, or the listing must be sent again after a fix | `publish-review`, then `publish-listing` (below) |

Everything else has no tool here: category or product type mapping changes, shipping and returns policies, brand approval, documents a channel asks for. Say where it is fixed (the product in Nexus, or the channel's own seller account) and move on.

**How to ask:** put every fix that does not depend on another into ONE `submit-change-plan` (or one bulk tool). Show the table of steps first (SKU, field, from → to) and get a clear yes.

## 5. Send the fixes to the channel

Text, attributes and photos are saved in Nexus only; the channel changes when the listing is published. After the fixes ran (`approval-status` says executed, or each plan step says done):

1. `publish-review` (`productId`, `channel`, `market`, and `accountId` or `listingId` from `listing-coordinates` when there are several): what would be sent, what it replaces on the channel (`changes`: SEND, DIFFERS, CANNOT_COMPARE, SAME), what blocks it (issues with severity error) and the channel's live mode. Fix blockers first.
2. `publish-listing` with `fields` naming only the groups that changed — `title`, `description`, `bullets`, `keywords`, `photos`, `attributes` — or `"all"` for a draft's first publish. Stock, price and fulfilment never ride a publish. It refuses Etsy (no publisher yet), an existing Shopify product, anything the review blocks, an FBA quantity, and an Amazon EU first publish whose quantity differs from the SKU's other EU markets.
3. Several listings: ONE `submit-change-plan` with one `publish-listing` step per listing.

Never put a publish in the same plan as the fix it should send: each step is checked now, so its review would not hold the fix and the publish step would be skipped as stale. Fix first, publish once the fix has run.

## 6. After each request

- Waiting for approval: nothing has changed yet; give the `approveAt` link.
- The issue keeps showing until the change ran and the channel reported back. For a publish, `approval-status` names its `publication`; `publication-status` reads it (SUBMITTED, UNVERIFIED, ACCEPTED, VERIFIED, PARTIAL, FAILED). A pending one settles through the settle sweep (when switched on) or when someone opens its result in the Nexus studio.

## 7. Wrap up

One line per listing or group: the problem, then what was asked for (with its `approvalId`) or what the person has to do in Nexus or on the channel. Put the Approvals link once, at the end.
