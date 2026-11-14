import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { HOLD_REASON_WORDS, inForce, storedWords, type HoldFacts, type ShipmentHoldReason } from '@nexus/factory-domain/shipping/holds/holds'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * The shipment holds' reads and writes (B-W2b-386; LOG-017, FIN-079; factory-db ShipmentHold, B-W2b-364). Every write runs
 * inside a command with the shipment's row locked first (`lockShipmentRow`: FOR UPDATE, never a version bump — a hold is its
 * own row, so a packer's open bench keeps its version and reads the hold by its event), then the shipment's holds are read
 * under it. A hold is placed once per reason while in force and released once; the database holds the same rules.
 */

type Reader = FactoryClient | CommandTx

export const HOLD_COLUMNS = {
  id: true,
  shipmentId: true,
  siteId: true,
  partyId: true,
  reason: true,
  words: true,
  placedAt: true,
  placedById: true,
  releasedAt: true,
  releasedById: true,
  releaseWords: true,
  version: true,
} as const satisfies Prisma.ShipmentHoldSelect
export type HoldRow = Prisma.ShipmentHoldGetPayload<{ select: typeof HOLD_COLUMNS }>

export const factsOf = (row: HoldRow): HoldFacts => ({ id: row.id, reason: row.reason as ShipmentHoldReason, placedAt: row.placedAt, placedById: row.placedById, releasedAt: row.releasedAt, releasedById: row.releasedById })

/** Every hold of the shipments (in force and released), newest first. */
export async function readHolds(db: Reader, shipmentIds: readonly string[]): Promise<HoldRow[]> {
  const ids = [...new Set(shipmentIds)]
  if (ids.length === 0) return []
  return db.shipmentHold.findMany({ where: { shipmentId: { in: ids } }, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }] })
}

/** The holds in force of the shipments, by shipment. */
export async function holdsInForceBy(db: Reader, shipmentIds: readonly string[]): Promise<Map<string, HoldRow[]>> {
  const out = new Map<string, HoldRow[]>()
  const ids = [...new Set(shipmentIds)]
  if (ids.length === 0) return out
  const rows = await db.shipmentHold.findMany({ where: { shipmentId: { in: ids }, releasedAt: null }, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
  for (const row of rows) out.set(row.shipmentId, [...(out.get(row.shipmentId) ?? []), row])
  return out
}

export interface LockedShipment {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly salesOrderId: string
}

/** Locks the shipment's row (FOR UPDATE: holds and packing writes take turns) and reads what a hold needs. */
export async function lockShipmentRow(tx: CommandTx, shipmentId: string): Promise<LockedShipment> {
  const rows = await tx.$queryRaw<LockedShipment[]>`
    SELECT "id"::text AS "id", "number", "status"::text AS "status", "companyId"::text AS "companyId", "siteId"::text AS "siteId", "partyId"::text AS "partyId", "salesOrderId"::text AS "salesOrderId"
      FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new InvalidStateError('The shipment is gone.')
  return row
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * When a hold is placed or released: the command's time, unless that clock runs more than a minute ahead of the database's
 * (a command on an app clock a test moves on: the guard refuses a hold placed or released "in the future"), then the
 * database's (as B-W2b-304's credit checks do).
 */
async function holdTimeOf(tools: CommandTools): Promise<Date> {
  const [row] = await tools.tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  return row && tools.now.getTime() > row.now.getTime() + 60_000 ? row.now : tools.now
}

export interface PlaceInput {
  readonly reason: ShipmentHoldReason
  readonly words: string | null
  /** The system's hold (placedById null), else the office person's. */
  readonly bySystem: boolean
}

/** Places one hold (the shipment locked, no hold of the reason in force: the caller checked), its audit row and event. */
export async function placeHoldInCommand(tools: CommandTools, shipment: LockedShipment, input: PlaceInput): Promise<string> {
  const id = newId()
  const placedById = input.bySystem ? null : actorIdOf(tools)
  const words = storedWords(input.words)
  const placedAt = await holdTimeOf(tools)
  await tools.tx.shipmentHold.create({
    data: { id, siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, reason: input.reason, words, placedAt, placedById, createdById: placedById },
    select: { id: true },
  })
  tools.audit({ action: 'shipping.holdPlaced', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { holdId: id, reason: input.reason, words, bySystem: input.bySystem } })
  tools.emit({ type: 'shipment.hold_placed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, holdId: id, reason: input.reason, bySystem: input.bySystem } })
  return id
}

/** Releases one hold in force (the shipment locked: the caller checked who may), its audit row and event. */
export async function releaseHoldInCommand(tools: CommandTools, shipment: LockedShipment, hold: HoldRow, input: { readonly words: string; readonly bySystem: boolean }): Promise<void> {
  const releasedById = input.bySystem ? null : actorIdOf(tools)
  const words = storedWords(input.words)!
  const now = await holdTimeOf(tools)
  // Never before it was placed (a hold placed on the database's clock, released on a slower app clock).
  const releasedAt = now.getTime() < hold.placedAt.getTime() ? hold.placedAt : now
  const { count } = await tools.tx.shipmentHold.updateMany({ where: { id: hold.id, releasedAt: null }, data: { releasedAt, releasedById, releaseWords: words, version: { increment: 1 } } })
  if (count !== 1) throw new InvalidStateError(`This hold of shipment ${shipment.number} was released already.`)
  const still = await tools.tx.shipmentHold.count({ where: { shipmentId: shipment.id, releasedAt: null } })
  tools.audit({
    action: 'shipping.holdReleased',
    recordType: 'Shipment',
    recordId: shipment.id,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    before: { holdId: hold.id, reason: hold.reason, releasedAt: null },
    after: { holdId: hold.id, reason: hold.reason, releaseWords: words, bySystem: input.bySystem, stillHeld: still > 0 },
    reason: words,
  })
  tools.emit({
    type: 'shipment.hold_released',
    subject: shipment.id,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    payload: { shipmentId: shipment.id, number: shipment.number, holdId: hold.id, reason: hold.reason as ShipmentHoldReason, bySystem: input.bySystem, stillHeld: still > 0 },
  })
}

/** The office people's names of some ids (shown inside one shipment's record only). */
export async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** A hold as the shipment's holds read it: the words and who, inside this one record. */
export function holdView(row: HoldRow, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    reason: row.reason as ShipmentHoldReason,
    reasonWords: HOLD_REASON_WORDS[row.reason as ShipmentHoldReason],
    words: row.words,
    inForce: inForce(row),
    bySystem: row.placedById === null,
    placedAt: toUtcIso(row.placedAt),
    /** null: the system. */
    placedBy: row.placedById ? (names.get(row.placedById) ?? null) : null,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    releasedBySystem: row.releasedAt !== null && row.releasedById === null,
    releasedBy: row.releasedById ? (names.get(row.releasedById) ?? null) : null,
    releaseWords: row.releaseWords,
    version: row.version,
  }
}
export type HoldView = ReturnType<typeof holdView>

/**
 * A split's new shipment carries the holds of the shipment it came from (B-W2b-386; LOG-005: a split never frees goods from a
 * hold): each hold in force, placed again on the new shipment by the same placer (the system or the person) with the same
 * reason and words; and, for a reason a person let go while none of it is in force, that release as history (so the system
 * does not hold the new shipment again for a cause a person let go). Inside the split's command, both shipments locked.
 */
export async function carryHoldsInCommand(tools: CommandTools, from: LockedShipment, to: LockedShipment): Promise<number> {
  const rows = await readHolds(tools.tx, [from.id])
  const live = rows.filter((row) => row.releasedAt === null)
  const placedAt = await holdTimeOf(tools)
  for (const row of live) {
    const id = newId()
    const words = storedWords(row.words)
    await tools.tx.shipmentHold.create({ data: { id, siteId: to.siteId, partyId: to.partyId, shipmentId: to.id, reason: row.reason, words, placedAt, placedById: row.placedById, createdById: actorIdOf(tools) }, select: { id: true } })
    tools.audit({ action: 'shipping.holdPlaced', recordType: 'Shipment', recordId: to.id, companyId: to.companyId, siteId: to.siteId, after: { holdId: id, reason: row.reason, words, bySystem: row.placedById === null, carriedFrom: { shipmentId: from.id, holdId: row.id } } })
    tools.emit({ type: 'shipment.hold_placed', subject: to.id, companyId: to.companyId, siteId: to.siteId, payload: { shipmentId: to.id, number: to.number, holdId: id, reason: row.reason as ShipmentHoldReason, bySystem: row.placedById === null } })
  }
  const inForce = new Set(live.map((row) => row.reason))
  const letGo = new Map<string, HoldRow>()
  for (const row of rows) if (row.releasedAt !== null && row.releasedById !== null && !inForce.has(row.reason) && !letGo.has(row.reason)) letGo.set(row.reason, row)
  for (const row of letGo.values()) {
    const id = newId()
    await tools.tx.shipmentHold.create({
      data: { id, siteId: to.siteId, partyId: to.partyId, shipmentId: to.id, reason: row.reason, words: row.words, placedAt: row.placedAt, placedById: row.placedById, releasedAt: row.releasedAt, releasedById: row.releasedById, releaseWords: row.releaseWords, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    tools.audit({ action: 'shipping.holdHistoryCarried', recordType: 'Shipment', recordId: to.id, companyId: to.companyId, siteId: to.siteId, after: { holdId: id, reason: row.reason, released: true, carriedFrom: { shipmentId: from.id, holdId: row.id } } })
  }
  return live.length
}
