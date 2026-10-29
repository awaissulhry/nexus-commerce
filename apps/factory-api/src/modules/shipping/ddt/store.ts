import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type CompanyLegal, type DocumentLanguage, type DocumentReference } from '@nexus/factory-domain/documents/model'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import { scopeKeyFor, yearOfScope } from '@nexus/factory-domain/numbering/kinds'
import type { DdtCarrier, DdtDestination, DdtFacts, DdtGoods, DdtLine, DdtPartySnapshot, IssuedDdt, PpeMarking } from '@nexus/factory-domain/shipping/ddt'
import type { CommandTx } from '../../../core/command'
import type { ShipmentHeader } from '../store'

/**
 * The DDT part's reads (every read names its columns). A reader takes the command's transaction (the issue reads its
 * facts under the shipment's lock) or a scoped client (`request.withClient`): row-level security decides what it finds.
 * Reads run one after another: one transaction client never runs two queries at once.
 */

// ---- the facts of a DDT ---------------------------------------------------------------------------------------------

const GOODS_SELECT = {
  workOrderSizeId: true,
  salesOrderLineId: true,
  size: true,
  quantity: true,
  workOrderSize: {
    select: {
      colourway: { select: { name: true } },
      workOrder: { select: { batchNumber: true, style: { select: { code: true, name: true, nameI18n: true, ppeCategory: true, ppeStandard: true, ppeClass: true } } } },
    },
  },
  serials: { select: { serial: true } },
} as const satisfies Prisma.ShipmentLineSelect

/** A name in the document's language when the record has one (nameI18n), else its own name. */
function localised(name: string, names: unknown, language: DocumentLanguage): string {
  const value = names !== null && typeof names === 'object' ? (names as Record<string, unknown>)[language] : null
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : name
}

/** The garments of the shipment, one entry per work order cell (its lines over every parcel added up). */
async function goodsOf(db: CommandTx, shipmentId: string, language: DocumentLanguage): Promise<DdtGoods[]> {
  const rows = await db.shipmentLine.findMany({ where: { shipmentId }, select: GOODS_SELECT, orderBy: { id: 'asc' } })
  const byCell = new Map<string, { goods: DdtGoods; quantity: number; serials: string[] }>()
  for (const row of rows) {
    const entry = byCell.get(row.workOrderSizeId)
    if (entry) {
      entry.quantity += row.quantity
      entry.serials.push(...row.serials.map((serial) => serial.serial))
      continue
    }
    const style = row.workOrderSize.workOrder.style
    const ppe: PpeMarking = { category: style.ppeCategory, standard: style.ppeStandard, class: style.ppeClass }
    byCell.set(row.workOrderSizeId, {
      goods: {
        workOrderSizeId: row.workOrderSizeId,
        salesOrderLineId: row.salesOrderLineId,
        styleCode: style.code,
        styleName: localised(style.name, style.nameI18n, language),
        colourway: row.workOrderSize.colourway.name,
        size: row.size,
        quantity: 0,
        batchNumber: row.workOrderSize.workOrder.batchNumber,
        serials: [],
        ppe,
      },
      quantity: row.quantity,
      serials: row.serials.map((serial) => serial.serial),
    })
  }
  return [...byCell.values()].map(({ goods, quantity, serials }) => ({ ...goods, quantity, serials }))
}

/** The language of the shipment's documents: its sales order's (it or en), else Italian. */
export async function languageOf(db: CommandTx, salesOrderId: string): Promise<DocumentLanguage> {
  const order = await db.salesOrder.findUnique({ where: { id: salesOrderId }, select: { language: true } })
  return isDocumentLanguage(order?.language) ? order.language : 'it'
}

/** The live DDT of a shipment (no cancellation names it), or null. */
export const liveDdtOf = (db: CommandTx, shipmentId: string) => db.ddt.findFirst({ where: { shipmentId, cancellations: { none: {} } }, select: { id: true, number: true } })

const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

/** Everything a DDT of the shipment says, read now (inside the issuing command: under the shipment's lock). */
export async function readDdtFacts(db: CommandTx, shipment: ShipmentHeader, company: CompanyLegal): Promise<DdtFacts> {
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, orderDate: true, customerRef: true, billTo: true, language: true } })
  const language: DocumentLanguage = isDocumentLanguage(order?.language) ? order.language : 'it'
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { defaultGoodsAppearance: true } })
  const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { seq: true, grossWeightKg: true }, orderBy: { seq: 'asc' } })
  const goods = await goodsOf(db, shipment.id, language)
  const live = await liveDdtOf(db, shipment.id)
  return {
    shipment: { status: shipment.status, transportBy: shipment.transportBy, carrierName: shipment.carrierName, shipTo: shipment.shipTo, shippedAt: shipment.shippedAt },
    liveDdtNumber: live?.number ?? null,
    company,
    billTo: order?.billTo ?? null,
    order: { number: order?.number ?? '', orderDate: order ? day(order.orderDate) : '', customerRef: order?.customerRef ?? null },
    defaultAppearance: settings?.defaultGoodsAppearance ?? null,
    parcels: parcels.map((parcel) => ({ seq: parcel.seq, grossWeightKg: parcel.grossWeightKg === null ? null : parcel.grossWeightKg.toFixed(4) })),
    goods,
    language,
  }
}

/**
 * The number the company's DDT series would give a DDT dated `date` now, for the preview and the confirm ("number
 * 145/2026 is taken"): not reserved (another DDT may take it first). Null when the company has no single active DDT
 * series (allocateNumber refuses then too).
 */
export async function expectedDdtNumber(db: CommandTx, companyId: string, date: BusinessDate): Promise<string | null> {
  const rows = await db.numberSeries.findMany({ where: { companyId, kind: 'DDT' }, select: { code: true, scopeKey: true, reset: true, pattern: true, nextValue: true, status: true }, orderBy: [{ code: 'asc' }, { scopeKey: 'desc' }] })
  const active = new Set(rows.filter((row) => row.status === 'ACTIVE').map((row) => row.code))
  if (active.size !== 1) return null
  const [code] = [...active]
  const newest = rows.find((row) => row.code === code)!
  const scopeKey = scopeKeyFor(newest.reset, date)
  const value = scopeKey === newest.scopeKey ? newest.nextValue : scopeKey > newest.scopeKey ? 1 : null
  if (value === null || (scopeKey === newest.scopeKey && newest.status !== 'ACTIVE')) return null
  return formatNumber(newest.pattern, { value, year: yearOfScope(scopeKey) })
}

// ---- an issued DDT --------------------------------------------------------------------------------------------------

export const DDT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  shipmentId: true,
  numberSeriesId: true,
  number: true,
  documentDate: true,
  reason: true,
  reasonText: true,
  transportBy: true,
  carrier: true,
  startAt: true,
  appearance: true,
  packages: true,
  grossWeightKg: true,
  netWeightKg: true,
  freight: true,
  sender: true,
  recipient: true,
  destination: true,
  lines: true,
  documentRefs: true,
  remarks: true,
  internalNote: true,
  issuedAt: true,
  createdById: true,
  shipment: { select: { number: true, status: true, salesOrderId: true } },
  cancellations: { select: { id: true, reason: true, cancelledAt: true, createdById: true }, orderBy: [{ cancelledAt: 'asc' }, { id: 'asc' }], take: 1 },
} as const satisfies Prisma.DdtSelect

export type DdtRow = Prisma.DdtGetPayload<{ select: typeof DDT_SELECT }>

/** The DDT, or null (missing, or out of the caller's scope). */
export async function readDdt(db: CommandTx, ddtId: string): Promise<DdtRow | null> {
  if (!isUuid(ddtId)) return null
  return db.ddt.findUnique({ where: { id: ddtId }, select: DDT_SELECT })
}

/** The DDT's stored PDF (its first FISCAL_ARCHIVE file), or null while it has none. */
export async function pdfFileIdOf(db: CommandTx, ddtId: string): Promise<string | null> {
  const file = await db.storedFile.findFirst({ where: { recordType: 'Ddt', recordId: ddtId, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return file?.id ?? null
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function addressOf(value: unknown) {
  if (value === null || value === undefined) return null
  const address = record(value)
  return {
    line1: text(address.line1) ?? '',
    line2: text(address.line2),
    postalCode: text(address.postalCode) ?? '',
    city: text(address.city) ?? '',
    province: text(address.province),
    country: text(address.country) ?? '',
  }
}

const partyOf = (value: unknown): DdtPartySnapshot => {
  const party = record(value)
  return { name: text(party.name) ?? '', address: addressOf(party.address), vatNumber: text(party.vatNumber), fiscalCode: text(party.fiscalCode) }
}

const carrierOf = (value: unknown): DdtCarrier | null => {
  if (value === null || value === undefined) return null
  const carrier = record(value)
  return { name: text(carrier.name) ?? '', address: addressOf(carrier.address), vatNumber: text(carrier.vatNumber) }
}

const destinationOf = (value: unknown): DdtDestination | null => {
  if (value === null || value === undefined) return null
  return { name: text(record(value).name), ...addressOf(value)! }
}

const linesOf = (value: unknown): DdtLine[] =>
  (Array.isArray(value) ? value : []).map((entry, index) => {
    const line = record(entry)
    return {
      seq: typeof line.seq === 'number' ? line.seq : index + 1,
      code: text(line.code),
      description: text(line.description) ?? '',
      quantity: text(line.quantity) ?? String(line.quantity ?? ''),
      uom: text(line.uom) ?? 'PCS',
      workOrderSizeId: text(line.workOrderSizeId) ?? '',
      salesOrderLineId: text(line.salesOrderLineId) ?? '',
      size: text(line.size) ?? '',
      batchNumber: text(line.batchNumber),
      serials: Array.isArray(line.serials) ? line.serials.filter((serial): serial is string => typeof serial === 'string') : [],
    }
  })

const referencesOf = (value: unknown): DocumentReference[] =>
  (Array.isArray(value) ? value : []).map((entry) => {
    const reference = record(entry)
    return { kind: text(reference.kind) as DocumentReference['kind'], number: text(reference.number) ?? '', date: text(reference.date) }
  })

/** The frozen DDT as the documents builder takes it. */
export function issuedOf(row: DdtRow): IssuedDdt {
  return {
    number: row.number,
    documentDate: day(row.documentDate),
    reason: row.reason,
    reasonText: row.reasonText,
    transportBy: row.transportBy,
    carrier: carrierOf(row.carrier),
    startAt: toUtcIso(row.startAt),
    appearance: row.appearance,
    packages: row.packages,
    grossWeightKg: row.grossWeightKg.toFixed(4),
    netWeightKg: row.netWeightKg === null ? null : row.netWeightKg.toFixed(4),
    freight: row.freight,
    sender: partyOf(row.sender),
    recipient: partyOf(row.recipient),
    destination: destinationOf(row.destination),
    lines: linesOf(row.lines),
    documentRefs: referencesOf(row.documentRefs),
    remarks: row.remarks,
  }
}

/** The office's view of a DDT: what it says, whether it is live, its cancellation and its PDF. */
export function ddtView(row: DdtRow, fileId: string | null) {
  const cancellation = row.cancellations[0] ?? null
  const issued = issuedOf(row)
  return {
    id: row.id,
    ...issued,
    lines: issued.lines.map((line) => ({ ...line, serials: [...line.serials] })),
    documentRefs: issued.documentRefs.map((reference) => ({ ...reference, date: reference.date ?? null })),
    status: cancellation ? ('CANCELLED' as const) : ('LIVE' as const),
    companyId: row.companyId,
    siteId: row.siteId,
    partyId: row.partyId,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment.number,
    numberSeriesId: row.numberSeriesId,
    internalNote: row.internalNote,
    issuedAt: toUtcIso(row.issuedAt),
    createdById: row.createdById,
    cancellation: cancellation ? { id: cancellation.id, reason: cancellation.reason, cancelledAt: toUtcIso(cancellation.cancelledAt), createdById: cancellation.createdById } : null,
    fileId,
  }
}

export type DdtView = ReturnType<typeof ddtView>
