import type { Prisma, StockMoveReason, StockValuationMethod, Uom } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  balancesFromSums,
  changesSiteStock,
  locatedKeyOf,
  moveProblems,
  quantityText,
  reversalProblems,
  shortfalls,
  type ItemTracking,
  type LocatedKey,
  type Shortfall,
} from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { costBasis, lotUnitCost, valuationKey, valueOfMove, type CostBasis, type ValuationMethod } from '@nexus/factory-domain/inventory/ledger/valuation'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools, CommandTx } from '../../../core/command'
import { honourPeriodLocks, lockDayOf } from '../../accounting/period-guard'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { postedBy, stockContextOf, type StockContext } from './access'

/**
 * postMoves(): the ONE writer of the stock ledger (plan A1 §2.1, §2.6; SCM-189, SCM-192, SCM-194), called INSIDE the
 * caller's command() by every module that moves stock: receipts (B-W1-32, 33), opening stock (B-W1-35), issues and
 * returns (B-W1-39), and this module's transfers, adjustments, counts, scraps and reversals.
 *
 *   const posted = await postMoves(tools, [{ siteId, reason: 'TRANSFER', itemId, lotId, hideId, fromLocationId,
 *     toLocationId, quantity: '53.2' }], { key: `inventory.transfer:${idempotencyKey}` })
 *
 * In the caller's transaction (READ COMMITTED, command()'s; each statement sees what committed before it), in order:
 *   1. every move gets its base quantity (factory-domain inventory/ledger/units, on product/units: computed for a unit
 *      the item converts, the caller's for a HIDE or ROLL, a mismatch refused), and is checked against the domain
 *      (factory-domain inventory/ledger moves) and the rows it names (site,
 *      item, colour, lot, hide, locations, receipt line, the move it reverses), with the same rules as the
 *      …_supply_guards trigger, so the caller gets a clear 400 (paths `moves/<i>/<field>`, or the caller's) instead of a
 *      trigger message that a Prisma model call can lose. A floor device posts only at its own site and never a cost;
 *   2. the stock it takes is locked with the trigger's own transaction lock (one per location and stock key, sorted, so
 *      two batches never deadlock), its balance read under the lock, and a move that would take a location below zero
 *      is a 409 (InsufficientStockError) before any insert (SCM-194: two scans never take the same hide);
 *   3. the moves are inserted in order (the trigger checks each again), each with its idempotency key: `<key>:<n>` from
 *      the caller's command key, or the draft's own, or `move:<id>`; a key used before is a 409;
 *   4. office and system callers value every move that enters or leaves the site's stock in the same command
 *      (StockValuation, key `move:<id>`, factory-domain valuation's basis: the draft's cost, a reversal's original,
 *      the lot's, the item's standard cost); the floor's are valued after their event by the worker
 *      (valuation.ts floorMoveValuationHandler). A reversal of a move not valued yet values that move first;
 *   5. one audit row per move and per valuation (values marked with the cost grain), and one `inventory.moved` event
 *      per move.
 * It returns the posted moves as plain JSON (never a cost). Permissions are the caller's: postMoves checks none but the
 * floor's site.
 */

export const MAX_MOVES_PER_POST = 500

export interface MoveDraft {
  readonly siteId: string
  readonly reason: StockMoveReason
  readonly itemId: string
  /** Left out: the lot's colour (a lot is one colour); null: no colour. */
  readonly itemColourId?: string | null
  /** Left out: the hide's lot. */
  readonly lotId?: string | null
  readonly hideId?: string | null
  readonly fromLocationId?: string | null
  readonly toLocationId?: string | null
  /** Above 0, in `uom`: a decimal string. */
  readonly quantity: string
  /** Default the item's base unit. */
  readonly uom?: Uom
  /**
   * In the item's base unit. Computed for a unit the item converts (m² for an item in ft², its purchase or consumption
   * unit): one sent must match it. Required for a unit of the item's own size (HIDE, SIDE, ROLL, CONE, BOX, SET).
   */
  readonly baseQuantity?: string
  readonly receiptLineId?: string | null
  /** W2b (B-W2b-19): a SHIPMENT move names the shipment line its garments leave with (and only it: the trigger). */
  readonly shipmentLineId?: string | null
  /** W2b (B-W2b-16): a CUSTOMER_RETURN move names the return line its goods came back on, and that line's customer. */
  readonly returnLineId?: string | null
  readonly returnPartyId?: string | null
  readonly workOrderId?: string | null
  readonly reference?: string | null
  /** Why: required for ADJUSTMENT, COUNT, SCRAP and a reversal. */
  readonly note?: string | null
  /** B-W2b-14/15: the code of the reason list the move was made for (WRITE_OFF, ADJUSTMENT, the floor's SCRAP list, a SUPPLIER_RETURN's CLAIM code…), no spaces. */
  readonly reasonCode?: string | null
  readonly reversalOfId?: string | null
  /** When it happened (a floor scan: the device's time). Default the command's time. */
  readonly occurredAt?: Date
  /** The move's own idempotency key (instead of `<key>:<n>`). */
  readonly idempotencyKey?: string
  /** Office and system only: the cost to value it at (a receipt's purchase price, a typed cost). */
  readonly cost?: { readonly method: ValuationMethod; readonly unitCost: string } | null
}

export interface PostOptions {
  /** The command's key, `<command>:<Idempotency-Key>`: move n's key is `<key>:<n>`. */
  readonly key?: string | null
  /** Where a move's issues point: default `moves/<index>`. */
  readonly issuePath?: (index: number) => string
  /** B-W2a-F8: the body's reason a move dated inside a SOFT-locked month is posted anyway (`periodLockOverride`). */
  readonly periodLockOverride?: PeriodLockOverride | null | undefined
}

/** A posted move as postMoves answers it (plain JSON, never a cost). */
export interface PostedMove {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly reason: StockMoveReason
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly quantity: string
  readonly uom: Uom
  readonly baseQuantity: string
  readonly receiptLineId: string | null
  readonly workOrderId: string | null
  readonly reference: string | null
  readonly note: string | null
  /** B-W2b-15: the code of the reason list it was made for, or null. */
  readonly reasonCode: string | null
  readonly reversalOfId: string | null
  readonly idempotencyKey: string
  readonly occurredAt: string
  /** Its value was written in this command (false: a transfer, an item without a cost, or a floor move). */
  readonly valued: boolean
}

/** A move would take a location below zero (SCM-194). A 409, before the insert. */
export class InsufficientStockError extends ConflictError {
  override name = 'InsufficientStockError'
  override readonly issues: readonly Issue[]
  constructor(message: string, issues: readonly Issue[]) {
    super(message)
    this.issues = issues
  }
}

// ---- the rows a batch names --------------------------------------------------------------------------------------------

const ITEM_SELECT = { id: true, code: true, tracking: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true, currency: true } as const
type ItemRow = {
  id: string
  code: string
  tracking: ItemTracking
  baseUom: Uom
  purchaseUom: Uom
  purchaseFactor: Prisma.Decimal
  consumptionUom: Uom
  consumptionFactor: Prisma.Decimal
  currency: string
  standardCost?: Prisma.Decimal | null
}
const LOT_SELECT = { id: true, siteId: true, itemId: true, itemColourId: true, code: true, qualityStatus: true, receiptLineId: true } as const
const HIDE_SELECT = { id: true, siteId: true, lotId: true, itemId: true, code: true, state: true } as const
const LOCATION_SELECT = { id: true, siteId: true, code: true, status: true } as const
export const LEDGER_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  reason: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  fromLocationId: true,
  toLocationId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  receiptLineId: true,
  workOrderId: true,
  reference: true,
  note: true,
  reasonCode: true,
  reversalOfId: true,
  idempotencyKey: true,
  occurredAt: true,
  createdAt: true,
  createdById: true,
  deviceId: true,
} as const satisfies Prisma.StockMoveSelect
export type LedgerRow = Prisma.StockMoveGetPayload<{ select: typeof LEDGER_SELECT }>

const ids = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string' && isUuid(value)))]
const byId = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))

/** A draft with its lot and colour filled in from its hide and lot (a scanned hide tag is enough). */
export interface KeyedDraft extends MoveDraft {
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
}

/** Fills each key's lot from its hide and its colour from its lot, where the caller left them out. */
export async function completeKeys<Key extends { readonly itemColourId?: string | null; readonly lotId?: string | null; readonly hideId?: string | null }>(
  tx: CommandTx,
  keys: readonly Key[],
): Promise<(Key & { readonly itemColourId: string | null; readonly lotId: string | null; readonly hideId: string | null })[]> {
  const hides = byId(await tx.hide.findMany({ where: { id: { in: ids(keys.filter((key) => key.lotId === undefined).map((key) => key.hideId)) } }, select: { id: true, lotId: true } }))
  const withLots = keys.map((key) => ({ ...key, hideId: key.hideId ?? null, lotId: key.lotId !== undefined ? key.lotId : (key.hideId ? hides.get(key.hideId)?.lotId : undefined) ?? null }))
  const lots = byId(await tx.lot.findMany({ where: { id: { in: ids(withLots.filter((key) => key.itemColourId === undefined).map((key) => key.lotId)) } }, select: { id: true, itemColourId: true } }))
  return withLots.map((key) => ({ ...key, itemColourId: key.itemColourId !== undefined ? key.itemColourId : (key.lotId ? lots.get(key.lotId)?.itemColourId : null) ?? null }))
}

// ---- locks and balances ------------------------------------------------------------------------------------------------

/**
 * Takes the …_supply_guards trigger's own transaction lock for each location and stock key (the same hash), sorted:
 * concurrent batches of the same stock wait for each other here, and the trigger's lock is then already held.
 */
export async function lockStock(tx: CommandTx, tenantId: string, keys: readonly LocatedKey[]): Promise<void> {
  const unique = [...new Map(keys.map((key) => [locatedKeyOf(key), key])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [, key] of unique) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.stock', ${tenantId}::uuid, ${key.siteId}::uuid, ${key.locationId}::uuid,
      ${key.itemId}::uuid, coalesce(${key.itemColourId}::uuid::text, '-'), coalesce(${key.lotId}::uuid::text, '-'), coalesce(${key.hideId}::uuid::text, '-')), 0))`
  }
}

/** The balances of these keys now (read after their locks: what committed before). Missing keys are 0. */
export async function readBalances(tx: CommandTx, keys: readonly LocatedKey[]): Promise<Map<string, Decimal>> {
  const balances = new Map<string, Decimal>(keys.map((key) => [locatedKeyOf(key), ZERO]))
  if (keys.length === 0) return balances
  const where = { siteId: { in: ids(keys.map((key) => key.siteId)) }, itemId: { in: ids(keys.map((key) => key.itemId)) } }
  const locations = ids(keys.map((key) => key.locationId))
  // One query after another: a transaction's client has one connection (pg refuses concurrent queries on it).
  const into = await tx.stockMove.groupBy({ by: ['toLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { ...where, toLocationId: { in: locations } }, _sum: { baseQuantity: true } })
  const outOf = await tx.stockMove.groupBy({ by: ['fromLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { ...where, fromLocationId: { in: locations } }, _sum: { baseQuantity: true } })
  const sum = (row: { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; _sum: { baseQuantity: Prisma.Decimal | null } }, locationId: string) => ({
    siteId: row.siteId,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    locationId,
    quantity: row._sum.baseQuantity?.toString() ?? '0',
  })
  for (const balance of balancesFromSums(
    into.map((row) => sum(row, row.toLocationId!)),
    outOf.map((row) => sum(row, row.fromLocationId!)),
    { keepZero: true },
  )) {
    const id = locatedKeyOf(balance)
    if (balances.has(id)) balances.set(id, balance.onHand)
  }
  return balances
}

// ---- postMoves ---------------------------------------------------------------------------------------------------------

export async function postMoves(tools: CommandTools, drafts: readonly MoveDraft[], options: PostOptions = {}): Promise<PostedMove[]> {
  const context = stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('postMoves runs inside a command')) })
  const { tx } = tools
  const at = options.issuePath ?? ((index: number) => `moves/${index}`)
  if (drafts.length === 0) throw new ValidationError('Post at least one move.', [{ path: 'moves', message: 'Expected at least one move.' }])
  if (drafts.length > MAX_MOVES_PER_POST) throw new ValidationError(`At most ${MAX_MOVES_PER_POST} moves at once.`, [{ path: 'moves', message: `At most ${MAX_MOVES_PER_POST}.` }])
  if (context.audience === 'floor') {
    if (drafts.some((draft) => draft.siteId !== context.siteId)) throw new ForbiddenError('A floor device moves stock only at its own site.')
    if (drafts.some((draft) => draft.cost)) throw new ForbiddenError('A floor device never sets a cost.')
  }

  const keyed = await completeKeys(tx, drafts)
  const facts = await readFacts(tx, context, keyed)
  // Each move's unit and base quantity (the product units module): computed for a unit the item converts, the caller's
  // for a unit of the item's own size (a hide, a roll), refused when they disagree. A reversal keeps its original's.
  const sizing = keyed.map((move) => {
    const item = facts.items.get(move.itemId)
    if (!item) return { move, problem: null }
    const uom = move.uom ?? item.baseUom
    if (move.reversalOfId && move.baseQuantity !== undefined) return { move: { ...move, uom }, problem: null }
    const units = { baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() }
    const base = baseQuantityOf({ quantity: move.quantity, uom, baseQuantity: move.baseQuantity }, units)
    return base.problem ? { move, problem: base.problem } : { move: { ...move, uom, baseQuantity: base.baseQuantity }, problem: null }
  })
  const moves = sizing.map((entry) => entry.move)
  const problems = sizing.flatMap((entry, index) =>
    (entry.problem ? [entry.problem] : checkDraft(entry.move, index, facts, moves)).map((issue) => ({ path: `${at(index)}/${issue.path}`, message: issue.message })),
  )
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These moves break the stock rules.', problems)

  const rows = moves.map((move, index) => rowOf(move, index, facts, context, tools.now, options.key ?? null))
  const keys = rows.map((row) => row.idempotencyKey)
  if (new Set(keys).size !== keys.length) throw new ConflictError('Two moves of this batch have the same idempotency key.')
  const used = await tx.stockMove.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } })
  if (used.length > 0) throw new ConflictError(`This move was posted already (idempotency key ${used[0]!.idempotencyKey}).`)
  // B-W2a-F1: an office or system move dated inside a HARD period lock of its company is refused in words (409) before
  // the database's StockMove_period_lock; B-W2a-F8: inside a SOFT one it needs the caller's override reason. The floor's
  // moves are dated now and the floor reads no lock (the trigger skips them).
  if (context.audience !== 'floor') {
    await honourPeriodLocks(
      tools,
      rows.map((row, index) => ({ companyId: row.companyId, day: lockDayOf(row.occurredAt), refused: `the stock move (${row.reason.toLowerCase().replace(/_/g, ' ')}) dated ${dayWords(lockDayOf(row.occurredAt))} is not posted`, path: `${at(index)}/occurredAt`, record: { type: 'StockMove', id: row.id } })),
      options.periodLockOverride,
    )
  }

  // Never below zero: lock what the batch takes, read it, refuse before the insert.
  const takes: LocatedKey[] = rows.filter((row) => row.fromLocationId).map((row) => ({ ...keyOf(row), locationId: row.fromLocationId! }))
  await lockStock(tx, context.tenantId, takes)
  const balances = await readBalances(tx, takes)
  const short = shortfalls((key) => balances.get(locatedKeyOf(key)) ?? ZERO, rows)
  if (short.length > 0) throw insufficient(short, facts, at)

  await tx.stockMove.createMany({ data: rows })
  const valued = context.audience === 'floor' ? new Set<string>() : await valueMovesInCommand(tools, rows, moves, facts)

  const by = postedBy(context)
  for (const row of rows) {
    const after = {
      reason: row.reason,
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      lotId: row.lotId,
      hideId: row.hideId,
      fromLocationId: row.fromLocationId,
      toLocationId: row.toLocationId,
      quantity: row.quantity,
      uom: row.uom,
      baseQuantity: row.baseQuantity,
      receiptLineId: row.receiptLineId,
      ...(row.shipmentLineId ? { shipmentLineId: row.shipmentLineId } : {}),
      ...(row.returnLineId ? { returnLineId: row.returnLineId, returnPartyId: row.returnPartyId } : {}),
      workOrderId: row.workOrderId,
      reference: row.reference,
      note: row.note,
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
      reversalOfId: row.reversalOfId,
      idempotencyKey: row.idempotencyKey,
      occurredAt: toUtcIso(row.occurredAt),
    }
    tools.audit({ action: 'inventory.move', recordType: 'StockMove', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after, ...(row.note ? { reason: row.note } : {}) })
    tools.emit({
      type: 'inventory.moved',
      subject: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      payload: {
        moveId: row.id,
        reason: row.reason,
        itemId: row.itemId,
        itemColourId: row.itemColourId,
        lotId: row.lotId,
        hideId: row.hideId,
        fromLocationId: row.fromLocationId,
        toLocationId: row.toLocationId,
        baseQuantity: row.baseQuantity,
        reversalOfId: row.reversalOfId,
        postedBy: by.audience,
        changesValue: changesSiteStock(row),
        valued: valued.has(row.id),
      },
    })
  }
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    reason: row.reason,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    quantity: row.quantity,
    uom: row.uom,
    baseQuantity: row.baseQuantity,
    receiptLineId: row.receiptLineId,
    workOrderId: row.workOrderId,
    reference: row.reference,
    note: row.note,
    reasonCode: row.reasonCode,
    reversalOfId: row.reversalOfId,
    idempotencyKey: row.idempotencyKey,
    occurredAt: toUtcIso(row.occurredAt),
    valued: valued.has(row.id),
  }))
}

interface Facts {
  readonly sites: Map<string, { id: string; companyId: string; code: string }>
  readonly items: Map<string, ItemRow>
  readonly colours: Map<string, { id: string; itemId: string }>
  readonly lots: Map<string, Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>>
  readonly hides: Map<string, Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>>
  readonly locations: Map<string, Prisma.LocationGetPayload<{ select: typeof LOCATION_SELECT }>>
  readonly lines: Map<string, { id: string; siteId: string; itemId: string; itemColourId: string | null; receipt: { status: string } }>
  readonly originals: Map<string, LedgerRow>
  /** The moves that already have a reversal: original id → reversal id. */
  readonly reversed: Map<string, string>
}

/** Every row the batch names, read with the columns the caller's role may read (the floor never reads a cost). */
async function readFacts(tx: CommandTx, context: StockContext, moves: readonly KeyedDraft[]): Promise<Facts> {
  const itemSelect = context.audience === 'floor' ? ITEM_SELECT : { ...ITEM_SELECT, standardCost: true }
  const reversalIds = ids(moves.map((move) => move.reversalOfId))
  // One query after another on the transaction's one connection (no Promise.all on a transaction client).
  const sites = await tx.site.findMany({ where: { id: { in: ids(moves.map((move) => move.siteId)) } }, select: { id: true, companyId: true, code: true } })
  const items = (await tx.item.findMany({ where: { id: { in: ids(moves.map((move) => move.itemId)) } }, select: itemSelect })) as ItemRow[]
  const colours = await tx.itemColour.findMany({ where: { id: { in: ids(moves.map((move) => move.itemColourId)) } }, select: { id: true, itemId: true } })
  const lots = await tx.lot.findMany({ where: { id: { in: ids(moves.map((move) => move.lotId)) } }, select: LOT_SELECT })
  const hides = await tx.hide.findMany({ where: { id: { in: ids(moves.map((move) => move.hideId)) } }, select: HIDE_SELECT })
  const locations = await tx.location.findMany({ where: { id: { in: ids(moves.flatMap((move) => [move.fromLocationId, move.toLocationId])) } }, select: LOCATION_SELECT })
  const lines = await tx.goodsReceiptLine.findMany({
    where: { id: { in: ids(moves.map((move) => move.receiptLineId)) } },
    select: { id: true, siteId: true, itemId: true, itemColourId: true, receipt: { select: { status: true } } },
  })
  const originals = await tx.stockMove.findMany({ where: { id: { in: reversalIds } }, select: LEDGER_SELECT })
  const reversals = await tx.stockMove.findMany({ where: { reversalOfId: { in: reversalIds } }, select: { id: true, reversalOfId: true } })
  return {
    sites: byId(sites),
    items: byId(items),
    colours: byId(colours),
    lots: byId(lots),
    hides: byId(hides),
    locations: byId(locations),
    lines: byId(lines),
    originals: byId(originals),
    reversed: new Map(reversals.map((row) => [row.reversalOfId!, row.id])),
  }
}

/** One draft against the domain and the rows it names (paths relative to the draft). */
function checkDraft(move: KeyedDraft, index: number, facts: Facts, batch: readonly KeyedDraft[]): Issue[] {
  const site = facts.sites.get(move.siteId)
  if (!site) return [{ path: 'siteId', message: 'Not a site of the tenant.' }]
  const item = facts.items.get(move.itemId)
  if (!item) return [{ path: 'itemId', message: 'Not an item of the tenant.' }]
  // Sized before (postMoves): the unit and the base quantity are set.
  const uom = move.uom ?? item.baseUom
  const baseQuantity = move.baseQuantity ?? move.quantity
  const problems: Issue[] = moveProblems({ ...move, uom, baseQuantity, item: { tracking: item.tracking, baseUom: item.baseUom } })

  if (move.itemColourId && facts.colours.get(move.itemColourId)?.itemId !== move.itemId) problems.push({ path: 'itemColourId', message: 'Not a colour of this item.' })
  const lot = move.lotId ? facts.lots.get(move.lotId) : undefined
  if (move.lotId && (!lot || lot.siteId !== move.siteId || lot.itemId !== move.itemId)) problems.push({ path: 'lotId', message: 'Not a lot of this item at this site.' })
  else if (lot && lot.itemColourId !== move.itemColourId) problems.push({ path: 'itemColourId', message: `Lot ${lot.code} is of another colour.` })
  const hide = move.hideId ? facts.hides.get(move.hideId) : undefined
  if (move.hideId && (!hide || hide.siteId !== move.siteId || hide.lotId !== move.lotId)) problems.push({ path: 'hideId', message: 'Not a hide of this lot at this site.' })
  for (const side of ['fromLocationId', 'toLocationId'] as const) {
    const locationId = move[side]
    if (!locationId) continue
    const location = facts.locations.get(locationId)
    if (!location || location.siteId !== move.siteId) problems.push({ path: side, message: 'Not a location of this site.' })
    else if (side === 'toLocationId' && location.status === 'ARCHIVED') problems.push({ path: side, message: `Location ${location.code} is archived; it takes no stock.` })
  }

  const reversal = Boolean(move.reversalOfId)
  if (move.reason === 'ISSUE' && !reversal) {
    if (lot && lot.qualityStatus !== 'RELEASED') problems.push({ path: 'lotId', message: `Lot ${lot.code} is ${lot.qualityStatus}; only RELEASED stock is issued (REACH Annex XVII entry 47: Cr VI).` })
    if (hide && (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED')) problems.push({ path: 'hideId', message: `Hide ${hide.code} is ${hide.state}; it is not issued.` })
  }
  if (move.receiptLineId) {
    const line = facts.lines.get(move.receiptLineId)
    if (!line || line.siteId !== move.siteId) problems.push({ path: 'receiptLineId', message: 'Not a goods receipt line of this site.' })
    else {
      if (line.itemId !== move.itemId || line.itemColourId !== move.itemColourId) problems.push({ path: 'receiptLineId', message: 'The receipt line is of another item or colour.' })
      if (!reversal && lot && lot.receiptLineId !== line.id) problems.push({ path: 'lotId', message: `Lot ${lot.code} is not a lot of this receipt line.` })
      const state = line.receipt.status
      if ((!reversal && state !== 'OPEN') || (reversal && state !== 'POSTED' && state !== 'REVERSED')) {
        problems.push({ path: 'receiptLineId', message: `The goods receipt is ${state}; its moves are posted while it is OPEN, reversed while it is POSTED.` })
      }
    }
  }
  if (move.reversalOfId) {
    const original = facts.originals.get(move.reversalOfId)
    if (!original || original.siteId !== move.siteId) problems.push({ path: 'reversalOfId', message: 'Not a move of this site.' })
    else {
      const earlier = batch.slice(0, index).some((other) => other.reversalOfId === move.reversalOfId)
      for (const message of reversalProblems({ id: original.id, reason: original.reason, reversalOfId: original.reversalOfId }, facts.reversed.get(original.id) ?? (earlier ? 'this batch' : null), { withReceipt: true })) {
        problems.push({ path: 'reversalOfId', message })
      }
      const mirrors =
        original.reason === move.reason &&
        original.itemId === move.itemId &&
        original.itemColourId === move.itemColourId &&
        original.lotId === move.lotId &&
        original.hideId === move.hideId &&
        original.receiptLineId === (move.receiptLineId ?? null) &&
        original.workOrderId === (move.workOrderId ?? null) &&
        original.fromLocationId === (move.toLocationId ?? null) &&
        original.toLocationId === (move.fromLocationId ?? null) &&
        new Dec(original.baseQuantity.toString()).equals(new Dec(baseQuantity))
      if (!mirrors) problems.push({ path: 'reversalOfId', message: 'A reversal is the same move with its locations swapped.' })
    }
    if (!(move.note ?? '').trim()) problems.push({ path: 'note', message: 'A reversal says why.' })
  }
  return problems
}

type MoveRow = Prisma.StockMoveCreateManyInput & {
  id: string
  companyId: string
  siteId: string
  reason: StockMoveReason
  itemId: string
  itemColourId: string | null
  lotId: string | null
  hideId: string | null
  fromLocationId: string | null
  toLocationId: string | null
  quantity: string
  uom: Uom
  baseQuantity: string
  receiptLineId: string | null
  workOrderId: string | null
  reference: string | null
  note: string | null
  reasonCode: string | null
  reversalOfId: string | null
  idempotencyKey: string
  occurredAt: Date
}

function rowOf(move: KeyedDraft, index: number, facts: Facts, context: StockContext, now: Date, key: string | null): MoveRow {
  const item = facts.items.get(move.itemId)!
  const uom = move.uom ?? item.baseUom
  const id = newId()
  const by = postedBy(context)
  return {
    id,
    companyId: facts.sites.get(move.siteId)!.companyId,
    siteId: move.siteId,
    reason: move.reason,
    itemId: move.itemId,
    itemColourId: move.itemColourId,
    lotId: move.lotId,
    hideId: move.hideId,
    fromLocationId: move.fromLocationId ?? null,
    toLocationId: move.toLocationId ?? null,
    quantity: quantityText(move.quantity),
    uom,
    baseQuantity: quantityText(move.baseQuantity ?? move.quantity),
    receiptLineId: move.receiptLineId ?? null,
    ...(move.shipmentLineId ? { shipmentLineId: move.shipmentLineId } : {}),
    ...(move.returnLineId ? { returnLineId: move.returnLineId, returnPartyId: move.returnPartyId ?? null } : {}),
    workOrderId: move.workOrderId ?? null,
    reference: move.reference?.trim() || null,
    note: move.note?.trim() || null,
    reasonCode: move.reasonCode?.trim() || null,
    reversalOfId: move.reversalOfId ?? null,
    idempotencyKey: move.idempotencyKey ?? (key ? `${key}:${index + 1}` : `move:${id}`),
    occurredAt: move.occurredAt ?? now,
    deviceId: by.deviceId,
    createdAt: now,
    createdById: by.createdById,
  }
}

const keyOf = (move: { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null }) => ({
  siteId: move.siteId,
  itemId: move.itemId,
  itemColourId: move.itemColourId,
  lotId: move.lotId,
  hideId: move.hideId,
})

function insufficient(found: readonly Shortfall[], facts: Facts, at: (index: number) => string): InsufficientStockError {
  const describe = (entry: Shortfall) => {
    const item = facts.items.get(entry.itemId)
    const location = facts.locations.get(entry.locationId)
    const lot = entry.lotId ? facts.lots.get(entry.lotId) : undefined
    const hide = entry.hideId ? facts.hides.get(entry.hideId) : undefined
    const what = [item?.code ?? entry.itemId, lot ? `lot ${lot.code}` : null, hide ? `hide ${hide.code}` : null].filter(Boolean).join(', ')
    return `Location ${location?.code ?? entry.locationId} holds ${quantityText(entry.holds)} ${item?.baseUom ?? ''} of ${what}; the move takes ${quantityText(entry.takes)}. Stock never goes below zero.`.replace('  ', ' ')
  }
  const issues = found.map((entry) => ({ path: `${at(entry.index)}/quantity`, message: describe(entry) }))
  return new InsufficientStockError(found.length === 1 ? issues[0]!.message : `${found.length} moves take more than their location holds; stock never goes below zero.`, issues)
}

// ---- valuation in the command -------------------------------------------------------------------------------------------

type ValuedMove = Pick<MoveRow, 'id' | 'companyId' | 'siteId' | 'itemId' | 'lotId' | 'fromLocationId' | 'toLocationId' | 'baseQuantity' | 'reversalOfId'>

/**
 * Values the moves that enter or leave the site's stock (office and system callers only), in the caller's command:
 * one StockValuation per move (key `move:<id>`), with its audit row (the cost marked with its grain). A reversal of a
 * move that has no value yet (a floor move the handler has not reached) values that move first, so the two cancel.
 * Returns the ids of the moves valued.
 */
export async function valueMovesInCommand(
  tools: Pick<CommandTools, 'tx' | 'audit' | 'now' | 'context'>,
  moves: readonly ValuedMove[],
  drafts: readonly Pick<MoveDraft, 'cost'>[] = [],
  facts?: Pick<Facts, 'items' | 'originals'>,
): Promise<Set<string>> {
  const context = stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('inside a command')) })
  if (context.audience === 'floor') throw new ForbiddenError('A floor device never values stock.')
  const { tx } = tools
  const valued = new Set<string>()
  const changing = moves.map((move, index) => ({ move, cost: drafts[index]?.cost ?? null })).filter(({ move }) => changesSiteStock(move))
  if (changing.length === 0) return valued

  const originalIds = ids(changing.map(({ move }) => move.reversalOfId))
  const originals = facts?.originals ?? byId(await tx.stockMove.findMany({ where: { id: { in: originalIds } }, select: LEDGER_SELECT }))
  const allItems = ids([...changing.map(({ move }) => move.itemId), ...[...originals.values()].map((row) => row.itemId)])
  const items = new Map([...(facts?.items ?? new Map<string, ItemRow>())])
  const missing = allItems.filter((id) => !items.get(id) || items.get(id)!.standardCost === undefined)
  if (missing.length > 0) {
    for (const row of await tx.item.findMany({ where: { id: { in: missing } }, select: { ...ITEM_SELECT, standardCost: true } })) items.set(row.id, row as ItemRow)
  }
  const existing = await tx.stockValuation.findMany({ where: { moveId: { in: [...originalIds, ...changing.map(({ move }) => move.id)] } }, select: { moveId: true, method: true, unitCost: true } })
  const valuationOf = new Map<string, { readonly method: ValuationMethod; readonly unitCost: string }>(
    existing.map((row) => [row.moveId, { method: row.method, unitCost: row.unitCost.toString() }]),
  )
  const lotIds = ids([...changing.map(({ move }) => move.lotId), ...[...originals.values()].map((row) => row.lotId)])
  const lotValuations = new Map<string, { quantity: string; unitCost: string }[]>()
  for (const row of await tx.stockValuation.findMany({ where: { lotId: { in: lotIds } }, select: { siteId: true, lotId: true, quantity: true, unitCost: true } })) {
    const list = lotValuations.get(`${row.siteId}|${row.lotId}`) ?? []
    list.push({ quantity: row.quantity.toString(), unitCost: row.unitCost.toString() })
    lotValuations.set(`${row.siteId}|${row.lotId}`, list)
  }

  const value = (move: ValuedMove, basis: CostBasis) => {
    const item = items.get(move.itemId)!
    const amount = valueOfMove(move, basis.unitCost, item.currency)!
    const row = {
      id: newId(),
      companyId: move.companyId,
      siteId: move.siteId,
      moveId: move.id,
      itemId: move.itemId,
      lotId: move.lotId,
      quantity: amount.quantity,
      unitCost: amount.unitCost,
      valueAmount: amount.valueAmount,
      currency: item.currency,
      method: basis.method as StockValuationMethod,
      idempotencyKey: valuationKey(move.id),
      createdAt: tools.now,
      createdById: context.audience === 'office' ? context.actorId : null,
    }
    if (move.lotId) {
      const key = `${move.siteId}|${move.lotId}`
      lotValuations.set(key, [...(lotValuations.get(key) ?? []), { quantity: row.quantity, unitCost: row.unitCost }])
    }
    valuationOf.set(move.id, { method: basis.method, unitCost: row.unitCost })
    tools.audit({
      action: 'inventory.value',
      recordType: 'StockValuation',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: { moveId: row.moveId, method: row.method, quantity: row.quantity, currency: row.currency, unitCost: markMoney('cost', row.unitCost), valueAmount: markMoney('cost', row.valueAmount) },
    })
    valued.add(move.id)
    return row
  }
  const basisOf = (move: ValuedMove, explicit: MoveDraft['cost'], reversed: { readonly method: ValuationMethod; readonly unitCost: string } | undefined) =>
    costBasis({
      explicit,
      reversed: reversed ?? null,
      lotCost: move.lotId ? lotUnitCost(lotValuations.get(`${move.siteId}|${move.lotId}`) ?? []) : null,
      standardCost: items.get(move.itemId)?.standardCost?.toString() ?? null,
    })

  const rows: ReturnType<typeof value>[] = []
  for (const { move, cost } of changing) {
    if (valuationOf.has(move.id)) continue
    const original = move.reversalOfId ? originals.get(move.reversalOfId) : undefined
    if (original && changesSiteStock(original) && !valuationOf.has(original.id)) {
      const basis = basisOf({ ...original, baseQuantity: original.baseQuantity.toString() }, null, undefined)
      if (basis) rows.push(value({ ...original, baseQuantity: original.baseQuantity.toString() }, basis))
    }
    const basis = basisOf(move, cost, original ? valuationOf.get(original.id) : undefined)
    if (basis) rows.push(value(move, basis))
  }
  if (rows.length > 0) await tx.stockValuation.createMany({ data: rows })
  return valued
}
