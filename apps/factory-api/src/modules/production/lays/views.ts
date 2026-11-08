import { toUtcIso } from '@nexus/factory-domain/core/time'
import { lengthText } from '@nexus/factory-domain/inventory/rolls/rolls'
import type { LayStatus } from '@nexus/factory-domain/production/cutorders/rules'
import { garmentsPerPly, ratioText } from '@nexus/factory-domain/production/cutorders/rules'
import { CONSUMPTION_UOM, differenceWords, estimateOf, recordedOf } from '@nexus/factory-domain/production/lays/consumption'
import { atTableRefusal, spreadWords, stillNeeded } from '@nexus/factory-domain/production/lays/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { decimalText } from '../cutorders/store'
import { layLengthOf, markerOf, metres, plyOf, rollUom, rowUse, type LayState } from './store'

/**
 * The answers of a lay at the table (B-W2b-116): the lay report roll by roll with its running sums, the count, the fabric used
 * (estimate, the lay report's figure, what was confirmed, the difference in words) and what the caller may do next. Lengths are
 * decimal strings in the unit beside them (a roll: its own; the sums and the fabric used: metres). No money, no person.
 */

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const m4 = (value: Decimal): string => value.toFixed(4)

/** The table facts the rules read. */
export const tableFactsOf = (state: LayState) => ({
  cutOrderNumber: state.order.number,
  kind: state.order.kind,
  cutOrderStatus: state.order.status,
  laySeq: state.lay.seq,
  layStatus: state.lay.status,
  ticket: state.ticket ? { number: state.ticket.number, status: state.ticket.status } : null,
})

/** The plies the lay's rolls gave. */
export const spreadPlies = (state: Pick<LayState, 'rows'>): number => state.rows.reduce((sum, row) => sum + row.plies, 0)

/** The fabric used of a CUT lay: stored once confirmed, else as the lay report says it now. */
export function fabricUsedOf(state: LayState) {
  const marker = markerOf(state.order)
  if (state.lay.status !== 'CUT' || !marker) return null
  const plies = state.lay.plyCountLeft ?? spreadPlies(state)
  const stored = state.consumption
  const estimated = stored ? new Dec(stored.estimated.toString()) : estimateOf(marker, plies)
  const recorded = stored ? new Dec(stored.recorded.toString()) : recordedOf(state.rows.map((row) => ({ plies: row.plies, endLoss: new Dec(row.endLoss.toString()), uom: rollUom(row.roll) })), plyOf(state, CONSUMPTION_UOM))
  const confirmed = stored?.confirmed ? new Dec(stored.confirmed.toString()) : null
  const shown = confirmed ?? recorded
  return {
    posted: stored !== null,
    uom: CONSUMPTION_UOM,
    plies,
    estimated: m4(estimated),
    recorded: m4(recorded),
    confirmed: confirmed ? m4(confirmed) : null,
    confirmedAt: at(stored?.confirmedAt ?? null),
    note: stored?.note ?? null,
    version: stored?.version ?? null,
    /** The confirmed figure (else the lay report's) against the estimate. */
    words: { it: differenceWords(shown, estimated, 'it'), en: differenceWords(shown, estimated, 'en') },
    /** The lay report's figure against the estimate. */
    recordedWords: { it: differenceWords(recorded, estimated, 'it'), en: differenceWords(recorded, estimated, 'en') },
  }
}

export function layView(state: LayState) {
  const { order, lay } = state
  const marker = markerOf(order)
  const plies = spreadPlies(state)
  const plyM = plyOf(state, 'M')
  const used = state.rows.reduce((sum, row) => sum.plus(metres(rowUse(state, row), rollUom(row.roll))), ZERO)
  const table = atTableRefusal(tableFactsOf(state))
  const open = table === null
  const status = lay.status as LayStatus
  const layLength = layLengthOf(lay)
  return {
    lay: {
      id: lay.id,
      cutOrderId: order.id,
      seq: lay.seq,
      of: state.live,
      plies: lay.plies,
      status,
      layLength: layLength ? new Dec(layLength.length).toFixed(4) : null,
      lengthUom: layLength?.uom ?? null,
      /** One ply off a roll, in metres (the lay's length on the table, else the marker). */
      plyMetres: m4(plyM),
      counted: status === 'CHECKED' || status === 'CUT' ? { left: lay.plyCountLeft!, right: lay.plyCountRight!, checkedAt: at(lay.checkedAt)! } : null,
      cutAt: at(lay.cutAt),
      version: lay.version,
    },
    cutOrder: {
      id: order.id,
      number: order.number,
      kind: order.kind,
      status: order.status,
      material: { item: { id: order.item.id, code: order.item.code, name: order.item.name }, colour: order.itemColour },
      marker: marker && order.markerName ? { name: order.markerName, length: new Dec(marker.length).toFixed(4), uom: marker.uom, widthCm: decimalText(order.markerWidthCm, 2), words: { it: lengthText(marker.length, marker.uom, 'it'), en: lengthText(marker.length, marker.uom, 'en') } } : null,
      ratio: ratioText(state.lines.map((line) => ({ size: line.workOrderSize.size, ratio: line.ratio }))),
      garmentsPerPly: garmentsPerPly(state.lines),
    },
    ticket: state.ticket ? { id: state.ticket.id, number: state.ticket.number, code: state.ticket.scanCode, status: state.ticket.status } : null,
    rolls: state.rows.map((row) => {
      const uom = rollUom(row.roll)
      return {
        id: row.id,
        seq: row.seq,
        rollId: row.rollId,
        code: row.roll.code,
        lotCode: row.roll.lot.code,
        plies: row.plies,
        splices: row.splices,
        endLoss: decimalText(row.endLoss)!,
        endReturned: decimalText(row.endReturned)!,
        uom,
        /** What it gave the lay (plies × ply + end loss), in its unit. */
        used: m4(rowUse(state, row)),
        state: row.roll.state,
        lengthLeft: decimalText(row.roll.lengthLeft)!,
        shade: row.roll.shade,
        shrinkageGroup: row.roll.shrinkageGroup,
        version: row.version,
      }
    }),
    spread: {
      plies,
      rolls: state.rows.length,
      needed: stillNeeded(lay.plies, plies),
      /** What the rolls gave, in metres. */
      used: m4(used),
      words: marker ? { it: spreadWords({ plies, rolls: state.rows.length, ply: plyM, uom: 'M' }, 'it'), en: spreadWords({ plies, rolls: state.rows.length, ply: plyM, uom: 'M' }, 'en') } : null,
    },
    fabricUsed: fabricUsedOf(state),
    refusal: table,
    can: {
      spread: open,
      count: open && (status === 'SPREADING' || status === 'CHECKED') && plies > 0,
      fabricUsed: status === 'CUT' && (order.status === 'IN_PROGRESS' || order.status === 'CUT'),
    },
  }
}
export type LayView = ReturnType<typeof layView>
