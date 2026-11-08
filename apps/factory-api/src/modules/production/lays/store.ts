import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { isLengthUom, lengthIn, type LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { plyLength, rollUse } from '@nexus/factory-domain/production/lays/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { readCutOrder, readLayRolls, readLays, readLines, TICKET_COLUMNS, type CutOrderRow, type LayRollRow, type LayRow, type LineRow, type Reader, type TicketRow } from '../cutorders/store'

/**
 * The reads of a lay at the table (B-W2b-116): the lay with its cut order, lines, rolls (the lay report), its ticket and its fabric
 * used; what other lays not yet issued take of a roll. The cut order reads are B-W2b-112's (../cutorders/store). Every read runs as
 * the caller (a floor device: its own site, by row-level security).
 */

/** The issue key of a lay's fabric for one roll and one work order (the moves take `<key>:<n>`): posted once, ever. */
export const LAY_FABRIC_KEY = 'lay-fabric'
export const layFabricKey = (layId: string, rollId: string, workOrderId: string): string => `${LAY_FABRIC_KEY}:${layId}:${rollId}:${workOrderId}`

export const CONSUMPTION_COLUMNS = {
  id: true,
  cutOrderId: true,
  layId: true,
  key: true,
  uom: true,
  estimated: true,
  recorded: true,
  confirmed: true,
  confirmedAt: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.CutConsumptionSelect
export type ConsumptionRow = Prisma.CutConsumptionGetPayload<{ select: typeof CONSUMPTION_COLUMNS }>

export interface LayState {
  readonly order: CutOrderRow
  readonly lay: LayRow
  /** Lays of the cut order not cancelled. */
  readonly live: number
  readonly rows: readonly LayRollRow[]
  /** The lay's cut ticket (not void). */
  readonly ticket: TicketRow | null
  readonly lines: readonly LineRow[]
  readonly consumption: ConsumptionRow | null
}

/** A lay and everything the table needs of it; null when the caller does not see it. */
export async function readLayState(db: Reader, layId: string): Promise<LayState | null> {
  if (!isUuid(layId)) return null
  const head = await db.lay.findUnique({ where: { id: layId }, select: { cutOrderId: true } })
  if (!head) return null
  const order = await readCutOrder(db, head.cutOrderId)
  if (!order) return null
  const [lays, rows, ticket, lines, consumption] = await Promise.all([
    readLays(db, [order.id]),
    readLayRolls(db, [layId]),
    db.cutTicket.findFirst({ where: { layId, kind: 'CUT', status: { not: 'VOID' } }, select: TICKET_COLUMNS }),
    readLines(db, [order.id]),
    db.cutConsumption.findFirst({ where: { layId }, select: CONSUMPTION_COLUMNS }),
  ])
  const lay = lays.find((row) => row.id === layId)
  if (!lay) return null
  return { order, lay, live: lays.filter((row) => row.status !== 'CANCELLED').length, rows, ticket, lines, consumption }
}

/** The cut order's marker (a released fabric cut order has one). */
export const markerOf = (order: CutOrderRow): { length: string; uom: LengthUom } | null =>
  order.markerLength !== null && order.markerUom !== null && isLengthUom(order.markerUom) ? { length: order.markerLength.toString(), uom: order.markerUom } : null

/** The lay's length on the table, when the table gave one. */
export const layLengthOf = (lay: Pick<LayRow, 'layLength' | 'lengthUom'>): { length: string; uom: LengthUom } | null =>
  lay.layLength !== null && lay.lengthUom !== null && isLengthUom(lay.lengthUom) ? { length: lay.layLength.toString(), uom: lay.lengthUom } : null

/** The length one ply of the lay takes, in `uom` (the marker when no lay length was given). */
export function plyOf(state: Pick<LayState, 'order' | 'lay'>, uom: LengthUom): Decimal {
  const marker = markerOf(state.order)
  if (!marker) return ZERO
  return plyLength(marker, layLengthOf(state.lay), uom)
}

export const rollUom = (row: { readonly uom: string }): LengthUom => (isLengthUom(row.uom) ? row.uom : 'M')

/** What a row of the report took off its roll, in the roll's unit. */
export const rowUse = (state: Pick<LayState, 'order' | 'lay'>, row: Pick<LayRollRow, 'plies' | 'endLoss' | 'roll'>): Decimal => rollUse(row.plies, plyOf(state, rollUom(row.roll)), new Dec(row.endLoss.toString()))

/**
 * What other lays spread at the table but whose fabric is not yet issued (SPREADING, CHECKED, or CUT with no fabric used confirmed)
 * take of each roll, in the roll's unit: the roll's length left does not show it yet.
 */
export async function usesElsewhere(db: Reader, rolls: readonly { readonly id: string; readonly uom: string }[], exceptLayId: string): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>()
  if (rolls.length === 0) return out
  const uomOf = new Map(rolls.map((roll) => [roll.id, rollUom(roll)]))
  const rows = await db.layRoll.findMany({
    where: { rollId: { in: rolls.map((roll) => roll.id) }, layId: { not: exceptLayId }, lay: { is: { status: { in: ['SPREADING', 'CHECKED', 'CUT'] }, consumptions: { none: {} } } } },
    select: { rollId: true, plies: true, endLoss: true, lay: { select: { layLength: true, lengthUom: true, cutOrder: { select: { markerLength: true, markerUom: true } } } } },
  })
  for (const row of rows) {
    const uom = uomOf.get(row.rollId)!
    const marker = row.lay.cutOrder.markerLength !== null && row.lay.cutOrder.markerUom !== null && isLengthUom(row.lay.cutOrder.markerUom) ? { length: row.lay.cutOrder.markerLength.toString(), uom: row.lay.cutOrder.markerUom } : null
    if (!marker) continue
    const ply = plyLength(marker, layLengthOf(row.lay), uom)
    out.set(row.rollId, (out.get(row.rollId) ?? ZERO).plus(rollUse(row.plies, ply, new Dec(row.endLoss.toString()))))
  }
  return out
}

/** Each work order of the cut order with its garments in one ply (its lines' ratios), in id order. */
export function workOrderWeights(lines: readonly LineRow[]): { key: string; number: string; weight: number }[] {
  const byId = new Map<string, { key: string; number: string; weight: number }>()
  for (const line of lines) {
    const entry = byId.get(line.workOrderId) ?? { key: line.workOrderId, number: line.workOrderSize.workOrder.number, weight: 0 }
    entry.weight += line.ratio ?? 0
    byId.set(line.workOrderId, entry)
  }
  return [...byId.values()].sort((left, right) => left.key.localeCompare(right.key))
}

/** A length in metres from `uom` (a length unit) at four decimals. */
export const metres = (value: Decimal | string, uom: LengthUom): Decimal => lengthIn(value.toString(), uom, 'M')

/** The fabric its first confirmation issued for a lay: ISSUE moves keyed `lay-fabric:<lay>:…`, less their reversals, in metres. */
export async function issuedForLays(db: Reader, layIds: readonly string[], baseUom: string): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>()
  if (layIds.length === 0 || !isLengthUom(baseUom)) return out
  const moves = await db.stockMove.findMany({ where: { OR: layIds.map((layId) => ({ idempotencyKey: { startsWith: `${LAY_FABRIC_KEY}:${layId}:` } })), reason: 'ISSUE' }, select: { id: true, idempotencyKey: true, baseQuantity: true } })
  const reversed = new Set((await db.stockMove.findMany({ where: { reversalOfId: { in: moves.map((move) => move.id) } }, select: { reversalOfId: true } })).map((move) => move.reversalOfId))
  for (const move of moves) {
    if (reversed.has(move.id)) continue
    const layId = move.idempotencyKey.split(':')[1]!
    out.set(layId, (out.get(layId) ?? ZERO).plus(metres(new Dec(move.baseQuantity.toString()), baseUom)))
  }
  return out
}
