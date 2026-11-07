import type { FastifyInstance, FastifyRequest } from 'fastify'
import { can } from '@nexus/factory-domain/core/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import {
  ALL_WORDS,
  byNewest,
  fingerprintOf,
  GROUP_RULES,
  groupOf,
  groupsFor,
  isNew,
  KIND_RULES,
  kindOfFile,
  kindOfInvoice,
  matchesSearch,
  maySee,
  replacementsOf,
  titleOf,
  type DocumentAccess,
  type DocumentGroup,
  type LibraryChip,
  type PortalDocumentKind,
} from '@nexus/factory-domain/sales/portal-documents/library'
import { PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, PORTAL_CUSTOMER_DOCUMENTS_FINANCE, PORTAL_CUSTOMER_DOCUMENTS_VIEW } from '@nexus/factory-domain/sales/portal-documents/permissions'
import { portalReader, type PortalReader } from '../portal-orders/access'
import {
  lastVisitOf,
  openedBy,
  readAnyFile,
  readComplianceDocuments,
  readCreations,
  readGenerated,
  readInvoices,
  readIssuedDocumentsOfStyles,
  readOrders,
  readOrdersOfVersions,
  readQuotes,
  readQuoteVersions,
  readSharedFiles,
  readShipments,
  readSources,
  readStyles,
  readStylesByCode,
  type ComplianceRow,
  type GeneratedRow,
  type InvoiceRow,
  type OrderRow,
  type SharedFileRow,
} from './store'

/**
 * A customer's document library (B-W2b-178; SAL-086, SAL-092, QHS-111; design portal.customer.documents › Which documents,
 * All documents; the order record's Documents tab; Home's New documents). Read for one portal request:
 *
 *   1. the partner's own, in the party's scope: the files shared with its portal (AVAILABLE: fixed) and its issued invoices,
 *      then the shipments, orders, quotes and DDTs they are of
 *   2. the tenant's, as the person, for exactly those: what made each file (its copy's source, its first audit row, the
 *      generated document it is a version of), the declarations' styles and revisions, the person's last visit and what
 *      they opened, the invoices' office-only PDF and XML
 *   3. the rules (factory-domain sales/portal-documents/library): each file's kind and group, who may see it, its version
 *      and the one that replaced it, NEW
 *
 * A declaration whose revision the office WITHDREW leaves the library and names the newer one (`withdrawn`); a quality
 * document's copy the office replaced with a newer version is no longer shared with the party (B-W2b-123), so it is gone
 * from the partner's reads already: `withdrawnCopy` finds it again for the one document the person asks for, and names the
 * version that replaced it. Money shows only with the price grain (the contract marks it).
 */

/** The audit action of a portal preview or download (QHS-111: downloads logged); also what "opened" reads. */
export const DOWNLOAD_ACTION = 'customerDocuments.download'

export interface OrderRef {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
}

export interface ForRecord {
  readonly type: string
  readonly id: string
  readonly label: string | null
  readonly order: OrderRef | null
}

export interface FileRef {
  readonly fileId: string
  /** PDF, XML (the legal e-invoice) or FILE. */
  readonly format: 'PDF' | 'XML' | 'FILE'
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
}

export interface LibraryEntry {
  readonly id: string
  readonly kind: PortalDocumentKind
  readonly group: DocumentGroup
  readonly title: Words
  readonly for: ForRecord | null
  readonly style: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly date: Date
  readonly version: number
  readonly sha256: string
  readonly language: string | null
  readonly files: readonly FileRef[]
  readonly grossTotal: number | null
  readonly currency: string | null
  readonly expiresOn: string | null
  /** Its versions' series (null: it has none). */
  readonly series: string | null
  readonly superseded: boolean
  /** The orders it belongs to (the order's Documents tab). */
  readonly orderIds: readonly string[]
  readonly shipmentId: string | null
  /** What the conformity section needs of a declaration or leaflet. */
  readonly compliance: { readonly styleId: string; readonly revision: number; readonly certificateId: string | null } | null
  /** The source revision was withdrawn: not listed; the newer one named. */
  readonly withdrawn: { readonly replacedBy: Replacement | null } | null
  /** Filled after all entries are known. */
  replacedById: string | null
  isNew: boolean
  readonly search: readonly string[]
}

/** The document that replaced another: its id when the party sees it, else only its title and version. */
export interface Replacement {
  readonly id: string | null
  readonly title: Words
  readonly version: number
}

export interface Library {
  readonly reader: PortalReader
  readonly access: DocumentAccess
  readonly entries: readonly LibraryEntry[]
  readonly lastVisitAt: Date | null
}

/** What the person holds over the portal's company and their own party. */
export function accessOf(reader: PortalReader): DocumentAccess {
  const scope = { companyId: reader.session.company.id, partyId: reader.session.partyId }
  return {
    view: can(reader.actor, PORTAL_CUSTOMER_DOCUMENTS_VIEW, scope),
    conformity: can(reader.actor, PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, scope),
    finance: can(reader.actor, PORTAL_CUSTOMER_DOCUMENTS_FINANCE, scope),
    price: reader.seesPrices,
  }
}

const uniq = <T>(values: Iterable<T | null | undefined>): T[] => [...new Set([...values].filter((value): value is T => value !== null && value !== undefined))]
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const formatOf = (contentType: string): FileRef['format'] => (contentType === 'application/pdf' ? 'PDF' : contentType.endsWith('/xml') ? 'XML' : 'FILE')
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

/** Reads and classifies every document of the party the library knows (also the ones the person may not see). */
export async function readLibrary(app: FastifyInstance, request: FastifyRequest, now: Date): Promise<Library> {
  const reader = portalReader(app, request)
  const access = accessOf(reader)
  const companyId = reader.session.company.id

  // 1. The partner's own.
  const own = await request.withClient(async (client) => {
    const files = await readSharedFiles(client, companyId)
    const invoices = await readInvoices(client, companyId)
    const shipments = await readShipments(client, uniq(files.filter((file) => file.recordType === 'Shipment').map((file) => file.recordId)))
    const quotes = await readQuotes(client, uniq(files.filter((file) => file.recordType === 'Quote').map((file) => file.recordId)))
    const versions = await readQuoteVersions(client, quotes.map((quote) => quote.id))
    const accepted = versions.filter((version) => version.status === 'ACCEPTED').map((version) => version.id)
    const ordersOfQuotes = await readOrdersOfVersions(client, accepted)
    const orderIds = uniq([
      ...files.filter((file) => file.recordType === 'SalesOrder').map((file) => file.recordId),
      ...shipments.map((shipment) => shipment.salesOrderId),
      ...invoices.map((invoice) => invoice.salesOrderId),
    ])
    const orders = [...(await readOrders(client, orderIds)), ...ordersOfQuotes]
    return { files, invoices, shipments, quotes, versions, orders }
  })

  // 2. The tenant's, for exactly those.
  const fileIds = own.files.map((file) => file.id)
  const invoiceFileIds = uniq(own.invoices.flatMap((invoice) => [invoice.pdfFileId, invoice.xmlFileId]))
  const tenant = await reader.inTenant(async (client) => {
    const sources = await readSources(client, fileIds)
    const compliance = await readComplianceDocuments(client, uniq([...sources.values()].filter((source) => source.recordType === 'ComplianceDocument').map((source) => source.recordId)))
    const generated = await readGenerated(client, uniq([...fileIds, ...[...sources.values()].map((source) => source.id)]))
    const creations = await readCreations(client, fileIds)
    const codes = uniq([...creations.values()].map((created) => text(created.details.styleCode)))
    const byCode = await readStylesByCode(client, codes)
    const styleIds = uniq([...compliance.map((row) => row.styleId), ...byCode.map((row) => row.id), ...own.files.filter((file) => file.recordType === 'Style').map((file) => file.recordId)])
    const styles = await readStyles(client, styleIds)
    const withdrawnStyles = uniq(compliance.filter((row) => row.status === 'WITHDRAWN').map((row) => row.styleId))
    const issued = await readIssuedDocumentsOfStyles(client, withdrawnStyles)
    const invoiceFiles = invoiceFileIds.length > 0 ? await client.storedFile.findMany({ where: { id: { in: invoiceFileIds }, status: 'AVAILABLE' }, select: { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true } }) : []
    const opened = await openedBy(client, reader.session.userId, DOWNLOAD_ACTION)
    const lastVisitAt = reader.session.preview ? null : await lastVisitOf(client, reader.session.userId, reader.session)
    return { sources, compliance, generated, creations, byCode, styles, issued, invoiceFiles, opened, lastVisitAt }
  })
  // The DDTs the shipment copies are of (the partner reads its own DDTs).
  const ddtIds = uniq([...tenant.creations.values()].filter((created) => created.details.documentKind === 'DDT').map((created) => text(created.details.documentId)))
  const ddts = ddtIds.length > 0 ? await request.withClient((client) => client.ddt.findMany({ where: { id: { in: ddtIds } }, select: { id: true, number: true } })) : []

  // 3. The rules.
  const shipmentOf = new Map(own.shipments.map((row) => [row.id, row]))
  const orderOf = new Map(own.orders.map((row) => [row.id, row]))
  const quoteOf = new Map(own.quotes.map((row) => [row.id, row]))
  const complianceOf = new Map(tenant.compliance.map((row) => [row.id, row]))
  const generatedOf = new Map(tenant.generated.map((row) => [row.fileId, row]))
  const styleOf = new Map(tenant.styles.map((row) => [row.id, row]))
  const styleByCode = new Map(tenant.byCode.map((row) => [row.code, row.id]))
  const ddtNumber = new Map(ddts.map((row) => [row.id, row.number]))
  const orderRef = (id: string | null | undefined): OrderRef | null => {
    const order = id ? orderOf.get(id) : undefined
    return order ? { id: order.id, number: order.number, customerRef: order.customerRef } : null
  }
  const orderOfVersion = new Map(own.orders.filter((order) => order.quoteVersionId).map((order) => [order.quoteVersionId!, order]))

  // A file's first version is in its series once a later version names it (or once it was superseded).
  const seriesRoots = new Set(own.files.flatMap((file) => (file.seriesId ? [file.seriesId] : [])))
  const entries: LibraryEntry[] = []
  for (const file of own.files) {
    const source = tenant.sources.get(file.id) ?? null
    const compliance = source?.recordType === 'ComplianceDocument' ? (complianceOf.get(source.recordId) ?? null) : null
    const generated = (source ? generatedOf.get(source.id) : undefined) ?? generatedOf.get(file.id) ?? null
    const created = tenant.creations.get(file.id) ?? null
    const quote = file.recordType === 'Quote' ? (quoteOf.get(file.recordId) ?? null) : null
    const version = quote ? (own.versions.find((row) => row.quoteId === quote.id && row.documentSha256 === file.sha256) ?? null) : null
    const kind = kindOfFile({
      recordType: file.recordType,
      fileKind: file.kind,
      category: file.category,
      created,
      source: source ? { complianceKind: compliance?.kind ?? null, generatedKind: generatedOf.get(source.id)?.kind ?? null } : null,
      generatedKind: generatedOf.get(file.id)?.kind ?? null,
      quoteAccepted: version ? version.status === 'ACCEPTED' : null,
    })
    if (kind === null) continue
    const styleId = compliance?.styleId ?? styleByCode.get(text(created?.details.styleCode) ?? '') ?? (file.recordType === 'Style' ? file.recordId : null)
    const style = styleId ? (styleOf.get(styleId) ?? null) : null
    const forRecord = forOf(file, { shipmentOf, orderRef, quote, orderOfQuote: version ? (orderOfVersion.get(version.id) ?? null) : null, style })
    const revision = compliance?.revision ?? int(created?.details.revision)
    const inSeries = file.seriesId !== null || file.supersededAt !== null || seriesRoots.has(file.id)
    const versionNo = inSeries ? file.versionNo : (compliance?.revision ?? generated?.version ?? version?.revision ?? int(created?.details.version) ?? file.versionNo)
    const series = inSeries ? `file:${file.seriesId ?? file.id}` : version ? `quote:${version.quoteId}` : generated ? `generated:${generated.recordType}:${generated.recordId}:${generated.kind}` : null
    const reference =
      kind === 'DDT'
        ? (ddtNumber.get(text(created?.details.documentId) ?? '') ?? null)
        : kind === 'ORDER_CONFIRMATION'
          ? (forRecord?.order?.number ?? quote?.number ?? null)
          : kind === 'QUOTE'
            ? (quote?.number ?? null)
            : (compliance?.number ?? generated?.number ?? null)
    // What it is of: its number or style (and a declaration's revision); a document with neither is named by its file.
    const byFile = kind === 'OTHER' || kind === 'PROOF' || kind === 'FISCAL_DOCUMENT' || (reference === null && style === null)
    const titleParts = byFile ? [file.originalName] : [reference, style?.code, revision !== null && (kind === 'DECLARATION_OF_CONFORMITY' || kind === 'USER_INFORMATION') ? `rev ${revision}` : null]
    entries.push({
      id: file.id,
      kind,
      group: groupOf(kind),
      title: titleOf(kind, titleParts),
      for: forRecord,
      style: style ? { id: style.id, code: style.code, name: style.name } : null,
      date: file.availableAt ?? file.createdAt,
      version: versionNo,
      sha256: file.sha256,
      language: compliance?.language ?? generated?.language ?? version?.language ?? text(created?.details.language),
      files: [{ fileId: file.id, format: formatOf(file.contentType), name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes }],
      grossTotal: null,
      currency: null,
      expiresOn: day(file.expiresOn),
      series,
      superseded: file.supersededAt !== null,
      orderIds: uniq([forRecord?.order?.id]),
      shipmentId: file.recordType === 'Shipment' ? file.recordId : null,
      compliance: compliance && (kind === 'DECLARATION_OF_CONFORMITY' || kind === 'USER_INFORMATION') ? { styleId: compliance.styleId, revision: compliance.revision, certificateId: compliance.certificateId } : null,
      withdrawn: compliance?.status === 'WITHDRAWN' ? { replacedBy: null } : null,
      replacedById: null,
      isNew: false,
      search: [file.originalName, forRecord?.label, forRecord?.order?.number, forRecord?.order?.customerRef, style?.code, style?.name, reference].filter((value): value is string => typeof value === 'string'),
    })
  }

  const invoiceFileOf = new Map(tenant.invoiceFiles.map((row) => [row.id, row]))
  const invoiceOf = new Map(own.invoices.map((row) => [row.id, row]))
  for (const invoice of own.invoices) entries.push(...invoiceEntry(invoice, { invoiceFileOf, invoiceOf, orderRef }))

  // Versions: each earlier version names the current one of its series.
  const replaced = replacementsOf(entries.filter((entry) => !entry.withdrawn).map((entry) => ({ id: entry.id, series: entry.series, order: entry.version, superseded: entry.superseded })))
  for (const entry of entries) entry.replacedById = replaced.get(entry.id) ?? null
  // A withdrawn declaration names the newest issued revision of its style, kind and language (its copy when shared).
  for (const [index, entry] of entries.entries()) {
    if (!entry.withdrawn) continue
    const source = tenant.compliance.find((row) => row.id === tenant.sources.get(entry.id)?.recordId)
    entries[index] = { ...entry, withdrawn: { replacedBy: source ? newerDeclaration(source, tenant.issued, entries) : null } }
  }
  for (const entry of entries) entry.isNew = !entry.withdrawn && entry.replacedById === null && isNew({ availableAt: entry.date, lastVisitAt: tenant.lastVisitAt, opened: entry.files.some((ref) => tenant.opened.has(ref.fileId)), now })
  return { reader, access, entries, lastVisitAt: tenant.lastVisitAt }
}

/** What the document is for: its record, labelled, and the order it belongs to. */
function forOf(
  file: SharedFileRow,
  facts: {
    readonly shipmentOf: Map<string, { readonly number: string; readonly salesOrderId: string }>
    readonly orderRef: (id: string | null | undefined) => OrderRef | null
    readonly quote: { readonly id: string; readonly number: string } | null
    readonly orderOfQuote: OrderRow | null
    readonly style: { readonly code: string } | null
  },
): ForRecord {
  const base = { type: file.recordType, id: file.recordId }
  switch (file.recordType) {
    case 'Shipment': {
      const shipment = facts.shipmentOf.get(file.recordId)
      return { ...base, label: shipment?.number ?? null, order: facts.orderRef(shipment?.salesOrderId) }
    }
    case 'SalesOrder': {
      const order = facts.orderRef(file.recordId)
      return { ...base, label: order?.number ?? null, order }
    }
    case 'Quote':
      return { ...base, label: facts.quote?.number ?? null, order: facts.orderOfQuote ? { id: facts.orderOfQuote.id, number: facts.orderOfQuote.number, customerRef: facts.orderOfQuote.customerRef } : null }
    case 'Style':
      return { ...base, label: facts.style?.code ?? null, order: null }
    default:
      return { ...base, label: null, order: null }
  }
}

/** An issued invoice or credit note: one document, its PDF copy and its XML (the legal e-invoice). */
function invoiceEntry(
  invoice: InvoiceRow,
  facts: {
    readonly invoiceFileOf: Map<string, { readonly id: string; readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string }>
    readonly invoiceOf: Map<string, InvoiceRow>
    readonly orderRef: (id: string | null | undefined) => OrderRef | null
  },
): LibraryEntry[] {
  const files = [invoice.pdfFileId, invoice.xmlFileId].flatMap((id) => {
    const row = id ? facts.invoiceFileOf.get(id) : undefined
    return row ? [{ fileId: row.id, format: formatOf(row.contentType), name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: row.sha256 }] : []
  })
  // Its files are made when it is issued; until they are there it has nothing to open.
  if (files.length === 0 || !invoice.number) return []
  const kind = kindOfInvoice(invoice.docType)
  const credited = invoice.creditOfId ? facts.invoiceOf.get(invoice.creditOfId) : undefined
  const order = facts.orderRef(invoice.salesOrderId ?? credited?.salesOrderId)
  const forRecord: ForRecord = credited ? { type: 'Invoice', id: credited.id, label: credited.number, order } : order ? { type: 'SalesOrder', id: order.id, label: order.number, order } : { type: 'Invoice', id: invoice.id, label: invoice.number, order: null }
  return [
    {
      id: files[0]!.fileId,
      kind,
      group: groupOf(kind),
      title: titleOf(kind, [invoice.number]),
      for: forRecord,
      style: null,
      date: invoice.issuedAt ?? invoice.issueDate ?? new Date(0),
      version: 1,
      sha256: files[0]!.sha256,
      language: null,
      files: files.map(({ sha256: _sha256, ...ref }) => ref),
      grossTotal: invoice.grossTotal,
      currency: invoice.currency,
      expiresOn: null,
      series: null,
      superseded: false,
      orderIds: uniq([order?.id]),
      shipmentId: null,
      compliance: null,
      withdrawn: null,
      replacedById: null,
      isNew: false,
      search: [invoice.number, credited?.number, order?.number, order?.customerRef].filter((value): value is string => typeof value === 'string'),
    },
  ]
}

/** The newest issued revision of a withdrawn declaration's style, kind and language, with its copy when the party has one. */
function newerDeclaration(withdrawn: ComplianceRow, issued: readonly ComplianceRow[], entries: readonly LibraryEntry[]): Replacement | null {
  const newer = issued.filter((row) => row.styleId === withdrawn.styleId && row.kind === withdrawn.kind && row.language === withdrawn.language && row.revision > withdrawn.revision).sort((a, b) => b.revision - a.revision)[0]
  if (!newer) return null
  const kind = newer.kind as PortalDocumentKind
  const copy = entries.find((entry) => !entry.withdrawn && entry.compliance?.styleId === newer.styleId && entry.kind === kind && entry.compliance.revision === newer.revision)
  return { id: copy?.id ?? null, title: copy?.title ?? titleOf(kind, [newer.number, `rev ${newer.revision}`]), version: newer.revision }
}

// ---- views ---------------------------------------------------------------------------------------------------------

/** One document as the answers show it (money only when the role sees prices: the contract drops it otherwise). */
export function documentView(entry: LibraryEntry, entries: ReadonlyMap<string, LibraryEntry>) {
  const replacedBy = entry.replacedById ? entries.get(entry.replacedById) : undefined
  return {
    id: entry.id,
    kind: entry.kind,
    kindWords: KIND_RULES[entry.kind].words,
    group: entry.group,
    title: entry.title,
    for: entry.for ? { ...entry.for, order: entry.for.order ? { ...entry.for.order } : null } : null,
    style: entry.style ? { code: entry.style.code, name: entry.style.name } : null,
    date: toUtcIso(entry.date),
    version: entry.version,
    sha256: entry.sha256,
    fingerprint: fingerprintOf(entry.sha256),
    language: entry.language,
    current: entry.replacedById === null,
    replacedBy: replacedBy ? { id: replacedBy.id, title: replacedBy.title, version: replacedBy.version } : null,
    new: entry.isNew,
    expiresOn: entry.expiresOn,
    files: entry.files.map((ref) => ({ ...ref })),
    grossTotal: asMoney('price', entry.grossTotal),
    currency: entry.currency,
  }
}

export interface ListQuery {
  readonly group: LibraryChip
  readonly q?: string | undefined
  readonly orderId?: string | undefined
  readonly shipmentId?: string | undefined
  readonly versions: 'current' | 'all'
  readonly new: 'true' | 'false'
  readonly limit: number
  readonly offset: number
}

const LIVE = { events: ['partner_notification.created'] }

/** The entries the person may see (never a withdrawn one). */
export const visibleEntries = (library: Library): LibraryEntry[] => library.entries.filter((entry) => !entry.withdrawn && maySee(library.access, entry.group))

/** GET /portal/customer-documents: the library with its chips (the groups the person sees), newest first. */
export async function listDocuments(app: FastifyInstance, request: FastifyRequest, query: ListQuery, now: Date) {
  const library = await readLibrary(app, request, now)
  const groups = groupsFor(library.access)
  if (query.group !== 'ALL' && !groups.includes(query.group)) throw new ValidationError('That kind of documents is not part of your access.', [{ path: 'querystring/group', message: 'Not one of the groups your role sees.' }])
  const byId = new Map(library.entries.map((entry) => [entry.id, entry]))
  const searched = visibleEntries(library).filter(
    (entry) =>
      (query.versions === 'all' || entry.replacedById === null) &&
      (!query.orderId || entry.orderIds.includes(query.orderId)) &&
      (!query.shipmentId || entry.shipmentId === query.shipmentId) &&
      (query.new !== 'true' || entry.isNew) &&
      matchesSearch(query.q, [entry.title.it, entry.title.en, KIND_RULES[entry.kind].words.it, KIND_RULES[entry.kind].words.en, ...entry.search]),
  )
  const inGroup = searched.filter((entry) => query.group === 'ALL' || entry.group === query.group).sort(byNewest)
  const chips = [
    { chip: 'ALL' as const, words: ALL_WORDS, count: searched.length },
    ...groups.map((group) => ({ chip: group, words: GROUP_RULES[group].words, count: searched.filter((entry) => entry.group === group).length })),
  ]
  return {
    asOf: toUtcIso(now),
    seesPrices: library.access.price,
    group: query.group,
    chips,
    count: inGroup.length,
    newCount: visibleEntries(library).filter((entry) => entry.isNew).length,
    lastVisitAt: library.lastVisitAt ? toUtcIso(library.lastVisitAt) : null,
    items: inGroup.slice(query.offset, query.offset + query.limit).map((entry) => documentView(entry, byId)),
    live: LIVE,
  }
}

/** The entry a file of the library belongs to (a document's PDF or XML), or null. */
export const entryOfFile = (library: Library, fileId: string): LibraryEntry | null => library.entries.find((entry) => entry.files.some((ref) => ref.fileId === fileId)) ?? null

/**
 * A quality document's copy the office withdrew from the party (B-W2b-123: a newer version shared on the same shipment
 * unshares the older copy): read in the tenant's scope, only when it was a copy on one of the party's own shipments; named
 * with the version that replaced it (the party's current copy of the same document, when it has one).
 */
export async function withdrawnCopy(request: FastifyRequest, library: Library, fileId: string): Promise<{ readonly title: Words; readonly version: number; readonly replacedBy: Replacement | null } | null> {
  const row = await library.reader.inTenant((client) => readAnyFile(client, fileId))
  if (!row || row.recordType !== 'Shipment' || row.visibility.includes('PARTNER') || !row.sourceFileId) return null
  // The shipment is the party's own: the partner's scope must see it.
  const own = await request.withClient((client) => readShipments(client, [row.recordId]))
  if (own.length === 0 || own[0]!.companyId !== library.reader.session.company.id) return null
  const generated: GeneratedRow | undefined = (await library.reader.inTenant((client) => readGenerated(client, [row.sourceFileId!])))[0]
  if (!generated) return null
  const kind = kindOfFile({ recordType: 'Shipment', fileKind: 'DOCUMENT', category: null, created: null, source: { complianceKind: null, generatedKind: generated.kind }, generatedKind: null, quoteAccepted: null })
  if (kind === null || !maySee(library.access, groupOf(kind))) return null
  const series = `generated:${generated.recordType}:${generated.recordId}:${generated.kind}`
  const current = visibleEntries(library).find((entry) => entry.series === series && entry.replacedById === null && entry.version > generated.version)
  return { title: titleOf(kind, [generated.number]), version: generated.version, replacedBy: current ? { id: current.id, title: current.title, version: current.version } : null }
}

/** GET /portal/customer-documents/:fileId: one document with its other versions; a withdrawn one names the newer. */
export async function oneDocument(app: FastifyInstance, request: FastifyRequest, fileId: string, now: Date) {
  const library = await readLibrary(app, request, now)
  const byId = new Map(library.entries.map((entry) => [entry.id, entry]))
  const entry = entryOfFile(library, fileId)
  if (entry && maySee(library.access, entry.group)) {
    if (entry.withdrawn) return { document: null, withdrawn: { title: entry.title, version: entry.version, replacedBy: entry.withdrawn.replacedBy }, versions: [], live: LIVE }
    const versions = entry.series ? visibleEntries(library).filter((other) => other.series === entry.series).sort((a, b) => b.version - a.version || byNewest(a, b)) : [entry]
    return { document: documentView(entry, byId), withdrawn: null, versions: versions.map((other) => documentView(other, byId)), live: LIVE }
  }
  if (!entry) {
    const withdrawn = await withdrawnCopy(request, library, fileId)
    if (withdrawn) return { document: null, withdrawn, versions: [], live: LIVE }
  }
  throw new NotFoundError('Document not found.')
}
