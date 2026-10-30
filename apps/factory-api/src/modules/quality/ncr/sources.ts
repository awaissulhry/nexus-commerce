import type { Uom } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { CLASS_RANK, type DefectClass, type QualityStage } from '@nexus/factory-domain/quality/defects/rules'
import { FROM_DEFAULTS, holdDefaults, type NcrFromType, type NcrSource } from '@nexus/factory-domain/quality/ncr/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { readSiteStock } from '../../inventory/issue/store'
import { readSubjects } from '../holds/store'
import type { Reader } from './store'

/**
 * "From anywhere" (QHS-080; design ncr-new: "Prefilled from the source (what, where found, style, size, lot, serial,
 * defect, photos)"): what an NCR raised from a record takes from it. One reader per record type, in the caller's scope
 * (a record of another company or site is not found). Each answers the NCR's site and company, where it comes from and
 * was found, what it is about, how much (in the unit of what it is: pieces of garments, the material's base unit of a
 * lot or hide), the defect when the record names one, the records it links to and the holds it decides. The person may
 * change every field before the NCR is raised.
 */

export interface Prefill {
  readonly fromType: NcrFromType
  readonly fromId: string
  /** The record in words ("Inspection INS-2026-0004"). */
  readonly label: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly source: NcrSource
  readonly foundAt: QualityStage
  readonly title: string | null
  readonly description: string | null
  readonly foundOn: Date | null
  readonly foundById: string | null
  readonly foundByWorkerId: string | null
  readonly quantityAffected: string | null
  readonly uom: Uom | null
  readonly severity: DefectClass | null
  readonly defectCodeId: string | null
  readonly zone: string | null
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly size: string | null
  readonly serial: string | null
  readonly workOrderId: string | null
  readonly itemId: string | null
  readonly lotId: string | null
  readonly supplierId: string | null
  /** The records the NCR is linked to from the start (the source first). */
  readonly links: readonly { readonly recordType: string; readonly recordId: string; readonly note: string | null }[]
  /** ACTIVE holds the NCR decides from the start (raised from a hold). */
  readonly holdIds: readonly string[]
  /** Why no NCR is raised from this record (a hold decided in another NCR): null when it may be. */
  readonly problem: string | null
}

type Draft = Partial<Omit<Prefill, 'fromType' | 'fromId' | 'label'>> & { readonly label: string }

const text = (value: Decimal): string => value.toFixed(4)
const sumOf = (values: readonly Decimal[]): Decimal => values.reduce((sum, value) => sum.plus(value), ZERO)

async function cellOf(db: Reader, workOrderSizeId: string | null) {
  if (!workOrderSizeId) return null
  return db.workOrderSize.findUnique({ where: { id: workOrderSizeId }, select: { styleId: true, colourwayId: true, size: true } })
}

async function workOrderOf(db: Reader, workOrderId: string) {
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true } })
}

async function lotOf(db: Reader, lotId: string) {
  return db.lot.findUnique({ where: { id: lotId }, select: { id: true, code: true, companyId: true, siteId: true, itemId: true, supplierId: true, qualityStatus: true, item: { select: { baseUom: true } } } })
}

/** What lies in stock at the site of this lot or hide, in the item's base unit (null: nothing). */
async function onHand(db: Reader, siteId: string, itemId: string, key: { readonly lotId?: string; readonly hideId?: string }): Promise<Decimal | null> {
  const balances = await readSiteStock(db, siteId, { itemIds: [itemId], ...(key.lotId ? { lotId: key.lotId } : {}), ...(key.hideId ? { hideId: key.hideId } : {}) })
  const total = sumOf(balances.map((balance) => new Dec(balance.onHand.toString())))
  return total.gt(0) ? total : null
}

const worst = (classes: readonly DefectClass[]): DefectClass | null => (classes.length === 0 ? null : [...classes].sort((a, b) => CLASS_RANK[a] - CLASS_RANK[b])[0]!)

const READERS: Readonly<Record<NcrFromType, (db: Reader, id: string) => Promise<Draft | null>>> = Object.freeze({
  Inspection: async (db, id) => {
    const row = await db.inspection.findUnique({
      where: { id },
      select: { id: true, number: true, companyId: true, siteId: true, workOrderId: true, decidedAt: true, inspectorUserId: true, inspectorWorkerId: true, status: true, note: true, defects: { select: { defectClass: true, code: true, defectCodeId: true, zone: true, quantity: true, workOrderSizeId: true, description: true } } },
    })
    if (!row) return null
    const workOrder = await workOrderOf(db, row.workOrderId)
    const cells = [...new Set(row.defects.map((defect) => defect.workOrderSizeId).filter((cell): cell is string => cell !== null))]
    const cell = cells.length === 1 ? await cellOf(db, cells[0]!) : null
    const severity = worst(row.defects.map((defect) => defect.defectClass as DefectClass))
    const lead = row.defects.find((defect) => defect.defectClass === severity && defect.defectCodeId) ?? row.defects.find((defect) => defect.defectCodeId) ?? row.defects[0]
    const pieces = row.defects.reduce((sum, defect) => sum + defect.quantity, 0)
    const label = `Inspection ${row.number ?? row.id.slice(0, 8)}`
    return {
      label,
      companyId: row.companyId,
      siteId: row.siteId,
      title: lead ? `${lead.description?.trim() || lead.code} at ${label}` : `Failed checks at ${label}`,
      description: row.note,
      foundOn: row.decidedAt,
      foundById: row.inspectorUserId,
      foundByWorkerId: row.inspectorUserId ? null : row.inspectorWorkerId,
      quantityAffected: text(new Dec(Math.max(1, pieces))),
      uom: 'PCS',
      severity,
      defectCodeId: lead?.defectCodeId ?? null,
      zone: lead?.zone ?? null,
      styleId: cell?.styleId ?? workOrder?.styleId ?? null,
      colourwayId: cell?.colourwayId ?? null,
      size: cell?.size ?? null,
      workOrderId: row.workOrderId,
      links: [{ recordType: 'Inspection', recordId: row.id, note: null }, { recordType: 'WorkOrder', recordId: row.workOrderId, note: null }],
    }
  },
  Bundle: async (db, id) => {
    const row = await db.bundle.findUnique({ where: { id }, select: { id: true, code: true, siteId: true, workOrderId: true, workOrderSizeId: true, quantity: true } })
    if (!row) return null
    const workOrder = await workOrderOf(db, row.workOrderId)
    const cell = await cellOf(db, row.workOrderSizeId)
    return {
      label: `Bundle ${row.code}`,
      companyId: workOrder?.companyId ?? null,
      siteId: row.siteId,
      title: `Rejected bundle ${row.code}`,
      quantityAffected: text(new Dec(row.quantity)),
      uom: 'PCS',
      styleId: cell?.styleId ?? workOrder?.styleId ?? null,
      colourwayId: cell?.colourwayId ?? null,
      size: cell?.size ?? null,
      workOrderId: row.workOrderId,
      links: [{ recordType: 'Bundle', recordId: row.id, note: null }, { recordType: 'WorkOrder', recordId: row.workOrderId, note: null }],
    }
  },
  OperationScan: async (db, id) => {
    const row = await db.operationScan.findUnique({ where: { id }, select: { id: true, siteId: true, workOrderId: true, bundleId: true, scrapQuantity: true, reworkQuantity: true, scrapReason: true, reason: true, serverTime: true, workOrderOperationId: true } })
    if (!row) return null
    const workOrder = await workOrderOf(db, row.workOrderId)
    const bundle = await db.bundle.findUnique({ where: { id: row.bundleId }, select: { code: true, workOrderSizeId: true } })
    const operation = await db.workOrderOperation.findUnique({ where: { id: row.workOrderOperationId }, select: { code: true, name: true } })
    const cell = await cellOf(db, bundle?.workOrderSizeId ?? null)
    const pieces = row.scrapQuantity + row.reworkQuantity
    return {
      label: `Scan of bundle ${bundle?.code ?? ''} at ${operation?.name ?? 'an operation'}`.replace('  ', ' '),
      companyId: workOrder?.companyId ?? null,
      siteId: row.siteId,
      title: `${pieces} ${pieces === 1 ? 'garment' : 'garments'} rejected at ${operation?.name ?? 'an operation'}${row.scrapReason ? ` (${row.scrapReason})` : ''}`,
      description: row.reason,
      foundOn: row.serverTime,
      quantityAffected: pieces > 0 ? text(new Dec(pieces)) : null,
      uom: 'PCS',
      styleId: cell?.styleId ?? workOrder?.styleId ?? null,
      colourwayId: cell?.colourwayId ?? null,
      size: cell?.size ?? null,
      workOrderId: row.workOrderId,
      links: [{ recordType: 'OperationScan', recordId: row.id, note: null }, { recordType: 'Bundle', recordId: row.bundleId, note: null }, { recordType: 'WorkOrder', recordId: row.workOrderId, note: null }],
    }
  },
  WorkOrder: async (db, id) => {
    const row = await workOrderOf(db, id)
    if (!row) return null
    return { label: `Work order ${row.number}`, companyId: row.companyId, siteId: row.siteId, title: `Problem on work order ${row.number}`, uom: 'PCS', styleId: row.styleId, workOrderId: row.id, links: [{ recordType: 'WorkOrder', recordId: row.id, note: null }] }
  },
  GarmentSerial: async (db, id) => {
    const row = await db.garmentSerial.findUnique({ where: { id }, select: { id: true, serial: true, siteId: true, workOrderId: true, workOrderSizeId: true } })
    if (!row) return null
    const workOrder = await workOrderOf(db, row.workOrderId)
    const cell = await cellOf(db, row.workOrderSizeId)
    return {
      label: `Garment ${row.serial}`,
      companyId: workOrder?.companyId ?? null,
      siteId: row.siteId,
      title: `Problem on garment ${row.serial}`,
      quantityAffected: text(new Dec(1)),
      uom: 'PCS',
      styleId: cell?.styleId ?? workOrder?.styleId ?? null,
      colourwayId: cell?.colourwayId ?? null,
      size: cell?.size ?? null,
      serial: row.serial,
      workOrderId: row.workOrderId,
      links: [{ recordType: 'GarmentSerial', recordId: row.id, note: null }, { recordType: 'WorkOrder', recordId: row.workOrderId, note: null }],
    }
  },
  Lot: async (db, id) => {
    const lot = await lotOf(db, id)
    if (!lot) return null
    const held = await onHand(db, lot.siteId, lot.itemId, { lotId: lot.id })
    return {
      label: `Lot ${lot.code}`,
      companyId: lot.companyId,
      siteId: lot.siteId,
      foundAt: lot.qualityStatus === 'QUARANTINE' ? 'INCOMING' : 'STOCK',
      title: `Problem with lot ${lot.code}`,
      quantityAffected: held ? text(held) : null,
      uom: lot.item.baseUom,
      itemId: lot.itemId,
      lotId: lot.id,
      supplierId: lot.supplierId,
      links: [{ recordType: 'Lot', recordId: lot.id, note: null }],
    }
  },
  Hide: async (db, id) => {
    const hide = await db.hide.findUnique({ where: { id }, select: { id: true, code: true, siteId: true, lotId: true, itemId: true, baseArea: true, defects: true, state: true } })
    if (!hide) return null
    const lot = await lotOf(db, hide.lotId)
    const held = await onHand(db, hide.siteId, hide.itemId, { hideId: hide.id })
    return {
      label: `Hide ${hide.code}`,
      companyId: lot?.companyId ?? null,
      siteId: hide.siteId,
      foundAt: hide.state === 'PARTLY_CUT' ? 'CUTTING' : 'STOCK',
      title: `Problem with hide ${hide.code}`,
      description: hide.defects,
      quantityAffected: text(held ?? new Dec(hide.baseArea.toString())),
      uom: lot?.item.baseUom ?? null,
      itemId: hide.itemId,
      lotId: hide.lotId,
      supplierId: lot?.supplierId ?? null,
      links: [{ recordType: 'Hide', recordId: hide.id, note: null }, { recordType: 'Lot', recordId: hide.lotId, note: null }],
    }
  },
  GoodsReceipt: async (db, id) => {
    const row = await db.goodsReceipt.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, siteId: true, supplierId: true, purchaseOrderId: true, receivedAt: true } })
    if (!row) return null
    const lots = await db.lot.findMany({ where: { receiptLine: { receiptId: row.id } }, select: { id: true, itemId: true }, take: 2 })
    const lot = lots.length === 1 ? lots[0]! : null
    return {
      label: `Receipt ${row.number}`,
      companyId: row.companyId,
      siteId: row.siteId,
      title: `Problem with the delivery of receipt ${row.number}`,
      foundOn: row.receivedAt,
      itemId: lot?.itemId ?? null,
      lotId: lot?.id ?? null,
      supplierId: row.supplierId,
      links: [{ recordType: 'GoodsReceipt', recordId: row.id, note: null }, ...(row.purchaseOrderId ? [{ recordType: 'PurchaseOrder', recordId: row.purchaseOrderId, note: null }] : [])],
    }
  },
  ReceiptDiscrepancy: async (db, id) => {
    const row = await db.receiptDiscrepancy.findUnique({ where: { id }, select: { id: true, seq: true, siteId: true, receiptId: true, receiptLineId: true, supplierId: true, kind: true, quantity: true, uom: true, note: true } })
    if (!row) return null
    const receipt = await db.goodsReceipt.findUnique({ where: { id: row.receiptId }, select: { number: true, companyId: true, receivedAt: true } })
    const line = row.receiptLineId ? await db.goodsReceiptLine.findUnique({ where: { id: row.receiptLineId }, select: { itemId: true, lots: { select: { id: true }, take: 2 } } }) : null
    const lot = line && line.lots.length === 1 ? line.lots[0]! : null
    const kind = row.kind.toLowerCase().replace(/_/g, ' ')
    return {
      label: `Receipt ${receipt?.number ?? ''} discrepancy ${row.seq}`,
      companyId: receipt?.companyId ?? null,
      siteId: row.siteId,
      title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} on receipt ${receipt?.number ?? ''}`.trim(),
      description: row.note,
      foundOn: receipt?.receivedAt ?? null,
      quantityAffected: row.quantity && row.quantity.gt(0) ? text(new Dec(row.quantity.toString())) : null,
      uom: row.uom,
      itemId: line?.itemId ?? null,
      lotId: lot?.id ?? null,
      supplierId: row.supplierId,
      links: [{ recordType: 'ReceiptDiscrepancy', recordId: row.id, note: null }, { recordType: 'GoodsReceipt', recordId: row.receiptId, note: null }],
    }
  },
  SupplierClaim: async (db, id) => {
    const row = await db.supplierClaim.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true, lines: { select: { itemId: true, lotId: true, quantity: true, uom: true } } } })
    if (!row) return null
    const lots = [...new Set(row.lines.map((line) => line.lotId).filter((lot): lot is string => lot !== null))]
    const items = [...new Set(row.lines.map((line) => line.itemId))]
    const units = [...new Set(row.lines.map((line) => line.uom))]
    return {
      label: `Claim ${row.number}`,
      companyId: row.companyId,
      siteId: row.siteId,
      title: `Supplier claim ${row.number}`,
      quantityAffected: units.length === 1 && row.lines.length > 0 ? text(sumOf(row.lines.map((line) => new Dec(line.quantity.toString())))) : null,
      uom: units.length === 1 ? units[0]! : null,
      itemId: items.length === 1 ? items[0]! : null,
      lotId: lots.length === 1 && items.length === 1 ? lots[0]! : null,
      supplierId: row.partyId,
      links: [{ recordType: 'SupplierClaim', recordId: row.id, note: null }, ...lots.map((lot) => ({ recordType: 'Lot', recordId: lot, note: null }))],
    }
  },
  QualityHold: async (db, id) => {
    const hold = await db.qualityHold.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, subjectType: true, subjectIds: true, reasonCode: true, reasonNote: true, sourceType: true, sourceId: true, status: true, ncrId: true, placedAt: true, placedById: true, placedByWorkerId: true } })
    if (!hold) return null
    const decidedIn = hold.ncrId ? await db.nonconformance.findUnique({ where: { id: hold.ncrId }, select: { number: true } }) : null
    const subjects = await readSubjects(db, hold.subjectType as never, hold.subjectIds)
    const units = [...new Set(subjects.map((subject) => subject.quantity?.uom ?? ''))]
    const amount = units.length === 1 && units[0] !== '' ? sumOf(subjects.map((subject) => new Dec(subject.quantity!.amount.toString()))) : null
    const defaults = holdDefaults(hold.subjectType, hold.sourceType)
    let about: Draft | null = null
    if (hold.subjectIds.length === 1 && (hold.subjectType === 'Hide' || hold.subjectType === 'Lot' || hold.subjectType === 'Bundle' || hold.subjectType === 'WorkOrder' || hold.subjectType === 'GarmentSerial')) {
      about = await READERS[hold.subjectType as 'Hide'](db, hold.subjectIds[0]!)
    }
    return {
      ...(about ?? {}),
      label: `Hold of ${subjects.map((subject) => subject.label).filter(Boolean).join(', ') || hold.subjectType}`,
      companyId: hold.companyId,
      siteId: hold.siteId,
      source: defaults.source,
      foundAt: defaults.foundAt,
      title: about?.title ?? `Goods on hold: ${hold.reasonCode.toLowerCase().replace(/_/g, ' ')}`,
      description: hold.reasonNote ?? about?.description ?? null,
      foundOn: hold.placedAt,
      foundById: hold.placedById,
      foundByWorkerId: hold.placedById ? null : hold.placedByWorkerId,
      quantityAffected: amount && amount.gt(0) ? text(amount) : (about?.quantityAffected ?? null),
      uom: amount && amount.gt(0) ? (units[0] as Uom) : (about?.uom ?? null),
      links: [{ recordType: 'QualityHold', recordId: hold.id, note: null }, ...(about?.links ?? []), ...(hold.sourceType && hold.sourceId && hold.sourceType !== 'Nonconformance' ? [{ recordType: hold.sourceType, recordId: hold.sourceId, note: null }] : [])],
      holdIds: hold.status === 'ACTIVE' ? [hold.id] : [],
      problem: decidedIn ? `This hold is decided in ${decidedIn.number}: follow it up there.` : hold.status !== 'ACTIVE' ? `This hold is ${hold.status.toLowerCase()}: raise the NCR from the goods instead.` : null,
    }
  },
  ReturnAuthorisation: async (db, id) => {
    const rma = await db.returnAuthorisation.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, siteId: true, receivedAt: true, lines: { select: { id: true }, orderBy: { seq: 'asc' } } } })
    if (!rma) return null
    if (rma.lines.length === 1) {
      const line = await READERS.ReturnLine(db, rma.lines[0]!.id)
      if (line) return { ...line, label: `Return ${rma.number}` }
    }
    const quantity = await db.returnLine.aggregate({ where: { returnId: rma.id }, _sum: { quantity: true } })
    return {
      label: `Return ${rma.number}`,
      companyId: rma.companyId,
      siteId: rma.siteId,
      title: `Returned garments of ${rma.number}`,
      foundOn: rma.receivedAt,
      quantityAffected: (quantity._sum.quantity ?? 0) > 0 ? text(new Dec(quantity._sum.quantity ?? 0)) : null,
      uom: 'PCS',
      links: [{ recordType: 'ReturnAuthorisation', recordId: rma.id, note: null }],
    }
  },
  ReturnLine: async (db, id) => {
    const line = await db.returnLine.findUnique({ where: { id }, select: { id: true, seq: true, returnId: true, siteId: true, salesOrderLineId: true, size: true, serial: true, quantity: true, description: true, reasonCode: true, reasonNote: true, conditionNote: true, inspectedAt: true, receivedAt: true } })
    if (!line) return null
    const rma = await db.returnAuthorisation.findUnique({ where: { id: line.returnId }, select: { number: true, companyId: true } })
    const orderLine = line.salesOrderLineId ? await db.salesOrderLine.findUnique({ where: { id: line.salesOrderLineId }, select: { styleId: true, colourwayId: true } }) : null
    return {
      label: `Return ${rma?.number ?? ''} line ${line.seq}`,
      companyId: rma?.companyId ?? null,
      siteId: line.siteId,
      title: `Returned: ${line.description}`,
      description: [line.reasonNote, line.conditionNote].filter(Boolean).join(' ') || null,
      foundOn: line.inspectedAt ?? line.receivedAt,
      quantityAffected: text(new Dec(line.quantity)),
      uom: 'PCS',
      styleId: orderLine?.styleId ?? null,
      colourwayId: orderLine?.colourwayId ?? null,
      size: line.size,
      serial: line.serial,
      links: [{ recordType: 'ReturnAuthorisation', recordId: line.returnId, note: `Line ${line.seq}` }],
    }
  },
  Complaint: async (db, id) => {
    const row = await db.complaint.findUnique({ where: { id }, select: { id: true, number: true, companyId: true, receivedAt: true, description: true, styleId: true, size: true, serial: true, shipmentId: true, returnId: true } })
    if (!row) return null
    const shipment = row.shipmentId ? await db.shipment.findUnique({ where: { id: row.shipmentId }, select: { siteId: true } }) : null
    return {
      label: `Complaint ${row.number}`,
      companyId: row.companyId,
      siteId: shipment?.siteId ?? null,
      title: `Complaint ${row.number}`,
      description: row.description,
      foundOn: row.receivedAt,
      quantityAffected: text(new Dec(1)),
      uom: 'PCS',
      styleId: row.styleId,
      size: row.size,
      serial: row.serial,
      links: [
        { recordType: 'Complaint', recordId: row.id, note: null },
        ...(row.shipmentId ? [{ recordType: 'Shipment', recordId: row.shipmentId, note: null }] : []),
        ...(row.returnId ? [{ recordType: 'ReturnAuthorisation', recordId: row.returnId, note: null }] : []),
      ],
    }
  },
})

/** The prefill of an NCR raised from this record (null: no such record for this caller). */
export async function prefillFrom(db: Reader, fromType: NcrFromType, fromId: string): Promise<Prefill | null> {
  if (!isUuid(fromId)) return null
  const draft = await READERS[fromType](db, fromId)
  if (!draft) return null
  const defaults = FROM_DEFAULTS[fromType]
  const seen = new Set<string>()
  const links = (draft.links ?? []).filter((link) => {
    const key = `${link.recordType}|${link.recordId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    fromType,
    fromId,
    label: draft.label,
    companyId: draft.companyId ?? null,
    siteId: draft.siteId ?? null,
    source: draft.source ?? defaults.source,
    foundAt: draft.foundAt ?? defaults.foundAt,
    title: draft.title ?? null,
    description: draft.description ?? null,
    foundOn: draft.foundOn ?? null,
    foundById: draft.foundById ?? null,
    foundByWorkerId: draft.foundByWorkerId ?? null,
    quantityAffected: draft.quantityAffected ?? null,
    uom: draft.uom ?? null,
    severity: draft.severity ?? null,
    defectCodeId: draft.defectCodeId ?? null,
    zone: draft.zone ?? null,
    styleId: draft.styleId ?? null,
    colourwayId: draft.colourwayId ?? null,
    size: draft.size ?? null,
    serial: draft.serial ?? null,
    workOrderId: draft.workOrderId ?? null,
    itemId: draft.itemId ?? null,
    lotId: draft.lotId ?? null,
    supplierId: draft.supplierId ?? null,
    links,
    holdIds: draft.holdIds ?? [],
    problem: draft.problem ?? null,
  }
}

/** A record an NCR may be linked to, in the caller's scope: its company and site (null when tenant-wide) and its label. */
export async function linkTarget(db: Reader, recordType: string, recordId: string): Promise<{ readonly companyId: string | null; readonly siteId: string | null; readonly label: string } | null> {
  if (!isUuid(recordId)) return null
  switch (recordType) {
    case 'PpeRegisterEntry': {
      const row = await db.ppeRegisterEntry.findUnique({ where: { id: recordId }, select: { companyId: true, reference: true } })
      return row ? { companyId: row.companyId, siteId: null, label: `PPE register ${row.reference}` } : null
    }
    case 'ReworkOrder': {
      const row = await db.reworkOrder.findUnique({ where: { id: recordId }, select: { companyId: true, siteId: true, quantity: true, workOrder: { select: { number: true } } } })
      return row ? { companyId: row.companyId, siteId: row.siteId, label: `Rework of ${row.quantity} on ${row.workOrder.number}` } : null
    }
    case 'RepairOrder': {
      const row = await db.repairOrder.findUnique({ where: { id: recordId }, select: { companyId: true, siteId: true, number: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, label: `Repair ${row.number}` } : null
    }
    case 'Shipment': {
      const row = await db.shipment.findUnique({ where: { id: recordId }, select: { companyId: true, siteId: true, number: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, label: `Shipment ${row.number}` } : null
    }
    case 'SalesOrder': {
      const row = await db.salesOrder.findUnique({ where: { id: recordId }, select: { companyId: true, number: true } })
      return row ? { companyId: row.companyId, siteId: null, label: `Order ${row.number}` } : null
    }
    case 'PurchaseOrder': {
      const row = await db.purchaseOrder.findUnique({ where: { id: recordId }, select: { companyId: true, siteId: true, number: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, label: `Purchase order ${row.number}` } : null
    }
    case 'Style': {
      const row = await db.style.findUnique({ where: { id: recordId }, select: { companyId: true, code: true } })
      return row ? { companyId: row.companyId, siteId: null, label: `Style ${row.code}` } : null
    }
    default: {
      if (!Object.hasOwn(READERS, recordType)) return null
      const draft = await READERS[recordType as NcrFromType](db, recordId)
      return draft ? { companyId: draft.companyId ?? null, siteId: draft.siteId ?? null, label: draft.label } : null
    }
  }
}
