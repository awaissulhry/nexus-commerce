import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { composeDocument, documentProblems } from '@nexus/factory-domain/documents/compose'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import {
  draftSourceDdt,
  SOURCE_DDT_REASONS,
  sourceDdtDocument,
  sourceIssueStateProblems,
  type SourceDdtDraft,
  type SourceDdtFacts,
  type SourceDdtRequest,
} from '@nexus/factory-domain/shipping/ddt/sources'
import { SHIPPING_DDT_ISSUE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import type { FileView } from '../../../platform/files/contract'
import type { FilesRuntime } from '../../../platform/files/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, officeContextOf } from '../access'
import { printSafely } from './ddt'
import { lockSource, readSource, readSourceFacts, sourceDdtView, type SourceDdtRow, type SourceDdtView, type SourceHeader, type SourceRef } from './sources-store'
import { expectedDdtNumber, readAnyDdt } from './store'

/**
 * A DDT for another reason (B-W2a-17; LOG-056; DPR 472/1996): the goods of a source record travel without a sales
 * shipment, with a DDT of the company's same series (factory-domain shipping/ddt/sources has the rules). Office only.
 *
 *   preview   what the DDT would say now, every problem, the number it would probably take, and each of the source's
 *             goods with why it cannot travel now (held) and the live DDT it travels with: nothing is used
 *   issue     ONE command: the SOURCE's row locked (FOR UPDATE, never bumped: a CLOSED RMA or a SHIPPED repair never
 *             changes), its facts read under the lock, the state and every field checked, THEN the number from the
 *             company's DDT series (allocateNumber, the series row locked in the same transaction: a refusal or a
 *             rollback uses no number), the frozen Ddt row (shipmentId null, sourceType and sourceId), the kit and claim
 *             lines it carries pointed at it, the audit rows and ddt.source_issued. After the commit the PDF (W1's
 *             ensurePdf: FISCAL_ARCHIVE, shared with the site's floor); a file store failure leaves the DDT issued
 *             (POST /shipping/ddts/:ddtId/pdf prints it again).
 *
 * The other flows issue it inside their own command with issueSourceDdtInCommand (B-W2a-25 kit send, B-W2a-44 return to
 * a supplier, B-W2a-57 a repair's way back, B-W2a-43 returned goods sent back): they post their stock moves and move
 * their own record first, then call it, then print with printSourceDdt after their commit. This step moves no stock and
 * no source state.
 */

/** What the routes pass: the request, the source's version as read (checked, never bumped) and a note for the office. */
export interface SourceIssueBody extends SourceDdtRequest {
  readonly version?: number | undefined
  readonly internalNote?: string | null | undefined
}

const issues = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The DDT cannot be issued as it stands.', problems)

const day = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

/** The JSON of a draft for the Ddt row (Prisma's JSON input: plain objects, no undefined). */
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The layout's own check of the DDT (factory-domain documents), before a number is taken: a bug guard. */
function layoutProblems(draft: SourceDdtDraft, facts: SourceDdtFacts): Issue[] {
  return documentProblems({ ...sourceDdtDocument({ ...draft, number: 'DDT' }, facts.language, facts.company.currency), company: facts.company })
}

/** The draft as the preview shows it. */
const draftView = (draft: SourceDdtDraft) => ({
  ...draft,
  lines: draft.lines.map((line) => ({ ...line, serials: [...line.serials] })),
  documentRefs: draft.documentRefs.map((reference) => ({ ...reference, date: reference.date ?? null })),
})

const sourceState = (header: SourceHeader) => ({ type: header.type, id: header.id, number: header.number, state: header.state, version: header.version })

/** The source the office may see (else 404) and act on with `permission` (else 403). */
async function officeSource(caller: CommandCaller, source: SourceRef, permission: Permission): Promise<SourceHeader> {
  const context = officeContextOf(caller)
  const header = await caller.withClient((client) => readSource(client, source))
  assertMay(context, SHIPPING_VIEW, permission, header, source.type)
  return header!
}

// ---- preview --------------------------------------------------------------------------------------------------------

async function previewFacts(caller: CommandCaller, source: SourceRef) {
  const header = await officeSource(caller, source, SHIPPING_VIEW)
  const company = await companyLegalOf(caller, header.companyId)
  const facts = await caller.withClient((client) => readSourceFacts(client, header, company, serverClock.now()))
  return { header, company, facts }
}

/**
 * shipping.view: the DDT the source's goods would get now, every problem (state, fields, company, numbering), the number
 * it would probably take, the reasons it may give, and each of the source's goods: why it cannot travel now and the live
 * DDT it travels with.
 */
export async function previewSourceDdt(caller: CommandCaller, source: SourceRef, body: SourceIssueBody) {
  const { header, facts } = await previewFacts(caller, source)
  const { draft, problems } = draftSourceDdt(facts, body, serverClock.now())
  const expectedNumber = await caller.withClient((client) => expectedDdtNumber(client, header.companyId, draft.documentDate))
  const all: Issue[] = [
    ...sourceIssueStateProblems(facts).map((message) => ({ path: 'state', message })),
    ...problems,
    ...(expectedNumber === null ? [{ path: 'company/numbering', message: 'The company has no single active DDT series: an administrator sets it up under numbering.' }] : []),
  ]
  const live = new Map<string, { id: string; number: string }>()
  for (const ddt of facts.liveDdts) for (const lineId of ddt.lineIds) live.set(lineId, { id: ddt.id, number: ddt.number })
  return {
    draft: draftView(draft),
    problems: all,
    expectedNumber,
    language: facts.language,
    source: sourceState(header),
    reasons: [...SOURCE_DDT_REASONS[header.type]],
    goods: facts.goods.map((goods) => ({ ...goods, serials: [...goods.serials], liveDdt: live.get(goods.sourceLineId) ?? null })),
  }
}

/** shipping.view: the preview as a PDF, with the "sample, not a valid document" banner (stored nowhere). */
export async function previewSourceDdtPdf(caller: CommandCaller, source: SourceRef, body: SourceIssueBody): Promise<{ pdf: Buffer; fileName: string }> {
  const { header, company, facts } = await previewFacts(caller, source)
  const { draft, problems } = draftSourceDdt(facts, body, serverClock.now())
  if (problems.length > 0) throw issues(problems)
  const expected = await caller.withClient((client) => expectedDdtNumber(client, header.companyId, draft.documentDate))
  const composed = composeDocument({ ...sourceDdtDocument({ ...draft, number: expected ?? 'DDT' }, facts.language, company.currency), company, sample: true })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.title} - ${composed.banner}.pdf` }
}

// ---- issue ----------------------------------------------------------------------------------------------------------

/** What issuing inside a command answers. */
export interface IssuedSource {
  readonly ddtId: string
  readonly number: string
  readonly documentDate: BusinessDate
  readonly replacement: boolean
  /** The source lines it carries (the repair itself for its garment). */
  readonly lineIds: readonly string[]
  /**
   * Supplier claim lines that name a live DDT already and keep it (B-W2b-14: a line whose DDT was cancelled follows the
   * replacement instead; the draft refuses goods a live DDT carries, so this stays empty in practice).
   */
  readonly claimLinesKeepingOldDdt: readonly string[]
  readonly source: SourceHeader
}

/**
 * Issues the DDT of a source's goods INSIDE the caller's command (an office or system one: a floor command cannot take a
 * DDT number, factory-domain FLOOR_DOCUMENT_KINDS). `company` is the source's company's legal data, read before the
 * command (platform/documents companyLegalOf). In order: the source's row lock (the caller may hold it already), the
 * facts under it, 409 InvalidStateError for the state, 400 ValidationError with every field problem, the layout check,
 * the number, the Ddt row, the kit lines' and claim lines' ddtId, the audit rows and ddt.source_issued. A kit line
 * travels once SENT: the caller posts its TRANSFER and marks it SENT first, in the same transaction.
 */
export async function issueSourceDdtInCommand(tools: CommandTools, company: CompanyLegal, source: SourceRef, body: SourceIssueBody): Promise<IssuedSource> {
  const header = await lockSource(tools.tx, source)
  if (!header) throw new NotFoundError(`${source.type} not found.`)
  if (body.version !== undefined && body.version !== header.version) throw new StaleVersionError(header.type, header.id, header.version, body.version)
  const facts = await readSourceFacts(tools.tx, header, company, tools.now)
  const state = sourceIssueStateProblems(facts)
  if (state.length > 0) throw new InvalidStateError(state.join(' '))
  const { draft, problems } = draftSourceDdt(facts, body, tools.now)
  if (problems.length > 0) throw issues(problems)
  const layout = layoutProblems(draft, facts)
  if (layout.length > 0) throw issues(layout)

  // Only now the number: under the series row's lock, in this transaction (no gap, never twice).
  const id = newId()
  const number = await allocateNumber(tools, { companyId: header.companyId, kind: 'DDT' }, { type: 'Ddt', id, date: draft.documentDate })
  const internalNote = body.internalNote?.trim() ? body.internalNote.trim() : null
  await tools.tx.ddt.create({
    data: {
      id,
      companyId: header.companyId,
      siteId: header.siteId,
      partyId: header.partyId,
      sourceType: header.type,
      sourceId: header.id,
      numberSeriesId: number.seriesId,
      number: number.formatted,
      documentDate: day(number.documentDate),
      reason: draft.reason,
      reasonText: draft.reasonText,
      transportBy: draft.transportBy,
      ...(draft.carrier ? { carrier: json(draft.carrier) } : {}),
      startAt: new Date(draft.startAt),
      appearance: draft.appearance,
      packages: draft.packages,
      grossWeightKg: draft.grossWeightKg,
      netWeightKg: draft.netWeightKg,
      freight: draft.freight,
      sender: json(draft.sender),
      recipient: json(draft.recipient),
      ...(draft.destination ? { destination: json(draft.destination) } : {}),
      lines: json(draft.lines),
      documentRefs: json(draft.documentRefs),
      remarks: draft.remarks,
      internalNote,
      issuedAt: tools.now,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })

  // The source's lines name the DDT they travel with (wave 3's columns): a kit line's moves to the replacement, a
  // claim line's is set once.
  const lineIds = draft.lines.flatMap((line) => (line.sourceLineId === null ? [] : [line.sourceLineId]))
  const kept: string[] = []
  if (header.type === 'SubcontractOrder' && lineIds.length > 0) {
    const rows = await tools.tx.subcontractKitLine.findMany({ where: { id: { in: lineIds }, subcontractOrderId: header.id }, select: { id: true, ddtId: true }, orderBy: { id: 'asc' } })
    for (const row of rows) {
      await tools.tx.subcontractKitLine.update({ where: { id: row.id }, data: { ddtId: id, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'shipping.ddtOnKitLine', recordType: 'SubcontractKitLine', recordId: row.id, companyId: header.companyId, siteId: header.siteId, before: { ddtId: row.ddtId }, after: { ddtId: id, ddt: number.formatted } })
    }
  }
  if (header.type === 'SupplierClaim' && lineIds.length > 0) {
    const rows = await tools.tx.supplierClaimLine.findMany({ where: { id: { in: lineIds }, claimId: header.id }, select: { id: true, ddtId: true }, orderBy: { id: 'asc' } })
    // B-W2b-14 (B-W2a-44's follow-up): a claim line whose DDT was cancelled follows this replacement (the W2b claim line
    // guard lets its ddtId move from a cancelled DDT to the live DDT of its claim that lists it); one on a live DDT keeps it.
    const cancelled = new Set((await tools.tx.ddtCancellation.findMany({ where: { ddtId: { in: rows.flatMap((row) => (row.ddtId ? [row.ddtId] : [])) } }, select: { ddtId: true } })).map((row) => row.ddtId))
    for (const row of rows) {
      if (row.ddtId !== null && !cancelled.has(row.ddtId)) {
        kept.push(row.id)
        continue
      }
      await tools.tx.supplierClaimLine.update({ where: { id: row.id }, data: { ddtId: id, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'shipping.ddtOnClaimLine', recordType: 'SupplierClaimLine', recordId: row.id, companyId: header.companyId, siteId: header.siteId, before: { ddtId: row.ddtId }, after: { ddtId: id, ddt: number.formatted, ...(row.ddtId ? { replaces: row.ddtId } : {}) } })
    }
  }

  tools.audit({
    recordType: 'Ddt',
    recordId: id,
    companyId: header.companyId,
    siteId: header.siteId,
    after: {
      number: number.formatted,
      documentDate: number.documentDate,
      sourceType: header.type,
      sourceId: header.id,
      sourceNumber: header.number,
      reason: draft.reason,
      transportBy: draft.transportBy,
      startAt: draft.startAt,
      packages: draft.packages,
      grossWeightKg: draft.grossWeightKg,
      lineIds,
      typedLines: draft.lines.length - lineIds.length,
      replacement: draft.replacement,
    },
  })
  tools.emit({
    type: 'ddt.source_issued',
    subject: header.id,
    companyId: header.companyId,
    siteId: header.siteId,
    payload: { ddtId: id, sourceType: header.type, sourceId: header.id, number: number.formatted, documentDate: number.documentDate, reason: draft.reason, replacement: draft.replacement },
  })
  return { ddtId: id, number: number.formatted, documentDate: number.documentDate, replacement: draft.replacement, lineIds, claimLinesKeepingOldDdt: kept, source: header }
}

/** What issuing answers: the DDT, the source as it is now, the stored PDF (or why it is missing). */
export interface IssuedSourceAnswer {
  readonly ddt: SourceDdtView
  readonly source: ReturnType<typeof sourceState>
  readonly claimLinesKeepingOldDdt: string[]
  readonly file: FileView | null
  readonly pdfProblem: string | null
}

/**
 * shipping.ddt.issue: issues the DDT of a source's goods (see the file's comment). 409 while the source is in no state
 * its goods travel in (or a repair's garment has a live DDT); 400 with every missing field or a line that cannot travel.
 * Neither uses a number.
 */
export async function issueSourceDdt(
  files: FilesRuntime,
  caller: CommandCaller,
  source: SourceRef,
  body: SourceIssueBody,
  idempotencyKey?: string,
  onPdfError?: (error: unknown) => void,
): Promise<IssuedSourceAnswer> {
  const header = await officeSource(caller, source, SHIPPING_DDT_ISSUE)
  const company = await companyLegalOf(caller, header.companyId)
  const { result } = await command(caller, { name: 'shipping.issueSourceDdt', idempotencyKey, input: { source, ...body } }, async (tools) => {
    const issued = await issueSourceDdtInCommand(tools, company, source, body)
    const row = (await readAnyDdt(tools.tx, issued.ddtId)) as SourceDdtRow
    return { ddt: sourceDdtView(row, null, issued.source.number), source: sourceState(issued.source), claimLinesKeepingOldDdt: [...issued.claimLinesKeepingOldDdt] }
  })
  const printed = await printSourceDdt(files, caller, result.ddt.id, onPdfError)
  return { ...result, ddt: { ...result.ddt, fileId: printed.file?.id ?? null }, ...printed }
}

/**
 * The PDF of an issued source DDT after the issuing command's commit (W1's: rendered from the frozen row, FISCAL_ARCHIVE,
 * shared with the site's floor): a failure leaves the DDT issued and says why the file is missing. For the other flows.
 */
export function printSourceDdt(files: FilesRuntime, caller: CommandCaller, ddtId: string, onError?: (error: unknown) => void): Promise<{ file: FileView | null; pdfProblem: string | null }> {
  return printSafely(files, caller, ddtId, onError)
}
