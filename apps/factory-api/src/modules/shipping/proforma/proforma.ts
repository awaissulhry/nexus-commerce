import { DomainError, ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { SHIPPING_PROFORMA_ISSUE } from '@nexus/factory-domain/shipping/proforma/permissions'
import { PROFORMA_KIND, proformaDocument, proformaFingerprint, proformaSourceProblems, type ProformaRecordType } from '@nexus/factory-domain/shipping/proforma/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { proformaFactsOf, type ProformaFacts, type SampleValue } from './facts'

/**
 * The proforma invoice (B-W2b-391; LOG-058; factory-domain shipping/proforma/rules.ts). Office only, shipping.proforma.issue
 * on the record's company (and party), and the price grain (a proforma prints prices):
 *
 *   GET  /shipping/proformas?recordType&recordId   the record's PROFORMA number (once taken) and its versions, newest first
 *   POST /shipping/proformas                       a version of the record's proforma: the facts read and composed; the same
 *                                                  contents and language as the newest give it back (200, made false); else
 *                                                  the record's number (taken ONCE: command `shipping.proformaNumber`,
 *                                                  allocateNumber of the company's PROFORMA series, under the record's lock),
 *                                                  the PDF painted and put in the store OUTSIDE any transaction, then ONE
 *                                                  command `shipping.proformaMade`: the StoredFile (office and the record's
 *                                                  customer), the GeneratedDocument PROFORMA (the number as allocated: the
 *                                                  database checks it), audit on the record, shipping.proforma_made (201)
 *
 * A proforma is not a tax document (the PDF says so) and changes nothing on its record. Refusals are 409 in words.
 */

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const refused = (message: string) => new DomainError('conflict', message, [{ path: 'refusal/PROFORMA', message }])

/** The record's facts, the caller allowed on it (404 out of its reach, 403 without the permission or the price grain). */
async function factsFor(caller: CommandCaller, recordType: ProformaRecordType, recordId: string, asked: SampleValue = {}): Promise<{ context: OfficeContext; facts: ProformaFacts }> {
  const context = officeOf(caller)
  const facts = await caller.withClient((db) => proformaFactsOf(db, recordType, recordId, asked))
  const scope = { companyId: facts.companyId, partyId: facts.partyId, ...(facts.siteId ? { siteId: facts.siteId } : {}) }
  if (!can(actorOf(context), SHIPPING_PROFORMA_ISSUE, scope)) throw new ForbiddenError()
  if (!holds(actorOf(context), 'money.price')) throw new ForbiddenError('A proforma shows prices: it needs the price grain.')
  return { context, facts }
}

const VERSION = { id: true, version: true, number: true, language: true, fingerprint: true, fileId: true, createdAt: true, createdById: true } as const

const versionsOf = (db: CommandTx, recordType: ProformaRecordType, recordId: string) =>
  db.generatedDocument.findMany({ where: { recordType, recordId, kind: PROFORMA_KIND }, select: VERSION, orderBy: { version: 'desc' } })

const allocationOf = (db: CommandTx, recordType: ProformaRecordType, recordId: string) =>
  db.numberAllocation.findFirst({ where: { kind: PROFORMA_KIND, recordType, recordId }, select: { formatted: true } })

type VersionRow = Awaited<ReturnType<typeof versionsOf>>[number]

const viewOf = (row: VersionRow, current: boolean, names: ReadonlyMap<string, string>) => ({
  documentId: row.id,
  version: row.version,
  number: row.number ?? '',
  language: (isDocumentLanguage(row.language) ? row.language : 'it') as DocumentLanguage,
  fileId: row.fileId,
  createdAt: toUtcIso(row.createdAt),
  createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
  current,
})

async function namesOf(db: CommandTx, rows: readonly VersionRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.createdById ? [row.createdById] : [])))]
  return new Map((ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** GET /shipping/proformas. */
export async function listProformas(caller: CommandCaller, query: { recordType: ProformaRecordType; recordId: string }) {
  const { facts } = await factsFor(caller, query.recordType, query.recordId)
  return caller.withClient(async (db) => {
    const rows = await versionsOf(db, query.recordType, query.recordId)
    const names = await namesOf(db, rows)
    const allocation = await allocationOf(db, query.recordType, query.recordId)
    return {
      recordType: query.recordType,
      recordId: query.recordId,
      label: facts.label,
      purpose: facts.source.purpose,
      number: allocation?.formatted ?? null,
      versions: rows.map((row, index) => viewOf(row, index === 0, names)),
      problems: [...facts.problems, ...proformaSourceProblems(facts.source)],
    }
  })
}

export interface MakeProformaBody extends SampleValue {
  readonly recordType: ProformaRecordType
  readonly recordId: string
  readonly language?: DocumentLanguage | undefined
  readonly notes?: string | undefined
}

const lockRecord = (tx: CommandTx, recordType: string, recordId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.proforma', ${recordType}::text, ${recordId}::uuid), 0))`

/** POST /shipping/proformas. */
export async function makeProforma(files: FilesRuntime, caller: CommandCaller, body: MakeProformaBody, idempotencyKey?: string) {
  const { recordType, recordId } = body
  const { context, facts } = await factsFor(caller, recordType, recordId, { unitValue: body.unitValue, currency: body.currency })
  const problems = [...facts.problems, ...proformaSourceProblems(facts.source)]
  if (problems.length > 0) throw refused(problems.join(' '))
  const company = await companyLegalOf(caller, facts.companyId)
  const letterhead = legalProblems(company)
  if (letterhead.length > 0) throw refused(letterhead.length === 1 ? letterhead[0]!.message : "The company's letterhead is not complete: the proforma cannot be printed.")
  const language = body.language ?? facts.source.language
  const date = businessDate(serverClock.now())

  // The record's number: the one it has, else taken now (once per record and kind).
  let number = (await caller.withClient((db) => allocationOf(db, recordType, recordId)))?.formatted ?? null
  if (number === null) {
    const { result } = await command(caller, { name: 'shipping.proformaNumber', ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:number` } : {}), input: { recordType, recordId } }, async (tools) => {
      await lockRecord(tools.tx, recordType, recordId)
      const taken = await allocationOf(tools.tx, recordType, recordId)
      if (taken) return { number: taken.formatted }
      const issued = await allocateNumber(tools, { companyId: facts.companyId, kind: PROFORMA_KIND }, { type: recordType, id: recordId, date })
      tools.audit({ action: 'shipping.proformaNumber', recordType, recordId, companyId: facts.companyId, ...(facts.siteId ? { siteId: facts.siteId } : {}), after: { number: issued.formatted } })
      return { number: issued.formatted }
    })
    number = result.number
  }

  const document = proformaDocument({ ...facts.source, language, number, date, notes: body.notes ?? null })
  const fingerprint = proformaFingerprint(document)
  const newest = (await caller.withClient((db) => versionsOf(db, recordType, recordId)))[0]
  const names = new Map<string, string>()
  if (newest && newest.fingerprint === fingerprint && newest.language === language) return { status: 200 as const, proforma: { ...viewOf(newest, true, names), made: false } }

  const composed = composeDocument({ ...document, company, sample: false })
  const pdf = await renderDocumentPdf(composed)
  const prepared = await putGeneratedFile(files, caller, {
    companyId: facts.companyId,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    originalName: documentFileName(composed),
    contentType: 'application/pdf',
    body: pdf,
    // The customer it is made for may read it (a portal or a link carries it); never the floor.
    visibility: ['OFFICE', 'PARTNER'],
    partyId: facts.partyId,
  })
  const { result } = await command(caller, { name: 'shipping.proformaMade', idempotencyKey, input: { ...body, fingerprint } }, async (tools) => {
    const { tx, audit, emit, now } = tools
    await lockRecord(tx, recordType, recordId)
    const last = (await versionsOf(tx, recordType, recordId))[0]
    if (last && last.fingerprint === fingerprint && last.language === language) return { status: 200 as const, view: viewOf(last, true, new Map()), createdById: last.createdById, made: false }
    const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'PROFORMA', number, layout: composed.layout, language } })
    const id = newId()
    const version = (last?.version ?? 0) + 1
    const row = await tx.generatedDocument.create({
      data: { id, companyId: facts.companyId, siteId: facts.siteId, recordType, recordId, kind: PROFORMA_KIND, version, fingerprint, language, layout: composed.layout, number, fileId: file.id, createdAt: now, createdById: context.actorId },
      select: VERSION,
    })
    audit({
      action: 'shipping.proformaMade',
      recordType,
      recordId,
      companyId: facts.companyId,
      ...(facts.siteId ? { siteId: facts.siteId } : {}),
      after: { documentId: id, version, number, language, layout: composed.layout, fileId: file.id, fingerprint, purpose: facts.source.purpose, lines: document.lines.length },
    })
    emit({ type: 'shipping.proforma_made', subject: recordId, companyId: facts.companyId, ...(facts.siteId ? { siteId: facts.siteId } : {}), payload: { recordType, recordId, documentId: id, number, version } })
    return { status: 201 as const, view: viewOf(row, true, new Map()), createdById: row.createdById, made: true }
  })
  const shown = result.createdById ? await caller.withClient((db) => db.user.findUnique({ where: { id: result.createdById! }, select: { displayName: true } })) : null
  return { status: result.status, proforma: { ...result.view, createdBy: shown?.displayName ?? null, made: result.made } }
}
