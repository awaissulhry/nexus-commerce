import type { Prisma } from '@nexus/factory-db'
import { PRINT_DOCUMENTS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { packingListProblems } from '@nexus/factory-domain/shipping/packing/versions'
import {
  inPackOrder,
  mayHave,
  NOT_SHOWN_WORDS,
  PACK_KIND,
  PACK_MAX_BYTES,
  PACK_MAX_PAGES,
  packFingerprint,
  packProblems,
  type PackPart,
  type PackPartFacts,
  type PartFile,
} from '@nexus/factory-domain/shipping/shipment-pack/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { putGeneratedFile, recordGeneratedFile, type Callers } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { assertMay, shippingContextOf, type ShippingContext } from '../access'
import { tenantOf } from '../cells'
import { liveDdtOf, pdfFileIdOf } from '../ddt/store'
import { labelFilesOf, readLabelParcels } from '../labels/store'
import { packingList, packingListFingerprint } from '../shipments/packing-list'
import { readContents, readShipment, type ShipmentHeader } from '../store'
import { mergePdfs, PdfMergeError } from './pdf-merge'

/**
 * One PDF per shipment (B-W2b-391; LOG-031; factory-domain shipping/shipment-pack/rules.ts). Office and a floor device at the
 * shipment's site (shipping.pack):
 *
 *   GET  /shipping/shipments/:shipmentId/pack       what the pack holds now, part by part (ready, missing and why, none, not
 *                                                   shown: it has prices), the newest version and whether it is current
 *   POST /shipping/shipments/:shipmentId/pack       the pack made (or the newest given back when the papers are the same):
 *                                                   the stored files read, merged page by page (pdf-merge.ts: no PDF library
 *                                                   is added), stored as a file of the shipment and kept as a version
 *                                                   (GeneratedDocument SHIPMENT_PACK) in ONE command under the shipment's
 *                                                   pack lock, event shipping.pack_made; the office's pack is also ONE print
 *                                                   job on the site's document printer (print.documents there) unless
 *                                                   `print: false`. The office makes the packing list first when none
 *                                                   matches the parcels (B-W1-46's packing list, its own version).
 *   GET  /shipping/shipments/:shipmentId/pack/pdf   the newest (or a named) version's PDF itself: the floor holds no
 *                                                   files.read, so the tablet's PdfViewer prints it from here (B-W2b-387)
 *
 * The floor neither reads nor stores files: after the checks (its own site, shipping.pack), its reads and its write run as
 * its tenant's system caller, naming the device and the worker on the shipment's audit row. A pack with a priced part (a
 * commercial invoice, a proforma) is kept for the office only; the floor's never has one.
 */

const FILE = { id: true, sha256: true, sizeBytes: true, storeAccountId: true, storageKey: true, status: true, visibility: true } as const satisfies Prisma.StoredFileSelect
type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE }>

interface Part extends PackPartFacts {
  readonly rows: readonly FileRow[]
}

async function packerShipment(caller: CommandCaller, shipmentId: string): Promise<{ context: ShippingContext; shipment: ShipmentHeader }> {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_PACK, SHIPPING_PACK, shipment)
  return { context, shipment: shipment! }
}

/** The caller (office) or its tenant as the system (a floor device: no file grants), for the reads of files and the write. */
const storeCallerOf = (callers: Callers, context: ShippingContext): CommandCaller => (context.audience === 'office' ? callers.caller : callers.system(tenantOf(context)))

const seesPricesOf = (context: ShippingContext): boolean => context.audience === 'office' && holds(actorOf(context), 'money.price')

const ready = (kind: PackPart, rows: readonly FileRow[], number: string | null, words: string | null = null): Part => ({
  kind,
  state: 'READY',
  number,
  words,
  files: rows.map((row): PartFile => ({ fileId: row.id, sha256: row.sha256 })),
  rows,
})
const notReady = (kind: PackPart, state: 'MISSING' | 'NONE' | 'NOT_SHOWN', words: string | null = null): Part => ({ kind, state, number: null, words, files: [], rows: [] })

async function availableFiles(db: CommandTx, ids: readonly string[]): Promise<Map<string, FileRow>> {
  if (ids.length === 0) return new Map()
  const rows = await db.storedFile.findMany({ where: { id: { in: [...ids] }, status: 'AVAILABLE', contentType: 'application/pdf' }, select: FILE })
  return new Map(rows.map((row) => [row.id, row]))
}

/** The newest generated document of a kind of the shipment, with its file when available. */
async function newestOf(db: CommandTx, shipmentId: string, kind: 'COMMERCIAL_INVOICE' | 'PROFORMA') {
  const row = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipmentId, kind }, select: { number: true, fileId: true }, orderBy: { version: 'desc' } })
  if (!row) return null
  const file = (await availableFiles(db, [row.fileId])).get(row.fileId) ?? null
  return { number: row.number, file }
}

/** Every part of the pack as the papers stand (read by the office caller, or the tenant's system for a floor device). */
async function readParts(db: CommandTx, shipment: ShipmentHeader, seesPrices: boolean): Promise<Part[]> {
  const parts: Part[] = []

  // The carrier labels: each labelled parcel's current label PDF.
  const parcels = await readLabelParcels(db, shipment.id)
  const extra = await db.shipment.findUnique({ where: { id: shipment.id }, select: { manualTrackingNumber: true } })
  if (shipment.transportBy !== 'CARRIER' || extra?.manualTrackingNumber) {
    parts.push(notReady('LABELS', 'NONE', shipment.transportBy !== 'CARRIER' ? 'No carrier label: our van or the customer carries the goods.' : "No label of ours: the carrier's own label carries the typed tracking number."))
  } else {
    const labelFiles = await labelFilesOf(db, parcels)
    const pdfIds = parcels.flatMap((parcel) => labelFiles.get(parcel.id)?.filter((file) => file.format === 'PDF').map((file) => file.fileId) ?? [])
    const files = await availableFiles(db, pdfIds)
    const rows: FileRow[] = []
    const notes: string[] = []
    for (const parcel of parcels) {
      const pdf = labelFiles.get(parcel.id)?.find((file) => file.format === 'PDF' && files.has(file.fileId))
      if (pdf) rows.push(files.get(pdf.fileId)!)
      else if (parcel.labelledAt === null) notes.push(`Parcel ${parcel.seq} has no carrier label yet.`)
      else notes.push(`Parcel ${parcel.seq}: its label is kept as ZPL only: print it on the label printer.`)
    }
    parts.push(rows.length > 0 ? ready('LABELS', rows, null, notes.length > 0 ? notes.join(' ') : null) : notReady('LABELS', 'MISSING', parcels.length === 0 ? 'Pack the parcels and buy their carrier labels first.' : notes.join(' ') || 'Buy the carrier labels first.'))
  }

  // The packing list: the newest version, while it matches the parcels.
  const newestList = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipment.id, kind: 'PACKING_LIST' }, select: { number: true, fileId: true, fingerprint: true }, orderBy: { version: 'desc' } })
  const contents = await readContents(db, shipment.id)
  const listFile = newestList ? (await availableFiles(db, [newestList.fileId])).get(newestList.fileId) : undefined
  if (newestList && listFile && newestList.fingerprint === packingListFingerprint(contents)) parts.push(ready('PACKING_LIST', [listFile], newestList.number))
  else parts.push(notReady('PACKING_LIST', 'MISSING', newestList ? 'The packing list no longer matches the parcels: the office prints it again.' : 'The office prints the packing list first.'))

  // The live DDT's stored PDF.
  if (!shipment.ddtRequired) parts.push(notReady('DDT', 'NONE', 'This shipment travels without a DDT (an immediate invoice goes with it).'))
  else {
    const live = await liveDdtOf(db, shipment.id)
    const fileId = live ? await pdfFileIdOf(db, live.id) : null
    const file = fileId ? (await availableFiles(db, [fileId])).get(fileId) : undefined
    parts.push(file ? ready('DDT', [file], live!.number) : notReady('DDT', 'MISSING', live ? "The DDT's PDF is not stored yet: print it from the DDT in the office." : 'The office issues the DDT first.'))
  }

  // The priced papers: only for one who sees prices.
  for (const kind of ['COMMERCIAL_INVOICE', 'PROFORMA'] as const) {
    const newest = await newestOf(db, shipment.id, kind)
    if (!newest?.file) parts.push(notReady(kind, 'NONE'))
    else if (!mayHave(kind, seesPrices)) parts.push(notReady(kind, 'NOT_SHOWN', NOT_SHOWN_WORDS))
    else parts.push(ready(kind, [newest.file], newest.number))
  }
  return inPackOrder(parts)
}

const partView = (part: Part) => ({ kind: part.kind, state: part.state, number: part.number, words: part.words, files: part.files.length })

async function versionsOf(db: CommandTx, shipmentId: string) {
  return db.generatedDocument.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, kind: PACK_KIND }, select: { id: true, version: true, fingerprint: true, fileId: true, createdAt: true }, orderBy: { version: 'desc' } })
}

/** The pages of a version, from its audit row (no column holds them). */
async function pagesOf(db: CommandTx, shipmentId: string, documentId: string): Promise<number | null> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, action: 'shipping.packMade' }, select: { after: true }, orderBy: { at: 'desc' }, take: 50 })
  for (const row of rows) {
    const after = row.after as { documentId?: unknown; pages?: unknown } | null
    if (after?.documentId === documentId && typeof after.pages === 'number') return after.pages
  }
  return null
}

/** The site's document printer (A4), when it has one. */
async function documentPrinterOf(db: CommandTx, siteId: string) {
  const settings = await db.shippingSettings.findUnique({ where: { id: siteId }, select: { documentPrinterId: true } })
  return settings?.documentPrinterId ? db.printer.findUnique({ where: { id: settings.documentPrinterId }, select: { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, mode: true, status: true } }) : null
}

/** GET /shipping/shipments/:shipmentId/pack. */
export async function packState(callers: Callers, shipmentId: string) {
  const { context, shipment } = await packerShipment(callers.caller, shipmentId)
  const reader = storeCallerOf(callers, context)
  return reader.withClient(async (db) => {
    const parts = await readParts(db, shipment, seesPricesOf(context))
    const newest = (await versionsOf(db, shipment.id))[0]
    const printer = context.audience === 'office' ? await documentPrinterOf(db, shipment.siteId) : null
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      status: shipment.status,
      parts: parts.map(partView),
      latest: newest ? { documentId: newest.id, version: newest.version, pages: await pagesOf(db, shipment.id, newest.id), createdAt: toUtcIso(newest.createdAt), current: newest.fingerprint === packFingerprint(parts) } : null,
      printer: printer ? { id: printer.id, code: printer.code, name: printer.name } : null,
    }
  })
}

const refused = (message: string, code = 'PACK') => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

export interface MakePackBody {
  readonly print?: boolean | undefined
  readonly printerId?: string | undefined
  readonly copies?: number | undefined
}

/** POST /shipping/shipments/:shipmentId/pack. */
export async function makePack(files: FilesRuntime, callers: Callers, shipmentId: string, body: MakePackBody, idempotencyKey?: string) {
  const { context, shipment } = await packerShipment(callers.caller, shipmentId)
  const store = storeCallerOf(callers, context)
  const seesPrices = seesPricesOf(context)
  let parts = await store.withClient((db) => readParts(db, shipment, seesPrices))
  // The office prints the packing list first when none matches the parcels (its own version, B-W1-46/B-W2a-48).
  const list = parts.find((part) => part.kind === 'PACKING_LIST')
  if (context.audience === 'office' && list?.state === 'MISSING') {
    const contents = await store.withClient((db) => readContents(db, shipment.id))
    const unpacked = contents.lines.filter((line) => line.parcelId === null).reduce((sum, line) => sum + line.quantity, 0)
    if (packingListProblems(shipment.status, contents.lines.length, unpacked).length === 0) {
      try {
        await packingList(files, callers.caller, shipment.id, {}, idempotencyKey ? `${idempotencyKey}:packing-list` : undefined)
        parts = await store.withClient((db) => readParts(db, shipment, seesPrices))
      } catch (error) {
        // The packing list cannot be printed now (the letterhead, its contents): the pack goes without it, saying why.
        if (!(error instanceof DomainError)) throw error
        parts = parts.map((part) => (part.kind === 'PACKING_LIST' ? { ...part, words: `The packing list cannot be printed: ${error.message}` } : part))
      }
    }
  }
  // Every ready part's files read from the store (OUTSIDE any transaction): a file missing there leaves its part out, said in
  // words, so the dock still prints the rest.
  const bytesOf = new Map<string, Uint8Array>()
  const readyRows = parts.filter((part) => part.state === 'READY').flatMap((part) => part.rows)
  if (readyRows.reduce((sum, row) => sum + row.sizeBytes, 0) > PACK_MAX_BYTES) throw refused('The papers are too large for one PDF: print them one by one.')
  for (const row of readyRows) {
    const bytes = await files.storage.read(store, row.storeAccountId, row.storageKey, PACK_MAX_BYTES)
    if (bytes) bytesOf.set(row.id, bytes)
  }
  parts = parts.map((part) => (part.state === 'READY' && part.rows.some((row) => !bytesOf.has(row.id)) ? notReady(part.kind, 'MISSING', 'Its file is missing from the file store: print it again in the office.') : part))
  const problems = packProblems(shipment.status, parts)
  if (problems.length > 0) throw refused(problems.join(' '))
  const fingerprint = packFingerprint(parts)
  const priced = parts.some((part) => part.state === 'READY' && !mayHave(part.kind, false))
  const language = await store.withClient(async (db) => {
    const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { language: true } })
    return order?.language === 'en' ? 'en' : 'it'
  })

  // The printer the office's pack goes to (checked before anything is stored).
  const wantsJob = context.audience === 'office' && body.print !== false
  let problem: { code: 'NO_PRINTER' | 'PRINTER'; message: string } | null = null
  let printer: { id: string; companyId: string; siteId: string; code: string } | null = null
  if (wantsJob) {
    const chosen = await store.withClient(async (db) =>
      body.printerId ? db.printer.findUnique({ where: { id: body.printerId }, select: { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, mode: true, status: true } }) : documentPrinterOf(db, shipment.siteId),
    )
    if (!chosen) {
      if (body.printerId) throw new NotFoundError('Printer not found.')
      problem = { code: 'NO_PRINTER', message: "The site has no document printer: print the PDF from the browser (or set the site's document printer)." }
    } else if (chosen.siteId !== shipment.siteId || chosen.kind !== 'A4_PDF') {
      throw refused("Choose a document (A4) printer of the shipment's site.", 'PRINTER')
    } else if (chosen.status !== 'ACTIVE') {
      throw refused(`The printer ${chosen.code} is ${chosen.status.toLowerCase()}; it takes no jobs now.`, 'PRINTER')
    } else if (chosen.mode === 'PDF') {
      problem = { code: 'PRINTER', message: `The printer ${chosen.code} prints from the browser: print the PDF there.` }
    } else {
      if (!can(actorOf(context), PRINT_DOCUMENTS, { companyId: chosen.companyId, siteId: chosen.siteId })) throw new ForbiddenError()
      printer = chosen
    }
  }

  // Merge OUTSIDE any transaction, unless the newest version holds these papers already.
  const newest = (await store.withClient((db) => versionsOf(db, shipment.id)))[0]
  const same = newest && newest.fingerprint === fingerprint ? newest : null
  let prepared: Awaited<ReturnType<typeof putGeneratedFile>> | null = null
  let pages: number | null = null
  let pagesPerPart: { kind: PackPart; number: string | null; pages: number }[] = []
  if (!same) {
    const readyParts = parts.filter((part) => part.state === 'READY')
    const bytes = readyParts.flatMap((part) => part.rows.map((row) => bytesOf.get(row.id)!))
    let merged
    try {
      merged = mergePdfs(bytes, { title: `${shipment.number} documents`, maxPages: PACK_MAX_PAGES })
    } catch (error) {
      if (error instanceof PdfMergeError) throw refused(`The papers cannot be merged: ${error.message}`)
      throw error
    }
    pages = merged.pages
    let at = 0
    pagesPerPart = readyParts.map((part) => {
      const count = merged.pagesPerFile.slice(at, at + part.rows.length).reduce((sum, value) => sum + value, 0)
      at += part.rows.length
      return { kind: part.kind, number: part.number, pages: count }
    })
    prepared = await putGeneratedFile(files, store, {
      companyId: shipment.companyId,
      recordType: 'Shipment',
      recordId: shipment.id,
      kind: 'DOCUMENT',
      originalName: `${shipment.number.replace(/[\\/]/g, '-')} documents.pdf`,
      contentType: 'application/pdf',
      body: merged.pdf,
      // A pack with prices stays the office's; without, the packing station's floor may print it too.
      ...(priced ? {} : { visibility: ['FLOOR'] as const, floorSiteId: shipment.siteId }),
    })
  }

  // The newest version holds these papers and nothing is to be printed: nothing to write.
  if (same && !printer) {
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      pack: { documentId: same.id, version: same.version, pages: await store.withClient((db) => pagesOf(db, shipment.id, same.id)), made: false, createdAt: toUtcIso(same.createdAt) },
      parts: parts.map(partView),
      job: null,
      problem,
    }
  }

  const { result } = await command(store, { name: 'shipping.packMade', idempotencyKey, input: { shipmentId, fingerprint, ...body } }, async (tools) => {
    const { tx, audit, emit, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.shipment-pack', ${tenantOf(context)}::uuid, ${shipment.id}::uuid), 0))`
    const last = (await versionsOf(tx, shipment.id))[0]
    let document: { id: string; version: number; fileId: string; createdAt: string; made: boolean }
    if (last && last.fingerprint === fingerprint) {
      // Made a moment ago by another request: with nothing to print there is nothing to write (every write is audited).
      if (!printer) throw refused('The pack was made a moment ago: look again.')
      document = { id: last.id, version: last.version, fileId: last.fileId, createdAt: toUtcIso(last.createdAt), made: false }
    }
    else {
      if (!prepared) throw refused('The papers changed while the pack was being made: make it again.')
      const file = await recordGeneratedFile(tools, prepared, { details: { documentType: PACK_KIND, number: shipment.number } })
      const id = newId()
      const version = (last?.version ?? 0) + 1
      await tx.generatedDocument.create({
        data: { id, companyId: shipment.companyId, siteId: shipment.siteId, recordType: 'Shipment', recordId: shipment.id, kind: PACK_KIND, version, fingerprint, language, number: shipment.number, fileId: file.id, createdById: context.audience === 'office' ? context.actorId : null },
        select: { id: true },
      })
      audit({
        action: 'shipping.packMade',
        recordType: 'Shipment',
        recordId: shipment.id,
        companyId: shipment.companyId,
        siteId: shipment.siteId,
        after: { documentId: id, version, fileId: file.id, fingerprint, pages, parts: pagesPerPart, priced, ...(context.audience === 'floor' ? { deviceId: context.deviceId, workerId: context.actorId } : {}) },
      })
      emit({ type: 'shipping.pack_made', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, documentId: id, version, pages: pages ?? 1 } })
      document = { id, version, fileId: file.id, createdAt: toUtcIso(now), made: true }
    }
    let job: { jobId: string; printerId: string; status: 'QUEUED' } | null = null
    if (printer) {
      const current = await tx.printer.findUnique({ where: { id: printer.id }, select: { status: true } })
      if (current?.status !== 'ACTIVE') throw refused(`The printer ${printer.code} takes no jobs now.`, 'PRINTER')
      const jobId = newId()
      const copies = body.copies ?? 1
      await tx.printJob.create({
        data: {
          id: jobId,
          companyId: printer.companyId,
          siteId: printer.siteId,
          printerId: printer.id,
          recordType: 'Shipment',
          recordId: shipment.id,
          payloadKind: 'PDF',
          fileId: document.fileId,
          copies,
          ...(context.audience === 'office' ? { requestedById: context.actorId, createdById: context.actorId } : {}),
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      audit({ recordType: 'PrintJob', recordId: jobId, companyId: printer.companyId, siteId: printer.siteId, after: { printerId: printer.id, recordType: 'Shipment', recordId: shipment.id, payloadKind: 'PDF', fileId: document.fileId, copies, documentId: document.id } })
      emit({ type: 'print.job_queued', subject: jobId, companyId: printer.companyId, siteId: printer.siteId, payload: { jobId, printerId: printer.id, payloadKind: 'PDF' } })
      job = { jobId, printerId: printer.id, status: 'QUEUED' }
    }
    return { document, job }
  })
  const shownPages = result.document.made ? pages : await store.withClient((db) => pagesOf(db, shipment.id, result.document.id))
  return {
    shipmentId: shipment.id,
    number: shipment.number,
    pack: { documentId: result.document.id, version: result.document.version, pages: shownPages, made: result.document.made, createdAt: result.document.createdAt },
    parts: parts.map(partView),
    job: result.job,
    problem,
  }
}

/** GET /shipping/shipments/:shipmentId/pack/pdf: the version's bytes (a priced pack only for the office that sees prices). */
export async function packPdf(files: FilesRuntime, callers: Callers, shipmentId: string, query: { version?: number | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { context, shipment } = await packerShipment(callers.caller, shipmentId)
  const store = storeCallerOf(callers, context)
  const seesPrices = seesPricesOf(context)
  // A pack shared with the floor has no price; one kept for the office only is read by one who sees prices. Without a version
  // named, the newest the caller may read.
  const found = await store.withClient(async (db) => {
    const versions = (await versionsOf(db, shipment.id)).filter((entry) => query.version === undefined || entry.version === query.version)
    for (const version of versions) {
      const file = await db.storedFile.findFirst({ where: { id: version.fileId, status: 'AVAILABLE' }, select: FILE })
      if (file && (seesPrices || file.visibility.includes('FLOOR'))) return { version, file }
      if (file && query.version !== undefined) throw new ForbiddenError('This pack shows prices.')
    }
    return null
  })
  if (!found) throw new NotFoundError(query.version === undefined ? 'The shipment has no pack yet: make it first.' : 'Pack version not found.')
  const pdf = await files.storage.read(store, found.file.storeAccountId, found.file.storageKey, PACK_MAX_BYTES * 2)
  if (!pdf) throw refused('The pack is missing from the file store: make it again.')
  return { pdf, fileName: `${shipment.number.replace(/[\\/]/g, '-')} documents v${found.version.version}.pdf` }
}
