import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { IN_STOCK_STATES, lengthText, type LengthUom, type RollState } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import {
  acrossLaysWarnings,
  layMixRefusal,
  pliesFrom,
  proposalWords,
  proposeAllocation,
  rollCheck,
  shadeKeyOf,
  type AllocMarker,
  type AllocRoll,
  type AllocationWarning,
  type LayNeed,
} from '@nexus/factory-domain/production/cutorders/allocation'
import { PRODUCTION_CUTORDERS_MANAGE } from '@nexus/factory-domain/production/cutorders/permissions'
import { CUT_ORDER_LIMITS, perPlyLength } from '@nexus/factory-domain/production/cutorders/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { lockLotRolls } from '../../inventory/rolls/facts'
import { activeHoldsOf } from '../../quality/holds/checks'
import { invalid, may, notFound, officeOf, refuse } from './access'
import { emitOrder } from './emit'
import { recordOf } from './read'
import { decimalText, plannedOnRolls, readCutOrder, readLayRolls, readLays, readLines, rejectedRolls, type CutOrderRow, type Reader } from './store'

/**
 * Rolls by shade, width and shrinkage (B-W2b-112; MES-037; design production.cutting › Cut › Lays): what rolls a fabric cut order
 * may take (in stock at its site, of its material and colour) with what each gives (whole plies of the marker) and why not, a
 * proposal that fills each lay still to spread from one shade and shrinkage group, and the office's allocation of rolls to a
 * PLANNED lay of a released cut order (LayRoll rows with the plies planned: spreading at the table confirms or corrects them,
 * B-W2b-116). Rules: factory-domain production/cutorders/allocation.ts. The allocation moves no stock: the roll goes to the table
 * and is issued when it is spread. Lock order (B-W2b-107's): the lay's row (command()'s version bump) → the rolls' lots
 * (`factory.fabric-rolls`, in id order).
 */

const ROLL_COLUMNS = {
  id: true,
  code: true,
  lotId: true,
  state: true,
  uom: true,
  length: true,
  lengthLeft: true,
  widthCm: true,
  shade: true,
  shadeGroupId: true,
  shrinkageGroup: true,
  shrinkageLengthPercent: true,
  shrinkageWidthPercent: true,
  supplierRollRef: true,
  location: { select: { id: true, code: true } },
  shadeGroup: { select: { label: true, outOfShade: true } },
  lot: { select: { code: true, qualityStatus: true, itemColourId: true, dyeBatch: true } },
} as const satisfies Prisma.FabricRollSelect
type RollRow = Prisma.FabricRollGetPayload<{ select: typeof ROLL_COLUMNS }>

const fabricMarker = (order: CutOrderRow): AllocMarker | null =>
  order.kind === 'FABRIC' && order.markerLength !== null && order.markerUom !== null
    ? { length: order.markerLength.toString(), uom: order.markerUom as LengthUom, widthCm: order.markerWidthCm === null ? null : new Dec(order.markerWidthCm.toString()) }
    : null

/** The rolls a fabric cut order may take, as the rules see them (`exceptLayId`: what that lay plans is left out). */
async function allocRolls(db: Reader, order: CutOrderRow, rollIds: readonly string[] | null, allowanceCm: number, exceptLayId: string | null): Promise<{ rows: RollRow[]; rolls: AllocRoll[]; on: Awaited<ReturnType<typeof plannedOnRolls>> }> {
  const rows = await db.fabricRoll.findMany({
    where: {
      siteId: order.siteId,
      itemId: order.itemId,
      ...(rollIds ? { id: { in: [...rollIds] } } : { state: { in: [...IN_STOCK_STATES] } }),
      ...(order.itemColourId ? { lot: { is: { itemColourId: order.itemColourId } } } : {}),
    },
    select: ROLL_COLUMNS,
    orderBy: { code: 'asc' },
    take: 500,
  })
  const [on, rejected, holds] = await Promise.all([
    plannedOnRolls(db, rows.map((row) => ({ id: row.id, uom: row.uom as LengthUom })), allowanceCm, exceptLayId),
    rejectedRolls(db, rows.map((row) => row.id)),
    activeHoldsOf(db, 'Lot', [...new Set(rows.map((row) => row.lotId))]),
  ])
  const held = new Set(holds.flatMap((hold) => hold.subjectIds))
  const rolls: AllocRoll[] = rows.map((row) => ({
    id: row.id,
    code: row.code,
    state: row.state as RollState,
    uom: row.uom as LengthUom,
    lengthLeft: new Dec(row.lengthLeft.toString()),
    widthCm: row.widthCm === null ? null : new Dec(row.widthCm.toString()),
    shadeGroupId: row.shadeGroupId,
    shade: row.shade,
    shrinkageGroup: row.shrinkageGroup,
    lotCode: row.lot.code,
    lotQuality: row.lot.qualityStatus,
    lotHeld: held.has(row.lotId),
    rejected: rejected.has(row.id),
    plannedElsewhere: on.get(row.id)?.length ?? ZERO,
  }))
  return { rows, rolls, on }
}

/** A lay's rolls as the proposal sees them. */
function needsOf(lays: Awaited<ReturnType<typeof readLays>>, layRolls: Awaited<ReturnType<typeof readLayRolls>>): LayNeed[] {
  return lays
    .filter((lay) => lay.status !== 'CANCELLED' && lay.status !== 'CUT')
    .map((lay) => ({
      id: lay.id,
      seq: lay.seq,
      plies: lay.plies,
      proposable: lay.status === 'PLANNED',
      rolls: layRolls
        .filter((row) => row.layId === lay.id)
        .map((row) => ({ rollId: row.rollId, code: row.roll.code, plies: row.plies, shadeGroupId: row.roll.shadeGroupId, shade: row.roll.shade, shrinkageGroup: row.roll.shrinkageGroup })),
    }))
}

export interface CandidatesQuery {
  readonly allowanceCm?: number | undefined
}

/** GET /production/cut-orders/:cutOrderId/rolls: the rolls the cut order may take, each with what it gives and why not; the proposal. */
export async function rollCandidates(caller: CommandCaller, cutOrderId: string, query: CandidatesQuery) {
  const context = officeOf(caller)
  const allowanceCm = query.allowanceCm ?? 0
  return caller.withClient(async (db) => {
    const order = await readCutOrder(db, cutOrderId)
    if (!order || !may(context, PRODUCTION_CUTTING_VIEW, order)) return notFound('Cut order')
    const marker = fabricMarker(order!)
    if (!marker) refuse({ code: 'NO_MARKER', message: `Cut order ${order!.number} ${order!.kind === 'LEATHER' ? 'cuts leather hide by hide: it takes no rolls' : 'has no marker yet: a roll gives plies of a marker'}.` })
    const lays = await readLays(db, [order!.id])
    const layRolls = await readLayRolls(db, lays.map((lay) => lay.id))
    const { rows, rolls, on } = await allocRolls(db, order!, null, allowanceCm, null)
    const needs = needsOf(lays, layRolls)
    // What other cut orders plan of a roll, and what this one's own lays plan of it (they are not "elsewhere" for its lays).
    const proposal = proposeAllocation(rolls, needs, marker!, allowanceCm)
    const groups = new Map<string, { shade: string | null; shadeGroupId: string | null; shrinkageGroup: string | null; rolls: number; plies: number }>()
    const views = rolls.map((roll, index) => {
      const row = rows[index]!
      const check = rollCheck(roll, marker!, allowanceCm, 'en')
      const plies = check.refusal ? 0 : pliesFrom(roll, marker!, allowanceCm)
      if (!check.refusal) {
        const key = JSON.stringify([shadeKeyOf(roll), roll.shrinkageGroup])
        const group = groups.get(key) ?? { shade: roll.shade, shadeGroupId: roll.shadeGroupId, shrinkageGroup: roll.shrinkageGroup, rolls: 0, plies: 0 }
        group.rolls += 1
        group.plies += plies
        groups.set(key, group)
      }
      return {
        id: row.id,
        code: row.code,
        supplierRollRef: row.supplierRollRef,
        state: row.state as RollState,
        uom: row.uom as LengthUom,
        length: decimalText(row.length)!,
        lengthLeft: decimalText(row.lengthLeft)!,
        planned: decimalText(roll.plannedElsewhere)!,
        widthCm: decimalText(row.widthCm, 2),
        shade: row.shade,
        shadeGroup: row.shadeGroupId && row.shadeGroup ? { id: row.shadeGroupId, label: row.shadeGroup.label, outOfShade: row.shadeGroup.outOfShade } : null,
        shrinkageGroup: row.shrinkageGroup,
        shrinkageLengthPercent: decimalText(row.shrinkageLengthPercent, 2),
        shrinkageWidthPercent: decimalText(row.shrinkageWidthPercent, 2),
        lot: { id: row.lotId, code: row.lot.code, dyeBatch: row.lot.dyeBatch, qualityStatus: row.lot.qualityStatus },
        location: row.location,
        plies,
        allocatedTo: on.get(row.id)?.on ?? [],
        refusal: check.refusal,
        warnings: check.warnings,
      }
    })
    const perPly = perPlyLength(marker!, 'M', allowanceCm)
    return {
      marker: { name: order!.markerName!, length: decimalText(order!.markerLength)!, uom: marker!.uom, widthCm: decimalText(order!.markerWidthCm, 2) },
      allowanceCm,
      perPlyMetres: perPly.toFixed(4),
      rolls: views,
      groups: [...groups.values()].sort((left, right) => right.plies - left.plies),
      lays: needs.map((need) => ({ id: need.id, seq: need.seq, plies: need.plies, allocated: need.rolls.reduce((sum, roll) => sum + roll.plies, 0), proposable: need.proposable })),
      proposal,
      words: { it: proposalWords(proposal, 'it'), en: proposalWords(proposal, 'en') },
      warnings: acrossLaysWarnings(needs.filter((need) => need.rolls.length > 0).map((need) => need.rolls)),
    }
  })
}

export interface AllocateBody {
  /** The lay's version (the allocation changes the lay). */
  readonly version: number
  readonly rolls: readonly { readonly rollId: string; readonly plies: number }[]
  readonly allowanceCm?: number | undefined
}

/** The lay of a cut order the office manages (404 / 403), with the cut order. */
async function managedLay(caller: CommandCaller, cutOrderId: string, layId: string) {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const order = await readCutOrder(db, cutOrderId)
    const lay = order && isUuid(layId) ? await db.lay.findUnique({ where: { id: layId }, select: { id: true, cutOrderId: true } }) : null
    return { order, lay }
  })
  if (!found.order || !may(context, PRODUCTION_CUTTING_VIEW, found.order) || !found.lay || found.lay.cutOrderId !== cutOrderId) return notFound('Lay')
  if (!may(context, PRODUCTION_CUTORDERS_MANAGE, found.order!)) throw new ForbiddenError('Allocating rolls needs production.cutorders.manage at the site.')
  return { context, order: found.order! }
}

/** Checks the lay and the cut order inside the command: a PLANNED lay of a released fabric cut order. */
async function layAtPlanning(tx: CommandTx, cutOrderId: string, layId: string) {
  const order = (await readCutOrder(tx, cutOrderId))!
  const lay = (await readLays(tx, [cutOrderId])).find((row) => row.id === layId)!
  const marker = fabricMarker(order)
  if (!marker) refuse({ code: 'NO_MARKER', message: `Cut order ${order.number} takes no rolls (${order.kind === 'LEATHER' ? 'leather' : 'no marker yet'}).` })
  if (order.status !== 'RELEASED' && order.status !== 'IN_PROGRESS') {
    refuse({ code: 'NOT_AT_TABLE', message: `Cut order ${order.number} is ${order.status.toLowerCase().replace('_', ' ')}: rolls are allocated to the lays of a released cut order.` })
  }
  if (lay.status !== 'PLANNED') refuse({ code: 'LAY_NOT_PLANNED', message: `Lay ${lay.seq} is ${lay.status.toLowerCase()}: its rolls are the table's now (the lay report).` })
  return { order, lay, marker: marker! }
}

/** POST /production/cut-orders/:cutOrderId/lays/:layId/rolls: rolls allocated to a PLANNED lay with the plies each gives it. */
export async function allocateRolls(caller: CommandCaller, cutOrderId: string, layId: string, body: AllocateBody, idempotencyKey?: string) {
  const { context } = await managedLay(caller, cutOrderId, layId)
  const allowanceCm = body.allowanceCm ?? 0
  const problems = body.rolls.flatMap((roll, index) => (Number.isSafeInteger(roll.plies) && roll.plies >= 1 && roll.plies <= CUT_ORDER_LIMITS.pliesPerLay ? [] : [{ path: `rolls/${index}/plies`, message: 'The plies from this roll, from 1.' }]))
  const ids = body.rolls.map((roll) => roll.rollId)
  if (body.rolls.length === 0 || body.rolls.length > 30) problems.push({ path: 'rolls', message: 'From 1 to 30 rolls at a time.' })
  if (new Set(ids).size !== ids.length) refuse({ code: 'ROLL_TWICE', message: 'A roll is named twice: name it once with all its plies.' })
  if (problems.length > 0) invalid(problems, 'The rolls are not valid.')

  const { result } = await command(caller, { name: 'production.allocateRolls', idempotencyKey, input: { cutOrderId, layId, ...body }, record: { type: 'Lay', id: layId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const { order: current, lay, marker } = await layAtPlanning(tx, cutOrderId, layId)
    const { rows, rolls } = await allocRolls(tx, current, ids, allowanceCm, null)
    for (const lotId of [...new Set(rows.map((row) => row.lotId))].sort()) await lockLotRolls(tx, context.tenantId, lotId)
    const existing = await readLayRolls(tx, [layId])
    const byId = new Map(rolls.map((roll) => [roll.id, roll]))
    const warnings: AllocationWarning[] = []
    const added: { rollId: string; plies: number; roll: AllocRoll }[] = []
    for (const [index, asked] of body.rolls.entries()) {
      const roll = byId.get(asked.rollId)
      if (!roll) {
        const other = isUuid(asked.rollId) ? await tx.fabricRoll.findUnique({ where: { id: asked.rollId }, select: { code: true } }) : null
        if (!other) invalid([{ path: `rolls/${index}/rollId`, message: 'The roll is not found.' }], 'The roll is not found.')
        refuse({ code: 'ROLL_OTHER_MATERIAL', message: `Roll ${other!.code} is not of the material (and colour) cut order ${current.number} cuts, at its site.` })
      }
      if (existing.some((row) => row.rollId === asked.rollId)) refuse({ code: 'ROLL_TWICE', message: `Roll ${roll!.code} is already in lay ${lay.seq}: change its plies there.` })
      const check = rollCheck(roll!, marker, allowanceCm, 'en')
      if (check.refusal) refuse(check.refusal)
      warnings.push(...check.warnings)
      const gives = pliesFrom(roll!, marker, allowanceCm)
      if (asked.plies > gives) {
        refuse({ code: 'ROLL_SHORT', message: `Roll ${roll!.code} gives ${gives} ${gives === 1 ? 'ply' : 'plies'} of ${lengthText(perPlyLength(marker, roll!.uom, allowanceCm), roll!.uom, 'en')} (what other lays plan of it is left out), not ${asked.plies}.` })
      }
      added.push({ rollId: asked.rollId, plies: asked.plies, roll: roll! })
    }
    const mix = layMixRefusal([...existing.map((row) => ({ code: row.roll.code, shadeGroupId: row.roll.shadeGroupId, shade: row.roll.shade, shrinkageGroup: row.roll.shrinkageGroup })), ...added.map((entry) => entry.roll)])
    if (mix) refuse(mix)
    const total = existing.reduce((sum, row) => sum + row.plies, 0) + added.reduce((sum, entry) => sum + entry.plies, 0)
    if (total > lay.plies) refuse({ code: 'LAY_FULL', message: `Lay ${lay.seq} plans ${lay.plies} plies; these rolls would give it ${total}.` })
    let seq = Math.max(0, ...existing.map((row) => row.seq))
    await tx.layRoll.createMany({
      data: added.map((entry) => ({ id: newId(), siteId: current.siteId, layId, seq: ++seq, rollId: entry.rollId, plies: entry.plies, createdAt: now, updatedAt: now, createdById: context.actorId })),
    })
    tools.audit({
      action: 'production.allocateRolls',
      recordType: 'Lay',
      recordId: layId,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { cutOrder: current.number, lay: lay.seq, rolls: added.map((entry) => ({ rollId: entry.rollId, code: entry.roll.code, plies: entry.plies })), allocated: total },
    })
    emitOrder(tools, current, 'ROLLS_ALLOCATED', [...new Set((await readLines(tx, [cutOrderId])).map((line) => line.workOrderId))], { layId, rollIds: added.map((entry) => entry.rollId) })
    const record = await recordOf(tx, context, current)
    const unique = new Map(warnings.map((warning) => [`${warning.code}|${warning.message}`, warning]))
    return { ...record, allocation: { layId, allocated: total, warnings: [...unique.values(), ...record.warnings] } }
  })
  return result
}

/** POST /production/cut-orders/:cutOrderId/lays/:layId/rolls/:layRollId/remove: a roll taken off a PLANNED lay. */
export async function removeRoll(caller: CommandCaller, cutOrderId: string, layId: string, layRollId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context } = await managedLay(caller, cutOrderId, layId)
  const { result } = await command(caller, { name: 'production.removeLayRoll', idempotencyKey, input: { cutOrderId, layId, layRollId, ...body }, record: { type: 'Lay', id: layId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const { order: current, lay } = await layAtPlanning(tx, cutOrderId, layId)
    const row = (await readLayRolls(tx, [layId])).find((entry) => entry.id === layRollId)
    if (!row) return notFound('Roll of the lay')
    await tx.layRoll.delete({ where: { id: layRollId }, select: { id: true } })
    tools.audit({ action: 'production.removeLayRoll', recordType: 'Lay', recordId: layId, companyId: current.companyId, siteId: current.siteId, before: { cutOrder: current.number, lay: lay.seq, rollId: row!.rollId, code: row!.roll.code, plies: row!.plies } })
    emitOrder(tools, current, 'ROLLS_REMOVED', [...new Set((await readLines(tx, [cutOrderId])).map((line) => line.workOrderId))], { layId, rollIds: [row!.rollId] })
    return recordOf(tx, context, current)
  })
  return result
}
