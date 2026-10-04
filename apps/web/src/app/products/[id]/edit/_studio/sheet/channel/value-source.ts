import type { StudioCellValue } from './types'
import { wholeListWriteField } from './provenance'

/** A reset returns the cell to the Shared product: only a declared Shared input (a plain source path) warrants it. */
export function resetFollowsShared(cell: Pick<StudioCellValue, 'mapped'>): boolean {
  return !!cell.mapped?.sourcePath && !cell.mapped.usesExpression && !cell.mapped.supplyingRule
}

/** Reset removes the override. Only a declared Shared input warrants promising the Shared product. */
export function resetSourceLabel(cell: StudioCellValue): string {
  return resetFollowsShared(cell)
    ? 'follow the Shared product'
    : 'use the configured mapping or default; the field may become empty if none is configured'
}

/**
 * The ONE name of a channel cell's reset — the cell menu (`channelResetOffer`) and Cell details both say it, so the
 * same pinned cell never offers "Reset to inherited" in one place and another word in the other (2026-10-04). An old
 * listing text is not an override anybody made: its reset is "Follow Shared" (P1, report 2 I-3).
 */
export function channelResetLabel(cell: Pick<StudioCellValue, 'source' | 'writeField'>): string {
  if (cell.source === 'channelSnapshot') return 'Follow Shared'
  return wholeListWriteField(cell.writeField) ? 'Reset list to inherited…' : 'Reset to inherited'
}

/**
 * The reset's words for Cell details: the menu's label (`channelResetLabel`) and the fuller description. An old listing
 * text's reset stops using the listing's own text for this language.
 */
export function resetActionWords(cell: StudioCellValue, subject: { sku: string; listing: string }): { label: string; description: string } {
  if (cell.source === 'channelSnapshot') return {
    label: channelResetLabel(cell),
    description: `Stop using this listing’s own text for ${subject.sku} · ${subject.listing} and ${resetSourceLabel(cell)}.`,
  }
  const list = !!wholeListWriteField(cell.writeField)
  return {
    label: channelResetLabel(cell),
    description: `Remove this ${list ? 'whole list’s' : 'listing'} override and ${resetSourceLabel(cell)}.`,
  }
}
