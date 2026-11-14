import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { areaIn, isAreaUom, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { AREA_CLAIM_REASON } from '@nexus/factory-domain/inventory/hides/measure'
import { areaCheckWords, areaClaimNote, areaLineCheck, invoicedArea, type AreaHide, type AreaLineCheck } from '@nexus/factory-domain/payables/area-check/rules'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { CLAIM_LIMITS } from '@nexus/factory-domain/purchasing/claims/rules'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { measuresOf } from '../../inventory/hides/measures'
import { toleranceSettingIn } from '../../inventory/hides/tolerance'
import { createClaim } from '../../purchasing/claims/claims'
import { RefusedError } from '../invoices'
import { officeInvoice, type InvoiceRow, type Reader } from '../store'

/**
 * The leather area check on a supplier invoice (B-W2b-403; SCM-132; factory-domain payables/area-check): per invoice line
 * mapped to a purchase order line of leather (a material tracked by the hide, in an area unit), what is invoiced on the
 * order line against the area measured on the hides received on it, with the tolerance (the order line's agreed area
 * tolerance, else the company's leather tolerance, else 2 %). Office only.
 *
 *   GET  /payables/invoices/:invoiceId/area-check             payables.view: the leather lines, each with its hides counted,
 *                                                             the check, its words, whether a claim is in order and the
 *                                                             claims of the order already (purchasing.view)
 *   POST /payables/invoices/:invoiceId/area-check/:lineId/claim  purchasing.claims.manage over the order's site and supplier
 *                                                             (through purchasing's own claim command): a DRAFT area claim to
 *                                                             the tannery for the shortfall, kind CLAIM (nothing goes back, a
 *                                                             credit is asked), on the newest lot received on the order line,
 *                                                             with the words of the check; refused in words while the check
 *                                                             is not SHORT beyond the tolerance. A person sends it.
 */

const fixed = (value: { toFixed(places: number): string }): string => value.toFixed(4)

interface LeatherLine {
  readonly lineId: string
  readonly seq: number
  readonly description: string
  readonly quantity: string | null
  readonly uom: string | null
  readonly order: { readonly id: string; readonly number: string; readonly lineId: string; readonly lineSeq: number; readonly siteId: string; readonly uom: string }
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly baseUom: AreaUom }
  readonly hides: readonly (AreaHide & { readonly lotId: string; readonly lotCode: string })[]
  readonly lots: readonly { readonly id: string; readonly code: string; readonly receivedAt: Date | null }[]
  readonly tolerance: { readonly percent: string; readonly from: 'ORDER_LINE' | 'COMPANY' | 'TENANT' | 'DEFAULT' }
  readonly check: AreaLineCheck | null
}

/** What the supplier's OTHER live invoices bill on the order line, in the material's base area unit (credit notes take off). */
async function billedElsewhere(db: Reader, invoiceId: string, orderLineId: string, orderUom: string, baseUom: AreaUom): Promise<string> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { purchaseOrderLineId: orderLineId, invoiceId: { not: invoiceId }, invoice: { status: { not: 'VOIDED' } } }, select: { quantity: true, uom: true, invoice: { select: { kind: true } } } })
  let total = new Dec(0)
  for (const line of lines) {
    const area = invoicedArea(line.quantity?.toString() ?? null, line.uom, orderUom, baseUom)
    if (area) total = line.invoice.kind === 'CREDIT_NOTE' ? total.minus(area) : total.plus(area)
  }
  return Dec.max(0, total).toFixed(4)
}

/** The invoice's leather lines with their facts and check (lines of another kind, or mapped to no leather line, are left out). */
async function leatherLines(db: Reader, tenantId: string, invoice: InvoiceRow): Promise<LeatherLine[]> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId: invoice.id, kind: 'GOODS', purchaseOrderLineId: { not: null } }, select: { id: true, seq: true, description: true, quantity: true, uom: true, purchaseOrderLineId: true }, orderBy: { seq: 'asc' } })
  const out: LeatherLine[] = []
  for (const line of lines) {
    const orderLine = await db.purchaseOrderLine.findUnique({
      where: { id: line.purchaseOrderLineId! },
      select: { id: true, seq: true, siteId: true, uom: true, areaTolerancePct: true, purchaseOrder: { select: { id: true, number: true, companyId: true } }, item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } } },
    })
    if (!orderLine || orderLine.item.tracking !== 'HIDE' || !isAreaUom(orderLine.item.baseUom)) continue
    const baseUom = orderLine.item.baseUom
    const receiptLines = await db.goodsReceiptLine.findMany({ where: { purchaseOrderLineId: orderLine.id, receipt: { status: 'POSTED' } }, select: { id: true, receipt: { select: { postedAt: true } } } })
    const lots = receiptLines.length === 0 ? [] : await db.lot.findMany({ where: { receiptLineId: { in: receiptLines.map((row) => row.id) } }, select: { id: true, code: true, receiptLineId: true }, orderBy: { code: 'asc' } })
    const postedAt = new Map(receiptLines.map((row) => [row.id, row.receipt.postedAt]))
    const hides = lots.length === 0 ? [] : await db.hide.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: { id: true, code: true, lotId: true, area: true, areaUom: true }, orderBy: { code: 'asc' } })
    const measures = await measuresOf(db, hides.map((hide) => hide.id))
    const lotCode = new Map(lots.map((lot) => [lot.id, lot.code]))
    const areaHides = hides.flatMap((hide) => {
      if (!isAreaUom(hide.areaUom)) return []
      const latest = measures.get(hide.id)?.[0]
      const measured = latest && isAreaUom(latest.areaUom) ? fixed(areaIn(latest.measuredArea.toString(), latest.areaUom, baseUom)) : null
      return [{ hideId: hide.id, code: hide.code, lotId: hide.lotId, lotCode: lotCode.get(hide.lotId) ?? '', received: fixed(areaIn(hide.area.toString(), hide.areaUom, baseUom)), measured }]
    })
    const setting = orderLine.areaTolerancePct === null ? await toleranceSettingIn(db, tenantId, orderLine.purchaseOrder.companyId) : null
    const tolerance = orderLine.areaTolerancePct !== null ? { percent: new Dec(orderLine.areaTolerancePct.toString()).toFixed(2), from: 'ORDER_LINE' as const } : { percent: setting!.percent, from: setting!.from }
    const invoiced = invoicedArea(line.quantity?.toString() ?? null, line.uom, orderLine.uom, baseUom)
    const check = invoiced === null ? null : areaLineCheck({ invoiced, billedElsewhere: await billedElsewhere(db, invoice.id, orderLine.id, orderLine.uom, baseUom), hides: areaHides, tolerancePercent: tolerance.percent })
    out.push({
      lineId: line.id,
      seq: line.seq,
      description: line.description,
      quantity: line.quantity === null ? null : line.quantity.toFixed(4),
      uom: line.uom,
      order: { id: orderLine.purchaseOrder.id, number: orderLine.purchaseOrder.number, lineId: orderLine.id, lineSeq: orderLine.seq, siteId: orderLine.siteId, uom: orderLine.uom },
      item: { id: orderLine.item.id, code: orderLine.item.code, name: orderLine.item.name, baseUom },
      hides: areaHides,
      lots: lots.map((lot) => ({ id: lot.id, code: lot.code, receivedAt: lot.receiptLineId ? (postedAt.get(lot.receiptLineId) ?? null) : null })),
      tolerance,
      check,
    })
  }
  return out
}

const checkView = (check: AreaLineCheck | null) =>
  check
    ? {
        invoiced: fixed(check.invoiced),
        invoicedTotal: fixed(check.invoicedTotal),
        received: fixed(check.received),
        measured: fixed(check.measured),
        measuredHides: check.measuredHides,
        unmeasuredHides: check.unmeasuredHides,
        difference: fixed(check.difference),
        differencePercent: check.differencePercent,
        outcome: check.outcome,
        opensClaim: check.opensClaim,
        shortfall: fixed(check.shortfall),
      }
    : null

function claimHeld(context: OfficeContext, line: LeatherLine, partyId: string, companyId: string): string | null {
  if (!line.check) return 'The line names no area the check can read: its quantity is not in an area unit.'
  if (!line.check.opensClaim) return line.check.outcome === 'NOT_RECEIVED' ? 'No hide was received on this order line yet.' : 'The area measured is within the tolerance or above what was invoiced: there is nothing to claim.'
  if (!can(actorOf(context), PURCHASING_CLAIMS_MANAGE, { companyId, siteId: line.order.siteId, partyId })) return 'Opening a claim needs purchasing.claims.manage over the supplier at this site.'
  return null
}

/** GET /payables/invoices/:invoiceId/area-check */
export async function invoiceAreaCheck(caller: CommandCaller, invoiceId: string) {
  const { context, invoice } = await officeInvoice(caller, invoiceId)
  return caller.withClient(async (client) => {
    const lines = await leatherLines(client, context.tenantId, invoice)
    const orderIds = [...new Set(lines.map((line) => line.order.id))]
    const seesClaims = (siteId: string) => can(actorOf(context), PURCHASING_VIEW, { companyId: invoice.companyId, siteId, partyId: invoice.partyId })
    const claims = orderIds.length === 0 ? [] : await client.supplierClaim.findMany({ where: { purchaseOrderId: { in: orderIds }, partyId: invoice.partyId }, select: { id: true, number: true, status: true, purchaseOrderId: true, siteId: true, createdAt: true }, orderBy: { createdAt: 'desc' } })
    return {
      invoiceId: invoice.id,
      lines: lines.map((line) => {
        const symbol = UNITS[line.item.baseUom].symbol
        return {
          lineId: line.lineId,
          seq: line.seq,
          description: line.description,
          quantity: line.quantity,
          uom: line.uom,
          order: line.order,
          item: line.item,
          tolerancePercent: line.tolerance.percent,
          toleranceFrom: line.tolerance.from,
          lots: line.lots.map((lot) => ({ id: lot.id, code: lot.code })),
          hides: line.hides.map((hide) => ({ id: hide.hideId, code: hide.code, lotId: hide.lotId, received: hide.received.toString(), measured: hide.measured === null ? null : hide.measured.toString() })),
          check: checkView(line.check),
          words: line.check ? areaCheckWords(line.check, symbol) : { en: 'The line names no area the check can read: its quantity is not in an area unit.', it: "La riga non indica un'area leggibile: la quantità non è in un'unità di superficie." },
          claim: {
            opens: line.check?.opensClaim ?? false,
            held: claimHeld(context, line, invoice.partyId, invoice.companyId),
            existing: seesClaims(line.order.siteId) ? claims.filter((claim) => claim.purchaseOrderId === line.order.id).map((claim) => ({ id: claim.id, number: claim.number, status: claim.status })) : [],
          },
        }
      }),
    }
  })
}

/** POST /payables/invoices/:invoiceId/area-check/:lineId/claim */
export async function openAreaClaim(caller: CommandCaller, invoiceId: string, lineId: string, input: { readonly reasonCode?: string | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, invoice } = await officeInvoice(caller, invoiceId)
  const line = isUuid(lineId) ? (await caller.withClient((client) => leatherLines(client, context.tenantId, invoice))).find((row) => row.lineId === lineId) : undefined
  if (!line) throw new NotFoundError('No leather line of this invoice has that id.')
  const held = claimHeld(context, line, invoice.partyId, invoice.companyId)
  if (held && line.check?.opensClaim) throw new ForbiddenError(held)
  if (held) throw new RefusedError([{ code: 'NOTHING_TO_CLAIM', message: held }])
  const check = line.check!
  const symbol = UNITS[line.item.baseUom].symbol
  // The claim names the newest lot received on the order line (the claim's lines name a lot of its site and supplier).
  const lot = [...line.lots].sort((a, b) => (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0) || b.code.localeCompare(a.code))[0]!
  const reasonCode = input.reasonCode ?? (await caller.withClient((client) => client.reasonCode.findFirst({ where: { list: 'CLAIM', code: AREA_CLAIM_REASON, active: true }, select: { code: true } })))?.code
  if (!reasonCode) throw new RefusedError([{ code: 'REASON', message: `Choose the claim's reason: the claim list has no active ${AREA_CLAIM_REASON}.` }])
  const note = areaClaimNote({ invoiceNumber: invoice.number, lineSeq: line.seq, orderNumber: line.order.number, orderLineSeq: line.order.lineSeq }, check, symbol)
  const { claim } = await createClaim(
    caller,
    {
      kind: 'CLAIM',
      partyId: invoice.partyId,
      siteId: line.order.siteId,
      purchaseOrderId: line.order.id,
      foundAt: 'RECEIPT',
      reasonCode,
      reasonNote: (input.note?.trim() ? `${note}\n${input.note.trim()}` : note).slice(0, CLAIM_LIMITS.reasonNote),
      remedy: 'CREDIT',
      lines: [{ lotId: lot.id, quantity: check.shortfall.toFixed(4), uom: line.item.baseUom, reason: note.slice(0, CLAIM_LIMITS.reasonNote) }],
    },
    idempotencyKey,
  )
  return { claim: { id: claim.id, number: claim.number, status: claim.status }, check: checkView(check) }
}
