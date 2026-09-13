import type { ViewChip } from '../types'
import { productSheetRowKey } from './productSheetRows'

interface DiagnosticCell { mapped?: { status?: string; mappingErrors?: unknown[]; errors?: unknown[] } | null }
export interface DiagnosticRow {
  id: string
  rowId?: string
  parentId: string | null
  values: Record<string, DiagnosticCell>
  readiness?: { issues: Array<{ key: string; severity: string }> } | null
  completeness?: { required?: { missing?: Array<{ key: string }> } }
}

/** Mirrors the frame's `ViewChipCells` without importing across the lane boundary for a type. */
export interface ChipCells {
  byRow: Record<string, string[]>
}

export interface ChipDraft {
  id: string
  label: string
  tone?: 'warning' | 'danger' | 'info' | 'neutral'
  count: ViewChip['count']
  hideWhenZero?: boolean
  note?: string
  cells: ChipCells
}

interface Accum {
  byRow: Record<string, string[]>
  cells: number
  /** Issue keys that are not columns on this scope — real, but not reachable from this sheet. */
  unreachable: Set<string>
}

const empty = (): Accum => ({ byRow: {}, cells: 0, unreachable: new Set() })

function add(acc: Accum, rowId: string, colId: string): void {
  const list = acc.byRow[rowId] ?? (acc.byRow[rowId] = [])
  if (!list.includes(colId)) {
    list.push(colId)
    acc.cells++
  }
}

/**
 * True when every row carried a readiness object. When one did not, the scope is NOT counted —
 * a partial count reported as a total is the dishonest half of this contract.
 */
function fullyCounted(rows: DiagnosticRow[]): boolean {
  return rows.every((r) => !!r.readiness && Array.isArray(r.readiness.issues))
}

function noteFor(counted: boolean, acc: Accum, why: string): string | undefined {
  if (!counted) return why
  if (acc.unreachable.size > 0) {
    const keys = [...acc.unreachable].sort().join(', ')
    return `${acc.unreachable.size} more on fields this view does not show (${keys}) — switch view to reach them`
  }
  return undefined
}

/**
 * Build the channel scope's chips from the rows it already holds.
 *
 * No fetch, no second source of truth: readiness comes from the same payload the grid renders, so
 * the chip and the cells it filters to cannot disagree.
 */
export function buildSheetChips(
  rows: DiagnosticRow[],
  columns: Array<{ key: string }>,
  mappingRun?: { skippedReason?: string | null; missingProductIds?: string[] } | null,
  options: { mapping?: boolean; warningsId?: string; scope?: 'master' | 'channel' } = {},
): ChipDraft[] {
  const colIds = new Set(columns.map((c) => c.key))
  const sharedProduct = options.scope === 'master'
  const counted = sharedProduct || fullyCounted(rows)
  const requiredCounted = rows.every((r) => Array.isArray(r.completeness?.required?.missing))

  const required = empty()
  const invalid = empty()
  const warnings = empty()
  const mapping = empty()

  for (const row of rows) {
    const missing = new Set(row.completeness?.required?.missing?.map((m) => m.key) ?? [])
    for (const key of missing) {
      if (colIds.has(key)) add(required, productSheetRowKey(row), key)
      else required.unreachable.add(key)
    }
    for (const issue of row.readiness?.issues ?? []) {
      if (sharedProduct && issue.severity !== 'error' && issue.severity !== 'warn') continue
      if (missing.has(issue.key) && issue.severity === 'error') continue
      const target = issue.severity === 'error' ? invalid : warnings
      if (!colIds.has(issue.key)) {
        target.unreachable.add(issue.key)
        continue
      }
      add(target, productSheetRowKey(row), issue.key)
    }
    // The mapping engine's own verdict, read never computed (layout §1).
    for (const [colId, cell] of Object.entries(row.values) as Array<[string, DiagnosticCell]>) {
      if (!colIds.has(colId)) continue
      if ((cell.mapped?.mappingErrors ?? cell.mapped?.errors ?? []).length > 0) add(mapping, productSheetRowKey(row), colId)
    }
  }

  const chips: ChipDraft[] = [
    {
      id: 'missing-required',
      label: 'Missing required',
      // §6.2 rule 1 (#362), the MASTER rule, applied here too (CH.1): a count of WORK is a view, not
      // an alarm. Master and channel now draw this chip identically; Warnings and Mapping errors
      // keep their glyphs because they ARE alarms.
      tone: 'neutral',
      count: requiredCounted ? { n: required.cells, unit: 'cells' } : null,
      ...(sharedProduct ? {} : { hideWhenZero: true }),
      note: sharedProduct ? undefined : noteFor(
        requiredCounted,
        required,
        'Readiness has not been computed for every row yet — this is not a count of zero',
      ),
      cells: { byRow: required.byRow },
    },
    {
      id: 'validation-errors',
      label: 'Invalid values',
      tone: 'danger',
      count: counted ? { n: invalid.cells, unit: 'cells' } : null,
      hideWhenZero: true,
      note: sharedProduct ? undefined : noteFor(counted, invalid, 'Validation has not been computed for every row yet'),
      cells: { byRow: invalid.byRow },
    },
    {
      id: options.warningsId ?? 'warnings',
      label: 'Warnings',
      // `neutral`, the same as master's Warnings chip (CH.1): a count of WORK, not an alarm (§6.2 rule 1).
      tone: 'neutral',
      count: counted ? { n: warnings.cells, unit: 'cells' } : null,
      hideWhenZero: true,
      note: sharedProduct ? 'A value the channel would accept but flag — the same rule the channel scopes count' : noteFor(
        counted,
        warnings,
        'Readiness has not been computed for every row yet — this is not a count of zero',
      ),
      cells: { byRow: warnings.byRow },
    },
    {
      id: 'mapping-errors',
      label: 'Mapping errors',
      tone: 'danger',
      // Null cells also occur when enrichment failed. Only a complete mapping run is counted.
      count: mappingRun === null || mappingRun?.skippedReason || mappingRun?.missingProductIds?.length ? null : { n: mapping.cells, unit: 'cells' },
      hideWhenZero: true,
      note: mappingRun === null ? 'Mapping has not been checked for this scope yet' : mappingRun?.skippedReason ?? (mappingRun?.missingProductIds?.length
        ? 'Mapping has not been checked for every product yet'
        : 'The mapping result has an error. Open Channel mapping to review the source rule and preview value.'),
      cells: { byRow: mapping.byRow },
    },
  ]
  return options.mapping ? chips : chips.filter(chip => chip.id !== 'mapping-errors')
}
