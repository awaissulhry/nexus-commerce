import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { fromRefusal, quantityToMove, toRefusal, type MoveRefusal, type PlaceFacts } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import { PUT_AWAY_FROM_KINDS } from '@nexus/factory-domain/inventory/tasks/sources'
import { databaseWarehouseRefusal, WAREHOUSE_REFUSAL_ISSUES } from '@nexus/factory-domain/inventory/warehouse/refusals'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { postMoves, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import { stockContextOf } from '../ledger/access'
import type { Reader } from '../issue/store'
import { moveRoll } from '../rolls/stock'
import { settleMoveTasksInCommand, type MovedStock } from '../tasks/lifecycle'
import { namesOf, taskView, type TaskRow } from '../tasks/store'
import { handOf, handView, placeOfScan, type Hand, type PlaceRef } from './hand'

/**
 * A move by its two scans (B-W2b-292; SCM-218 move between bins, SCM-202 put away; design floor.move): what (a lot, a hide, a
 * roll, a remnant's tag) and the place's label. ONE command (inventory.binMove / inventory.putAway) for the office and a floor
 * device at its own site (inventory.transfer; an Idempotency-Key, the tablet's queue keeps one): the checks in words first
 * (factory-domain inventory/bin-moves rules: where it lies, a place of the site that is active and not where it is, stock not
 * released only into quarantine, a hide or a lot tracked hide by hide whole, never more than lies there; a count's frozen
 * line, in the database's words), then TRANSFER moves through the ledger's one writer (postMoves: the place's kind and block,
 * the balance under its lock, the floor's moves valued by the worker), then the open put-away and move tasks of what moved
 * (modules/inventory/tasks lifecycle settleMoveTasksInCommand: done once nothing is left where it was).
 *
 * A fabric roll keeps its own place and length: it moves through the rolls' own command (modules/inventory/rolls moveRoll),
 * then its tasks are settled in a second command keyed from the first (a resend answers both from their receipts).
 */

export type MovePurpose = 'MOVE' | 'PUT_AWAY'

export interface MoveByScanBody {
  readonly code: string
  readonly placeCode: string
  /** Where it is moved from, when it lies in several places. */
  readonly fromLocationId?: string | null | undefined
  /** In the item's base unit; left out: all of it (what moves whole: all of it, or refused). */
  readonly quantity?: string | null | undefined
  /** The task the screen works on (its put-away or move). */
  readonly taskId?: string | null | undefined
  readonly note?: string | null | undefined
  /** When it happened, by the tablet's clock (a queued move). */
  readonly occurredAt?: string | undefined
}

const NAMES: Readonly<Record<MovePurpose, 'inventory.binMove' | 'inventory.putAway'>> = { MOVE: 'inventory.binMove', PUT_AWAY: 'inventory.putAway' }
const REFERENCE: Readonly<Record<MovePurpose, string>> = { MOVE: 'Bin move', PUT_AWAY: 'Put away' }

const refuse = (refusal: MoveRefusal | null, path = 'body'): void => {
  if (refusal) throw new DomainError(refusal.code === 'TOO_MUCH' || refusal.code === 'WHOLE_ONLY' ? 'validation_failed' : 'conflict', refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }, { path, message: refusal.message }])
}

/** A count's frozen line of the item at either place: refused in the database's own words before it is reached. */
export async function frozenRefusal(db: Reader, siteId: string, itemId: string, places: readonly PlaceRef[]): Promise<void> {
  const lines = await db.stockCountLine.findMany({
    where: { siteId, itemId, locationId: { in: places.map((place) => place.id) }, frozenAt: { not: null }, count: { status: 'COUNTING' } },
    select: { locationId: true, countedAt: true, recountRequestedAt: true, recountedAt: true, count: { select: { number: true } } },
  })
  const holding = lines.find((line) => line.countedAt === null || (line.recountRequestedAt !== null && line.recountedAt === null))
  if (!holding) return
  const at = places.find((place) => place.id === holding.locationId)?.code ?? ''
  const words = databaseWarehouseRefusal(`inventory: count ${holding.count.number} is counting this material at location ${at} (a frozen line)`)!
  throw new DomainError('conflict', words.message, [{ path: WAREHOUSE_REFUSAL_ISSUES.frozen, message: words.message }])
}

interface Planned {
  readonly hand: Hand
  readonly from: PlaceRef
  readonly to: PlaceRef
  readonly drafts: readonly MoveDraft[]
  readonly moved: readonly MovedStock[]
}

/** The move as asked, checked in words on what the caller reads now (the command checks the ledger again under its locks). */
export async function planMove(db: Reader, hand: Hand, body: Pick<MoveByScanBody, 'placeCode' | 'fromLocationId' | 'quantity' | 'note'>, purpose: MovePurpose, occurredAt: Date | undefined): Promise<Planned> {
  const places: PlaceFacts[] = hand.lying.map((entry) => entry.location)
  refuse(fromRefusal(hand, places, body.fromLocationId), 'body/fromLocationId')
  const lying = hand.lying.find((entry) => entry.location.id === (body.fromLocationId ?? places[0]!.id))!
  const to = await placeOfScan(db, hand.siteId, body.placeCode)
  refuse(toRefusal(hand, lying.location, to), 'body/placeCode')
  const amount = quantityToMove(hand, lying.onHand, body.quantity)
  if ('refusal' in amount) refuse(amount.refusal, 'body/quantity')
  const quantity = (amount as { quantity: Decimal }).quantity
  await frozenRefusal(db, hand.siteId, hand.item.id, [lying.location, to])
  const note = (body.note ?? '').trim() || null
  // A lot tracked hide by hide moves hide by hide; a lot by quantity in one move (its rows there are of one lot).
  const rows = hand.item.tracking === 'HIDE' ? lying.rows : [{ ...lying.rows[0]!, onHand: quantity }]
  const drafts: MoveDraft[] = rows.map((row) => ({
    siteId: hand.siteId,
    reason: 'TRANSFER',
    itemId: hand.item.id,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    fromLocationId: lying.location.id,
    toLocationId: to.id,
    quantity: new Dec(row.onHand).toFixed(4),
    reference: REFERENCE[purpose],
    note,
    ...(occurredAt ? { occurredAt } : {}),
  }))
  const moved: MovedStock[] = rows.map((row) => ({ itemId: hand.item.id, lotId: row.lotId, hideId: row.hideId, fromLocationId: lying.location.id, toLocationId: to.id }))
  return { hand, from: lying.location, to, drafts, moved }
}

const moveViewOf = (move: PostedMove) => ({ id: move.id, itemId: move.itemId, lotId: move.lotId, hideId: move.hideId, fromLocationId: move.fromLocationId, toLocationId: move.toLocationId, quantity: move.quantity, uom: move.uom as string, occurredAt: move.occurredAt })
const placeShort = (place: PlaceRef) => ({ id: place.id, code: place.code, name: place.name, kind: place.kind })

async function tasksAnswer(tools: Pick<CommandTools, 'tx'>, rows: readonly TaskRow[]) {
  if (rows.length === 0) return []
  const names = await namesOf(tools.tx, rows)
  return rows.map((row) => taskView(row, names))
}

/**
 * Where it moves from when the scan does not say (it lies in several places): the place of the task the screen works on, else
 * for a put-away the one dock or quarantine place it waits in ("two scans and no taps": a lot partly put away lies on the dock
 * and in its bin). Null: the move asks (NAME_THE_PLACE).
 */
async function impliedFrom(db: Reader, hand: Hand, taskId: string | null | undefined, purpose: MovePurpose): Promise<string | null> {
  if (hand.lying.length < 2) return null
  if (taskId) {
    const task = await db.warehouseTask.findUnique({ where: { id: taskId }, select: { fromLocationId: true } })
    if (task?.fromLocationId && hand.lying.some((entry) => entry.location.id === task.fromLocationId)) return task.fromLocationId
  }
  if (purpose !== 'PUT_AWAY') return null
  const waiting = hand.lying.filter((entry) => (PUT_AWAY_FROM_KINDS as readonly string[]).includes(entry.location.kind))
  return waiting.length === 1 ? waiting[0]!.location.id : null
}

/** POST /inventory/bin-moves and POST /inventory/putaway: the move by its two scans. */
export async function moveByScan(caller: CommandCaller, body: MoveByScanBody, purpose: MovePurpose, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  const occurredAt = body.occurredAt ? (parseInstant(body.occurredAt) ?? undefined) : undefined
  const hand = await caller.withClient((db) => handOf(db, context, body.code, INVENTORY_TRANSFER))
  const name = NAMES[purpose]
  const deviceTime = context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}

  if (hand.roll) {
    if (!hand.roll.locationId) refuse({ code: 'NOTHING_HERE', message: `${hand.label} is not in stock: there is nothing to move.` })
    if (body.quantity && !new Dec(body.quantity).eq(hand.lying[0]?.onHand ?? 0)) refuse({ code: 'WHOLE_ONLY', message: `${hand.label} moves whole: a roll's length is taken off by an issue.` }, 'body/quantity')
    const plan = await caller.withClient((db) => planMove(db, hand, { ...body, quantity: null }, purpose, occurredAt))
    const rolled = await moveRoll(caller, hand.roll.id, { toLocationId: plan.to.id, note: body.note ?? null, ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}) }, idempotencyKey ? `${name}:${idempotencyKey}` : undefined)
    const { result } = await command(caller, { name, idempotencyKey: idempotencyKey ? `${idempotencyKey}:tasks` : undefined, input: { ...body, purpose, moveIds: rolled.moveIds }, ...deviceTime }, async (tools) => {
      const tasks = await settleMoveTasksInCommand(tools, hand.siteId, plan.moved, body.taskId)
      tools.audit({ action: name, recordType: 'FabricRoll', recordId: hand.roll!.id, companyId: hand.companyId, siteId: hand.siteId, after: { moveIds: rolled.moveIds, fromLocationId: plan.from.id, toLocationId: plan.to.id, taskIds: tasks.map((task) => task.id) } })
      return { tasks: await tasksAnswer(tools, tasks) }
    })
    return { moveIds: rolled.moveIds, from: placeShort(plan.from), to: placeShort(plan.to), hand: handView(hand), tasks: result.tasks }
  }

  const fromLocationId = body.fromLocationId ?? (await caller.withClient((db) => impliedFrom(db, hand, body.taskId, purpose)))
  const plan = await caller.withClient((db) => planMove(db, hand, { ...body, fromLocationId }, purpose, occurredAt))
  const { result } = await command(caller, { name, idempotencyKey, input: { ...body, purpose }, ...deviceTime }, async (tools) => {
    const posted = await postMoves(tools, plan.drafts, { key: idempotencyKey ? `${name}:${idempotencyKey}` : null, issuePath: () => 'body' })
    const tasks = await settleMoveTasksInCommand(tools, hand.siteId, plan.moved, body.taskId)
    const after = await handOf(tools.tx, tools.context as ReturnType<typeof stockContextOf>, body.code, INVENTORY_TRANSFER)
    return { moveIds: posted.map((move) => move.id), moves: posted.map(moveViewOf), from: placeShort(plan.from), to: placeShort(plan.to), hand: handView(after), tasks: await tasksAnswer(tools, tasks) }
  })
  return result
}

/** A body's problems a contract cannot say (a quantity above 0). */
export function moveBodyProblems(body: Pick<MoveByScanBody, 'quantity'>): void {
  if (body.quantity !== null && body.quantity !== undefined && !new Dec(body.quantity).gt(0)) throw new ValidationError('How much is above 0.', [{ path: 'body/quantity', message: 'How much is above 0.' }])
}
