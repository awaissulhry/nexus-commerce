import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { GuestExportView, GuestFileView, GuestInvoiceView, GuestOverviewAnswer, GuestPeriodAnswer, GuestRegisterView, GuestZipBody } from '@nexus/factory-domain/accounting/guest/contracts'
import { batchStanding, GUEST_ZIP, isJournal, purchaseKindOf, REGISTER_PACKAGES, REGISTERS_LATER, registerStanding, salesKindOf, zipNameOf, zipPaths, zipProblem, type ZipFolder } from '@nexus/factory-domain/accounting/guest/files'
import { dayShared, handedOverMonths, latestHandedOver, periodChoices } from '@nexus/factory-domain/accounting/guest/periods'
import { monthOfDay } from '@nexus/factory-domain/accounting/periods'
import { accessEndsSoon } from '@nexus/factory-domain/auth/partners/rules'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { presignedView, storeCall } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { guestGrantOf, guestReaderOf, guestRefusal, type GuestGrant, type GuestReader } from './access'
import { exportedBatches, givenByOf, invoicesBetween, liveLocks, lockOver, type StoredFileRow } from './store'
import { indexCsv, writeZip, type ZipEntry } from './zip'

/**
 * The accountant's room in the portal (B-W2b-201; FIN-158; design portal.guest.accountant, SCR-268):
 *
 *   GET  /portal/accounting                            your access (firm, company, given by, until), the handed-over months
 *                                                      with their locks, the period picker's choices, the newest month
 *   GET  /portal/accounting/periods/:period            a month, quarter or year: its months (handed over or not, locked),
 *                                                      the batches' journal files, every e-invoice (XML, PDF), the registers
 *   POST /portal/accounting/files/:fileId/download     one file of the period: ONE command writes its audit row, then a
 *                                                      60-second link presigned by the tenant's system caller
 *   POST /portal/accounting/zip                        the whole period, its XML, or the files chosen, as ONE zip written
 *                                                      here (never stored), with an index; one audit row
 *
 * Reads run in the tenant's system scope only after the guest grant (access.ts) named the company and the period. Files
 * only: what names a file (number, day, the other party, the SDI state) and never an amount or a record. Every download
 * is in the audit log (`portal.accountingDownload`, `portal.accountingZip`); an office preview reads but never downloads
 * (the authenticator refuses its POSTs).
 */

export const DOWNLOAD_ACTION = 'portal.accountingDownload'
export const ZIP_ACTION = 'portal.accountingZip'

const fileView = (row: StoredFileRow | null): GuestFileView | null => (row && row.status === 'AVAILABLE' ? { id: row.id, name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: row.sha256 } : null)

/** GET /portal/accounting. */
export async function guestOverview(app: FastifyInstance, request: FastifyRequest): Promise<GuestOverviewAnswer> {
  const reader = await guestReaderOf(app, request)
  const now = reader.clock.now()
  const { batches, locks, givenBy } = await reader.system.withClient(async (client) => ({
    batches: await exportedBatches(client, reader.companyId),
    locks: await liveLocks(client, reader.companyId),
    givenBy: reader.preview ? null : await givenByOf(client, reader.session.userId),
  }))
  const handedOver = handedOverMonths(batches)
  const accessUntil = reader.preview ? null : reader.session.person.accessUntil
  return {
    access: {
      firm: reader.firm,
      company: { id: reader.session.company.id, code: reader.session.company.code, name: reader.session.company.name },
      givenBy,
      accessUntil: accessUntil ? toUtcIso(accessUntil) : null,
      endsSoon: accessEndsSoon(accessUntil, now),
      preview: reader.preview,
    },
    months: [...handedOver].reverse().map((month) => {
      const lock = lockOver(locks, month)
      return { month, lock: lock ? { level: lock.level, lockedAt: toUtcIso(lock.lockedAt) } : null, batches: batches.filter((batch) => monthOfDay(batch.periodStart) <= month && month <= monthOfDay(batch.periodEnd)).length }
    }),
    choices: (({ months, quarters, years }) => ({ months: [...months], quarters: [...quarters], years: [...years] }))(periodChoices(handedOver)),
    latest: latestHandedOver(handedOver),
    asOf: toUtcIso(now),
  }
}

/** One file the period lists: where it goes in a zip and what it is (the audit row and the zip's index say it). */
interface Listed {
  readonly row: StoredFileRow
  readonly folder: ZipFolder
  readonly what: string
  readonly number: string
  readonly date: string
  readonly xml: boolean
  /** Part of "the whole period" (an older register file replaced whole by a later batch is not). */
  readonly inPeriodZip: boolean
}

interface Material {
  readonly exports: GuestExportView[]
  readonly invoices: GuestInvoiceView[]
  readonly registers: GuestRegisterView[]
  readonly files: Map<string, Listed>
}

/** Everything the period lists, read in the system scope for the grant's company and handed-over months only. */
async function materialOf(reader: GuestReader, grant: GuestGrant): Promise<Material> {
  const shared = new Set(grant.share.shared)
  const inPeriod = grant.batches.filter((batch) => shared.has(monthOfDay(batch.periodStart)))
  const standing = batchStanding(grant.batches.map((batch) => ({ id: batch.id, number: batch.number, supersedesId: batch.supersedesId, exportedAt: toUtcIso(batch.exportedAt), packages: batch.packages })))
  const files = new Map<string, Listed>()

  const exports: GuestExportView[] = inPeriod.map((batch) => {
    const own = standing.get(batch.id) ?? { amends: null, amendedBy: null }
    const journals = batch.files.filter((entry) => isJournal(entry.package)).flatMap((entry) => {
      const file = fileView(entry.file)
      if (!file) return []
      files.set(file.id, { row: entry.file, folder: 'EXPORTS', what: entry.package, number: batch.number, date: batch.periodStart, xml: false, inPeriodZip: true })
      return [{ package: entry.package, format: entry.format, rowCount: entry.rowCount, file }]
    })
    return { exportId: batch.id, number: batch.number, month: monthOfDay(batch.periodStart), exportedAt: toUtcIso(batch.exportedAt), amends: own.amends, amendedBy: own.amendedBy, files: journals }
  })

  const registerRows = inPeriod.flatMap((batch) =>
    batch.files
      .filter((entry) => (REGISTER_PACKAGES as readonly string[]).includes(entry.package) && fileView(entry.file) !== null)
      .map((entry) => ({ month: monthOfDay(batch.periodStart), package: entry.package, exportNumber: batch.number, exportedAt: toUtcIso(batch.exportedAt), format: entry.format, file: fileView(entry.file)!, row: entry.file })),
  )
  const registers: GuestRegisterView[] = registerStanding(registerRows).map(({ row, ...view }) => {
    files.set(view.file.id, { row, folder: 'REGISTERS', what: view.package, number: view.exportNumber, date: `${view.month}-01`, xml: false, inPeriodZip: view.current })
    return view
  })

  const rows = await reader.system.withClient((client) => invoicesBetween(client, reader.companyId, grant.period.start, grant.period.end))
  const invoices: GuestInvoiceView[] = rows
    .filter((row) => dayShared(row.date, grant.share))
    .map((row) => {
      const xml = fileView(row.xml)
      const pdf = fileView(row.pdf)
      const folder: ZipFolder = row.side === 'SALES' ? 'SALES' : 'PURCHASE'
      if (xml) files.set(xml.id, { row: row.xml!, folder, what: `${row.side}_XML`, number: row.number, date: row.date, xml: true, inPeriodZip: true })
      if (pdf) files.set(pdf.id, { row: row.pdf!, folder, what: `${row.side}_PDF`, number: row.number, date: row.date, xml: false, inPeriodZip: true })
      return { id: row.id, side: row.side, kind: row.side === 'SALES' ? salesKindOf(row.docType ?? 'TD01') : purchaseKindOf(row.kind ?? 'INVOICE', row.docType), number: row.number, date: row.date, party: row.party, state: row.state, xml, pdf }
    })
  return { exports, invoices, registers, files }
}

/** GET /portal/accounting/periods/:period. */
export async function guestPeriod(app: FastifyInstance, request: FastifyRequest, periodKey: string): Promise<GuestPeriodAnswer> {
  const reader = await guestReaderOf(app, request)
  const grant = await guestGrantOf(reader, periodKey)
  const [material, locks] = await Promise.all([materialOf(reader, grant), reader.system.withClient((client) => liveLocks(client, reader.companyId))])
  const listed = [...material.files.values()]
  return {
    period: {
      key: grant.period.key,
      kind: grant.period.kind,
      start: grant.period.start,
      end: grant.period.end,
      months: grant.share.months.map((entry) => {
        const lock = lockOver(locks, entry.month)
        return { month: entry.month, shared: entry.shared, lock: lock ? { level: lock.level, lockedAt: toUtcIso(lock.lockedAt) } : null }
      }),
    },
    exports: material.exports,
    invoices: material.invoices,
    registers: material.registers,
    later: [...REGISTERS_LATER],
    counts: { files: listed.filter((entry) => entry.inPeriodZip).length, xml: listed.filter((entry) => entry.xml).length, sizeBytes: listed.filter((entry) => entry.inPeriodZip).reduce((sum, entry) => sum + entry.row.sizeBytes, 0) },
    asOf: toUtcIso(reader.clock.now()),
  }
}

const previewRefusal = () => new ForbiddenError('A preview reads the accountant’s room; it never downloads for them.')

/** POST /portal/accounting/files/:fileId/download {period}. */
export async function guestDownload(app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly period: string }, idempotencyKey?: string) {
  const reader = await guestReaderOf(app, request)
  if (reader.preview) throw previewRefusal()
  const grant = await guestGrantOf(reader, body.period)
  const material = await materialOf(reader, grant)
  const listed = material.files.get(fileId)
  if (!listed) throw guestRefusal('FILE_NOT_IN_PERIOD')
  await commandOn(app, request, { name: DOWNLOAD_ACTION, idempotencyKey, input: { fileId, period: grant.period.key } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: fileId, companyId: reader.companyId, after: { period: grant.period.key, what: listed.what, number: listed.number, name: listed.row.originalName, sha256: listed.row.sha256, firmId: reader.firm.id } })
    return { fileId }
  })
  const runtime = processFiles()
  const presigned = await storeCall(() =>
    runtime.storage.presignDownload(reader.system, listed.row.storeAccountId, {
      key: listed.row.storageKey,
      contentType: listed.row.contentType,
      disposition: attachmentDisposition(listed.row.originalName),
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return { file: { id: listed.row.id, name: listed.row.originalName }, download: presignedView(presigned) }
}

/** The files a zip carries: the whole period (journals, current registers, every invoice file), its XML, or the chosen. */
function chosenFiles(material: Material, body: GuestZipBody): Listed[] {
  const all = [...material.files.values()]
  if (body.what === 'PERIOD') return all.filter((entry) => entry.inPeriodZip)
  if (body.what === 'XML') return all.filter((entry) => entry.xml)
  const ids = [...new Set(body.fileIds ?? [])]
  if (ids.length === 0) throw guestRefusal('NOTHING_TO_ZIP')
  return ids.map((id) => {
    const entry = material.files.get(id)
    if (!entry) throw guestRefusal('FILE_NOT_IN_PERIOD')
    return entry
  })
}

/** Reads each file's bytes through the store (a few at a time); a file whose object is missing is named in the index. */
async function readAll(reader: GuestReader, files: readonly Listed[]): Promise<(Buffer | null)[]> {
  const runtime = processFiles()
  const out: (Buffer | null)[] = new Array(files.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]!
      out[index] = await storeCall(() => runtime.storage.read(reader.system, file.row.storeAccountId, file.row.storageKey, GUEST_ZIP.fileBytes))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
  return out
}

/** POST /portal/accounting/zip {period, what, fileIds?}: the zip's bytes (an attachment). */
export async function guestZip(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: GuestZipBody) {
  const reader = await guestReaderOf(app, request)
  if (reader.preview) throw previewRefusal()
  const grant = await guestGrantOf(reader, body.period)
  const material = await materialOf(reader, grant)
  const files = chosenFiles(material, body)
  const problem = zipProblem(files.map((entry) => ({ sizeBytes: entry.row.sizeBytes })))
  if (problem) throw guestRefusal(problem)
  const paths = zipPaths(files.map((entry) => ({ folder: entry.folder, name: entry.row.originalName })))
  const bytes = await readAll(reader, files)
  const included = files.map((_, index) => bytes[index] !== null)
  if (!included.some(Boolean)) throw guestRefusal('FILE_UNAVAILABLE', 'not_ready')
  const index = indexCsv(files.map((entry, at) => ({ path: paths[at]!, what: entry.what, number: entry.number, date: entry.date, sha256: entry.row.sha256, sizeBytes: entry.row.sizeBytes, included: included[at]! })))
  const entries: ZipEntry[] = [{ path: 'index.csv', bytes: index }, ...files.flatMap((_, at) => (bytes[at] ? [{ path: paths[at]!, bytes: bytes[at]! }] : []))]
  const now = reader.clock.now()
  const zip = writeZip(entries, now)
  const name = zipNameOf(reader.session.company.code, grant.period.key, body.what)
  await commandOn(app, request, { name: ZIP_ACTION, input: { period: grant.period.key, what: body.what, fileIds: files.map((entry) => entry.row.id) } }, async (tools) => {
    tools.audit({
      recordType: 'Party',
      recordId: reader.firm.id,
      companyId: reader.companyId,
      after: { period: grant.period.key, what: body.what, name, files: files.length, included: included.filter(Boolean).length, sizeBytes: zip.length, fileIds: files.map((entry) => entry.row.id) },
    })
    return { files: files.length }
  })
  return reply.type('application/zip').header('content-disposition', attachmentDisposition(name)).header('cache-control', 'no-store').send(zip)
}
