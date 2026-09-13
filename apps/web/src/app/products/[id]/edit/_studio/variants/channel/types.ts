/**
 * VP.4 — the channel projection's wire contract, as this surface consumes it.
 *
 * 🔴 **`docs/vp2-contracts.md` is FINAL as of 2026-09-11 18:24 and this file now follows IT**, not
 * spec §5.4's proposal. Four things moved between the two, and each is marked below, because the
 * proposal is what the canvas and this lane were first built against:
 *
 *   §5.4 proposed                     VP.2 ships
 *   `vocabulary.limits`               top-level `limits`, and either number may be **null**
 *   `vocabulary.axisNoun` only        `+ axisNounPlural + sectionTitle` (a channel's own words)
 *   —                                 `freeform`, `theme`, `order`, `counts`
 *   `parent: {...}`                   **absent** — see `ProjectionParent` for what this lane does
 *
 * 🔴 This is a LOCAL MIRROR of a server type and mirrors drift (reference_wire_parse_boundary_rules).
 * So there is ONE parse boundary (`parseProjection` in `./source.ts`), nothing here is
 * optional-by-accident, and a field that VP.2's DOC does not carry but its ROUTE does is marked
 * `MEASURED` with the date — the route is the contract, and a doc can describe code that never
 * shipped as easily as the reverse (reference_docs_describe_deleted_code).
 */
import type { SheetColumn } from '../../sheet/channel/types'
import type { ProjectionState } from '@/design-system/grid'

/** contracts §1 — the channel's own words. Never composed client-side. */
export interface ProjectionVocabulary {
  /** Singular, lower case: `specific` · `theme` · `option` · `property`. */
  axisNoun: string
  /** Sent explicitly because `property` does not pluralise with `+ s`. */
  axisNounPlural: string
  /** The dock's section-1 title for this channel (§9): `Variation specifics` · `Options` · … */
  sectionTitle: string
}

/**
 * contracts §1 — and **either number may be `null`**.
 *
 * 🔴 `null` is not zero and not "unlimited": it means this channel states no limit VP.2 could
 * SOURCE. Amazon has no sourced variant cap, so `variants` is null there and §4.1's sentence drops
 * its "of N allowed" half rather than printing a number nobody can stand behind. `source` carries
 * the provenance of each — eBay's two are pinned to code by a test; Shopify's and Etsy's come from
 * the spec table and say so.
 */
export interface ProjectionLimits {
  axes: number | null
  variants: number | null
  source: { axes: string | null; variants: string | null }
}

/** One shared axis, projected onto one channel target. */
export interface ProjectionMapping {
  axisKey: string
  /** The axis's operator-facing name — `Colore`. */
  axisLabel: string
  /** The channel-side target. `null` = this axis is not mapped yet (§4.2's `Mapping errors`). */
  target: string | null
  /** 0-based, the projection order. */
  order: number
}

/** An option the channel offers. Empty + `freeform` for a channel that takes free names. */
export interface ProjectionTargetOption {
  code: string
  label: string
  columnKey?: string | null
  /** True when a shared axis is already mapped onto it. */
  taken?: boolean
}

/** §4.4.3 — how this family lands on the channel. */
export interface ProjectionSplit {
  mode: 'single' | 'per-axis'
  axisKey?: string
  listings: Array<{ aliasKey: string; label: string; count: number }>
  /**
   * 🔴 Alias CREATION is inert until PES.5-ii lands. `false` means the per-axis option is RENDERED
   * and HELD with `heldReason` on it — never silently disabled (§4.4.3).
   */
  creatable: boolean
  heldReason?: string
}

/**
 * §4.4.4 — non-null when this coordinate has already published. Never fabricated from declared axes.
 *
 * 🔴 VT.1b unified this with the SHEET cell's lock (`variationLockFor`, ONE definition —
 * `family-projection.service.ts:1142`), after the two disagreed: this block was derived from
 * `platformAttributes.__lastPublishedAxes`, which only eBay's push writes, so GALE's live Amazon
 * coordinates read UNLOCKED here and LOCKED on the cell. The three fields below are that producer's,
 * declared rather than left to be read as `undefined` by a consumer that then guesses: VT.2c's dock
 * section reads `orderChangeAllowed` to decide whether a reorder is a permitted commit, and the
 * fallback it would have taken (`order.writableHere`, `false` on eBay) is the OPPOSITE answer for the
 * one channel where a reorder on a live listing IS allowed.
 *
 * `lockedAxisKeys` stays beside them as the extra fact only this store can answer — WHICH axes are
 * already published — and it is `[]` on every channel that cannot say (that is not "none locked" for
 * a client to infer anything from; it is "this store has no per-axis answer").
 */
export interface ProjectionLock {
  reason: string
  lockedAxisKeys: string[]
  /** What a SET change on this coordinate IS — the operation the plan describes (`docs/vt1-contracts.md` §1). */
  setChangeIs: 'relist' | 'new-parent' | 'in-place'
  /** eBay/Shopify `true`: reordering a live listing is a revise, so an order-only commit saves normally. */
  orderChangeAllowed: boolean
  externalId: string | null
}

/**
 * The five words §9 gives a projection — VP.5's, from the DS, never a local copy.
 *
 * The vocabulary lives in `design-system/grid/renderers/projection.ts` as a third table beside the
 * row and scope readiness ones, with every tone taken from a declared `readinessMeta` counterpart.
 * Two of the five (`excluded`, `not-set-up`) are not readiness verdicts at all and carry no tone;
 * VP.4 and VP.5 reached that independently, and VP.5's answer — one table in the one tone source —
 * is the one that ships. Re-exported rather than redeclared: hub ruling #11, one definition.
 */
export type ProjectionListingState = ProjectionState

/**
 * Where a pinned value's write lands — MEASURED on the route 2026-09-11, VP.2's answer to REQUEST A5.
 *
 * §4.3: *"pinned writes go through the EXISTING channel write path (`resolveWriteRouting`,
 * `marketplaceContexts`) — no new write path for values"*. That path is `commitChannelRow`
 * (`_studio/sheet/channel/useChannelSheet.ts`), whose own docblock states the rule this field obeys:
 * **"The write target comes from the CELL, not from this client. Re-deriving it here is exactly how
 * a channel edit silently lands on the master record."**
 *
 * `version` is the version of the ROW named by `target` — a product version is not a listing
 * version, and the sheet shipped that pairing wrong once already (#697).
 */
export interface ProjectionWriteRouting {
  field: string
  target: 'product' | 'channelListing'
  verb: string
  version: number
}

/** §4.3 — the mapped value on one child, and where it came from. */
export interface ProjectionValue {
  value: string | null
  /** `inherited` = follows the shared axis value (link glyph) · `pinned` = this channel's own (pin + tint). */
  source: 'inherited' | 'pinned'
  /** Absent = this cell cannot be pinned yet; `writeBlockedReason` says why, on screen. */
  write?: ProjectionWriteRouting | null
  /**
   * The value the CASCADE would resolve to if this cell were reset — VP.2's A7, on the route since
   * 2026-09-11 19:1x. **`null` means a reset EMPTIES this cell**; the key being ABSENT means the
   * server could not compute it and `inheritedValueUnknownReason` says why. The two are different
   * sentences and the surface holds on both, differently.
   *
   * Not `sharedAxisValues[axisKey]`. Measured on eBay·IT 2026-09-11: the projection reports
   * `sharedAxisValues.Colore = "Nero"` on every child, and the MASTER sheet reports `color = null`
   * and `axisValues = {}` on the same child. So `sharedAxisValues` is the family's axis TUPLE — what
   * distinguishes this variant from its siblings — and not a value anything would inherit. A reset
   * built on it promises "Nero" and would leave the specific EMPTY on a live listing.
   *
   * So the reset is HELD until this field exists, and `planPin` says why on the control. The
   * distinction is the same one `reference_available_is_the_stock_rollup` records in another
   * vocabulary: two fields that read alike and answer different questions.
   */
  inheritedValue?: string | null
  /**
   * Why `inheritedValue` is absent. VP.2 leaves it unanswered rather than guessing for a MAPPED
   * cell — a mapping rule sits between master and the channel, so the master value is not where a
   * reset lands, and answering would be a confident wrong answer.
   */
  inheritedValueUnknownReason?: string
  /** The server's sentence for why this cell cannot be written. Rendered, never swallowed. */
  writeBlockedReason?: string | null
}

export interface ProjectionChild {
  id: string
  sku: string
  included: boolean
  values: Record<string, ProjectionValue>
  listing: {
    state: ProjectionListingState
    externalId: string | null
    listingId?: string | null
    /** The server's sentence for the state — "Live on this channel." Shown, never re-derived. */
    reason?: string
  }
  /* MEASURED on the route 2026-09-11 (VP.2's answer to REQUEST A2); not in contracts §4.1's snippet. */
  name?: string | null
  image?: string | null
  imageInherited?: boolean
  /** The SHARED axis values, keyed by axis — the identity band's second line ("Nero · XXS"). */
  sharedAxisValues?: Record<string, string>
  /**
   * Axes whose shared value on THIS row is not trustworthy, with the server's reason.
   *
   * Measured on GALE-JACKET: two XXS rows have had their shared axis bag overwritten, so the only
   * surviving value says `XS` on a SKU named `…-XXS`. VP.2 detects it rather than correcting it —
   * deriving `XXS` from the SKU would be an inference — and this surface MARKS it rather than
   * hiding it, because a wrong value nobody is warned about is worse than a wrong value they are.
   */
  axisValuesSuspect?: Array<{ axisKey: string; reason: string }>
  completeness?: { pct: number | null; filled: number; total: number } | null
  readiness?: { pct?: number | null; requiredPct?: number | null; state: string | null } | null
}

/**
 * The parent row — §4.3: `● Listed · 1 listing`, the channel's own key in mono.
 *
 * 🔴 **VP.2's contract does not carry this yet**, though its `counts.rows` is 21 on a 20-child
 * family, so a parent row is intended. Until it does, the surface builds the row from facts it
 * already holds rather than inferring one: the SKU and name come from the studio frame's own
 * product, the listing count from `split.listings`, and the Listing cell shows that count with NO
 * state and NO external id — because "every child carries the same ItemID, so that is the family's"
 * is an inference, and this row is exactly where an inference would be mistaken for a fact.
 * Filed to VP.2 as REQUEST A6.
 */
export interface ProjectionParent {
  readiness?: { state: string | null } | null
  completeness?: { pct: number | null; filled: number; total: number } | null
  id: string
  sku: string
  name: string | null
  image: string | null
  /** A COUNT, deliberately beside `listing` rather than inside it — it is not part of the vocabulary. */
  listings: number
  /**
   * 🔴 The SAME shape a child's `listing` has. It shipped flat for one revision, and this lane's
   * formatter — written from §5.4's nested proposal — crashed the page to Next's error boundary the
   * minute it appeared. VP.2 nested it rather than documenting the divergence, which is the right
   * call while nothing is committed: one vocabulary in two shapes is what a consumer reads past.
   *
   * `externalId` here is the PARENT listing's own, never folded up from the children — precisely
   * what this surface declined to infer while the field did not exist. Note `listingId` differs
   * from every child's, which is the point of it.
   */
  listing: {
    state: ProjectionListingState | null
    externalId: string | null
    listingId?: string | null
    reason?: string
  }
}

/** The coordinate. `channelLabel` / `accountLabel` are MEASURED on the route (REQUEST A3). */
export interface ProjectionCoordinate {
  channel: string
  market: string
  accountId: string | null
  aliasKey: string
  /** `eBay · IT` — the server's own composed label. */
  label: string
  channelLabel?: string
  accountLabel?: string | null
}

/**
 * §1.4's fold, relayed by VP.2 and NOT writable here — MEASURED on the route 2026-09-11.
 *
 * VP.2 took this lane's recommendation: the presentation order keeps its own editor and its own CAS
 * pair, and the projection PATCH does not touch `_variationAxes` / `_axisValueOrder`. The server
 * says so in `writableHere` and `reason`, so the dock states where the order lives rather than
 * offering a second writer for the same bytes.
 */
export interface ProjectionOrder {
  axes: string[]
  valueOrder: Record<string, string[]>
  editorUrl: string
  writableHere: boolean
  reason: string
  token?: string
  resolvedAxes?: Array<{ name: string; key: string; values: string[] }>
}

/** `GET /api/products/:id/studio/projection` — `docs/vp2-contracts.md` §4.1. */
/**
 * VT.4 — the coordinate's collision report, `docs/vt1-contracts.md` §3.5, relayed verbatim.
 *
 * 🔴 `null` and `{ unresolved: 0 }` are DIFFERENT facts and the dock says each of them differently:
 * `null` = this coordinate drops no axis (or the read carried no children), so there is nothing a
 * collision could come from — NOT COMPUTED. `unresolved: 0` with `groups: []` = it was computed and
 * came back empty. The same distinction `targetOptionsState` exists for, one field along.
 */
export interface ProjectionCollisions {
  groups: Array<{ key: string[]; members: Array<{ id: string; sku: string; droppedValues: Record<string, string> }> }>
  unresolved: number
  /** The server's sentence. Rendered verbatim — the dock composes no count of its own. */
  summary: string
  resolvers: Array<{ kind: 'split' | 'fold' | 'exclude'; available: boolean; reason: string | null }>
}

export interface ProjectionPage {
  axisColumns?: Record<string, SheetColumn>
  /** VT.4 — absent on an older server, `null` when nothing could collide. See `ProjectionCollisions`. */
  collisions?: ProjectionCollisions | null
  /** The PARENT ChannelListing's version on this coordinate. Sent back as `expectedVersion`. */
  version: number
  coordinate: ProjectionCoordinate
  vocabulary: ProjectionVocabulary
  limits: ProjectionLimits
  mapping: ProjectionMapping[]
  targetOptions: ProjectionTargetOption[]
  /**
   * R-VT-7 — why `targetOptions` is what it is. `'ok'` is only ever sent with a NON-EMPTY list, so an empty
   * Listbox always has a word for itself: `'freeform'` (the channel takes any name), `'unavailable'` (the
   * schema or column set could not be read), `'no-theme'` (this Amazon product type declares no theme).
   * Optional because an older server does not send it; `undefined` is treated as not measured, never as `ok`.
   */
  targetOptionsState?: 'ok' | 'freeform' | 'unavailable' | 'no-theme'
  /** The server's sentence for that state, rendered verbatim. `null` when the list is populated. */
  targetOptionsReason?: string | null
  /** True when the channel takes free names (Shopify) — the Listbox becomes an Input. */
  freeform: boolean
  /**
   * AMAZON only — the theme enum from the CACHED product-type schema (R-VT-7: it used to be read off a sheet
   * column VT.1 retired, so it was `[]` on every coordinate). `coversAll` / `drops` / `adds` / `deprecated` are
   * the server's grouping, so the dock groups the list exactly as the sheet cell's editor does (R-VT-9).
   */
  theme?: {
    value: string | null
    options: Array<{ code: string; label: string; deprecated?: boolean; coversAll?: boolean; drops?: string[]; adds?: string[] }>
  } | null
  split: ProjectionSplit
  locked: ProjectionLock | null
  children: ProjectionChild[]
  /** MEASURED on the route: the axes the FAMILY has, with per-value counts (REQUEST A4). */
  axes?: Array<{ key: string; label: string; valueOrder?: { codes: string[]; from?: string | null }; hasSuspectRows?: boolean; values: Array<{ code: string; label: string; count: number; suspectRows?: number }> }>
  order?: ProjectionOrder
  /**
   * The server's own tallies.
   *
   * 🔴 Read, but NOT used for the chips. Measured on eBay·IT: `counts.pinned` is 40 on a 20-child
   * family — it counts pinned CELLS (20 × 2 axes), while a chip narrows the grid to ROWS. A chip
   * reading 40 that narrows to 20 rows is the count-and-result disagreement §6.2's chip rules exist
   * to prevent, so `projectionCounts` derives the row numbers and this is kept for comparison.
   * Reported to VP.2.
   */
  /**
   * The server's own tallies, now NAMING THEIR UNIT after this lane reported that `pinned` was 40
   * on a 20-child family. `pinnedRows` is what a row-narrowing chip prints; `pinnedCells` is not.
   */
  counts?: { rows: number; includedChildren: number; pinnedCells: number; pinnedRows: number; mappingErrorRows: number }
  meta?: { tookMs: number }
  /** Absent today — see `ProjectionParent`. */
  parent?: ProjectionParent
}

/** The dock's draft — what `Save mapping` sends. */
export interface ProjectionDraft {
  mapping: ProjectionMapping[]
  /**
   * R-VT-9 — AMAZON only: the theme the dock's picker chose. ABSENT (not `null`) on every draft that never
   * touched a theme, because the route reads an explicit `null` as "clear it".
   */
  theme?: string | null
  split: { mode: 'single' | 'per-axis'; axisKey?: string }
  presentationOrder?: { expectedToken: string; change: { axes?: string[]; values?: Record<string, string[]> } }
}

export interface ProjectionSaveOk {
  ok: true
  version: number
}

/**
 * VT.4 — the server's own error CODE on a refusal, relayed beside the sentence.
 *
 * Why the code and not only the sentence: `axes_locked` is not a message to read, it is a BRANCH — a SET
 * change on a live coordinate is an operation, so the dock opens the dry-run plan instead of reporting a
 * failure (design §3.5). Matching on the sentence would be `reference_idempotency_guard_matched_the_quote`:
 * the copy is Appendix A's and may be reworded, and the branch would silently stop firing.
 *
 * It is OPTIONAL because a transport failure and an unparseable body carry no code, and those are genuinely
 * "we do not know which refusal this was".
 */
export type ProjectionRefusalCode = 'version_conflict' | 'axes_locked' | 'no_listing_here' | 'collision_unresolved' | 'bad_projection_request' | (string & {})

/** 409 → repaint + refetch, exactly like the sheet (§4.4). */
export interface ProjectionSaveConflict {
  ok: false
  conflict: true
  current: ProjectionPage
  reason: string
  /** VT.4 — the wire's `error` field. Absent when the body carried none. */
  code?: ProjectionRefusalCode
}

export interface ProjectionSaveFailed {
  ok: false
  conflict: false
  reason: string
  /** VT.4 — the wire's `error` field. Absent when the body carried none. */
  code?: ProjectionRefusalCode
}

export type ProjectionSaveResult = ProjectionSaveOk | ProjectionSaveConflict | ProjectionSaveFailed

/** The projection endpoint's read and versioned write operations. */
export interface ProjectionSource {
  read(signal: AbortSignal): Promise<ProjectionPage>
  /** contracts §4.2 — PATCH `{ expectedVersion, mapping?, split? }`. */
  saveMapping(expectedVersion: number, draft: ProjectionDraft): Promise<ProjectionSaveResult>
  /** contracts §4.3 — PATCH `/children` `{ expectedVersion, changes: [{ id, included }] }`. */
  setIncluded(expectedVersion: number, changes: Array<{ id: string; included: boolean }>): Promise<ProjectionSaveResult>
}
