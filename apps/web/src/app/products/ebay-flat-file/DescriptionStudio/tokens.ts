/**
 * DS-1 — the ONE client-side list of theme tokens. Mirrors the COMPLETE token
 * map in apps/api/src/services/ebay-description-render.ts
 * (renderDescriptionTheme). The legacy modal listed only 10 of these; the
 * Studio palette must show every token the renderer resolves — an unknown
 * token is REMOVED at render time with a warning, so the palette and the
 * renderer have to agree.
 */
export const THEME_TOKENS = [
  '{{title}}',
  '{{subtitle}}',
  '{{body}}',
  '{{sku}}',
  '{{brand}}',
  '{{market}}',
  '{{gallery}}',
  '{{gallery_shared}}',
  '{{specs_table}}',
  '{{policies}}',
  '{{mobile_summary}}',
  '{{policy_shipping}}',
  '{{policy_returns}}',
  '{{policy_payment}}',
] as const
