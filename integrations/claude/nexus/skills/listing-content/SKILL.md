---
name: listing-content
description: Write or rewrite product text in Nexus - titles, bullet points, descriptions, keywords and text attributes, per language and per listing - following the business's glossary and brand voice, saved in Nexus with one approval per product (or up to 25 products in one bulk change), then offered for publishing to Amazon and eBay. Use when the person asks to write, improve, shorten, translate or fix listing text, fill missing translations, or align text with the brand voice.
---

# Listing content

Text is saved in Nexus first, as shared text per language (or as one listing's own text), and the person who approves it is its reviewer. A channel shows the new text only after the listing is published from Nexus. Claude writes the text itself; Nexus's own AI writers are not used from here.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

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

After the text change ran (`approval-status`), offer to send it: `publish-review`, then `publish-listing` with `fields` naming only the text groups that changed (`title`, `description`, `bullets`, `keywords`, `attributes`) — one plan, one publish step per listing (see `list-product`). Never in the same plan as the text change: each step is checked now, so the publish would be skipped as stale. Amazon, eBay and Etsy publish from the studio (Etsy: a new listing is created as an Etsy draft; see `list-product/etsy.md`); Shopify store fields go with Shopify's sync.
