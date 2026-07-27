/**
 * DS-1 — the ONE client-side list of theme tokens. Mirrors the COMPLETE token
 * map in apps/api/src/services/ebay-description-render.ts
 * (renderDescriptionTheme). The legacy modal listed only 10 of these; the
 * Studio palette must show every token the renderer resolves — an unknown
 * token is REMOVED at render time with a warning, so the palette and the
 * renderer have to agree.
 *
 * DS-4 — per-token descriptions (the palette buttons' tooltips), keyed on the
 * SAME object the token list derives from so the two can never drift apart.
 * Wording mirrors what renderDescriptionTheme actually substitutes.
 */
export const THEME_TOKEN_INFO = {
  '{{title}}': 'Listing title as plain text (HTML-escaped).',
  '{{subtitle}}': 'Listing subtitle as plain text (empty when the listing has none).',
  '{{body}}': "The market's description body HTML — the copy this theme wraps, inserted verbatim.",
  '{{sku}}': "The family parent's SKU as plain text.",
  '{{brand}}': 'Product brand as plain text.',
  '{{market}}': 'Marketplace code the render targets (e.g. IT, DE) as plain text.',
  '{{gallery}}': "Image gallery grid. Group mode: shared images first, then one titled section per colour/variant group; single mode: this row's own images. Capped at 36 images.",
  '{{gallery_shared}}': 'Shared/common gallery only — images not tied to any colour group (capped at 36).',
  '{{specs_table}}': "Two-column specifics table built from the row's item specifics (the aspect_* columns), max 14 rows.",
  '{{specs_rows}}': 'Bare <tr><td> specifics rows with no styling — the theme provides the <table>/<thead> shell and CSS (max 14 rows).',
  '{{gallery_hero}}': 'Interactive CSS-only radio-swap gallery (stage + thumbnails, no JavaScript) sized to the real image count, max 8. Group mode: shared images (first colour group as fallback); single mode: this row. Styled via .gallery/.stage/.shot/.thumbs classes — place ONCE per theme (THEME ONLY, not usable inside the description body: it mints element ids a duplicate would collide with).',
  '{{gallery_groups}}': 'One classed section per colour/variant group (.ggroup > .gg-title + .gg-grid of plain <img>) — the theme owns all styling. Empty in single mode.',
  '{{policies}}': 'One localized list of the shipping / returns / payment business-policy names (missing policies are omitted).',
  '{{mobile_summary}}': 'Plain-text summary the eBay mobile app shows before "see full description": title + de-tagged body, truncated at a word boundary (≤640 chars).',
  '{{policy_shipping}}': 'Shipping business-policy display name only, as plain text.',
  '{{policy_returns}}': 'Returns business-policy display name only, as plain text.',
  '{{policy_payment}}': 'Payment business-policy display name only, as plain text.',
} as const

export type ThemeToken = keyof typeof THEME_TOKEN_INFO

export const THEME_TOKENS = Object.keys(THEME_TOKEN_INFO) as ThemeToken[]
