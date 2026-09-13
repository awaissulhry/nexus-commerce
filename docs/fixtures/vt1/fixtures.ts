/**
 * VT.1 fixtures for the Variation theme column — `docs/vt1-contracts.md` §6.
 *
 * SELF-CONTAINED on purpose: no imports, so VT.2 can import or copy this file from anywhere
 * (apps/web, apps/factory, a story, a node test) without pulling the API's graph in.
 *
 * Every value is a reading taken 2026-09-13 on the LOCAL Docker database
 * (`127.0.0.1:55439/nexus_development`, GALE-JACKET `Product.version` 59) and the LIVE eBay taxonomy —
 * the readings are in `docs/pes-claims.md` under "VT.1 Phase 0". Copy strings are the design's Appendix A.
 *
 * Nothing here is a guess. Where a coordinate genuinely cannot answer (eBay·DE has no category), the fixture
 * carries the unavailable state rather than a plausible-looking name.
 */

export interface VariationThemeAxis {
  axisKey: string
  familyKey: string
  label: string
  channelName: string
  target: string | null
  included: boolean
  segment?: string
  unbound?: { reason: string }
}

export interface VariationThemeCell {
  axes: VariationThemeAxis[]
  theme: { code: string; label: string; deprecated: boolean } | null
  source: {
    kind: 'derived' | 'rule' | 'override' | 'none'
    ruleLabel: string | null
    category: string | null
    label: string
    tieBreak?: 'bare-form' | 'only-match' | 'only-live' | 'set-order' | 'kept-from-listing'
  }
  candidates: {
    kind: 'theme-enum' | 'aspects' | 'free'
    items: Array<{ code: string; label: string; coversAll: boolean; drops: string[]; deprecated: boolean; required?: boolean }>
    limit: number | null
    schemaFetchedAt: string | null
    state: 'ok' | 'freeform' | 'unavailable'
    unavailableReason?: string
  } | null
  masterCandidates: Array<{ key: string; label: string; axisKey: string; valueCount: number }> | null
  dropped: string[]
  collisions: { unresolved: number; summary: string } | null
  locked: { reason: string; externalId: string | null; setChangeIs: 'relist' | 'new-parent' | 'in-place'; orderChangeAllowed: boolean } | null
  write: {
    endpoint: 'variation-axes' | 'projection'
    expectedVersion: number
    aliasKey: string
    coordinate: { channel: string | null; market: string; accountId: string | null }
    childIds?: string[]
  } | null
  writable: boolean
  writeBlockedReason: string | null
  vocabulary: { axisNoun: string; axisNounPlural: string; sectionTitle: string }
  separator: string
}

/** GALE-JACKET's 20 child ids on the local database, in SKU order — what `variation-axes` requires back. */
export const GALE_CHILD_IDS: string[] = [
  'cmokmy0jf0003pm0ppnu1b2yy', 'cmokmy0jt0004pm0p0gaufo1b', 'cmokmy2ir005bpm0p0sm1rxx8', 'cmokmy0k70005pm0puvz2ucxu',
  'cmokmy0kl0006pm0p9auaundx', 'cmokmy0ky0007pm0p3vj7q0mh', 'cmokmy0lc0008pm0p2thzmlqq', 'cmokmy0lr0009pm0p9yxk7ho0',
  'cmokmy0m9000apm0pm52rd77m', 'cmokmy0mm000bpm0pm7k7eke4', 'cmokmy0n4000cpm0ptkjitr0f', 'cmokmy0ni000dpm0p2xvcpkma',
  'cmokmy0o1000epm0pca79fbbf', 'cmokmy0og000fpm0pdwckcnq0', 'cmokmy0ot000gpm0p4z5vwnoo', 'cmokmy0p6000hpm0ptee51htd',
  'cmokmy0pk000ipm0pi8nl7pbn', 'cmokmy0py000jpm0pc2jcd5ul', 'cmokmy0qb000kpm0p06pmx2vt', 'cmokmy0qp000lpm0p2yxw35ku',
]

/**
 * 1 · MASTER — the structure itself. English labels, family order, no provenance mark on screen (master IS
 * the source). `theme` and `candidates` are null; the candidates are the per-variant editable scalar columns.
 */
export const GALE_MASTER: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Color', target: 'color', included: true },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Size', target: 'size', included: true },
  ],
  theme: null,
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
  candidates: null,
  masterCandidates: [
    { key: 'color', label: 'Color', axisKey: 'color', valueCount: 2 },
    { key: 'size', label: 'Size', axisKey: 'size', valueCount: 10 },
  ],
  dropped: [],
  collisions: null,
  locked: null,
  write: {
    endpoint: 'variation-axes',
    expectedVersion: 59,
    aliasKey: '',
    coordinate: { channel: null, market: 'IT', accountId: null },
    childIds: GALE_CHILD_IDS,
  },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'axis', axisNounPlural: 'axes', sectionTitle: 'Variation axes' },
  separator: ' · ',
}

/**
 * 2 · AMAZON · DE — DERIVED, and the tie-break that decides 100% of the catalogue.
 *
 * `[color,size]` matches BOTH `COLOR/SIZE` and `COLOR_NAME/SIZE_NAME` in order (35/35 pairs, T14). The bare
 * form wins — and Amazon's own `$lifecycle.enumDeprecated` marks `COLOR_NAME/SIZE_NAME` DEPRECATED on this
 * product type, so the choice is derived from the schema, not from a preference.
 * Label = the BOUND attributes' titles (`Farbe`, `Größe`), never `enumNames` (`FARBE/GRÖSSE`, machine-cased).
 */
export const GALE_AMAZON_DE_DERIVED: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Farbe', target: 'color', included: true, segment: 'COLOR' },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Größe', target: 'size', included: true, segment: 'SIZE' },
  ],
  theme: { code: 'COLOR/SIZE', label: 'Farbe / Größe', deprecated: false },
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes', tieBreak: 'only-live' },
  candidates: {
    kind: 'theme-enum',
    items: [
      { code: 'COLOR/SIZE', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: false },
      { code: 'SIZE/COLOR', label: 'Größe / Farbe', coversAll: true, drops: [], deprecated: false },
      { code: 'COLOR_NAME/SIZE_NAME', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: true },
      { code: 'SIZE_NAME/COLOR_NAME', label: 'Größe / Farbe', coversAll: true, drops: [], deprecated: true },
      { code: 'COLOR', label: 'Farbe', coversAll: false, drops: ['size'], deprecated: false },
      { code: 'COLOR/MATERIAL', label: 'Farbe / Material', coversAll: false, drops: ['size'], deprecated: false },
      { code: 'SIZE', label: 'Größe', coversAll: false, drops: ['color'], deprecated: false },
      { code: 'COLOR_NAME', label: 'Farbe', coversAll: false, drops: ['size'], deprecated: true },
    ],
    limit: 4,
    schemaFetchedAt: '2026-09-12T14:52:54.095Z',
    state: 'ok',
  },
  masterCandidates: null,
  dropped: [],
  collisions: null,
  locked: {
    reason: 'Live on Amazon DE (B0D8XBXM5H) — changing the theme creates a new parent and relinks 20 children. Commit opens the plan.',
    externalId: 'B0D8XBXM5H',
    setChangeIs: 'new-parent',
    orderChangeAllowed: false,
  },
  write: {
    endpoint: 'projection',
    expectedVersion: 13,
    aliasKey: '',
    coordinate: { channel: 'AMAZON', market: 'DE', accountId: null },
  },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'theme', axisNounPlural: 'themes', sectionTitle: 'Variation theme' },
  separator: ' / ',
}

/**
 * 3 · eBay · IT — OVERRIDDEN on this coordinate. The parent listing row carries `"Color,Size"` and all 19
 * child rows carry it too (measured on local); the names DELIVERED are the site's variation-enabled aspects.
 * Live item 257584954808: changing the SET relists; reordering does not (Appendix A lock copy).
 */
export const GALE_EBAY_IT_OVERRIDDEN: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Colore', target: 'Colore', included: true },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Taglia', target: 'Taglia', included: true },
  ],
  theme: null,
  source: { kind: 'override', ruleLabel: null, category: null, label: 'Overridden here' },
  candidates: {
    kind: 'aspects',
    items: [
      { code: 'Taglia', label: 'Taglia', coversAll: false, drops: [], deprecated: false, required: false },
      { code: 'Colore', label: 'Colore', coversAll: false, drops: [], deprecated: false, required: false },
      { code: 'Scollatura', label: 'Scollatura', coversAll: false, drops: [], deprecated: false, required: false },
    ],
    limit: 5,
    schemaFetchedAt: null,
    state: 'ok',
  },
  masterCandidates: null,
  dropped: [],
  collisions: null,
  locked: {
    reason: 'Live on eBay IT (item 257584954808) — changing the set relists it. Reordering does not.',
    externalId: '257584954808',
    setChangeIs: 'relist',
    orderChangeAllowed: true,
  },
  write: {
    endpoint: 'projection',
    expectedVersion: 18,
    aliasKey: '',
    coordinate: { channel: 'EBAY', market: 'IT', accountId: null },
  },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  separator: ' · ',
}

/** 4 · eBay · DE — the honest "could not look" state: no category on the listing, so no aspects to bind to. */
export const GALE_EBAY_DE_UNAVAILABLE: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Color', target: null, included: true,
      unbound: { reason: 'This eBay DE listing has no category yet, so its variation specifics cannot be read.' } },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Size', target: null, included: true,
      unbound: { reason: 'This eBay DE listing has no category yet, so its variation specifics cannot be read.' } },
  ],
  theme: null,
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
  candidates: {
    kind: 'aspects',
    items: [],
    limit: 5,
    schemaFetchedAt: null,
    state: 'unavailable',
    unavailableReason: 'This eBay DE listing has no category yet, so its variation specifics cannot be read.',
  },
  masterCandidates: null,
  dropped: [],
  collisions: null,
  locked: null,
  write: {
    endpoint: 'projection',
    expectedVersion: 7,
    aliasKey: '',
    coordinate: { channel: 'EBAY', market: 'DE', accountId: null },
  },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  separator: ' · ',
}

/** 5 · A CHILD row — the `—` state, `Set on the parent`. The cell VALUE is null. */
export const GALE_CHILD: null = null
export const GALE_CHILD_WRITE_BLOCKED_REASON = 'Set on the parent'

/**
 * 6 · SHOPIFY with a DROPPED axis and a COLLISION — the `n dropped` + `collides` states.
 * A three-axis family (`color × size × style`) on a coordinate that delivers two: `style` is dropped and the
 * variants that differed only by style can no longer be told apart.
 */
export const GALE_SHOPIFY_DROPPED: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Color', target: 'Color', included: true },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Size', target: 'Size', included: true },
    { axisKey: 'style', familyKey: 'Stile', label: 'Style', channelName: 'Style', target: null, included: false },
  ],
  theme: null,
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
  candidates: { kind: 'free', items: [], limit: 3, schemaFetchedAt: null, state: 'freeform' },
  masterCandidates: null,
  dropped: ['style'],
  collisions: { unresolved: 2, summary: '2 variants cannot be told apart on Shopify after Style is dropped.' },
  locked: null,
  write: {
    endpoint: 'projection',
    expectedVersion: 4,
    aliasKey: '',
    coordinate: { channel: 'SHOPIFY', market: 'GLOBAL', accountId: null },
  },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'option', axisNounPlural: 'options', sectionTitle: 'Options' },
  separator: ' · ',
}

/** 7 · AMAZON, nothing matches — the `Choose a theme` state and readiness `theme-unset`. */
export const AMAZON_THEME_UNSET: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Color', target: null, included: true,
      unbound: { reason: 'No theme on this product type covers this family’s axes.' } },
  ],
  theme: null,
  source: { kind: 'none', ruleLabel: null, category: null, label: 'Choose a theme' },
  candidates: {
    kind: 'theme-enum',
    items: [{ code: 'SIZE', label: 'Taglia', coversAll: false, drops: ['color'], deprecated: false }],
    limit: 4,
    schemaFetchedAt: '2026-09-12T14:51:37.132Z',
    state: 'ok',
  },
  masterCandidates: null,
  dropped: [],
  collisions: null,
  locked: null,
  write: { endpoint: 'projection', expectedVersion: 87, aliasKey: '', coordinate: { channel: 'AMAZON', market: 'IT', accountId: null } },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'theme', axisNounPlural: 'themes', sectionTitle: 'Variation theme' },
  separator: ' / ',
}

/** Keyed by scope label, for a story or a test that walks every state. */
export const VT1_FIXTURES: Record<string, VariationThemeCell | null> = {
  master: GALE_MASTER,
  'Amazon · DE': GALE_AMAZON_DE_DERIVED,
  'Amazon · IT (unset)': AMAZON_THEME_UNSET,
  'eBay · IT': GALE_EBAY_IT_OVERRIDDEN,
  'eBay · DE (unavailable)': GALE_EBAY_DE_UNAVAILABLE,
  'Shopify (dropped + collides)': GALE_SHOPIFY_DROPPED,
  child: GALE_CHILD,
}
