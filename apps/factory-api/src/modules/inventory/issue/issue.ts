import type { Uom } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { issueDecision, returnDecision, reversalRefusal, undoRefusal, type HideState, type Refusal } from '@nexus/factory-domain/inventory/issue/rules'
import { quantityText, reversalOf } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_ISSUE, INVENTORY_ISSUE_OVER, INVENTORY_REVERSE } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, postedBy, stockContextOf, type StockContext } from '../ledger/access'
import { InsufficientStockError, LEDGER_SELECT, postMoves, type LedgerRow, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { latestMoveOf, PickRefusedError, pickingWorkOrder, readGroup } from './picking'
import { giveBackIssue, reservedForIssue, ReservedForOtherError } from '../reservations/consume'
import { holdOnIssue } from '../../quality/holds/checks'
import {
  itemUnitsOf,
  lockHideCuts,
  lockWorkOrderIssues,
  readAtWorkOrder,
  readCuts,
  readHides,
  readItems,
  readLocations,
  readLots,
  readPickHeader,
  readSiteStock,
  HIDE_COLUMNS,
  LOT_COLUMNS,
  type HideRow,
  type ItemRow,
  type LotRow,
  type PickHeader,
} from './store'

/**
 * Issue to the work order, return to stock, undo and reversal (B-W1-39; SCM-215, SCM-194, SCM-216; PLAN §4.7 stage
 * 11a-issue; A2 SCR-093). Each is ONE command() whose moves go through the ledger's one writer (postMoves, inside the
 * command), in this lock order: the work order's issue lock (store.ts) → a hide's cut lock (returns and reversals of a
 * hide: what was cut of it stays covered) → the stock locks (postMoves, sorted). The rules are factory-domain
 * inventory/issue/rules; a refusal is a 409 with its code (`refusal/<CODE>`).
 *
 *   issue      office and floor (inventory.issue; the floor at its own site, with an Idempotency-Key): a scanned hide
 *              whole, or a lot or untracked material by quantity (default: what the work order still needs); an
 *              over-issue only with a reason and inventory.issue.over (the office). A hide two tablets scan at once is
 *              issued once: the stock lock lets one through, the other is told it is already issued.
 *   return     office and floor: the unused part, measured, to a location of the site; a hide that left part of itself
 *              becomes a REMNANT.
 *   undo       office and floor: the poster's own last issue, before its next stock action.
 *   reversal   office (inventory.reverse, with the reason): any issue or return of a work order.
 *
 * Every write records its moves' audit rows (postMoves) and one row on the work order, and emits `inventory.issued`,
 * `inventory.returned` or `inventory.pick_reversed`. The first issue to a RELEASED work order says so in its event, and
 * the worker's `inventory.startWorkOrderOnIssue` handler moves it to IN_PROGRESS as the system (the floor role cannot
 * update a work order; ownership/production.json).
 */

/** The stock a request names: a scanned code, or the ids. */
export interface StockRef {
  /** A scanned tag: a hide's code, else a lot's, else an item's. */
  readonly code?: string | undefined
  readonly hideId?: string | undefined
  readonly lotId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
}

interface Resolved {
  readonly item: ItemRow
  readonly itemColourId: string | null
  readonly lot: LotRow | null
  readonly hide: HideRow | null
}

function refused(refusal: Refusal): never {
  throw new PickRefusedError(refusal)
}
/** The caller's context inside a command (postMoves' way). */
const contextOf = (tools: Pick<CommandTools, 'context'>): StockContext =>
  stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('inside a command')) })
const dec = (value: { toString(): string }): Decimal => new Dec(value.toString())
const labelOf = (item: ItemRow, colour: { code: string } | undefined) => `${item.code}${colour ? ` ${colour.code}` : ''}`
const keyFor = (name: string, key: string | undefined) => `${name}:${key ?? `g-${newId()}`}`

/** The stock a request names, at the work order's site (another site's stock is not found). */
async function resolveStock(tx: CommandTx, workOrder: PickHeader, ref: StockRef, path: string): Promise<Resolved> {
  const notFound = () => new ValidationError('This is not stock of the work order\'s site.', [{ path, message: 'Not a hide, lot or material of this site.' }])
  const named = [ref.code, ref.hideId, ref.lotId, ref.itemId].filter((value) => value !== undefined).length
  if (named !== 1) throw new ValidationError('Name the stock once: a scanned code, a hide, a lot or a material.', [{ path, message: 'Exactly one of code, hideId, lotId, itemId.' }])
  let hide: HideRow | null = null
  let lot: LotRow | null = null
  let itemId: string | null = ref.itemId ?? null
  const code = ref.code?.trim()
  if (code) {
    hide = await tx.hide.findFirst({ where: { code }, select: HIDE_COLUMNS })
    if (!hide) lot = await tx.lot.findFirst({ where: { code }, select: LOT_COLUMNS })
    if (!hide && !lot) itemId = (await tx.item.findFirst({ where: { code }, select: { id: true } }))?.id ?? null
    if (!hide && !lot && !itemId) throw notFound()
  } else if (ref.hideId) {
    hide = isUuid(ref.hideId) ? ((await readHides(tx, [ref.hideId])).get(ref.hideId) ?? null) : null
    if (!hide) throw notFound()
  } else if (ref.lotId) {
    lot = isUuid(ref.lotId) ? ((await readLots(tx, [ref.lotId])).get(ref.lotId) ?? null) : null
    if (!lot) throw notFound()
  }
  if (hide) lot = (await readLots(tx, [hide.lotId])).get(hide.lotId) ?? null
  if ((hide && hide.siteId !== workOrder.siteId) || (lot && lot.siteId !== workOrder.siteId)) throw notFound()
  const id = hide?.itemId ?? lot?.itemId ?? itemId
  const item = id && isUuid(id) ? (await readItems(tx, [id])).get(id) : undefined
  if (!item) throw notFound()
  if (!lot && item.tracking !== 'NONE') {
    throw new ValidationError(`${item.code} is tracked by ${item.tracking}: scan its ${item.tracking === 'HIDE' ? 'hide' : 'lot'}.`, [{ path, message: `Name the ${item.tracking === 'HIDE' ? 'hide' : 'lot'}.` }])
  }
  if (lot && !hide && item.tracking === 'HIDE') {
    throw new ValidationError(`${item.code} is issued hide by hide: scan a hide of lot ${lot.code}.`, [{ path, message: 'Name the hide.' }])
  }
  let itemColourId: string | null
  if (lot) itemColourId = lot.itemColourId
  else if (ref.itemColourId !== undefined) itemColourId = ref.itemColourId
  else {
    // An untracked material named without its colour: the one colour the work order plans of it, if only one.
    const planned = await tx.workOrderMaterial.groupBy({ by: ['itemColourId'], where: { workOrderId: workOrder.id, itemId: item.id } })
    itemColourId = planned.length === 1 ? planned[0]!.itemColourId : null
  }
  return { item, itemColourId, lot, hide }
}

/** The work order, read and locked for issuing (another site's, or one the caller may not reach: not found). */
async function lockedWorkOrder(tools: CommandTools, workOrderId: string): Promise<PickHeader> {
  const context = contextOf(tools)
  await lockWorkOrderIssues(tools.tx, context.tenantId, workOrderId)
  const workOrder = await readPickHeader(tools.tx, workOrderId)
  if (!workOrder) throw new NotFoundError('Work order not found.')
  return workOrder
}

const quantityOf = (item: ItemRow, body: { readonly quantity?: string | undefined; readonly uom?: Uom | undefined; readonly baseQuantity?: string | undefined }, path: string) => {
  if (body.quantity === undefined) return null
  const uom = body.uom ?? item.baseUom
  const base = baseQuantityOf({ quantity: body.quantity, uom, baseQuantity: body.baseQuantity ?? null }, itemUnitsOf(item))
  if (base.problem) throw new ValidationError(base.problem.message, [{ path: `${path}/${base.problem.path}`, message: base.problem.message }])
  return { quantity: body.quantity, uom, baseQuantity: base.baseQuantity }
}

const sumOf = (rows: readonly { baseQuantity: string }[]): string => quantityText(rows.reduce((sum, row) => sum.plus(new Dec(row.baseQuantity)), ZERO))

// ---- issue ----------------------------------------------------------------------------------------------------------------

export interface IssueInput extends StockRef {
  /** A lot or untracked material: how much (default what the work order still needs). Never for a hide (whole). */
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  /** Take it from this location only (default: wherever the site holds it, by location code). */
  readonly fromLocationId?: string | undefined
  /** An over-issue (the office, inventory.issue.over): why. */
  readonly overIssueReason?: string | undefined
  /** When it happened, by the device's clock (a floor scan sent later). Default now. */
  readonly occurredAt?: string | undefined
  /** B-W2a-F8: the reason an issue dated inside a SOFT-locked month is posted anyway. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

export interface IssueResult {
  readonly issue: {
    readonly id: string
    readonly workOrderId: string
    readonly number: string
    readonly itemId: string
    readonly itemColourId: string | null
    readonly lotId: string | null
    readonly hideId: string | null
    readonly baseQuantity: string
    readonly overIssue: boolean
    readonly startsWorkOrder: boolean
    readonly moves: PostedMove[]
  }
  readonly line: { readonly planned: string; readonly issued: string; readonly toIssue: string }
}

/**
 * Issues stock to a work order INSIDE the caller's command (this module's route, and cutting's scan of a hide not yet
 * issued, B-W1-40): the work order's issue lock, the rules, postMoves, the audit row on the work order and the event.
 * `key` is the command's (its moves' keys are `<key>:<n>`).
 */
export async function issueInCommand(tools: CommandTools, workOrderId: string, body: IssueInput, key: string, path = 'body'): Promise<IssueResult> {
  const context = contextOf(tools)
  const workOrder = await lockedWorkOrder(tools, workOrderId)
  const { tx } = tools
  const reason = body.overIssueReason?.trim() || null
  if (reason && !mayOverIssue(context, workOrder)) throw new ForbiddenError('An over-issue is the office\'s, with inventory.issue.over.')
  const stock = await resolveStock(tx, workOrder, body, path)
  const { item, itemColourId, lot, hide } = stock
  // W2a B-W2a-26 hook (modules/quality/holds/checks.ts): a lot, hide or work order on hold is refused with the hold's
  // reason before the database's StockMove_awaits_quality_hold would.
  const held = await holdOnIssue(tx, tools.context, { lotId: lot?.id ?? null, hideId: hide?.id ?? null, workOrderId: workOrder.id })
  if (held) refused({ code: 'QUALITY_HOLD', message: held })
  if (hide && body.quantity !== undefined) throw new ValidationError('A hide is issued whole, with what it measures.', [{ path: `${path}/quantity`, message: 'Leave it out for a hide.' }])
  const requested = quantityOf(item, body, path)

  const planned = await tx.workOrderMaterial.groupBy({ by: ['itemColourId'], where: { workOrderId: workOrder.id, itemId: item.id }, _sum: { baseQuantity: true } })
  const plannedLine = planned.find((row) => row.itemColourId === itemColourId)
  const issuedNow = (await readAtWorkOrder(tx, workOrder.siteId, workOrder.id, { itemId: item.id, itemColourId })).reduce((sum, row) => sum.plus(new Dec(row.quantity)), ZERO)
  const balances = (await readSiteStock(tx, workOrder.siteId, { itemIds: [item.id], itemColourId, lotId: lot?.id ?? null, hideId: hide?.id ?? null })).filter(
    // A hide is issued whole, from wherever it lies; a quantity from the location asked, when one is.
    (balance) => hide !== null || !body.fromLocationId || balance.locationId === body.fromLocationId,
  )
  const onHand = balances.reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
  const colour = itemColourId ? await tx.itemColour.findUnique({ where: { id: itemColourId }, select: { code: true } }) : null
  const label = labelOf(item, colour ?? undefined)

  const decision = issueDecision({
    workOrder: { number: workOrder.number, status: workOrder.status },
    label,
    baseUom: item.baseUom,
    line: plannedLine ? { planned: dec(plannedLine._sum.baseQuantity ?? ZERO).toFixed(4), issued: issuedNow.toFixed(4) } : null,
    materialPlanned: planned.length > 0,
    lot: lot ? { code: lot.code, qualityStatus: lot.qualityStatus, requiresCrViTest: lot.requiresCrViTest, crViStatus: lot.crViStatus } : null,
    hide: hide ? { code: hide.code, state: hide.state } : null,
    onHand: onHand.toFixed(4),
    requested: requested?.baseQuantity ?? null,
    overIssueReason: reason,
  })
  if (!decision.ok) {
    if (decision.refusal.code === 'NOTHING_ON_HAND' && hide) throw await alreadyIssued(tx, hide)
    refused(decision.refusal)
  }

  // Where it is taken from: a hide from every location holding it (whole), a quantity location by location by code.
  const locations = await readLocations(tx, balances.map((balance) => balance.locationId))
  const sorted = [...balances].sort((a, b) => ((locations.get(a.locationId)?.code ?? '') < (locations.get(b.locationId)?.code ?? '') ? -1 : 1))
  let left = new Dec(decision.baseQuantity)
  const takes: { locationId: string; baseQuantity: string }[] = []
  for (const balance of sorted) {
    if (left.lte(0)) break
    const take = Dec.min(left, balance.onHand)
    takes.push({ locationId: balance.locationId, baseQuantity: quantityText(take) })
    left = left.minus(take)
  }
  // B-W2a-11: stock another work order's (or order line's) reservation holds is refused in words; after the moves the
  // issue counts against this work order's own reservations (modules/inventory/reservations/consume.ts).
  const reserved = await reservedForIssue(
    tools,
    { workOrder, itemId: item.id, itemColourId, label, baseUom: item.baseUom, lot: lot ? { id: lot.id, code: lot.code } : null, hide: hide ? { id: hide.id, code: hide.code } : null },
    decision.baseQuantity,
  ).catch((error: unknown) => {
    if (error instanceof ReservedForOtherError) refused({ code: 'RESERVED_FOR_OTHER', message: error.words })
    throw error
  })
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined
  const asEntered = requested && takes.length === 1 && requested.uom !== item.baseUom
  const drafts: MoveDraft[] = takes.map((take) => ({
    siteId: workOrder.siteId,
    reason: 'ISSUE',
    itemId: item.id,
    itemColourId,
    lotId: lot?.id ?? null,
    hideId: hide?.id ?? null,
    fromLocationId: take.locationId,
    ...(asEntered ? { quantity: requested.quantity, uom: requested.uom, baseQuantity: requested.baseQuantity } : { quantity: take.baseQuantity, uom: item.baseUom }),
    workOrderId: workOrder.id,
    reference: workOrder.number,
    note: decision.overIssue ? `Over-issue: ${reason}` : null,
    ...(occurredAt ? { occurredAt } : {}),
  }))
  let moves: PostedMove[]
  try {
    moves = await postMoves(tools, drafts, {
      key,
      issuePath: () => path,
      periodLockOverride: body.periodLockOverride,
    })
  } catch (error) {
    // Another tablet issued the same hide first (it held the stock lock): who-free words, not the balance (SCM-194).
    if (error instanceof InsufficientStockError && hide) throw await alreadyIssued(tx, hide)
    throw error
  }

  const baseQuantity = sumOf(moves)
  await reserved.consume(moves.map((move) => move.id), baseQuantity)
  const startsWorkOrder = workOrder.status === 'RELEASED'
  const issue = {
    id: moves[0]!.id,
    workOrderId: workOrder.id,
    number: workOrder.number,
    itemId: item.id,
    itemColourId,
    lotId: lot?.id ?? null,
    hideId: hide?.id ?? null,
    baseQuantity,
    overIssue: decision.overIssue,
    startsWorkOrder,
    moves,
  }
  tools.audit({
    action: 'inventory.issue',
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: { issueId: issue.id, moveIds: moves.map((move) => move.id), itemId: item.id, itemColourId, lotId: issue.lotId, hideId: issue.hideId, baseQuantity, overIssue: decision.overIssue },
    ...(decision.overIssue && reason ? { reason } : {}),
  })
  tools.emit({
    type: 'inventory.issued',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      issueId: issue.id,
      moveIds: moves.map((move) => move.id),
      itemId: item.id,
      itemColourId,
      lotId: issue.lotId,
      hideId: issue.hideId,
      baseQuantity,
      overIssue: decision.overIssue,
      startsWorkOrder,
      postedBy: postedBy(context).audience,
    },
  })
  const planned4 = plannedLine ? dec(plannedLine._sum.baseQuantity ?? ZERO) : ZERO
  const issuedAfter = issuedNow.plus(new Dec(baseQuantity))
  return { issue, line: { planned: quantityText(planned4), issued: quantityText(issuedAfter), toIssue: quantityText(Dec.max(ZERO, planned4.minus(issuedAfter))) } }
}

const mayOverIssue = (context: StockContext, workOrder: PickHeader): boolean =>
  context.audience === 'system' || (context.audience === 'office' && can(actorOf(context), INVENTORY_ISSUE_OVER, { companyId: workOrder.companyId, siteId: workOrder.siteId }))

/** "Already issued to WO-… on …": the hide's last issue not reversed (its work order's number and time), else none on hand. */
async function alreadyIssued(tx: CommandTx, hide: HideRow): Promise<PickRefusedError> {
  const issues = await tx.stockMove.findMany({ where: { hideId: hide.id, reason: 'ISSUE', reversalOfId: null }, orderBy: { id: 'desc' }, take: 5, select: { id: true, workOrderId: true, occurredAt: true } })
  const reversed = new Set((await tx.stockMove.findMany({ where: { reversalOfId: { in: issues.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId))
  const last = issues.find((row) => !reversed.has(row.id))
  const workOrder = last?.workOrderId ? await tx.workOrder.findUnique({ where: { id: last.workOrderId }, select: { number: true } }) : null
  if (!last || !workOrder) return new PickRefusedError({ code: 'NOTHING_ON_HAND', message: `None of hide ${hide.code} is in stock at this site.` })
  const at = toUtcIso(last.occurredAt)
  return new PickRefusedError({ code: 'ALREADY_ISSUED', message: `Hide ${hide.code} is already issued to work order ${workOrder.number} (${at.slice(0, 10)} ${at.slice(11, 16)} UTC).` })
}

export async function issue(caller: CommandCaller, workOrderId: string, body: IssueInput, idempotencyKey?: string): Promise<IssueResult> {
  const { context } = await pickingWorkOrder(caller, workOrderId)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined
  const { result } = await command(
    caller,
    { name: 'inventory.issue', idempotencyKey, input: { workOrderId, ...body }, ...(context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}) },
    (tools) => issueInCommand(tools, workOrderId, body, keyFor('inventory.issue', idempotencyKey)),
  )
  return result
}

// ---- return ---------------------------------------------------------------------------------------------------------------

export interface ReturnInput extends StockRef {
  /** Measured: a remnant's area, a roll's metres, in `uom` (default the item's base unit). */
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly toLocationId: string
  readonly note?: string | null | undefined
  readonly occurredAt?: string | undefined
  /** B-W2a-F8: the reason a return dated inside a SOFT-locked month is posted anyway. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

export async function returnStock(caller: CommandCaller, workOrderId: string, body: ReturnInput, idempotencyKey?: string) {
  const { context } = await pickingWorkOrder(caller, workOrderId)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined
  const { result } = await command(
    caller,
    { name: 'inventory.return', idempotencyKey, input: { workOrderId, ...body }, ...(context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}) },
    async (tools) => {
      const workOrder = await lockedWorkOrder(tools, workOrderId)
      const { tx } = tools
      const { item, itemColourId, lot, hide } = await resolveStock(tx, workOrder, body, 'body')
      const measured = quantityOf(item, body, 'body')!
      if (hide) await lockHideCuts(tx, context.tenantId, workOrder.siteId, hide.id)
      const at = (await readAtWorkOrder(tx, workOrder.siteId, workOrder.id, { itemId: item.id, itemColourId, lotId: lot?.id ?? null, hideId: hide?.id ?? null })).reduce((sum, row) => sum.plus(new Dec(row.quantity)), ZERO)
      const cut = hide ? ((await readCuts(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id) ?? '0') : '0'
      const colour = itemColourId ? await tx.itemColour.findUnique({ where: { id: itemColourId }, select: { code: true } }) : null
      const decision = returnDecision({
        workOrder: { number: workOrder.number },
        label: labelOf(item, colour ?? undefined),
        baseUom: item.baseUom,
        atWorkOrder: at.toFixed(4),
        cut,
        hide: hide ? { code: hide.code, state: hide.state } : null,
        baseQuantity: measured.baseQuantity,
      })
      if (!decision.ok) refused(decision.refusal)
      const [move] = await postMoves(
        tools,
        [
          {
            siteId: workOrder.siteId,
            reason: 'RETURN',
            itemId: item.id,
            itemColourId,
            lotId: lot?.id ?? null,
            hideId: hide?.id ?? null,
            toLocationId: body.toLocationId,
            quantity: measured.quantity,
            uom: measured.uom,
            baseQuantity: measured.baseQuantity,
            workOrderId: workOrder.id,
            reference: workOrder.number,
            note: body.note?.trim() || null,
            ...(occurredAt ? { occurredAt } : {}),
          },
        ],
        {
          key: keyFor('inventory.return', idempotencyKey),
          issuePath: () => 'body',
          periodLockOverride: body.periodLockOverride,
        },
      )
      const hideState: HideState | null = decision.hideState
      if (hide && hideState && hideState !== hide.state) {
        await tx.hide.update({ where: { id: hide.id }, data: { state: hideState, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'inventory.hideState', recordType: 'Hide', recordId: hide.id, companyId: workOrder.companyId, siteId: workOrder.siteId, before: { state: hide.state }, after: { state: hideState } })
      }
      tools.audit({
        action: 'inventory.return',
        recordType: 'WorkOrder',
        recordId: workOrder.id,
        companyId: workOrder.companyId,
        siteId: workOrder.siteId,
        after: { returnId: move!.id, itemId: item.id, itemColourId, lotId: move!.lotId, hideId: move!.hideId, baseQuantity: move!.baseQuantity, toLocationId: body.toLocationId, hideState },
      })
      tools.emit({
        type: 'inventory.returned',
        subject: workOrder.id,
        companyId: workOrder.companyId,
        siteId: workOrder.siteId,
        payload: {
          workOrderId: workOrder.id,
          number: workOrder.number,
          returnId: move!.id,
          itemId: item.id,
          itemColourId,
          lotId: move!.lotId,
          hideId: move!.hideId,
          toLocationId: body.toLocationId,
          baseQuantity: move!.baseQuantity,
          hideState,
          postedBy: postedBy(context).audience,
        },
      })
      return { return: { id: move!.id, workOrderId: workOrder.id, number: workOrder.number, hideState, move: move! } }
    },
  )
  return result
}

// ---- undo and reversal ----------------------------------------------------------------------------------------------------

const UNDO_NOTE = 'Undone by the poster before the next action (issued by mistake).'

/** The move a reversal or undo names, visible to the caller with `permission` (else not found). */
async function pickedMove(caller: CommandCaller, moveId: string, permission: typeof INVENTORY_ISSUE | typeof INVENTORY_REVERSE): Promise<{ context: StockContext; move: LedgerRow }> {
  const context = stockContextOf(caller)
  const move = isUuid(moveId) ? await caller.withClient((client) => client.stockMove.findUnique({ where: { id: moveId }, select: LEDGER_SELECT })) : null
  if (!move || !move.workOrderId || (move.reason !== 'ISSUE' && move.reason !== 'RETURN') || !mayAt(context, permission, move)) throw new NotFoundError('Issue not found.')
  await pickingWorkOrder(caller, move.workOrderId, permission)
  return { context, move }
}

/** Reverses one issue or return (all the moves its command posted), inside the caller's command, after the checks. */
async function reverseGroup(tools: CommandTools, original: LedgerRow, options: { readonly undo: boolean; readonly note: string; readonly key: string }) {
  const context = contextOf(tools)
  const workOrder = await lockedWorkOrder(tools, original.workOrderId!)
  const { tx } = tools
  const moves = await readGroup(tx, original)
  const reversed = (await tx.stockMove.count({ where: { reversalOfId: { in: moves.map((move) => move.id) } } })) > 0
  let hideFacts: { code: string; atWorkOrder: string; cut: string; baseUom: string } | null = null
  // Giving an issued hide back to stock must leave what was cut of it: under the cut log's own lock. (A return's reversal
  // takes the hide back to the work order: it needs no cut lock, and takes the stock lock as postMoves does.)
  if (original.hideId && original.reason === 'ISSUE') {
    await lockHideCuts(tx, context.tenantId, original.siteId, original.hideId)
    const hide = (await readHides(tx, [original.hideId])).get(original.hideId)
    const item = (await readItems(tx, [original.itemId])).get(original.itemId)
    const at = (await readAtWorkOrder(tx, workOrder.siteId, workOrder.id, { hideId: original.hideId, itemId: original.itemId })).reduce((sum, row) => sum.plus(new Dec(row.quantity)), ZERO)
    const cut = (await readCuts(tx, workOrder.siteId, workOrder.id, [original.hideId])).get(original.hideId) ?? '0'
    hideFacts = { code: hide?.code ?? original.hideId, atWorkOrder: at.toFixed(4), cut, baseUom: item?.baseUom ?? '' }
  }
  const picked = moves.map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() }))
  const refusal = reversalRefusal(picked, { reversed, workOrderNumber: workOrder.number, hide: hideFacts })
  if (refusal) refused(refusal)
  if (options.undo) {
    const own = moves.every((move) => (context.audience === 'floor' ? move.deviceId === context.deviceId && move.createdById === context.actorId : context.audience === 'office' && move.deviceId === null && move.createdById === context.actorId))
    const latest = own ? await latestMoveOf(tx, context, workOrder.siteId) : null
    const undo = undoRefusal(picked, latest)
    if (undo) refused(undo)
  }
  const drafts: MoveDraft[] = moves.map((move) => ({
    ...reversalOf({ ...move, quantity: move.quantity.toString(), baseQuantity: move.baseQuantity.toString() }, options.note),
    uom: move.uom,
  }))
  if (original.reason === 'ISSUE') {
    // B-W2a-11: what the issue counted against the work order's reservations goes back to those still ACTIVE.
    const item = (await readItems(tx, [original.itemId])).get(original.itemId)
    const lot = original.lotId ? (await readLots(tx, [original.lotId])).get(original.lotId) : undefined
    const hide = original.hideId ? (await readHides(tx, [original.hideId])).get(original.hideId) : undefined
    await giveBackIssue(
      tools,
      {
        workOrder,
        itemId: original.itemId,
        itemColourId: original.itemColourId,
        label: item?.code ?? original.itemId,
        baseUom: item?.baseUom ?? '',
        lot: lot ? { id: lot.id, code: lot.code } : null,
        hide: hide ? { id: hide.id, code: hide.code } : null,
      },
      sumOf(picked),
      moves.map((move) => move.id),
    )
  }
  const posted = await postMoves(tools, drafts, { key: options.key, issuePath: () => 'body' })
  tools.audit({
    action: options.undo ? 'inventory.undoIssue' : 'inventory.reverseIssue',
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: { reversedId: moves[0]!.id, of: original.reason, moveIds: posted.map((move) => move.id), baseQuantity: sumOf(posted) },
    reason: options.note,
  })
  tools.emit({
    type: 'inventory.pick_reversed',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      reversedId: moves[0]!.id,
      of: original.reason as 'ISSUE' | 'RETURN',
      undo: options.undo,
      moveIds: posted.map((move) => move.id),
      postedBy: postedBy(context).audience,
    },
  })
  return { reversal: { reversedId: moves[0]!.id, of: original.reason as 'ISSUE' | 'RETURN', workOrderId: workOrder.id, number: workOrder.number, baseQuantity: sumOf(posted), moves: posted } }
}

/** The poster's own last issue, undone before its next stock action (the floor's Undo strip; the office's own too). */
export async function undoIssue(caller: CommandCaller, moveId: string, idempotencyKey?: string) {
  const { move } = await pickedMove(caller, moveId, INVENTORY_ISSUE)
  const { result } = await command(caller, { name: 'inventory.undoIssue', idempotencyKey, input: { moveId } }, (tools) =>
    reverseGroup(tools, move, { undo: true, note: UNDO_NOTE, key: keyFor('inventory.undoIssue', idempotencyKey) }),
  )
  return result
}

/** The office's reversal of any issue or return of a work order, with the reason. */
export async function reversePick(caller: CommandCaller, moveId: string, body: { readonly note: string }, idempotencyKey?: string) {
  const { context, move } = await pickedMove(caller, moveId, INVENTORY_REVERSE)
  if (context.audience !== 'office') throw new ForbiddenError()
  const { result } = await command(caller, { name: 'inventory.reverseIssue', idempotencyKey, input: { moveId, ...body } }, (tools) =>
    reverseGroup(tools, move, { undo: false, note: body.note.trim(), key: keyFor('inventory.reverseIssue', idempotencyKey) }),
  )
  return result
}

