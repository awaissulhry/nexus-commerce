import type { FactoryClient } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../core/command'
import { customersOf, partyOfCustomers } from '../../modules/quality/wall'
import { mayOnThread, resolveRecord, wallPartyOf, type WallScope } from '../threads/records'

/**
 * B-PR-44 (the production lane's finding, in B-TH-029's area; Decision 17: "a customer limit covers customer records"): the scope
 * a file's RECORD is read in, for the office's file reads — by id, download, preview, versions, history, a record's list, a
 * copy's origin, the measurement-sheet gate (B-TH-083) and Use on (B-TH-024). Before, a record type the thread resolver did not
 * know (an order or quote LINE: a configured line's artwork) fell back to the file's company, so a person limited to customer B
 * who had the id of customer A's line artwork opened it. Now, in this order:
 *
 *   record     the thread resolver's own scope (company, site, customer; a work order's, hold's or NCR's wall party), or its
 *              PARENT's for a child record files hang on: an order line → its order, a quote line → its version's quote, a
 *              request, catalogue-order or change-request line → its request, a style's revision, colourway, picture or
 *              technical file → the style, a kit line → its subcontract order, an NCR's disposition or concession → the NCR, a
 *              return line → the return, a repair estimate → the repair order
 *   customer   a record of one work order (a bundle, a serial, an inspection, a scan, a rework order, an in-process check) names
 *              its work order's customer (quality's wall.ts); any other table that names its party (the database's own
 *              `factory_file_record_party`: partyId, a style's brand, an invoice's buyer, a certificate's holder, a lot's or a
 *              receipt's supplier, a CAPA's customer) names it — read at the file's company
 *   unknown    a type that carries a customer but this record's could not be read (gone): only a person who reaches every
 *              customer and every site opens its files (fail closed for a limited person)
 *   none       a type that names no customer (a hide, a chemical, a payroll export …): the file's company decides, as before
 *
 * A person without a customer or site limit (the default: the factory sees it all) reads what they read before.
 */

type Reader = FactoryClient | CommandTx
type Ref = { readonly type: string; readonly id: string }

export type FileRecordScope =
  | { readonly kind: 'record'; readonly recordType: string; readonly scope: WallScope }
  | { readonly kind: 'customer'; readonly partyId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }

const ref = (type: string, id: string | null | undefined): Ref | null => (id ? { type, id } : null)

/** A child record files hang on → the record whose thread resolver reads it (null: the child is gone). */
export const PARENT_RECORDS: Readonly<Record<string, (client: Reader, id: string) => Promise<Ref | null>>> = Object.freeze({
  SalesOrderLine: async (client, id) => ref('SalesOrder', (await client.salesOrderLine.findUnique({ where: { id }, select: { orderId: true } }))?.orderId),
  QuoteLine: async (client, id) => {
    const line = await client.quoteLine.findUnique({ where: { id }, select: { versionId: true } })
    return line ? ref('Quote', (await client.quoteVersion.findUnique({ where: { id: line.versionId }, select: { quoteId: true } }))?.quoteId) : null
  },
  QuoteVersion: async (client, id) => ref('Quote', (await client.quoteVersion.findUnique({ where: { id }, select: { quoteId: true } }))?.quoteId),
  InquiryLine: async (client, id) => ref('Inquiry', (await client.inquiryLine.findUnique({ where: { id }, select: { inquiryId: true } }))?.inquiryId),
  PortalOrderRequestLine: async (client, id) => ref('PortalOrderRequest', (await client.portalOrderRequestLine.findUnique({ where: { id }, select: { requestId: true } }))?.requestId),
  OrderChangeRequestLine: async (client, id) => ref('OrderChangeRequest', (await client.orderChangeRequestLine.findUnique({ where: { id }, select: { requestId: true } }))?.requestId),
  StyleRevision: async (client, id) => ref('Style', (await client.styleRevision.findUnique({ where: { id }, select: { styleId: true } }))?.styleId),
  Colourway: async (client, id) => ref('Style', (await client.colourway.findUnique({ where: { id }, select: { styleId: true } }))?.styleId),
  StyleImage: async (client, id) => ref('Style', (await client.styleImage.findUnique({ where: { id }, select: { styleId: true } }))?.styleId),
  TechnicalFile: async (client, id) => ref('Style', (await client.technicalFile.findUnique({ where: { id }, select: { styleId: true } }))?.styleId),
  SubcontractKitLine: async (client, id) => ref('SubcontractOrder', (await client.subcontractKitLine.findUnique({ where: { id }, select: { subcontractOrderId: true } }))?.subcontractOrderId),
  NcrDispositionLine: async (client, id) => ref('Nonconformance', (await client.ncrDispositionLine.findUnique({ where: { id }, select: { ncrId: true } }))?.ncrId),
  NcrConcession: async (client, id) => ref('Nonconformance', (await client.ncrConcession.findUnique({ where: { id }, select: { ncrId: true } }))?.ncrId),
  ReturnLine: async (client, id) => ref('ReturnAuthorisation', (await client.returnLine.findUnique({ where: { id }, select: { returnId: true } }))?.returnId),
  RepairEstimate: async (client, id) => ref('RepairOrder', (await client.repairEstimate.findUnique({ where: { id }, select: { repairId: true } }))?.repairId),
})

/** The records of one work order: quality's wall names their work order's customer (customersOf). */
export const WORK_ORDER_RECORDS: readonly string[] = Object.freeze(['Bundle', 'GarmentSerial', 'Inspection', 'OperationScan', 'ReworkOrder', 'InProcessCheck'])

// ── B-PR-08b (production plan §2 "files", PW-05 files) ─────────────────────────────────────────────────────────────────────
/**
 * Production records whose files hang on another production record, read through THAT record's own scope (its thread resolver:
 * a work order's wall party is its customer, a mixed one or one of none reaches only who reaches every customer; a style's is its
 * brand). Before, these fell through to the database's party mapping or to the file's company: a production hold names its work
 * order's customer only when the work order has one (a mixed one's hold names none), and a defect or a check result names none at
 * all, so a person limited to customer B opened customer A's defect photos by id and listed them.
 *
 *   WorkOrderHold           a production hold or an accepted pause → its work order
 *   InspectionDefect        a final inspection's defect (its photos) → the inspection's work order
 *   InspectionCheckResult   a plan check's result (its photos) → its final inspection's or in-process check's work order; an
 *                           incoming inspection's (a supplier's lot) or a line check's (no work order) names no customer
 *   WorkInstruction         a work instruction's media → its style (B-PR-37: walled by the style's brand); one of every style
 *                           names no customer
 *
 * `found` false: the record is gone (a customer-carrying type: only every-customer readers, fail closed); `parent` null: it names
 * no customer (the file's company decides).
 */
export const PRODUCTION_CHILD_RECORDS: Readonly<Record<string, (client: Reader, id: string) => Promise<{ readonly found: boolean; readonly parent: Ref | null }>>> = Object.freeze({
  WorkOrderHold: async (client, id) => {
    const row = await client.workOrderHold.findUnique({ where: { id }, select: { workOrderId: true } })
    return { found: row !== null, parent: ref('WorkOrder', row?.workOrderId) }
  },
  InspectionDefect: async (client, id) => {
    const row = await client.inspectionDefect.findUnique({ where: { id }, select: { workOrderId: true } })
    return { found: row !== null, parent: ref('WorkOrder', row?.workOrderId) }
  },
  InspectionCheckResult: async (client, id) => {
    const row = await client.inspectionCheckResult.findUnique({ where: { id }, select: { inspectionId: true, inProcessCheckId: true } })
    if (!row) return { found: false, parent: null }
    if (row.inspectionId) {
      const inspection = await client.inspection.findUnique({ where: { id: row.inspectionId }, select: { workOrderId: true } })
      return { found: inspection !== null, parent: ref('WorkOrder', inspection?.workOrderId) }
    }
    if (row.inProcessCheckId) {
      const check = await client.inProcessCheck.findUnique({ where: { id: row.inProcessCheckId }, select: { workOrderId: true } })
      return { found: check !== null, parent: ref('WorkOrder', check?.workOrderId) }
    }
    return { found: true, parent: null }
  },
  WorkInstruction: async (client, id) => {
    const row = await client.workInstruction.findUnique({ where: { id }, select: { styleId: true, styleRevisionId: true } })
    if (!row) return { found: false, parent: null }
    const styleId = row.styleId ?? (row.styleRevisionId ? ((await client.styleRevision.findUnique({ where: { id: row.styleRevisionId }, select: { styleId: true } }))?.styleId ?? null) : null)
    return { found: true, parent: ref('Style', styleId) }
  },
})
// ── end B-PR-08b ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The party column the database's `factory_file_record_party` reads for a record type (its CASE, word for word). */
const PARTY_COLUMN: Readonly<Record<string, string>> = Object.freeze({ Party: 'id', Style: 'brandPartyId', Invoice: 'buyerPartyId', Certificate: 'holderPartyId', Lot: 'supplierId', GoodsReceipt: 'supplierId', Capa: 'customerId' })
const partyColumnOf = (recordType: string): string => (Object.hasOwn(PARTY_COLUMN, recordType) ? PARTY_COLUMN[recordType]! : 'partyId')

export async function fileRecordScope(client: Reader, tenantId: string, record: { readonly recordType: string; readonly recordId: string }): Promise<FileRecordScope> {
  const own = await resolveRecord(client, record.recordType, record.recordId)
  if (own) return { kind: 'record', recordType: record.recordType, scope: own }
  if (!isUuid(record.recordId)) return { kind: 'none' }
  // B-PR-08b: a production record's file through the record it hangs on (a work order, a style).
  const productionParentOf = Object.hasOwn(PRODUCTION_CHILD_RECORDS, record.recordType) ? PRODUCTION_CHILD_RECORDS[record.recordType]! : null
  if (productionParentOf) {
    const child = await productionParentOf(client, record.recordId)
    if (!child.found) return { kind: 'unknown' }
    if (child.parent === null) return { kind: 'none' }
    const scope = await resolveRecord(client, child.parent.type, child.parent.id)
    return scope ? { kind: 'record', recordType: child.parent.type, scope } : { kind: 'unknown' }
  }
  const parentOf = Object.hasOwn(PARENT_RECORDS, record.recordType) ? PARENT_RECORDS[record.recordType]! : null
  if (parentOf) {
    const parent = await parentOf(client, record.recordId)
    const scope = parent ? await resolveRecord(client, parent.type, parent.id) : null
    return scope && parent ? { kind: 'record', recordType: parent.type, scope } : { kind: 'unknown' }
  }
  if (WORK_ORDER_RECORDS.includes(record.recordType)) {
    const named = (await customersOf(client, [{ type: record.recordType, id: record.recordId }])).get(`${record.recordType}:${record.recordId}`)
    if (!named) return { kind: 'unknown' }
    const partyId = partyOfCustomers(named)
    return partyId ? { kind: 'customer', partyId } : { kind: 'none' }
  }
  // Any other table that names its party: the database's own mapping (the files guards read it too). `carries`: the type's
  // table has that party column (then a record not found is a gone record of a customer-carrying type: unknown).
  const [row] = await client.$queryRaw<{ known: boolean; party: string | null; carries: boolean }[]>`
    SELECT r.known, r.party::text AS party,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass(quote_ident(${record.recordType})) AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = ${partyColumnOf(record.recordType)}) AS carries
      FROM "factory_file_record_party"(${tenantId}::uuid, ${record.recordType}, ${record.recordId}::uuid) r`
  if (row?.known) return row.party ? { kind: 'customer', partyId: row.party } : { kind: 'none' }
  return row?.carries ? { kind: 'unknown' } : { kind: 'none' }
}

/** Every grant of the permission at this company reaches every customer and every site: the production unit. */
function reachesEverything(actor: Actor, permission: Permission, companyId: string | null): boolean {
  if (actor.audience !== 'office' && actor.audience !== 'system') return false
  const grants = grantsFor(actor, permission).filter((grant) => !companyId || grant.companies === 'all' || grant.companies.includes(companyId))
  return grants.some((grant) => grant.parties === 'all' && grant.sites === 'all')
}

/**
 * May the office person hold `permission` over the file's record (`companyId`: the file's, for a record read at its company)?
 * A record: as threads read it (mayOnThread: its gate and wall party; a parent's type for a child). A customer: that customer at
 * the file's company. Unknown: every customer and site only. None: the file's company (already asked by the caller's can()).
 */
export function reachesFileRecord(actor: Actor, permission: Permission, found: FileRecordScope, companyId: string | null): boolean {
  switch (found.kind) {
    case 'record':
      return mayOnThread(actor, permission, found.recordType, found.scope)
    case 'customer':
      return can(actor, permission, { companyId, partyId: found.partyId })
    case 'unknown':
      return reachesEverything(actor, permission, companyId)
    default:
      return can(actor, permission, { companyId })
  }
}

/** The customer (or supplier) the file's record names, for Use on's brand wall (a work order's: its wall party); null: none. */
export function fileRecordParty(found: FileRecordScope): string | null {
  if (found.kind === 'record') return wallPartyOf(found.scope)
  if (found.kind === 'customer') return found.partyId
  return null
}
