import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { REQUIRED_RECORD_TYPES, requirementStates, rulesThatApply, type RequiredRecordType } from '@nexus/factory-domain/files/required/rules'
import {
  checkUploadDetails,
  daysLeftOf,
  documentStateOf,
  isSupplierDocumentCategory,
  isSupplierDocumentRecordType,
  REFUSED_SHOWN_DAYS,
  requestReasonWords,
  ruleReasonWords,
  SUPPLIER_DOCUMENT_CATEGORIES,
  type SupplierDocumentRecordType,
  type SupplierDocumentState,
  type UploadDetailsInput,
} from '@nexus/factory-domain/purchasing/portal-profile/documents'
import type { CommandTools } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import { activeRulesOf, documentsOf } from '../../../platform/files/required/check'
import { expiryKeyParts } from '../../../platform/files/expiry/source'
import { completeUpload, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { processFiles } from '../../../platform/files/service'
import { closeOne, TASK_COLUMNS, type TaskRow } from '../../../platform/portal/tasks/store'
import { ACTIONS, iso, keyFor, lockSupplier, partyUploads, supplierUploader, type UploadRecord } from './store'
import { refusedFileOf } from './task-source'

/**
 * A supplier's documents in the portal (B-W2b-189; SCM-096 "Document upload"; design portal.supplier.documents; QHS-112,
 * PRD-305 point here):
 *
 *   GET  /portal/supplier-documents                     "We ask for" — what the company's required-document rules need from
 *                                                       the supplier (its own record, its open purchase orders, ship notices
 *                                                       and jobs: MISSING or EXPIRED, with why and by when) and the open
 *                                                       UPLOAD_DOCUMENT requests (by hand, by expiry, after a refusal) — and
 *                                                       "Your documents" (accepted, expiring, expired, waiting for our check,
 *                                                       refused with the reason)
 *   POST /portal/supplier-documents                     announce one (kind, issuer, number, dates, articles and lots it covers,
 *                                                       the request it answers or the document it replaces): a file of the
 *                                                       supplier's record (or of the record asked about), OFFICE only, then
 *                                                       the presigned PUT
 *   POST /portal/supplier-documents/:fileId/complete    the file arrived: scanned (when a scanner runs), then WAITING for our
 *                                                       check; the request it answered closes (DONE by the person)
 *
 * Reading needs portal.supplierDocuments.view (the route's); sending also the person's capability portal.upload (403 in
 * words), never an office preview. Uploads from outside wait for the virus scanner in a live environment (GATE-SPEND,
 * B-W2b-160 assertOutsideUploadsOpen). The file stays unshared — the supplier sees its upload only as "waiting" — until a
 * buyer or quality person accepts it (./review.ts). Never a price: nothing here has one. Each upload is a
 * SupplierDocumentUpload row (./store.ts; W2b schema wave 23): announced WAITING, `receivedAt` when the file arrived.
 */

const RECORDS_MAX = 50
const PARTY_LEVEL = new Set(['SUPPLIER_CERTIFICATE', 'DECLARATION'])
export const DOCUMENT_LIVE_EVENTS = ['supplier_document.uploaded', 'supplier_document.accepted', 'supplier_document.refused', 'partner_task.opened', 'partner_task.closed'] as const

const system = (request: FastifyRequest, session: PortalSession) => systemCallerOf(request)(session.tenantId)

/** The person may send documents (the capability, never an office preview). */
export function mayUpload(request: FastifyRequest, session: PortalSession): boolean {
  if (session.preview) return false
  return can(actorOf(requireContext(request)), PORTAL_UPLOAD, { companyId: session.company.id, partyId: session.partyId })
}

function assertMayUpload(request: FastifyRequest, session: PortalSession): void {
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never sends documents for the supplier.')
  if (!mayUpload(request, session)) throw new ForbiddenError('Your access lets you read our requests, not send documents: ask your admin for the right to upload.')
}

// ---- the supplier's records -------------------------------------------------------------------------------------------------

interface SupplierRecord {
  readonly type: RequiredRecordType & SupplierDocumentRecordType
  readonly id: string
  readonly label: string
  readonly status: string
  readonly dueOn: BusinessDate | null
}

const RANKS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  PurchaseOrder: { DRAFT: 0, SENT: 1, CHANGES_PROPOSED: 1, CONFIRMED: 2, PARTLY_RECEIVED: 3, RECEIVED: 4, CLOSED: 5 },
  ShipNotice: { DRAFT: 0, SENT: 1, RECEIVED: 2 },
  SubcontractOrder: { DRAFT: 0, ISSUED: 1, AT_WORKSHOP: 2, PARTLY_RECEIVED: 3, RECEIVED: 4, CLOSED: 5 },
})

/** The status moves still ahead of a record (a party: becoming and staying active). */
function movesAhead(record: SupplierRecord): string[] {
  const statuses = REQUIRED_RECORD_TYPES[record.type].statuses as readonly string[]
  if (record.type === 'Party') return [...statuses]
  const ranks = RANKS[record.type]!
  const now = ranks[record.status] ?? 0
  return statuses.filter((status) => (ranks[status] ?? 0) > now)
}

const dayOrNull = (value: Date | null): BusinessDate | null => (value === null ? null : dayOf(value))
/** A calendar day as a DATE column's value. */
const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The supplier's own record and its open records of the portal's company (system scope, filtered to the party). */
async function supplierRecords(client: FactoryClient, session: PortalSession): Promise<SupplierRecord[]> {
  const party = await client.party.findUnique({ where: { id: session.partyId }, select: { id: true, code: true, status: true } })
  if (!party) return []
  const companyId = session.company.id
  const [orders, notices, jobs] = [
    await client.purchaseOrder.findMany({
      where: { partyId: party.id, companyId, status: { in: ['SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'] } },
      orderBy: [{ requestedDate: 'asc' }, { id: 'asc' }],
      take: RECORDS_MAX,
      select: { id: true, number: true, status: true, requestedDate: true },
    }),
    await client.shipNotice.findMany({
      where: { partyId: party.id, companyId, status: { in: ['DRAFT', 'SENT'] } },
      orderBy: [{ expectedDate: 'asc' }, { id: 'asc' }],
      take: RECORDS_MAX,
      select: { id: true, number: true, status: true, expectedDate: true },
    }),
    await client.subcontractOrder.findMany({
      where: { partyId: party.id, companyId, status: { in: ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] } },
      orderBy: [{ expectedBackDate: 'asc' }, { id: 'asc' }],
      take: RECORDS_MAX,
      select: { id: true, number: true, status: true, expectedBackDate: true },
    }),
  ]
  return [
    { type: 'Party', id: party.id, label: party.code, status: party.status, dueOn: null },
    ...orders.map((row) => ({ type: 'PurchaseOrder' as const, id: row.id, label: row.number, status: row.status, dueOn: dayOrNull(row.requestedDate) })),
    ...notices.map((row) => ({ type: 'ShipNotice' as const, id: row.id, label: row.number ?? 'Ship notice', status: row.status, dueOn: dayOrNull(row.expectedDate) })),
    ...jobs.map((row) => ({ type: 'SubcontractOrder' as const, id: row.id, label: row.number, status: row.status, dueOn: dayOrNull(row.expectedBackDate) })),
  ]
}

/** One record of the supplier's, by type and id (the target of an upload), or null. */
async function supplierRecord(client: FactoryClient, session: PortalSession, type: SupplierDocumentRecordType, id: string): Promise<{ readonly type: SupplierDocumentRecordType; readonly id: string; readonly label: string } | null> {
  if (!isUuid(id)) return null
  const companyId = session.company.id
  if (type === 'Party') {
    if (id !== session.partyId) return null
    const party = await client.party.findUnique({ where: { id }, select: { code: true } })
    return party && { type, id, label: party.code }
  }
  if (type === 'PurchaseOrder') {
    const row = await client.purchaseOrder.findFirst({ where: { id, partyId: session.partyId, companyId, status: { notIn: ['DRAFT'] } }, select: { number: true } })
    return row && { type, id, label: row.number }
  }
  if (type === 'ShipNotice') {
    const row = await client.shipNotice.findFirst({ where: { id, partyId: session.partyId, companyId }, select: { number: true } })
    return row && { type, id, label: row.number ?? 'Ship notice' }
  }
  const row = await client.subcontractOrder.findFirst({ where: { id, partyId: session.partyId, companyId, status: { notIn: ['DRAFT'] } }, select: { number: true } })
  return row && { type, id, label: row.number }
}

// ---- "We ask for" --------------------------------------------------------------------------------------------------------------

export interface AskedRow {
  readonly key: string
  readonly source: 'RULE' | 'EXPIRY' | 'ASKED' | 'REFUSED'
  readonly category: string | null
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly forRecords: { readonly type: string; readonly id: string; readonly label: string }[]
  readonly dueOn: BusinessDate | null
  readonly level: 'BLOCK' | 'WARN' | null
  readonly state: 'MISSING' | 'EXPIRED' | null
  readonly reason: string
  readonly taskId: string | null
  readonly askedBy: string | null
  readonly waiting: boolean
}

const earlier = (a: BusinessDate | null, b: BusinessDate | null): BusinessDate | null => (a === null ? b : b === null ? a : a < b ? a : b)
const isWaiting = (state: SupplierDocumentState): boolean => state === 'WAITING' || state === 'CHECKING'

/** What the rules need from the supplier now: MISSING or EXPIRED, one row per document and record (a company-wide one once). */
async function ruleRows(client: FactoryClient, session: PortalSession, today: BusinessDate, waitingFor: (category: string, record: { type: string; id: string }) => boolean): Promise<AskedRow[]> {
  const records = await supplierRecords(client, session)
  const party = records.find((record) => record.type === 'Party')
  if (!party) return []
  const roles = (await client.party.findUnique({ where: { id: session.partyId }, select: { roles: true } }))?.roles ?? []
  const rulesByType = new Map<string, Awaited<ReturnType<typeof activeRulesOf>>>()
  const rows = new Map<string, AskedRow>()
  for (const record of records) {
    const moves = movesAhead(record)
    if (moves.length === 0) continue
    if (!rulesByType.has(record.type)) rulesByType.set(record.type, await activeRulesOf(client, record.type, session.company.id))
    const rules = rulesByType.get(record.type)!.filter((rule) => isSupplierDocumentCategory(rule.category))
    const applying = moves.flatMap((status) => rulesThatApply(rules, record.type, status, roles))
    if (applying.length === 0) continue
    const files = (await documentsOf(client, record.type, record.id, session.partyId)).map((row) => ({ ...row, expiresOn: row.expiresOn === null ? null : dayOf(row.expiresOn) }))
    for (const state of requirementStates(applying, files, today)) {
      if (state.reason === 'MET') continue
      const companyWide = PARTY_LEVEL.has(state.category)
      const target = companyWide ? party : record
      const key = `rule:${state.category}:${target.type}:${target.id}`
      const reason = ruleReasonWords(record.type, state.beforeStatus, record.label)
      const known = rows.get(key)
      const recordRef = { type: record.type, id: record.id, label: record.label }
      if (known) {
        rows.set(key, {
          ...known,
          forRecords: known.forRecords.some((entry) => entry.id === record.id) ? known.forRecords : [...known.forRecords, recordRef],
          dueOn: earlier(known.dueOn, record.dueOn),
          level: known.level === 'BLOCK' || state.level === 'BLOCK' ? 'BLOCK' : 'WARN',
          state: known.state === 'MISSING' || state.reason === 'MISSING' ? 'MISSING' : 'EXPIRED',
        })
        continue
      }
      rows.set(key, {
        key,
        source: 'RULE',
        category: state.category,
        record: { type: target.type, id: target.id, label: target.label },
        forRecords: [recordRef],
        dueOn: record.dueOn,
        level: state.level,
        state: state.reason === 'EXPIRED' ? 'EXPIRED' : 'MISSING',
        reason,
        taskId: null,
        askedBy: null,
        waiting: waitingFor(state.category, target),
      })
    }
  }
  return [...rows.values()]
}

/** The open UPLOAD_DOCUMENT requests of the party in the portal's company, with why. */
async function requestRows(request: FastifyRequest, session: PortalSession, uploads: readonly UploadRecord[]): Promise<AskedRow[]> {
  const tasks = await request.withClient((client) =>
    client.partnerTask.findMany({ where: { companyId: session.company.id, kind: 'UPLOAD_DOCUMENT', status: 'OPEN' }, orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }], take: 200, select: TASK_COLUMNS }),
  )
  const roots = tasks.map((task) => expiryKeyParts(task.sourceKey)?.root).filter((root): root is string => root !== undefined)
  const categories = new Map(
    roots.length === 0 ? [] : (await system(request, session).withClient((client) => client.storedFile.findMany({ where: { id: { in: roots } }, select: { id: true, category: true } }))).map((row) => [row.id, row.category] as const),
  )
  return tasks.map((task) => {
    const record = { type: task.recordType, id: task.recordId, label: task.recordLabel }
    const base = { key: `task:${task.id}`, record, forRecords: [record], dueOn: task.dueAt === null ? null : businessDate(task.dueAt), level: null, state: null, taskId: task.id, askedBy: task.askedByName, waiting: false }
    const expiry = expiryKeyParts(task.sourceKey)
    if (expiry) {
      const category = categories.get(expiry.root) ?? null
      return { ...base, source: 'EXPIRY' as const, category, reason: requestReasonWords('EXPIRY', { label: task.recordLabel, category, expiresOn: expiry.expiresOn }) }
    }
    const refused = refusedFileOf(task.sourceKey)
    if (refused) {
      const upload = uploads.find((entry) => entry.fileId === refused)
      return { ...base, source: 'REFUSED' as const, category: upload?.category ?? null, reason: requestReasonWords('REFUSED', { label: task.recordLabel, category: upload?.category ?? null, reason: upload?.decision?.reason ?? null }) }
    }
    return { ...base, source: 'ASKED' as const, category: null, reason: requestReasonWords('ASKED', { label: task.recordLabel }) }
  })
}

// ---- "Your documents" ---------------------------------------------------------------------------------------------------------

const FILE_SELECT = { id: true, recordType: true, recordId: true, companyId: true, category: true, originalName: true, contentType: true, sizeBytes: true, status: true, quarantineReason: true, expiresOn: true, supersededAt: true, availableAt: true, createdAt: true, version: true } as const satisfies Prisma.StoredFileSelect
type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_SELECT }>

export interface DocumentRow {
  readonly fileId: string
  readonly uploadFileId: string | null
  readonly state: SupplierDocumentState
  readonly category: string | null
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly issuer: string | null
  readonly number: string | null
  readonly issuedOn: string | null
  readonly expiresOn: string | null
  readonly daysLeft: number | null
  readonly articles: string[]
  readonly lots: string[]
  readonly sentAt: string | null
  readonly decidedAt: string | null
  readonly reason: string | null
  /** Accepted and current: the supplier may send its next version. */
  readonly canReplace: boolean
}

async function labelsOf(client: FactoryClient, refs: readonly { readonly recordType: string; readonly recordId: string }[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(refs.filter((ref) => ref.recordType === type).map((ref) => ref.recordId))]
  const labels = new Map<string, string>()
  const parties = ids('Party')
  if (parties.length > 0) for (const row of await client.party.findMany({ where: { id: { in: parties } }, select: { id: true, code: true } })) labels.set(row.id, row.code)
  const orders = ids('PurchaseOrder')
  if (orders.length > 0) for (const row of await client.purchaseOrder.findMany({ where: { id: { in: orders } }, select: { id: true, number: true } })) labels.set(row.id, row.number)
  const notices = ids('ShipNotice')
  if (notices.length > 0) for (const row of await client.shipNotice.findMany({ where: { id: { in: notices } }, select: { id: true, number: true } })) labels.set(row.id, row.number ?? 'Ship notice')
  const jobs = ids('SubcontractOrder')
  if (jobs.length > 0) for (const row of await client.subcontractOrder.findMany({ where: { id: { in: jobs } }, select: { id: true, number: true } })) labels.set(row.id, row.number)
  return labels
}

/**
 * The supplier's documents: those shared with it as accepted (current versions of the supplier kinds, on its records of the
 * portal's company) and its own uploads not accepted (waiting, held, refused in the last 90 days). System scope, filtered to
 * the party and the company.
 */
async function documentRows(client: FactoryClient, session: PortalSession, uploads: readonly UploadRecord[], today: BusinessDate): Promise<DocumentRow[]> {
  const companyId = session.company.id
  const shared = await client.storedFile.findMany({
    where: {
      partyId: session.partyId,
      visibility: { has: 'PARTNER' },
      status: 'AVAILABLE',
      supersededAt: null,
      category: { in: [...SUPPLIER_DOCUMENT_CATEGORIES] },
      recordType: { in: ['Party', 'PurchaseOrder', 'ShipNotice', 'SubcontractOrder'] },
      OR: [{ companyId }, { companyId: null }],
    },
    orderBy: [{ expiresOn: 'asc' }, { createdAt: 'desc' }],
    take: 500,
    select: FILE_SELECT,
  })
  const ownIds = uploads.map((upload) => upload.fileId)
  const own = ownIds.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: ownIds } }, select: FILE_SELECT })
  const files = new Map<string, FileRow>([...own, ...shared].map((row) => [row.id, row] as const))
  const byDocument = new Map<string, UploadRecord>()
  for (const upload of uploads) if (upload.decision?.kind === 'ACCEPTED') byDocument.set(upload.decision.documentFileId ?? upload.fileId, upload)
  const labels = await labelsOf(client, shared)
  const rows: DocumentRow[] = []
  for (const file of shared) {
    const upload = byDocument.get(file.id) ?? null
    const expiresOn = file.expiresOn === null ? null : dayOf(file.expiresOn)
    rows.push({
      fileId: file.id,
      uploadFileId: upload?.fileId ?? null,
      state: documentStateOf({ status: file.status, quarantineReason: file.quarantineReason, decision: 'ACCEPTED', expiresOn, today }),
      category: file.category,
      name: file.originalName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      record: { type: file.recordType, id: file.recordId, label: labels.get(file.recordId) ?? '' },
      issuer: upload?.issuer ?? null,
      number: upload?.number ?? null,
      issuedOn: upload?.issuedOn ?? null,
      expiresOn,
      daysLeft: daysLeftOf(expiresOn, today),
      articles: [...(upload?.articles ?? [])],
      lots: [...(upload?.lots ?? [])],
      sentAt: upload ? iso(upload.at) : null,
      decidedAt: upload?.decision ? iso(upload.decision.at) : iso(file.availableAt),
      reason: null,
      canReplace: true,
    })
  }
  const shownFrom = Date.parse(`${today}T00:00:00Z`) - REFUSED_SHOWN_DAYS * 86_400_000
  for (const upload of uploads) {
    if (upload.decision?.kind === 'ACCEPTED' || upload.companyId !== companyId) continue
    const file = files.get(upload.fileId)
    if (!file) continue
    const state = documentStateOf({ status: file.status, quarantineReason: file.quarantineReason, decision: upload.decision ? 'REJECTED' : null, expiresOn: upload.expiresOn, today })
    if (state === 'NOT_RECEIVED' || file.status === 'DELETED') continue
    if (state === 'REJECTED' && upload.decision !== null && upload.decision.at.getTime() < shownFrom) continue
    rows.push({
      fileId: file.id,
      uploadFileId: upload.fileId,
      state,
      category: upload.category,
      name: file.originalName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      record: { type: upload.recordType, id: upload.recordId, label: upload.recordLabel },
      issuer: upload.issuer,
      number: upload.number,
      issuedOn: upload.issuedOn,
      expiresOn: upload.expiresOn,
      daysLeft: daysLeftOf(upload.expiresOn, today),
      articles: [...upload.articles],
      lots: [...upload.lots],
      sentAt: iso(upload.at),
      decidedAt: upload.decision ? iso(upload.decision.at) : null,
      reason: upload.decision?.reason ?? null,
      canReplace: false,
    })
  }
  const order: Readonly<Record<SupplierDocumentState, number>> = { REJECTED: 0, HELD: 1, EXPIRED: 2, CHECKING: 3, WAITING: 4, ACCEPTED: 5, NOT_RECEIVED: 6 }
  return rows.sort((a, b) => order[a.state] - order[b.state] || (a.daysLeft ?? 99_999) - (b.daysLeft ?? 99_999) || a.name.localeCompare(b.name))
}

/** GET /portal/supplier-documents. */
export async function supplierDocuments(request: FastifyRequest, now: Date) {
  const session = portalSessionOf(request)
  const today = businessDate(now)
  const { uploads, documents, rules } = await system(request, session).withClient(async (client) => {
    const uploads = await partyUploads(client, session.partyId)
    const documents = await documentRows(client, session, uploads, today)
    const waitingFor = (category: string, record: { type: string; id: string }) =>
      documents.some((row) => isWaiting(row.state) && row.category === category && (record.type === 'Party' || (row.record.type === record.type && row.record.id === record.id)))
    return { uploads, documents, rules: await ruleRows(client, session, today, waitingFor) }
  })
  const requested = [...(await requestRows(request, session, uploads)), ...rules].sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || a.key.localeCompare(b.key))
  return {
    today,
    mayUpload: mayUpload(request, session),
    categories: [...SUPPLIER_DOCUMENT_CATEGORIES],
    requested,
    documents,
    counts: {
      requested: requested.filter((row) => !row.waiting).length,
      waiting: documents.filter((row) => isWaiting(row.state)).length,
      expiring: documents.filter((row) => (row.state === 'ACCEPTED' && row.daysLeft !== null && row.daysLeft <= 30) || row.state === 'EXPIRED').length,
      refused: documents.filter((row) => row.state === 'REJECTED').length,
    },
    live: { events: [...DOCUMENT_LIVE_EVENTS] },
  }
}

/** Home's counts: what we ask for, and documents expiring within 30 days or expired. */
export async function supplierDocumentCounts(request: FastifyRequest, now: Date): Promise<{ readonly requested: number; readonly expiring: number }> {
  const answer = await supplierDocuments(request, now)
  return { requested: answer.counts.requested, expiring: answer.counts.expiring }
}

// ---- upload -----------------------------------------------------------------------------------------------------------------

export interface UploadBody extends UploadDetailsInput {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  /** The request it answers (an open UPLOAD_DOCUMENT task of the party): the file goes on that request's record. */
  readonly taskId?: string | null | undefined
  /** Or the record it is for (the supplier's own record by default). */
  readonly recordType?: string | null | undefined
  readonly recordId?: string | null | undefined
  /** An accepted document of the supplier's this one replaces (its next version once accepted). */
  readonly replacesFileId?: string | null | undefined
}

/** Where the upload goes, from the request, the document it replaces or the record named. */
async function targetOf(request: FastifyRequest, session: PortalSession, body: UploadBody): Promise<{ readonly type: SupplierDocumentRecordType; readonly id: string; readonly label: string; readonly taskId: string | null; readonly replacesFileId: string | null }> {
  const sys = system(request, session)
  if (body.replacesFileId) {
    // An accepted document shared with the supplier (its own scope reads only those).
    const replaced = isUuid(body.replacesFileId)
      ? await request.withClient((client) =>
          client.storedFile.findFirst({ where: { id: body.replacesFileId!, status: 'AVAILABLE', supersededAt: null, visibility: { has: 'PARTNER' }, category: { in: [...SUPPLIER_DOCUMENT_CATEGORIES] } }, select: { id: true, recordType: true, recordId: true, companyId: true } }),
        )
      : null
    if (!replaced || !isSupplierDocumentRecordType(replaced.recordType) || (replaced.companyId !== null && replaced.companyId !== session.company.id)) {
      throw new ValidationError('The document it replaces is not one of your accepted documents.', [{ path: 'body/replacesFileId', message: 'One of your accepted documents.' }])
    }
    const record = await sys.withClient((client) => supplierRecord(client, session, replaced.recordType as SupplierDocumentRecordType, replaced.recordId))
    if (!record) throw new ValidationError('The document it replaces is not one of your accepted documents.', [{ path: 'body/replacesFileId', message: 'One of your accepted documents.' }])
    return { ...record, taskId: null, replacesFileId: replaced.id }
  }
  if (body.taskId) {
    const task = isUuid(body.taskId) ? await request.withClient((client) => client.partnerTask.findFirst({ where: { id: body.taskId!, companyId: session.company.id, kind: 'UPLOAD_DOCUMENT' }, select: TASK_COLUMNS })) : null
    if (!task) throw new ValidationError('This request is not one of yours.', [{ path: 'body/taskId', message: 'An open request of yours to upload a document.' }])
    if (task.status !== 'OPEN') throw new InvalidStateError(task.status === 'DONE' ? 'This request is answered already.' : 'We withdrew this request.')
    const type = isSupplierDocumentRecordType(task.recordType) ? task.recordType : 'Party'
    const record = await sys.withClient((client) => supplierRecord(client, session, type, type === 'Party' ? session.partyId : task.recordId))
    if (!record) throw new NotFoundError('The record this request is about is not there any more.')
    return { ...record, taskId: task.id, replacesFileId: null }
  }
  const type = body.recordType ?? 'Party'
  if (!isSupplierDocumentRecordType(type)) throw new ValidationError('A document is for your company, or one of your orders, ship notices or jobs.', [{ path: 'body/recordType', message: 'Party, PurchaseOrder, ShipNotice or SubcontractOrder.' }])
  const record = await sys.withClient((client) => supplierRecord(client, session, type, type === 'Party' ? (body.recordId ?? session.partyId) : (body.recordId ?? '')))
  if (!record) throw new NotFoundError('Record not found.')
  return { ...record, taskId: null, replacesFileId: null }
}

/** The supplier person's office-scope command (its own acts: `byPartner`). */
function asPerson(app: FastifyInstance, request: FastifyRequest, session: PortalSession) {
  const p = portalOf(app)
  return { p, context: p.auth.contextFor(request, session.tenantId, session.userId) }
}

/** POST /portal/supplier-documents: the document announced, then its presigned PUT. */
export async function announceDocument(app: FastifyInstance, request: FastifyRequest, body: UploadBody, now: Date, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  assertMayUpload(request, session)
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  const checked = checkUploadDetails(body, businessDate(now))
  if (!checked.ok) throw new ValidationError('The document is not valid.', [...checked.issues])
  const target = await targetOf(request, session, body)
  const answer = await requestUpload(
    processFiles(),
    supplierUploader(request, session.tenantId, session.company.id, session.partyId),
    { companyId: session.company.id, recordType: target.type, recordId: target.id, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    idempotencyKey,
  )
  const { p, context } = asPerson(app, request, session)
  const details = checked.details
  await p.auth.command(context, { name: 'supplierDocuments.upload', idempotencyKey: keyFor(idempotencyKey, 'document'), input: { fileId: answer.file.id, ...details, taskId: target.taskId, replacesFileId: target.replacesFileId } }, async (tools) => {
    // One upload per file (the party's row locked first: two announces of one file never both insert).
    await lockSupplier(tools.tx, session.partyId)
    const known = await tools.tx.supplierDocumentUpload.findFirst({ where: { fileId: answer.file.id }, select: { id: true } })
    if (known) return { recorded: false }
    const uploadId = newId()
    await tools.tx.supplierDocumentUpload.create({
      data: {
        id: uploadId,
        companyId: session.company.id,
        partyId: session.partyId,
        fileId: answer.file.id,
        recordType: target.type,
        recordId: target.id,
        recordLabel: target.label,
        category: details.category,
        issuer: details.issuer,
        documentNumber: details.number,
        issuedOn: details.issuedOn === null ? null : dayValue(details.issuedOn),
        expiresOn: details.expiresOn === null ? null : dayValue(details.expiresOn),
        articleCodes: [...details.articles],
        lotCodes: [...details.lots],
        note: details.note,
        replacesFileId: target.replacesFileId,
        taskId: target.taskId,
        uploadedById: session.userId,
        uploadedByName: session.person.displayName,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: session.userId,
      },
      select: { id: true },
    })
    tools.audit({
      action: ACTIONS.upload,
      recordType: 'Party',
      recordId: session.partyId,
      companyId: session.company.id,
      after: {
        uploadId,
        fileId: answer.file.id,
        recordType: target.type,
        recordId: target.id,
        recordLabel: target.label,
        ...details,
        articles: [...details.articles],
        lots: [...details.lots],
        taskId: target.taskId,
        replacesFileId: target.replacesFileId,
        byPartner: true,
        personId: session.userId,
        personName: session.person.displayName,
      },
    })
    return { recorded: true }
  })
  return { file: { id: answer.file.id, status: answer.file.status }, record: { type: target.type, id: target.id, label: target.label }, upload: answer.upload }
}

/** Inside the confirm's command: the file arrived (once), the request it answered closes (DONE by the person), the office learns of it. */
async function received(tools: CommandTools, session: PortalSession, upload: UploadRecord): Promise<boolean> {
  // Once, while it waits: the row's own compare-and-set (a second confirm finds it received and writes nothing).
  const marked = await tools.tx.supplierDocumentUpload.updateMany({ where: { id: upload.id, partyId: session.partyId, status: 'WAITING', receivedAt: null }, data: { receivedAt: tools.now, version: { increment: 1 } } })
  if (marked.count === 0) return false
  let closed: TaskRow | null = null
  if (upload.taskId) {
    const task = await tools.tx.partnerTask.findFirst({ where: { id: upload.taskId, partyId: session.partyId, status: 'OPEN' }, select: TASK_COLUMNS })
    if (task) {
      await closeOne(tools, task, 'DONE', session.userId, true)
      closed = task
    }
  }
  tools.audit({ action: ACTIONS.received, recordType: 'Party', recordId: session.partyId, companyId: session.company.id, after: { uploadId: upload.id, fileId: upload.fileId, taskId: closed?.id ?? null, byPartner: true, personId: session.userId } })
  tools.emit({
    type: 'supplier_document.uploaded',
    subject: upload.fileId,
    companyId: session.company.id,
    payload: { fileId: upload.fileId, partyId: session.partyId, recordType: upload.recordType, recordId: upload.recordId, category: upload.category, replacesFileId: upload.replacesFileId },
  })
  return true
}

/** POST /portal/supplier-documents/:fileId/complete. */
export async function completeDocument(app: FastifyInstance, request: FastifyRequest, fileId: string, now: Date, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  assertMayUpload(request, session)
  const upload = isUuid(fileId) ? (await system(request, session).withClient((client) => partyUploads(client, session.partyId))).find((entry) => entry.fileId === fileId && entry.companyId === session.company.id) : undefined
  if (!upload) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), supplierUploader(request, session.tenantId, session.company.id, session.partyId), fileId, idempotencyKey)
  const state = documentStateOf({ status: view.status, quarantineReason: view.quarantineReason, decision: upload.decision ? (upload.decision.kind === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED') : null, expiresOn: upload.expiresOn, today: businessDate(now) })
  if (state === 'WAITING' || state === 'CHECKING') {
    const { p, context } = asPerson(app, request, session)
    await p.auth.command(context, { name: 'supplierDocuments.received', idempotencyKey: keyFor(idempotencyKey, 'received'), input: { fileId } }, (tools) => received(tools, session, upload))
  }
  return { file: { id: fileId, status: view.status }, state }
}
