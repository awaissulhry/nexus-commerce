/**
 * /design/variation-projection — the frozen fixture behind every scenario.
 *
 * One family, GALE-JACKET, with THREE axes (colour × size × style = 12 children), because the
 * collision rule and the "two axes on Shopify, three on Amazon" ask cannot be shown on a two-axis
 * family — and no three-axis family exists on production (design §1 V14). Nothing here is read from
 * an API and nothing is written anywhere: every number in the mock resolves from this file, so a
 * reviewer can check a count by reading it.
 *
 * Design: `docs/2026-09-12-variation-projection-design.md`. Section references in the comments below
 * are to that document.
 */

/* ── the family (design §2 layer 2: axes and values are CODES with labels) ──────────────────── */

export interface AxisValue {
  /** The stable identity — `AttributeOption.code` once §4 M1 lands. */
  code: string
  /** What Nexus shows AND what is pushed, unless a value map converts it (§2 VX.3). */
  label: string
}

export interface FamilyAxis {
  /** `CustomAttribute.code`, canonical (`color`, `size`, `style`) — design §1 V1. */
  key: string
  /** English, shown everywhere in Nexus (§2 VX.2). */
  label: string
  values: AxisValue[]
}

export const AXES: FamilyAxis[] = [
  { key: 'color', label: 'Colour', values: [{ code: 'black', label: 'Nero' }, { code: 'yellow', label: 'Giallo' }] },
  { key: 'size', label: 'Size', values: [{ code: 's', label: 'S' }, { code: 'm', label: 'M' }, { code: 'l', label: 'L' }] },
  { key: 'style', label: 'Style', values: [{ code: 'slim', label: 'Slim' }, { code: 'regular', label: 'Regular' }] },
]

export const axisByKey = (key: string) => AXES.find((a) => a.key === key)
export const valueLabel = (axisKey: string, code: string) =>
  axisByKey(axisKey)?.values.find((v) => v.code === code)?.label ?? code

export interface Variant {
  id: string
  sku: string
  /** axisKey → option code. The TUPLE that tells this variant from its siblings. */
  values: Record<string, string>
  completeness: number
}

/** 2 colours × 3 sizes × 2 styles = 12 children, SKUs in axis-value order (§11.3 row order). */
export const VARIANTS: Variant[] = AXES[0].values.flatMap((colour) =>
  AXES[1].values.flatMap((size) =>
    AXES[2].values.map((style, i): Variant => ({
      id: `${colour.code}-${size.code}-${style.code}`,
      sku: `GALE-JACKET-${colour.code.toUpperCase()}-${size.code.toUpperCase()}-${style.code.toUpperCase()}`,
      values: { color: colour.code, size: size.code, style: style.code },
      completeness: 76 - i * 3,
    })),
  ),
)

export const PARENT = { id: 'parent', sku: 'GALE-JACKET', name: 'Gale Jacket', completeness: 81 }

/* ── the coordinates (design §2 layer 3; §10 aliases are coordinates) ───────────────────────── */

/** The five words the DS ships today, plus the sixth the design proposes (D9). */
export type CellState = 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'collides'

export interface Coordinate {
  key: string
  channel: string
  /** Column header on the shared state (§11.3). The market suffix only when the channel has >1 market. */
  label: string
  market: string
  /** `''` is the primary listing; anything else is a `ProductListingAlias` (design §1 V11). */
  aliasKey: string
  aliasLabel: string
  /** The axis keys this coordinate RECEIVES, in projection order. A family axis absent here is dropped. */
  axes: string[]
  /** Amazon only — a value of the product type's `variation_theme` enum. */
  theme: string | null
  /** `rule` = follows the channel × market × category rule; `override` = this listing's own (§2 VX.1). */
  source: 'rule' | 'override'
  ruleLabel: string
  /** The channel's own noun for an axis, from the wire, never composed client-side. */
  axisNoun: string
  axisNounPlural: string
  /** `null` = no limit this repository can source (vp2-contracts §1 — never printed as a number). */
  limitAxes: number | null
  limitVariants: number | null
  /** Variant ids included on this coordinate. */
  included: string[]
  /** axisKey → the channel-side target. */
  targets: Record<string, string>
  connected: boolean
  externalId: string | null
}

const ALL = VARIANTS.map((v) => v.id)
const regularOnly = VARIANTS.filter((v) => v.values.style === 'regular').map((v) => v.id)
const outlet = VARIANTS.filter((v) => v.values.size !== 's' && v.values.style === 'slim').map((v) => v.id)
const neroOnly = VARIANTS.filter((v) => v.values.color === 'black').map((v) => v.id)

export const COORDINATES: Coordinate[] = [
  {
    key: 'AMAZON:DE', channel: 'AMAZON', label: 'Amazon · DE', market: 'DE', aliasKey: '', aliasLabel: 'Primary',
    axes: ['size', 'color', 'style'], theme: 'SIZE/COLOR/STYLE', source: 'rule', ruleLabel: 'Apparel default',
    axisNoun: 'theme', axisNounPlural: 'themes', limitAxes: 3, limitVariants: null,
    included: ALL, targets: { size: 'size_name', color: 'color_name', style: 'style_name' },
    connected: true, externalId: 'B0F7J163XJ',
  },
  {
    key: 'AMAZON:IT', channel: 'AMAZON', label: 'Amazon · IT', market: 'IT', aliasKey: '', aliasLabel: 'Primary',
    axes: ['size', 'color'], theme: 'SIZE/COLOR', source: 'override', ruleLabel: 'Apparel default',
    axisNoun: 'theme', axisNounPlural: 'themes', limitAxes: 3, limitVariants: null,
    included: regularOnly, targets: { size: 'size_name', color: 'color_name' },
    connected: true, externalId: 'B0F7J163XK',
  },
  {
    key: 'EBAY:IT', channel: 'EBAY', label: 'eBay · IT', market: 'IT', aliasKey: '', aliasLabel: 'Primary',
    axes: ['color', 'size'], theme: null, source: 'rule', ruleLabel: 'Apparel default',
    axisNoun: 'specific', axisNounPlural: 'specifics', limitAxes: 5, limitVariants: 250,
    included: regularOnly, targets: { color: 'Colore', size: 'Taglia' },
    connected: true, externalId: '385612094771',
  },
  {
    key: 'EBAY:IT:2', channel: 'EBAY', label: 'eBay · IT ②', market: 'IT', aliasKey: 'outlet', aliasLabel: '② Outlet',
    axes: ['size', 'color'], theme: null, source: 'override', ruleLabel: 'Apparel default',
    axisNoun: 'specific', axisNounPlural: 'specifics', limitAxes: 5, limitVariants: 250,
    included: outlet, targets: { size: 'Taglia', color: 'Colore' },
    connected: true, externalId: '385612118904',
  },
  {
    key: 'EBAY:IT:3', channel: 'EBAY', label: 'eBay · IT ③', market: 'IT', aliasKey: 'nero', aliasLabel: '③ Nero',
    axes: ['size'], theme: null, source: 'override', ruleLabel: 'Apparel default',
    axisNoun: 'specific', axisNounPlural: 'specifics', limitAxes: 5, limitVariants: 250,
    included: neroOnly, targets: { size: 'Taglia' },
    connected: true, externalId: null,
  },
  {
    key: 'SHOPIFY', channel: 'SHOPIFY', label: 'Shopify', market: 'GLOBAL', aliasKey: '', aliasLabel: 'Primary',
    axes: ['color', 'size'], theme: null, source: 'rule', ruleLabel: 'Apparel default',
    axisNoun: 'option', axisNounPlural: 'options', limitAxes: 3, limitVariants: 100,
    included: ALL, targets: { color: 'Colour', size: 'Size' },
    connected: true, externalId: '8841204163',
  },
  {
    key: 'ETSY', channel: 'ETSY', label: 'Etsy', market: 'GLOBAL', aliasKey: '', aliasLabel: 'Primary',
    axes: [], theme: null, source: 'rule', ruleLabel: 'Apparel default',
    axisNoun: 'property', axisNounPlural: 'properties', limitAxes: 2, limitVariants: 70,
    included: [], targets: {}, connected: false, externalId: null,
  },
]

export const coordinate = (key: string) => COORDINATES.find((c) => c.key === key)!

/* ── the collision rule (design §6) ─────────────────────────────────────────────────────────── */

export interface CollisionGroup {
  /** The tuple the mapped axes produce — the reason the two variants cannot be told apart. */
  keyLabel: string
  variantIds: string[]
  skus: string[]
}

/**
 * key(v) over a coordinate's MAPPED axes and its INCLUDED variants. Two included variants with an
 * equal key collide: the channel has no way to tell them apart, so a buyer picking that combination
 * would land on an arbitrary one of the two.
 */
export function collisionsOf(c: Coordinate): CollisionGroup[] {
  const groups = new Map<string, Variant[]>()
  for (const v of VARIANTS) {
    if (!c.included.includes(v.id)) continue
    // A printable delimiter: a NUL byte here makes the shell’s `grep` skip this
    // whole file, so a repo-wide set claim silently omits it (LX.F F1).
    const key = c.axes.map((k) => v.values[k] ?? '').join('\u001f')
    groups.set(key, [...(groups.get(key) ?? []), v])
  }
  return [...groups.values()]
    .filter((vs) => vs.length > 1)
    .map((vs) => ({
      keyLabel: c.axes.map((k) => valueLabel(k, vs[0].values[k])).join(' · '),
      variantIds: vs.map((v) => v.id),
      skus: vs.map((v) => v.sku),
    }))
}

/** The axes this coordinate does NOT receive — named on screen, never silently missing. */
export const droppedAxes = (c: Coordinate) => AXES.filter((a) => !c.axes.includes(a.key))

export type Resolver = 'split' | 'fold' | 'exclude'

export const RESOLVERS: Array<{ id: Resolver; label: string; detail: string; heldReason?: string }> = [
  {
    id: 'split',
    label: 'Split per dropped axis',
    detail: 'One listing per value of the dropped axis — a listing alias each, labelled by the value.',
    heldReason: 'Listing aliases cannot be created yet: the legacy unique indexes are still on ChannelListing (PES.5-ii).',
  },
  { id: 'fold', label: 'Fold into another axis', detail: 'The dropped value joins another axis’s value — “L / Slim”. Writes as a pinned value on the variant.' },
  { id: 'exclude', label: 'Exclude the duplicates', detail: 'Keep the first variant per key, in axis-value order, and exclude the rest on this coordinate.' },
]

/* ── the rule, as the mapping page holds it (design §4 M2, §11.1) ───────────────────────────── */

export interface VariationRule {
  channel: string
  market: string
  category: string
  categoryLabel: string
  theme: string | null
  themeOptions: string[]
  axes: Array<{ axisKey: string; target: string; order: number; included: boolean }>
  collisions: { resolver: Resolver; foldInto?: string; foldSeparator: string }
  split: { mode: 'single' | 'per-axis'; axisKey?: string }
  follow: number
  override: number
  /** The channel's sentence about who names an axis (§2 VX.2) — informational, never a control. */
  axisNameNote: string
  valueMaps: Array<{ axisKey: string; mapped: number; unreviewed: number }>
  freeform: boolean
}

export const RULES: VariationRule[] = [
  {
    channel: 'AMAZON', market: 'DE', category: 'OUTERWEAR', categoryLabel: 'OUTERWEAR',
    theme: 'SIZE/COLOR/STYLE', themeOptions: ['SIZE/COLOR', 'SIZE/COLOR/STYLE', 'COLOR', 'SIZE', 'STYLE/COLOR'],
    axes: [
      { axisKey: 'size', target: 'size_name', order: 0, included: true },
      { axisKey: 'color', target: 'color_name', order: 1, included: true },
      { axisKey: 'style', target: 'style_name', order: 2, included: true },
    ],
    collisions: { resolver: 'fold', foldInto: 'size', foldSeparator: ' / ' },
    split: { mode: 'single' },
    follow: 38, override: 3,
    axisNameNote: 'Amazon prints the axis names itself, in the market’s language. The theme decides the attribute keys.',
    valueMaps: [{ axisKey: 'color', mapped: 12, unreviewed: 2 }, { axisKey: 'size', mapped: 0, unreviewed: 0 }],
    freeform: false,
  },
  {
    channel: 'EBAY', market: 'IT', category: '177104', categoryLabel: '177104 · Giacche da moto',
    theme: null, themeOptions: [],
    axes: [
      { axisKey: 'color', target: 'Colore', order: 0, included: true },
      { axisKey: 'size', target: 'Taglia', order: 1, included: true },
      { axisKey: 'style', target: '', order: 2, included: false },
    ],
    collisions: { resolver: 'split', foldSeparator: ' / ' },
    split: { mode: 'single' },
    follow: 26, override: 2,
    axisNameNote: 'The names come from this category’s aspects on the eBay site — “Colore” on ebay.it, “Farbe” on ebay.de. A name that is not an aspect becomes a custom specific and drops out of the filters.',
    valueMaps: [{ axisKey: 'color', mapped: 0, unreviewed: 0 }, { axisKey: 'size', mapped: 4, unreviewed: 0 }],
    freeform: false,
  },
  {
    channel: 'SHOPIFY', market: 'GLOBAL', category: 'OUTERWEAR', categoryLabel: 'OUTERWEAR',
    theme: null, themeOptions: [],
    axes: [
      { axisKey: 'color', target: 'Colour', order: 0, included: true },
      { axisKey: 'size', target: 'Size', order: 1, included: true },
      { axisKey: 'style', target: '', order: 2, included: false },
    ],
    collisions: { resolver: 'fold', foldInto: 'size', foldSeparator: ' / ' },
    split: { mode: 'single' },
    follow: 41, override: 0,
    axisNameNote: 'Shopify takes the English label as the option name. Per-locale translations of the option and its values exist on the platform and are not registered today.',
    valueMaps: [{ axisKey: 'color', mapped: 0, unreviewed: 0 }, { axisKey: 'size', mapped: 0, unreviewed: 0 }],
    freeform: true,
  },
]

export const ruleFor = (channel: string, market: string) =>
  RULES.find((r) => r.channel === channel && r.market === market) ?? RULES[0]

/** What a target listbox offers, per channel (vp2-contracts §1 derivation). */
export const TARGET_OPTIONS: Record<string, Array<{ code: string; label: string }>> = {
  AMAZON: [
    { code: 'size_name', label: 'size_name' }, { code: 'color_name', label: 'color_name' },
    { code: 'style_name', label: 'style_name' }, { code: 'model_name', label: 'model_name' },
  ],
  EBAY: [
    { code: 'Colore', label: 'Colore' }, { code: 'Taglia', label: 'Taglia' },
    { code: 'Scollatura', label: 'Scollatura' }, { code: 'Materiale', label: 'Materiale' },
  ],
  SHOPIFY: [],
  ETSY: [{ code: 'Primary colour', label: 'Primary colour' }, { code: 'Size', label: 'Size' }],
}

/* ── delivery: how a value resolves, and what is pushed (design §5) ─────────────────────────── */

export type ValueTier = 'pin' | 'map' | 'label'

export interface DeliveredValue {
  variantId: string
  axisKey: string
  /** The word the channel receives. */
  out: string
  tier: ValueTier
  /** The provenance sentence — what the cell's mark says on hover. */
  from: string
}

/** Amazon · DE converts colour through a reviewed value map; everything else goes verbatim. */
export function deliveredValue(c: Coordinate, v: Variant, axisKey: string): DeliveredValue {
  const code = v.values[axisKey]
  const label = valueLabel(axisKey, code)
  if (c.key === 'EBAY:IT:2' && axisKey === 'color' && code === 'yellow') {
    return { variantId: v.id, axisKey, out: 'Giallo fluo', tier: 'pin', from: 'Pinned on this listing' }
  }
  if (c.channel === 'AMAZON' && c.market === 'DE' && axisKey === 'color') {
    return { variantId: v.id, axisKey, out: code === 'black' ? 'Schwarz' : 'Gelb', tier: 'map', from: 'Value map · Amazon DE' }
  }
  return { variantId: v.id, axisKey, out: label, tier: 'label', from: 'Shared value' }
}

/** The buyer-facing axis NAME on a coordinate, and where it came from (design §5). */
export function deliveredAxisName(c: Coordinate, axisKey: string): { name: string; source: string } {
  const axis = axisByKey(axisKey)!
  if (c.channel === 'AMAZON') return { name: c.targets[axisKey] ?? axis.key, source: 'Amazon prints the name from the theme' }
  if (c.channel === 'EBAY') return { name: c.targets[axisKey] ?? axis.label, source: 'The site’s aspect name for this category' }
  return { name: c.targets[axisKey] ?? axis.label, source: 'The English label' }
}

/* ── the preview (design §8) ────────────────────────────────────────────────────────────────── */

export interface PreviewPayload {
  format: string
  parent: string
  child: string
}

export const PREVIEWS: Record<string, PreviewPayload> = {
  'EBAY:IT:2': {
    format: 'ebay-trading-xml',
    parent: `<Item>
  <ItemID>385612118904</ItemID>
  <Title>Gale Jacket · Outlet</Title>
  <Variations>
    <VariationSpecificsSet>
      <NameValueList><Name>Taglia</Name>
        <Value>M</Value><Value>L</Value></NameValueList>
      <NameValueList><Name>Colore</Name>
        <Value>Nero</Value><Value>Giallo fluo</Value></NameValueList>
    </VariationSpecificsSet>
  </Variations>
</Item>`,
    child: `<Variation>
  <SKU>GALE-JACKET-BLACK-M-SLIM</SKU>
  <StartPrice>289.00</StartPrice>
  <Quantity>4</Quantity>
  <VariationSpecifics>
    <NameValueList><Name>Taglia</Name><Value>M</Value></NameValueList>
    <NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList>
  </VariationSpecifics>
</Variation>`,
  },
  'AMAZON:DE': {
    format: 'sp-api-listings-item',
    parent: `{
  "productType": "OUTERWEAR",
  "attributes": {
    "parentage_level":  [{ "marketplace_id": "A1PA6795UKMFR9", "value": "parent" }],
    "variation_theme":  [{ "marketplace_id": "A1PA6795UKMFR9", "name": "SIZE/COLOR/STYLE" }]
  }
}`,
    child: `{
  "productType": "OUTERWEAR",
  "attributes": {
    "parentage_level": [{ "marketplace_id": "A1PA6795UKMFR9", "value": "child" }],
    "child_parent_sku_relationship": [{
      "marketplace_id": "A1PA6795UKMFR9",
      "child_relationship_type": "variation",
      "parent_sku": "GALE-JACKET"
    }],
    "variation_theme": [{ "marketplace_id": "A1PA6795UKMFR9", "name": "SIZE/COLOR/STYLE" }],
    "size_name":  [{ "marketplace_id": "A1PA6795UKMFR9", "value": "M" }],
    "color_name": [{ "marketplace_id": "A1PA6795UKMFR9", "value": "Schwarz" }],
    "style_name": [{ "marketplace_id": "A1PA6795UKMFR9", "value": "Slim" }]
  }
}`,
  },
}

export interface PreviewDiff {
  lastPublishedAxes: string[] | null
  added: string[]
  removed: string[]
  renamed: Array<[string, string]>
}

export const PREVIEW_DIFF: Record<string, PreviewDiff> = {
  'EBAY:IT:2': { lastPublishedAxes: ['Color', 'Size'], added: [], removed: [], renamed: [['Color', 'Colore'], ['Size', 'Taglia']] },
  'AMAZON:DE': { lastPublishedAxes: ['size_name', 'color_name'], added: ['style_name'], removed: [], renamed: [] },
}

export const PREVIEW_WARNINGS: Record<string, string[]> = {
  'EBAY:IT:2': ['GALE-JACKET-YELLOW-L-SLIM has no value for Taglia — eBay would refuse the whole listing.'],
  'AMAZON:DE': [],
}

/* ── theme change plans (design §9) ─────────────────────────────────────────────────────────── */

export interface PlanStep { n: number; verb: string; target: string; detail: string; reversible: boolean }

export interface ThemeChangePlan {
  kind: 'amazon-new-parent' | 'ebay-relist' | 'shopify-in-place'
  title: string
  coordinate: string
  from: string
  to: string
  steps: PlanStep[]
  keeps: string[]
  loses: string[]
  note: string
}

export const PLANS: ThemeChangePlan[] = [
  {
    kind: 'amazon-new-parent', title: 'Change variation theme', coordinate: 'Amazon · DE',
    from: 'SIZE/COLOR', to: 'SIZE/COLOR/STYLE',
    steps: [
      { n: 1, verb: 'PUT', target: 'GALE-JACKET-P2', detail: 'A new parent SKU carrying the new theme.', reversible: true },
      { n: 2, verb: 'PATCH', target: '12 children', detail: 'child_parent_sku_relationship → the new parent, variation_theme → SIZE/COLOR/STYLE, plus style_name.', reversible: true },
      { n: 3, verb: 'READ', target: '12 children', detail: 'Read back after 8 s and confirm every child answers with the new parent.', reversible: true },
      { n: 4, verb: 'DELETE', target: 'B0F7J163XJ', detail: 'The old parent listing, once every child has moved.', reversible: false },
    ],
    keeps: ['Child ASINs', 'Reviews', 'Sales history', 'Offers and prices'],
    loses: ['The parent ASIN and its URL', 'A+ content attached to the parent', 'Ads targeting the parent ASIN'],
    note: 'Amazon’s own procedure for its 2025 theme removal. A theme cannot be changed in place, and parent and children must carry the same theme in one submission or the 8541 family of errors fires. The Nexus product does not change — the parent listing’s external id does.',
  },
  {
    kind: 'ebay-relist', title: 'Relist with new specifics', coordinate: 'eBay · IT ② Outlet',
    from: 'Taglia · Colore', to: 'Taglia · Colore · Stile',
    steps: [
      { n: 1, verb: 'END', target: 'Item 385612118904', detail: 'The live listing ends. Its ItemID cannot be reused.', reversible: false },
      { n: 2, verb: 'RELIST', target: 'A new item', detail: 'Same SKUs, EANs, prices and stock, echoed from the listing that ended.', reversible: true },
      { n: 3, verb: 'RELINK', target: 'The alias row', detail: 'The alias points at the new ItemID.', reversible: true },
    ],
    keeps: ['SKUs', 'EANs', 'Prices', 'Stock'],
    loses: ['The ItemID', 'Watchers', 'Sales history on the item', 'Best-match age'],
    note: 'Proven live on 2026-07-25: eBay identifies a variation BY its specifics, so an in-place rename is rejected (code 21916664) and the whole revise is refused. Reordering specifics and adding values are a revise and never reach this plan.',
  },
  {
    kind: 'shopify-in-place', title: 'Change options', coordinate: 'Shopify',
    from: 'Colour · Size', to: 'Colour · Size · Style',
    steps: [
      { n: 1, verb: 'CREATE', target: 'Option “Style”', detail: 'productOptionsCreate. Every existing variant receives a value for the new option.', reversible: true },
      { n: 2, verb: 'UPDATE', target: '12 variants', detail: 'productOptionUpdate sets each variant’s Style value.', reversible: true },
    ],
    keeps: ['Variant ids', 'Inventory', 'Prices', 'The product URL'],
    loses: ['Nothing, when the constraints below hold'],
    note: 'Shopify allows this in place with a variant strategy, under two rules the plan checks first: option positions stay sequential, and every remaining option is used by at least one variant.',
  },
]

/* ── the catalogue (design §11.4) ───────────────────────────────────────────────────────────── */

export type CatalogueState = 'follows' | 'overridden' | 'collides' | 'missing' | 'theme-unset'

export interface CatalogueRow {
  id: string
  sku: string
  name: string
  variants: number
  state: CatalogueState
  detail: string
}

export const CATALOGUE: CatalogueRow[] = [
  { id: 'gale', sku: 'GALE-JACKET', name: 'Gale Jacket', variants: 12, state: 'collides', detail: '2 groups on Shopify' },
  { id: 'misano', sku: 'MISANO', name: 'Misano Glove', variants: 8, state: 'overridden', detail: 'Amazon · IT' },
  { id: 'aireon', sku: 'AIREON', name: 'Aireon Helmet', variants: 6, state: 'follows', detail: 'Apparel default' },
  { id: 'xri01', sku: 'XRI01', name: 'XR Intercom', variants: 4, state: 'missing', detail: 'eBay · IT has no mapping' },
  { id: 'tarn', sku: 'TARN-BOOT', name: 'Tarn Boot', variants: 10, state: 'theme-unset', detail: 'Amazon · DE' },
  { id: 'vela', sku: 'VELA-VEST', name: 'Vela Vest', variants: 5, state: 'follows', detail: 'Apparel default' },
]

export const CATALOGUE_FILTERS: Array<{ id: CatalogueState | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'follows', label: 'Follows rule' },
  { id: 'overridden', label: 'Overridden' },
  { id: 'collides', label: 'Collisions' },
  { id: 'missing', label: 'Missing' },
  { id: 'theme-unset', label: 'Theme unset' },
]

/** What the bulk verb's dry run answers before anything is written (§11.4). */
export const BULK_DRY_RUN = {
  families: 14,
  overridesRemoved: 3,
  newCollisions: 0,
  skipped: [{ sku: 'GALE-JACKET', reason: '2 unresolved collisions on Shopify' }],
}

/* ── what each channel accepts (design §7) ──────────────────────────────────────────────────── */

export const CHANNEL_FACTS = [
  {
    channel: 'Amazon', axes: 'The theme’s segments (1–3)', variants: 'No sourced cap',
    name: 'Amazon’s own, localised by Amazon', setPerMarket: 'Yes — relationships are per marketplace',
    change: 'New parent and relink — never in place',
  },
  {
    channel: 'eBay', axes: '5 specifics', variants: '250',
    name: 'The site’s aspect name', setPerMarket: 'Yes, once the set moves to the listing row',
    change: 'End and relist',
  },
  {
    channel: 'Shopify', axes: '3 options', variants: '100',
    name: 'Free; translatable per locale', setPerMarket: 'One store, one set',
    change: 'In place, with a variant strategy',
  },
  {
    channel: 'Etsy', axes: '2 properties', variants: '70',
    name: 'The property list', setPerMarket: 'Per shop',
    change: 'Relist',
  },
]

/* ── the changes this design asks for (design §13 and the change table) ─────────────────────── */

export const CHANGES = [
  { store: 'Product.variationAxes', today: 'Free strings — “Colore”, “Taglia”', after: 'Canonical keys, each a CustomAttribute with scope per_variant', lane: 'VX.1' },
  { store: 'Child axis values', today: 'Free text in two bags — two XXS rows read “XS”', after: 'AttributeOption code plus label; a string stays valid until backfilled', lane: 'VX.1' },
  { store: 'MarketplaceSchemaMapping', today: 'fields · byProductType · expressions', after: 'A variations block, per category and channel-wide', lane: 'VX.1' },
  { store: 'ChannelListing.variationTheme / variationMapping', today: 'Null on 978 of 999 rows, meaning nothing', after: 'Null means FOLLOWS RULE; set means overridden here; Reset to rule nulls both', lane: 'VX.1' },
  { store: 'eBay axis set', today: 'Product.variationTheme wins — one set for every market and alias', after: 'The coordinate’s stored axes win when set, so a set is per market and per alias', lane: 'VX.1' },
  { store: 'Shopify options', today: 'Seeded from family.variationAxes; the mapping is never read', after: 'From the projection — the rule combined with the override', lane: 'VX.1' },
  { store: 'Projection PATCH', today: 'Limit · duplicate target · lock', after: 'And the collision rule — 400 until a resolver can run', lane: 'VX.1' },
  { store: 'FieldValueMap', today: 'Value maps per channel and market', after: 'Unchanged — the only place a market word enters', lane: '—' },
  { store: 'Readiness', today: 'No variation items', after: 'Mapping missing · collision · unreviewed map · theme unset', lane: 'VX.4' },
  { store: 'Preview', today: 'None', after: 'The adapters in dry-run, no HTTP — one composer, never a second', lane: 'VX.1' },
  { store: 'Theme change', today: 'None', after: 'A dry-run plan per channel; the live executor is a separate approval', lane: 'VX.1' },
  { store: 'Scope bar', today: 'listingId and a Clear button', after: 'A listing listbox; New listing held until aliases can be created', lane: 'VX.3' },
  { store: 'Projection words', today: 'Five', after: 'Six — Collides', lane: 'VX.3' },
]
