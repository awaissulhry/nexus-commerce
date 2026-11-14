import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { SHOWN_INVOICE_STATUSES } from '@nexus/factory-domain/sales/portal-documents/library'
// B-W2b-401: never a self-invoice in the portal.
import { SELF_INVOICE_DOC_TYPES } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { STYLE_SELECT } from '../../product/compliance/read'

/**
 * The reads of a customer's documents in the portal (B-W2b-178). Two kinds, never mixed in one query:
 *
 *   the partner's own (the session's party scope: factory_partner_runtime, row-level security by party): the files shared
 *   with the party, its issued invoices, and the shipments, orders, quotes and quote versions the documents are of. Every
 *   select names its columns and never one the partner role cannot read (no copy's source, no creator, no internal note).
 *
 *   the tenant's (the office scope, read as the person, only for what the partner read found): what made each shared file
 *   (its source, its first audit row, the generated document it is a version of), the styles' names and PPE facts, the
 *   declarations' revisions and the certificates they cite, the frozen style revisions of the shipped work orders, the
 *   person's earlier sessions (the last visit) and their downloads (what they opened), and an invoice's office-only files.
 *
 * Every reader runs one query at a time (one connection runs one query at a time).
 */

export type Reader = FactoryClient

/** At most this many shared files and invoices of a party in one answer (a party has far fewer). */
export const FILES_MAX = 2000
export const INVOICES_MAX = 2000

// ---- the partner's reads ------------------------------------------------------------------------------------------

export const SHARED_FILE_SELECT = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  category: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  availableAt: true,
  createdAt: true,
  versionNo: true,
  seriesId: true,
  supersededAt: true,
  expiresOn: true,
} as const satisfies Prisma.StoredFileSelect
export type SharedFileRow = Prisma.StoredFileGetPayload<{ select: typeof SHARED_FILE_SELECT }>

/** The files shared with the party's portal, of the portal's company or tenant-wide (row-level security: the party's own). */
export const readSharedFiles = (db: Reader, companyId: string): Promise<SharedFileRow[]> =>
  db.storedFile.findMany({
    where: { status: 'AVAILABLE', visibility: { has: 'PARTNER' }, kind: { notIn: ['PHOTO', 'AUDIO'] }, OR: [{ companyId }, { companyId: null }] },
    select: SHARED_FILE_SELECT,
    orderBy: [{ availableAt: 'desc' }, { id: 'desc' }],
    take: FILES_MAX,
  })

export const INVOICE_SELECT = {
  id: true,
  docType: true,
  status: true,
  number: true,
  issueDate: true,
  issuedAt: true,
  currency: true,
  grossTotal: true,
  salesOrderId: true,
  creditOfId: true,
  xmlFileId: true,
  pdfFileId: true,
} as const satisfies Prisma.InvoiceSelect
export type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>

/** The party's issued invoices and credit notes of the portal's company (never a draft, never one SDI rejected). */
export const readInvoices = (db: Reader, companyId: string): Promise<InvoiceRow[]> =>
  db.invoice.findMany({
    // B-W2b-401: a self-invoice (TD16-TD19) names the supplier as its buyer but is the company's own VAT document: never shown.
    where: { companyId, status: { in: [...SHOWN_INVOICE_STATUSES] }, docType: { notIn: [...SELF_INVOICE_DOC_TYPES] } },
    select: INVOICE_SELECT,
    orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
    take: INVOICES_MAX,
  })

export const SHIPMENT_SELECT = { id: true, companyId: true, salesOrderId: true, number: true, status: true, shippedAt: true } as const satisfies Prisma.ShipmentSelect
export type ShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>
export const readShipments = (db: Reader, ids: readonly string[]): Promise<ShipmentRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.shipment.findMany({ where: { id: { in: [...ids] } }, select: SHIPMENT_SELECT })

/** The party's shipments of the portal's company that left (the goods it received). */
export const readShipmentsThatLeft = (db: Reader, companyId: string): Promise<ShipmentRow[]> =>
  db.shipment.findMany({ where: { companyId, status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { not: null } }, select: SHIPMENT_SELECT, orderBy: [{ shippedAt: 'desc' }, { number: 'desc' }], take: FILES_MAX })

export const ORDER_SELECT = { id: true, companyId: true, number: true, customerRef: true, quoteVersionId: true } as const satisfies Prisma.SalesOrderSelect
export type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_SELECT }>
export const readOrders = (db: Reader, ids: readonly string[]): Promise<OrderRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.salesOrder.findMany({ where: { id: { in: [...ids] } }, select: ORDER_SELECT })

/** The orders made from these accepted quote versions. */
export const readOrdersOfVersions = (db: Reader, versionIds: readonly string[]): Promise<OrderRow[]> =>
  versionIds.length === 0 ? Promise.resolve([]) : db.salesOrder.findMany({ where: { quoteVersionId: { in: [...versionIds] } }, select: ORDER_SELECT })

export const readQuotes = (db: Reader, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.quote.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, number: true, customerRef: true } })

export const QUOTE_VERSION_SELECT = { id: true, quoteId: true, revision: true, status: true, documentSha256: true, language: true } as const satisfies Prisma.QuoteVersionSelect
export type QuoteVersionRow = Prisma.QuoteVersionGetPayload<{ select: typeof QUOTE_VERSION_SELECT }>
export const readQuoteVersions = (db: Reader, quoteIds: readonly string[]): Promise<QuoteVersionRow[]> =>
  quoteIds.length === 0 ? Promise.resolve([]) : db.quoteVersion.findMany({ where: { quoteId: { in: [...quoteIds] }, documentSha256: { not: null } }, select: QUOTE_VERSION_SELECT })

/** What the shipments carried: per line, the work order and the order line (the style). */
export const readShipmentLines = (db: Reader, shipmentIds: readonly string[]) =>
  shipmentIds.length === 0
    ? Promise.resolve([])
    : db.shipmentLine.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: { shipmentId: true, workOrderId: true, salesOrderLineId: true, quantity: true } })

export const readOrderLines = (db: Reader, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.salesOrderLine.findMany({ where: { id: { in: [...ids] } }, select: { id: true, orderId: true, styleId: true } })

// ---- the tenant's reads (office scope, as the person, after the partner read) ---------------------------------------

/** Each shared file's source (a copy names the file it was copied from) and that source's record. */
export async function readSources(db: Reader, fileIds: readonly string[]): Promise<Map<string, { readonly id: string; readonly recordType: string; readonly recordId: string }>> {
  if (fileIds.length === 0) return new Map()
  const copies = await db.storedFile.findMany({ where: { id: { in: [...fileIds] }, sourceFileId: { not: null } }, select: { id: true, sourceFileId: true } })
  const sourceIds = [...new Set(copies.map((row) => row.sourceFileId!))]
  const sources = sourceIds.length > 0 ? await db.storedFile.findMany({ where: { id: { in: sourceIds } }, select: { id: true, recordType: true, recordId: true } }) : []
  const byId = new Map(sources.map((row) => [row.id, row]))
  return new Map(copies.flatMap((row) => (byId.has(row.sourceFileId!) ? [[row.id, byId.get(row.sourceFileId!)!] as const] : [])))
}

export const COMPLIANCE_SELECT = { id: true, kind: true, styleId: true, revision: true, language: true, number: true, status: true, certificateId: true } as const satisfies Prisma.ComplianceDocumentSelect
export type ComplianceRow = Prisma.ComplianceDocumentGetPayload<{ select: typeof COMPLIANCE_SELECT }>
export const readComplianceDocuments = (db: Reader, ids: readonly string[]): Promise<ComplianceRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.complianceDocument.findMany({ where: { id: { in: [...ids] } }, select: COMPLIANCE_SELECT })

/** The issued declarations and leaflets of these styles (to name the newer one of a withdrawn revision). */
export const readIssuedDocumentsOfStyles = (db: Reader, styleIds: readonly string[]): Promise<ComplianceRow[]> =>
  styleIds.length === 0 ? Promise.resolve([]) : db.complianceDocument.findMany({ where: { styleId: { in: [...styleIds] }, status: 'ISSUED' }, select: COMPLIANCE_SELECT, orderBy: [{ revision: 'desc' }] })

export const GENERATED_SELECT = { fileId: true, kind: true, version: true, language: true, number: true, recordType: true, recordId: true } as const satisfies Prisma.GeneratedDocumentSelect
export type GeneratedRow = Prisma.GeneratedDocumentGetPayload<{ select: typeof GENERATED_SELECT }>
/** The generated document versions whose file these are. */
export const readGenerated = (db: Reader, fileIds: readonly string[]): Promise<GeneratedRow[]> =>
  fileIds.length === 0 ? Promise.resolve([]) : db.generatedDocument.findMany({ where: { fileId: { in: [...fileIds] } }, select: GENERATED_SELECT })

/** Each file's first audit row: the command that recorded it and the details it wrote (what the document is). */
export async function readCreations(db: Reader, fileIds: readonly string[]): Promise<Map<string, { readonly action: string; readonly details: Record<string, unknown> }>> {
  if (fileIds.length === 0) return new Map()
  const rows = await db.auditLog.findMany({ where: { recordType: 'StoredFile', recordId: { in: [...fileIds] } }, select: { recordId: true, action: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const first = new Map<string, { action: string; details: Record<string, unknown> }>()
  for (const row of rows) {
    if (first.has(row.recordId)) continue
    const after = row.after && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : {}
    first.set(row.recordId, { action: row.action, details: after })
  }
  return first
}

export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>
export const readStyles = (db: Reader, ids: readonly string[]): Promise<StyleRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.style.findMany({ where: { id: { in: [...ids] } }, select: STYLE_SELECT })
export const readStylesByCode = (db: Reader, codes: readonly string[]) =>
  codes.length === 0 ? Promise.resolve([]) : db.style.findMany({ where: { code: { in: [...codes] } }, select: { id: true, code: true } })

/** The style revision each work order froze (its number). */
export async function frozenRevisions(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, number | null>> {
  if (workOrderIds.length === 0) return new Map()
  const orders = await db.workOrder.findMany({ where: { id: { in: [...workOrderIds] } }, select: { id: true, styleRevisionId: true } })
  const revisionIds = [...new Set(orders.map((row) => row.styleRevisionId).filter((value): value is string => value !== null))]
  const revisions = revisionIds.length > 0 ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } }) : []
  const numberOf = new Map(revisions.map((row) => [row.id, row.revision]))
  return new Map(orders.map((row) => [row.id, row.styleRevisionId ? (numberOf.get(row.styleRevisionId) ?? null) : null]))
}

export const CERTIFICATE_SELECT = {
  id: true,
  number: true,
  standard: true,
  ppeClass: true,
  notifiedBodyName: true,
  notifiedBodyNumber: true,
  validFrom: true,
  validTo: true,
  status: true,
  statusChangedAt: true,
} as const satisfies Prisma.CertificateSelect
export type CertificateRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>
export const readCertificates = (db: Reader, ids: readonly string[]): Promise<CertificateRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.certificate.findMany({ where: { id: { in: [...ids] } }, select: CERTIFICATE_SELECT })

/** The certificates covering each style (ACTIVE coverage rows). */
export async function coveringCertificates(db: Reader, styleIds: readonly string[]): Promise<Map<string, CertificateRow[]>> {
  if (styleIds.length === 0) return new Map()
  const coverage = await db.certificateCoverage.findMany({ where: { styleId: { in: [...styleIds] }, status: 'ACTIVE' }, select: { styleId: true, certificateId: true } })
  const certificates = await readCertificates(db, [...new Set(coverage.map((row) => row.certificateId))])
  const byId = new Map(certificates.map((row) => [row.id, row]))
  const result = new Map<string, CertificateRow[]>()
  for (const row of coverage) {
    const certificate = byId.get(row.certificateId)
    if (row.styleId && certificate) result.set(row.styleId, [...(result.get(row.styleId) ?? []), certificate])
  }
  return result
}

/** When the person's previous portal visit ended: the last activity of their earlier sessions (not a preview), or null. */
export async function lastVisitOf(db: Reader, userId: string, session: { readonly id: string; readonly createdAt: Date }): Promise<Date | null> {
  const row = await db.session.findFirst({
    where: { userId, id: { not: session.id }, audience: 'PARTNER', previewOfPartyId: null, createdAt: { lt: session.createdAt } },
    select: { lastSeenAt: true },
    orderBy: [{ lastSeenAt: 'desc' }],
  })
  return row?.lastSeenAt ?? null
}

/** The files the person opened (previewed or downloaded) through the portal. */
export async function openedBy(db: Reader, userId: string, action: string): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'StoredFile', action, actorId: userId, audience: 'PARTNER' }, select: { recordId: true }, distinct: ['recordId'] })
  return new Set(rows.map((row) => row.recordId))
}

/** A file as the store is asked for it (the download): its object, type and name. */
export const STORE_SELECT = { id: true, status: true, storeAccountId: true, storageKey: true, contentType: true, originalName: true, thumbnailKey: true, sha256: true } as const satisfies Prisma.StoredFileSelect
export type StoreRow = Prisma.StoredFileGetPayload<{ select: typeof STORE_SELECT }>
export const readForStore = (db: Reader, fileId: string): Promise<StoreRow | null> => db.storedFile.findUnique({ where: { id: fileId }, select: STORE_SELECT })

/** A file the party may once have been shown (a copy withdrawn since): read in the tenant's scope. */
export const readAnyFile = (db: Reader, fileId: string) =>
  db.storedFile.findUnique({ where: { id: fileId }, select: { id: true, recordType: true, recordId: true, visibility: true, status: true, sourceFileId: true, originalName: true, sha256: true } })
