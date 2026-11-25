'use client'

import { ProgressBar } from '@nexus/ui/components'
import type { Translate } from '../../i18n/messages'
import { shippedPercentOf, type ShippedCellModel } from '../model'
import { useCellWords } from '../words'
import { DoorCell } from './DoorCell'
import '../order-cells.css'

/**
 * pg-w1 (18-lead-settles Z4; 10-design § 1.4) — Shipped, ONE cell for both faces (the Orders sheet's own cell, moved here): the DS
 * bar and "40 of 114" as its door (the tip in the host's words, `t`). The customer's next parcel, named by its order (D6: never the
 * office's shipment series), is the cell's tip. The words are the sheet's own, read in place (`orders`, `orders-sheet`).
 */
export function ShippedCell({ cell, t }: { cell: ShippedCellModel; t: Translate }) {
  const words = useCellWords()
  return (
    <span className="fw-so-progress" {...(cell.tip ? { title: cell.tip } : {})}>
      <ProgressBar value={shippedPercentOf(cell.shipped, cell.units)} ariaLabel={words.orders('list.shippedLabel', { number: cell.record })} height={6} />
      <DoorCell door={cell.door} t={t}>
        {words.sheet('shippedOf', { shipped: cell.shipped, units: cell.units })}
      </DoorCell>
    </span>
  )
}
