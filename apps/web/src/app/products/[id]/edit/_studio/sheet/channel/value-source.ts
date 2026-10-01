import type { StudioCellValue } from './types'
import { wholeListWriteField } from './provenance'

/** Reset removes the override. Only a declared Master input warrants promising Master. */
export function resetSourceLabel(cell: StudioCellValue): string {
  return cell.mapped?.sourcePath && !cell.mapped.usesExpression && !cell.mapped.supplyingRule
    ? 'follow Master'
    : 'use the configured mapping or default; the field may become empty if none is configured'
}

/**
 * The reset's words, for Cell details and the cell menu. An old listing text is not an override anybody made: its
 * reset is "Follow Shared" (P1, report 2 I-3), which stops using the listing's own text for this language.
 */
export function resetActionWords(cell: StudioCellValue, subject: { sku: string; listing: string }): { label: string; description: string } {
  if (cell.source === 'channelSnapshot') return {
    label: 'Follow Shared',
    description: `Stop using this listing’s own text for ${subject.sku} · ${subject.listing} and ${resetSourceLabel(cell)}.`,
  }
  const list = !!wholeListWriteField(cell.writeField)
  return {
    label: list ? 'Review removing list override…' : 'Remove listing override',
    description: `Remove this ${list ? 'whole list’s' : 'listing'} override and ${resetSourceLabel(cell)}.`,
  }
}
