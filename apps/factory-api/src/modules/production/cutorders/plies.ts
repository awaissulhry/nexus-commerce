import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Language } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUT } from '@nexus/factory-domain/production/cutting/permissions'
import {
  defaultParts,
  MAX_STICKERS_PER_RUN,
  PLY_LABEL_KIND,
  partsProblems,
  plyRunRefusal,
  plyRunZpl,
  stickerLines,
  stickersOf,
  stickersPerPly,
  type PlyLine,
} from '@nexus/factory-domain/production/cutorders/plies'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { invalid, may, refuse, workerOf } from './access'
import { emitPlyRun } from './emit'
import { jobKey, labelTarget, queueLabel } from './printing'
import { plyLinesOf, PLY_RUN_COLUMNS, readCutOrder, readLines, type CutOrderRow, type LayRow, LAY_COLUMNS, type PlyRunRow } from './store'
import { plyRunView } from './views'

/**
 * Ply (shade) numbering (B-W2b-112; MES-043; design floor.fabriccut "Ply stickers"): once a lay is counted at both ends, the
 * table (or the office) numbers its plies with a run of stickers — every piece of a ply gets the ply's number, its size, which
 * garment of the size and the part, so sewing joins only pieces of one ply (one shade). The run is ONE command (PlyRun PLANNED,
 * its stickers counted from the lines' ratios and the pattern pieces of the material); it is then printed on the label printer
 * of the device's station (else the table's, else the site's only one) as ZPL, label kind PLY, and marked PRINTED. A misprint is
 * voided with the reason and a new run printed. production.cut, office and floor (a floor device: its own site). No person.
 */

/** The lay of a fabric cut order the caller may number (404 when it does not see it). */
async function layFor(caller: CommandCaller, layId: string): Promise<{ context: OfficeContext | FloorContext; lay: LayRow; order: CutOrderRow }> {
  const context = workerOf(caller)
  const found = await caller.withClient(async (db) => {
    const lay = isUuid(layId) ? await db.lay.findUnique({ where: { id: layId }, select: LAY_COLUMNS }) : null
    const order = lay ? await readCutOrder(db, lay.cutOrderId) : null
    return { lay, order }
  })
  if (!found.lay || !found.order || !may(context, PRODUCTION_CUT, found.order)) throw new NotFoundError('Lay not found.')
  return { context, lay: found.lay, order: found.order }
}

/** The ply runs of a lay take turns (seq and the plies numbered): a transaction-scoped advisory lock per lay. */
async function lockRuns(tx: CommandTx, tenantId: string, layId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ply-runs', ${tenantId}::uuid, ${layId}::uuid), 0))`
}

export interface MakeRunBody {
  readonly parts?: readonly string[] | undefined
  readonly firstPly?: number | undefined
  readonly lastPly?: number | undefined
  /** The label printer; null: not printed now (the stickers are shown); absent: the station's, else the table's, else the site's only one. */
  readonly printerId?: string | null | undefined
  readonly language?: Language | undefined
}

const runPreview = (lines: readonly PlyLine[], run: { readonly firstPly: number; readonly lastPly: number; readonly parts: readonly string[] }, header: { cutOrderNumber: string; laySeq: number }, language: Language) =>
  stickersOf({ firstPly: run.firstPly, lastPly: run.firstPly }, lines, run.parts).map((sticker) => stickerLines(sticker, header, language))

/** POST /production/lays/:layId/ply-runs: a run of ply stickers for a counted lay, printed when a label printer is there. */
export async function makePlyRun(caller: CommandCaller, layId: string, body: MakeRunBody, idempotencyKey?: string) {
  const { context, lay, order } = await layFor(caller, layId)
  if (order.kind !== 'FABRIC') refuse({ code: 'NOT_FABRIC', message: `Cut order ${order.number} cuts leather hide by hide: it has no plies to number.` })
  if (body.parts) {
    const problems = partsProblems(body.parts)
    if (problems.length > 0) invalid(problems, 'The parts are not valid.')
  }
  const language = body.language ?? 'it'
  const header = { cutOrderNumber: order.number, laySeq: lay.seq }

  const { result } = await command(caller, { name: 'production.makePlyRun', idempotencyKey, input: { layId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockRuns(tx, context.tenantId, layId)
    const current = (await tx.lay.findUniqueOrThrow({ where: { id: layId }, select: LAY_COLUMNS }))
    const counted = current.status === 'CHECKED' || current.status === 'CUT' ? current.plyCountLeft : null
    const lines = await plyLinesOf(tx, order, await readLines(tx, [order.id]))
    const parts = body.parts ? body.parts.map((part) => part.trim()) : defaultParts(lines)
    if (parts.length === 0) refuse({ code: 'NO_PARTS', message: `The pattern lists no pieces of ${order.item.code} for these sizes: name the parts to number.` })
    const perPly = stickersPerPly(lines, parts)
    const runs = await tx.plyRun.findMany({ where: { layId }, select: PLY_RUN_COLUMNS, orderBy: { seq: 'asc' } })
    const live = runs.filter((run) => run.status !== 'VOID')
    const firstPly = body.firstPly ?? Math.max(0, ...live.map((run) => run.lastPly)) + 1
    const room = perPly > 0 ? Math.max(1, Math.floor(MAX_STICKERS_PER_RUN / perPly)) : 1
    const lastPly = body.lastPly ?? Math.min(counted ?? firstPly, firstPly + room - 1)
    if (counted !== null && body.firstPly === undefined && firstPly > counted) refuse({ code: 'PLIES_NUMBERED', message: `Every ply of lay ${current.seq} (${counted}) is numbered: void a run to number its plies again.` })
    if (lastPly < firstPly) invalid([{ path: 'lastPly', message: 'The last ply is at least the first.' }], 'The plies are not valid.')
    const overlap = live.find((run) => run.firstPly <= lastPly && firstPly <= run.lastPly)
    if (overlap) refuse({ code: 'PLIES_NUMBERED', message: `Plies ${overlap.firstPly}–${overlap.lastPly} of lay ${current.seq} are numbered by run ${overlap.seq}: void it to number them again.` })
    const refusal = plyRunRefusal({ firstPly, lastPly, perPly }, { seq: current.seq, status: current.status, counted })
    if (refusal) refuse(refusal)
    const id = newId()
    const labelCount = (lastPly - firstPly + 1) * perPly
    await tx.plyRun.create({ data: { id, siteId: order.siteId, layId, seq: Math.max(0, ...runs.map((run) => run.seq)) + 1, firstPly, lastPly, parts, labelCount, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
    const run = await tx.plyRun.findUniqueOrThrow({ where: { id }, select: PLY_RUN_COLUMNS })
    tools.audit({ action: 'production.makePlyRun', recordType: 'PlyRun', recordId: id, companyId: order.companyId, siteId: order.siteId, after: { cutOrder: order.number, lay: current.seq, firstPly, lastPly, parts, labelCount } })
    emitPlyRun(tools, order, run, 'MADE')
    return { run: plyRunView(run), stickersPerPly: perPly, preview: runPreview(lines, run, header, language) }
  })
  const printed = await printRun(caller, context, order, lay.seq, result.run.id, body.printerId, language, idempotencyKey)
  return { ...result, run: printed.run ?? result.run, job: printed.job, problem: printed.problem }
}

/** Prints the run (when a printer is there) and marks it PRINTED; a run already printed gets its new print time. */
async function printRun(caller: CommandCaller, context: OfficeContext | FloorContext, order: CutOrderRow, laySeq: number, runId: string, printerId: string | null | undefined, language: Language, idempotencyKey: string | undefined) {
  const { run, lines } = await caller.withClient(async (db) => ({ run: await db.plyRun.findUniqueOrThrow({ where: { id: runId }, select: PLY_RUN_COLUMNS }), lines: await plyLinesOf(db, order, await readLines(db, [order.id])) }))
  const stickers = stickersOf(run, lines, run.parts)
  const target = await labelTarget(caller, context, { siteId: order.siteId, stationPrinterId: order.station?.labelPrinterId ?? null }, printerId)
  const header = { cutOrderNumber: order.number, laySeq }
  const queued = await queueLabel(
    caller,
    target,
    { recordType: 'PlyRun', recordId: run.id, kind: PLY_LABEL_KIND, scanId: `${order.number}-L${laySeq}-P${run.firstPly}-${run.lastPly}`, copies: 1, zplFor: (stock) => plyRunZpl(stickers, header, stock, language) },
    jobKey('ply-run', run.id, idempotencyKey),
  )
  if (!queued.job) return { run: null, job: null, problem: queued.problem }
  const { result } = await command(caller, { name: 'production.printPlyRun', idempotencyKey: idempotencyKey ? jobKey('printed', run.id, idempotencyKey) : undefined, input: { runId, jobId: queued.job.id }, record: { type: 'PlyRun', id: run.id } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.plyRun.findUniqueOrThrow({ where: { id: run.id }, select: PLY_RUN_COLUMNS })
    if (current.status === 'VOID') refuse({ code: 'RUN_VOID', message: `Run ${current.seq} was voided: print a new run.` })
    await tx.plyRun.update({ where: { id: run.id }, data: { status: 'PRINTED', printedAt: now, updatedAt: now }, select: { id: true } })
    const after = await tx.plyRun.findUniqueOrThrow({ where: { id: run.id }, select: PLY_RUN_COLUMNS })
    tools.audit({ action: 'production.printPlyRun', recordType: 'PlyRun', recordId: run.id, companyId: order.companyId, siteId: order.siteId, before: { status: current.status }, after: { status: 'PRINTED', jobId: queued.job!.id, labelCount: after.labelCount } })
    emitPlyRun(tools, order, after, 'PRINTED')
    return plyRunView(after)
  })
  return { run: result, job: queued.job, problem: null }
}

/** The run the caller may print, void or read (production.cut at its site). */
async function runFor(caller: CommandCaller, runId: string): Promise<{ context: OfficeContext | FloorContext; run: PlyRunRow; lay: LayRow; order: CutOrderRow }> {
  const context = workerOf(caller)
  const run = isUuid(runId) ? await caller.withClient((db) => db.plyRun.findUnique({ where: { id: runId }, select: PLY_RUN_COLUMNS })) : null
  if (!run) throw new NotFoundError('Ply run not found.')
  const { lay, order } = await layFor(caller, run.layId)
  return { context, run, lay, order }
}

/** POST /production/ply-runs/:runId/print: the run printed (again). */
export async function reprintPlyRun(caller: CommandCaller, runId: string, body: { readonly printerId?: string | null | undefined; readonly language?: Language | undefined }, idempotencyKey?: string) {
  const { context, run, lay, order } = await runFor(caller, runId)
  if (run.status === 'VOID') refuse({ code: 'RUN_VOID', message: `Run ${run.seq} of lay ${lay.seq} was voided: print a new run.` })
  const printed = await printRun(caller, context, order, lay.seq, run.id, body.printerId, body.language ?? 'it', idempotencyKey)
  return { run: printed.run ?? plyRunView(run), job: printed.job, problem: printed.problem }
}

/** POST /production/ply-runs/:runId/void: a misprinted run voided with the reason (a new run numbers its plies again). */
export async function voidPlyRun(caller: CommandCaller, runId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { run, lay, order } = await runFor(caller, runId)
  // A VOID run never changes, not even its version (the database's rule): refused in words before the bump.
  if (run.status === 'VOID') refuse({ code: 'RUN_VOID', message: `Run ${run.seq} of lay ${lay.seq} is voided already.` })
  const { result } = await command(caller, { name: 'production.voidPlyRun', idempotencyKey, input: { runId, ...body }, record: { type: 'PlyRun', id: runId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.plyRun.findUniqueOrThrow({ where: { id: runId }, select: PLY_RUN_COLUMNS })
    if (current.status === 'VOID') refuse({ code: 'RUN_VOID', message: `Run ${current.seq} of lay ${lay.seq} is voided already.` })
    const reason = body.reason.trim()
    await tx.plyRun.update({ where: { id: runId }, data: { status: 'VOID', voidedAt: now, voidReason: reason, updatedAt: now }, select: { id: true } })
    const after = await tx.plyRun.findUniqueOrThrow({ where: { id: runId }, select: PLY_RUN_COLUMNS })
    tools.audit({ action: 'production.voidPlyRun', recordType: 'PlyRun', recordId: runId, companyId: order.companyId, siteId: order.siteId, before: { status: current.status }, after: { status: 'VOID' }, reason })
    emitPlyRun(tools, order, after, 'VOIDED')
    return plyRunView(after)
  })
  return { run: result }
}

/** GET /production/ply-runs/:runId/stickers: every sticker of the run in words (the screen's LabelPreview), in order. */
export async function plyRunStickers(caller: CommandCaller, runId: string, query: { readonly language?: Language | undefined }) {
  const { run, lay, order } = await runFor(caller, runId)
  const lines = await caller.withClient(async (db) => plyLinesOf(db, order, await readLines(db, [order.id])))
  const header = { cutOrderNumber: order.number, laySeq: lay.seq }
  const language = query.language ?? 'it'
  return { run: plyRunView(run), stickers: stickersOf(run, lines, run.parts).map((sticker) => ({ ...sticker, lines: stickerLines(sticker, header, language) })) }
}
