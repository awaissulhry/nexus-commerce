import { marketLanguages, type MarketLanguageRow } from './market-languages.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import type { StudioSheet } from './studio-sheet.service.js'
import type { SheetColumn } from './sheet-columns.service.js'
import { columnRequiredHere } from '@nexus/shared/master-sheet'
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
  /**
   * P2 (docs/attributes/PLAN.md §4.7) — the earliest pending mark among this scope's rows: a bulk edit changed values
   * and the rebuild has not run yet. `pct`, `state` and `required` are then the PREVIOUS answer — show "checking…",
   * never the old state as current. Absent = every row is current.
   */
  pendingSince?: string
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


export interface MissingReadinessField {
  productId: string
  field: string
  label: string
  reason: string
  /** The issue vocabulary (LX.F P2-14 / VT.1b) — unchanged; readers match it, never the sentence. */
  kind?: string
  /**
   * A-45 (Step 4.3 #4) — this field is REQUIRED here and EMPTY: a member of the row's
   * `completeness.required.missing`, the same set behind `requiredFilled` / `requiredTotal`. A flag, not a
   * `kind`, because one field is one entry (LX.F P1-4): a required untranslated field is already
   * `kind: 'language-fallback'` and must not become a second row. Per index row, the flagged count
   * equals `requiredTotal − requiredFilled`; a row written before this flag existed has fewer, and a
   * reader says so ("not recorded yet") instead of listing a guess.
   */
  requiredEmpty?: true
  /**
   * P7 (docs/attributes/PLAN.md §4.6, §10.8) — WHO requires this field here, on a `requiredEmpty` entry: a channel
   * coordinate's label (`"Amazon · IT"`, its category schema or a mapping rule) and/or `"Family: <label>"` (the
   * product family's required flag). The same disjuncts `completenessFor` counts, so the list is never empty on an
   * entry the count includes. Absent on a row written before P7 = not recorded, never "nobody".
   */
  requiredBy?: string[]
}

/** The fallback reason for a required field no validator named (e.g. rule-required, conditional). */
export const REQUIRED_EMPTY_REASON = 'Required and empty'

/**
 * A-45 (Step 4.3 #4) — one sheet row's `ReadinessIndex.missing[]`: its readiness issues, as before, with
 * every required-and-empty field FLAGGED. An issue already on that field is flagged in place (one field,
 * one entry); a required-empty field no validator named gets one entry of its own. Pure.
 */
export function readinessMissingEntries(row: Pick<StudioSheet['rows'][number], 'id' | 'readiness' | 'completeness'>, sourcesOf?: (field: string) => string[]): MissingReadinessField[] {
  const empty = new Map((row.completeness?.required?.missing ?? []).map(m => [m.key, m.label]))
  const entries: MissingReadinessField[] = row.readiness.issues.map(issue => ({ productId: row.id, field: issue.key,
    label: issue.label, reason: issue.message, ...(issue.kind ? { kind: issue.kind } : {}) }))
  const requiredBy = (field: string) => {
    const sources = sourcesOf?.(field) ?? []
    return sources.length ? { requiredBy: sources } : {}
  }
  const flagged = new Set<string>()
  for (const entry of entries) {
    if (!empty.has(entry.field) || flagged.has(entry.field)) continue
    entry.requiredEmpty = true
    Object.assign(entry, requiredBy(entry.field))
    flagged.add(entry.field)
  }
  for (const [field, label] of empty) {
    if (flagged.has(field)) continue
    entries.push({ productId: row.id, field, label, reason: REQUIRED_EMPTY_REASON, requiredEmpty: true, ...requiredBy(field) })
    flagged.add(field)
  }
  return entries
}

/**
 * P7 (docs/attributes/PLAN.md §4.6) — the sources behind ONE required field on ONE sheet row: the same three
 * disjuncts `completenessFor` (sheet-rows.service.ts) ORs into `required`, named instead of collapsed.
 *
 *   · the channel resolver marked the cell required (`mapped.requiredByRule`: the category schema, one of Amazon's
 *     conditional rules, or a mapping rule) → this scope's coordinate label;
 *   · the family requires it everywhere (the `'Master'` requirement) → `"Family: <label>"`;
 *   · a coordinate in `requiredBy` requires it on this row → that coordinate's label.
 *
 * Pure. `coordinateLabel` is null on the Master scope, where nothing is resolved through a channel.
 */
export function requirementSources(
  column: SheetColumn | undefined,
  row: { productType: string | null; familyId?: string | null; values?: Record<string, { mapped?: { requiredByRule?: boolean } | null } | undefined> },
  coordinateLabel: string | null,
  familyLabel: (familyId: string) => string | undefined,
): string[] {
  if (!column) return []
  const out: string[] = []
  const add = (source: string) => { if (!out.includes(source)) out.push(source) }
  const values = row.values as Record<string, unknown> | undefined
  if (coordinateLabel && row.values?.[column.key]?.mapped?.requiredByRule === true) add(coordinateLabel)
  // `'Master'` is the family's rule when the column carries family rules, and the shared record's own rule otherwise.
  if (columnRequiredHere(column, 'Master', row.productType, row.familyId, values)) {
    add(column.familyRules ? `Family: ${familyLabel(row.familyId ?? '') ?? 'unnamed family'}` : 'Shared product')
  }
  for (const label of column.requiredBy) {
    if (label !== 'Master' && columnRequiredHere(column, label, row.productType, row.familyId, values)) add(label)
  }
  return out
}
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
  byProduct: Record<string, { state: ScopeState; pct: number | null; note?: string; required: { filled: number; total: number }; computedAt: string | null; pendingSince?: string }>
}

export function readinessCoordinateKey(c: ReadinessCoordinate): string {
  return JSON.stringify([c.channel, c.market, c.accountId, c.aliasId])
}

/** Ordered union of the marketplace authority, with the shared source first. */
export function readinessLanguages(markets: readonly MarketLanguageRow[]): string[] {
  return [...new Set([PRIMARY_CONTENT_LOCALE, ...markets.flatMap(m => marketLanguages(m.channel, m.code, [m]))])]
}
