import { createHash } from 'node:crypto'
import {
  packContents,
  packFileName,
  packFingerprintText,
  packLocaleOf,
  packPaper,
  packRefusals,
  packWarnings,
  sumsText,
  type ContentsEntry,
  type PackBatch,
  type PackDocument,
  type PackFacts,
  type PackStyle,
} from '@nexus/factory-domain/compliance/declarations/pack'
import { DECLARATIONS_PACK } from '@nexus/factory-domain/compliance/declarations/permissions'
import { formatPublicDocCode, publicDocAddress, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { ConflictError, DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { certificateFor, certificateValidOn } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { DOCUMENT_RETENTION_YEARS } from '@nexus/factory-domain/product/compliance/rules'
import type { CommandCaller } from '../../../core/command'
import { processEmail } from '../../../platform/email-out/service'
import { putGeneratedFile, recordGeneratedFile, retainFilesInCommand, tenantOf } from '../../../platform/files/files'
import { addYears } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { writeZip } from '../../accounting/guest/zip'
import { readDocuments } from '../../shipping/documents/read'
import { officeShipment } from '../../shipping/shipments/shipments'
import type { ShipmentHeader } from '../../shipping/store'
import { insertRecords, lockShipmentRecords, travelledRecords } from './batches'
import { declarationsClock, declarationsCommand, namesFor, officeOf, refused, todayOf, type Reader } from './common'
import { certificateFactsOf, coveringCertificates } from './facts'
import { renderPack } from './pdf'

/**
 * The shipment compliance pack (B-W2b-257; PRD-300; Reg. (EU) 2016/425 art. 8(8), art. 10): what travels with the PPE garments
 * of one shipment — per style and the revision its work orders froze, the signed DoC and leaflet shipping chose in the buyer's
 * language (B-W1-49), the certificate in summary (the one the DoC cites when valid on the day, else one covering the style;
 * B-W2b-178's rule) and the batches with the public DoC address their labels' QR holds (B-W2b-166) — as ONE PDF (the summary,
 * kept: GeneratedDocument COMPLIANCE_PACK of the Shipment, B-W2b-218) and ONE ZIP (that PDF, each document's PDF as stored and
 * SHA256SUMS.txt; written on demand from the version's contents, each file checked against its kept SHA-256). Only signed
 * documents travel: a generated draft never does before GATE-PPE-TEXTS.
 *
 *   GET  /compliance/declarations/shipments/:id/pack                    what the pack holds now, why it cannot be built, its versions
 *   POST /compliance/declarations/shipments/:id/pack {share?}          a new version (or the newest again when the same): outside
 *        the transaction each document's bytes are read and checked, the PDF painted and stored; then ONE command under
 *        `factory.compliance-pack|<tenant>|<shipment>`: the file, the GeneratedDocument, the versions by batch it carried
 *        (ComplianceDocumentBatch, as batches.ts records them), the audit row on the Shipment (with the contents the ZIP is
 *        written from) and compliance_declarations.pack_made. `share`: the PDF is shared with the shipment's party (its
 *        portal and the shipment's document link list it, as the DoC copies of B-W1-49).
 *   GET  …/pack/:documentId/pdf | /zip                                  one version's PDF (inline) or ZIP (attachment)
 *
 * Reading needs shipping.view on the shipment; building compliance.declarations.pack. Never a price, a cost or a pay figure.
 */

const KIND = 'COMPLIANCE_PACK' as const
const RECORD = 'Shipment'
const LAYOUT = 'compliance-pack.1'
const ACTION = 'compliance.declarations.pack'
/** The documents a pack may hold and the bytes of its ZIP (the files platform's largest file, 25 MiB). */
const DOCUMENTS_MAX = 200
const ZIP_MAX_BYTES = 25 * 1024 * 1024
const PAGE_WORDS = { it: 'pagina {page} di {pages}', en: 'page {page} of {pages}' } as const

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/** Every fact of a shipment's pack, as the domain's rules read them, and what blocks it. */
export async function readPackFacts(db: Reader, shipment: ShipmentHeader): Promise<{ facts: PackFacts; blockers: string[] }> {
  const { facts: shipping, documents, order } = await readDocuments(db, shipment)
  const day = shipment.shippedAt ? businessDate(shipment.shippedAt) : todayOf()
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { workOrderId: true, quantity: true } })
  const orders = await db.workOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.workOrderId))] } }, select: { id: true, styleId: true, styleRevisionId: true, batchNumber: true } })
  const revisionNumbers = new Map((await db.styleRevision.findMany({ where: { id: { in: orders.map((entry) => entry.styleRevisionId).filter((id): id is string => id !== null) } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
  const styleRows = new Map((await db.style.findMany({ where: { id: { in: shipping.styles.map((style) => style.styleId) } }, select: { id: true, ppeCategory: true } })).map((row) => [row.id, row]))
  const webOrigin = processEmail().webOrigin

  const styles: PackStyle[] = []
  for (const style of shipping.styles.filter((entry) => entry.documentsRequired)) {
    const own = documents.documents.filter((document) => document.style?.id === style.styleId && document.style.revision === style.revision && (document.kind === 'DECLARATION_OF_CONFORMITY' || document.kind === 'USER_INFORMATION'))
    const packDocuments: PackDocument[] = own
      .filter((document) => document.source !== null && document.documentId !== null)
      .map((document) => ({
        documentId: document.documentId!,
        kind: document.kind as PackDocument['kind'],
        language: document.language ?? '',
        revision: style.revision ?? 0,
        number: document.number,
        issuedAt: document.date,
        fallback: document.fallback,
        file: { id: document.source!.id, originalName: document.source!.originalName, sha256: document.source!.sha256, sizeBytes: document.source!.sizeBytes },
      }))
    // The certificate: the one the DoC cites when valid on the day, else one covering the style.
    const doc = packDocuments.find((document) => document.kind === 'DECLARATION_OF_CONFORMITY')
    const citedId = doc ? (await db.complianceDocument.findUnique({ where: { id: doc.documentId }, select: { certificateId: true } }))?.certificateId ?? null : null
    const covering = (await coveringCertificates(db, style.styleId)).map(certificateFactsOf)
    const citedRow = citedId ? (covering.find((entry) => entry.id === citedId) ?? null) : null
    const cited = citedRow ?? (citedId ? await db.certificate.findUnique({ where: { id: citedId }, select: { id: true, number: true, standard: true, ppeClass: true, notifiedBodyName: true, notifiedBodyNumber: true, notifiedBodyId: true, validFrom: true, validTo: true, status: true, statusChangedAt: true } }).then((row) => (row ? certificateFactsOf(row) : null)) : null)
    const chosen = certificateFor(cited, covering, day)
    const batches = new Map<string, PackBatch>()
    for (const order of orders.filter((entry) => entry.styleId === style.styleId && (entry.styleRevisionId ? (revisionNumbers.get(entry.styleRevisionId) ?? null) : null) === style.revision)) {
      if (!order.batchNumber) continue
      const garments = lines.filter((line) => line.workOrderId === order.id).reduce((sum, line) => sum + line.quantity, 0)
      const code = publicDocCodeOf(order.id)
      const before = batches.get(order.id)
      batches.set(order.id, { workOrderId: order.id, batchNumber: order.batchNumber, garments: (before?.garments ?? 0) + garments, publicDocAddress: publicDocAddress(webOrigin, code), publicDocCode: formatPublicDocCode(code) })
    }
    styles.push({
      styleId: style.styleId,
      code: style.code,
      name: style.name,
      revision: style.revision,
      category: styleRows.get(style.styleId)?.ppeCategory ?? 'CATEGORY_II',
      garments: style.garments,
      documents: packDocuments,
      certificate: chosen
        ? { id: chosen.id, number: chosen.number, standard: chosen.standard, ppeClass: chosen.ppeClass, bodyName: chosen.notifiedBodyName, bodyNumber: chosen.notifiedBodyNumber, validFrom: chosen.validFrom, validTo: chosen.validTo, validOnDay: certificateValidOn(chosen, day) }
        : null,
      batches: [...batches.values()].sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
    })
  }
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true, tradeName: true } })
  const company = await db.company.findUnique({ where: { id: shipment.companyId }, select: { legalName: true } })
  const facts: PackFacts = {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, shippedOn: shipment.shippedAt ? businessDate(shipment.shippedAt) : null },
    customer: party ? { name: party.tradeName ?? party.legalName } : null,
    order: order ? { number: order.number, customerRef: order.customerRef } : null,
    wantedLanguage: order?.language ?? null,
    day,
    styles,
    sender: company?.legalName ?? '',
  }
  return { facts, blockers: documents.blockers.flatMap((check) => check.problems.map((problem) => problem.message)) }
}

const VERSION_COLUMNS = { id: true, version: true, language: true, layout: true, number: true, fingerprint: true, fileId: true, companyId: true, createdAt: true, createdById: true } as const
const readVersions = (db: Reader, shipmentId: string) => db.generatedDocument.findMany({ where: { recordType: RECORD, recordId: shipmentId, kind: KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
type VersionRow = Awaited<ReturnType<typeof readVersions>>[number]

/** The contents a version was built from (its command's audit row on the Shipment). */
async function contentsOf(db: Reader, shipmentId: string, documentId: string): Promise<ContentsEntry[] | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: RECORD, recordId: shipmentId, action: ACTION, after: { path: ['generatedDocumentId'], equals: documentId } }, select: { after: true }, orderBy: { at: 'asc' } })
  const after = row?.after as { contents?: unknown } | null | undefined
  if (!after || !Array.isArray(after.contents)) return null
  return after.contents.filter((entry): entry is ContentsEntry => entry !== null && typeof entry === 'object' && typeof (entry as ContentsEntry).fileId === 'string' && typeof (entry as ContentsEntry).path === 'string' && typeof (entry as ContentsEntry).sha256 === 'string')
}

async function versionViews(db: Reader, shipmentId: string, rows: readonly VersionRow[]) {
  const names = await namesFor(db, rows.map((row) => row.createdById))
  const files = new Map((await db.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, originalName: true, sizeBytes: true, sha256: true, visibility: true } })).map((row) => [row.id, row]))
  const out = []
  for (const row of rows) {
    const file = files.get(row.fileId)
    const contents = await contentsOf(db, shipmentId, row.id)
    out.push({
      id: row.id,
      version: row.version,
      language: row.language,
      number: row.number,
      fingerprint: row.fingerprint,
      file: file ? { id: file.id, originalName: file.originalName, sizeBytes: file.sizeBytes, sha256: file.sha256 } : null,
      shared: file ? file.visibility.includes('PARTNER') || file.visibility.includes('LINK') : false,
      documents: contents?.length ?? 0,
      createdAt: toUtcIso(row.createdAt),
      createdBy: names(row.createdById),
    })
  }
  return out
}

const viewOfFacts = (facts: PackFacts) => ({
  shipment: { ...facts.shipment },
  customer: facts.customer,
  order: facts.order,
  wantedLanguage: facts.wantedLanguage,
  day: facts.day,
  styles: facts.styles.map((style) => ({ ...style, documents: style.documents.map((document) => ({ ...document, file: { ...document.file } })), certificate: style.certificate ? { ...style.certificate } : null, batches: style.batches.map((batch) => ({ ...batch })) })),
})

/** GET /compliance/declarations/shipments/:shipmentId/pack */
export async function packView(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient(async (db) => {
    const { facts, blockers } = await readPackFacts(db, shipment)
    const locale = packLocaleOf(facts.wantedLanguage)
    return {
      pack: {
        ...viewOfFacts(facts),
        locale,
        contents: packContents(facts, locale).map((entry) => ({ ...entry })),
        refusals: packRefusals(facts, blockers).map((problem) => ({ ...problem })),
        warnings: packWarnings(facts).map((problem) => ({ ...problem })),
        versions: await versionViews(db, shipment.id, await readVersions(db, shipment.id)),
      },
    }
  })
}

/** The bytes of a stored file, checked against its kept SHA-256 (null: missing, unreadable or changed). */
async function bytesOf(caller: CommandCaller, fileId: string, sha256: string): Promise<Buffer | null> {
  const row = await caller.withClient((db) => db.storedFile.findUnique({ where: { id: fileId }, select: { status: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true } }))
  if (!row || row.status !== 'AVAILABLE' || row.sha256 !== sha256) return null
  try {
    const body = await processFiles().storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes)
    return body && sha(body) === sha256 ? body : null
  } catch {
    return null
  }
}

/** POST /compliance/declarations/shipments/:shipmentId/pack {share?}: a new version of the pack (or the newest again). */
export async function makePack(caller: CommandCaller, shipmentId: string, body: { readonly share?: boolean | undefined }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const shipment = await officeShipment(caller, shipmentId, DECLARATIONS_PACK)
  const share = body.share === true
  const { facts, blockers } = await caller.withClient((db) => readPackFacts(db, shipment))
  const refusals = packRefusals(facts, blockers)
  if (refusals.length > 0) throw new DomainError('conflict', refusals.map((problem) => problem.message).join(' '), refusals.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.message })))
  const locale = packLocaleOf(facts.wantedLanguage)
  const contents = packContents(facts, locale)
  if (contents.length > DOCUMENTS_MAX) throw refused('conflict', { code: 'TOO_MANY', message: `A pack holds at most ${DOCUMENTS_MAX} documents; this one has ${contents.length}.` })
  const fingerprint = sha(`${packFingerprintText(facts, locale)}|shared:${share}`)
  const before = await caller.withClient((db) => readVersions(db, shipment.id))
  const answer = async (id: string, made: boolean) => {
    const rows = await caller.withClient((db) => readVersions(db, shipment.id))
    const [view] = await caller.withClient((db) => versionViews(db, shipment.id, rows.filter((row) => row.id === id)))
    return { status: made ? (201 as const) : (200 as const), pack: { version: view!, made } }
  }
  const same = before.find((row) => row.fingerprint === fingerprint)
  if (same && same.id === before[0]?.id) return answer(same.id, false)

  // Every document readable and unchanged: a pack never lists a file it could not verify.
  let total = 0
  for (const entry of contents) {
    const bytes = await bytesOf(caller, entry.fileId, entry.sha256)
    if (!bytes) throw refused('conflict', { code: 'FILE_UNREADABLE', message: `${entry.title}: its file could not be read from the store, or it changed. Try again; if it stays, upload the signed PDF again.` })
    total += bytes.length
  }
  if (total > ZIP_MAX_BYTES) throw refused('conflict', { code: 'TOO_LARGE', message: `The pack's documents hold ${Math.ceil(total / 1024 / 1024)} MiB; a pack holds at most 25 MiB.` })

  const version = (before[0]?.version ?? 0) + 1
  const number = `${shipment.number}/CP${version}`
  const createdAt = declarationsClock().now()
  const pdf = await renderPack(packPaper(facts, locale, contents, fingerprint, version), { language: locale, createdAt, pageWords: PAGE_WORDS[locale] })
  const file = await putGeneratedFile(processFiles(), caller, {
    companyId: shipment.companyId,
    recordType: RECORD,
    recordId: shipment.id,
    kind: 'DOCUMENT',
    originalName: `${packFileName(shipment.number, version, locale)}.pdf`,
    contentType: 'application/pdf',
    body: pdf,
    visibility: share ? ['OFFICE', 'PARTNER', 'LINK'] : ['OFFICE'],
    partyId: share ? shipment.partyId : null,
    retainUntil: addYears(createdAt, DOCUMENT_RETENTION_YEARS),
  })

  const { result } = await declarationsCommand(caller, { name: ACTION, idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.compliance-pack', ${tenantOf(context)}::uuid, ${shipment.id}::uuid), 0))`
    const versions = await readVersions(tx, shipment.id)
    if (versions[0] && versions[0].fingerprint === fingerprint) return { id: versions[0].id, made: false }
    if ((versions[0]?.version ?? 0) + 1 !== version) throw new ConflictError(`Another compliance pack of shipment ${shipment.number} was made meanwhile: build it again.`)
    const stored = await recordGeneratedFile(tools, file, { details: { documentType: KIND, number, language: locale, layout: LAYOUT } })
    const id = newId()
    await tx.generatedDocument.create({
      data: { id, companyId: shipment.companyId, siteId: shipment.siteId, recordType: RECORD, recordId: shipment.id, kind: KIND, version, fingerprint, language: locale, layout: LAYOUT, number, fileId: stored.id, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    // The documents it holds are kept as long as the pack (ten years, art. 8(3)).
    await retainFilesInCommand(tools, contents.map((entry) => entry.fileId), addYears(now, DOCUMENT_RETENTION_YEARS), 'Reg. (EU) 2016/425 art. 8(3): a document of a compliance pack is kept ten years.')
    // Which signed revision went with which batch of this shipment (PRD-295), recorded once.
    await lockShipmentRecords(tools, shipment.id)
    const { toMake } = await travelledRecords(tx, shipment)
    const recorded = await insertRecords(tools, toMake, shipment.id)
    tools.audit({
      action: ACTION,
      recordType: RECORD,
      recordId: shipment.id,
      companyId: shipment.companyId,
      after: { generatedDocumentId: id, version, number, language: locale, fingerprint, fileId: stored.id, shared: share, contents: contents.map((entry) => ({ ...entry })), batchRecords: recorded.length },
    })
    tools.emit({ type: 'compliance_declarations.pack_made', subject: shipment.id, companyId: shipment.companyId, payload: { shipmentId: shipment.id, generatedDocumentId: id, version, language: locale, documents: contents.length, shared: share } })
    return { id, made: true }
  })
  return answer(result.id, result.made)
}

/** A version of this shipment's pack, or not found. */
async function readVersion(caller: CommandCaller, shipmentId: string, documentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  const row = isUuid(documentId) ? await caller.withClient((db) => db.generatedDocument.findUnique({ where: { id: documentId }, select: { ...VERSION_COLUMNS, recordType: true, recordId: true, kind: true } })) : null
  if (!row || row.recordType !== RECORD || row.recordId !== shipment.id || row.kind !== KIND) throw new NotFoundError('There is no such compliance pack.')
  const file = await caller.withClient((db) => db.storedFile.findUnique({ where: { id: row.fileId }, select: { status: true, originalName: true, sha256: true } }))
  if (!file || file.status !== 'AVAILABLE') throw new NotFoundError('There is no such compliance pack.')
  return { shipment, row, file }
}

/** GET …/pack/:documentId/pdf */
export async function packPdf(caller: CommandCaller, shipmentId: string, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const { row, file } = await readVersion(caller, shipmentId, documentId)
  const pdf = await bytesOf(caller, row.fileId, file.sha256)
  if (!pdf) throw new DomainError('not_ready', 'The file store did not answer. Try again in a moment.')
  return { pdf, fileName: file.originalName }
}

/** GET …/pack/:documentId/zip: the version's PDF, its documents as stored and SHA256SUMS.txt (each checked again). */
export async function packZip(caller: CommandCaller, shipmentId: string, documentId: string): Promise<{ zip: Buffer; fileName: string }> {
  const { shipment, row, file } = await readVersion(caller, shipmentId, documentId)
  const contents = await caller.withClient((db) => contentsOf(db, shipment.id, row.id))
  if (!contents) throw new NotFoundError('There is no such compliance pack.')
  const pdf = await bytesOf(caller, row.fileId, file.sha256)
  if (!pdf) throw new DomainError('not_ready', 'The file store did not answer. Try again in a moment.')
  const pdfPath = `${file.originalName.replace(/[^\w. -]+/g, '-')}`
  const entries: { path: string; bytes: Uint8Array; sha256: string }[] = [{ path: pdfPath, bytes: pdf, sha256: file.sha256 }]
  for (const entry of contents) {
    const bytes = await bytesOf(caller, entry.fileId, entry.sha256)
    if (!bytes) throw refused('conflict', { code: 'FILE_UNREADABLE', message: `${entry.title}: its file could not be read from the store, or it changed since the pack was made.` })
    entries.push({ path: entry.path, bytes, sha256: entry.sha256 })
  }
  const sums = Buffer.from(sumsText(entries), 'utf8')
  const zip = writeZip([...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes })), { path: 'SHA256SUMS.txt', bytes: sums }], row.createdAt)
  return { zip, fileName: file.originalName.replace(/\.pdf$/i, '.zip') }
}
