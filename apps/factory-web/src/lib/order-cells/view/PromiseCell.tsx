'use client'

import { Tag } from '@nexus/ui/primitives'
import type { Translate } from '../../i18n/messages'
import type { PromiseCellModel } from '../model'
import { useCellWords } from '../words'
import { DoorCell } from './DoorCell'
import '../order-cells.css'

/**
 * pg-w1 (18-lead-settles Z4; 10-design § 1.4, § 1.5) — Promised, ONE cell for both faces; the day is its door (the tip in the host's
 * words, `t`). Office (the Orders sheet's own cell, moved here): the day and, beside it, the Late tag while Where it is does not say
 * it; "No promise" / "Nessuna data promessa" wraps inside the cell, quieter, never cut. Customer: under the day "was …" (warning
 * words) when it moved, "date asked" for the customer's own day while nothing is promised, "wanted" for a request; no day: "No
 * promise" as the office says it, a request "—". The words are the part's own: `orders` (read in place) and `order-list` › customer.
 */
export function PromiseCell({ cell, t }: { cell: PromiseCellModel; t: Translate }) {
  const words = useCellWords()
  if (cell.face === 'office')
    return cell.day ? (
      <span className="fw-so-inline">
        <DoorCell door={cell.door} t={t}>
          {cell.day}
        </DoorCell>
        {cell.lateDays !== null && cell.lateDays !== undefined && cell.lateDays > 0 && <Tag tone="danger">{words.orders('list.daysLate', { count: cell.lateDays })}</Tag>}
      </span>
    ) : (
      // cw fx5 (walk W-14): "No promise" / "Nessuna data promessa" wraps inside the cell (quieter, two lines), never cut.
      <span className="fw-sheet-wraps is-quiet">
        <DoorCell door={cell.door} t={t}>
          {words.orders('list.noPromise')}
        </DoorCell>
      </span>
    )
  const of = cell.of ?? 'promise'
  if (!cell.day)
    return of === 'wanted' ? (
      <span className="fw-oc-sub">—</span>
    ) : (
      <span className="fw-sheet-wraps is-quiet">
        <DoorCell door={cell.door} t={t}>
          {words.orders('list.noPromise')}
        </DoorCell>
      </span>
    )
  const under = of === 'asked' ? words.list('customer.promise.asked') : of === 'wanted' ? words.list('customer.promise.wanted') : cell.was ? words.list('customer.promise.was', { date: cell.was }) : null
  return (
    <span className="fw-oc-stack">
      <DoorCell door={cell.door} t={t}>
        {cell.day}
      </DoorCell>
      {under && <span className={of === 'promise' ? 'fw-oc-sub is-warn' : 'fw-oc-sub'}>{under}</span>}
    </span>
  )
}
