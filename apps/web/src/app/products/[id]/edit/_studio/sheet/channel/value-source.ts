import type { StudioCellValue } from './types'

/** Reset removes the override. Only a declared Master input warrants promising Master. */
export function resetSourceLabel(cell: StudioCellValue): string {
  return cell.mapped?.sourcePath && !cell.mapped.usesExpression && !cell.mapped.supplyingRule
    ? 'follow Master'
    : 'use the configured mapping or default; the field may become empty if none is configured'
}
