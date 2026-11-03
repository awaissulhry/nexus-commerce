import { createHash } from 'node:crypto'
import { ConflictError, DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { fieldRuleOf, fieldWords, targetKey, valueWords, currentValue, standing, storedValue, correctionsOf, type AmendedRow } from '@nexus/factory-domain/quality/amendments/rules'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { IDENTITY_ENTRY, isSystemEntry } from '@nexus/factory-domain/quality/final/plan'
import { CHECKLIST_ITEMS, defectCounts } from '@nexus/factory-domain/quality/final/rules'
import { QUALITY_DOCUMENTS_MAKE } from '@nexus/factory-domain/quality/inspection-docs/permissions'
import { fingerprintText, inspectionReport, type DocumentPhoto, type ReportInput } from '@nexus/factory-domain/quality/inspection-docs/documents'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FilesRuntime } from '../../../platform/files/service'
import { readCells, readStyle } from '../../production/serials/store'
import { readAmendments, refsOf } from '../amendments/amendments'
import { causesOf, namesOf } from '../amendments/records'
import { readBinding, measurementsOf, resultsOf, RESULT_RECORD } from '../final/plan'
import { inspectionFor } from '../final/inspections'
import { officeOf } from '../final/access'
import { readDefects, readReleases, readReversals, type InspectionRow, type Reader } from '../final/store'
import { renderQualityDocument } from './pdf'
import { keepVersionInCommand, keptVersionView, prepareVersion, type DocumentRecord } from './versions'

/**
 * The inspection report of a signed final inspection (B-W2b-123; QHS-055; design quality.inspections row verb "Report PDF",
 * the new tab "Inspection report (PDF)": result, AQL table, checks, measurements, the serial or batch check, defects with
 * photos, signatures). Office only; quality.inspections.view over the inspection's company and site to read it,
 * quality.documents.make to keep a version.
 *
 *   GET  /quality/inspections/:inspectionId/report?language=    the PDF with the "preview" banner, made in memory
 *   GET  /quality/inspections/:inspectionId/reports             the versions kept, where each is shared, the shipments that
 *                                                               carry the inspection's goods, what holds a version
 *   POST /quality/inspections/:inspectionId/reports {language?} keeps a version (./versions.ts): same contents → the newest
 *
 * What it prints is what stands: the signed record with its SIGNED corrections (each marked [A1], listed with who asked
 * and who countersigned). No price, cost, margin or pay figure; a floor inspector or releaser is "the bench", never named
 * (the e-signature's SHA-256 is printed); a rider's profile never. The language: asked, else the work order's customers'
 * (Italian or English, when they share one), else Italian. The company's letterhead must be complete (c.c. art. 2250).
 * Photos: the results' AVAILABLE JPEG and PNG photos (at most 12, 4 MB each) are printed; the others are counted.
 */

export const REPORT_KIND = 'INSPECTION_REPORT' as const
const MAX_PHOTOS = 12
const MAX_PHOTO_BYTES = 4 * 1024 * 1024
const PRINTABLE = new Set(['image/jpeg', 'image/png'])

const refused = (issues: readonly Issue[], message: string) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : message, [...issues])

/** The inspection as the caller may reach it, signed (409 in words otherwise). */
export async function signedInspection(caller: CommandCaller, inspectionId: string) {
  officeOf(caller)
  const found = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_VIEW)
  if (found.inspection.status !== 'PASSED' && found.inspection.status !== 'FAILED') {
    throw new ConflictError(`This inspection is ${found.inspection.status}: a report is made of a signed result (passed or failed).`)
  }
  return found
}

/** The inspection as the record of its report's versions (the number printed: its own, else the work order's). */
export const reportRecordOf = (row: InspectionRow, workOrderNumber: string): DocumentRecord => ({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, number: row.number ?? `${workOrderNumber} · inspection` })

/** The report's language: asked, else the one the work order's customers share (it or en), else Italian. */
async function languageOf(db: Reader, workOrderId: string, asked: DocumentLanguage | undefined): Promise<DocumentLanguage> {
  if (asked) return asked
  const parties = [...new Set((await readCells(db, workOrderId)).map((cell) => cell.partyId))]
  const languages = parties.length === 0 ? [] : [...new Set((await db.party.findMany({ where: { id: { in: parties } }, select: { language: true } })).map((party) => party.language))]
  return languages.length === 1 && isDocumentLanguage(languages[0]) ? languages[0] : 'it'
}

interface PhotoFacts {
  readonly photos: DocumentPhoto[]
  readonly leftOut: number
  /** The rows to read the bytes of (id → store account and key). */
  readonly files: ReadonlyMap<string, { readonly storeAccountId: string; readonly storageKey: string; readonly sizeBytes: number; readonly sha256: string }>
}

/** The results' photos the report prints (and how many it leaves out), with their captions. */
async function photoFactsOf(db: Reader, results: readonly { readonly id: string; readonly caption: string }[]): Promise<PhotoFacts> {
  if (results.length === 0) return { photos: [], leftOut: 0, files: new Map() }
  const rows = await db.storedFile.findMany({
    where: { recordType: RESULT_RECORD, recordId: { in: results.map((result) => result.id) }, kind: 'PHOTO', status: { notIn: ['DELETED', 'PENDING_UPLOAD'] } },
    select: { id: true, recordId: true, status: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const caption = new Map(results.map((result) => [result.id, result.caption]))
  const printable = rows.filter((row) => row.status === 'AVAILABLE' && PRINTABLE.has(row.contentType) && row.sizeBytes <= MAX_PHOTO_BYTES).slice(0, MAX_PHOTOS)
  return {
    photos: printable.map((row) => ({ fileId: row.id, sha256: row.sha256, caption: caption.get(row.recordId) ?? '' })),
    leftOut: rows.length - printable.length,
    files: new Map(printable.map((row) => [row.id, { storeAccountId: row.storeAccountId, storageKey: row.storageKey, sizeBytes: row.sizeBytes, sha256: row.sha256 }])),
  }
}

/** The photos' bytes, each checked against its SHA-256 (a photo the store cannot give, or that does not match, is left out). */
async function photoBytes(files: FilesRuntime, caller: CommandCaller, facts: PhotoFacts): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const [id, file] of facts.files) {
    try {
      const body = await files.storage.read(caller, file.storeAccountId, file.storageKey, file.sizeBytes)
      if (body && createHash('sha256').update(body).digest('hex') === file.sha256) out.set(id, body)
    } catch {
      // Left out of the PDF: its caption still says which check it was.
    }
  }
  return out
}

/** Everything the report prints, read with the office caller's client. */
async function reportInputOf(db: Reader, inspection: InspectionRow, header: { readonly id: string; readonly number: string; readonly batchNumber: string | null; readonly styleId: string; readonly styleRevisionId: string | null }, options: { readonly language: DocumentLanguage; readonly sample: boolean; readonly company: ReportInput['company'] }) {
  const { language } = options
  const corrections = correctionsOf(await readAmendments(db, 'Inspection', inspection.id))
  const now = standing(corrections)
  const refs = refsOf(corrections)
  const amendedRefs = (key: string): number[] => (now.has(key) ? [refs.get(now.get(key)!.requestId)!].filter((ref) => ref !== undefined) : [])
  const value = (own: string | null, field: string, row: { type: AmendedRow; id: string } | null): string | null => currentValue(own, now, targetKey(field, row))

  const style = await readStyle(db, header.styleId)
  const revision = header.styleRevisionId ? ((await db.styleRevision.findUnique({ where: { id: header.styleRevisionId }, select: { revision: true } }))?.revision ?? null) : null

  // The checks: the plan's results (their value and note as they stand), or W1's fixed checklist.
  let checks: ReportInput['checks'] = null
  let plan: string | null = null
  const photoCaptions: { id: string; caption: string }[] = []
  let measurements: ReportInput['measurements'] = []
  if (inspection.planVersionId) {
    const binding = await readBinding(db, inspection.planVersionId)
    plan = `${binding.plan.code} v${binding.version.number}`
    const results = await resultsOf(db, inspection.id)
    checks = binding.checks
      .filter((check) => check.type !== 'INSTRUCTION')
      .map((check) => ({
        code: check.code,
        label: language === 'it' ? check.labelIt : check.labelEn,
        checkClass: check.checkClass,
        results: results
          .filter((result) => result.planCheckId === check.id)
          .map((result) => {
            const row = { type: 'InspectionCheckResult' as const, id: result.id }
            photoCaptions.push({ id: result.id, caption: `${check.code} · ${language === 'it' ? 'capo' : 'unit'} ${result.sampleIndex}` })
            return {
              unit: result.sampleIndex,
              outcome: result.outcome as 'PASS' | 'FAIL' | 'NOT_APPLICABLE',
              value: value(result.value, 'value', row),
              note: value(result.note, 'note', row),
              amended: [...amendedRefs(targetKey('value', row)), ...amendedRefs(targetKey('note', row))],
            }
          }),
      }))
      .filter((check) => check.results.length > 0)
  }
  measurements = (await measurementsOf(db, inspection.id)).map((row) => {
    const ref = { type: 'InspectionMeasurement' as const, id: row.id }
    return {
      pointCode: row.pointCode,
      size: row.size,
      unit: row.sampleIndex,
      nominal: row.nominal.toFixed(3),
      tolerance: row.tolerance.toFixed(3),
      measured: value(row.measured.toFixed(3), 'measured', ref) ?? row.measured.toFixed(3),
      uom: row.uom as Uom,
      pass: row.pass,
      amended: amendedRefs(targetKey('measured', ref)),
    }
  })
  const entries = Array.isArray(inspection.checklist) ? (inspection.checklist as { code?: unknown; ok?: unknown; note?: unknown; mode?: unknown }[]) : []
  const words = new Map<string, string>(CHECKLIST_ITEMS.map((item) => [item.code, item.words]))
  const checklist = inspection.planVersionId
    ? []
    : entries
        .filter((entry) => typeof entry?.code === 'string' && !isSystemEntry(entry.code))
        .map((entry) => {
          const field = `checklist.${entry.code as string}.note`
          return { code: entry.code as string, label: words.get(entry.code as string) ?? (entry.code as string), ok: typeof entry.ok === 'boolean' ? entry.ok : null, note: value(typeof entry.note === 'string' ? entry.note : null, field, null), amended: amendedRefs(targetKey(field, null)) }
        })
  const identityEntry = entries.find((entry) => entry?.code === IDENTITY_ENTRY)
  const identity = identityEntry ? { mode: identityEntry.mode === 'SERIAL' ? ('SERIAL' as const) : ('BATCH' as const), ok: typeof identityEntry.ok === 'boolean' ? identityEntry.ok : null, words: typeof identityEntry.note === 'string' ? identityEntry.note : '' } : null

  const causes = (await causesOf(db, language)).words
  const defectRows = await readDefects(db, [inspection.id])
  const causeIds = await db.inspectionDefect.findMany({ where: { inspectionId: inspection.id }, select: { id: true, causeCodeId: true } })
  const causeOf = new Map(causeIds.map((row) => [row.id, row.causeCodeId]))
  const defects = defectRows.map((row) => {
    const ref = { type: 'InspectionDefect' as const, id: row.id }
    const cause = value(causeOf.get(row.id) ?? null, 'causeCodeId', ref)
    return {
      defectClass: row.defectClass as 'CRITICAL' | 'MAJOR' | 'MINOR',
      code: row.code,
      zone: value(row.zone, 'zone', ref),
      quantity: row.quantity,
      description: value(row.description, 'description', ref),
      note: value(row.note, 'note', ref),
      cause: cause ? (causes.get(cause) ?? null) : null,
      amended: ['zone', 'description', 'note', 'causeCodeId'].flatMap((field) => amendedRefs(targetKey(field, ref))),
      zoneAmended: amendedRefs(targetKey('zone', ref)),
    }
  })

  const releases = await readReleases(db, { inspectionId: inspection.id })
  const reversals = releases.length === 0 ? [] : await readReversals(db, { releaseId: { in: releases.map((release) => release.id) } })
  const signedCorrections = corrections.filter((entry) => entry.state === 'SIGNED').sort((a, b) => refs.get(a.request.id)! - refs.get(b.request.id)!)
  const names = await namesOf(db, [inspection.inspectorUserId, ...releases.map((release) => release.releasedById), ...signedCorrections.flatMap((entry) => [entry.request.signedById, entry.answer!.signedById])])
  const amendments = signedCorrections.map((entry) => {
    const rowType = (entry.request.recordType as AmendedRow | null) ?? null
    const field = entry.request.field ?? ''
    const rule = fieldRuleOf('Inspection', field, rowType)
    const kind = rule?.kind ?? 'text'
    return {
      ref: refs.get(entry.request.id)!,
      field: rule ? fieldWords('Inspection', field, rowType, language) : field,
      from: valueWords(kind, storedValue(entry.request.before), language, causes),
      to: valueWords(kind, storedValue(entry.request.after), language, causes),
      reason: entry.request.reason ?? '',
      askedBy: names.get(entry.request.signedById) ?? '-',
      signedBy: names.get(entry.answer!.signedById) ?? '-',
      signedOn: businessDate(entry.answer!.signedAt),
    }
  })

  const noteRef = targetKey('note', null)
  const input: Omit<ReportInput, 'photos' | 'photosLeftOut'> = {
    language,
    date: businessDate(serverClock.now()),
    company: options.company,
    inspection: {
      number: inspection.number ?? `${header.number} · inspection`,
      status: inspection.status as 'PASSED' | 'FAILED',
      computedResult: (inspection.computedResult as 'PASS' | 'FAIL' | null) ?? null,
      overrideReason: inspection.overrideReason,
      decidedOn: businessDate(inspection.decidedAt ?? inspection.updatedAt),
      signatureSha256: inspection.signatureSha256,
      note: value(inspection.note, 'note', null),
      noteAmended: amendedRefs(noteRef),
    },
    workOrder: { number: header.number, batchNumber: header.batchNumber, style: { code: style?.code ?? '-', name: style?.name ?? '-', revision } },
    sampling: {
      lotSize: inspection.lotSize,
      sampleSize: inspection.sampleSize,
      inspectionLevel: inspection.inspectionLevel,
      codeLetter: inspection.codeLetter,
      aqlMajor: inspection.aqlMajor.toString(),
      aqlMinor: inspection.aqlMinor.toString(),
      acceptMajor: inspection.acceptMajor,
      acceptMinor: inspection.acceptMinor,
      plan,
    },
    counts: defectCounts(defectRows),
    inspector: inspection.inspectorUserId ? (names.get(inspection.inspectorUserId) ?? null) : null,
    checks,
    checklist,
    measurements,
    identity,
    defects,
    releases: releases
      .slice()
      .sort((a, b) => a.releasedAt.getTime() - b.releasedAt.getTime() || (a.number ?? '').localeCompare(b.number ?? ''))
      .map((release) => ({
        number: release.number ?? '-',
        garments: release.quantity,
        reversed: reversals.filter((reversal) => reversal.releaseId === release.id).reduce((sum, reversal) => sum + reversal.quantity, 0),
        releasedOn: businessDate(release.releasedAt),
        by: release.releasedById ? (names.get(release.releasedById) ?? null) : null,
      })),
    amendments,
    sample: options.sample,
  }
  return { input, photoFacts: await photoFactsOf(db, photoCaptions) }
}

/** The report composed, its photos' bytes and its PDF painter. */
async function composeReport(files: FilesRuntime | null, caller: CommandCaller, inspectionId: string, options: { readonly language?: DocumentLanguage | undefined; readonly sample: boolean }) {
  const { inspection, header } = await signedInspection(caller, inspectionId)
  const legal = await companyLegalOf(caller, inspection.companyId)
  const problems = legalProblems(legal)
  if (problems.length > 0) throw refused(problems, 'The inspection report cannot be made as the company stands.')
  const { language, input, photoFacts } = await caller.withClient(async (db) => {
    const language = await languageOf(db, header.id, options.language)
    const company = { name: legalName(legal, language), lines: legalLines(legal, language), legal: legalFooter(legal, language) }
    return { language, ...(await reportInputOf(db, inspection, header, { language, sample: options.sample, company })) }
  })
  const document = inspectionReport({ ...input, photos: photoFacts.photos, photosLeftOut: photoFacts.leftOut })
  const render = async () => renderQualityDocument(document, files ? await photoBytes(files, caller, photoFacts) : new Map())
  return { inspection, header, language, document, render }
}

/** GET …/report: the PDF as it would be kept, with the preview banner (photos printed as they will be). */
export async function previewReport(files: FilesRuntime, caller: CommandCaller, inspectionId: string, query: { readonly language?: DocumentLanguage | undefined }) {
  const composed = await composeReport(files, caller, inspectionId, { language: query.language, sample: true })
  return { pdf: await composed.render(), fileName: composed.document.fileName }
}

/** POST …/reports: keeps a version (see the file's comment). */
export async function makeReport(files: FilesRuntime, caller: CommandCaller, inspectionId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  officeOf(caller)
  await inspectionFor(caller, inspectionId, QUALITY_DOCUMENTS_MAKE)
  const composed = await composeReport(files, caller, inspectionId, { language: body.language, sample: false })
  const record = reportRecordOf(composed.inspection, composed.header.number)
  const prepared = await prepareVersion(files, caller, record, REPORT_KIND, { fingerprintText: fingerprintText(composed.document), language: composed.language, fileName: composed.document.fileName, render: composed.render })
  const kept = prepared.current
    ? { ...prepared.current, made: false }
    : (
        await command(caller, { name: 'quality.keepInspectionReport', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
          const version = await keepVersionInCommand(tools, record, REPORT_KIND, prepared)
          if (version.made) {
            tools.emit({ type: 'inspection_report.made', subject: inspectionId, companyId: record.companyId, siteId: record.siteId, payload: { inspectionId, workOrderId: composed.inspection.workOrderId, number: record.number, documentId: version.id, version: version.version, language: prepared.language } })
          }
          return version
        })
      ).result
  return { report: await keptVersionView(caller, record, REPORT_KIND, kept.id), made: kept.made }
}
