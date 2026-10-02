---
name: listing-content
description: Write or rewrite product text in Nexus - titles, bullet points, descriptions, keywords and text attributes, per language and per listing - following the business's glossary and brand voice, saved in Nexus with one approval per product (or up to 25 products in one bulk change), then offered for publishing to Amazon and eBay. Use when the person asks to write, improve, shorten, translate or fix listing text, fill missing translations, or align text with the brand voice.
---

# Listing content

Text is saved in Nexus first, as shared text per language (or as one listing's own text), and the person who approves it is its reviewer. A channel shows the new text only after the listing is published from Nexus. Claude writes the text itself; Nexus's own AI writers are not used from here.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read the rules before writing

`content-guidelines` (`brand`, `market`, `language`): the glossary (preferred words, words to avoid and why) and the brand voice for the closest match. Use the preferred words; never use an avoid word.

## 2. Read the text now

- `product-content` (`product`: id or SKU, `language`, optional `coordinate` { `channel`, `market` }): each field's value and layer — `source` (the primary-language text), `language` (shared text in another language), `pin` (this listing's own text), `mapped` (built by the channel's mapping) — its review state, whether it is required, its limits, and why it cannot be edited.
- `translation-status` (`products` up to 250, `languages`): per language missing, outdated, `ai-draft` (machine text nobody reviewed: Nexus will not publish it) or reviewed.
- `content-gaps` (`channel`, `market`, `language`, `state: "blocked"`): where required text or attributes are missing.
- `listing-live-content` (`product`, `channel`, `market`): what the channel shows right now, to compare. Shopify store fields: `shopify-content`.

## 3. Write

- Per language, inside each field's limits, in the brand voice. A variation that only repeats its parent's text needs nothing of its own.
- For every field written in a language other than English, give `englishMeaning`: what it says in English, for the approver.
- Show the text before asking: per product and field, old → new (shortened if long) and the English meaning.

## 4. Ask: one approval per product, or up to 25 in bulk

| Change | Tool |
|---|---|
| One product, one language: shared text every listing in that language follows | `set-content` (`product`, `language`, `title`, `bulletPoints`, `description`, `keywords`, `attributes`, `reset`, `englishMeaning`) |
| 1 to 25 products, one language | `bulk-content-change` (`language`, `items`); if one product cannot change, none does |
| One Amazon or eBay listing keeps its own text, or follows the shared text again | `set-listing-content` (`product`, `coordinate`, `language`, `pin`, `follow`, `attributes`, `dropAttributes`, `englishMeaning`) |
| Shopify store fields (metafields, vendor, tags, product type, category, SEO) | `set-shopify-content` |

- Several languages or more than 25 products: ONE `submit-change-plan` with one step per language or per batch of 25.
- The preview flags glossary avoid words and the writer's warnings, and counts the listings that follow the text (and those with their own pin, which do not change). Fix any avoid word before you ask.
- The primary language is the source text: changing it can mark the other languages outdated. Say so.

## 5. Offer to publish

After the text change ran (`approval-status`), offer to send it: `publish-review`, then `publish-listing` with `fields` naming only the text groups that changed (`title`, `description`, `bullets`, `keywords`, `attributes`) — one plan, one publish step per listing (see `list-product`). Never in the same plan as the text change: each step is checked now, so the publish would be skipped as stale. Amazon and eBay publish from the studio; Shopify store fields go with Shopify's sync; Etsy is not available yet.
