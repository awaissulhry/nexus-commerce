import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { ProtectorRefusal } from '@nexus/factory-domain/inventory/rolls/protectors'
import {
  IN_STOCK_STATES,
  isInStock,
  isLengthUom,
  lengthIn,
  lengthText,
  lotCheckWords,
  lotRollCheck,
  type LengthUom,
  type RollFacts,
  type RollRefusal,
  type RollState,
} from '@nexus/factory-domain/inventory/rolls/rolls'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { fixed, locatedBy } from '../stock/read-kit'

/**
 * What the rolls module's reads and commands share (B-W2b-107; SCM-260, SCM-261, SCM-263): one roll as the caller may see
 * it, its view, the lot's rolls against its ledger per place, the refusals in words, and the locks. Every read runs on the
 * caller's client (row-level security); a floor device sees its own site only (can() pins it).
 *
 * Lock order of every roll write (no deadlock): the roll's row (command()'s version bump) → the lot's roll lock
 * (`factory.fabric-rolls|tenant|lot`, also taken by the tag, so what no roll claims is read by one writer at a time) → the
 * work order's issue lock → the stock locks (postMoves).
 */

export class RollRefusedError extends ConflictError {
  override name = 'RollRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: RollRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export class ProtectorRefusedError extends ConflictError {
  override name = 'ProtectorRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ProtectorRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuseRoll = (refusal: RollRefusal): never => {
  throw new RollRefusedError(refusal)
}

/** The lot's roll lock: tags and roll writes of one lot take turns (taken after the roll's own row). */
export async function lockLotRolls(tx: CommandTx, tenantId: string, lotId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.fabric-rolls', ${tenantId}::uuid, ${lotId}::uuid), 0))`
}

export const ROLL_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  itemId: true,
  lotId: true,
  code: true,
  supplierRollRef: true,
  length: true,
  uom: true,
  lengthLeft: true,
  widthCm: true,
  shade: true,
  shadeGroupId: true,
  shrinkageLengthPercent: true,
  shrinkageWidthPercent: true,
  shrinkageGroup: true,
  defects: true,
  locationId: true,
  state: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lot: {
    select: {
      id: true,
      code: true,
      dyeBatch: true,
      qualityStatus: true,
      itemColourId: true,
      item: { select: { id: true, code: true, name: true, baseUom: true } },
      itemColour: { select: { id: true, code: true, name: true } },
    },
  },
  shadeGroup: { select: { id: true, label: true, outOfShade: true } },
  location: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.FabricRollSelect
export type RollRow = Prisma.FabricRollGetPayload<{ select: typeof ROLL_SELECT }>

/** A length unit of a row the database holds to M, CM or MM. */
export const lengthUom = (uom: string): LengthUom => (isLengthUom(uom) ? uom : 'M')
const d4 = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed(4))
const d2 = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed(2))

export const rollFactsOf = (row: Pick<RollRow, 'code' | 'state' | 'length' | 'lengthLeft' | 'uom' | 'locationId'>): RollFacts => ({
  code: row.code,
  state: row.state as RollState,
  length: new Dec(row.length.toString()).toFixed(4),
  lengthLeft: new Dec(row.lengthLeft.toString()).toFixed(4),
  uom: lengthUom(row.uom),
  locationId: row.locationId,
})

/** What is left of the roll in the lot's base unit (a roll is entered in the lot's length unit, or another one). */
export const leftInBase = (row: Pick<RollRow, 'lengthLeft' | 'uom'>, base: LengthUom): Decimal => lengthIn(row.lengthLeft.toString(), lengthUom(row.uom), base)

/** One roll as every answer shows it. */
export function rollView(row: RollRow) {
  const uom = lengthUom(row.uom)
  return {
    id: row.id,
    code: row.code,
    state: row.state as RollState,
    inStock: isInStock(row.state as RollState) && row.locationId !== null,
    version: row.version,
    siteId: row.siteId,
    companyId: row.companyId,
    item: { id: row.lot.item.id, code: row.lot.item.code, name: row.lot.item.name },
    colour: row.lot.itemColour ? { id: row.lot.itemColour.id, code: row.lot.itemColour.code, name: row.lot.itemColour.name } : null,
    lot: { id: row.lot.id, code: row.lot.code, dyeBatch: row.lot.dyeBatch, qualityStatus: row.lot.qualityStatus },
    supplierRollRef: row.supplierRollRef,
    length: d4(row.length)!,
    lengthLeft: d4(row.lengthLeft)!,
    uom,
    words: {
      it: `${lengthText(row.lengthLeft.toString(), uom, 'it')} su ${lengthText(row.length.toString(), uom, 'it')}`,
      en: `${lengthText(row.lengthLeft.toString(), uom, 'en')} of ${lengthText(row.length.toString(), uom, 'en')}`,
    },
    widthCm: d2(row.widthCm),
    shade: row.shade,
    shadeGroup: row.shadeGroup ? { id: row.shadeGroup.id, label: row.shadeGroup.label, outOfShade: row.shadeGroup.outOfShade } : null,
    shrinkageLengthPercent: d2(row.shrinkageLengthPercent),
    shrinkageWidthPercent: d2(row.shrinkageWidthPercent),
    shrinkageGroup: row.shrinkageGroup,
    defects: row.defects,
    location: row.location ? { id: row.location.id, code: row.location.code, name: row.location.name } : null,
    note: row.note,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const scopeOf = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })

/**
 * One roll the caller may reach: the office sees it with inventory.stock.view at its site (else not found) and must hold
 * `permission` there too (else forbidden); a floor device only at its own site with `permission` (else not found).
 */
export async function rollFor(caller: CommandCaller, rollId: string, permission: Permission): Promise<{ row: RollRow; context: StockContext }> {
  const context = stockContextOf(caller)
  const row = isUuid(rollId) ? await caller.withClient((client) => client.fabricRoll.findUnique({ where: { id: rollId }, select: ROLL_SELECT })) : null
  const sees = row !== null && (context.audience === 'office' ? mayAt(context, INVENTORY_STOCK_VIEW, scopeOf(row)) : mayAt(context, permission, scopeOf(row)))
  if (!row || !sees) throw new NotFoundError('Roll not found.')
  if (!mayAt(context, permission, scopeOf(row))) throw new ForbiddenError(`This needs ${permission} at the roll's site.`)
  return { row, context }
}

export const LOT_SELECT = {
  id: true,
  code: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  qualityStatus: true,
  item: { select: { id: true, code: true, name: true, tracking: true, baseUom: true } },
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

/** The rolls of a lot that lie in its stock (a state in stock and a place), what is left of each in the base unit. */
export async function rollsInStock(db: Pick<CommandTx, 'fabricRoll'>, lotId: string, base: LengthUom) {
  const rows = await db.fabricRoll.findMany({ where: { lotId, state: { in: [...IN_STOCK_STATES] }, locationId: { not: null } }, select: { id: true, locationId: true, lengthLeft: true, uom: true } })
  return rows.map((row) => ({ id: row.id, locationId: row.locationId!, lengthLeftBase: leftInBase(row, base) }))
}

/** The places' codes and names. */
export async function placesOf(db: Pick<CommandTx, 'location'>, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.location.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
}

/**
 * The lot's rolls against its ledger, per place, as an answer: what the ledger holds of the lot, what the rolls in stock say,
 * what no roll claims, what the rolls say beyond the ledger; the two numbers in words.
 */
export async function lotCheckOf(db: Pick<CommandTx, 'fabricRoll' | 'stockMove' | 'location'>, lot: Pick<LotRow, 'id' | 'code'>, base: LengthUom) {
  const located = (await locatedBy(db, 'lotId', { lotId: lot.id })).get(lot.id)
  const rolls = await rollsInStock(db, lot.id, base)
  const check = lotRollCheck(located?.at ?? new Map<string, Decimal>(), rolls)
  const places = await placesOf(db, check.places.map((place) => place.locationId))
  const view = {
    lotId: lot.id,
    lotCode: lot.code,
    uom: base,
    onHand: fixed(check.onHand),
    tagged: fixed(check.tagged),
    untagged: fixed(check.untagged),
    beyond: fixed(check.beyond),
    rolls: rolls.length,
    places: check.places.map((place) => ({
      location: places.get(place.locationId) ?? { id: place.locationId, code: '?', name: '?' },
      onHand: fixed(place.onHand),
      tagged: fixed(place.tagged),
      untagged: fixed(place.untagged),
      beyond: fixed(place.beyond),
    })),
    words: { it: lotCheckWords(check, rolls.length, base, 'it'), en: lotCheckWords(check, rolls.length, base, 'en') },
  }
  /** `check` is for the tag (Decimals: never in an answer); `view` is the answer's. */
  return { view, check }
}


