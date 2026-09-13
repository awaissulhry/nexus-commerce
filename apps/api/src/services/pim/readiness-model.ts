import { marketLanguages, type MarketLanguageRow } from './market-languages.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import type { StudioSheet } from './studio-sheet.service.js'
/**
 * R-LX-9 (on LX.R's P1-5) — `notComputed` is a FIFTH scope state, not a flavour
 * of `absent`. `absent` means "nothing is set up for this scope"; `notComputed`
 * means "nobody has computed readiness for this coordinate and language yet", and
 * an empty `ReadinessIndex` (production: 0 rows) rendered the two identically —
 * an unmeasured scope read as a measured empty one. The DS table in
 * `design-system/grid/renderers/readiness.ts` carries the matching word and tone.
 */
export type ScopeState = 'ready' | 'warn' | 'blocked' | 'absent' | 'notComputed'
/**
 * The one API-side member list, ORDERED BY SEVERITY (most attention first).
 *
 * LX.F F6: the catalogue's readiness sort was `ORDER BY r.state`, i.e. alphabetical
 * — `absent < blocked < notComputed < ready < warn` — so "sort by readiness" put
 * `ready` before `warn` and buried `blocked` in the middle. The vocabulary has an
 * order and this is it; `scopeStateRank()` is the only place it is written, and the
 * SQL builds its CASE from this array rather than restating it.
 */
export const SCOPE_STATES: readonly ScopeState[] = ['blocked', 'warn', 'notComputed', 'absent', 'ready']
/** 0 = needs attention most. Unknown states sort last, never silently first. */
export const scopeStateRank = (state: string): number => {
  const rank = SCOPE_STATES.indexOf(state as ScopeState)
  return rank === -1 ? SCOPE_STATES.length : rank
}

export interface ScopeReadiness {
  languages?: Array<{ language: string; pct: number | null; state: ScopeState }>
  /** `master`, or the channel name (`AMAZON`, `EBAY`, …). */
  id: string
  label: string
  pct: number | null
  required: { filled: number; total: number }
  state: ScopeState
  /** Why `pct` is null, or why the scope is absent. Rendered beside the chip. */
  note?: string
  aliasCount: number
  /** Rules applicable to the selected categories. Explicit listing values can
   * also supply fields without a mapping rule. `null` for Master. */
  mappingRules: number | null
}

export interface ProductReadiness {
  market: string
  locale: string
  scopes: ScopeReadiness[]
  computedAt: string
  matrix: ReadinessMatrixEntry[]
}

/** Summarize the same rows and validators the editor serves, including listing aliases. */
export function readinessFromSheet(sheet: StudioSheet, mappingRules: number | null): ScopeReadiness {
  const required = sheet.rows.reduce((sum, row) => ({
    filled: sum.filled + row.completeness.required.filled,
    total: sum.total + row.completeness.required.total,
  }), { filled: 0, total: 0 })
  const issues = sheet.rows.flatMap(row => row.readiness.issues)
  const missing = sheet.meta.schemaMissing
  const mappingUnavailable = sheet.scope.kind === 'channel' && (!sheet.meta.mapping || !!sheet.meta.mapping.skippedReason || sheet.meta.mapping.missingProductIds.length > 0)
  const unavailable = missing.length > 0 || required.total === 0 || mappingUnavailable
  return {
    id: sheet.scope.channel ?? 'master', label: sheet.scope.label, required,
    pct: unavailable ? null : Math.round(100 * required.filled / required.total),
    state: issues.some(i => i.severity === 'error') ? 'blocked' : missing.length > 0 || required.total === 0 ? 'absent'
      : mappingUnavailable || issues.length > 0 ? 'warn' : 'ready',
    ...(missing.length ? { note: `Category metadata is incomplete: ${missing.join(', ')}` }
      : mappingUnavailable ? { note: sheet.meta.mapping?.skippedReason ?? 'Channel mapping values have not been fully checked' }
      : required.total === 0 ? { note: 'No required attributes are defined for this scope' }
      : { note: `${required.filled} of ${required.total} required values filled across this scope. Row completeness also includes optional attributes. Information completeness does not establish publication eligibility or provider acceptance.` }),
    aliasCount: sheet.aliases.filter(alias => alias.id !== null).length,
    mappingRules,
  }
}


export interface MissingReadinessField { productId: string; field: string; label: string; reason: string }
export interface ReadinessCoordinate { channel: string | null; market: string | null; accountId: string | null; aliasId: string | null }
export interface ReadinessMatrixEntry extends ScopeReadiness, ReadinessCoordinate {
  language: string
  coordinateKey: string
  missing: MissingReadinessField[]
  computedAt: string | null
  /**
   * VT.4b — `ReadinessIndex.variationSource` for this coordinate, relayed so the reader of the index can answer
   * the same provenance question its writer stamps. VT.1b's spelling (`overridden`, the catalogue filter's
   * word, not `source.kind`'s `override`).
   *
   * 🔴 `null` is NOT COMPUTED and never `derived` — a row written before the column existed, or a CHILD row,
   * which has no projection of its own. A coordinate's rows can span the parent and its children, so the value
   * is the first non-null one: the children legitimately contribute nothing.
   */
  variationSource: 'derived' | 'rule' | 'overridden' | 'none' | null
  /**
   * LX.FIN (R-LX-22, design §8 LX.15) — this coordinate's verdict **per product in the family**, in the SCOPE
   * vocabulary, so the master sheet's per-coordinate readiness column has something true to put in each ROW.
   *
   * 🔴 It is the SAME summary function as the coordinate's own verdict, run over one product's rows — not a
   * second answer to the same question, and not a mapping from the ROW vocabulary. `ReadinessIndex` is keyed
   * `(productId, coordinateKey, language)`, so a per-product verdict is a filter, not a derivation; PES.0 hub
   * ruling #3 (no converter between the two readiness vocabularies) is untouched because nothing is converted.
   *
   * A product with no row for this coordinate and language is ABSENT FROM THIS MAP, and its cell renders
   * `Not computed` — the R-LX-9 rule one column over: absent is not empty, and a missing key must never read as
   * a score. An empty object is therefore a legitimate value (nothing computed for this coordinate at all).
   */
  byProduct: Record<string, { state: ScopeState; pct: number | null; note?: string }>
}

export function readinessCoordinateKey(c: ReadinessCoordinate): string {
  return JSON.stringify([c.channel, c.market, c.accountId, c.aliasId])
}

/** Ordered union of the marketplace authority, with the shared source first. */
export function readinessLanguages(markets: readonly MarketLanguageRow[]): string[] {
  return [...new Set([PRIMARY_CONTENT_LOCALE, ...markets.flatMap(m => marketLanguages(m.channel, m.code, [m]))])]
}
