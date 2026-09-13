import type { ViewChip } from '../types'

interface LanguageCell { requested?: string; language?: string; translation?: { source: string; reviewedAt: string | null; outdated: boolean } }
const rules = [
    { id: 'needs-translation', label: 'Needs translation', test: (cell: LanguageCell) => !!cell.requested && cell.language !== cell.requested },
    { id: 'ai-drafts', label: 'AI drafts', test: (cell: LanguageCell) => !!cell.translation && cell.translation.source !== 'manual' && !cell.translation.reviewedAt },
    { id: 'out-of-date', label: 'Out of date', test: (cell: LanguageCell) => cell.translation?.outdated === true },
  ]

/** Missing means a fallback answered, even when that fallback is non-empty. */
export function languageChips(rows: Array<{ id: string; rowId?: string; values: Record<string, LanguageCell> }> | null, columns: readonly { key: string; localizable?: boolean; locale?: string }[]): ViewChip[] {
  const text = new Set(columns.filter(column => column.localizable || column.locale).map(column => column.key))
  return rules.map(rule => {
    const byRow: Record<string, string[]> = {}
    for (const row of rows ?? []) {
      const keys = Object.entries(row.values).filter(([key, cell]) => text.has(key) && rule.test(cell)).map(([key]) => key)
      if (keys.length) byRow[row.rowId ?? row.id] = keys
    }
    return { id: rule.id, label: rule.label, tone: 'neutral', hideWhenZero: false,
      count: rows ? { n: Object.values(byRow).reduce((sum, keys) => sum + keys.length, 0), unit: 'cells' } : null, cells: { byRow } }
  })
}

/** S2 keeps its three language filters visible before the generic sheet findings. */
export function orderLanguageChips<T extends { id: string }>(chips: readonly T[], languagesView: boolean): readonly T[] {
  if (!languagesView) return chips
  const rank = (id: string) => { const index = rules.findIndex(rule => rule.id === id); return index < 0 ? rules.length : index }
  return [...chips].sort((a, b) => rank(a.id) - rank(b.id))
}
