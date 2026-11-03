import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { areaIn } from '@nexus/factory-domain/inventory/hides/area'
import { AREA_CLAIM_REASON, areaCheck, claimNote, lotCheck, type MeasuredHide } from '@nexus/factory-domain/inventory/hides/measure'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf } from '../ledger/access'
import { fixed, PARTY_SELECT, partyName } from '../stock/read-kit'
import { areaUom, toleranceOfLot } from './facts'
import { declaredOf, measuresOf } from './measures'

/**
 * A lot's area against the tannery's (B-W2b-94; SCM-249 "Re-measure and area check", QHS-025 "Hide area check against the
 * tannery's claim"). Office, inventory.stock.view at the lot's company and site.
 *
 *   GET /inventory/lots/:lotId/area-check   every hide of the lot with its latest measure against the tannery's area (typed,
 *                                           else the area it was received with), all in the article's base unit; the
 *                                           measured hides together; and whether a claim to the supplier is in order (short
 *                                           beyond the tolerance), with the body of POST /purchasing/claims that claims the
 *                                           shortfall hide by hide (kind CLAIM: nothing goes back, a credit is asked; the
 *                                           claim list's SHORT_DELIVERY reason when the tenant keeps it, else null: the
 *                                           person picks one) and
 *                                           the claims that name the lot already (purchasing.view). Nothing is opened here:
 *                                           a claim is purchasing's (purchasing.claims.manage), sent by a person.
 */

/** GET /inventory/lots/:lotId/area-check. */
export async function readAreaCheck(caller: CommandCaller, lotId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const lot = isUuid(lotId)
      ? await client.lot.findUnique({
          where: { id: lotId },
          select: {
            id: true,
            code: true,
            companyId: true,
            siteId: true,
            supplierLotRef: true,
            supplier: { select: PARTY_SELECT },
            item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
            receiptLine: { select: { receipt: { select: { id: true, number: true } } } },
          },
        })
      : null
    if (!lot || lot.item.tracking !== 'HIDE' || !mayAt(context, INVENTORY_STOCK_VIEW, { companyId: lot.companyId, siteId: lot.siteId })) throw new NotFoundError('Lot not found.')
    const base = areaUom(lot.item.baseUom)
    const hides = await client.hide.findMany({ where: { lotId: lot.id }, select: { id: true, code: true, state: true, area: true, areaUom: true }, orderBy: { code: 'asc' } })
    const measures = await measuresOf(client, hides.map((hide) => hide.id))
    const tolerance = await toleranceOfLot(client, lot.id)
    const measured: MeasuredHide[] = []
    const rows = hides.map((hide) => {
      const latest = measures.get(hide.id)?.[0]
      if (!latest) return { hide: { id: hide.id, code: hide.code, state: hide.state }, measured: false, declared: null, measuredArea: null, difference: null, differencePercent: null, outcome: null, measuredAt: null }
      const unit = areaUom(latest.areaUom)
      const declared = areaIn(declaredOf(latest, hide).declared, unit, base)
      const found = areaIn(latest.measuredArea.toString(), unit, base)
      measured.push({ hideId: hide.id, code: hide.code, declared, measured: found })
      const check = areaCheck(declared, found, tolerance.percent)
      return {
        hide: { id: hide.id, code: hide.code, state: hide.state },
        measured: true,
        declared: fixed(declared),
        measuredArea: fixed(found),
        difference: fixed(check.difference),
        differencePercent: check.differencePercent,
        outcome: check.outcome,
        measuredAt: toUtcIso(latest.measuredAt),
      }
    })
    const symbol = UNITS[base].symbol
    const whole = lotCheck(measured, symbol, tolerance.percent)
    const seesClaims = can(actorOf(context), PURCHASING_VIEW, { companyId: lot.companyId, siteId: lot.siteId })
    const existing = seesClaims
      ? await client.supplierClaim.findMany({ where: { lines: { some: { lotId: lot.id } } }, select: { id: true, number: true, status: true }, orderBy: { id: 'asc' } })
      : []
    const note = whole.check ? claimNote(lot.code, whole.check, whole.hides, symbol, tolerance.percent) : null
    const reason = whole.opensClaim ? await client.reasonCode.findFirst({ where: { list: 'CLAIM', code: AREA_CLAIM_REASON, active: true }, select: { code: true } }) : null
    const check = whole.check
    return {
      lot: {
        id: lot.id,
        code: lot.code,
        companyId: lot.companyId,
        siteId: lot.siteId,
        supplier: lot.supplier ? { id: lot.supplier.id, name: partyName(lot.supplier)!.name } : null,
        supplierLotRef: lot.supplierLotRef,
        item: { id: lot.item.id, code: lot.item.code, name: lot.item.name, baseUom: lot.item.baseUom },
        receipt: lot.receiptLine?.receipt ?? null,
      },
      uom: base,
      tolerancePercent: tolerance.percent,
      toleranceFrom: tolerance.from,
      hides: rows,
      counts: { hides: hides.length, measured: measured.length, notMeasured: hides.length - measured.length },
      total: check ? { declared: fixed(check.declared), measured: fixed(check.measured), difference: fixed(check.difference), differencePercent: check.differencePercent, outcome: check.outcome } : null,
      claim: {
        opens: whole.opensClaim,
        words: claimWords(whole.opensClaim, check?.outcome ?? null, measured.length),
        prefill:
          whole.opensClaim && note
            ? { kind: 'CLAIM' as const, siteId: lot.siteId, reasonCode: reason?.code ?? null, reasonNote: note, lines: whole.claimLines.map((line) => ({ lotId: lot.id, hideId: line.hideId, quantity: line.quantity, uom: lot.item.baseUom, reason: line.reason })) }
            : null,
        existing: existing.map((row) => ({ id: row.id, number: row.number, status: row.status })),
      },
    }
  })
}

/** The claim's state in words. */
function claimWords(opens: boolean, outcome: string | null, measured: number): { it: string; en: string } {
  if (measured === 0) return { it: 'Nessuna pelle misurata: il controllo inizia con la prima misura.', en: 'No hide measured yet: the check starts with the first measure.' }
  if (opens) return { it: "Area sotto quella della conceria oltre la tolleranza: si può aprire un reclamo al fornitore.", en: "Area short of the tannery's beyond the tolerance: a claim to the supplier is in order." }
  if (outcome === 'OVER') return { it: 'Area sopra quella della conceria oltre la tolleranza: nessun reclamo.', en: "Area above the tannery's beyond the tolerance: no claim." }
  return { it: 'Area entro la tolleranza: nessun reclamo.', en: 'Area within the tolerance: no claim.' }
}
