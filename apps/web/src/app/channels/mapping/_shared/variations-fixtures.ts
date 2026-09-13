/**
 * VT.3 fixtures for the Variations group — `docs/vt-prompts.md` § "VT.3", canvas artboard 6.
 *
 * Why these exist: `GET/PUT /api/pim/channel-mapping/:channel/:code/variations[/:categoryId]`
 * (VX §11.1) is NOT served yet — measured 2026-09-13 with a positive control
 * (`/usr/bin/grep -n "variation" apps/api/src/routes/channel-mapping.routes.ts` → 0 matches,
 * `grep -c "presentation"` on the same file → 6). The group renders from these until VT.1 answers,
 * through the SAME component and the SAME `VariationRuleView` type — one definition, two sources.
 *
 * 🔴 `AMAZON_DE_OUTERWEAR_THEMES` is DERIVED, not typed by hand: generated from the latest cached
 * `CategorySchema` row for (AMAZON, DE, OUTERWEAR) on the LOCAL Docker database
 * (`127.0.0.1:55439/nexus_development`, `fetchedAt 2026-09-12T14:52:54.095Z`) — 50 enum values, 13
 * of which cover `[color, size]`, 28 marked deprecated by that schema's own
 * `variation_theme.items.properties.name.$lifecycle.enumDeprecated`. Labels are the BOUND
 * attributes' `title`s joined with ` / ` (`COLOR/SIZE` → `Farbe / Größe`), exactly the derivation
 * `docs/vt1-contracts.md` §2.1 fixes; a segment that binds to no property keeps its raw segment
 * (`MATERIAL_TYPE`), which is the T15 unbound case rather than an invented word.
 *
 * The canvas's own hint reads "50 values on DE" — this reading CONFIRMS it (the design doc's T14
 * "52 values" is a different coordinate's count, and the number is served, never assumed).
 */

import type { VariationRuleView, VariationThemeOption } from './contracts'

/** The 50 OUTERWEAR·DE theme enum values, derived from the cached schema (see the file header). */
export const AMAZON_DE_OUTERWEAR_THEMES: VariationThemeOption[] = [
  { code: 'NUMBER_OF_ITEMS', label: 'Artikelanzahl', coversAll: false, drops: ['color', 'size'], deprecated: false },
  { code: 'NUMBER_OF_ITEMS/COLOR_NAME/SIZE_NAME', label: 'Artikelanzahl / Farbe / Größe', coversAll: true, drops: [], deprecated: true },
  { code: 'NUMBER_OF_ITEMS/SIZE/COLOR', label: 'Artikelanzahl / Größe / Farbe', coversAll: true, drops: [], deprecated: false },
  { code: 'NUMBER_OF_ITEMS/STYLE_NAME', label: 'Artikelanzahl / Stil/Form', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'ITEM_WEIGHT', label: 'Artikelgewicht', coversAll: false, drops: ['color', 'size'], deprecated: false },
  { code: 'ITEM_PACKAGE_QUANTITY', label: 'Packungseinheit', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'ITEM_PACKAGE_QUANTITY/SIZE_NAME', label: 'Packungseinheit / Größe', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'ITEM_PACKAGE_QUANTITY/MATERIAL_TYPE', label: 'Packungseinheit / MATERIAL_TYPE', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'COLOR', label: 'Farbe', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'COLOR/NUMBER_OF_ITEMS', label: 'Farbe / Artikelanzahl', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'COLOR/SIZE', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: false },
  { code: 'COLOR/MATERIAL', label: 'Farbe / Material', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'COLOR/ITEM_PACKAGE_QUANTITY', label: 'Farbe / Packungseinheit', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'COLOR_NAME', label: 'Farbe', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'COLOR_NAME/NUMBER_OF_ITEMS', label: 'Farbe / Artikelanzahl', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'COLOR_NAME/ITEM_PACKAGE_QUANTITY', label: 'Farbe / Packungseinheit', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'COLOR_NAME/SIZE_NAME', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: true },
  { code: 'COLOR_NAME/MATERIAL_TYPE', label: 'Farbe / MATERIAL_TYPE', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'COLOR_NAME/STYLE_NAME', label: 'Farbe / Stil/Form', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'SIZE', label: 'Größe', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'SIZE/NUMBER_OF_ITEMS', label: 'Größe / Artikelanzahl', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'SIZE/COLOR', label: 'Größe / Farbe', coversAll: true, drops: [], deprecated: false },
  { code: 'SIZE/MATERIAL', label: 'Größe / Material', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'SIZE_NAME', label: 'Größe', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'SIZE_NAME/COLOR_NAME', label: 'Größe / Farbe', coversAll: true, drops: [], deprecated: true },
  { code: 'SIZE_NAME/COLOR_NAME/NUMBER_OF_ITEMS', label: 'Größe / Farbe / Artikelanzahl', coversAll: true, drops: [], deprecated: false },
  { code: 'SIZE_NAME/MATERIAL_TYPE', label: 'Größe / MATERIAL_TYPE', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'SIZE_NAME/STYLE_NAME', label: 'Größe / Stil/Form', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'SIZE_NAME/STYLE_NAME/COLOR_NAME', label: 'Größe / Stil/Form / Farbe', coversAll: true, drops: [], deprecated: true },
  { code: 'MATERIAL/COLOR', label: 'Material / Farbe', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'MATERIAL/SIZE', label: 'Material / Größe', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'MATERIAL/SIZE/COLOR', label: 'Material / Größe / Farbe', coversAll: true, drops: [], deprecated: false },
  { code: 'MATERIAL_TYPE', label: 'MATERIAL_TYPE', coversAll: false, drops: ['color', 'size'], deprecated: false },
  { code: 'MATERIAL_TYPE/COLOR_NAME/SIZE_NAME', label: 'MATERIAL_TYPE / Farbe / Größe', coversAll: true, drops: [], deprecated: true },
  { code: 'MODEL_NUMBER/SIZE', label: 'Modellnummer / Größe', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'MODEL_NUMBER/STYLE/PART_NUMBER', label: 'Modellnummer / Stil/Form / Artikelnummer', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'ITEM_PACKAGE_QUANTITY/SIZE', label: 'Packungseinheit / Größe', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'SPECIAL_SIZE_TYPE/COLOR_NAME', label: 'Sondergröße / Farbe', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'SPECIAL_SIZE_TYPE/SIZE_NAME/COLOR_NAME', label: 'Sondergröße / Größe / Farbe', coversAll: true, drops: [], deprecated: true },
  { code: 'STYLE/MODEL_NUMBER/NUMBER_OF_ITEMS/PART_NUMBER', label: 'Stil/Form / Modellnummer / Artikelanzahl / Artikelnummer', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'STYLE_NAME', label: 'Stil/Form', coversAll: false, drops: ['color', 'size'], deprecated: true },
  { code: 'STYLE_NAME/COLOR_NAME', label: 'Stil/Form / Farbe', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'STYLE_NAME/SIZE_NAME', label: 'Stil/Form / Größe', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'TEAM_NAME', label: 'Teamname', coversAll: false, drops: ['color', 'size'], deprecated: false },
  { code: 'TEAM_NAME/COLOR_NAME', label: 'Teamname / Farbe', coversAll: false, drops: ['size'], deprecated: true },
  { code: 'TEAM_NAME/SIZE_NAME', label: 'Teamname / Größe', coversAll: false, drops: ['color'], deprecated: true },
  { code: 'TEAM_NAME/SIZE_NAME/COLOR_NAME', label: 'Teamname / Größe / Farbe', coversAll: true, drops: [], deprecated: true },
  { code: 'TEAM_NAME/COLOR', label: 'Teamname / Farbe', coversAll: false, drops: ['size'], deprecated: false },
  { code: 'TEAM_NAME/SIZE', label: 'Teamname / Größe', coversAll: false, drops: ['color'], deprecated: false },
  { code: 'TEAM_NAME/SIZE/COLOR', label: 'Teamname / Größe / Farbe', coversAll: true, drops: [], deprecated: false },
]

const AXIS_NAMES_SENTENCE =
  'Amazon prints the names · eBay: from the site’s aspects · Shopify: English labels · values are pushed verbatim'

/**
 * 1 · CANVAS REPLICA — artboard 6 exactly, so the on-screen before/after table compares like with
 * like: `38 follow · 3 override · 0 collide`, `12 mapped · 2 unreviewed` on colour, `size: none`.
 * Those four counts are the canvas's DRAWN numbers, kept here on purpose and labelled as such; the
 * same coordinate MEASURED on this database is fixture 2 below.
 */
export const CANVAS_AMAZON_DE_OUTERWEAR: VariationRuleView = {
  channel: 'AMAZON',
  market: 'DE',
  categoryId: 'OUTERWEAR',
  categoryLabel: 'OUTERWEAR',
  source: 'derived',
  ruleLabel: null,
  derivation: {
    axisSummary: 'colour × size',
    themeCode: 'COLOR/SIZE',
    themeLabel: 'Farbe / Größe',
    families: 38,
    familiesTotal: 38,
  },
  counts: { follow: 38, override: 3, collide: 0, wouldCollide: 0, total: 41 },
  theme: { code: 'COLOR/SIZE', label: 'Farbe / Größe', options: AMAZON_DE_OUTERWEAR_THEMES },
  axes: [
    { axisKey: 'color', label: 'colour', channelName: 'Farbe', target: 'color', included: true },
    { axisKey: 'size', label: 'size', channelName: 'Größe', target: 'size', included: true },
  ],
  dropped: [],
  collisions: {
    resolver: 'split',
    foldInto: 'size',
    foldSeparator: ' / ',
    resolvers: [
      { kind: 'split', available: true, reason: null },
      { kind: 'fold', available: true, reason: null },
      { kind: 'exclude', available: true, reason: null },
    ],
  },
  split: { mode: 'one', axisKey: null, available: false, reason: 'Listing split is held until PES.5-ii makes aliases creatable.' },
  valueMaps: [
    { axisKey: 'color', label: 'colour', mapped: 12, unreviewed: 2 },
    { axisKey: 'size', label: 'size', mapped: 0, unreviewed: 0 },
  ],
  axisNamesSentence: AXIS_NAMES_SENTENCE,
  previewSkus: [
    { productId: 'cmokmy3a40078pm0p1fvnu523', sku: 'GALE-JACKET-BLACK-MEN-XL', name: 'Gale Jacket', productType: 'OUTERWEAR', listedHere: true, label: 'GALE-JACKET-BLACK-MEN-XL' },
  ],
  writeBlockedReason: null,
  expectedToken: 'fixture-canvas',
}

/**
 * 2 · MEASURED on the LOCAL Docker database, 2026-09-13, AMAZON·DE·OUTERWEAR:
 * 7 families carry variation axes, all 7 have a primary DE parent listing, **0** of them carry a
 * `variationTheme` (so 7 follow · 0 override), and `FieldValueMap` holds **0 rows in total**
 * (positive control: `SELECT count(*) FROM "FieldValueMap"` → 0 with the column list returned, i.e.
 * measured empty, not "could not measure"), so both value maps read `none`.
 * This is what the live wire will serve on this machine — the canvas's 38/3 is a bigger catalogue.
 */
export const MEASURED_AMAZON_DE_OUTERWEAR: VariationRuleView = {
  ...CANVAS_AMAZON_DE_OUTERWEAR,
  derivation: { axisSummary: 'colour × size', themeCode: 'COLOR/SIZE', themeLabel: 'Farbe / Größe', families: 7, familiesTotal: 7 },
  counts: { follow: 7, override: 0, collide: 0, wouldCollide: 0, total: 7 },
  valueMaps: [
    { axisKey: 'color', label: 'colour', mapped: 0, unreviewed: 0 },
    { axisKey: 'size', label: 'size', mapped: 0, unreviewed: 0 },
  ],
  expectedToken: 'fixture-measured',
}

/**
 * 3 · A RULE EXISTS — the other arm of the Rule line, on the XAVIA family's own product type
 * (`xavia-knee-slider` → `AUTO_ACCESSORY`, 18 products on this database, `variationAxes = {Colore}`).
 * One axis, so nothing can collide and nothing is dropped.
 */
export const RULE_AMAZON_IT_AUTO_ACCESSORY: VariationRuleView = {
  channel: 'AMAZON',
  market: 'IT',
  categoryId: 'AUTO_ACCESSORY',
  categoryLabel: 'AUTO_ACCESSORY',
  source: 'rule',
  ruleLabel: 'Accessories default',
  derivation: null,
  counts: { follow: 1, override: 0, collide: 0, wouldCollide: 0, total: 1 },
  theme: {
    code: 'COLOR',
    label: 'Colore',
    options: [
      { code: 'COLOR', label: 'Colore', coversAll: true, drops: [], deprecated: false },
      { code: 'COLOR_NAME', label: 'Colore', coversAll: true, drops: [], deprecated: true },
      { code: 'SIZE', label: 'Taglia', coversAll: false, drops: ['color'], deprecated: false },
    ],
  },
  axes: [{ axisKey: 'color', label: 'colour', channelName: 'Colore', target: 'color', included: true }],
  dropped: [],
  collisions: {
    resolver: 'exclude',
    foldInto: null,
    foldSeparator: ' / ',
    resolvers: [
      { kind: 'split', available: false, reason: 'Aliases are not creatable until PES.5-ii.' },
      { kind: 'fold', available: false, reason: 'Fold needs a second delivered axis to fold into.' },
      { kind: 'exclude', available: true, reason: null },
    ],
  },
  split: { mode: 'one', axisKey: null, available: false, reason: 'Listing split is held until PES.5-ii makes aliases creatable.' },
  valueMaps: [{ axisKey: 'color', label: 'colour', mapped: 0, unreviewed: 0 }],
  axisNamesSentence: AXIS_NAMES_SENTENCE,
  previewSkus: [
    { productId: 'xavia-knee-slider', sku: 'xavia-knee-slider', name: 'Xavia knee slider', productType: 'AUTO_ACCESSORY', listedHere: false, label: 'xavia-knee-slider' },
  ],
  writeBlockedReason: null,
  expectedToken: 'fixture-rule',
}

/**
 * 4 · A DROPPED AXIS AND A COLLISION on a channel that names its own options — the `OrderedList`
 * arm (`theme === null`, so the axis order is the rule's to set) and the `<names> dropped` copy.
 * Shopify takes 3 options; this family has 3 axes and the rule delivers 2, so `style` is dropped and
 * the variants that differed only by style can no longer be told apart (VX §6).
 */
export const SHOPIFY_DROPPED_AND_COLLIDING: VariationRuleView = {
  channel: 'SHOPIFY',
  market: 'GLOBAL',
  categoryId: 'OUTERWEAR',
  categoryLabel: 'OUTERWEAR',
  source: 'rule',
  ruleLabel: 'Apparel default',
  derivation: null,
  counts: { follow: 12, override: 2, collide: 3, wouldCollide: 3, total: 14 },
  theme: null,
  axes: [
    { axisKey: 'color', label: 'colour', channelName: 'Color', target: 'Color', included: true },
    { axisKey: 'size', label: 'size', channelName: 'Size', target: 'Size', included: true },
    { axisKey: 'style', label: 'style', channelName: 'Style', target: null, included: false },
  ],
  dropped: ['style'],
  collisions: {
    resolver: 'fold',
    foldInto: 'size',
    foldSeparator: ' / ',
    resolvers: [
      { kind: 'split', available: false, reason: 'Aliases are not creatable until PES.5-ii.' },
      { kind: 'fold', available: true, reason: null },
      { kind: 'exclude', available: true, reason: null },
    ],
  },
  split: { mode: 'one', axisKey: null, available: false, reason: 'Listing split is held until PES.5-ii makes aliases creatable.' },
  valueMaps: [
    { axisKey: 'color', label: 'colour', mapped: 0, unreviewed: 0 },
    { axisKey: 'size', label: 'size', mapped: 0, unreviewed: 0 },
    { axisKey: 'style', label: 'style', mapped: 0, unreviewed: 0 },
  ],
  axisNamesSentence: AXIS_NAMES_SENTENCE,
  previewSkus: [],
  writeBlockedReason: null,
  expectedToken: 'fixture-shopify',
}

/** Keyed for the `?variationsFixture=` instrument and for a test that walks every state. */
export const VARIATION_FIXTURES: Record<string, VariationRuleView> = {
  canvas: CANVAS_AMAZON_DE_OUTERWEAR,
  measured: MEASURED_AMAZON_DE_OUTERWEAR,
  rule: RULE_AMAZON_IT_AUTO_ACCESSORY,
  dropped: SHOPIFY_DROPPED_AND_COLLIDING,
}
