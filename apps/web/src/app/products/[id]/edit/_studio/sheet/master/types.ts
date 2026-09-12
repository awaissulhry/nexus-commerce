/**
 * PES.2 — the master sheet's wire contract.
 *
 * Written against **PES.5 §3.2** (`GET /api/products/:id/studio/sheet`), not against the
 * catalogue-wide `GET /api/products/sheet` that exists today. The studio route is approved
 * (hub ruling #8) and being built; coding to the older shape and migrating later would mean
 * writing the provenance layer twice, since the whole point of `StudioCellValue` is that the
 * SERVER states the layer instead of the grid inferring it.
 *
 * Until that route answers, `adaptLegacy.ts` converts the live catalogue read into this shape and
 * marks the result `source: 'legacy'` so the sheet can say on screen which read it is showing.
 * Nothing in the component knows the difference; the adapter is the only thing that does.
 *
 * Hand-written rather than imported: apps/web does not import from apps/api. Asserted against a
 * live response by `verifyContract()` below, so a drift is a loud message and not a blank column.
 */

export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'
/** `listing` (AM.1) — a store that exists only on the ChannelListing; such a column appears on channel scopes only. */
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent' | 'listing'

/** PES.5 §3.2. `linked` is a FieldLinkGroup; `default` is the schema's own fallback. */
export type CellLayer = 'master' | 'variant' | 'alias' | 'aliasVariant' | 'channel' | 'linked' | 'default'

export interface SheetColumn {
  managedBy?: 'productMedia'
  familyRules?: Record<string, { required: boolean; sortOrder: number }>
  validation?: Record<string, unknown>
  /**
   * 🔴 PES.5's `formulaWritable` — may a cell FORMULA be stored on this column (#753(b)).
   *
   * It was on the wire and missing from this mirror, which is the banked wire→UI drift: the client
   * cannot consume a field it does not declare, and nothing fails when it silently does not. Derived
   * server-side from the formula writer's own allow-list, so it cannot disagree with what the writer
   * will actually accept — measured `true` for `manufacturer`/`name`/`basePrice`, `false` for
   * `fabric_type`/`item_name`/`country_of_origin`/`color`.
   *
   * Optional because an older server does not send it, and absence is UNKNOWN rather than "no" —
   * see `formulaAvailability`.
   */
  formulaWritable?: boolean
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  label: string
  group: string
  /** Stable canonical group ID. Older server responses may omit it. */
  groupKey?: string
  kind: SheetColumnKind
  storage: SheetStorage
  scope: 'global' | 'per_variant'
  /**
   * This column IS one of the family's variation axes, as the SERVER derived it
   * (`sheet-columns.service.ts:115`): `scope === 'per_variant'` AND an exact, case-insensitive
   * match against the family's axis KEYS — the stored spelling, never a label and never a substring.
   *
   * 🔴 Optional because the BASE column set is built without a family and cannot know; but
   * `/studio/sheet` always sets it (PES.5 verified all 102 columns carry it). So consumers test
   * `=== true`: `undefined` means "this did not come from that endpoint", which must not read as
   * "not an axis" by default.
   */
  axis?: boolean
  options?: string[]
  optionLabels?: Record<string, string>
  mode?: 'strict' | 'open'
  requiredBy: string[]
  /**
   * 🔴 `| null` because the MIRROR is deliberately wider than the contract — **not** because the
   * server sends null. It does not.
   *
   * I wrote "measured on `product_description`, live: `maxLength: null`" here. **I had not measured
   * it.** It arrived in a relayed ruling, I restated it in a source comment as my own measurement,
   * and it was copied into a second file and quoted onward as established fact before anyone
   * checked. AG.1 traced the producer and challenged it; the actual reading, taken since, is:
   *
   *     product_description → { maxBytes: 20000 }        // `maxLength` is ABSENT, not null
   *     columns with maxLength === null:  0
   *     columns where maxLength is absent: 60 of 96
   *
   * (`schema-caps.ts:99` coerces to `undefined`, and `/studio/columns` declares no response schema,
   * so `JSON.stringify` omits it.)
   *
   * **Keep the `| null` anyway.** A consumer may be wider than its producer and must never be
   * narrower. The tempting "tidy-up" — diffing this mirror against the server type, seeing `| null`
   * against `?:`, and narrowing to match — would reintroduce #397 with a diff that reads as
   * drift-correction.
   *
   * The lesson is the comment, not the type: a claim stated in source outlives the memory of how it
   * was established. Mine lasted four hours and two files.
   */
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  editable: boolean
  width?: number
  helpText?: string
  /** A hint about what a NARROW landing view might show. Views decide visibility, not this. */
  defaultVisible: boolean
  deprecatedOptions?: string[]
  // ── AM.1 (2026-09-05) — the shape vocabulary, mirrored from `sheet-columns.service.ts` ─────────
  // All OPTIONAL: an older server omits them and every consumer must read absence as `scalar`.
  /** Default `scalar`. A `list` column's value is an array; a `measure` column's is `{ value, unit }`. */
  shape?: 'scalar' | 'list' | 'measure'
  /** list only. `max: null` = unbounded. A bounded list ≤ 10 arrives as slot columns instead. */
  cardinality?: { min: number; max: number | null }
  /** measure only. */
  unitOptions?: string[]
  /** This column is slot `index` (1-based) of the list `of`; the list itself is not a column. */
  slot?: { of: string; index: number; max: number; label: string }
  /** eBay: the aspect may vary per variation (informational — `scope` decides locking). */
  variantEligible?: boolean
  /** Every declaring channel hides it in its own UI. Still a column. */
  hidden?: boolean
  /** Each coordinate's own facts about this column, by coordinate label (`Amazon · IT`). */
  channels?: Record<string, {
    key: string
    attribute: string
    path: string[]
    label: string
    requirement: 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'
    cardinality: { min: number; max: number | null }
    maxLength?: number
    maxBytes?: number
    options?: string[]
    mode?: 'strict' | 'open'
    store?: { kind: 'listingColumn'; column: string; followFlag?: string } | { kind: 'platformAttributes'; path: string[]; unitPath?: string[] }
    selectors?: string[]
    hidden: boolean
    editableOnExisting: boolean
    categories: string[]
  }>
}

export interface StudioCellValue {
  requestedLocale?: string
  effectiveLocale?: string
  needsTranslation?: boolean
  translationState?: 'current' | 'missing' | 'fallback' | 'draft' | 'reviewed' | 'outdated'
  value: unknown
  /**
   * The resolver's `ValueSource`. REQUIRED: PES.5 §3.2 defines `StudioCellValue` as
   * `SheetCellValue` plus extras, and `SheetCellValue.source` is not optional. Both reads send it.
   */
  source: string
  inheritedFrom: string | null
  inherited: boolean
  /** PES.5: which layer supplied this value. Authoritative when present. */
  layer?: CellLayer
  /** PES.5: this layer stores its own value — the ✎ glyph. */
  pinned?: boolean
  /** PES.5: `followMaster*` for the six flagged fields; null/absent for everything else. */
  follows?: boolean | null
  editable?: boolean
  linkGroupId?: string | null
  /**
   * PES.6's mapping engine: what this cell WOULD ship as, beside — never replacing — `value`.
   *
   * Narrowed from `unknown` for §9.6: the provenance classifier reads `status` to decide whether
   * this cell wears the derived mark, and `unknown` cannot be read at all without a cast. Only the
   * field the classifier needs is declared — the channel lane's fuller `MappedCell` satisfies this
   * structurally, and a local mirror of a server type must ADD fields, never relax the constraint.
   *
   * 🔴 `status: 'unmapped'` means the engine RAN and matched nothing. That is not a derived value
   * and must not wear the mark.
   */
  mapped?: { status?: string } | null
  /** PES.5 hands these over so the grid never re-derives where a cell writes. */
  writeField?: string
  writeTarget?: 'master' | 'channelListing'
}

export interface ReadinessIssue {
  key: string
  label: string
  message: string
  severity: 'error' | 'warn'
}

export interface RowReadiness {
  state: 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'
  issues: ReadinessIssue[]
  ref?: string
}

export interface MasterCompleteness {
  overall: { filled: number; total: number; pct: number }
  required: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
  byGroup: Array<{ group: string; filled: number; total: number }>
}

/**
 * One channel listing on a row, keyed `CHANNEL:MARKETPLACE`.
 *
 * Restored after PES.4's drawer needed it: PES.5 §3.2 defines `StudioRow` as `SheetRow` *plus* the
 * alias axis, and `listings` is one of the fields it inherits. Dropping it from this mirror made
 * the row shape quietly narrower than the contract — the kind of drift `verifyContract` exists to
 * catch on the wire and a hand-written mirror cannot catch on its own.
 */
export interface SheetListing {
  id: string
  listingStatus: string
  isPublished: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  follows: Record<string, boolean>
}

export interface StudioRow {
  productMedia?: Array<{ id: string; type: string; preview: string | null; alt: string }>
  productMediaError?: string
  productRole?: import('@nexus/shared/master-sheet').ProductRole
  parentSku?: string | null
  familyId?: string | null
  id: string
  sku: string
  /**
   * The face image, for the pinned identity cell (ruling #169: "the picture on the left").
   *
   * 🔴 OPTIONAL because the studio sheet contract does NOT supply it today — measured on the live
   * route: no `imageUrl` on any row, no image column among the 102. Requested from PES.5. Until it
   * lands the identity cell renders exactly as before rather than a column of grey placeholders,
   * which is the empty-column problem the Owner rejected, one column wide.
   *
   * When it lands it must be derived with the SERVER's `pickFaceImage`
   * (`product-read-cache.service.ts:42` — isPrimary → MAIN → lowest sortOrder), which is the same
   * rule PES.7's client `pickFaceImage` applies in the drawer. Same rule, so the grid thumbnail and
   * the drawer's main image cannot disagree.
   */
  imageUrl?: string | null
  /** How many images the record has — the "+N" badge on the thumbnail. Same source as above. */
  photoCount?: number
  /**
   * True when `imageUrl` is the PARENT's face image because this row has none of its own.
   *
   * 🔴 Not cosmetic. PES.5 measured 74 of 301 children (25%) with zero own images, so the fallback
   * fires on a quarter of the catalogue — and a thumbnail sitting beside `photoCount: 0` reads as a
   * bug unless the row says whose picture it is. Rendered with the SAME `inherited` provenance the
   * sheet already uses for every borrowed value (🔗, `--nds-info-strong`), not a new treatment:
   * a second visual vocabulary for one idea is the inconsistency the design rules exist to prevent.
   */
  imageInherited?: boolean
  name: string | null
  /**
   * The row's variation-axis values, keyed by the family's axis KEYS as stored — `{Size:'XS',
   * Color:'Nero'}`. Present on every row from `/studio/sheet` (PES.5 verified 21/21).
   *
   * 🔴 The PARENT carries `{}`, not an absent key, so `'axisValues' in row` and any truthiness test
   * report that a parent HAS axis values — `{}` is truthy. Test EMPTINESS. `identitySecondary.ts`
   * is the one place that decides anything from this.
   *
   * 🔴 It was missing from this mirror while the wire carried it on every row, so the band could not
   * show a second line the server had already answered — the banked wire→UI parse drift, found by
   * PES.5 rather than by anything here. Optional because a legacy/adapted read may not carry it.
   */
  axisValues?: Record<string, string>
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  /** The optimistic-concurrency token. `SheetWriter` owns advancing it. */
  version: number
  basePrice: number | null
  childCount: number
  rowKind?: 'parent' | 'variant'
  aliasId?: string | null
  values: Record<string, StudioCellValue>
  /**
   * STUDIO shape: the row's listing on the CURRENT scope's coordinate — `null` on master, which
   * has no channel. Singular, and verified against the live route rather than the doc.
   */
  listing?: SheetListing | null
  /** STUDIO shape: ONE verdict for this row in this scope. */
  readiness?: RowReadiness
  /**
   * LEGACY shape only: the catalogue-wide read answers a verdict PER channel coordinate, which the
   * studio route does not (a master scope has one readiness, not one per channel). Kept separate
   * rather than union-typed so a caller cannot read one shape believing it is the other, and so the
   * sheet can render the richer per-coordinate columns when — and only when — it actually has them.
   */
  readinessByCoordinate?: Record<string, RowReadiness>
  completeness: MasterCompleteness
}

export interface SheetCoordinate {
  languages?: string[]
  channel: string
  marketplace: string
  label: string
  inMarket: boolean
}

export interface StudioSheet {
  scope: { kind: 'master' | 'channel'; channel?: string; marketplace?: string; label: string; locale: string }
  family: { id: string; sku: string; name: string | null; productType: string | null; variationAxes: string[] }
  columns: SheetColumn[]
  /** LEGACY read only — the studio route scopes readiness instead of listing coordinates. */
  coordinates?: SheetCoordinate[]
  /** PES.3's alias groups. `[]` on master. */
  aliases?: unknown[]
  rows: StudioRow[]
  /** Server-declared view presets, when the studio route supplies them (PES.5 §3.1). */
  views?: Array<{ id: string; label: string; columnKeys: string[] }>
  meta: {
    schemaMissing: string[]
    schemaAge: Array<{ productType: string; fetchedAt: string }>
    droppedKeys: string[]
    tookMs?: number
    /**
     * Which read produced this. `legacy` means the studio route was not available and the
     * catalogue-wide read was adapted — the sheet SAYS so rather than presenting adapted
     * provenance as if the server had stated it.
     */
    source: 'studio' | 'legacy'
  }
}

/**
 * Assert a response is actually the shape above.
 *
 * Not paranoia: this contract is hand-mirrored across an app boundary, it is being written by
 * another session right now, and the failure mode without a check is a sheet of blank columns that
 * looks like an empty catalogue rather than a contract drift. Returns the problems; the caller
 * decides whether to render or shout.
 */
export function verifyContract(body: unknown): string[] {
  const problems: string[] = []
  const b = body as Partial<StudioSheet> | null
  if (!b || typeof b !== 'object') return ['response is not an object']
  if (!Array.isArray(b.columns)) problems.push('columns[] missing')
  if (!Array.isArray(b.rows)) problems.push('rows[] missing')
  if (!b.family?.id) problems.push('family.id missing')
  if (!b.scope?.locale) problems.push('scope.locale missing')
  if (Array.isArray(b.rows) && b.rows.length > 0) {
    const r = b.rows[0]
    if (typeof r.version !== 'number') problems.push('rows[0].version is not a number — optimistic concurrency would be unarmed')
    if (!r.values || typeof r.values !== 'object') problems.push('rows[0].values missing')
  }
  return problems
}
