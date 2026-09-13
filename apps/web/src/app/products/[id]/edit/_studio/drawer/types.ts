import type { ListingPresenceFields } from '../presence/fields'
/**
 * PES.4 — the drawer's contracts.
 *
 * Three of these four groups MIRROR types that already exist on the API side and are the shapes
 * the sheet is already reading; they are restated here (not imported) because `apps/web` does not
 * depend on `apps/api`. The source of truth for each is named above it — when PES.2 lands a shared
 * `_studio/sheet/contract.ts`, this file re-exports from there instead of restating.
 *
 * The point of the drawer is that it opens on the row object the GRID ALREADY HOLDS. `SheetRow`
 * carries the resolved value, its provenance, the per-channel listings, readiness and completeness
 * — everything the record form renders. So opening costs no fetch. Only history and compare, which
 * nothing on the sheet needs, are fetched, and only when their pane is looked at.
 */

// ────────────────────────────────────────────────────────────────────
// 1. The sheet's shapes — mirror of apps/api/src/services/pim/sheet-{columns,rows}.service.ts
// ────────────────────────────────────────────────────────────────────

export type SheetChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
/** `'variationTheme'` — VT.2 (2026-09-13, additive): the drawer receives the sheet's columns, so a
 *  kind this mirror cannot name makes the whole `columns` array unassignable. The drawer renders it
 *  through its existing default path; the editor is the cell's and the dock's (design §3.5). */
export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date' | 'variationTheme'
/** `listing` (AM.1) — a store that exists only on the ChannelListing; such a column appears on channel scopes only. */
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent' | 'listing'
/**
 * The ROW readiness vocabulary. NOT restated here — PES.2's `readiness.ts` is the one definition
 * of both vocabularies (programme §3, hub ruling #11), and a second copy of the same five strings
 * is how two surfaces end up disagreeing about a family after one of them gains a sixth state.
 * Aliased rather than re-exported under its own name so existing references keep reading.
 */
export type { RowReadinessState } from '@/design-system/grid/renderers/readiness'
import type { RowReadinessState } from '@/design-system/grid/renderers/readiness'
/* The formula seam's wire shapes come from the engine, NOT restated here: `DrawerFormulas` is
   satisfied by the host's own `useCellFormulas` object, so these two must be the identical types or
   the pass-through would need an adapter that could drift from what the server actually sends. */
import type { FormulaFunctionDoc, FormulaPreviewResponse } from '@/design-system/grid'

export type ReadinessState = RowReadinessState

export interface SheetCoordinate {
  languages?: string[]
  channel: SheetChannel
  marketplace: string
}

export interface SheetColumn {
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field` (`attr_*` keeps its prefix). */
  writeField: string
  label: string
  group: string
  kind: SheetColumnKind
  storage: SheetStorage
  scope: 'global' | 'per_variant'
  options?: string[]
  optionLabels?: Record<string, string>
  mode?: 'strict' | 'open'
  requiredBy: string[]
  /**
   * 🔴 `| null` because a mirror may be WIDER than its producer, never narrower — **not** because
   * the server sends null. **The wire OMITS an uncapped unit; it never sends null.** Measured
   * 2026-09-02 on GALE-JACKET master DE/de, 96 columns: `maxLength` absent 60 / value 36 /
   * null 0; `maxBytes` absent 81 / value 15 / null 0. Re-measured independently by this lane on
   * BOTH master DE/de and Amazon·IT (97 columns): identical, null 0 in both units. The `| null`
   * stays because defensive handling is never narrowed on the strength of one reading — but it is
   * a defence, not a description.
   *
   * The minute is omitted deliberately: the relaying session's clock read ~2 minutes AHEAD of this
   * one, and a precise timestamp nobody can reconcile is how two lanes later conclude they are on
   * different builds.
   *
   * My earlier comment claimed the null was measured; it was a relayed claim I restated as my own.
   */
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  editable: boolean
  /**
   * 🔴 PES.5's per-column formula gate (#753/#756) — may a cell FORMULA be stored on this column?
   *
   * Added because this interface is a local MIRROR of the wire type and had DRIFTED. The server has
   * sent the flag since #756 (`studio-sheet.service.ts:1384`, declared `sheet-columns.service.ts:132`)
   * and the SHEET's copy of this type carries it (`sheet/master/types.ts:37`) — this copy did not.
   * The value was arriving at runtime the whole time; only the type dropped it, so the drawer's
   * field had no way to gate the `=` editor and would have offered formula authoring on every
   * column, including the ones the writer refuses.
   *
   * OPTIONAL deliberately: absent is UNKNOWN, not "no". `formulaAvailability()` reads it that way on
   * purpose — an older server that omits the field gets a visible server refusal, where reading
   * absence as "no" would disable formulas everywhere and say nothing.
   */
  formulaWritable?: boolean
  width?: number
  helpText?: string
  /**
   * Write routing, moved onto the COLUMN by PES.5 (#333.1).
   *
   * 🔴 It lives here because the per-cell copy was omitted for BLANK cells — present on the fields
   * that already had a value, absent on exactly the empty field an operator is about to type into.
   * That is why only 5 of 97 fields carried "writes to the master record": not a rendering bug, a
   * contract that supplied the fact everywhere except where it was needed. Read these first and
   * fall back to the cell, which still carries its copies so nothing breaks mid-migration.
   */
  writeVerb?: string
  writeTarget?: 'master' | 'channel'
  affectsAllChannels?: boolean
  writable?: boolean
  writeBlockedReason?: string | null
  // ── AM.1 (2026-09-05) — the shape vocabulary, mirrored from `sheet-columns.service.ts` ─────────
  // All OPTIONAL: an older server omits them and every consumer must read absence as `scalar`.
  /** Default `scalar`. A `list` column's value is an array; a `measure` column's is `{ value, unit }`. */
  /** `'axes'` — VT.2's variation-theme projection (additive 2026-09-13); see `kind` above. */
  shape?: 'scalar' | 'list' | 'measure' | 'axes'
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

export interface ReadinessIssue {
  key: string
  label: string
  message: string
  /** `error` = the channel WILL refuse; `warn` = accepted but it may reject. */
  severity: 'error' | 'warn'
}

export interface SheetReadiness {
  state: ReadinessState
  issues: ReadinessIssue[]
  ref?: string
}

export interface SheetListing extends ListingPresenceFields {
  id: string
  listingStatus: string
  /**
   * Whether the local record is being PUSHED to the channel. Distinct from `offerActive` — see
   * below. A restore sets this false (PES.5 §12) without touching the marketplace.
   */
  isPublished: boolean
  /**
   * 🔴 NOT the same fact as `isPublished`, and rendering them as one would misreport the state of
   * a live listing (PES.5, ruling #115.2). `offerActive: false` is a PAUSED OFFER — the listing
   * still exists on the marketplace, the buy box is suppressed. `isPublished: false` is
   * not-being-pushed — the marketplace keeps serving whatever it last received. A listing can be
   * paused and published, or active and unpushed; the pane shows both.
   */
  offerActive?: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  /**
   * When a sync last RAN for this listing (PES.5, #333.2 — additive on the projection).
   *
   * 🔴 Labelled "Last synced", never "last checked against the channel". Those are different
   * claims: this says our sync job ran, not that anyone confirmed the marketplace agrees with us.
   * Reconciliation is a feature that does not exist yet, and a value wearing a label it does not
   * satisfy is the honesty rule failing in the small.
   *
   * Optional until it lands; absent renders as "not reported", not as "never".
   */
  lastSyncedAt?: string | null
  follows: Record<string, boolean>
}

export interface SheetCellValue {
  value: unknown
  source: string
  inheritedFrom: string | null
  inherited: boolean
}

/**
 * MA.4 completeness — mirrored from `apps/api/src/services/pim/master-completeness.service.ts:13`.
 *
 * 🔴 This was WRONG until 2026-09-01 (ruling #46, caught by PES.2 while wiring the dock): it was
 * mirrored as a flat `{filled, total, percent, missing?: string[]}`, which is not what the service
 * has ever sent. Three separate mismatches — nested not flat, `pct` not `percent`, and `missing`
 * is `{key,label}[]` not `string[]` — and TypeScript could not catch any of them, because a mirror
 * is only ever checked against itself. The visible cost was the drawer's footer rendering
 * “undefined% complete”. `completeness.vitest.test.ts` now pins this against the service source, so
 * the next divergence fails a test instead of reaching an operator.
 */
export interface MasterCompleteness {
  overall: { filled: number; total: number; pct: number }
  required: { filled: number; total: number; missing: { key: string; label: string }[] }
  byGroup: { group: string; filled: number; total: number }[]
}

/**
 * PES.5 §3.2 — what the STUDIO's sheet read sends for a cell. A superset of `SheetCellValue`.
 *
 * The three fields that change how the drawer behaves rather than how it looks:
 *   `layer`       provenance, said by the server instead of derived from `source` here
 *   `pinned`      whether THIS layer stores the value — the ✎ glyph, and the Reset affordance
 *   `writeField` + `writeTarget`  where an edit goes, so no client re-derives it
 */
export interface StudioCellValue extends Omit<SheetCellValue, 'inherited'> {
  /** Optional on the studio shape: `pinned`/`layer` answer the same question more precisely. */
  inherited?: boolean
  layer?: string
  pinned?: boolean
  /** `followMaster*` for the six flagged fields; null for everything else. */
  follows?: boolean | null
  editable?: boolean
  linkGroupId?: string | null
  /**
   * What `PATCH /api/products/bulk` expects in `changes[].field` — ALREADY channel-prefixed
   * (`ebay_title`) when `writeTarget` is `channelListing`. The two always agree; sending a master
   * field name with a channel target lands the write on master.
   */
  writeField?: string
  /**
   * Where an edit ACTUALLY lands. Derived from the TARGET layer, never from `layer` — a cell can
   * READ from master and still WRITE to the channel, which is the normal case for a channel
   * override.
   */
  writeTarget?: 'master' | 'channelListing'
  /**
   * 🔴 Shown in a CHANNEL scope but writes to MASTER — so an edit changes every channel at once.
   *
   * Not an edge case: `PATCH /api/products/bulk` can route only SIX fields to a ChannelListing
   * (`{amazon,ebay}_{title,description,variationTheme}`). Measured on eBay·IT, 399 of 441 cells
   * are honestly master-routed. A channel-scoped form whose fields quietly edit the shared record
   * is the single most expensive lie this drawer could tell, so the commit affordance says it
   * BEFORE the write, not after.
   */
  affectsAllChannels?: boolean
  /** False when this cell must not be written yet — `writeBlockedReason` says why. */
  writable?: boolean
  writeBlockedReason?: string | null
}

export interface SheetRow {
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  version: number
  basePrice: number | null
  childCount: number
  /**
   * Resolved value + provenance, by master key. Keys with no value anywhere are absent.
   *
   * Typed as the STUDIO shape. Every field `StudioCellValue` adds is optional, so a row from the
   * catalogue-wide `GET /api/products/sheet` — which sends plain `SheetCellValue` — still
   * satisfies it, and `resolveLayer()` falls back to `source` for exactly those rows.
   */
  values: Record<string, StudioCellValue>
  /**
   * 🔴 SINGULAR, and per-scope — mirrored from `studio-sheet.service.ts:138`.
   *
   * This lane originally mirrored the CATALOGUE-wide read (`sheet-rows.service.ts`), where a row
   * carries `listings` and `readiness` as maps KEYED BY COORDINATE, because that endpoint reports
   * one row against every channel in a market. The STUDIO read is loaded FOR one scope, so a row
   * has exactly one listing and one readiness — the maps do not exist and never did.
   *
   * Nothing caught it: same blind spot as the completeness mirror (#46). It crashed on the first
   * real payload with `readiness.issues is not iterable`, because `Object.values()` over
   * `{state, issues}` yields the STRING "missing", and a string has no `.issues`.
   */
  listing: SheetListing | null
  readiness: SheetReadiness
  completeness: MasterCompleteness
}

/** PES.5 §3.2 — `SheetRow` plus the alias axis. What the studio's family read returns. */
export interface StudioRow extends SheetRow {
  aliasId: string | null
  rowKind: 'parent' | 'variant'
}

/** PES.5 §3.2 — one collapsible listing-alias group. The primary listing is always `id: null`. */
export interface AliasGroup {
  id: string | null
  label: string
  position: number
  status?: string
  externalListingId?: string | null
  listingStatus?: string
  isPublished?: boolean
  readiness?: { percent: number; state: ReadinessState; errors: number; warnings: number; rowsMissingRequired: number }
  rowIds: string[]
}

// ────────────────────────────────────────────────────────────────────
// 2. Provenance — ONE vocabulary, mapped from two
// ────────────────────────────────────────────────────────────────────

/**
 * The API resolves values in two places and they do NOT speak the same language:
 * `attribute-resolver.ts` returns `ValueSource` (master | masterLocale | masterColumn | variant |
 * variantLocale | channelOverride | channelExplicit | default) and `resolve-channel-field.ts`
 * returns a channel provenance (missing | locked | override | linked | fallback | default |
 * catalogRule). A cell whose chip says "override" on one scope and "channelExplicit" on another is
 * the same fact wearing two names, and an operator would read it as two different states.
 *
 * So the drawer renders ONE layer vocabulary and `toLayer()` below maps both onto it. Anything
 * unrecognised becomes `unknown` and is labelled as such — never silently folded into `master`.
 */
export type Layer =
  // ── PES.5 §3.2 `StudioCellValue.layer` — the SERVER's seven, verbatim ──
  | 'master' // the family root's own stored value — the only truth there is
  | 'variant' // this variation's own value, pinned away from the parent
  | 'alias' // pinned on one listing alias
  | 'aliasVariant' // pinned on one alias × one variation — the narrowest layer there is
  | 'channel' // pinned on the channel listing (no alias involved)
  | 'linked' // supplied by a FieldLinkGroup; editing moves every member coordinate
  | 'default' // nothing set anywhere; the schema's fallback ships
  // ── Only `source` can say these, so they survive as an extension ──
  | 'locale' // the master's localised content for this market's language
  | 'mapped' // derived by the mapping engine from a master field
  | 'locked' // identity field pinned to master (GTIN / SKU / brand)
  | 'channelSnapshot' // following legacy listing content; drift, never an operator pin
  | 'unknown' // a value this build does not know — shown, never guessed

/**
 * `source` → `Layer`, for the cells that carry no explicit `layer`.
 *
 * 🔴 This is the FALLBACK, not the main road. PES.5 §3.2 sends `layer` on every `StudioCellValue`,
 * and `resolveLayer()` below prefers it. This map still matters because the catalogue-wide
 * `GET /api/products/sheet` (MS.1/MS.2, unchanged and still serving /products/next) sends only
 * `source`, and because a `layer` the server adds tomorrow must land as `unknown` rather than
 * being quietly folded into `master`.
 */
const LAYER_OF: Record<string, Layer> = {
  // attribute-resolver.ts ValueSource
  master: 'master',
  masterColumn: 'master',
  masterLocale: 'locale',
  variant: 'variant',
  variantLocale: 'locale',
  channelOverride: 'channel',
  channelExplicit: 'channel',
  default: 'default',
  // resolve-channel-field.ts provenance
  override: 'channel',
  linked: 'linked',
  catalogRule: 'mapped',
  fallback: 'default',
  locked: 'locked',
  missing: 'default',
  channelSnapshot: 'channelSnapshot',
  // sheet-rows.service.ts writes this one directly
  schema: 'default',
  // PES.5 §3.2 layer values, so a `layer` string handed to this function still resolves
  alias: 'alias',
  aliasVariant: 'aliasVariant',
  channel: 'channel',
  locale: 'locale',
}

export function toLayer(source: string | null | undefined): Layer {
  if (!source) return 'unknown'
  return LAYER_OF[source] ?? 'unknown'
}

/**
 * The server's `layer` when it sent one; its `source` otherwise. One answer, one precedence.
 *
 * 🔴 An ABSENT cell is `default`, not `unknown`, and the difference is the whole point of having
 * an `unknown` at all. The sheet contract says "keys with no value anywhere are absent" — so a
 * missing entry is a DEFINED state (nothing is set; the schema default would ship), while
 * `unknown` means "the server named a provenance this build does not recognise". Returning
 * `unknown` for absence made the drawer report a contract mismatch that had not happened: measured
 * on the live studio, every optional column with no value rendered "? Unrecognised", which reads
 * as a bug in the payload rather than an empty field.
 *
 * That is the same honesty failure as an empty history list meaning "not shipped" — just pointing
 * the other way. Claiming confusion is as wrong as claiming certainty.
 */
export function resolveLayer(cell: Pick<StudioCellValue, 'layer' | 'source'> | undefined): Layer {
  if (!cell) return 'default'
  // The legacy layer fold says master; source names the stored channel value more precisely.
  if (cell.source === 'channelSnapshot') return 'channelSnapshot'
  if (cell.layer) return toLayer(cell.layer)
  return toLayer(cell.source)
}

/** Short chip text. Kept to one or two words so it fits beside a label without wrapping the row. */
export const LAYER_LABEL: Record<Layer, string> = {
  master: 'Master',
  variant: 'Variant',
  alias: 'Alias',
  aliasVariant: 'Alias × variant',
  channel: 'Channel',
  linked: 'Linked',
  default: 'Default',
  locale: 'Locale',
  mapped: 'Mapped',
  locked: 'Locked',
  channelSnapshot: 'Channel snapshot',
  unknown: 'Unrecognised',
}

/** The sentence under the field, and the tooltip on the chip. */
export const LAYER_HINT: Record<Layer, string> = {
  master: 'Stored on the family root. Every scope that has not pinned its own value shows this.',
  variant: "Pinned on this variation — the parent's value no longer reaches it.",
  alias: 'Pinned on this listing alias. Other aliases of the same product are unaffected.',
  aliasVariant: 'Pinned on this alias AND this variation — the narrowest override there is.',
  channel: 'Pinned on this channel listing. The master value no longer reaches it.',
  linked: 'Supplied by a linked group: editing it here moves every coordinate in the group.',
  default: 'No value is set anywhere — the schema default is what would ship.',
  locale: "From the master's localised content for this market's language.",
  mapped: 'Derived by the mapping engine from a master field. Edit the mapping, not this cell.',
  locked: 'An identity field pinned to master. It cannot diverge per channel.',
  channelSnapshot: 'The last stored channel value. It follows legacy listing content, may differ from master, and is not an operator pin.',
  unknown: 'The server reported a provenance this build does not recognise. Shown verbatim, not guessed.',
}

/**
 * True when the value is NOT this scope's own — resetting is a no-op and pinning is what an edit
 * would do.
 *
 * PES.5 §3.2 sends `pinned` per cell, which answers this directly; `isInherited(layer)` is the
 * answer for the reads that do not carry it. `isOwnValue()` below prefers the explicit flag.
 */
export function isInherited(layer: Layer): boolean {
  return (
    layer === 'master' ||
    layer === 'locale' ||
    layer === 'linked' ||
    layer === 'mapped' ||
    layer === 'channelSnapshot' ||
    layer === 'default'
  )
}

/**
 * Does THIS row/scope store the value, or is it quoting somewhere else?
 *
 * Precedence, explicit before inferred:
 *   1. `pinned`    — the server answering this exact question for this layer
 *   2. `inherited` — the sheet read's own flag, inverted
 *   3. the layer   — inference, and only when neither was sent
 *
 * 🔴 Step 2 is not redundant, and leaving it out was a bug. On the MASTER scope a parent row's own
 * stored value has `layer: 'master'`, and `isInherited('master')` is true — so pure layer
 * inference calls the family root's own value "inherited from master", which is inherited from
 * ITSELF. The visible cost: no Reset offered on a value that has one, and the first edit sent as
 * `pin` rather than `set` — pinning an override onto the very row the value already lives on.
 * The sheet read sends `inherited: false` for exactly this case (PES.2 hit the same false positive
 * independently in `classifyProvenance`, ruling #33; explicit now wins there too).
 */
export function isOwnValue(
  cell: Pick<StudioCellValue, 'layer' | 'source' | 'pinned' | 'inherited'> | undefined,
): boolean {
  if (!cell) return false
  if (typeof cell.pinned === 'boolean') return cell.pinned
  if (typeof cell.inherited === 'boolean') return !cell.inherited
  return !isInherited(resolveLayer(cell))
}

// ────────────────────────────────────────────────────────────────────
// 3. What the drawer is open ON
// ────────────────────────────────────────────────────────────────────

/** Which projection of the record the sheet — and therefore the drawer — is showing. */
export interface DrawerScope {
  accountId?: string
  listingId?: string
  /** `master` is the stored truth; a channel scope is a sparse override layer over it. */
  kind: 'master' | 'channel'
  channel?: SheetChannel
  marketplace?: string
  /** PES.3's listing alias, when a channel scope has more than one listing per coordinate. */
  aliasId?: string
  aliasLabel?: string
  /** Content language for this market — from `Marketplace.language`, never guessed from the code. */
  locale?: string
  /** PES.5 §3.2 sends `scope.label` ("eBay · IT"). Preferred over anything assembled client-side. */
  label?: string
}

// ────────────────────────────────────────────────────────────────────
// 5. The formula seam — supplied by the HOST, never built here
// ────────────────────────────────────────────────────────────────────

/**
 * D16 cell formulas as the drawer consumes them (#708/#775 — "PES.2 builds the `=`-mode editor in
 * the engine, PES.4 the drawer's field").
 *
 * 🔴 INJECTED, not constructed, and the obvious alternative is wrong twice over. Calling
 * `useCellFormulas` inside the drawer needs the full coordinate including `market`, which
 * `DrawerScope` does not carry and the drawer must not guess — `/pim/formulas/preview` REFUSES
 * without it (#729), because the key set a `$ref` may name differs per market (40 keys on IT, 35
 * on DE for the same product), so a guess there is a plausible wrong answer rather than an error.
 * And the sheet that mounts this drawer already holds that hook for these very rows: a second one
 * means two batch reads and two answers to "what formula is on this cell", which is the drift the
 * "shared = exactly the same" rule exists to stop. The host owns the seam and hands it over,
 * exactly as it hands over `compareTargets`.
 *
 * Structurally satisfied by `useCellFormulas`'s `CellFormulas` (this is that type minus `reload`),
 * so a host passes its existing object straight through with no adapter and no second source.
 */
export interface DrawerFormulas {
  ready?: boolean
  sourceLabel?: string
  sourceLabelFor?: (fieldKey?: string) => string
  replace?: (rowId: string, fieldKey: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
  /** The stored expression for a cell, or null. A cell that HAS one always opens in formula mode. */
  exprFor: (rowId: string, fieldKey: string) => string | null
  /** The language's functions, for the signature hint. Empty until loaded — never invented. */
  functions: FormulaFunctionDoc[]
  /** Evaluated by the REAL engine. The client never decides whether a formula resolves (#728). */
  preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>
  /**
   * 🔴 The formula's own write path, and the reason this seam exists at all. The ordinary `onWrite`
   * would store the CHARACTERS `="a" + $brand` as the cell's literal value — and `overrideData` is
   * read as a value layer by the resolver, so the formula text would publish to a channel and
   * preflight would call it valid.
   */
  save: (rowId: string, fieldKey: string, expr: string) => Promise<{ ok: boolean; error?: string }>
  /** Drop the formula, keep the value it last produced. The audit row keeps it restorable (#488). */
  pinOver: (rowId: string, fieldKey: string) => Promise<{ ok: boolean; error?: string }>
}

export interface DrawerTarget {
  row: SheetRow
  /** The column the operator was standing on when they expanded. Scrolled to and ringed, not focused. */
  focusKey?: string
  scope: DrawerScope
}

// ────────────────────────────────────────────────────────────────────
// 4. History + compare — PES.5's contracts (docs/pes-claims.md)
// ────────────────────────────────────────────────────────────────────

/**
 * One recorded change to one field — PES.5 §3.5, verbatim field names.
 *
 * `by` and `previous` stay NULLABLE after PES.5 §4 lands, and that is not defensive typing. The
 * `before`/actor capture is gated to the SINGLE-PRODUCT write path (`expectedVersion` present),
 * which is how the studio autosaves — but a catalogue-wide bulk-op still logs `before: null`, and
 * every row written before §4 has neither. `coverageSince` is what tells the operator which is
 * which; the pane renders it rather than letting an empty column read as "it was empty".
 */
export interface FieldHistoryEntry {
  at: string
  by: string | null
  layer: string
  fieldKey: string
  previous: unknown
  /**
   * Hub ruling #14 (2026-09-01) — MANDATORY in §3.5: was a previous value actually captured?
   *
   * `previous: null` cannot carry both "the old value was empty" and "no old value was recorded",
   * and the second is true for every row written before PES.5 §4 and for every catalogue-wide
   * bulk-op after it (the capture is gated to the single-product path the studio autosaves
   * through). An operator reads a rendered empty as a fact, so the two must be separable on the
   * wire rather than inferred here.
   *
   * Optional only until PES.5 ships it; `previousWasRecorded()` below applies the interim
   * `undefined` vs `null` reading in the meantime and switches to this the moment it arrives.
   */
  previousRecorded?: boolean
  next: unknown
  /** How the change was made: `manual` | `ai` | `sync` | `rule`. */
  source: string
}

/**
 * Did this entry actually record a previous value?
 *
 * Prefers the server's explicit answer (hub ruling #14). Falls back to the shape of `previous`
 * itself: `undefined` — the key absent from the JSON — means nothing was captured, while an
 * explicit `null` is a captured empty. The fallback is a READING of the payload, not a guess
 * about the data: it errs toward "not recorded", because claiming a change happened is the more
 * expensive mistake of the two.
 */
export function previousWasRecorded(entry: Pick<FieldHistoryEntry, 'previous' | 'previousRecorded'>): boolean {
  if (typeof entry.previousRecorded === 'boolean') return entry.previousRecorded
  return entry.previous !== undefined
}

export interface FieldHistoryPage {
  coverageNote?: string
  entries: FieldHistoryEntry[]
  /**
   * 🔴 The honesty field. The timestamp from which per-cell history is actually recorded — before
   * it, an absent entry means "not recorded", not "not changed". `null` means nothing is covered
   * yet, which is what it returns today for every cell.
   */
  coverageSince: string | null
}

/** One coordinate's value for a field, in a compare table. */
export interface CompareCell {
  targetId: string
  label: string
  value: unknown
  layer: Layer
  /** False when this target has no listing at all — distinct from having an empty value. */
  exists: boolean
  /** Set when copying INTO this target is impossible, and why. Drives the disabled control's title. */
  readOnlyReason?: string
}

export interface CompareRow {
  key: string
  label: string
  cells: CompareCell[]
}

export interface CompareTarget {
  id: string
  label: string
  kind: 'master' | 'locale' | 'alias' | 'channel'
  scope: DrawerScope
}

// ────────────────────────────────────────────────────────────────────
// 5. The one write path
// ────────────────────────────────────────────────────────────────────

/**
 * A drawer edit is a SHEET edit. The drawer never owns a fetch of its own for writes: the host
 * hands it this mutator, which is the same one the grid's cell editor calls, so a field changed in
 * the drawer repaints its cell, shares the `expectedVersion` / 409 handling, and lands in the same
 * audit row it would have from the sheet. Two write paths would be two provenance stories.
 */
export interface RecordWriteRequest {
  rowId: string
  /**
   * What `PATCH /api/products/bulk` expects in `changes[].field` — NOT the column key; `attr_*`
   * keeps its prefix on the wire. Taken from the CELL's `writeField` when the studio read sent
   * one (PES.5 §3.2 puts it there precisely so no client re-derives it), the column's otherwise.
   */
  writeField: string
  /** PES.5 §3.2 — which entity the write lands on. Absent on catalogue-wide master reads. */
  writeTarget?: 'master' | 'channelListing'
  value: unknown
  scope: DrawerScope
  /** `pin` sets an override on this scope; `reset` clears it and returns the cell to inheritance. */
  intent: 'set' | 'pin' | 'reset'
}

export type RecordWriteState = 'idle' | 'pending' | 'saving' | 'saved' | 'refused'

export interface RecordWriteResult {
  state: RecordWriteState
  /** Present on `refused` — shown verbatim on the field, never swallowed into a toast. */
  message?: string
}
