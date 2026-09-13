import { useMemo } from 'react'
import { useRegisterViewChip } from '../contracts'
import { buildSheetChips, type DiagnosticRow } from './sheetChips'

export function useSheetChips(rows: DiagnosticRow[] | null, columns: Array<{ key: string }>, options: {
  mapping?: boolean
  scope?: 'master' | 'channel'
  warningsId?: string
  mappingRun?: { skippedReason?: string | null; missingProductIds?: string[] } | null
} = {}) {
  const warningsId = options.warningsId ?? 'warnings'
  const chips = useMemo(() => {
    if (!rows && options.scope === 'channel') return []
    const result = buildSheetChips(rows ?? [], columns, options.mappingRun, { mapping: options.mapping, warningsId, scope: options.scope })
    return rows ? result : result.map(chip => ({ ...chip, count: null, note: options.scope === 'master' && chip.id === 'validation-errors' ? undefined : 'Counted once the sheet has loaded' }))
  }, [rows, columns, options.mappingRun, options.mapping, options.scope, warningsId])
  useRegisterViewChip('missing-required', chips.find(chip => chip.id === 'missing-required') ?? null)
  useRegisterViewChip(warningsId, chips.find(chip => chip.id === warningsId) ?? null)
  // Registration order is visible in the toolbar. Retain each scope's existing order.
  const third = options.mapping ? 'mapping-errors' : 'validation-errors'
  const fourth = options.mapping ? 'validation-errors' : 'mapping-errors'
  useRegisterViewChip(third, chips.find(chip => chip.id === third) ?? null)
  useRegisterViewChip(fourth, chips.find(chip => chip.id === fourth) ?? null)
}
