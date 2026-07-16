# ED — eBay Dynamic Description Engine

**Date:** 2026-07-16 · **Status: ✅ ALL PHASES SHIPPED (ED.1–ED.5), awaiting owner test pass** (owner: "Proceed however you recommend") · flat-file protected surface exception applies to this engagement.

> **Progress:** ED.1+ED.2 `b2922394` (theme model + migration, pure renderer + eBay active-content sanitizer, 3 built-in themes, service CRUD, wired at all three push sites — render never blocks a push) · ED.3 `356f9540` (per-market Description Theme column + DescriptionModal "Themed (as pushed)" tab + description-preview endpoint) · ED.4 `49c445e1` (File → "Description themes…" two-pane manager: editor with token click-to-insert, duplicate/default-star/active/delete, unsaved-draft Preview via `themeHtml` override) · ED.5 `53a01cf5` (a: image-publish path resolves per-market parentContent + themed render before pushVariationGroup — fixes the P9e family gap AND means image changes re-push themed descriptions automatically; b: Edit-menu bulk "Set description theme…" over ticked rows). AI body feed stays gated on the prod AI provider (Gemini exhausted — see reference_prod_ai_provider); the description cell already accepts flat-file-ai output when a key lands.

## Owner goals
Description field "extremely dynamic": custom embeddable **themes**, **auto-fetched images per variant / per group** (the image-axis groups the drawer manages), **policy blocks**, **per-market localized content**, full automation ("find a way to be the best").

## Architecture (research-grounded, 2 agents 2026-07-16)
- **Body copy stays the operator's** — `ChannelListing.description` per market (P9e model: one row per region, per-market resolution at push already shipped). Themes never rewrite it.
- **Render at PUSH time**: the resolved theme wraps the market's body the moment it's sent, so image/policy/content changes flow into eBay on every push with zero extra operator actions. No theme assigned → raw body, byte-identical to before (live-but-inert rollout).
- **Assignment** = `ChannelListing.platformAttributes.descriptionThemeId` on the market's row (per-market themes for free); `'none'` opts out of the default; global default = `EbayDescriptionTheme.isDefault`.
- **Galleries** mirror the canonical curated resolution (`images/ebay-inventory-image-publish.service.ts`): shared gallery (no group key) + per-group sets (`ListingImage.variantGroupKey/Value` — the owner's "groups") + per-SKU pins; master `ProductImage` fallback. Variation listings carry ONE description → group mode renders colour-sectioned galleries inside it; single-SKU/shared-SKU render per listing.
- **eBay compliance guard** (new — nothing sanitized descriptions before): strip script/iframe/object/embed/form/link/meta/base + on* handlers + `javascript:` URLs; upgrade http→https media; size warning at 300 KB. Applied to the whole rendered output.
- **Never block a push**: any render/DB error falls back to the raw body with a logged warning.

## Tokens (v1)
`{{title}} {{subtitle}} {{body}} {{sku}} {{brand}} {{market}}` (text esc; body raw) ·
`{{gallery}}` (single: row's images per-SKU→group→shared; group: shared + per-colour sections) ·
`{{gallery_shared}}` · `{{specs_table}}` (row aspect_* dedup, cap 14) · `{{policies}} {{policy_shipping}} {{policy_returns}} {{policy_payment}}` (display names when the push site has them). Unknown tokens stripped + warned.

## Phases
- **ED.1 ✅** `EbayDescriptionTheme` model + migration (additive) · pure renderer `ebay-description-render.ts` (+7 vitest) · 3 built-in starter themes (Nexus Clean / Gallery Pro / Classic Two-Column — editable, not deletable) · theme service (CRUD, default, ensure-seeds, `renderListingDescriptionSafe`).
- **ED.2 ✅** Push wiring at all three sites — single-SKU offer `listingDescription`, variation-group body via `parentContent` (colour-sectioned), shared-SKU Trading push — + `/api/ebay/description-themes` CRUD + `/api/ebay/description-preview` (renders exactly what a push would send; no eBay, no writes). 203 existing eBay push tests green.
- **ED.3** Operator UX: `description_theme` per-market assignment (save-path split into `platformAttributes.descriptionThemeId`, like subtitle), theme picker + **Themed preview** tab in the DescriptionModal, theme options injected like policy dropdowns.
- **ED.4** Theme manager UI (list/edit/duplicate/set-default with live preview, DS components) + bulk-assign via Edit menu.
- **ED.5** Automation tail: optional re-push enqueue when a group's images change (flag-gated), AI body generation feed (flat-file-ai / listing-content services), docs.

## Invariants
Stored body copy never rewritten · render never blocks a push (fallback = raw body) · per-market everything (body, theme, galleries, policy names) · no active content ever emitted · additive schema only.
