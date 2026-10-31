import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { composeDocument, documentProblems } from '@nexus/factory-domain/documents/compose'
import { cancelDdtProblems, ddtDocument, draftDdt, draftInvoicesWarning, invoicesOfDdt, issueStateProblems, type DdtDraft, type DdtFacts, type DdtRequest, type InvoiceOfDdt } from '@nexus/factory-domain/shipping/ddt'
import { cancelSourceDdtProblems, DDT_SOURCE_TYPES, sourceDdtDocument, type DdtSourceType } from '@nexus/factory-domain/shipping/ddt/sources'
import { SHIPPING_DDT_CANCEL, SHIPPING_DDT_ISSUE, SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { shipmentMachine, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { TransportMode } from '@nexus/factory-domain/shipping/shipments/transport'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { isDocumentLanguage } from '@nexus/factory-domain/documents/model'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, IdempotencyKeyReusedError, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { serverClock } from '../../../core/time'
import { companyLegalOf, storeDocumentPdf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import type { FileView } from '../../../platform/files/contract'
import { downloadFile, getFile, type Callers } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, mayOn, officeContextOf } from '../access'
import { tenantOf } from '../cells'
import { shipmentDetail, officeShipment } from '../shipments/shipments'
import { shipmentDocumentBlockers } from '../documents/read'
import { whenShipped } from '../shipments/leave'
import { lockedStatus, readShipment, shipmentFacts, type ShipmentHeader } from '../store'
import { isSourceDdt, lockSource, sourceDdtView, sourceIssuedOf, sourceLanguageOf, sourceNumbersOf, type SourceDdtRow } from './sources-store'
import { ddtView, expectedDdtNumber, isShipmentDdt, issuedOf, languageOf, liveDdtOf, pdfFileIdOf, pdfFileIdsOf, readAnyDdt, readDdt, readDdtFacts, type AnyDdtRow, type DdtRow, type DdtView } from './store'

/**
 * The DDT of a shipment (B-W1-47; LOG-054; DPR 472/1996; A2 SCR-067 Documents tab). Office only.
 *
 *   preview   what the DDT would say now and every problem, with the number it would probably take: nothing is used
 *   issue     ONE command on the Shipment (its version bump locks the row, so two issues of one shipment queue and the
 *             second finds the first's DDT): the facts read under the lock, the state and every field checked, THEN
 *             the number from the company's DDT series for the document's year (allocateNumber: the series row
 *             locked, in the same transaction, so a refusal or a rollback uses no number), the frozen Ddt row, and with
 *             `ship` the shipment PACKED → SHIPPED and its serials RELEASED → SHIPPED (that order: a serial is SHIPPED
 *             only with its shipment), the audit rows and the events. After the commit the PDF is rendered from the
 *             frozen row and stored (FISCAL_ARCHIVE, ten years) by platform/documents' own command: when the file
 *             store is down the DDT stays issued and POST /shipping/ddts/:ddtId/pdf prints it again.
 *   ship      PACKED → SHIPPED (the goods were handed over): a live DDT unless an immediate invoice travels instead, and
 *             every PPE style's DoC and leaflet on file for its frozen revision (B-W1-49: 409 in the compliance step's
 *             words; the same check when `issue` ships). Issuing a DDT without shipping never asks for them.
 *   cancel    an append-only DdtCancellation under the shipment's lock (one per DDT); the shipment stays as it is (the
 *             guards allow no way back from SHIPPED): PACKED can be unpacked or take a new DDT, SHIPPED takes a
 *             replacement DDT with a new number.
 *
 * B-W2a-17 (LOG-056): the record, PDF, list and cancel routes take any DDT, a shipment's or one for another reason (a
 * source record's goods: sources.ts issues them); a source's DDT is cancelled under the SOURCE's row lock.
 */

/** The DDT's request as the routes pass it. */
export interface IssueBody extends DdtRequest {
  readonly version?: number | undefined
  readonly internalNote?: string | null | undefined
  /** B-W2b-19 (Intrastat): the mode of transport the DDT keeps; default the shipment's. */
  readonly transportMode?: TransportMode | null | undefined
  /** B-W2a-F8 with B-W2b-19: with `ship`, the reason the garments' SHIPMENT moves go into a SOFT-locked month. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

const issues = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The DDT cannot be issued as it stands.', problems)

const day = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

/** The JSON of a draft for the Ddt row (Prisma's JSON input: plain objects, no undefined). */
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** The draft as the preview shows it. */
const draftView = (draft: DdtDraft) => ({ ...draft, lines: draft.lines.map((line) => ({ ...line, serials: [...line.serials] })), documentRefs: draft.documentRefs.map((reference) => ({ ...reference, date: reference.date ?? null })) })

/** The layout's own check of the DDT (factory-domain documents), before a number is taken: a bug guard. */
function layoutProblems(draft: DdtDraft, facts: DdtFacts): Issue[] {
  return documentProblems({ ...ddtDocument({ ...draft, number: 'DDT' }, facts.language, facts.company.currency), company: facts.company })
}

// ---- preview --------------------------------------------------------------------------------------------------------

async function previewFacts(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const company = await companyLegalOf(caller, shipment.companyId)
  const facts = await caller.withClient((client) => readDdtFacts(client, shipment, company))
  return { shipment, company, facts }
}

/** shipping.view: the DDT the shipment would get now, every problem, and the number it would probably take. */
export async function previewDdt(caller: CommandCaller, shipmentId: string, body: IssueBody) {
  const { shipment, facts } = await previewFacts(caller, shipmentId)
  const now = serverClock.now()
  const { draft, problems } = draftDdt(facts, body, now)
  const expectedNumber = await caller.withClient((client) => expectedDdtNumber(client, shipment.companyId, draft.documentDate))
  const all: Issue[] = [
    ...issueStateProblems(shipment.status, facts.liveDdtNumber, body.ship === true).map((message) => ({ path: 'state', message })),
    ...problems,
    ...(expectedNumber === null ? [{ path: 'company/numbering', message: 'The company has no single active DDT series: an administrator sets it up under numbering.' }] : []),
  ]
  return { draft: draftView(draft), problems: all, expectedNumber, language: facts.language }
}

/** shipping.view: the preview as a PDF, with the "sample, not a valid document" banner (stored nowhere). */
export async function previewDdtPdf(caller: CommandCaller, shipmentId: string, body: IssueBody): Promise<{ pdf: Buffer; fileName: string }> {
  const { shipment, company, facts } = await previewFacts(caller, shipmentId)
  const { draft, problems } = draftDdt(facts, body, serverClock.now())
  if (problems.length > 0) throw issues(problems)
  const expected = await caller.withClient((client) => expectedDdtNumber(client, shipment.companyId, draft.documentDate))
  const composed = composeDocument({ ...ddtDocument({ ...draft, number: expected ?? 'DDT' }, facts.language, company.currency), company, sample: true })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.title} - ${composed.banner}.pdf` }
}

// ---- issue ----------------------------------------------------------------------------------------------------------

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * The goods leave (inside a command on the shipment): PACKED → SHIPPED first, then each packed serial RELEASED →
 * SHIPPED (the …_quality_shipping_guards trigger ships a serial only with its shipment; the deferred one checks the
 * live DDT at commit). Returns the serials shipped.
 */
async function shipGoods(tools: CommandTools, shipment: ShipmentHeader, periodLockOverride?: PeriodLockOverride | null): Promise<string[]> {
  await tools.tx.shipment.update({ where: { id: shipment.id }, data: { status: 'SHIPPED', shippedAt: tools.now }, select: { id: true } })
  const serials = await tools.tx.garmentSerial.findMany({ where: { shipmentLine: { shipmentId: shipment.id }, status: 'RELEASED' }, select: { id: true, serial: true }, orderBy: { serial: 'asc' } })
  for (const serial of serials) {
    await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { status: 'SHIPPED', version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.shipSerial', recordType: 'GarmentSerial', recordId: serial.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: 'RELEASED' }, after: { status: 'SHIPPED', shipmentId: shipment.id } })
  }
  // B-W2a-48: closed-short lines refused, the garments in finished goods out of stock, the freight, the EU evidence.
  await whenShipped(tools, shipment, periodLockOverride)
  tools.emit({ type: 'shipment.status_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, from: 'PACKED', to: 'SHIPPED' } })
  tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status: 'SHIPPED', change: 'status' } })
  return serials.map((serial) => serial.serial)
}

/**
 * PPE leaves only with its EU Declaration of Conformity and user information (B-W1-49; Reg. (EU) 2016/425 art. 8(7),
 * 8(8)): inside the shipping command, after its state check, a 409 with the compliance step's words when a PPE style's
 * documents are not on file for its frozen revision (modules/shipping/documents shipmentDocumentBlockers).
 */
async function assertDocumentsTravel(tools: CommandTools, shipmentId: string): Promise<void> {
  const blockers = await shipmentDocumentBlockers(tools.tx, shipmentId)
  if (blockers.length > 0) throw new InvalidStateError(blockers.map((check) => check.message).join(' '))
}

const shipmentState = async (tools: CommandTools, shipmentId: string) => {
  const row = (await readShipment(tools.tx, shipmentId))!
  return { id: row.id, number: row.number, status: row.status, version: row.version }
}

/** What issuing answers: the DDT, the shipment as it is now, the stored PDF (or why it is missing). */
export interface IssuedAnswer {
  readonly ddt: DdtView
  readonly shipment: { readonly id: string; readonly number: string; readonly status: ShipmentStatus; readonly version: number }
  readonly file: FileView | null
  readonly pdfProblem: string | null
}

/**
 * shipping.ddt.issue (and shipping.manage with `ship`): issues the shipment's DDT (see the file's comment). 409 while
 * the shipment is not PACKED (or SHIPPED without a live DDT, a replacement) or has a live DDT; 400 with every missing
 * field. Neither uses a number.
 */
export async function issueDdt(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: IssueBody, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<IssuedAnswer> {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_DDT_ISSUE)
  if (body.ship === true && !mayOn(context, SHIPPING_MANAGE, shipment)) throw new ForbiddenError('Shipping the goods with the DDT needs shipping.manage too.')
  const company = await companyLegalOf(caller, shipment.companyId)
  const { result } = await command(
    caller,
    { name: 'shipping.issueDdt', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const facts = await readDdtFacts(tools.tx, current, company)
      const state = issueStateProblems(current.status, facts.liveDdtNumber, body.ship === true)
      if (state.length > 0) throw new InvalidStateError(state.join(' '))
      if (body.ship === true) await assertDocumentsTravel(tools, current.id)
      const { draft, problems } = draftDdt(facts, body, tools.now)
      if (problems.length > 0) throw issues(problems)
      const layout = layoutProblems(draft, facts)
      if (layout.length > 0) throw issues(layout)

      // Only now the number: under the series row's lock, in this transaction (no gap, never twice).
      const id = newId()
      const number = await allocateNumber(tools, { companyId: current.companyId, kind: 'DDT' }, { type: 'Ddt', id, date: draft.documentDate })
      const internalNote = body.internalNote?.trim() ? body.internalNote.trim() : null
      // B-W2b-19: the DDT keeps the language it is printed in and the mode of transport (Intrastat).
      const shipmentMode = (await tools.tx.shipment.findUnique({ where: { id: current.id }, select: { transportMode: true } }))?.transportMode ?? null
      await tools.tx.ddt.create({
        data: {
          id,
          companyId: current.companyId,
          siteId: current.siteId,
          partyId: current.partyId,
          shipmentId: current.id,
          language: facts.language,
          transportMode: body.transportMode !== undefined ? body.transportMode : shipmentMode,
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
      const replacement = current.status === 'SHIPPED'
      const shipped = body.ship === true ? await shipGoods(tools, current, body.periodLockOverride) : null
      tools.audit({
        recordType: 'Ddt',
        recordId: id,
        companyId: current.companyId,
        siteId: current.siteId,
        after: { number: number.formatted, documentDate: number.documentDate, shipmentId: current.id, reason: draft.reason, transportBy: draft.transportBy, startAt: draft.startAt, packages: draft.packages, grossWeightKg: draft.grossWeightKg, replacement },
      })
      if (shipped !== null) {
        tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'PACKED' }, after: { status: 'SHIPPED', ddt: number.formatted, serials: shipped } })
      }
      tools.emit({ type: 'ddt.issued', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { ddtId: id, shipmentId: current.id, number: number.formatted, documentDate: number.documentDate, replacement, shipped: shipped !== null } })
      return { ddt: ddtView((await readDdt(tools.tx, id))!, null), shipment: await shipmentState(tools, current.id) }
    },
  )
  const printed = await printSafely(files, caller, result.ddt.id, onPdfError)
  return { ...result, ddt: { ...result.ddt, fileId: printed.file?.id ?? null }, ...printed }
}

// ---- the PDF --------------------------------------------------------------------------------------------------------

/**
 * The DDT's PDF: the stored one, or rendered now from the frozen row (the company's letterhead from its Company row)
 * and stored for the DDT (FISCAL_ARCHIVE, shared with its site's floor, which hands it to the driver). The documents
 * command takes a fixed Idempotency-Key per DDT: two prints at once record one file.
 */
async function ensurePdf(files: FilesRuntime, caller: CommandCaller, ddtId: string): Promise<{ file: FileView; created: boolean }> {
  const stored = await caller.withClient((client) => pdfFileIdOf(client, ddtId))
  if (stored) return { file: await getFile(caller, stored), created: false }
  const { ddt, document } = await caller.withClient(async (client) => {
    const row = (await readAnyDdt(client, ddtId))!
    const company = await client.company.findUnique({ where: { id: row.companyId }, select: { currency: true } })
    const currency = company?.currency ?? 'EUR'
    // The language it was issued in (B-W2b-19: Ddt.language); a DDT issued before W2b: a shipment's speaks its order's
    // language, one for another reason its party's (B-W2a-17).
    const kept = isDocumentLanguage(row.language) ? row.language : null
    if (isShipmentDdt(row)) return { ddt: row, document: ddtDocument(issuedOf(row), kept ?? (await languageOf(client, row.shipment.salesOrderId)), currency) }
    if (!isSourceDdt(row)) throw new InvalidStateError('This DDT names neither a shipment nor a source record.')
    return { ddt: row, document: sourceDdtDocument(sourceIssuedOf(row), kept ?? (await sourceLanguageOf(client, row.partyId)), currency) }
  })
  try {
    const { file } = await storeDocumentPdf(files, caller, {
      companyId: ddt.companyId,
      recordType: 'Ddt',
      recordId: ddt.id,
      document,
      visibility: ['FLOOR'],
      floorSiteId: ddt.siteId,
      idempotencyKey: `ddt-pdf.${ddt.id}`,
    })
    return { file, created: true }
  } catch (error) {
    // Another person printed it at the same moment (the same key, another caller): theirs is the file.
    const again = error instanceof IdempotencyKeyReusedError ? await caller.withClient((client) => pdfFileIdOf(client, ddtId)) : null
    if (again) return { file: await getFile(caller, again), created: false }
    throw error
  }
}

/** The PDF after the issue's commit: a failure leaves the DDT issued and says why the file is missing. */
export async function printSafely(files: FilesRuntime, caller: CommandCaller, ddtId: string, onError?: (error: unknown) => void): Promise<{ file: FileView | null; pdfProblem: string | null }> {
  try {
    return { file: (await ensurePdf(files, caller, ddtId)).file, pdfProblem: null }
  } catch (error) {
    onError?.(error)
    const why = error instanceof DomainError || (error instanceof ApiError && error.code !== 'internal_error') ? ` (${error.message})` : ''
    return { file: null, pdfProblem: `The DDT is issued; its PDF could not be stored now${why}. Print it again with POST /shipping/ddts/${ddtId}/pdf.` }
  }
}

/** The DDT (a shipment's or one for another reason) the office may see (else 404) and act on with `permission` (else 403). */
async function officeDdt(caller: CommandCaller, ddtId: string, permission: Permission = SHIPPING_VIEW): Promise<AnyDdtRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readAnyDdt(client, ddtId))
  assertMay(context, SHIPPING_VIEW, permission, row, 'DDT')
  return row!
}

/** shipping.ddt.issue: stores the DDT's PDF when it has none (the issue's file store was down); else the stored one. */
export async function printDdt(files: FilesRuntime, caller: CommandCaller, ddtId: string): Promise<{ file: FileView; created: boolean }> {
  await officeDdt(caller, ddtId, SHIPPING_DDT_ISSUE)
  return ensurePdf(files, caller, ddtId)
}

/** shipping.view: a presigned download of the DDT's PDF (the files module also checks files.read on the file). */
export async function downloadDdtPdf(files: FilesRuntime, callers: Callers, ddtId: string) {
  await officeDdt(callers.caller, ddtId)
  const fileId = await callers.caller.withClient((client) => pdfFileIdOf(client, ddtId))
  if (!fileId) throw new NotFoundError(`This DDT's PDF is not stored yet: print it again (POST /shipping/ddts/${ddtId}/pdf).`)
  return { file: await getFile(callers.caller, fileId), download: await downloadFile(files, callers, fileId) }
}

// ---- reading --------------------------------------------------------------------------------------------------------

export async function getDdt(caller: CommandCaller, ddtId: string) {
  const row = await officeDdt(caller, ddtId)
  const fileId = await caller.withClient((client) => pdfFileIdOf(client, row.id))
  if (isShipmentDdt(row)) return { ddt: ddtView(row, fileId) }
  if (!isSourceDdt(row)) throw new NotFoundError('DDT not found.')
  const numbers = await caller.withClient((client) => sourceNumbersOf(client, [{ type: row.sourceType, id: row.sourceId }]))
  return { ddt: sourceDdtView(row, fileId, numbers.get(`${row.sourceType}:${row.sourceId}`) ?? null) }
}

export interface ListDdtsQuery {
  readonly shipmentId?: string | undefined
  /** B-W2a-17: the DDTs of one source record (both, or the type alone), or only shipments' (SHIPMENT) or sources' (SOURCE). */
  readonly sourceType?: DdtSourceType | undefined
  readonly sourceId?: string | undefined
  readonly kind?: 'SHIPMENT' | 'SOURCE' | undefined
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly status?: 'LIVE' | 'CANCELLED' | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The DDTs the caller may see (its companies, sites and parties), shipments' and sources' (B-W2a-17), newest first. */
export async function listDdts(caller: CommandCaller, query: ListDdtsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.DdtWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.DdtWhereInput,
      query.kind === 'SHIPMENT' ? { shipmentId: { not: null } } : query.kind === 'SOURCE' ? { shipmentId: null } : {},
      query.shipmentId ? { shipmentId: query.shipmentId } : {},
      query.sourceType ? { sourceType: query.sourceType } : {},
      query.sourceId ? { sourceId: query.sourceId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.status === 'LIVE' ? { cancellations: { none: {} } } : query.status === 'CANCELLED' ? { cancellations: { some: {} } } : {},
      query.from ? { documentDate: { gte: day(query.from) } } : {},
      query.to ? { documentDate: { lte: day(query.to) } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient(async (client) => {
    const found = await client.ddt.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        number: true,
        documentDate: true,
        companyId: true,
        siteId: true,
        partyId: true,
        shipmentId: true,
        sourceType: true,
        sourceId: true,
        reason: true,
        transportBy: true,
        packages: true,
        grossWeightKg: true,
        startAt: true,
        issuedAt: true,
        recipient: true,
        shipment: { select: { number: true } },
        cancellations: { select: { cancelledAt: true }, orderBy: { cancelledAt: 'asc' }, take: 1 },
      },
    })
    // The same choice as the record's: the first stored print (store.ts pdfFileIdsOf).
    const pdf = await pdfFileIdsOf(client, found.map((row) => row.id))
    const sources = found.flatMap((row) => (row.sourceId !== null && (DDT_SOURCE_TYPES as readonly string[]).includes(row.sourceType ?? '') ? [{ type: row.sourceType as DdtSourceType, id: row.sourceId }] : []))
    return { found, pdf, numbers: await sourceNumbersOf(client, sources) }
  })
  const page = rows.found.slice(0, query.limit)
  return {
    ddts: page.map((row) => {
      const recipient = row.recipient as Record<string, unknown> | null
      return {
        id: row.id,
        number: row.number,
        documentDate: row.documentDate.toISOString().slice(0, 10),
        status: row.cancellations.length > 0 ? ('CANCELLED' as const) : ('LIVE' as const),
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: row.partyId,
        recipientName: typeof recipient?.name === 'string' ? recipient.name : '',
        shipmentId: row.shipmentId,
        shipmentNumber: row.shipment?.number ?? null,
        source: row.sourceType !== null && row.sourceId !== null ? { type: row.sourceType as DdtSourceType, id: row.sourceId, number: rows.numbers.get(`${row.sourceType}:${row.sourceId}`) ?? '' } : null,
        reason: row.reason,
        transportBy: row.transportBy,
        packages: row.packages,
        grossWeightKg: row.grossWeightKg.toFixed(4),
        startAt: row.startAt.toISOString(),
        issuedAt: row.issuedAt.toISOString(),
        cancelledAt: row.cancellations[0] ? row.cancellations[0].cancelledAt.toISOString() : null,
        fileId: rows.pdf.get(row.id) ?? null,
      }
    }),
    nextCursor: rows.found.length > query.limit ? page[page.length - 1]!.id : null,
  }
}

// ---- ship and cancel ------------------------------------------------------------------------------------------------

/**
 * shipping.manage: the goods were handed over (PACKED → SHIPPED, the packed serials SHIPPED): with a live DDT, unless
 * an immediate invoice travels with them (ddtRequired false). Office only; never the floor.
 */
export async function shipShipment(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const { result } = await command(caller, { name: 'shipping.ship', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = await lockedStatus(tools, shipment.id, ['PACKED'], 'it leaves')
    const facts = { ...(await shipmentFacts(tools.tx, current.id)), ddtRequired: current.ddtRequired }
    assertTransition(shipmentMachine, current.status, 'SHIPPED', facts)
    await assertDocumentsTravel(tools, current.id)
    const live = await liveDdtOf(tools.tx, current.id)
    const serials = await shipGoods(tools, current, body.periodLockOverride)
    tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'PACKED' }, after: { status: 'SHIPPED', ddt: live?.number ?? null, serials } })
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
  return result
}

/**
 * shipping.ddt.cancel: cancels a DDT with its reason (an append-only DdtCancellation; the DDT keeps its number). One
 * command on the DDT's shipment (`version` is the shipment's), so one cancellation per DDT holds under its lock. Refused
 * once the transport is over (DELIVERED, RETURNED: no replacement could be issued) and while an issued invoice (ISSUED or
 * later) has a line naming it (409 naming the invoice); DRAFT invoices naming it come back as a warning.
 */
export async function cancelDdt(caller: CommandCaller, ddtId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const row = await officeDdt(caller, ddtId, SHIPPING_DDT_CANCEL)
  if (isSourceDdt(row)) return cancelSourceDdt(caller, row, body, idempotencyKey)
  if (!isShipmentDdt(row)) throw new NotFoundError('DDT not found.')
  const ddt: DdtRow = row
  const { result } = await command(caller, { name: 'shipping.cancelDdt', idempotencyKey, input: { ddtId, ...body }, record: { type: 'Shipment', id: ddt.shipmentId, expectedVersion: body.version } }, async (tools) => {
    const shipment = await readShipment(tools.tx, ddt.shipmentId)
    if (!shipment) throw new InvalidStateError('The shipment is gone.')
    const cancelled = (await tools.tx.ddtCancellation.count({ where: { ddtId: ddt.id } })) > 0
    // The invoices whose lines name the DDT, locked: an issue racing this cancel waits, then the money guards refuse
    // it (a DDT named is not cancelled); a cancel racing an issue waits, then reads it ISSUED and refuses.
    const invoices = await tools.tx.$queryRaw<InvoiceOfDdt[]>`
      SELECT i."id"::text AS "id", i."number", i."status"::text AS "status" FROM "Invoice" i
       WHERE i."tenantId" = ${tenantOf(tools.context)}::uuid
         AND EXISTS (SELECT 1 FROM "InvoiceLine" l WHERE l."tenantId" = i."tenantId" AND l."invoiceId" = i."id" AND l."ddtId" = ${ddt.id}::uuid)
       ORDER BY i."id" FOR UPDATE`
    const { issued, drafts } = invoicesOfDdt(invoices)
    const problems = cancelDdtProblems({ cancelled, shipmentStatus: shipment.status, invoiceNumbers: issued })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const cancellationId = newId()
    await tools.tx.ddtCancellation.create({
      data: { id: cancellationId, siteId: ddt.siteId, partyId: ddt.partyId, ddtId: ddt.id, reason: body.reason, cancelledAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    tools.audit({ recordType: 'Ddt', recordId: ddt.id, companyId: ddt.companyId, siteId: ddt.siteId, before: { status: 'LIVE', number: ddt.number }, after: { status: 'CANCELLED', number: ddt.number, cancellationId, shipmentStatus: shipment.status, draftInvoiceIds: drafts }, reason: body.reason })
    tools.emit({ type: 'ddt.cancelled', subject: shipment.id, companyId: ddt.companyId, siteId: ddt.siteId, payload: { ddtId: ddt.id, shipmentId: shipment.id, number: ddt.number } })
    const state = await shipmentState(tools, shipment.id)
    return {
      ddt: ddtView((await readDdt(tools.tx, ddt.id))!, await pdfFileIdOf(tools.tx, ddt.id)),
      // A SHIPPED shipment travels without a live DDT until its replacement is issued.
      shipment: { ...state, needsDdt: state.status === 'SHIPPED' && shipment.ddtRequired },
      source: null,
      // DRAFT invoices that still name the cancelled DDT: they are not issued until their lines name the replacement.
      draftInvoiceIds: drafts,
      warning: draftInvoicesWarning(drafts),
    }
  })
  return result
}

/**
 * shipping.ddt.cancel, a DDT for another reason (B-W2a-17): an append-only DdtCancellation under the SOURCE's row lock
 * (sources-store.ts lockSource; `version`, when sent, is the source's as read: never bumped, a CLOSED RMA or a SHIPPED
 * repair never changes). Refused once the source's transport is over (its state no longer takes a replacement) and
 * while an issued invoice names the DDT (W1's rule and lock); DRAFT invoices come back as a warning. The source's lines
 * keep the DDT they named (a replacement names the new one; a supplier claim line's DDT is set once: see the notes).
 */
async function cancelSourceDdt(caller: CommandCaller, ddt: SourceDdtRow, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const ref = { type: ddt.sourceType, id: ddt.sourceId }
  const { result } = await command(caller, { name: 'shipping.cancelSourceDdt', idempotencyKey, input: { ddtId: ddt.id, ...body } }, async (tools) => {
    const source = await lockSource(tools.tx, ref)
    if (!source) throw new InvalidStateError('The source record of this DDT is gone.')
    if (body.version !== undefined && body.version !== source.version) throw new StaleVersionError(source.type, source.id, source.version, body.version)
    const cancelled = (await tools.tx.ddtCancellation.count({ where: { ddtId: ddt.id } })) > 0
    const invoices = await tools.tx.$queryRaw<InvoiceOfDdt[]>`
      SELECT i."id"::text AS "id", i."number", i."status"::text AS "status" FROM "Invoice" i
       WHERE i."tenantId" = ${tenantOf(tools.context)}::uuid
         AND EXISTS (SELECT 1 FROM "InvoiceLine" l WHERE l."tenantId" = i."tenantId" AND l."invoiceId" = i."id" AND l."ddtId" = ${ddt.id}::uuid)
       ORDER BY i."id" FOR UPDATE`
    const { issued, drafts } = invoicesOfDdt(invoices)
    const problems = cancelSourceDdtProblems({ cancelled, source, invoiceNumbers: issued })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const cancellationId = newId()
    await tools.tx.ddtCancellation.create({
      data: { id: cancellationId, siteId: ddt.siteId, partyId: ddt.partyId, ddtId: ddt.id, reason: body.reason, cancelledAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    tools.audit({
      recordType: 'Ddt',
      recordId: ddt.id,
      companyId: ddt.companyId,
      siteId: ddt.siteId,
      before: { status: 'LIVE', number: ddt.number },
      after: { status: 'CANCELLED', number: ddt.number, cancellationId, sourceType: source.type, sourceId: source.id, sourceState: source.state, draftInvoiceIds: drafts },
      reason: body.reason,
    })
    tools.emit({ type: 'ddt.source_cancelled', subject: source.id, companyId: ddt.companyId, siteId: ddt.siteId, payload: { ddtId: ddt.id, sourceType: source.type, sourceId: source.id, number: ddt.number } })
    const row = (await readAnyDdt(tools.tx, ddt.id)) as SourceDdtRow
    return {
      ddt: sourceDdtView(row, await pdfFileIdOf(tools.tx, ddt.id), source.number),
      shipment: null,
      // The goods left (the transport started): they travel without a live DDT until its replacement is issued.
      source: { type: source.type, id: source.id, number: source.number, state: source.state, version: source.version, needsDdt: ddt.startAt.getTime() <= tools.now.getTime() },
      draftInvoiceIds: drafts,
      warning: draftInvoicesWarning(drafts),
    }
  })
  return result
}
