import type { Prisma, StockMoveReason, Uom } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { countDifferences, countProblems } from '@nexus/factory-domain/inventory/ledger/count'
import { locatedKeyOf, reversalOf, reversalProblems } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ADJUST, INVENTORY_REVERSE, INVENTORY_SCRAP, INVENTORY_STOCK_VIEW, INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf, seesCost, siteFor, stockContextOf } from './access'
import type { MoveView } from './contract'
import { completeKeys, LEDGER_SELECT, lockStock, postMoves, readBalances, type MoveDraft, type PostedMove } from './post-moves'

/**
 * The stock ledger's own commands (SCM-189, SCM-192, SCM-193; A2 SCR-064) and the moves list (SCM-195). Each write is
 * one command() that posts through postMoves (the one writer): a transfer (office, and a floor device at its own site:
 * an Idempotency-Key is required, so a resent scan posts once), an adjustment and a count's differences (office, with
 * the reason), a scrap (office, with the reason), the reversal of a move (office, with the reason). Their move keys are
 * `<command>:<Idempotency-Key>:<n>`.
 */

interface StockInput {
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly hideId?: string | null | undefined
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly reference?: string | null | undefined
}

/** The stock fields of a body as a draft (an absent colour or lot stays absent: postMoves fills it in). */
const stockOf = (body: StockInput) => ({
  itemId: body.itemId,
  ...(body.itemColourId !== undefined ? { itemColourId: body.itemColourId } : {}),
  ...(body.lotId !== undefined ? { lotId: body.lotId } : {}),
  hideId: body.hideId ?? null,
  quantity: body.quantity,
  ...(body.uom ? { uom: body.uom } : {}),
  ...(body.baseQuantity ? { baseQuantity: body.baseQuantity } : {}),
  reference: body.reference ?? null,
})

const view = (move: PostedMove): MoveView => ({ ...move })
const keyFor = (name: string, key: string | undefined) => (key ? `${name}:${key}` : null)

export interface AdjustInput extends StockInput {
  readonly siteId: string
  readonly locationId: string
  readonly direction: 'IN' | 'OUT'
  readonly note: string
  readonly unitCost?: string | undefined
}

/** inventory.adjust: a correction up or down at one location, with its reason (SCM-192); optionally at a typed cost. */
export async function adjust(caller: CommandCaller, body: AdjustInput, idempotencyKey?: string): Promise<{ move: MoveView }> {
  officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_ADJUST, 'body/siteId')
  const draft: MoveDraft = {
    siteId: site.id,
    reason: 'ADJUSTMENT',
    ...stockOf(body),
    ...(body.direction === 'IN' ? { toLocationId: body.locationId } : { fromLocationId: body.locationId }),
    note: body.note,
    cost: body.unitCost ? { method: 'MANUAL', unitCost: body.unitCost } : null,
  }
  const { result } = await command(caller, { name: 'inventory.adjust', idempotencyKey, input: body }, async (tools) => {
    const [move] = await postMoves(tools, [draft], { key: keyFor('inventory.adjust', idempotencyKey), issuePath: () => 'body' })
    return { move: view(move!) }
  })
  return result
}

export interface TransferInput extends StockInput {
  readonly siteId?: string | undefined
  readonly fromLocationId: string
  readonly toLocationId: string
  readonly note?: string | null | undefined
  readonly occurredAt?: string | undefined
}

/** inventory.transfer: stock from one location of a site to another (office; a floor device at its own site). */
export async function transfer(caller: CommandCaller, body: TransferInput, idempotencyKey?: string): Promise<{ move: MoveView }> {
  const context = stockContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_TRANSFER, 'body/siteId')
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined
  const draft: MoveDraft = {
    siteId: site.id,
    reason: 'TRANSFER',
    ...stockOf(body),
    fromLocationId: body.fromLocationId,
    toLocationId: body.toLocationId,
    note: body.note ?? null,
    ...(occurredAt ? { occurredAt } : {}),
  }
  const { result } = await command(
    caller,
    { name: 'inventory.transfer', idempotencyKey, input: body, ...(context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}) },
    async (tools) => {
      const [move] = await postMoves(tools, [draft], { key: keyFor('inventory.transfer', idempotencyKey), issuePath: () => 'body' })
      return { move: view(move!) }
    },
  )
  return result
}

export interface ScrapInput extends StockInput {
  readonly siteId: string
  readonly fromLocationId: string
  readonly note: string
}

/** inventory.scrap: stock out of the site as scrap, with the reason (SCM-193). */
export async function scrap(caller: CommandCaller, body: ScrapInput, idempotencyKey?: string): Promise<{ move: MoveView }> {
  officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_SCRAP, 'body/siteId')
  const draft: MoveDraft = { siteId: site.id, reason: 'SCRAP', ...stockOf(body), fromLocationId: body.fromLocationId, note: body.note }
  const { result } = await command(caller, { name: 'inventory.scrap', idempotencyKey, input: body }, async (tools) => {
    const [move] = await postMoves(tools, [draft], { key: keyFor('inventory.scrap', idempotencyKey), issuePath: () => 'body' })
    return { move: view(move!) }
  })
  return result
}

/**
 * inventory.reverse: the reversal of a move, with the reason: the same move with its locations swapped (at most one per
 * move; never of a reversal; a receipt's moves are reversed with their goods receipt). Reversing a move that put stock
 * in takes it out again: refused (409) when that stock is gone.
 */
export async function reverse(caller: CommandCaller, moveId: string, body: { readonly note: string }, idempotencyKey?: string): Promise<{ move: MoveView; reversed: string }> {
  const context = officeContextOf(caller)
  const original = isUuid(moveId) ? await caller.withClient((client) => client.stockMove.findUnique({ where: { id: moveId }, select: { ...LEDGER_SELECT, reversals: { select: { id: true } } } })) : null
  if (!original || !mayAt(context, INVENTORY_REVERSE, original)) throw new NotFoundError('Stock move not found.')
  const problems = reversalProblems(original, original.reversals[0]?.id ?? null)
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  const draft: MoveDraft = { ...reversalOf({ ...original, quantity: original.quantity.toString(), baseQuantity: original.baseQuantity.toString() }, body.note), uom: original.uom }
  const { result } = await command(caller, { name: 'inventory.reverse', idempotencyKey, input: { moveId, ...body } }, async (tools) => {
    const [move] = await postMoves(tools, [draft], { key: keyFor('inventory.reverse', idempotencyKey), issuePath: () => 'body' })
    return { move: view(move!), reversed: original.id }
  })
  return result
}

export interface CountInput {
  readonly siteId: string
  readonly locationId: string
  readonly note: string
  readonly reference?: string | null | undefined
  readonly lines: readonly { readonly itemId: string; readonly itemColourId?: string | null | undefined; readonly lotId?: string | null | undefined; readonly hideId?: string | null | undefined; readonly counted: string }[]
}

/**
 * inventory.count: a count at one location (PLAN §2.8: the year-end count; a cycle count): each counted stock against
 * the ledger's balance there, read under the stock locks in the same command, and every difference posted as a COUNT
 * move with the count's reason. A line that agrees posts nothing.
 */
export async function postCount(caller: CommandCaller, body: CountInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_ADJUST, 'body/siteId')
  const location = isUuid(body.locationId) ? await caller.withClient((client) => client.location.findUnique({ where: { id: body.locationId }, select: { siteId: true } })) : null
  if (location?.siteId !== site.id) throw new ValidationError('The location is not valid.', [{ path: 'body/locationId', message: 'Not a location of this site.' }])
  const { result } = await command(caller, { name: 'inventory.count', idempotencyKey, input: body }, async (tools) => {
    const lines = (await completeKeys(tools.tx, body.lines)).map((line) => ({ ...line, siteId: site.id }))
    const problems = countProblems(lines)
    if (problems.length > 0) throw new ValidationError('The count is not valid.', problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    const keys = lines.map((line) => ({ ...line, locationId: body.locationId }))
    await lockStock(tools.tx, context.tenantId, keys)
    const balances = await readBalances(tools.tx, keys)
    const differences = countDifferences(body.locationId, lines, (line) => balances.get(locatedKeyOf({ ...line, locationId: body.locationId })) ?? ZERO)
    const booked = differences.filter((entry) => entry.move !== null)
    const drafts: MoveDraft[] = booked.map((entry) => ({
      siteId: site.id,
      reason: 'COUNT',
      itemId: entry.itemId,
      itemColourId: entry.itemColourId,
      lotId: entry.lotId,
      hideId: entry.hideId,
      fromLocationId: entry.move!.fromLocationId,
      toLocationId: entry.move!.toLocationId,
      quantity: entry.move!.baseQuantity,
      note: body.note,
      reference: body.reference ?? null,
    }))
    const moves = drafts.length > 0 ? await postMoves(tools, drafts, { key: keyFor('inventory.count', idempotencyKey), issuePath: (index) => `body/lines/${booked[index]!.index}` }) : []
    if (moves.length === 0) {
      tools.audit({ action: 'inventory.count', recordType: 'Location', recordId: body.locationId, companyId: site.companyId, siteId: site.id, after: { counted: lines.length, differences: 0 }, reason: body.note })
    }
    const moveOf = new Map(booked.map((entry, index) => [entry.index, moves[index]!.id]))
    return {
      differences: differences.map((entry) => ({
        itemId: entry.itemId,
        itemColourId: entry.itemColourId,
        lotId: entry.lotId,
        hideId: entry.hideId,
        system: entry.system,
        counted: entry.counted,
        difference: entry.difference,
        moveId: moveOf.get(entry.index) ?? null,
      })),
      moves: moves.map(view),
    }
  })
  return result
}

// ---- the moves list (SCM-195) ------------------------------------------------------------------------------------------

export interface ListMovesQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly locationId?: string | undefined
  readonly reason?: StockMoveReason | undefined
  readonly createdById?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const LIST_SELECT = {
  ...LEDGER_SELECT,
  item: { select: { id: true, code: true, name: true, baseUom: true } },
  lot: { select: { code: true } },
  hide: { select: { code: true } },
  fromLocation: { select: { id: true, code: true, name: true } },
  toLocation: { select: { id: true, code: true, name: true } },
  reversals: { select: { id: true } },
} as const satisfies Prisma.StockMoveSelect

/**
 * The moves the caller may see (its companies and sites), newest first (by id: UUIDv7, the posting order), with the
 * filters of SCR-064; their values only for a caller with the cost grain (read only then).
 */
export async function listMoves(caller: CommandCaller, query: ListMovesQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.StockMoveWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.StockMoveWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.itemId ? { itemId: query.itemId } : {},
      query.itemColourId ? { itemColourId: query.itemColourId } : {},
      query.lotId ? { lotId: query.lotId } : {},
      query.hideId ? { hideId: query.hideId } : {},
      query.locationId ? { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] } : {},
      query.reason ? { reason: query.reason } : {},
      query.createdById ? { createdById: query.createdById } : {},
      query.from ? { occurredAt: { gte: parseInstant(query.from)! } } : {},
      query.to ? { occurredAt: { lt: parseInstant(query.to)! } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient((client) => client.stockMove.findMany({ where, select: LIST_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 }))
  const page = rows.slice(0, query.limit)
  const withCost = seesCost(context)
  const valuations = withCost && page.length > 0
    ? new Map(
        (
          await caller.withClient((client) =>
            client.stockValuation.findMany({ where: { moveId: { in: page.map((row) => row.id) } }, select: { moveId: true, method: true, quantity: true, unitCost: true, valueAmount: true, currency: true } }),
          )
        ).map((row) => [row.moveId, row]),
      )
    : new Map()
  return {
    moves: page.map((row) => {
      const valuation = valuations.get(row.id)
      return {
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
        quantity: row.quantity.toFixed(4),
        uom: row.uom,
        baseQuantity: row.baseQuantity.toFixed(4),
        receiptLineId: row.receiptLineId,
        workOrderId: row.workOrderId,
        reference: row.reference,
        note: row.note,
        reversalOfId: row.reversalOfId,
        idempotencyKey: row.idempotencyKey,
        occurredAt: toUtcIso(row.occurredAt),
        item: row.item,
        lotCode: row.lot?.code ?? null,
        hideCode: row.hide?.code ?? null,
        fromLocation: row.fromLocation,
        toLocation: row.toLocation,
        reversedById: row.reversals[0]?.id ?? null,
        createdAt: toUtcIso(row.createdAt),
        createdById: row.createdById,
        deviceId: row.deviceId,
        ...(withCost
          ? {
              valuation: asMoney(
                'cost',
                valuation
                  ? {
                      method: valuation.method,
                      quantity: valuation.quantity.toFixed(4),
                      unitCost: asMoney('cost', valuation.unitCost.toFixed(6)),
                      valueAmount: asMoney('cost', valuation.valueAmount),
                      currency: valuation.currency,
                    }
                  : null,
              ),
            }
          : {}),
      }
    }),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}
