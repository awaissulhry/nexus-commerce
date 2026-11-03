import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant } from '@nexus/factory-domain/core/time'
import type { RollChange } from '@nexus/factory-domain/inventory-rolls/events'
import { WRITE_OFF_REASON_LIST, writeOffNote, writeOffReasonProblem } from '@nexus/factory-domain/inventory/ledger/write-off'
import { INVENTORY_ADJUST, INVENTORY_ISSUE, INVENTORY_SCRAP, INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import {
  atWorkOrderRefusal,
  correctDecision,
  isLengthUom,
  issueDecision,
  lengthIn,
  lengthProblem,
  lengthText,
  moveDecision,
  returnDecision,
  scrapDecision,
  type LengthUom,
  type RollAfter,
  type RollDecision,
} from '@nexus/factory-domain/inventory/rolls/rolls'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { holdOnWriteOff } from '../../quality/holds/checks'
import { issueInCommand } from '../issue/issue'
import { lockWorkOrderIssues, readAtWorkOrder, readPickHeader } from '../issue/store'
import type { StockContext } from '../ledger/access'
import { postMoves, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import { lengthUom, lockLotRolls, refuseRoll, rollFactsOf, rollFor, ROLL_SELECT, rollView, type RollRow } from './facts'
import { emitChange } from './write'

/**
 * A roll's stock (B-W2b-107; SCM-260; B-W2b-80's rule: "the ledger stays per lot: keep lengthLeft and state in the same
 * command as the lot's move"). Each write is ONE command() with an Idempotency-Key (a tablet's is required): the roll's row
 * (its version: concurrent writes of one roll take turns), the lot's roll lock, the lot's move through the ledger's own
 * writers, then the roll's new length left, state and place, an audit row on the roll and fabric_roll.changed (the move also
 * emits inventory.moved; office moves are valued in the command, the floor's by the worker).
 *
 *   POST /inventory/rolls/:rollId/issue    office + floor, inventory.issue: a length off a roll in stock (default all that is
 *                                          left) to a work order, through modules/inventory/issue issueInCommand (W1's rules:
 *                                          holds, reservations, what the work order still needs, the over-issue the office
 *                                          gives with its reason), from the roll's place. All of it: CONSUMED, at the work order.
 *   POST /inventory/rolls/:rollId/return   office + floor, inventory.issue: the end of a roll that went whole to a work order
 *                                          comes back to a place (a RETURN of the lot for the work order, never more than it
 *                                          holds of the lot): END (FULL when all of it came back).
 *   POST /inventory/rolls/:rollId/move     office + floor, inventory.transfer: a roll in stock to another place (a TRANSFER of
 *                                          what is left).
 *   POST /inventory/rolls/:rollId/scrap    office, inventory.scrap: a roll in stock written off with a WRITE_OFF reason (a
 *                                          SCRAP of what is left; a quality hold on the lot refuses, as the write-off does).
 *   POST /inventory/rolls/:rollId/correct  office, inventory.adjust: a roll in stock measured again (an ADJUSTMENT of the
 *                                          difference, with the note and an ADJUSTMENT reason); the length received is fixed.
 *
 * Refusals say why in words (409 `refusal/<CODE>`, the decisions of factory-domain inventory/rolls); the ledger's own (409
 * below zero at the place, a held lot, a locked month) come from postMoves and issueInCommand unchanged.
 */

interface Common {
  readonly version?: number | undefined
  readonly occurredAt?: string | undefined
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

export interface IssueRollBody extends Common {
  readonly workOrderId: string
  readonly length?: string | undefined
  readonly uom?: LengthUom | undefined
  readonly overIssueReason?: string | undefined
}
export interface ReturnRollBody extends Common {
  readonly workOrderId: string
  readonly length: string
  readonly uom?: LengthUom | undefined
  readonly toLocationId: string
  readonly note?: string | null | undefined
}
export interface MoveRollBody extends Common {
  readonly toLocationId: string
  readonly note?: string | null | undefined
}
export interface ScrapRollBody extends Common {
  readonly reasonCode: string
  readonly note?: string | null | undefined
}
export interface CorrectRollBody extends Common {
  readonly lengthLeft: string
  readonly uom?: LengthUom | undefined
  readonly note: string
  readonly reasonCode?: string | undefined
}

/** The base unit of the roll's lot (a length unit: rolls are only tagged on lots counted by length). */
const baseOf = (row: RollRow): LengthUom => (isLengthUom(row.lot.item.baseUom) ? row.lot.item.baseUom : lengthUom(row.uom))
/** A length the body gave in its unit, in the roll's unit. */
const inRollUnit = (row: RollRow, length: string, uom: LengthUom | undefined): string => lengthIn(length, uom ?? lengthUom(row.uom), lengthUom(row.uom)).toFixed(4)
const keyOf = (name: string, idempotencyKey: string | undefined) => `${name}:${idempotencyKey ?? `g-${newId()}`}`
const decided = (decision: RollDecision): Extract<RollDecision, { ok: true }> => {
  if (!decision.ok) refuseRoll(decision.refusal)
  return decision as Extract<RollDecision, { ok: true }>
}
const checkLength = (value: string | undefined, uom: LengthUom, path: string, zero = false): void => {
  const problem = lengthProblem(value, uom, path, zero)
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
}

interface RollWork {
  readonly name: string
  readonly action: string
  readonly change: RollChange
  readonly decide: (row: RollRow) => RollDecision
  /** The lot's move(s) of the decision, posted in the command; answers the moves and the work order it was for. */
  readonly post: (tools: CommandTools, row: RollRow, decision: Extract<RollDecision, { ok: true }>, key: string) => Promise<{ moves: readonly PostedMove[]; workOrderId: string | null }>
  readonly reason?: string | null | undefined
}

/**
 * One roll write: decided only on the row the command holds, so a resent request (a tablet's queue, a retry) answers its
 * stored receipt instead of a refusal of the roll as it stands after it.
 */
async function rollWrite(caller: CommandCaller, rollId: string, permission: Parameters<typeof rollFor>[2], body: Common & object, work: RollWork, idempotencyKey?: string) {
  const { row, context } = await rollFor(caller, rollId, permission)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) ?? undefined : undefined
  const { result } = await command(
    caller,
    {
      name: work.name as `${string}.${string}`,
      idempotencyKey,
      input: { rollId, ...body },
      record: { type: 'FabricRoll', id: row.id, ...(body.version !== undefined ? { expectedVersion: body.version } : {}) },
      ...(context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}),
    },
    async (tools) => {
      const { tx, now } = tools
      await lockLotRolls(tx, context.tenantId, row.lotId)
      const current = await tx.fabricRoll.findUniqueOrThrow({ where: { id: row.id }, select: ROLL_SELECT })
      const decision = decided(work.decide(current))
      const { moves, workOrderId } = await work.post(tools, current, decision, keyOf(work.name, idempotencyKey))
      const after: RollAfter = decision.after
      await tx.fabricRoll.update({ where: { id: current.id }, data: { lengthLeft: after.lengthLeft, state: after.state, locationId: after.locationId, updatedAt: now }, select: { id: true } })
      const updated = await tx.fabricRoll.findUniqueOrThrow({ where: { id: current.id }, select: ROLL_SELECT })
      tools.audit({
        action: work.action,
        recordType: 'FabricRoll',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { state: current.state, lengthLeft: new Dec(current.lengthLeft.toString()).toFixed(4), locationId: current.locationId },
        after: { state: after.state, lengthLeft: after.lengthLeft, locationId: after.locationId, quantity: decision.quantity, uom: lengthUom(current.uom), moveIds: moves.map((move) => move.id), workOrderId },
        ...(work.reason ? { reason: work.reason } : {}),
      })
      emitChange(tools, updated, work.change, moves.map((move) => move.id), workOrderId)
      return { roll: rollView(updated), moveIds: moves.map((move) => move.id), workOrderId }
    },
  )
  return result
}

const contextOfTools = (tools: CommandTools) => tools.context as StockContext

// ---- issue -----------------------------------------------------------------------------------------------------------------

/** POST /inventory/rolls/:rollId/issue. */
export async function issueRoll(caller: CommandCaller, rollId: string, body: IssueRollBody, idempotencyKey?: string) {
  if (body.length !== undefined) checkLength(body.length, body.uom ?? 'M', 'length')
  return rollWrite(caller, rollId, INVENTORY_ISSUE, body, {
    name: 'inventory.issueRoll',
    action: 'inventory.issueRoll',
    change: 'ISSUED',
    decide: (row) => issueDecision(rollFactsOf(row), body.length === undefined ? undefined : inRollUnit(row, body.length, body.uom)),
    post: async (tools, row, decision, key) => {
      const result = await issueInCommand(
        tools,
        body.workOrderId,
        {
          lotId: row.lotId,
          quantity: decision.quantity,
          uom: lengthUom(row.uom),
          fromLocationId: row.locationId!,
          ...(body.overIssueReason ? { overIssueReason: body.overIssueReason } : {}),
          ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
          ...(body.periodLockOverride ? { periodLockOverride: body.periodLockOverride } : {}),
        },
        key,
        'body',
      )
      return { moves: result.issue.moves, workOrderId: result.issue.workOrderId }
    },
  }, idempotencyKey)
}

// ---- return ----------------------------------------------------------------------------------------------------------------

/** POST /inventory/rolls/:rollId/return. */
export async function returnRoll(caller: CommandCaller, rollId: string, body: ReturnRollBody, idempotencyKey?: string) {
  checkLength(body.length, body.uom ?? 'M', 'length')
  return rollWrite(caller, rollId, INVENTORY_ISSUE, body, {
    name: 'inventory.returnRoll',
    action: 'inventory.returnRoll',
    change: 'RETURNED',
    decide: (row) => returnDecision(rollFactsOf(row), inRollUnit(row, body.length, body.uom), body.toLocationId),
    post: async (tools, row, decision, key) => {
      const { tx } = tools
      const context = contextOfTools(tools)
      await lockWorkOrderIssues(tx, context.tenantId, body.workOrderId)
      const workOrder = await readPickHeader(tx, body.workOrderId)
      if (!workOrder || workOrder.siteId !== row.siteId) throw new ValidationError("Not a work order of the roll's site.", [{ path: 'body/workOrderId', message: "Not a work order of the roll's site." }])
      const base = baseOf(row)
      const held = (await readAtWorkOrder(tx, row.siteId, workOrder.id, { itemId: row.itemId, lotId: row.lotId })).reduce((sum, entry) => sum.plus(entry.quantity), ZERO)
      const back = lengthIn(decision.quantity, lengthUom(row.uom), base)
      const refusal = atWorkOrderRefusal(row, workOrder.number, row.lot.code, held, back, base)
      if (refusal) refuseRoll(refusal)
      const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) ?? undefined : undefined
      const draft: MoveDraft = {
        siteId: row.siteId,
        reason: 'RETURN',
        itemId: row.itemId,
        itemColourId: row.lot.itemColourId,
        lotId: row.lotId,
        toLocationId: body.toLocationId,
        quantity: decision.quantity,
        uom: lengthUom(row.uom),
        workOrderId: workOrder.id,
        reference: workOrder.number,
        note: [`Roll ${row.code}: its end back`, (body.note ?? '').trim()].filter((part) => part !== '').join(' — '),
        ...(occurredAt ? { occurredAt } : {}),
      }
      const moves = await postMoves(tools, [draft], { key, issuePath: () => 'body', periodLockOverride: body.periodLockOverride })
      return { moves, workOrderId: workOrder.id }
    },
  }, idempotencyKey)
}

// ---- move ------------------------------------------------------------------------------------------------------------------

/** POST /inventory/rolls/:rollId/move. */
export async function moveRoll(caller: CommandCaller, rollId: string, body: MoveRollBody, idempotencyKey?: string) {
  return rollWrite(caller, rollId, INVENTORY_TRANSFER, body, {
    name: 'inventory.moveRoll',
    action: 'inventory.moveRoll',
    change: 'MOVED',
    decide: (row) => moveDecision(rollFactsOf(row), body.toLocationId),
    post: async (tools, row, decision, key) => {
      const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) ?? undefined : undefined
      const moves = await postMoves(
        tools,
        [
          {
            siteId: row.siteId,
            reason: 'TRANSFER',
            itemId: row.itemId,
            itemColourId: row.lot.itemColourId,
            lotId: row.lotId,
            fromLocationId: row.locationId!,
            toLocationId: body.toLocationId,
            quantity: decision.quantity,
            uom: lengthUom(row.uom),
            reference: `Roll ${row.code}`,
            note: (body.note ?? '').trim() || null,
            ...(occurredAt ? { occurredAt } : {}),
          },
        ],
        { key, issuePath: () => 'body', periodLockOverride: body.periodLockOverride },
      )
      return { moves, workOrderId: null }
    },
  }, idempotencyKey)
}

// ---- scrap -----------------------------------------------------------------------------------------------------------------

/** POST /inventory/rolls/:rollId/scrap. */
export async function scrapRoll(caller: CommandCaller, rollId: string, body: ScrapRollBody, idempotencyKey?: string) {
  const note = (body.note ?? '').trim() || null
  return rollWrite(caller, rollId, INVENTORY_SCRAP, body, {
    name: 'inventory.scrapRoll',
    action: 'inventory.scrapRoll',
    change: 'SCRAPPED',
    reason: writeOffNote(body.reasonCode, note),
    decide: (row) => scrapDecision(rollFactsOf(row)),
    post: async (tools, row, decision, key) => {
      const { tx } = tools
      const code = await tx.reasonCode.findFirst({ where: { list: WRITE_OFF_REASON_LIST, code: body.reasonCode }, select: { active: true, needsDetail: true } })
      const problem = writeOffReasonProblem(code, note)
      if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
      // A lot under an ACTIVE quality hold is quality's to decide (as the write-off: before the stock locks).
      const held = await holdOnWriteOff(tx, tools.context, { lotId: row.lotId, hideId: null })
      if (held) throw new ValidationError(held, [{ path: 'body/refusal/QUALITY_HOLD', message: held }])
      const moves = await postMoves(
        tools,
        [
          {
            siteId: row.siteId,
            reason: 'SCRAP',
            itemId: row.itemId,
            itemColourId: row.lot.itemColourId,
            lotId: row.lotId,
            fromLocationId: row.locationId!,
            quantity: decision.quantity,
            uom: lengthUom(row.uom),
            note: writeOffNote(body.reasonCode, note),
            reasonCode: body.reasonCode,
            reference: `Roll ${row.code}`,
          },
        ],
        { key, issuePath: () => 'body', periodLockOverride: body.periodLockOverride },
      )
      return { moves, workOrderId: null }
    },
  }, idempotencyKey)
}

// ---- correct ---------------------------------------------------------------------------------------------------------------

/** POST /inventory/rolls/:rollId/correct. */
export async function correctRoll(caller: CommandCaller, rollId: string, body: CorrectRollBody, idempotencyKey?: string) {
  checkLength(body.lengthLeft, body.uom ?? 'M', 'lengthLeft', true)
  const note = body.note.trim()
  if (note.length < 3) throw new ValidationError('Say why the length is corrected.', [{ path: 'body/note', message: 'Say why (at least 3 characters).' }])
  return rollWrite(caller, rollId, INVENTORY_ADJUST, body, {
    name: 'inventory.correctRoll',
    action: 'inventory.correctRoll',
    change: 'CORRECTED',
    reason: note,
    decide: (row) => correctDecision(rollFactsOf(row), inRollUnit(row, body.lengthLeft, body.uom)),
    post: async (tools, row, decision, key) => {
      const reasonCode = body.reasonCode?.trim()
      if (reasonCode) {
        const code = await tools.tx.reasonCode.findFirst({ where: { list: 'ADJUSTMENT', code: reasonCode }, select: { active: true } })
        if (!code?.active) throw new ValidationError('Not an active adjustment reason of this company.', [{ path: 'body/reasonCode', message: 'Pick an active adjustment reason.' }])
      }
      const uom = lengthUom(row.uom)
      // correctDecision says which way the stock moves.
      const direction = (decision as { readonly direction?: 'IN' | 'OUT' }).direction ?? 'OUT'
      const words = `Roll ${row.code} measured ${lengthText(decision.after.lengthLeft, uom, 'en')} (said ${lengthText(row.lengthLeft.toString(), uom, 'en')}): ${note}`
      const moves = await postMoves(
        tools,
        [
          {
            siteId: row.siteId,
            reason: 'ADJUSTMENT',
            itemId: row.itemId,
            itemColourId: row.lot.itemColourId,
            lotId: row.lotId,
            ...(direction === 'IN' ? { toLocationId: row.locationId! } : { fromLocationId: row.locationId! }),
            quantity: decision.quantity,
            uom,
            note: words,
            ...(reasonCode ? { reasonCode } : {}),
            reference: `Roll ${row.code}`,
          },
        ],
        { key, issuePath: () => 'body', periodLockOverride: body.periodLockOverride },
      )
      return { moves, workOrderId: null }
    },
  }, idempotencyKey)
}
