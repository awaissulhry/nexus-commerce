/**
 * VT.4 — the catalogue's `Variation mapping` filter (VX §11.4, values fixed by `docs/vt1-contracts.md` §5).
 *
 * Pure: no React, no fetch, no DOM. The page renders it, a node-environment test exercises it
 * (`apps/web` vitest is `environment: 'node'` — no DOM assertions reach here).
 *
 * ## The five values, and where they come from
 *
 * `docs/vt1-contracts.md` §5 is FINAL and fixes them as **`derived | rule | overridden | unset | collides`**
 * — "exactly `source.kind` minus `none`, plus `unset` for `none` and `collides` for a coordinate with
 * `collisions.unresolved > 0`".
 *
 * 🔴 The VX design's §11.4 sentence lists a DIFFERENT set ("follows rule · overridden · collisions ·
 * missing · theme unset") and its Appendix C copy table names `Follows rule`, `Overridden`, `Collisions`,
 * `Missing`, `Theme unset`. Two of those do not survive §5: there is no `missing` value (a missing VALUE is
 * the sheet's readiness, not a mapping provenance), and `derived` — the tier that makes "mapped by default"
 * true for every family without a rule — is absent from the older list entirely. The CODES here are §5's,
 * because a FINAL contract outranks a design paragraph it was written to settle; the LABELS reuse Appendix
 * C's words wherever a value exists for them. The disagreement is raised in `docs/pes-claims.md` rather
 * than resolved by whichever file this module happened to read last.
 *
 * ## What it is fed by — LIVE since VT.1b
 *
 * The wire is the materialized `ReadinessIndex` (VX §4 M5), and both halves now exist:
 *  - `derived` / `rule` / `overridden` ← **`ReadinessIndex.variationSource`**, the nullable TEXT column VT.1b
 *    added, stamped by `readiness-index.service.ts` on every write AND every reconcile (they are the same
 *    function). It carries the filter's own spelling — `overridden`, not `source.kind`'s `override`.
 *  - `unset` / `collides` ← **`ReadinessIndex.missing[].kind`** (`theme-unset` / `collision`), LX.F's P2-14
 *    field. The filter narrows on the FACT, never on the sentence, which is free to be reworded.
 *
 * 🔴 `variationSource` NULL / absent is **NOT COMPUTED** — a row written before the column existed (measured:
 * 818 of 884 local rows), or a child row, which has no projection of its own. It is matched by NO value and in
 * particular never by `derived`: an index that has not been rebuilt must not answer a provenance question at
 * all. That is R-LX-9's lesson, and `FamilyFooterCounts` renders it as the word `Not computed`.
 *
 * The server predicate is `restrictVariationMapping` (`apps/api/src/services/pim/variation-mapping-filter.ts`)
 * on `?variationMapping=…`; this module's `toRequestParameter` is the ONLY place the URL form is converted to
 * it, and `matchesVariationMapping` / `countVariationMapping` are the same rule for anything the page holds in
 * memory (the footer's per-coordinate counts), so the two can only ever agree.
 */

/** §5's five values, in the order the filter offers them. */
export const VARIATION_MAPPING_VALUES = ['derived', 'rule', 'overridden', 'unset', 'collides'] as const
export type VariationMappingValue = (typeof VARIATION_MAPPING_VALUES)[number]

/**
 * Labels. Appendix C's words where §5 has a value for them; the two it has no word for are named after
 * the tier they describe (`source.kind`), not invented.
 */
export const VARIATION_MAPPING_LABELS: Record<VariationMappingValue, string> = {
  derived: 'Derived',
  rule: 'Follows rule',
  overridden: 'Overridden',
  unset: 'Theme unset',
  collides: 'Collisions',
}

/** The filter's own title. Appendix C, verbatim. */
export const VARIATION_MAPPING_TITLE = 'Variation mapping'

/** The URL token VT.3's `[List]` link and design §3.7 write. */
export const VARIATION_MAPPING_URL_KEY = 'variation-mapping'

export function isVariationMappingValue(value: unknown): value is VariationMappingValue {
  return typeof value === 'string' && (VARIATION_MAPPING_VALUES as readonly string[]).includes(value)
}

/**
 * Read `?filter=variation-mapping:derived|rule|overridden` — the spelling design §3.7 and VX §11.1's
 * `[List]` button use (pipe-separated, because a comma already separates `filter` terms elsewhere).
 *
 * Unknown values are DROPPED and reported, never silently ignored and never passed through: a filter the
 * page cannot honour must not look applied. Returns the values it understood plus the ones it did not, so
 * the caller can say so on screen.
 */
export function parseVariationMappingFilter(raw: string | null | undefined): {
  values: VariationMappingValue[]
  unknown: string[]
  /**
   * 🔴 R-VT-11 — EVERY token the URL carried under this key, known and unknown, so the caller can hand the
   * raw words to the ONE arbiter instead of deciding for it.
   *
   * The defect this closes, measured by VT.4b and ruled on by the orchestrator: `?filter=variation-mapping:
   * teleport` produced `values: []`, the page then sent NO parameter, and the grid came back with all **31**
   * rows under a banner saying the filter was not applied — while `GET ?variationMapping=teleport` answered
   * **0**. Two layers, two answers, and the page's answer was the dangerous one: a filter that WIDENS is a
   * lie, because the rows above it are not the rows the operator asked for. The banner naming the word does
   * not repair that — it explains a wrong row set.
   *
   * `restrictVariationMapping` on the server already has the right rule ("an active-but-unanswerable filter
   * narrows to nothing"), and VT.4b made it the single arbiter for the GRID path. This field is the same fix
   * for the URL path: the page reports what it could not honour and lets the arbiter narrow.
   */
  raw: string[]
} {
  if (!raw) return { values: [], unknown: [], raw: [] }
  const values: VariationMappingValue[] = []
  const unknown: string[] = []
  // Several `filter=` terms may ride in one parameter, separated by commas.
  for (const term of raw.split(',')) {
    const [key, rest] = term.split(':')
    if (key?.trim() !== VARIATION_MAPPING_URL_KEY) continue
    for (const token of (rest ?? '').split('|')) {
      const value = token.trim()
      if (!value) continue
      if (isVariationMappingValue(value)) { if (!values.includes(value)) values.push(value) }
      else if (!unknown.includes(value)) unknown.push(value)
    }
  }
  // Normalised to §5's order, exactly as `serialiseVariationMappingFilter` writes it: one selection is one
  // array, whatever order the URL happened to list it in, so a `useMemo` on it does not churn.
  const ordered = VARIATION_MAPPING_VALUES.filter((v) => values.includes(v))
  /* `raw` is ordered the same way for the same reason — a stable identity for a `useMemo` — with the
     unknown words appended in the order the URL listed them, since §5 has no place for them. */
  return { values: ordered, unknown, raw: [...ordered, ...unknown] }
}

/** The inverse, so a chip and a link write the same string. */
export function serialiseVariationMappingFilter(values: readonly VariationMappingValue[]): string | null {
  if (values.length === 0) return null
  // §5's order, not the click order: a URL that reorders on every click is a different URL for one state.
  const ordered = VARIATION_MAPPING_VALUES.filter((v) => values.includes(v))
  return `${VARIATION_MAPPING_URL_KEY}:${ordered.join('|')}`
}

/**
 * VT.4b — the ONE translation from the URL form to the REQUEST form.
 *
 * Two spellings exist and both are load-bearing, so this is the only place that converts between them:
 *  - the URL carries `?filter=variation-mapping:derived|collides` — design §3.7's spelling, which the mapping
 *    page's `[List]` button and VT.3 emit, and which an operator pastes;
 *  - the wire carries `?variationMapping=derived|collides` (VT.1b's `restrictVariationMapping`, which splits on
 *    `[|,]`), and the grid POST carries the same words as `context.filters.variationMapping`.
 *
 * A second converter anywhere else is the drift this function exists to prevent: the two forms differ only in
 * their key, and a page that re-derived one from the other would diverge the first time a value was added.
 */
export function toRequestParameter(values: readonly VariationMappingValue[]): string | null {
  if (values.length === 0) return null
  return VARIATION_MAPPING_VALUES.filter((v) => values.includes(v)).join('|')
}

/* ── the wire: one `ReadinessIndex` row, as the contract shapes it ──────────────────────────── */

export interface VariationReadinessItemRow {
  /** `theme-unset` | `collision` | `attribute-unbound`, plus every other readiness kind the index carries. */
  kind: string
  message?: string
  subjects?: string[]
  severity?: string
}

export interface VariationIndexRow {
  productId: string
  /** The canonical JSON tuple the index keys on. */
  coordinateKey: string
  channel: string | null
  market: string | null
  /** `ReadinessIndex.label`, e.g. `Amazon · IT`. */
  label?: string
  /** `ReadinessIndex.missing`, parsed. An EMPTY array means "computed, nothing missing". */
  missing: VariationReadinessItemRow[]
  /**
   * `ReadinessIndex.variationSource` — LANDED by VT.1b (2026-09-13, additive nullable TEXT + a partial index).
   * `null` / absent is NOT COMPUTED: a row written before the column existed, or a child row, which has no
   * projection of its own. It is matched by NO value, and in particular never by `derived`.
   */
  /**
   * 🔴 VT.1b's producer stamps the CATALOGUE FILTER's spelling — `overridden`, not `source.kind`'s `override`
   * — deliberately, "so the narrowing needs no translation table"
   * (`variation-rules.service.ts#variationSourceFor`). Both are accepted here because this module also reads
   * the READINESS payload, whose entries come from the same column; neither spelling is invented.
   */
  variationSource?: 'derived' | 'rule' | 'overridden' | 'override' | 'none' | null
}

/**
 * One coordinate's `Variation mapping` value, or `null` when the index cannot answer.
 *
 * Precedence, and why: a COLLISION outranks provenance. A coordinate can be correctly `overridden` and
 * still be unpublishable because two included variants collapse onto one key — and the filter exists to
 * find the coordinates that need work, so the blocking fact wins the single value a row can carry. `unset`
 * is next for the same reason (the projection has no theme at all). Provenance answers only when neither
 * problem is present.
 *
 * `attribute-unbound` deliberately does NOT map to a value: it is a WARNING (contracts §4 — the push still
 * goes out with the axis missing), and giving it a filter value would hide the provenance of every
 * coordinate that has one.
 */
export function variationMappingOf(row: VariationIndexRow): VariationMappingValue | null {
  const kinds = new Set(row.missing.map((item) => item.kind))
  if (kinds.has('collision')) return 'collides'
  if (kinds.has('theme-unset')) return 'unset'
  switch (row.variationSource) {
    case 'derived': return 'derived'
    case 'rule': return 'rule'
    case 'overridden': return 'overridden'
    case 'override': return 'overridden'
    // `none` without a `theme-unset` item is a contradiction on the wire: the resolver raises that item
    // for exactly this state. Report NOT COMPUTED rather than pick one of the two stories.
    case 'none': return 'unset'
    default: return null
  }
}

/** Does this coordinate match the selected values? An empty selection matches everything. */
export function matchesVariationMapping(
  row: VariationIndexRow,
  selected: readonly VariationMappingValue[],
): boolean {
  if (selected.length === 0) return true
  const value = variationMappingOf(row)
  return value !== null && selected.includes(value)
}

/**
 * Per-value counts over a set of index rows, plus the rows the index could not answer for.
 *
 * `unknown` is a first-class number, not a remainder to be inferred: "3 coordinates of 20 could not be
 * classified" and "17 are derived" are two facts, and a UI given only the second would print 17 beside a
 * total of 20 and leave the operator to guess what the other three are.
 */
export interface VariationMappingCounts {
  byValue: Record<VariationMappingValue, number>
  unknown: number
  rows: number
  /** How many distinct products the rows cover — the unit a FAMILY count prints. */
  products: number
}

export function countVariationMapping(rows: readonly VariationIndexRow[]): VariationMappingCounts {
  const byValue = Object.fromEntries(VARIATION_MAPPING_VALUES.map((v) => [v, 0])) as Record<VariationMappingValue, number>
  let unknown = 0
  const products = new Set<string>()
  for (const row of rows) {
    products.add(row.productId)
    const value = variationMappingOf(row)
    if (value === null) unknown += 1
    else byValue[value] += 1
  }
  return { byValue, unknown, rows: rows.length, products: products.size }
}

/* ── the family footer's per-coordinate counts (VT.4b item 3) ───────────────────────────────── */

/**
 * One entry of `GET /api/products/:id/readiness`'s `scopes[]`, narrowed to what this rule reads.
 *
 * `state: 'notComputed'` is R-LX-9's own word for "the index has no rows for this coordinate and language",
 * and it is kept distinct from a `variationSource` of `null` on a row that DOES exist: the first says nobody
 * looked at the coordinate, the second says nobody stamped the provenance. Both print `Not computed`, because
 * to an operator they are the same instruction — rebuild the index — but they are counted apart so a reader
 * of this code cannot collapse them by accident.
 */
export interface ReadinessScopeEntry {
  coordinateKey: string
  label: string
  state?: string
  missing?: VariationReadinessItemRow[]
  variationSource?: VariationIndexRow['variationSource']
}

export interface FamilyFooterCounts extends VariationMappingCounts {
  /** Coordinates whose index rows exist but carry no provenance, plus those with no rows at all. */
  notComputed: number
  /** `label` of every coordinate that matched something, for the footer's tooltip. */
  labelsByValue: Record<VariationMappingValue, string[]>
}

/**
 * The family's variation-mapping counts across every coordinate the readiness index holds for it.
 *
 * 🔴 It counts COORDINATES, not products, and the footer says so — the unit is the thing the count-and-result
 * disagreement rules exist to protect (VP.4 printed 40 pinned cells beside a 20-row family). A family with
 * 26 coordinate rows can be `derived` on 25 and `overridden` on one, which is exactly what GALE-JACKET is.
 */
export function familyFooterCounts(scopes: readonly ReadinessScopeEntry[]): FamilyFooterCounts {
  const byValue = Object.fromEntries(VARIATION_MAPPING_VALUES.map((v) => [v, 0])) as Record<VariationMappingValue, number>
  const labelsByValue = Object.fromEntries(VARIATION_MAPPING_VALUES.map((v) => [v, [] as string[]])) as Record<VariationMappingValue, string[]>
  let notComputed = 0
  for (const scope of scopes) {
    const value = variationMappingOf({
      productId: '',
      coordinateKey: scope.coordinateKey,
      channel: null,
      market: null,
      missing: scope.missing ?? [],
      variationSource: scope.variationSource,
    })
    if (value === null || scope.state === 'notComputed') { notComputed += 1; continue }
    byValue[value] += 1
    if (!labelsByValue[value].includes(scope.label)) labelsByValue[value].push(scope.label)
  }
  return { byValue, unknown: notComputed, notComputed, rows: scopes.length, products: 0, labelsByValue }
}

/**
 * The footer's sentence. `Not computed` is the ONLY thing an unclassified family says — never `0 collides`,
 * which would be a measurement nobody took, in the one place an operator reads a total.
 */
export function familyFooterSentence(counts: FamilyFooterCounts): string {
  const parts = VARIATION_MAPPING_VALUES
    .filter((value) => counts.byValue[value] > 0)
    .map((value) => `${counts.byValue[value]} ${VARIATION_MAPPING_LABELS[value].toLowerCase()}`)
  // 🔴 Nothing classified ⇒ the bare word, with no number. R-LX-9's vocabulary: "Readiness has not been
  // computed" is ONE fact, and "2 not computed" would invite an operator to read it as a partial result — the
  // instruction is the same whether it is 2 coordinates or 34. A number is only informative BESIDE a count
  // that was taken.
  if (parts.length === 0) return 'Not computed'
  if (counts.notComputed > 0) parts.push(`${counts.notComputed} not computed`)
  return parts.join(' · ')
}

/* ── the bulk verb: `Apply mapping rule…` (VX §11.4) ───────────────────────────────────────── */

export interface BulkApplyCandidate {
  productId: string
  sku: string
  /** One entry per coordinate the selection touches. */
  coordinates: Array<{
    channel: string
    market: string
    accountId: string | null
    aliasKey: string
    label: string
    /** The parent `ChannelListing.version` — the CAS token for this coordinate's PATCH. */
    expectedVersion: number
    /** The coordinate's current provenance; only an `override` has anything to clear. */
    source: 'derived' | 'rule' | 'override' | 'none'
    /** > 0 means this family is LISTED, never applied. */
    unresolvedCollisions: number
  }>
}

export interface BulkApplyPlan {
  /** Coordinates whose override would be cleared, so the rule or the derivation takes over. */
  apply: Array<{ productId: string; sku: string; coordinate: BulkApplyCandidate['coordinates'][number] }>
  /**
   * 🔴 Families the verb REFUSES to touch: a coordinate with an unresolved collision. VX §11.4's own
   * words — "Never touches a family with an unresolved collision — it lists them instead." Clearing an
   * override there would swap one unpublishable mapping for another and lose the operator's statement.
   */
  skipped: Array<{ productId: string; sku: string; coordinate: string; reason: string }>
  counts: { families: number; overridesRemoved: number; newCollisions: number; skippedFamilies: number }
  /** The sentence VX §11.4 prints in the confirm step. Server-shaped numbers, one composition. */
  summary: string
}

/**
 * What `Apply mapping rule…` would do — computed BEFORE anything is sent, from the coordinates' own
 * versions, so the confirm step's numbers are the numbers the apply uses.
 *
 * `newCollisions` is 0 by construction and that is a statement, not a placeholder: clearing an override
 * hands the coordinate to the rule or the derivation, and every family whose current mapping collides is
 * SKIPPED above, so this verb cannot create one. A family that would gain a collision from its rule is a
 * question for the mapping page's blast radius (VT.3), which simulates the rule itself.
 */
export function planBulkApply(candidates: readonly BulkApplyCandidate[]): BulkApplyPlan {
  const apply: BulkApplyPlan['apply'] = []
  const skipped: BulkApplyPlan['skipped'] = []
  const families = new Set<string>()
  const skippedFamilies = new Set<string>()
  for (const candidate of candidates) {
    for (const coordinate of candidate.coordinates) {
      if (coordinate.unresolvedCollisions > 0) {
        skipped.push({
          productId: candidate.productId,
          sku: candidate.sku,
          coordinate: coordinate.label,
          reason: `${coordinate.unresolvedCollisions} variants cannot be told apart on ${coordinate.label}. Resolve the collision before applying the rule.`,
        })
        skippedFamilies.add(candidate.productId)
        continue
      }
      if (coordinate.source !== 'override') continue
      apply.push({ productId: candidate.productId, sku: candidate.sku, coordinate })
      families.add(candidate.productId)
    }
  }
  const counts = {
    families: families.size,
    overridesRemoved: apply.length,
    newCollisions: 0,
    skippedFamilies: skippedFamilies.size,
  }
  const parts = [
    `${counts.families} ${counts.families === 1 ? 'family' : 'families'}`,
    `${counts.overridesRemoved} ${counts.overridesRemoved === 1 ? 'override' : 'overrides'} removed`,
    `${counts.newCollisions} new collisions`,
  ]
  if (counts.skippedFamilies > 0) {
    parts.push(`${counts.skippedFamilies} listed instead — ${counts.skippedFamilies === 1 ? 'it collides' : 'they collide'}`)
  }
  return { apply, skipped, counts, summary: parts.join(' · ') }
}

/**
 * The ONE request each apply sends: the projection PATCH with `reset: true`, CAS on that coordinate's own
 * `expectedVersion`. No second write path, and no batch endpoint — one CAS per family per coordinate is
 * what makes a partial failure reportable per row (VX §11.4's "results table").
 */
export function bulkApplyRequest(entry: BulkApplyPlan['apply'][number]): {
  method: 'PATCH'
  path: string
  query: Record<string, string>
  body: { expectedVersion: number; reset: true }
} {
  const { coordinate } = entry
  const query: Record<string, string> = { channel: coordinate.channel, market: coordinate.market }
  if (coordinate.accountId) query.accountId = coordinate.accountId
  if (coordinate.aliasKey) query.aliasKey = coordinate.aliasKey
  return {
    method: 'PATCH',
    path: `/api/products/${entry.productId}/studio/projection`,
    query,
    body: { expectedVersion: coordinate.expectedVersion, reset: true },
  }
}
