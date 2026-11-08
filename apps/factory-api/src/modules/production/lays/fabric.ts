import { newId } from '@nexus/factory-domain/core/ids'
import { issueDecision, lengthIn, type LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUT } from '@nexus/factory-domain/production/cutting/permissions'
import { CONSUMPTION_UOM, splitByWeight } from '@nexus/factory-domain/production/lays/consumption'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTools } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { issueInCommand } from '../../inventory/issue/issue'
import { lockLotRolls, refuseRoll, rollFactsOf, ROLL_SELECT } from '../../inventory/rolls/facts'
import { emitChange } from '../../inventory/rolls/write'
import { may, notFound, workerOf } from '../cutorders/access'
import { refuse } from './access'
import { emitConsumption } from './emit'
import { tableCommand } from './spread'
import { layFabricKey, readLayState, rollUom, rowUse, workOrderWeights, type LayState } from './store'
import { fabricUsedOf, layView } from './views'

/**
 * Fabric used at cut finish (B-W2b-116; MES-046; design floor.fabriccut "Fabric used": "Actual metres used against the estimate.
 * Estimate, the cut-log figure, and a QuantityPad to confirm or correct; the difference in words"):
 *
 *   GET  /production/lays/:layId               the lay as the table sees it (the report, its sums, the count) and, once it is CUT,
 *                                              its fabric used: the estimate (marker × plies counted), the lay report's figure,
 *                                              what was confirmed, the difference in words
 *   POST /production/lays/:layId/fabric-used   the cutter confirms the lay report's figure or corrects it (metres, or another
 *                                              length unit), with words when it differs. The FIRST confirmation issues the lay's
 *                                              fabric to the cut order's work orders: for each roll of the report what it gave
 *                                              (plies × ply + end loss), split by each work order's garments in a ply, through
 *                                              the issue's own command (W1's rules: holds, reservations, what the work order still
 *                                              needs; an over-issue only the office gives, with its reason) with the roll's length
 *                                              left and state in the SAME command (B-W2b-107's lock order: the roll rows → the
 *                                              lots' roll locks → the work orders' issue locks → the stock). Those ISSUE moves are
 *                                              what feeds the work orders' cost (the cost ledger posts them). A later correction
 *                                              changes the confirmed figure only, until the cut order is reconciled.
 *
 * Office and floor (production.cut at the lay's site). Each write is ONE command on the lay, audited, with cut_consumption.changed
 * (and fabric_roll.changed per roll, inventory.issued per issue). No money: lengths only; no worker named.
 */

/** GET /production/lays/:layId: office + floor, production.cut at the lay's site. */
export async function readLay(caller: CommandCaller, layId: string) {
  const context = workerOf(caller)
  return caller.withClient(async (db) => {
    const state = await readLayState(db, layId)
    if (!state || !may(context, PRODUCTION_CUT, state.order)) return notFound('Lay')
    return { ...layView(state!), warnings: [] }
  })
}

export interface FabricUsedBody {
  readonly version?: number | undefined
  /** What was used (default: the lay report's figure), in `uom` (default metres). */
  readonly confirmed?: string | undefined
  readonly uom?: LengthUom | undefined
  readonly note?: string | null | undefined
  /** The office's reason when the fabric issued is more than a work order still needs (inventory.issue.over). */
  readonly overIssueReason?: string | undefined
}

/**
 * The lay's fabric to the work orders, roll by roll (see the head of this file). Answers the moves and the work orders. A refusal
 * of the roll (no longer in stock, shorter than the report) or of the issue (a hold, a reservation of another work order, an
 * over-issue) stops the whole confirmation, in its words.
 */
async function issueLayFabric(tools: CommandTools, state: LayState, context: OfficeContext | FloorContext, overIssueReason: string | undefined) {
  const { tx, now } = tools
  const weights = workOrderWeights(state.lines)
  const rows = [...state.rows].sort((left, right) => left.seq - right.seq)
  const rollIds = [...new Set(rows.map((row) => row.rollId))].sort()
  // The rolls' rows first (in id order), then their lots' roll locks: the rolls module's own order.
  for (const rollId of rollIds) await tx.$queryRaw`SELECT 1 FROM "FabricRoll" WHERE id = ${rollId}::uuid FOR UPDATE`
  const rolls = new Map((await tx.fabricRoll.findMany({ where: { id: { in: rollIds } }, select: ROLL_SELECT })).map((roll) => [roll.id, roll]))
  for (const lotId of [...new Set([...rolls.values()].map((roll) => roll.lotId))].sort()) await lockLotRolls(tx, context.tenantId, lotId)
  const moveIds: string[] = []
  const workOrderIds = new Set<string>()
  for (const row of rows) {
    const roll = rolls.get(row.rollId)!
    const uom = rollUom(roll)
    const use = rowUse(state, row)
    const decision = issueDecision(rollFactsOf(roll), use.toFixed(4))
    if (!decision.ok) refuseRoll(decision.refusal)
    const decided = decision as Extract<typeof decision, { ok: true }>
    const ownMoves: string[] = []
    const ownOrders: string[] = []
    for (const share of splitByWeight(new Dec(decided.quantity), weights)) {
      if (!share.length.greaterThan(0)) continue
      const issued = await issueInCommand(
        tools,
        share.key,
        { lotId: roll.lotId, quantity: share.length.toFixed(4), uom, fromLocationId: roll.locationId!, ...(overIssueReason ? { overIssueReason } : {}) },
        layFabricKey(state.lay.id, roll.id, share.key),
        'body',
      )
      ownMoves.push(...issued.issue.moves.map((move) => move.id))
      workOrderIds.add(share.key)
      ownOrders.push(share.key)
    }
    await tx.fabricRoll.update({ where: { id: roll.id }, data: { lengthLeft: decided.after.lengthLeft, state: decided.after.state, locationId: decided.after.locationId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const updated = await tx.fabricRoll.findUniqueOrThrow({ where: { id: roll.id }, select: ROLL_SELECT })
    tools.audit({
      action: 'production.issueLayFabric',
      recordType: 'FabricRoll',
      recordId: roll.id,
      companyId: roll.companyId,
      siteId: roll.siteId,
      before: { state: roll.state, lengthLeft: new Dec(roll.lengthLeft.toString()).toFixed(4), locationId: roll.locationId },
      after: { state: updated.state, lengthLeft: new Dec(updated.lengthLeft.toString()).toFixed(4), locationId: updated.locationId, quantity: decided.quantity, uom, cutOrder: state.order.number, lay: state.lay.seq, moveIds: ownMoves },
    })
    emitChange(tools, updated, 'ISSUED', ownMoves, ownOrders.length === 1 ? ownOrders[0]! : null)
    moveIds.push(...ownMoves)
    // Rolls named twice on one lay never happen (one row per roll); a roll on this lay reads its new length for the next row.
    rolls.set(roll.id, updated)
  }
  return { moveIds, workOrderIds: [...workOrderIds].sort() }
}

/** POST /production/lays/:layId/fabric-used: the cutter confirms or corrects the fabric used; the first time it is issued. */
export async function confirmFabricUsed(caller: CommandCaller, layId: string, body: FabricUsedBody, idempotencyKey?: string) {
  return tableCommand(caller, layId, { name: 'production.confirmFabricUsed', input: { ...body }, version: body.version }, idempotencyKey, async (tools, state, context) => {
    const { tx, now } = tools
    const { order, lay } = state
    if (order.kind !== 'FABRIC') refuse({ code: 'NOT_FABRIC', message: `Cut order ${order.number} cuts leather hide by hide: its lays have no fabric used.` })
    if (order.status === 'RECONCILED' || order.status === 'CANCELLED') refuse({ code: 'CONSUMPTION_CLOSED', message: `Cut order ${order.number} is ${order.status.toLowerCase()}: its fabric used no longer changes.` })
    if (lay.status !== 'CUT') refuse({ code: 'LAY_NOT_CUT', message: `Lay ${lay.seq} is ${lay.status.toLowerCase()}: its fabric used is confirmed once it is cut (scan its ticket at the end).` })
    const figures = fabricUsedOf(state)!
    const confirmed: Decimal = body.confirmed !== undefined ? lengthIn(body.confirmed.trim(), body.uom ?? CONSUMPTION_UOM, CONSUMPTION_UOM) : new Dec(figures.confirmed ?? figures.recorded)
    const note = body.note === undefined ? (state.consumption?.note ?? null) : body.note?.trim() || null
    let moves: { moveIds: string[]; workOrderIds: string[] } = { moveIds: [], workOrderIds: [] }
    let consumptionId: string
    if (!state.consumption) {
      moves = await issueLayFabric(tools, state, context, body.overIssueReason?.trim() || undefined)
      consumptionId = newId()
      await tx.cutConsumption.create({
        data: {
          id: consumptionId,
          siteId: order.siteId,
          cutOrderId: order.id,
          layId: lay.id,
          key: `consumption:${lay.id}`,
          uom: CONSUMPTION_UOM,
          estimated: figures.estimated,
          recorded: figures.recorded,
          confirmed: confirmed.toFixed(4),
          confirmedAt: now,
          note,
          createdAt: now,
          updatedAt: now,
          createdById: context.audience === 'office' ? context.actorId : null,
        },
        select: { id: true },
      })
    } else {
      consumptionId = state.consumption.id
      await tx.cutConsumption.update({ where: { id: consumptionId }, data: { confirmed: confirmed.toFixed(4), confirmedAt: now, note, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    tools.audit({
      action: 'production.confirmFabricUsed',
      recordType: 'Lay',
      recordId: lay.id,
      companyId: order.companyId,
      siteId: order.siteId,
      before: state.consumption ? { confirmed: state.consumption.confirmed?.toString() ?? null, note: state.consumption.note } : { confirmed: null },
      after: { cutOrder: order.number, lay: lay.seq, uom: CONSUMPTION_UOM, estimated: figures.estimated, recorded: figures.recorded, confirmed: confirmed.toFixed(4), note, issued: state.consumption === null, moveIds: moves.moveIds, workOrderIds: moves.workOrderIds },
    })
    emitConsumption(tools, order, { id: consumptionId, layId: lay.id }, state.consumption ? 'CORRECTED' : 'CONFIRMED', moves.workOrderIds, moves.moveIds)
    return { ...layView((await readLayState(tx, layId))!), warnings: [] }
  })
}
