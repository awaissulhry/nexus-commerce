'use client'

import { Pill } from '@nexus/ui/primitives'
import type { StateChipModel } from '../model'
import '../order-cells.css'

/**
 * pg-w1 (18-lead-settles Z1, Z16 P4; 10-design § 1.5) — the status chip of an order: the DS Pill with its group's mark (11 px), the
 * status in words and, on the phone card, the shipped pieces after a dot. ONE chip for one status on every page: the office's sheet
 * (its Where it is cell draws it for an order with no stage kept), the customer's portal list and the order page's band; the tone is
 * the office's for the same status (ORDER_STATUS_TONE). A closed one is outlined. It draws its model and nothing else.
 */
export function StateChip({ chip }: { chip: StateChipModel }) {
  const Icon = chip.mark
  return (
    <Pill tone={chip.tone} icon={<Icon size={11} aria-hidden />} className={chip.line ? 'fw-sheet-st is-line' : 'fw-sheet-st'}>
      {chip.words}
      {chip.tail ? ` · ${chip.tail}` : ''}
    </Pill>
  )
}
