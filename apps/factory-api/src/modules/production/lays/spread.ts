import type { Prisma } from '@nexus/factory-db'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { lengthIn, type LengthUom, type RollState } from '@nexus/factory-domain/inventory/rolls/rolls'
import { layMixRefusal, rollCheck, type AllocationWarning, type AllocRoll } from '@nexus/factory-domain/production/cutorders/allocation'
import { PRODUCTION_CUT } from '@nexus/factory-domain/production/cutting/permissions'
import type { LayChange } from '@nexus/factory-domain/production-lays/events'
import { atTableRefusal, countRefusal, endWarning, LAY_LIMITS, layLengthRefusal, pliesFromLength, pliesRefusal, rollUse, spreadProblems, stillNeeded, type LayWarning } from '@nexus/factory-domain/production/lays/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { activeHoldsOf } from '../../quality/holds/checks'
import { invalid, may, notFound, workerOf } from '../cutorders/access'
import { rejectedRolls, type LayRollRow } from '../cutorders/store'
import { assertFloorReady, refuse } from './access'
import { emitLay } from './emit'
import { markerOf, plyOf, readLayState, rollUom, usesElsewhere, type LayState } from './store'
import { layView, spreadPlies, tableFactsOf } from './views'

/**
 * The lay report at the table (B-W2b-116; MES-038; design floor.fabriccut "Spread the lay": "Scan each roll label → plies from this
 * roll (default = plies still needed), splices, end loss in metres, roll end returned. Running totals: plies, lay length, rolls
 * used. Undo last roll.") and the count at both ends (MES-039; "Count the plies at both ends": "Any difference blocks the cut").
 *
 *   POST /production/lays/:layId/spread                  start the lay from its started ticket (PLANNED → SPREADING: the rolls
 *                                                        the office allocated count as spread), with the lay's length on the
 *                                                        table (at least the marker's; default the marker)
 *   POST /production/lays/:layId/rolls                   a scanned roll (its label code, or its id) with its plies (default:
 *                                                        what the lay still needs, as far as the roll goes), splices, end loss
 *                                                        and roll end returned; a roll already on the lay (an allocation) is
 *                                                        confirmed or corrected
 *   POST /production/lays/:layId/rolls/:layRollId        a roll of the report corrected
 *   POST /production/lays/:layId/rolls/undo              Undo last roll
 *   POST /production/lays/:layId/count                   both ends counted: equal to each other and to the plies spread →
 *                                                        CHECKED; else refused in words and stored nowhere
 *
 * Office and floor (production.cut at the lay's site; a floor device at its own site, after the floor's readiness), each ONE
 * command on the lay (its version: the table's writes take turns; optional, a queued write applies to the lay as it stands),
 * audited, with lay.changed. A write while PLANNED starts the lay; a write after the count sends it back to SPREADING (the count
 * is taken again). Rules: factory-domain production/lays/rules and B-W2b-112's roll checks (production/cutorders/allocation): in
 * stock, not rejected, of an unheld usable lot, wide enough, ONE shade and ONE shrinkage group per lay. Nothing moves stock here:
 * the fabric is issued when its use is confirmed at cut finish (./fabric.ts). No worker is named.
 */

export interface TableSpec {
  readonly name: `${string}.${string}`
  readonly input: Record<string, unknown>
  readonly version?: number | undefined
}

/** One write of the table on a lay: found (404) and allowed (production.cut at its site) first, then ONE command on the lay. */
export async function tableCommand<T>(caller: CommandCaller, layId: string, spec: TableSpec, idempotencyKey: string | undefined, work: (tools: CommandTools, state: LayState, context: OfficeContext | FloorContext) => Promise<T>) {
  const context = workerOf(caller)
  const found = await caller.withClient((db) => readLayState(db, layId))
  if (!found || !may(context, PRODUCTION_CUT, found.order)) return notFound('Lay')
  if (context.audience === 'floor') await assertFloorReady(caller, context, found!.order.siteId)
  const { result, replayed } = await command(
    caller,
    { name: spec.name, idempotencyKey, input: { layId, ...spec.input }, record: { type: 'Lay', id: layId, ...(spec.version !== undefined ? { expectedVersion: spec.version } : {}) } },
    async (tools) => work(tools, (await readLayState(tools.tx, layId))!, context),
  )
  return { ...result, replayed }
}

/** The table may spread this lay now, or a refusal in words. */
function assertAtTable(state: LayState): void {
  const refusal = atTableRefusal(tableFactsOf(state))
  if (refusal) refuse(refusal)
}

interface LayLength {
  readonly length: string
  readonly uom: LengthUom
}

/** PLANNED → SPREADING (the lay starts), CHECKED → SPREADING (the count is taken again); the lay's length when given. */
async function toSpreading(tools: CommandTools, state: LayState, layLength: LayLength | null): Promise<LayChange | null> {
  const from = state.lay.status
  if (from !== 'PLANNED' && from !== 'CHECKED' && !layLength) return null
  const data: Prisma.LayUncheckedUpdateInput = { updatedAt: tools.now }
  if (from === 'PLANNED' || from === 'CHECKED') data.status = 'SPREADING'
  if (from === 'CHECKED') Object.assign(data, { plyCountLeft: null, plyCountRight: null, checkedAt: null })
  if (layLength) Object.assign(data, { layLength: new Dec(layLength.length).toFixed(4), lengthUom: layLength.uom })
  await tools.tx.lay.update({ where: { id: state.lay.id }, data, select: { id: true } })
  return from === 'PLANNED' ? 'SPREAD_STARTED' : from === 'CHECKED' ? 'BACK_TO_SPREADING' : null
}

const createdBy = (context: OfficeContext | FloorContext): string | null => (context.audience === 'office' ? context.actorId : null)

/** The lay as it stands after the command's writes, with the warnings of the write. */
async function answer(tools: CommandTools, layId: string, warnings: readonly (AllocationWarning | LayWarning)[] = []) {
  const unique = new Map(warnings.map((warning) => [`${warning.code}|${warning.message}`, warning]))
  return { ...layView((await readLayState(tools.tx, layId))!), warnings: [...unique.values()] }
}

// ---- start --------------------------------------------------------------------------------------------------------------------

export interface StartBody {
  readonly version?: number | undefined
  readonly layLength?: string | undefined
  readonly uom?: LengthUom | undefined
}

/** POST /production/lays/:layId/spread: the lay starts on the table (and its length on it). */
export async function startSpread(caller: CommandCaller, layId: string, body: StartBody, idempotencyKey?: string) {
  if ((body.layLength === undefined) !== (body.uom === undefined)) invalid([{ path: 'uom', message: "The lay's length is given with its unit (M, CM or MM)." }], "The lay's length is given with its unit.")
  return tableCommand(caller, layId, { name: 'production.startLay', input: { ...body }, version: body.version }, idempotencyKey, async (tools, state) => {
    assertAtTable(state)
    const marker = markerOf(state.order)!
    const layLength = body.layLength !== undefined ? { length: body.layLength.trim(), uom: body.uom! } : null
    if (layLength) {
      const wrong = layLengthRefusal(marker, layLength, state.lay.seq)
      if (wrong) refuse(wrong)
    }
    const change = await toSpreading(tools, state, layLength)
    const after = (await readLayState(tools.tx, layId))!
    // A longer ply takes more off each roll already on the lay: each must still have it.
    if (layLength) for (const row of after.rows) await assertRollHolds(tools, after, row)
    tools.audit({
      action: 'production.startLay',
      recordType: 'Lay',
      recordId: layId,
      companyId: state.order.companyId,
      siteId: state.order.siteId,
      before: { status: state.lay.status, layLength: state.lay.layLength?.toString() ?? null, lengthUom: state.lay.lengthUom },
      after: { cutOrder: state.order.number, lay: state.lay.seq, status: after.lay.status, layLength: after.lay.layLength?.toString() ?? null, lengthUom: after.lay.lengthUom, rolls: after.rows.length, plies: spreadPlies(after) },
    })
    if (change) emitLay(tools, state.order, after.lay, change, spreadPlies(after), after.rows.map((row) => row.rollId))
    return answer(tools, layId)
  })
}

/** A row's use still fits its roll (its length left less what other lays not yet issued take of it). */
async function assertRollHolds(tools: CommandTools, state: LayState, row: LayRollRow): Promise<void> {
  const elsewhere = (await usesElsewhere(tools.tx, [{ id: row.rollId, uom: row.roll.uom }], state.lay.id)).get(row.rollId) ?? ZERO
  const available = Dec.max(ZERO, new Dec(row.roll.lengthLeft.toString()).minus(elsewhere))
  const others = spreadPlies(state) - row.plies
  const wrong = pliesRefusal({ plies: row.plies, endLoss: new Dec(row.endLoss.toString()) }, { laySeq: state.lay.seq, planned: Math.max(state.lay.plies, spreadPlies(state)), others, rollCode: row.roll.code, available, ply: plyOf(state, rollUom(row.roll)), uom: rollUom(row.roll) })
  if (wrong) refuse(wrong)
}

// ---- a roll of the report -------------------------------------------------------------------------------------------------------

export interface RollFigures {
  readonly plies?: number | undefined
  readonly splices?: number | undefined
  readonly endLoss?: string | undefined
  readonly endReturned?: string | undefined
  /** The unit of endLoss and endReturned (default the roll's). */
  readonly uom?: LengthUom | undefined
}

export interface AddRollBody extends RollFigures {
  readonly version?: number | undefined
  /** The roll's label as scanned, or its id. */
  readonly code?: string | undefined
  readonly rollId?: string | undefined
}

const ROLL_COLUMNS = {
  id: true,
  code: true,
  siteId: true,
  itemId: true,
  lotId: true,
  state: true,
  uom: true,
  length: true,
  lengthLeft: true,
  widthCm: true,
  shade: true,
  shadeGroupId: true,
  shrinkageGroup: true,
  lot: { select: { code: true, qualityStatus: true, itemColourId: true } },
} as const satisfies Prisma.FabricRollSelect
type RollRow = Prisma.FabricRollGetPayload<{ select: typeof ROLL_COLUMNS }>

/** The figures of a roll in its own unit: what the body gives, else what the row had (or nothing). */
function figuresOf(body: RollFigures, uom: LengthUom, row: Pick<LayRollRow, 'splices' | 'endLoss' | 'endReturned'> | null) {
  const inRoll = (value: string | undefined, kept: { toString(): string } | null): string => (value !== undefined ? lengthIn(value.trim(), body.uom ?? uom, uom).toFixed(4) : kept ? new Dec(kept.toString()).toFixed(4) : '0.0000')
  return { splices: body.splices ?? row?.splices ?? 0, endLoss: inRoll(body.endLoss, row?.endLoss ?? null), endReturned: inRoll(body.endReturned, row?.endReturned ?? null) }
}

/**
 * The checks of one roll's figures on the lay (plies against the plan and the roll, lengths against the roll) and the warning of
 * its end; the plies default to what the lay still needs, as far as the roll goes.
 */
async function checkedFigures(tools: CommandTools, state: LayState, roll: { readonly id: string; readonly code: string; readonly uom: string; readonly length: { toString(): string }; readonly lengthLeft: { toString(): string } }, body: RollFigures, row: LayRollRow | null) {
  const uom = rollUom(roll)
  const figures = figuresOf(body, uom, row)
  const ply = plyOf(state, uom)
  const elsewhere = (await usesElsewhere(tools.tx, [{ id: roll.id, uom: roll.uom }], state.lay.id)).get(roll.id) ?? ZERO
  const available = Dec.max(ZERO, new Dec(roll.lengthLeft.toString()).minus(elsewhere))
  const others = state.rows.filter((entry) => entry.rollId !== roll.id).reduce((sum, entry) => sum + entry.plies, 0)
  const endLoss = new Dec(figures.endLoss)
  const facts = { laySeq: state.lay.seq, planned: state.lay.plies, others, rollCode: roll.code, available, ply, uom }
  const plies = body.plies ?? row?.plies ?? Math.min(stillNeeded(state.lay.plies, others), pliesFromLength(available.minus(endLoss), ply))
  if (plies < 1) refuse(pliesRefusal({ plies: 1, endLoss }, facts) ?? { code: 'LAY_FULL', message: `Lay ${state.lay.seq} has all its ${state.lay.plies} plies.` })
  const problems = spreadProblems({ plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned }, new Dec(roll.length.toString()))
  if (problems.length > 0) invalid(problems, 'The roll\'s figures are not valid.')
  const wrong = pliesRefusal({ plies, endLoss }, facts)
  if (wrong) refuse(wrong)
  const left = available.minus(rollUse(plies, ply, endLoss))
  const warning = endWarning({ code: roll.code, length: new Dec(roll.length.toString()), uom }, left, new Dec(figures.endReturned))
  return { plies, ...figures, warnings: warning ? [warning] : [] }
}

async function rollByScan(tools: CommandTools, body: AddRollBody): Promise<RollRow> {
  const code = body.code?.trim()
  if ((code ? 1 : 0) + (body.rollId ? 1 : 0) !== 1) invalid([{ path: 'code', message: 'Name the roll once: its label as scanned, or its id.' }], 'Name the roll once.')
  const roll = body.rollId
    ? isUuid(body.rollId)
      ? await tools.tx.fabricRoll.findUnique({ where: { id: body.rollId }, select: ROLL_COLUMNS })
      : null
    : await tools.tx.fabricRoll.findFirst({ where: { code: { equals: code!, mode: 'insensitive' } }, select: ROLL_COLUMNS })
  if (!roll) return notFound('Roll')
  return roll!
}

/** POST /production/lays/:layId/rolls: a roll scanned onto the lay (or an allocated one confirmed) with its figures. */
export async function addRoll(caller: CommandCaller, layId: string, body: AddRollBody, idempotencyKey?: string) {
  return tableCommand(caller, layId, { name: 'production.spreadLayRoll', input: { ...body }, version: body.version }, idempotencyKey, async (tools, state, context) => {
    const { tx, now } = tools
    assertAtTable(state)
    const { order, lay } = state
    const roll = await rollByScan(tools, body)
    if (roll.siteId !== order.siteId || roll.itemId !== order.itemId || (order.itemColourId !== null && roll.lot.itemColourId !== order.itemColourId)) {
      refuse({ code: 'ROLL_OTHER_MATERIAL', message: `Roll ${roll.code} is not of the material (and colour) cut order ${order.number} cuts, at its site.` })
    }
    const existing = state.rows.find((row) => row.rollId === roll.id) ?? null
    if (!existing && state.rows.length >= LAY_LIMITS.rolls) invalid([{ path: 'code', message: `A lay takes at most ${LAY_LIMITS.rolls} rolls.` }], 'Too many rolls.')
    // B-W2b-112's checks of a roll for a lay: in stock, not rejected, of a lot not held and usable, wide enough; one shade and
    // one shrinkage group on the lay. What other lays not yet issued take of it is left out of what it gives.
    const marker = markerOf(order)!
    const [rejected, holds, elsewhere] = await Promise.all([rejectedRolls(tx, [roll.id]), activeHoldsOf(tx, 'Lot', [roll.lotId]), usesElsewhere(tx, [roll], lay.id)])
    const facts: AllocRoll = {
      id: roll.id,
      code: roll.code,
      state: roll.state as RollState,
      uom: rollUom(roll),
      lengthLeft: new Dec(roll.lengthLeft.toString()),
      widthCm: roll.widthCm === null ? null : new Dec(roll.widthCm.toString()),
      shadeGroupId: roll.shadeGroupId,
      shade: roll.shade,
      shrinkageGroup: roll.shrinkageGroup,
      lotCode: roll.lot.code,
      lotQuality: roll.lot.qualityStatus,
      lotHeld: holds.length > 0,
      rejected: rejected.has(roll.id),
      plannedElsewhere: elsewhere.get(roll.id) ?? ZERO,
    }
    const check = rollCheck(facts, { length: marker.length, uom: marker.uom, widthCm: order.markerWidthCm === null ? null : new Dec(order.markerWidthCm.toString()) }, 0, 'en')
    if (check.refusal) refuse(check.refusal)
    const others = state.rows.filter((row) => row.rollId !== roll.id)
    const mix = layMixRefusal([...others.map((row) => ({ code: row.roll.code, shadeGroupId: row.roll.shadeGroupId, shade: row.roll.shade, shrinkageGroup: row.roll.shrinkageGroup })), facts])
    if (mix) refuse(mix)
    const figures = await checkedFigures(tools, state, roll, body, existing)
    const change = await toSpreading(tools, state, null)
    let rowId: string
    if (existing) {
      rowId = existing.id
      await tx.layRoll.update({ where: { id: existing.id }, data: { plies: figures.plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    } else {
      rowId = newId()
      await tx.layRoll.create({
        data: { id: rowId, siteId: order.siteId, layId, seq: Math.max(0, ...state.rows.map((row) => row.seq)) + 1, rollId: roll.id, plies: figures.plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned, createdAt: now, updatedAt: now, createdById: createdBy(context) },
        select: { id: true },
      })
    }
    const after = (await readLayState(tx, layId))!
    tools.audit({
      action: 'production.spreadLayRoll',
      recordType: 'Lay',
      recordId: layId,
      companyId: order.companyId,
      siteId: order.siteId,
      before: existing ? { roll: roll.code, plies: existing.plies, splices: existing.splices, endLoss: existing.endLoss.toString(), endReturned: existing.endReturned.toString() } : { status: lay.status },
      after: { cutOrder: order.number, lay: lay.seq, status: after.lay.status, layRollId: rowId, roll: roll.code, plies: figures.plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned, spread: spreadPlies(after) },
    })
    if (change) emitLay(tools, order, after.lay, change, spreadPlies(after), [roll.id])
    emitLay(tools, order, after.lay, existing ? 'ROLL_CHANGED' : 'ROLL_SPREAD', spreadPlies(after), [roll.id])
    return answer(tools, layId, [...check.warnings, ...figures.warnings])
  })
}

export interface ChangeRollBody extends RollFigures {
  readonly version?: number | undefined
}

/** POST /production/lays/:layId/rolls/:layRollId: a roll of the report corrected (plies, splices, end loss, end returned). */
export async function changeRoll(caller: CommandCaller, layId: string, layRollId: string, body: ChangeRollBody, idempotencyKey?: string) {
  return tableCommand(caller, layId, { name: 'production.changeLayRoll', input: { layRollId, ...body }, version: body.version }, idempotencyKey, async (tools, state) => {
    const { tx, now } = tools
    assertAtTable(state)
    const row = state.rows.find((entry) => entry.id === layRollId)
    if (!row) return notFound('Roll of the lay')
    const roll = await tx.fabricRoll.findUniqueOrThrow({ where: { id: row!.rollId }, select: ROLL_COLUMNS })
    const figures = await checkedFigures(tools, state, roll, body, row!)
    const change = await toSpreading(tools, state, null)
    await tx.layRoll.update({ where: { id: row!.id }, data: { plies: figures.plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const after = (await readLayState(tx, layId))!
    tools.audit({
      action: 'production.changeLayRoll',
      recordType: 'Lay',
      recordId: layId,
      companyId: state.order.companyId,
      siteId: state.order.siteId,
      before: { layRollId: row!.id, roll: row!.roll.code, plies: row!.plies, splices: row!.splices, endLoss: row!.endLoss.toString(), endReturned: row!.endReturned.toString() },
      after: { cutOrder: state.order.number, lay: state.lay.seq, status: after.lay.status, plies: figures.plies, splices: figures.splices, endLoss: figures.endLoss, endReturned: figures.endReturned, spread: spreadPlies(after) },
    })
    if (change) emitLay(tools, state.order, after.lay, change, spreadPlies(after), [row!.rollId])
    emitLay(tools, state.order, after.lay, 'ROLL_CHANGED', spreadPlies(after), [row!.rollId])
    return answer(tools, layId, figures.warnings)
  })
}

/** POST /production/lays/:layId/rolls/undo: the last roll of the report taken off (it was not spread, or not on this lay). */
export async function undoRoll(caller: CommandCaller, layId: string, body: { readonly version?: number | undefined; readonly layRollId?: string | undefined }, idempotencyKey?: string) {
  return tableCommand(caller, layId, { name: 'production.undoLayRoll', input: { ...body }, version: body.version }, idempotencyKey, async (tools, state) => {
    const { tx } = tools
    assertAtTable(state)
    const last = [...state.rows].sort((left, right) => right.seq - left.seq)[0]
    if (!last) refuse({ code: 'ROLL_NOT_IN_LAY', message: `Lay ${state.lay.seq} has no roll to undo.` })
    if (body.layRollId && body.layRollId !== last!.id) {
      const named = state.rows.find((row) => row.id === body.layRollId)
      refuse({ code: 'NOT_LAST_ROLL', message: `${named ? `Roll ${named.roll.code} is not the last one on lay ${state.lay.seq}` : `That roll is not on lay ${state.lay.seq}`}: undo roll ${last!.roll.code} first.` })
    }
    const change = await toSpreading(tools, state, null)
    await tx.layRoll.delete({ where: { id: last!.id }, select: { id: true } })
    const after = (await readLayState(tx, layId))!
    tools.audit({
      action: 'production.undoLayRoll',
      recordType: 'Lay',
      recordId: layId,
      companyId: state.order.companyId,
      siteId: state.order.siteId,
      before: { layRollId: last!.id, roll: last!.roll.code, plies: last!.plies, splices: last!.splices, endLoss: last!.endLoss.toString(), endReturned: last!.endReturned.toString() },
      after: { cutOrder: state.order.number, lay: state.lay.seq, status: after.lay.status, spread: spreadPlies(after) },
    })
    if (change) emitLay(tools, state.order, after.lay, change, spreadPlies(after), [last!.rollId])
    emitLay(tools, state.order, after.lay, 'ROLL_UNDONE', spreadPlies(after), [last!.rollId])
    return answer(tools, layId)
  })
}

// ---- the count at both ends ---------------------------------------------------------------------------------------------------------

export interface CountBody {
  readonly version?: number | undefined
  readonly left: number
  readonly right: number
}

/** POST /production/lays/:layId/count: both ends counted; CHECKED when they agree with each other and with the plies spread. */
export async function countLay(caller: CommandCaller, layId: string, body: CountBody, idempotencyKey?: string) {
  return tableCommand(caller, layId, { name: 'production.countLay', input: { ...body }, version: body.version }, idempotencyKey, async (tools, state) => {
    assertAtTable(state)
    const { order, lay } = state
    if (lay.status === 'PLANNED') refuse({ code: 'LAY_NOT_SPREAD', message: `Lay ${lay.seq} is not spread yet: start it and spread its rolls first.` })
    const spread = spreadPlies(state)
    // A difference is refused here and stored nowhere (the database keeps only two equal counts that are the plies spread).
    const wrong = countRefusal(body, spread, lay.seq)
    if (wrong) refuse(wrong)
    await tools.tx.lay.update({ where: { id: lay.id }, data: { status: 'CHECKED', plyCountLeft: body.left, plyCountRight: body.right, checkedAt: tools.now, updatedAt: tools.now }, select: { id: true } })
    const after = (await readLayState(tools.tx, layId))!
    tools.audit({
      action: 'production.countLay',
      recordType: 'Lay',
      recordId: layId,
      companyId: order.companyId,
      siteId: order.siteId,
      before: { status: lay.status, plyCountLeft: lay.plyCountLeft, plyCountRight: lay.plyCountRight },
      after: { cutOrder: order.number, lay: lay.seq, status: 'CHECKED', plyCountLeft: body.left, plyCountRight: body.right, spread },
    })
    emitLay(tools, order, after.lay, 'COUNTED', spread, after.rows.map((row) => row.rollId))
    return answer(tools, layId)
  })
}
