import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_TROLLEYS } from '@nexus/factory-domain/production/cutissue/permissions'
import type { SecondaryKind } from '@nexus/factory-domain/production/cutissue/secondary'
import {
  bundleLoadRefusal,
  differencesText,
  lineOfLoad,
  lineRefusal,
  lineWarnings,
  nextTrolleyStep,
  OPEN_CUT_ISSUE_STATUSES,
  receiveRefusal,
  sendRefusal,
  sendWords,
  TROLLEY_LIMITS,
  trolleyCodeOf,
  trolleyCodeProblem,
  trolleyLoadRefusal,
  unloadRefusal,
  type CutIssueStatus,
  type TrolleyWarning,
} from '@nexus/factory-domain/production/cutissue/trolley'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { assertFloorReady } from '../bundles/bundles'
import { may, officeOf, refuse, seen, workerOf } from './access'
import { emitIssue } from './emit'
import { deviceStation, findBundle, readBundles, readCells, readLines, readOrder, readOrders, readProcesses, trolleyOfBundles, type Reader } from './store'

/**
 * Cut issue to sewing (B-W2b-117; MES-048; design floor.fabriccut "Send to sewing"; rules factory-domain production/cutissue/trolley):
 * bundles scanned onto a trolley, the trolley sent to a sewing line, and the line confirming it by scanning the trolley's label.
 * The writes name the trolley by its label (never an id the tablet could not know offline), so the floor queue carries them
 * (platform/floor-sync kinds production.trolley.load|unload|send|receive).
 *
 *   GET  /production/trolleys                office (production.cutting.view): every trolley, newest first; tiles
 *   GET  /production/trolleys/:issueId       office (production.cutting.view): one trolley with its bundles
 *   GET  /production/trolleys/open           office + floor (production.trolleys): the site's trolleys loading or on their way
 *                                            (a tablet on a line: those coming to its line first)
 *   GET  /production/trolleys/scan?code=     office + floor (production.trolleys): the trolley's open issue and what the scan does
 *   POST /production/trolleys/load           a bundle scanned onto the trolley (a new LOADING issue when none is open)
 *   POST /production/trolleys/unload         a bundle taken off while loading
 *   POST /production/trolleys/send           LOADING → SENT (the line may change until then)
 *   POST /production/trolleys/receive        at the line: SENT → RECEIVED, each bundle received but those named missing
 *   POST /production/trolleys/:issueId/cancel  LOADING → CANCELLED with the reason
 *
 * Each write is ONE command (a tablet's with its Idempotency-Key) under the trolley label's lock (one open issue per label at the
 * site) and, for a load, the bundle's (one open trolley per bundle); audited (the trolley, the bundle) with cut_issue.changed. No
 * worker is named; no money.
 */

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

const ISSUE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  trolleyCode: true,
  lineId: true,
  status: true,
  sentAt: true,
  receivedAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.CutIssueSelect
type IssueRow = Prisma.CutIssueGetPayload<{ select: typeof ISSUE_COLUMNS }>

const LINE_COLUMNS = { id: true, cutIssueId: true, workOrderId: true, bundleId: true, receivedAt: true, createdAt: true } as const satisfies Prisma.CutIssueLineSelect
type LineRow = Prisma.CutIssueLineGetPayload<{ select: typeof LINE_COLUMNS }>

async function readIssueLines(db: Reader, issueIds: readonly string[]): Promise<LineRow[]> {
  if (issueIds.length === 0) return []
  return db.cutIssueLine.findMany({ where: { cutIssueId: { in: [...issueIds] } }, select: LINE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

/** The views of trolleys: the line, the counts, the send words and (with `withBundles`) each bundle on it. */
async function issueViews(db: Reader, rows: readonly IssueRow[], withBundles: boolean) {
  const lines = await readIssueLines(db, rows.map((row) => row.id))
  const [sewingLines, bundles, orders] = await Promise.all([readLines(db, rows.map((row) => row.lineId)), withBundles ? readBundles(db, lines.map((line) => line.bundleId)) : Promise.resolve(new Map()), withBundles ? readOrders(db, lines.map((line) => line.workOrderId)) : Promise.resolve(new Map())])
  const cells = withBundles ? await readCells(db, [...bundles.values()].map((bundle) => bundle.workOrderSizeId)) : new Map()
  return rows.map((row) => {
    const own = lines.filter((line) => line.cutIssueId === row.id)
    const line = sewingLines.get(row.lineId)
    const received = own.filter((entry) => entry.receivedAt !== null).length
    const lineCode = line?.code ?? ''
    return {
      id: row.id,
      trolleyCode: row.trolleyCode,
      status: row.status as CutIssueStatus,
      line: { id: row.lineId, code: lineCode, name: line?.name ?? '' },
      sentAt: at(row.sentAt),
      receivedAt: at(row.receivedAt),
      cancelledAt: at(row.cancelledAt),
      cancelReason: row.cancelReason,
      /** The differences found at the line, in words. */
      note: row.note,
      counts: { bundles: own.length, received, missing: row.status === 'RECEIVED' ? own.length - received : 0 },
      send: { it: sendWords(own.length, lineCode, 'it'), en: sendWords(own.length, lineCode, 'en') },
      bundles: withBundles
        ? own.map((entry) => {
            const bundle = bundles.get(entry.bundleId)
            const cell = bundle ? cells.get(bundle.workOrderSizeId) : undefined
            return {
              id: entry.id,
              bundle: { id: entry.bundleId, code: bundle?.code ?? '', part: bundle?.part ?? null, quantity: bundle?.quantity ?? 0 },
              workOrder: { id: entry.workOrderId, number: orders.get(entry.workOrderId)?.number ?? '' },
              cell: { colourwayCode: cell?.colourwayCode ?? '', size: cell?.size ?? '' },
              receivedAt: at(entry.receivedAt),
            }
          })
        : [],
      createdAt: toUtcIso(row.createdAt),
      version: row.version,
    }
  })
}
type IssueView = Awaited<ReturnType<typeof issueViews>>[number]

const viewOf = async (db: Reader, row: IssueRow): Promise<IssueView> => (await issueViews(db, [row], true))[0]!

async function readIssue(db: Reader, issueId: string): Promise<IssueRow | null> {
  if (!isUuid(issueId)) return null
  return db.cutIssue.findUnique({ where: { id: issueId }, select: ISSUE_COLUMNS })
}

/** The trolley's open issue at the site (LOADING or SENT), the newest. */
async function openIssueOf(db: Reader, siteId: string, trolleyCode: string): Promise<IssueRow | null> {
  return db.cutIssue.findFirst({ where: { siteId, trolleyCode, status: { in: [...OPEN_CUT_ISSUE_STATUSES] } }, select: ISSUE_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

const openFacts = (issue: IssueRow | null, bundles: number) => (issue ? { trolleyCode: issue.trolleyCode, status: issue.status as CutIssueStatus, bundles } : null)

/** A trolley label as scanned: upper case, or a 400 in words. */
function codeOf(raw: string, path: string): string {
  const code = trolleyCodeOf(raw)
  const problem = trolleyCodeProblem(code)
  if (problem) throw new ValidationError(problem, [{ path, message: problem }])
  return code
}

// ---- reads ----------------------------------------------------------------------------------------------------------------------

export const TROLLEY_VIEWS = ['open', 'loading', 'sent', 'received', 'cancelled', 'all'] as const
export type TrolleyListView = (typeof TROLLEY_VIEWS)[number]
const VIEW_STATUSES: Record<TrolleyListView, readonly CutIssueStatus[] | null> = { open: ['LOADING', 'SENT'], loading: ['LOADING'], sent: ['SENT'], received: ['RECEIVED'], cancelled: ['CANCELLED'], all: null }

export interface TrolleyListQuery {
  readonly view?: TrolleyListView | undefined
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** GET /production/trolleys: the office's list, newest first, with a tile per status. */
export async function listTrolleys(caller: CommandCaller, query: TrolleyListQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.CutIssueWhereInput
  const limit = Math.min(query.limit ?? 50, TROLLEY_LIMITS.rows)
  const q = query.q?.trim().toUpperCase()
  const base: Prisma.CutIssueWhereInput[] = [
    scope,
    query.siteId ? { siteId: query.siteId } : {},
    query.lineId ? { lineId: query.lineId } : {},
    q ? { OR: [{ trolleyCode: { contains: q } }, { lines: { some: { bundle: { is: { code: { contains: q } } } } } }] } : {},
  ]
  const statuses = VIEW_STATUSES[query.view ?? 'open']
  return caller.withClient(async (db) => {
    const rows = await db.cutIssue.findMany({ where: { AND: [...base, statuses ? { status: { in: [...statuses] } } : {}, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}] }, select: ISSUE_COLUMNS, orderBy: { id: 'desc' }, take: limit + 1 })
    const page = rows.slice(0, limit)
    const counts = await db.cutIssue.groupBy({ by: ['status'], where: { AND: base }, _count: { _all: true } })
    const count = (status: CutIssueStatus) => counts.find((row) => row.status === status)?._count._all ?? 0
    return { rows: await issueViews(db, page, false), nextCursor: rows.length > limit ? page.at(-1)!.id : null, tiles: { loading: count('LOADING'), sent: count('SENT'), received: count('RECEIVED'), cancelled: count('CANCELLED') } }
  })
}

/** GET /production/trolleys/:issueId: one trolley with its bundles (office). */
export async function trolleyRecord(caller: CommandCaller, issueId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ trolley: await viewOf(db, seen(context, PRODUCTION_CUTTING_VIEW, await readIssue(db, issueId), 'Trolley')) }))
}

/** GET /production/trolleys/open: the site's trolleys loading or on their way; a tablet on a line sees those coming to it first. */
export async function openTrolleys(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }) {
  const context = workerOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_TROLLEYS, { company: 'companyId', site: 'siteId' }) as Prisma.CutIssueWhereInput
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  return caller.withClient(async (db) => {
    const station = context.audience === 'floor' ? await deviceStation(db, context.deviceId) : null
    const here = station?.lineId ? ((await readLines(db, [station.lineId])).get(station.lineId) ?? null) : null
    const rows = await db.cutIssue.findMany({ where: { AND: [scope, siteId ? { siteId } : {}, query.lineId ? { lineId: query.lineId } : {}, { status: { in: [...OPEN_CUT_ISSUE_STATUSES] } }] }, select: ISSUE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: TROLLEY_LIMITS.rows })
    const views = await issueViews(db, rows, true)
    const mine = (view: IssueView) => (here && view.status === 'SENT' && view.line.id === here.id ? 0 : 1)
    return { here: here ? { id: here.id, code: here.code, name: here.name } : null, rows: views.sort((a, b) => mine(a) - mine(b)) }
  })
}

/** GET /production/trolleys/scan?code=: the trolley's open issue at the site (none: a scan starts loading it) and what the scan does. */
export async function scanTrolley(caller: CommandCaller, query: { readonly code: string; readonly siteId?: string | undefined }) {
  const context = workerOf(caller)
  const code = codeOf(query.code, 'querystring/code')
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  if (!siteId) throw new ValidationError('Name the site of the trolley.', [{ path: 'querystring/siteId', message: 'The office names the site.' }])
  return caller.withClient(async (db) => {
    const issue = await openIssueOf(db, siteId, code)
    if (issue && !may(context, PRODUCTION_TROLLEYS, issue)) throw new NotFoundError('Trolley not found.')
    const view = issue ? await viewOf(db, issue) : null
    return { code, trolley: view, next: nextTrolleyStep(issue ? { status: issue.status as CutIssueStatus } : null) }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------------------

/** One open issue per trolley label at the site: the label's lock, then (a load) the bundle's. */
async function lockTrolley(tx: CommandTx, tenantId: string, siteId: string, code: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.trolley', ${tenantId}::uuid, ${siteId}::uuid, ${code}::text), 0))`
}
async function lockTrolleyBundle(tx: CommandTx, tenantId: string, bundleId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.trolley-bundle', ${tenantId}::uuid, ${bundleId}::uuid), 0))`
}

/** The issue's version moves with every change of it or its bundles (a list reads it). */
async function bump(tx: CommandTx, issueId: string, now: Date, data: Prisma.CutIssueUncheckedUpdateInput = {}): Promise<void> {
  await tx.cutIssue.update({ where: { id: issueId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
}

async function workOrdersOn(tx: CommandTx, issueId: string): Promise<{ ids: string[]; bundles: number }> {
  const lines = await readIssueLines(tx, [issueId])
  return { ids: [...new Set(lines.map((line) => line.workOrderId))], bundles: lines.length }
}

/** Where a write happens: the tablet's own site, or (the office) the site of the bundle or trolley named. */
function siteOf(context: OfficeContext | FloorContext, fallback: string | null): string {
  if (context.audience === 'floor') return context.siteId
  if (!fallback) throw new ValidationError('Name the site of the trolley.', [{ path: 'body/siteId', message: 'The office names the site.' }])
  return fallback
}

export interface LoadBody {
  /** The trolley's label ("T-3"). */
  readonly trolley: string
  /** The bundle's ticket code. */
  readonly bundle: string
  /** The line it goes to: a new trolley's (else the work order's planned line), or a change while it loads. */
  readonly lineId?: string | undefined
}

/** POST /production/trolleys/load: a bundle scanned onto the trolley. */
export async function loadTrolley(caller: CommandCaller, body: LoadBody, idempotencyKey?: string) {
  const context = workerOf(caller)
  const code = codeOf(body.trolley, 'body/trolley')
  const known = await caller.withClient(async (db) => {
    const bundle = await findBundle(db, { code: body.bundle })
    const order = bundle ? await readOrder(db, bundle.workOrderId) : null
    return { bundle, order: seen(context, PRODUCTION_TROLLEYS, order, 'Bundle') }
  })
  const siteId = siteOf(context, known.order.siteId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, siteId)
  const { result, replayed } = await command(caller, { name: 'production.loadTrolley', idempotencyKey, input: { ...body, trolley: code } }, async (tools) => loadInCommand(tools, context, siteId, code, known.bundle!.id, body.lineId))
  return { ...result, replayed }
}

async function loadInCommand(tools: CommandTools, context: OfficeContext | FloorContext, siteId: string, code: string, bundleId: string, lineId: string | undefined) {
  const { tx, now } = tools
  await lockTrolley(tx, context.tenantId, siteId, code)
  await lockTrolleyBundle(tx, context.tenantId, bundleId)
  const bundle = (await readBundles(tx, [bundleId])).get(bundleId)!
  const order = (await readOrder(tx, bundle.workOrderId))!
  if (order.siteId !== siteId) throw new NotFoundError('Bundle not found.')
  let issue = await openIssueOf(tx, siteId, code)
  const before = issue ? (await readIssueLines(tx, [issue.id])).length : 0
  const stop = trolleyLoadRefusal(openFacts(issue, before), code)
  if (stop) refuse(stop)
  const [pending, onTrolley] = await Promise.all([readProcesses(tx, [bundle.id], true), trolleyOfBundles(tx, [bundle.id])])
  const refusal = bundleLoadRefusal({ trolleyCode: code, workOrder: order, bundle: { code: bundle.code, status: bundle.status }, pending: pending.map((row) => ({ kind: row.kind as SecondaryKind })), onTrolley: onTrolley.get(bundle.id)?.trolleyCode ?? null })
  if (refusal) refuse(refusal)
  const wantedLine = lineOfLoad(lineId, issue ? issue.lineId : order.lineId)
  const lines = await readLines(tx, [wantedLine ?? '', order.lineId ?? ''].filter((value) => value !== ''))
  const line = wantedLine ? lines.get(wantedLine) : undefined
  if (wantedLine && !line) throw new ValidationError('Line not found.', [{ path: 'body/lineId', message: 'Name a line of the site.' }])
  const lineStop = lineRefusal(line ? { code: line.code, status: line.status, sameSite: line.siteId === siteId } : null)
  if (lineStop) refuse(lineStop)
  const scope = { companyId: order.companyId, siteId }
  let opened = false
  if (!issue) {
    const id = newId()
    await tx.cutIssue.create({ data: { id, companyId: order.companyId, siteId, trolleyCode: code, lineId: line!.id, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
    issue = (await readIssue(tx, id))!
    opened = true
    tools.audit({ action: 'production.loadTrolley', recordType: 'CutIssue', recordId: id, ...scope, after: { trolleyCode: code, lineId: line!.id, status: 'LOADING' } })
  } else if (issue.lineId !== line!.id) {
    await bump(tx, issue.id, now, { lineId: line!.id })
    tools.audit({ action: 'production.loadTrolley', recordType: 'CutIssue', recordId: issue.id, ...scope, before: { lineId: issue.lineId }, after: { lineId: line!.id } })
    emitIssue(tools, { ...issue, lineId: line!.id }, 'LINE_CHANGED', { workOrderIds: (await workOrdersOn(tx, issue.id)).ids, bundles: before })
  }
  await tx.cutIssueLine.create({ data: { id: newId(), siteId, cutIssueId: issue.id, workOrderId: bundle.workOrderId, bundleId: bundle.id, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
  if (!opened) await bump(tx, issue.id, now)
  const after = (await readIssue(tx, issue.id))!
  const on = await workOrdersOn(tx, issue.id)
  tools.audit({ action: 'production.loadTrolley', recordType: 'CutIssue', recordId: issue.id, ...scope, after: { loaded: { bundleId: bundle.id, code: bundle.code }, bundles: on.bundles } })
  tools.audit({ action: 'production.loadTrolley', recordType: 'Bundle', recordId: bundle.id, ...scope, after: { trolley: code, issueId: issue.id, lineId: after.lineId } })
  if (opened) emitIssue(tools, after, 'OPENED', { workOrderIds: on.ids, bundles: 0 })
  emitIssue(tools, after, 'LOADED', { bundleId: bundle.id, workOrderIds: on.ids, bundles: on.bundles })
  const plannedLine = order.lineId ? lines.get(order.lineId) : undefined
  const warnings: TrolleyWarning[] = lineWarnings({ id: after.lineId, code: line!.code }, { code: bundle.code }, plannedLine ? { id: plannedLine.id, code: plannedLine.code } : null)
  return { trolley: await viewOf(tx, after), warnings }
}

/** The trolley's open issue at the site, checked for the caller (404 when none is open or it is not theirs). */
async function knownOpen(caller: CommandCaller, context: OfficeContext | FloorContext, code: string, siteId: string | undefined): Promise<{ issue: IssueRow | null; siteId: string }> {
  const site = context.audience === 'floor' ? context.siteId : siteId
  if (!site) throw new ValidationError('Name the site of the trolley.', [{ path: 'body/siteId', message: 'The office names the site.' }])
  const issue = await caller.withClient((db) => openIssueOf(db, site, code))
  if (issue && !may(context, PRODUCTION_TROLLEYS, issue)) throw new NotFoundError('Trolley not found.')
  return { issue, siteId: site }
}

/** POST /production/trolleys/unload: a bundle taken off while the trolley loads (a wrong scan). */
export async function unloadTrolley(caller: CommandCaller, body: { readonly trolley: string; readonly bundle: string; readonly siteId?: string | undefined }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const code = codeOf(body.trolley, 'body/trolley')
  const { siteId } = await knownOpen(caller, context, code, body.siteId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, siteId)
  const { result, replayed } = await command(caller, { name: 'production.unloadTrolley', idempotencyKey, input: { ...body, trolley: code } }, async (tools) => {
    const { tx, now } = tools
    await lockTrolley(tx, context.tenantId, siteId, code)
    const issue = await openIssueOf(tx, siteId, code)
    const lines = issue ? await readIssueLines(tx, [issue.id]) : []
    const bundle = await findBundle(tx, { code: body.bundle })
    const entry = bundle ? lines.find((line) => line.bundleId === bundle.id) : undefined
    const refusal = unloadRefusal(openFacts(issue, lines.length), code, bundle?.code ?? body.bundle.trim().toUpperCase(), entry !== undefined)
    if (refusal) refuse(refusal)
    await tx.cutIssueLine.delete({ where: { id: entry!.id }, select: { id: true } })
    await bump(tx, issue!.id, now)
    const after = (await readIssue(tx, issue!.id))!
    const on = await workOrdersOn(tx, issue!.id)
    tools.audit({ action: 'production.unloadTrolley', recordType: 'CutIssue', recordId: issue!.id, companyId: issue!.companyId, siteId, after: { unloaded: { bundleId: bundle!.id, code: bundle!.code }, bundles: on.bundles } })
    emitIssue(tools, after, 'UNLOADED', { bundleId: bundle!.id, workOrderIds: [...on.ids, bundle!.workOrderId], bundles: on.bundles })
    return { trolley: await viewOf(tx, after) }
  })
  return { ...result, replayed }
}

/** POST /production/trolleys/send: LOADING → SENT, to the line named (a change while loading) or its own. */
export async function sendTrolley(caller: CommandCaller, body: { readonly trolley: string; readonly lineId?: string | undefined; readonly siteId?: string | undefined }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const code = codeOf(body.trolley, 'body/trolley')
  const { siteId } = await knownOpen(caller, context, code, body.siteId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, siteId)
  const { result, replayed } = await command(caller, { name: 'production.sendTrolley', idempotencyKey, input: { ...body, trolley: code } }, async (tools) => {
    const { tx, now } = tools
    await lockTrolley(tx, context.tenantId, siteId, code)
    const issue = await openIssueOf(tx, siteId, code)
    const on = issue ? await workOrdersOn(tx, issue.id) : { ids: [], bundles: 0 }
    const refusal = sendRefusal(openFacts(issue, on.bundles), code)
    if (refusal) refuse(refusal)
    const lineId = body.lineId ?? issue!.lineId
    const line = (await readLines(tx, [lineId])).get(lineId)
    if (!line) throw new ValidationError('Line not found.', [{ path: 'body/lineId', message: 'Name a line of the site.' }])
    const lineStop = lineRefusal({ code: line.code, status: line.status, sameSite: line.siteId === siteId })
    if (lineStop) refuse(lineStop)
    // Every bundle on it is still live and past its processes (one may have been voided or given a process since it was loaded).
    const lines = await readIssueLines(tx, [issue!.id])
    const [bundles, orders, pending] = await Promise.all([readBundles(tx, lines.map((entry) => entry.bundleId)), readOrders(tx, lines.map((entry) => entry.workOrderId)), readProcesses(tx, lines.map((entry) => entry.bundleId), true)])
    for (const entry of lines) {
      const bundle = bundles.get(entry.bundleId)!
      const stop = bundleLoadRefusal({ trolleyCode: code, workOrder: orders.get(entry.workOrderId)!, bundle: { code: bundle.code, status: bundle.status }, pending: pending.filter((row) => row.bundleId === bundle.id).map((row) => ({ kind: row.kind as SecondaryKind })), onTrolley: null })
      if (stop) refuse(stop)
    }
    await bump(tx, issue!.id, now, { status: 'SENT', sentAt: now, ...(lineId !== issue!.lineId ? { lineId } : {}) })
    const after = (await readIssue(tx, issue!.id))!
    tools.audit({ action: 'production.sendTrolley', recordType: 'CutIssue', recordId: issue!.id, companyId: issue!.companyId, siteId, before: { status: issue!.status, lineId: issue!.lineId }, after: { status: 'SENT', lineId, bundles: on.bundles } })
    emitIssue(tools, after, 'SENT', { workOrderIds: on.ids, bundles: on.bundles })
    return { trolley: await viewOf(tx, after) }
  })
  return { ...result, replayed }
}

/** POST /production/trolleys/receive: the line scans the trolley's label; each bundle is received but those named missing. */
export async function receiveTrolley(caller: CommandCaller, body: { readonly trolley: string; readonly missing?: readonly string[] | undefined; readonly siteId?: string | undefined }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const code = codeOf(body.trolley, 'body/trolley')
  const { siteId } = await knownOpen(caller, context, code, body.siteId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, siteId)
  const here = context.audience === 'floor' ? await caller.withClient(async (db) => {
    const station = await deviceStation(db, context.deviceId)
    return station?.lineId ? ((await readLines(db, [station.lineId])).get(station.lineId) ?? null) : null
  }) : null
  const { result, replayed } = await command(caller, { name: 'production.receiveTrolley', idempotencyKey, input: { ...body, trolley: code } }, async (tools) => {
    const { tx, now } = tools
    await lockTrolley(tx, context.tenantId, siteId, code)
    const issue = await openIssueOf(tx, siteId, code)
    const lines = issue ? await readIssueLines(tx, [issue.id]) : []
    const trolleyLine = issue ? ((await readLines(tx, [issue.lineId])).get(issue.lineId) ?? null) : null
    const refusal = receiveRefusal(openFacts(issue, lines.length), code, trolleyLine ? { id: trolleyLine.id, code: trolleyLine.code } : null, here ? { id: here.id, code: here.code } : null)
    if (refusal) refuse(refusal)
    const bundles = await readBundles(tx, lines.map((entry) => entry.bundleId))
    const named = [...new Set((body.missing ?? []).map((value) => value.trim().toUpperCase()).filter((value) => value !== ''))]
    const byCode = new Map([...bundles.values()].flatMap((bundle) => [bundle.code, ...bundle.replacedCodes].map((value) => [value, bundle] as const)))
    const missing = lines.filter((entry) => named.some((value) => byCode.get(value)?.id === entry.bundleId))
    const unknown = named.filter((value) => !lines.some((entry) => byCode.get(value)?.id === entry.bundleId))
    for (const entry of lines) {
      if (missing.includes(entry)) continue
      await tx.cutIssueLine.update({ where: { id: entry.id }, data: { receivedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    const note = differencesText(missing.map((entry) => bundles.get(entry.bundleId)!.code), unknown)
    await bump(tx, issue!.id, now, { status: 'RECEIVED', receivedAt: now, note })
    const after = (await readIssue(tx, issue!.id))!
    const on = await workOrdersOn(tx, issue!.id)
    tools.audit({
      action: 'production.receiveTrolley',
      recordType: 'CutIssue',
      recordId: issue!.id,
      companyId: issue!.companyId,
      siteId,
      before: { status: issue!.status },
      after: { status: 'RECEIVED', lineId: issue!.lineId, received: lines.length - missing.length, missing: missing.map((entry) => bundles.get(entry.bundleId)!.code), notOnIt: unknown },
    })
    emitIssue(tools, after, 'RECEIVED', { workOrderIds: on.ids, bundles: on.bundles, missing: missing.length })
    return { trolley: await viewOf(tx, after), differences: note }
  })
  return { ...result, replayed }
}

/** POST /production/trolleys/:issueId/cancel: a trolley loaded by mistake (LOADING only), with the reason; its bundles are free. */
export async function cancelTrolley(caller: CommandCaller, issueId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const known = seen(context, PRODUCTION_TROLLEYS, await caller.withClient((db) => readIssue(db, issueId)), 'Trolley')
  if (known.status !== 'LOADING') refuse({ code: 'TROLLEY_NOT_LOADING', message: `Trolley ${known.trolleyCode} is ${known.status.toLowerCase()}: only a trolley still loading is cancelled.` })
  const { result } = await command(caller, { name: 'production.cancelTrolley', idempotencyKey, input: { issueId, ...body }, record: { type: 'CutIssue', id: issueId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockTrolley(tx, context.tenantId, known.siteId, known.trolleyCode)
    const current = (await readIssue(tx, issueId))!
    if (current.status !== 'LOADING') refuse({ code: 'TROLLEY_NOT_LOADING', message: `Trolley ${current.trolleyCode} is ${current.status.toLowerCase()}: only a trolley still loading is cancelled.` })
    const reason = body.reason.trim()
    await tx.cutIssue.update({ where: { id: issueId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: { id: true } })
    const after = (await readIssue(tx, issueId))!
    const on = await workOrdersOn(tx, issueId)
    tools.audit({ action: 'production.cancelTrolley', recordType: 'CutIssue', recordId: issueId, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'CANCELLED', bundles: on.bundles }, reason })
    emitIssue(tools, after, 'CANCELLED', { workOrderIds: on.ids, bundles: on.bundles })
    return { trolley: await viewOf(tx, after) }
  })
  return result
}
