import type { PickerReason } from '../../../_shared/reasons/api'
import type { HideRow } from '../../../_shared/stock/api'
import { decimalValue, phrase } from '../../../_shared/stock/model'
import type { ReserveHide } from '../../stock/daily/dialog-model'
import { demandLabel, holdOfRow, reasonLabel, type HoldFact, type WriteOffTarget } from '../../stock/daily/model'

/**
 * The every-day abilities and rules Hides (SCR-200) and Lots & traceability (SCR-201) share (B-W2a-64), pure: what the
 * person may do beyond reading stock (reserve, scrap, put on hold, raise an NCR, add a photo, release lots, see work
 * orders, the cost grain), why a hide is held in words (a quality hold's reason, never "free"), which selected hides a
 * reservation can take (and why the others are left out), and the Scrap N hides target.
 */

export interface DailyCan {
  reserve: boolean
  scrap: boolean
  holdsView: boolean
  holdsPlace: boolean
  ncrRaise: boolean
  filesUpload: boolean
  lotsRelease: boolean
  workOrders: boolean
  cost: boolean
}

export function dailyCan(permissions: readonly string[]): DailyCan {
  const held = new Set(permissions)
  return {
    reserve: held.has('inventory.reserve'),
    scrap: held.has('inventory.scrap'),
    holdsView: held.has('quality.holds.view'),
    holdsPlace: held.has('quality.holds.place'),
    ncrRaise: held.has('quality.ncr.raise'),
    filesUpload: held.has('files.upload'),
    lotsRelease: held.has('quality.lots.release'),
    workOrders: held.has('workorders.view'),
    cost: held.has('money.cost'),
  }
}

/** The ACTIVE quality holds by the held record's id, as a plain object (a view model can carry it). */
export type HoldsBySubject = Readonly<Record<string, HoldFact>>
export const holdMap = (holds: HoldsBySubject): Map<string, HoldFact> => new Map(Object.entries(holds))

/** The hold that holds a hide: its own, else its lot's. */
export const holdOfHide = (holds: HoldsBySubject, hide: Pick<HideRow, 'id' | 'lot'>): HoldFact | null => holdOfRow(holdMap(holds), { lotId: hide.lot.id, hideId: hide.id })

/** A hold's reason in the person's words ("Controllo qualità"), its code when the list does not know it. */
export const holdReasonWords = (hold: HoldFact, reasons: readonly PickerReason[], locale: string): string => reasonLabel(reasons, hold.reasonCode, locale)

/** Nothing of the hide to reserve or scrap: used up, scrapped, or nothing on hand (at a work order). */
export const hideGone = (hide: Pick<HideRow, 'state' | 'onHand'>): boolean => hide.state === 'CONSUMED' || hide.state === 'SCRAPPED' || (decimalValue(hide.onHand) ?? 0) <= 0

/**
 * The hides a reservation to a work order can take, each free or left out with why (the API refuses the same): on hold
 * (its own or its lot's quality hold), its lot not released, reserved already, or nothing of it in stock.
 */
export function reserveHides(rows: readonly HideRow[], holds: HoldsBySubject, reasons: readonly PickerReason[], locale: string): ReserveHide[] {
  return rows.map((row) => {
    const hold = holdOfHide(holds, row)
    const why = hold
      ? phrase('reserve.why.onHold', { reason: holdReasonWords(hold, reasons, locale) })
      : row.lot.qualityStatus !== 'RELEASED'
        ? phrase('reserve.why.lotHeld')
        : row.reservedFor
          ? phrase('reserve.why.reserved', { demand: demandLabel(row.reservedFor.demand) })
          : hideGone(row)
            ? phrase('reserve.why.notInStock')
            : null
    return { id: row.id, code: row.code, lotCode: row.lot.code, area: row.left, uom: row.item.baseUom, why }
  })
}

/** Why "Reserve to a work order…" is held for a selection (a key of warehouse-lots), or null. */
export function reserveSelectionHeld(rows: readonly Pick<HideRow, 'siteId'>[], can: Pick<DailyCan, 'reserve'>): string | null {
  if (!can.reserve) return 'hd.daily.held.noReserve'
  if (rows.length === 0) return 'hd.daily.held.pick'
  if (new Set(rows.map((row) => row.siteId)).size > 1) return 'hd.daily.held.oneSite'
  return null
}

/** Why "Scrap…" is held for a selection (a key of warehouse-lots), or null. */
export function scrapSelectionHeld(rows: readonly Pick<HideRow, 'siteId' | 'state' | 'onHand'>[], can: Pick<DailyCan, 'scrap'>): string | null {
  if (!can.scrap) return 'hd.daily.held.noScrap'
  if (rows.length === 0) return 'hd.daily.held.pick'
  if (new Set(rows.map((row) => row.siteId)).size > 1) return 'hd.daily.held.oneSite'
  if (rows.some((row) => hideGone(row))) return 'hd.daily.held.gone'
  return null
}

/** The Scrap N hides target: each hide whole (what is left of it), its hold and its reservation said. */
export function scrapTarget(rows: readonly HideRow[], holds: HoldsBySubject, value: { amount: number; currency: string } | null): WriteOffTarget {
  return {
    kind: 'hides',
    siteId: rows[0]?.siteId ?? '',
    hides: rows.map((row) => ({
      id: row.id,
      code: row.code,
      lotId: row.lot.id,
      area: (decimalValue(row.onHand) ?? 0) > 0 ? row.onHand : row.left,
      uom: row.item.baseUom,
      hold: holdOfHide(holds, row),
      reservedFor: row.reservedFor ? demandLabel(row.reservedFor.demand) : null,
    })),
    value,
  }
}

/** The value of these hides leaving stock (cost grain): the stock rows' values of the hides, one currency, else null. */
export function hidesValue(rows: readonly { hide: { id: string } | null; value?: number | null }[], hideIds: readonly string[], currency: string | null): { amount: number; currency: string } | null {
  if (!currency) return null
  const wanted = new Set(hideIds)
  let amount = 0
  let seen = 0
  for (const row of rows) {
    if (!row.hide || !wanted.has(row.hide.id)) continue
    if (row.value === null || row.value === undefined) return null
    amount += row.value
    seen += 1
  }
  return seen === 0 ? null : { amount, currency }
}
