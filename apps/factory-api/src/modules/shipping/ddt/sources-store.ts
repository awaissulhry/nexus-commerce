import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type CompanyLegal, type DocumentLanguage, type DocumentReference } from '@nexus/factory-domain/documents/model'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import type { DdtDestination, DdtPartySnapshot } from '@nexus/factory-domain/shipping/ddt'
import {
  garmentDescription,
  isDdtSourceType,
  materialDescription,
  type DdtSourceFacts,
  type DdtSourceType,
  type IssuedSourceDdt,
  type SourceDdtFacts,
  type SourceDdtLine,
  type SourceDdtOf,
  type SourceGoods,
} from '@nexus/factory-domain/shipping/ddt/sources'
import type { CommandTx } from '../../../core/command'
import { TAX_COLUMNS, taxFieldsOf } from '../../parties/store'
import { printedOf, type AnyDdtRow } from './store'

/**
 * The reads of a DDT for another reason (B-W2a-17; LOG-056): its source record (a subcontract order, a supplier claim,
 * a repair or an RMA), the source's goods in the DDT's language, its party as printed and the source's own DDTs. Every
 * read names its columns (never a cost or a price: a DDT shows none) and runs one after another on the client it is
 * given (the issuing command's transaction, under the source's row lock, or a scoped client: row-level security decides
 * what it finds).
 */

/** A source record: its type and id. */
export interface SourceRef {
  readonly type: DdtSourceType
  readonly id: string
}

/** What the access check and the lock need of a source. */
export interface SourceHeader {
  readonly type: DdtSourceType
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly number: string
  /** Its status (a repair's stage). */
  readonly state: string
  readonly version: number
}

const headerOf = (type: DdtSourceType, row: { id: string; companyId: string; siteId: string; partyId: string; number: string; version: number }, state: string): SourceHeader => ({
  type,
  id: row.id,
  companyId: row.companyId,
  siteId: row.siteId,
  partyId: row.partyId,
  number: row.number,
  state,
  version: row.version,
})

const HEADER = { id: true, companyId: true, siteId: true, partyId: true, number: true, version: true } as const

/** The source as the caller sees it (row-level security), or null. */
export async function readSource(db: CommandTx, source: SourceRef): Promise<SourceHeader | null> {
  if (!isUuid(source.id)) return null
  switch (source.type) {
    case 'SubcontractOrder': {
      const row = await db.subcontractOrder.findUnique({ where: { id: source.id }, select: { ...HEADER, status: true } })
      return row ? headerOf(source.type, row, row.status) : null
    }
    case 'SupplierClaim': {
      const row = await db.supplierClaim.findUnique({ where: { id: source.id }, select: { ...HEADER, status: true } })
      return row ? headerOf(source.type, row, row.status) : null
    }
    case 'RepairOrder': {
      const row = await db.repairOrder.findUnique({ where: { id: source.id }, select: { ...HEADER, stage: true } })
      return row ? headerOf(source.type, row, row.stage) : null
    }
    case 'ReturnAuthorisation': {
      const row = await db.returnAuthorisation.findUnique({ where: { id: source.id }, select: { ...HEADER, status: true } })
      return row ? headerOf(source.type, row, row.status) : null
    }
  }
}

/**
 * Locks the source's row (FOR UPDATE, never a write: a CLOSED RMA or a SHIPPED repair never changes, so command()'s
 * version bump cannot be the lock) and reads it under the lock, or null. Every DDT of the source is issued and cancelled
 * under this lock, so a line never travels on two live DDTs. A flow that moved the source in the same transaction
 * (B-W2a-25's kit send bumps the order's version) holds the lock already. Lock order: the source row, then the DDT
 * series row (allocateNumber), then the invoices that name a DDT (cancelling).
 */
export async function lockSource(tx: CommandTx, source: SourceRef): Promise<SourceHeader | null> {
  if (!isUuid(source.id)) return null
  const id = source.id
  // One fixed table per type: never a name from the request.
  const rows =
    source.type === 'SubcontractOrder'
      ? await tx.$queryRaw<{ id: string }[]>`SELECT s."id"::text AS "id" FROM "SubcontractOrder" s WHERE s."id" = ${id}::uuid FOR UPDATE`
      : source.type === 'SupplierClaim'
        ? await tx.$queryRaw<{ id: string }[]>`SELECT s."id"::text AS "id" FROM "SupplierClaim" s WHERE s."id" = ${id}::uuid FOR UPDATE`
        : source.type === 'RepairOrder'
          ? await tx.$queryRaw<{ id: string }[]>`SELECT s."id"::text AS "id" FROM "RepairOrder" s WHERE s."id" = ${id}::uuid FOR UPDATE`
          : await tx.$queryRaw<{ id: string }[]>`SELECT s."id"::text AS "id" FROM "ReturnAuthorisation" s WHERE s."id" = ${id}::uuid FOR UPDATE`
  return rows.length === 0 ? null : readSource(tx, source)
}

// ---- the party as printed -------------------------------------------------------------------------------------------

const ADDRESS = { kinds: true, isDefaultBillTo: true, isDefaultShipTo: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true } as const satisfies Prisma.PartyAddressSelect
type AddressRow = Prisma.PartyAddressGetPayload<{ select: typeof ADDRESS }>
const postal = (row: AddressRow) => ({ line1: row.line1, line2: row.line2, postalCode: row.postalCode, city: row.city, province: row.province, country: row.country })

/**
 * The source's party: the recipient as printed (legal name; registered, else invoice, else any address; the VAT number
 * in force today, else the fiscal code), where its goods go by default (a workshop's or supplier's pickup address, else
 * the delivery address; a customer's delivery address) and the language of its documents (it or en, else it).
 */
async function partyOf(db: CommandTx, type: DdtSourceType, partyId: string, today: BusinessDate) {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { legalName: true, language: true } })
  const addresses = await db.partyAddress.findMany({ where: { partyId, status: 'ACTIVE' }, select: ADDRESS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const identities = await db.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS })
  const identity = identityAt(identities.map(taxFieldsOf), today)
  const registered = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses.find((row) => row.isDefaultBillTo) ?? addresses[0] ?? null
  const shipTo = addresses.find((row) => row.isDefaultShipTo) ?? null
  const pickup = addresses.find((row) => row.kinds.includes('PICKUP')) ?? null
  const going = type === 'SubcontractOrder' || type === 'SupplierClaim' ? (pickup ?? shipTo) : shipTo
  const recipient: DdtPartySnapshot = {
    name: party?.legalName ?? '',
    address: registered ? postal(registered) : null,
    vatNumber: identity?.vatNumber ?? null,
    fiscalCode: identity?.vatNumber ? null : (identity?.fiscalCode ?? null),
  }
  const destination: DdtDestination | null = going ? { ...(going.name ? { name: going.name } : {}), ...postal(going) } : null
  const language: DocumentLanguage = isDocumentLanguage(party?.language) ? party.language : 'it'
  return { recipient, destination, language }
}

/** The language of a source DDT's documents: its party's (it or en, else it). No column keeps it on the DDT. */
export async function sourceLanguageOf(db: CommandTx, partyId: string): Promise<DocumentLanguage> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { language: true } })
  return isDocumentLanguage(party?.language) ? party.language : 'it'
}

// ---- the goods ------------------------------------------------------------------------------------------------------

/** A name in the document's language when the record has one (nameI18n), else its own name. */
function localised(name: string, names: unknown, language: DocumentLanguage): string {
  const value = names !== null && typeof names === 'object' ? (names as Record<string, unknown>)[language] : null
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : name
}

const dayOf = (value: Date | null | undefined): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)

const MATERIAL = {
  id: true,
  seq: true,
  quantity: true,
  uom: true,
  ddtId: true,
  item: { select: { code: true, name: true, nameI18n: true } },
  itemColour: { select: { name: true } },
  lot: { select: { code: true } },
  hide: { select: { code: true } },
} as const

type MaterialRow = { id: string; seq: number; quantity: Prisma.Decimal; uom: string; item: { code: string; name: string; nameI18n: unknown }; itemColour: { name: string } | null; lot: { code: string } | null; hide: { code: string } | null }

const materialGoods = (row: MaterialRow, language: DocumentLanguage, held: string | null): SourceGoods => ({
  sourceLineId: row.id,
  seq: row.seq,
  code: row.item.code,
  description: materialDescription({ name: localised(row.item.name, row.item.nameI18n, language), colour: row.itemColour?.name ?? null, lot: row.lot?.code ?? null, hide: row.hide?.code ?? null }, language),
  quantity: row.quantity.toString(),
  uom: row.uom,
  batchNumber: row.lot?.code ?? null,
  serials: [],
  held,
})

/** The source's own facts, its goods and the documents it refers to. */
async function sourceGoodsOf(db: CommandTx, header: SourceHeader, language: DocumentLanguage): Promise<{ source: DdtSourceFacts; goods: SourceGoods[]; references: DocumentReference[] }> {
  const base = { type: header.type, id: header.id, number: header.number, state: header.state }
  switch (header.type) {
    case 'SubcontractOrder': {
      const order = await db.subcontractOrder.findUnique({ where: { id: header.id }, select: { number: true, orderDate: true } })
      const lines = await db.subcontractKitLine.findMany({ where: { subcontractOrderId: header.id }, select: { ...MATERIAL, status: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
      const held = (status: string, seq: number): string | null =>
        status === 'SENT' ? null : status === 'PLANNED' ? `Kit line ${seq} is not sent yet: its transfer to the workshop comes first.` : `Kit line ${seq} is ${status}.`
      return {
        source: base,
        goods: lines.map((line) => materialGoods(line, language, held(line.status, line.seq))),
        // The order placed with the workshop (no reference kind of its own yet: the documents' PURCHASE_ORDER).
        references: order ? [{ kind: 'PURCHASE_ORDER', number: order.number, date: dayOf(order.orderDate) }] : [],
      }
    }
    case 'SupplierClaim': {
      const claim = await db.supplierClaim.findUnique({
        where: { id: header.id },
        select: { kind: true, purchaseOrder: { select: { number: true, orderDate: true } }, goodsReceipt: { select: { supplierDdtNumber: true, supplierDdtDate: true } } },
      })
      const lines = await db.supplierClaimLine.findMany({ where: { claimId: header.id }, select: MATERIAL, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
      const references: DocumentReference[] = [
        ...(claim?.purchaseOrder ? [{ kind: 'PURCHASE_ORDER' as const, number: claim.purchaseOrder.number, date: dayOf(claim.purchaseOrder.orderDate) }] : []),
        // The supplier's DDT the goods came with.
        ...(claim?.goodsReceipt?.supplierDdtNumber ? [{ kind: 'DDT' as const, number: claim.goodsReceipt.supplierDdtNumber, date: dayOf(claim.goodsReceipt.supplierDdtDate) }] : []),
      ]
      return { source: { ...base, claimKind: claim?.kind ?? null }, goods: lines.map((line) => materialGoods(line, language, null)), references }
    }
    case 'RepairOrder': {
      const repair = await db.repairOrder.findUnique({
        where: { id: header.id },
        select: {
          serial: true,
          size: true,
          inboundDdtNumber: true,
          inboundDdtDate: true,
          safetyCheckRequired: true,
          safetyCheckResult: true,
          safetyCheckedAt: true,
          repairedAt: true,
          shippedAt: true,
          style: { select: { code: true, name: true, nameI18n: true, ppeCategory: true, ppeStandard: true, ppeClass: true } },
          colourway: { select: { name: true } },
        },
      })
      const repairedUnchecked =
        header.state === 'REPAIRED' &&
        repair !== null &&
        repair.safetyCheckRequired &&
        (repair.safetyCheckResult !== 'PASS' || repair.safetyCheckedAt === null || repair.repairedAt === null || repair.safetyCheckedAt < repair.repairedAt)
      const style = repair?.style ?? null
      const goods: SourceGoods = {
        sourceLineId: header.id,
        seq: 10,
        code: style?.code ?? null,
        description: garmentDescription(
          {
            styleName: style ? localised(style.name, style.nameI18n, language) : null,
            colourway: repair?.colourway?.name ?? null,
            size: repair?.size ?? null,
            serial: repair?.serial ?? null,
            ppe: style ? { category: style.ppeCategory, standard: style.ppeStandard, class: style.ppeClass } : null,
          },
          language,
        ),
        quantity: '1',
        uom: 'PCS',
        batchNumber: null,
        serials: repair?.serial ? [repair.serial] : [],
        held: null,
      }
      return {
        source: { ...base, repairedUnchecked, shippedAt: repair?.shippedAt ?? null },
        goods: [goods],
        // The customer's DDT the garment came with.
        references: repair?.inboundDdtNumber ? [{ kind: 'DDT', number: repair.inboundDdtNumber, date: dayOf(repair.inboundDdtDate) }] : [],
      }
    }
    case 'ReturnAuthorisation': {
      const rma = await db.returnAuthorisation.findUnique({ where: { id: header.id }, select: { salesOrder: { select: { number: true, orderDate: true } } } })
      const lines = await db.returnLine.findMany({
        where: { returnId: header.id },
        select: { id: true, seq: true, description: true, serial: true, batchNumber: true, receivedQuantity: true, disposition: true, goodsOutcome: true },
        orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      })
      const receipts = await db.returnReceipt.findMany({ where: { returnId: header.id }, select: { customerDdtNumber: true, customerDdtDate: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
      const held = (line: (typeof lines)[number]): string | null => {
        if (line.receivedQuantity === 0) return `Line ${line.seq}: nothing of it arrived.`
        if (line.goodsOutcome === 'BACK_TO_CUSTOMER' || line.disposition === 'RETURN_UNCHANGED') return null
        if (line.disposition === null && line.goodsOutcome === null) return `Line ${line.seq} has no decision yet: decide to send it back unchanged first.`
        return `Line ${line.seq} is not sent back as it came (${line.disposition ?? line.goodsOutcome}).`
      }
      const customerDdts = new Map<string, DocumentReference>()
      for (const receipt of receipts) {
        if (receipt.customerDdtNumber && !customerDdts.has(receipt.customerDdtNumber)) customerDdts.set(receipt.customerDdtNumber, { kind: 'DDT', number: receipt.customerDdtNumber, date: dayOf(receipt.customerDdtDate) })
      }
      return {
        source: base,
        goods: lines.map((line) => ({
          sourceLineId: line.id,
          seq: line.seq,
          code: null,
          description: garmentDescription({ styleName: line.description, batchNumber: line.batchNumber, serial: line.serial }, language),
          quantity: String(line.receivedQuantity),
          uom: 'PCS',
          batchNumber: line.batchNumber,
          serials: line.serial ? [line.serial] : [],
          held: held(line),
        })),
        references: [...(rma?.salesOrder ? [{ kind: 'SALES_ORDER' as const, number: rma.salesOrder.number, date: dayOf(rma.salesOrder.orderDate) }] : []), ...customerDdts.values()],
      }
    }
  }
}

/** The source line ids a DDT's lines JSON names (typed lines name none). */
export function sourceLineIdsOf(lines: unknown): string[] {
  return (Array.isArray(lines) ? lines : []).flatMap((line) => {
    const id = line !== null && typeof line === 'object' ? (line as Record<string, unknown>).sourceLineId : null
    return typeof id === 'string' ? [id] : []
  })
}

/** The source's DDTs: live (no cancellation names them) and cancelled, with the source lines each carries. */
export async function sourceDdtsOf(db: CommandTx, source: SourceRef): Promise<{ live: SourceDdtOf[]; cancelled: SourceDdtOf[] }> {
  const rows = await db.ddt.findMany({
    where: { sourceType: source.type, sourceId: source.id },
    select: { id: true, number: true, startAt: true, lines: true, cancellations: { select: { id: true }, take: 1 } },
    orderBy: { id: 'asc' },
  })
  const of = (row: (typeof rows)[number]): SourceDdtOf => ({ id: row.id, number: row.number, startAt: row.startAt, lineIds: sourceLineIdsOf(row.lines) })
  return { live: rows.filter((row) => row.cancellations.length === 0).map(of), cancelled: rows.filter((row) => row.cancellations.length > 0).map(of) }
}

/** Everything a DDT of the source says, read now (inside the issuing command: under the source's row lock). */
export async function readSourceFacts(db: CommandTx, header: SourceHeader, company: CompanyLegal, now: Date): Promise<SourceDdtFacts> {
  const party = await partyOf(db, header.type, header.partyId, businessDate(now))
  const settings = await db.shippingSettings.findUnique({ where: { id: header.siteId }, select: { defaultGoodsAppearance: true } })
  const { source, goods, references } = await sourceGoodsOf(db, header, party.language)
  const ddts = await sourceDdtsOf(db, header)
  return {
    source,
    company,
    recipient: party.recipient,
    defaultDestination: party.destination,
    defaultAppearance: settings?.defaultGoodsAppearance ?? null,
    goods,
    liveDdts: ddts.live,
    cancelledDdts: ddts.cancelled,
    references,
    language: party.language,
  }
}

/** The numbers of source records, by `type:id` (the DDT list and record show them). */
export async function sourceNumbersOf(db: CommandTx, sources: readonly SourceRef[]): Promise<Map<string, string>> {
  const numbers = new Map<string, string>()
  const ids = (type: DdtSourceType) => [...new Set(sources.filter((source) => source.type === type).map((source) => source.id))]
  const put = (type: DdtSourceType, rows: readonly { id: string; number: string }[]) => rows.forEach((row) => numbers.set(`${type}:${row.id}`, row.number))
  const sub = ids('SubcontractOrder')
  if (sub.length > 0) put('SubcontractOrder', await db.subcontractOrder.findMany({ where: { id: { in: sub } }, select: { id: true, number: true } }))
  const claims = ids('SupplierClaim')
  if (claims.length > 0) put('SupplierClaim', await db.supplierClaim.findMany({ where: { id: { in: claims } }, select: { id: true, number: true } }))
  const repairs = ids('RepairOrder')
  if (repairs.length > 0) put('RepairOrder', await db.repairOrder.findMany({ where: { id: { in: repairs } }, select: { id: true, number: true } }))
  const returns = ids('ReturnAuthorisation')
  if (returns.length > 0) put('ReturnAuthorisation', await db.returnAuthorisation.findMany({ where: { id: { in: returns } }, select: { id: true, number: true } }))
  return numbers
}

// ---- an issued source DDT's lines -------------------------------------------------------------------------------------

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The frozen lines of a source's DDT. */
export const sourceLinesOf = (value: unknown): SourceDdtLine[] =>
  (Array.isArray(value) ? value : []).map((entry, index) => {
    const line = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    return {
      seq: typeof line.seq === 'number' ? line.seq : index + 1,
      code: text(line.code),
      description: text(line.description) ?? '',
      quantity: text(line.quantity) ?? String(line.quantity ?? ''),
      uom: text(line.uom) ?? 'PCS',
      sourceLineId: text(line.sourceLineId),
      batchNumber: text(line.batchNumber),
      serials: Array.isArray(line.serials) ? line.serials.filter((serial): serial is string => typeof serial === 'string') : [],
    }
  })

/** A DDT for another reason: no shipment, a source record. */
export type SourceDdtRow = AnyDdtRow & { readonly shipmentId: null; readonly sourceType: DdtSourceType; readonly sourceId: string }

export const isSourceDdt = (row: AnyDdtRow): row is SourceDdtRow => row.shipmentId === null && isDdtSourceType(row.sourceType) && row.sourceId !== null

/** The frozen source DDT as the documents builder takes it. */
export function sourceIssuedOf(row: SourceDdtRow): IssuedSourceDdt {
  return { ...printedOf(row), lines: sourceLinesOf(row.lines) }
}

/**
 * The office's view of a source's DDT, in the shape of a shipment's (store.ts ddtView): no shipment, its source with its
 * number, each line naming the source line it carries.
 */
export function sourceDdtView(row: SourceDdtRow, fileId: string | null, sourceNumber: string | null) {
  const cancellation = row.cancellations[0] ?? null
  const issued = sourceIssuedOf(row)
  return {
    id: row.id,
    ...issued,
    lines: issued.lines.map((line) => ({ ...line, serials: [...line.serials], workOrderSizeId: null, salesOrderLineId: null, size: null })),
    documentRefs: issued.documentRefs.map((reference) => ({ ...reference, date: reference.date ?? null })),
    status: cancellation ? ('CANCELLED' as const) : ('LIVE' as const),
    companyId: row.companyId,
    siteId: row.siteId,
    partyId: row.partyId,
    shipmentId: null,
    shipmentNumber: null,
    source: { type: row.sourceType, id: row.sourceId, number: sourceNumber ?? '' },
    numberSeriesId: row.numberSeriesId,
    internalNote: row.internalNote,
    issuedAt: toUtcIso(row.issuedAt),
    createdById: row.createdById,
    cancellation: cancellation ? { id: cancellation.id, reason: cancellation.reason, cancelledAt: toUtcIso(cancellation.cancelledAt), createdById: cancellation.createdById } : null,
    fileId,
  }
}

export type SourceDdtView = ReturnType<typeof sourceDdtView>
