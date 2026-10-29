import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ticketLabel, bundleTicketZpl, type BundleTicket } from '@nexus/factory-domain/production/bundles/ticket'
import type { LabelInput, LabelLanguage } from '@nexus/factory-domain/labels/model'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { PRODUCTION_BUNDLES } from '@nexus/factory-domain/production/bundles/permissions'
import {
  bundlesReadyRefusal,
  cellBundles,
  planBundles,
  reprintRefusal,
  voidRefusal,
  type BundleAsk,
  type BundleCount,
  type BundleRefusal,
  type CellBundles,
} from '@nexus/factory-domain/production/bundles/rules'
import { cellLabel } from '@nexus/factory-domain/production/cutting/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorReadinessFor } from '../../../platform/privacy/read'
import type { PrintJobView } from '../../../platform/print/contract'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { readPrinter, type PrinterRow } from '../../../platform/print/printers'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { cutForBundles } from '../cutting/views'
import { floorRecordSubjectFor } from '../settings/subject'
import { asTenantSystem, withTicketCodes, type TicketCodes } from './codes'
import {
  BUNDLE_COLUMNS,
  countScans,
  deviceStationOf,
  lockBundle,
  lockCells,
  readBundle,
  readBundles,
  readCellLabels,
  readHeader,
  readOperations,
  type BundleHeader,
  type BundleRow,
  type CellLabel,
  type Reader,
} from './store'

/**
 * Bundles and bundle tickets from a cut (B-W1-41; MES-065, MES-066, MES-068, MES-073, MES-184; PLAN §4.7 stage 12-scans
 * "bundles"; A2 SCR-095, SCR-072). Each write is ONE command() (the floor: production.bundles at its own site with an
 * Idempotency-Key; the office: production.bundles); the rules are factory-domain production/bundles/rules; a refusal is
 * a 409 with its code (`refusal/<CODE>`); the …_production_guards Bundle trigger stays the last word.
 *
 *   make     the floor: the garments cut and not yet in bundles, per cell (or "all cut, not bundled"), split into
 *            bundles of the target size (the last one takes the rest), each with the next ticket code; they name the
 *            cell's live cut log entries (genealogy: hides, lots). Lock order: the work order's issue lock (a cut's undo
 *            or correction and the work order's complete, close and cancel take it first, so no cut is reversed under
 *            bundles being made and no bundle lands on a cancelled work order) → the cells' bundle locks (sorted) → the
 *            tenant's ticket-code lock (codes.ts). Two tablets on one cell take turns; the second is told what is left.
 *   reprint  floor or office: the ticket gets a new code, the old one joins `replacedCodes` (a scan of it is refused
 *            with the new code in the words); the bundle row is locked FOR UPDATE first (store.ts lockBundle).
 *   void     floor or office: a bundle made by mistake, only before any scan names it (B-W1-42 locks the bundle row
 *            FOR SHARE before a scan: store.ts lockBundleForScan), with the reason; its garments are to bundle again.
 * After the command, each new ticket is queued on the label printer (platform/print queueModuleLabel, label kind
 * BUNDLE: the BUNDLE label and the operations, ZPL for the printer's stock) under the key `bundle-ticket:<id>:<code>`,
 * so a resent request queues no ticket twice; without a label printer the answer carries the label for the browser's
 * PDF (POST /print/labels/pdf). Before a floor make or reprint the site's floor must be ready (platform/privacy
 * floorReadinessFor, read as the tenant's system caller): 409 FLOOR_NOT_READY in the gate's words. A bundle names who
 * made it (createdById) only where the site names workers and the worker acknowledged the notice (production/settings
 * floorRecordSubjectFor); at a station site nobody. Every write audits the bundle and the work order and emits
 * production.bundle_created / bundle_reprinted / bundle_voided.
 */

/** A bundle refused by its rule (factory-domain production/bundles/rules): a 409 with the refusal's code in `refusal/<CODE>`. */
export class BundleRefusedError extends ConflictError {
  override name = 'BundleRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: BundleRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

const refused = (refusal: BundleRefusal): never => {
  throw new BundleRefusedError(refusal)
}
const at = (value: Date | null) => (value ? toUtcIso(value) : null)

type Worker = FloorContext | OfficeContext

export function workerOf(caller: Pick<CommandCaller, 'factoryContext'>): Worker {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
}

function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** May the caller work on this work order with the permission? (A floor device: only at its own site.) */
export function mayBundle(context: Worker, permission: Permission, workOrder: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== workOrder.siteId) return false
  return can(actorOf(context), permission, { companyId: workOrder.companyId, siteId: workOrder.siteId })
}

/** The work order the caller bundles for or reads: one it may reach with the permission (else not found). */
export async function bundleWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<BundleHeader> {
  const context = workerOf(caller)
  const workOrder = await caller.withClient((client) => readHeader(client, workOrderId))
  if (!workOrder || !mayBundle(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return workOrder
}

// ---- views ------------------------------------------------------------------------------------------------------------------

export function bundleView(row: BundleRow, cells: ReadonlyMap<string, CellLabel>) {
  const cell = cells.get(row.workOrderSizeId)
  return {
    id: row.id,
    code: row.code,
    replacedCodes: [...row.replacedCodes],
    workOrderId: row.workOrderId,
    workOrderSizeId: row.workOrderSizeId,
    colourwayCode: cell?.colourwayCode ?? '',
    size: cell?.size ?? '',
    part: row.part,
    quantity: row.quantity,
    status: row.status,
    voidedAt: at(row.voidedAt),
    voidReason: row.voidReason,
    cutLogIds: [...row.cutLogIds],
    deviceId: row.deviceId,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}
export type BundleView = ReturnType<typeof bundleView>

export function cellView(counts: CellBundles, label: CellLabel | undefined) {
  return {
    workOrderSizeId: counts.cellId,
    colourwayCode: label?.colourwayCode ?? '',
    size: label?.size ?? '',
    quantity: counts.quantity,
    cut: counts.cut,
    bundled: counts.bundled,
    toBundle: counts.toBundle,
    parts: counts.parts.map((part) => ({ ...part })),
  }
}

const activeCounts = (rows: readonly Pick<BundleRow, 'workOrderSizeId' | 'part' | 'quantity' | 'status'>[]): BundleCount[] =>
  rows.filter((row) => row.status === 'ACTIVE').map((row) => ({ cellId: row.workOrderSizeId, part: row.part, quantity: row.quantity }))

/** Each cell's cut, bundled and still-to-bundle garments, from the cut log (B-W1-40's cutForBundles) and the bundles. */
export async function countsOf(db: Reader, workOrder: Pick<BundleHeader, 'id' | 'styleId'>, bundles?: readonly BundleCount[]) {
  const cut = await cutForBundles(db, workOrder.id, workOrder.styleId)
  const active = bundles ?? activeCounts(await readBundles(db, workOrder.id))
  return { cut, cells: cut.map((cell) => cellBundles({ cellId: cell.workOrderSizeId, quantity: cell.quantity, cut: cell.cut, parts: cell.parts }, active)) }
}

/** What every ticket of the work order prints but the bundle's own facts. */
export async function ticketBase(db: Reader, workOrder: BundleHeader, language: LabelLanguage) {
  const company = await db.company.findUnique({ where: { id: workOrder.companyId }, select: { legalName: true, tradeName: true } })
  const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { code: true, name: true } })
  const operations = await readOperations(db, workOrder.id)
  return {
    language,
    maker: company?.tradeName || company?.legalName || null,
    workOrder: { number: workOrder.number, batchNumber: workOrder.batchNumber },
    style: { code: style?.code ?? '', name: style?.name ?? '' },
    operations: operations.map((operation) => ({ seq: operation.seq, code: operation.code, name: operation.name })),
  }
}

export function ticketOf(base: Awaited<ReturnType<typeof ticketBase>>, row: Pick<BundleRow, 'code' | 'quantity' | 'part' | 'workOrderSizeId'>, cells: ReadonlyMap<string, CellLabel>): BundleTicket {
  const cell = cells.get(row.workOrderSizeId)
  return { ...base, code: row.code, colourway: { code: cell?.colourwayCode ?? '', name: cell?.colourwayName ?? '' }, size: cell?.size ?? '', quantity: row.quantity, part: row.part }
}

// ---- the printer and the tickets -----------------------------------------------------------------------------------------------

interface TicketPrinter {
  readonly printer: PrinterRow | null
  /** Why no ticket is queued (no label printer: the tickets print as PDF). */
  readonly problem: string | null
}

const NO_PRINTER = 'No label printer is chosen: print the tickets as PDF.'

/**
 * The label printer the tickets go to, checked BEFORE anything is made: the one asked (a label printer of the work
 * order's site, ACTIVE, where the caller prints labels), none (null: the tickets print as PDF), or, when none is named,
 * the site's only ACTIVE label printer (several: the caller chooses; MES-184's station printer is a later schema step).
 */
async function ticketPrinter(caller: CommandCaller, workOrder: BundleHeader, printerId: string | null | undefined): Promise<TicketPrinter> {
  const context = workerOf(caller)
  if (printerId === null) return { printer: null, problem: NO_PRINTER }
  if (printerId === undefined) {
    const rows = await caller.withClient((client) => client.printer.findMany({ where: { siteId: workOrder.siteId, kind: 'LABEL_ZPL', status: 'ACTIVE' }, select: { id: true } }))
    if (rows.length === 0) return { printer: null, problem: 'This site has no active label printer: print the tickets as PDF.' }
    if (rows.length > 1) {
      throw new ValidationError(`This site has ${rows.length} label printers: choose one.`, [{ path: 'body/printerId', message: 'Name the label printer, or null to print the tickets as PDF.' }])
    }
    printerId = rows[0]!.id
  }
  const printer = await readPrinter(caller, printerId)
  if (printer.siteId !== workOrder.siteId || printer.kind !== 'LABEL_ZPL') {
    throw new ValidationError('Tickets print on a label printer of the work order’s site.', [{ path: 'body/printerId', message: 'Pick a label printer of this site, or null to print the tickets as PDF.' }])
  }
  if (!can(actorOf(context), PRINT_LABELS, { companyId: printer.companyId, siteId: printer.siteId })) throw new ForbiddenError()
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`Printer ${printer.code} is ${printer.status.toLowerCase()}; it takes no tickets now. Pick another, or print the tickets as PDF.`)
  return { printer, problem: null }
}

export interface TicketAnswer {
  readonly bundleId: string
  readonly code: string
  readonly ticket: BundleTicket
  /** The BUNDLE label for the browser's PDF (POST /print/labels/pdf). */
  readonly label: LabelInput
  /** The queued print job, or null (no printer, or why not in `problem`). */
  readonly job: PrintJobView | null
  readonly problem: string | null
}

/**
 * Queues each ticket on the printer (after the command), once per ticket code. A ticket whose code is no longer its
 * bundle's (a replayed request after a reprint) or whose bundle is void is never printed: two tickets of one code, or a
 * replaced code on paper, would defeat MES-073.
 */
async function printTickets(caller: CommandCaller, target: TicketPrinter, tickets: readonly { readonly bundleId: string; readonly ticket: BundleTicket }[]): Promise<TicketAnswer[]> {
  const context = workerOf(caller)
  const tag = tenantTag(context.tenantId)
  const current = new Map(
    (await caller.withClient((client) => client.bundle.findMany({ where: { id: { in: tickets.map((ticket) => ticket.bundleId) } }, select: { id: true, code: true, status: true } }))).map((row) => [row.id, row]),
  )
  const answers: TicketAnswer[] = []
  for (const { bundleId, ticket } of tickets) {
    const label = ticketLabel(ticket)
    const now = current.get(bundleId)
    const stale = !now ? 'This bundle is not found.' : now.status === 'VOID' ? `Bundle ${now.code} is voided: its ticket is not printed.` : now.code !== ticket.code ? `Ticket ${ticket.code} was replaced by ${now.code}: it is not printed again.` : null
    if (stale || !target.printer) {
      answers.push({ bundleId, code: ticket.code, ticket, label, job: null, problem: stale ?? target.problem })
      continue
    }
    try {
      const job = await queueModuleLabel(
        caller,
        { printerId: target.printer.id, recordType: 'Bundle', recordId: bundleId, copies: 1, labelKind: 'BUNDLE', scanId: ticket.code, zplFor: (stock) => bundleTicketZpl(ticket, stock, 1, { tenantTag: tag }) },
        `bundle-ticket:${bundleId}:${ticket.code}`,
      )
      answers.push({ bundleId, code: ticket.code, ticket, label, job, problem: null })
    } catch (error) {
      // The bundle stands; the ticket is printed again later (or as PDF). Only the print module's refusals are words.
      if (!(error instanceof DomainError)) throw error
      answers.push({ bundleId, code: ticket.code, ticket, label, job: null, problem: error.message })
    }
  }
  return answers
}

/**
 * The site's floor is ready for real work (B-W1-36, B-W1-37), or a 409 in the gate's words. The gate reads the DPIA and
 * the legal basis, which the floor role may not: it runs in the tenant's system context (codes.ts asTenantSystem).
 */
async function assertFloorReady(caller: CommandCaller, context: FloorContext, siteId: string): Promise<void> {
  const refusal = bundlesReadyRefusal(await asTenantSystem(caller, context).withClient((client) => floorReadinessFor(client, siteId, serverClock.now())))
  if (refusal) refused(refusal)
}

// ---- make ---------------------------------------------------------------------------------------------------------------------

export interface MakeInput {
  /** Per cell (and part); absent: every cell's whole garments cut and not yet in bundles. */
  readonly cells?: readonly { readonly workOrderSizeId: string; readonly part?: string | null | undefined; readonly quantity?: number | undefined; readonly quantities?: readonly number[] | undefined; readonly bundleSize?: number | undefined }[] | undefined
  /** The target size (default 10; a made-to-measure work order: 1). */
  readonly bundleSize?: number | undefined
  /** The label printer; null: the tickets print as PDF; absent: the site's only label printer. */
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

async function makeInCommand(tools: CommandTools, workOrderId: string, body: MakeInput, codes: TicketCodes) {
  const context = tools.context as FloorContext
  const { tx } = tools
  await lockWorkOrderIssues(tx, context.tenantId, workOrderId)
  const workOrder = await readHeader(tx, workOrderId)
  if (!workOrder || !mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Work order not found.')
  const labels = await readCellLabels(tx, workOrder.id)
  const asks: BundleAsk[] | null = body.cells ? body.cells.map((cell) => ({ cellId: cell.workOrderSizeId, part: cell.part, quantity: cell.quantity, quantities: cell.quantities, bundleSize: cell.bundleSize })) : null
  await lockCells(tx, context.tenantId, workOrder.siteId, asks ? asks.map((ask) => ask.cellId).filter((id) => labels.has(id)) : [...labels.keys()])
  // Who it names: the site's floor rules (409 in words; at a station site nobody).
  const subject = await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId: await deviceStationOf(tx, context.deviceId) })
  const createdById = subject.workerId ? context.actorId : null

  const before = activeCounts(await readBundles(tx, workOrder.id))
  const { cut, cells } = await countsOf(tx, workOrder, before)
  const plan = planBundles({
    workOrder,
    cells: cells.map((cell) => {
      const label = labels.get(cell.cellId)
      return { ...cell, label: label ? cellLabel(label.colourwayCode, label.size) : cell.cellId }
    }),
    asks,
    bundleSize: body.bundleSize,
  })
  if (!plan.ok) return refused(plan.refusal)

  const taken = await codes.take(tx, plan.bundles.length)
  const entriesOf = new Map(cut.map((cell) => [cell.workOrderSizeId, cell.cutLogIds]))
  const rows = plan.bundles.map((bundle, index) => ({
    id: newId(),
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
    workOrderSizeId: bundle.cellId,
    code: taken[index]!,
    quantity: bundle.quantity,
    part: bundle.part,
    // Genealogy: every live entry that cut pieces for the cell (the cut module refuses to reverse one while it is named).
    cutLogIds: [...(entriesOf.get(bundle.cellId) ?? [])],
    deviceId: context.deviceId,
    createdAt: tools.now,
    updatedAt: tools.now,
    createdById,
  }))
  await tx.bundle.createMany({ data: rows })

  const event = { subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId }
  for (const row of rows) {
    tools.audit({
      recordType: 'Bundle',
      recordId: row.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      after: { workOrderId: workOrder.id, workOrderSizeId: row.workOrderSizeId, code: row.code, quantity: row.quantity, part: row.part, cutLogIds: row.cutLogIds, deviceId: row.deviceId },
    })
    tools.emit({
      ...event,
      type: 'production.bundle_created',
      payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: row.id, code: row.code, workOrderSizeId: row.workOrderSizeId, part: row.part, quantity: row.quantity, postedBy: 'FLOOR' },
    })
  }
  tools.audit({
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: { bundles: rows.map((row) => ({ bundleId: row.id, code: row.code, workOrderSizeId: row.workOrderSizeId, part: row.part, quantity: row.quantity })) },
  })

  const base = await ticketBase(tx, workOrder, body.language ?? 'it')
  const after = [...before, ...plan.bundles.map((bundle) => ({ cellId: bundle.cellId, part: bundle.part, quantity: bundle.quantity }))]
  const stored = await tx.bundle.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: BUNDLE_COLUMNS })
  const byId = new Map(stored.map((row) => [row.id, row]))
  return {
    workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
    singlePiece: plan.singlePiece,
    bundles: rows.map((row) => bundleView(byId.get(row.id)!, labels)),
    tickets: rows.map((row) => ({ bundleId: row.id, ticket: ticketOf(base, row, labels) })),
    cells: (await countsOf(tx, workOrder, after)).cells.filter((cell) => cell.cut !== null).map((cell) => cellView(cell, labels.get(cell.cellId))),
  }
}

/** The floor's "make bundles and print their tickets": one command, then the tickets. */
export async function makeBundles(caller: CommandCaller, workOrderId: string, body: MakeInput, idempotencyKey?: string) {
  const context = floorOf(caller)
  const workOrder = await bundleWorkOrder(caller, workOrderId, PRODUCTION_BUNDLES)
  await assertFloorReady(caller, context, workOrder.siteId)
  const target = await ticketPrinter(caller, workOrder, body.printerId)
  const outcome = await withTicketCodes(caller, (codes) =>
    command(caller, { name: 'production.makeBundles', idempotencyKey, input: { workOrderId, ...body } }, (tools) => makeInCommand(tools, workOrderId, body, codes)),
  )
  const { tickets, ...made } = outcome.result
  return { ...made, tickets: await printTickets(caller, target, tickets), replayed: outcome.replayed }
}

// ---- reprint and void -----------------------------------------------------------------------------------------------------

/** The bundle a reprint or void names, visible to the caller with the permission (else not found). */
async function namedBundle(caller: CommandCaller, bundleId: string): Promise<{ bundle: BundleRow; workOrder: BundleHeader }> {
  const context = workerOf(caller)
  const bundle = await caller.withClient((client) => readBundle(client, bundleId))
  const workOrder = bundle ? await caller.withClient((client) => readHeader(client, bundle.workOrderId)) : null
  if (!bundle || !workOrder || !mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Bundle not found.')
  return { bundle, workOrder }
}

const postedBy = (context: Worker) => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')

export interface ReprintInput {
  /** Why: lost, damaged, unreadable … (kept in the audit row). */
  readonly reason: string
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

async function reprintInCommand(tools: CommandTools, bundleId: string, body: ReprintInput, codes: TicketCodes) {
  const context = tools.context as Worker
  const { tx } = tools
  const bundle = await lockBundle(tx, bundleId)
  if (!bundle) throw new NotFoundError('Bundle not found.')
  const workOrder = (await readHeader(tx, bundle.workOrderId))!
  const refusal = reprintRefusal({ bundle, workOrder })
  if (refusal) refused(refusal)
  const [code] = await codes.take(tx, 1)
  await tx.bundle.update({ where: { id: bundle.id }, data: { code: code!, replacedCodes: [...bundle.replacedCodes, bundle.code], version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  const reason = body.reason.trim()
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  tools.audit({ recordType: 'Bundle', recordId: bundle.id, ...scope, before: { code: bundle.code, replacedCodes: bundle.replacedCodes }, after: { code, replacedCodes: [...bundle.replacedCodes, bundle.code] }, reason })
  tools.audit({ recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { bundleId: bundle.id, code, replacedCode: bundle.code }, reason })
  tools.emit({ type: 'production.bundle_reprinted', subject: workOrder.id, ...scope, payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: bundle.id, code: code!, replacedCode: bundle.code, postedBy: postedBy(context) } })
  const labels = await readCellLabels(tx, workOrder.id)
  const after = (await readBundle(tx, bundle.id))!
  return { bundle: bundleView(after, labels), replacedCode: bundle.code, ticket: { bundleId: bundle.id, ticket: ticketOf(await ticketBase(tx, workOrder, body.language ?? 'it'), after, labels) } }
}

/** A lost or damaged ticket printed again with a new code (MES-073): the old code is refused when scanned. */
export async function reprintBundle(caller: CommandCaller, bundleId: string, body: ReprintInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  const { workOrder } = await namedBundle(caller, bundleId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, workOrder.siteId)
  const target = await ticketPrinter(caller, workOrder, body.printerId)
  const outcome = await withTicketCodes(caller, (codes) =>
    command(caller, { name: 'production.reprintBundle', idempotencyKey, input: { bundleId, ...body } }, (tools) => reprintInCommand(tools, bundleId, body, codes)),
  )
  const { ticket, ...reprinted } = outcome.result
  const [answer] = await printTickets(caller, target, [ticket])
  return { ...reprinted, ticket: answer!, replayed: outcome.replayed }
}

/** A bundle made by mistake voided, before any scan names it, with the reason: its garments are to bundle again. */
export async function voidBundle(caller: CommandCaller, bundleId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const context = workerOf(caller)
  await namedBundle(caller, bundleId)
  const reason = body.reason.trim()
  const { result, replayed } = await command(caller, { name: 'production.voidBundle', idempotencyKey, input: { bundleId, reason } }, async (tools) => {
    const { tx } = tools
    // The row locked first: a scan that locked it FOR SHARE before is committed, and counted here (lockBundleForScan).
    const bundle = await lockBundle(tx, bundleId)
    if (!bundle) throw new NotFoundError('Bundle not found.')
    const workOrder = (await readHeader(tx, bundle.workOrderId))!
    const refusal = voidRefusal({ bundle, workOrder, scans: await countScans(tx, bundle.id) })
    if (refusal) refused(refusal)
    await tx.bundle.update({ where: { id: bundle.id }, data: { status: 'VOID', voidedAt: tools.now, voidReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
    tools.audit({ recordType: 'Bundle', recordId: bundle.id, ...scope, before: { status: bundle.status }, after: { status: 'VOID', code: bundle.code, quantity: bundle.quantity }, reason })
    tools.audit({ recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { bundleId: bundle.id, code: bundle.code, voided: true }, reason })
    tools.emit({
      type: 'production.bundle_voided',
      subject: workOrder.id,
      ...scope,
      payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: bundle.id, code: bundle.code, workOrderSizeId: bundle.workOrderSizeId, quantity: bundle.quantity, postedBy: postedBy(context) },
    })
    const labels = await readCellLabels(tx, workOrder.id)
    const cell = (await countsOf(tx, workOrder)).cells.find((row) => row.cellId === bundle.workOrderSizeId)!
    return { bundle: bundleView((await readBundle(tx, bundle.id))!, labels), cell: cellView(cell, labels.get(cell.cellId)) }
  })
  return { ...result, replayed }
}
