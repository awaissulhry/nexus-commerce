import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { qualityOf, type InHand, type PlaceFacts, type QualityState, type ScannedKind } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { normalizeLabelCode } from '@nexus/factory-domain/inventory/locations-depth/labels'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { mayAt, type StockContext } from '../ledger/access'
import { readSiteStock, type Reader } from '../issue/store'
import { activeHoldsOf } from '../../quality/holds/checks'
import { leftInBase, lengthUom } from '../rolls/facts'

/**
 * What a scan names, "In your hands" (B-W2b-292; design floor.move sec:what — item, quantity, where it is now, quality status):
 * a hide's tag, a remnant's tag (its hide), a fabric roll's tag or a lot's number, each unique in the tenant, found in that
 * order. Read as the caller (row-level security keeps a floor device to its own site, so another site's label is not found),
 * with the permission of the act at the record's company and site. Every read names its columns (the floor reads no cost).
 */

export interface PlaceRef extends PlaceFacts {
  readonly name: string
  readonly labelCode: string | null
}

export interface Lying {
  readonly location: PlaceRef
  /** In the item's base unit, above 0. */
  readonly onHand: Decimal
  /** The stock rows there (a lot tracked hide by hide: one per hide). */
  readonly rows: readonly { readonly lotId: string | null; readonly hideId: string | null; readonly itemColourId: string | null; readonly onHand: Decimal }[]
}

export interface Hand extends InHand {
  readonly code: string
  readonly companyId: string
  readonly siteId: string
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string; readonly tracking: string; readonly baseUom: string }
  readonly itemColourId: string | null
  readonly colour: { readonly code: string; readonly name: string } | null
  readonly lot: { readonly id: string; readonly code: string; readonly qualityStatus: string; readonly lifecycle: string } | null
  readonly hide: { readonly id: string; readonly code: string; readonly state: string } | null
  readonly roll: { readonly id: string; readonly code: string; readonly locationId: string | null; readonly state: string } | null
  readonly remnant: { readonly id: string; readonly code: string } | null
  readonly quality: QualityState
  readonly holds: readonly { readonly id: string; readonly reasonCode: string }[]
  /** Where it lies at its site now (most first). */
  readonly lying: readonly Lying[]
}

export const PLACE_COLUMNS = { id: true, code: true, name: true, kind: true, status: true, labelCode: true, siteId: true, companyId: true } as const
const ITEM_COLUMNS = { id: true, code: true, name: true, kind: true, tracking: true, baseUom: true } as const

const LABELS: Readonly<Record<ScannedKind, string>> = Object.freeze({ LOT: 'Lot', HIDE: 'Hide', ROLL: 'Roll', REMNANT: 'Remnant' })

/** The places of these ids (of the caller's sites), by id. */
export async function placesById(db: Reader, ids: readonly string[]): Promise<Map<string, PlaceRef & { siteId: string; companyId: string }>> {
  if (ids.length === 0) return new Map()
  const rows = await db.location.findMany({ where: { id: { in: [...new Set(ids)] } }, select: PLACE_COLUMNS })
  return new Map(rows.map((row) => [row.id, { ...row, kind: row.kind as string, status: row.status as string }]))
}

/**
 * The place a scan of its label names at the site: its label code, else (a place without a printed label, typed) its own
 * code, case aside. A label of another site is not a place here: refused in words at `body/placeCode`.
 */
export async function placeOfScan(db: Reader, siteId: string, scanned: string, path = 'body/placeCode'): Promise<PlaceRef> {
  const code = normalizeLabelCode(scanned)
  const byLabel = code ? await db.location.findFirst({ where: { siteId, labelCode: code }, select: PLACE_COLUMNS }) : null
  const row = byLabel ?? (code ? await db.location.findFirst({ where: { siteId, code: { equals: scanned.trim(), mode: 'insensitive' } }, select: PLACE_COLUMNS, orderBy: { id: 'asc' } }) : null)
  if (!row) throw new ValidationError(`No place of this site carries label ${code || scanned}: scan the label of a place here.`, [{ path, message: `No place of this site carries label ${code || scanned}.` }])
  return { ...row, kind: row.kind as string, status: row.status as string }
}

async function findScanned(db: Reader, code: string): Promise<{ kind: ScannedKind; hideId: string | null; lotId: string | null; rollId: string | null; remnantId: string | null } | null> {
  const codes = [...new Set([code, code.toUpperCase()])]
  const hide = await db.hide.findFirst({ where: { code: { in: codes } }, select: { id: true, lotId: true } })
  if (hide) return { kind: 'HIDE', hideId: hide.id, lotId: hide.lotId, rollId: null, remnantId: null }
  const remnant = await db.remnant.findFirst({ where: { code: { in: codes } }, select: { id: true, hideId: true } })
  if (remnant) {
    const of = await db.hide.findUnique({ where: { id: remnant.hideId }, select: { lotId: true } })
    return of ? { kind: 'REMNANT', hideId: remnant.hideId, lotId: of.lotId, rollId: null, remnantId: remnant.id } : null
  }
  const roll = await db.fabricRoll.findFirst({ where: { code: { in: codes } }, select: { id: true, lotId: true } })
  if (roll) return { kind: 'ROLL', hideId: null, lotId: roll.lotId, rollId: roll.id, remnantId: null }
  const lot = await db.lot.findFirst({ where: { code: { in: codes } }, select: { id: true } })
  return lot ? { kind: 'LOT', hideId: null, lotId: lot.id, rollId: null, remnantId: null } : null
}

/** What the scanned code names, where it lies and its quality state; another site's or an unknown code is not found. */
export async function handOf(db: Reader, context: StockContext, scanned: string, permission: Permission): Promise<Hand> {
  const code = scanned.trim()
  const found = code ? await findScanned(db, code) : null
  const lot = found?.lotId ? await db.lot.findUnique({ where: { id: found.lotId }, select: { id: true, code: true, companyId: true, siteId: true, itemId: true, itemColourId: true, qualityStatus: true, lifecycle: true } }) : null
  if (!found || !lot || !mayAt(context, permission, lot)) throw new NotFoundError(`Nothing at your site carries the label ${code || scanned}: scan a lot, a hide, a roll or a remnant's tag.`)
  const item = await db.item.findUniqueOrThrow({ where: { id: lot.itemId }, select: ITEM_COLUMNS })
  const colour = lot.itemColourId ? await db.itemColour.findUnique({ where: { id: lot.itemColourId }, select: { code: true, name: true } }) : null
  const hide = found.hideId ? await db.hide.findUnique({ where: { id: found.hideId }, select: { id: true, code: true, state: true } }) : null
  const roll = found.rollId ? await db.fabricRoll.findUnique({ where: { id: found.rollId }, select: { id: true, code: true, locationId: true, state: true, lengthLeft: true, uom: true } }) : null
  const remnant = found.remnantId ? await db.remnant.findUnique({ where: { id: found.remnantId }, select: { id: true, code: true } }) : null

  const holds = [...(await activeHoldsOf(db, 'Lot', [lot.id])), ...(hide ? await activeHoldsOf(db, 'Hide', [hide.id]) : [])]
  const balances = await readSiteStock(db, lot.siteId, { itemIds: [lot.itemId], lotId: lot.id, ...(hide ? { hideId: hide.id } : {}) })
  // A roll is its own tag: only its place, with what is left of it.
  const rows = roll ? balances.filter((balance) => balance.locationId === roll.locationId) : balances
  const places = await placesById(db, rows.map((row) => row.locationId))
  const byPlace = new Map<string, { location: PlaceRef; onHand: Decimal; rows: Lying['rows'][number][] }>()
  for (const row of rows) {
    const location = places.get(row.locationId)
    if (!location) continue
    const entry = byPlace.get(row.locationId) ?? { location, onHand: ZERO, rows: [] }
    entry.onHand = entry.onHand.plus(row.onHand)
    entry.rows.push({ lotId: row.lotId, hideId: row.hideId, itemColourId: row.itemColourId, onHand: new Dec(row.onHand) })
    byPlace.set(row.locationId, entry)
  }
  if (roll) {
    for (const entry of byPlace.values()) entry.onHand = leftInBase(roll, lengthUom(item.baseUom as string))
  }
  const lying = [...byPlace.values()].sort((a, b) => b.onHand.comparedTo(a.onHand) || a.location.code.localeCompare(b.location.code))
  const kind = found.kind
  const label = `${LABELS[kind]} ${hide?.code ?? roll?.code ?? remnant?.code ?? lot.code}`
  const hand: InHand = { kind, label, lotStatus: lot.qualityStatus as InHand['lotStatus'], onHold: holds.length > 0, whole: kind !== 'LOT' || item.tracking === 'HIDE' }
  return {
    ...hand,
    code,
    companyId: lot.companyId,
    siteId: lot.siteId,
    item: { ...item, kind: item.kind as string, tracking: item.tracking as string, baseUom: item.baseUom as string },
    itemColourId: lot.itemColourId,
    colour,
    lot: { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus as string, lifecycle: lot.lifecycle as string },
    hide: hide ? { ...hide, state: hide.state as string } : null,
    roll: roll ? { id: roll.id, code: roll.code, locationId: roll.locationId, state: roll.state as string } : null,
    remnant,
    quality: qualityOf(hand),
    holds: holds.map((hold) => ({ id: hold.id, reasonCode: hold.reasonCode })),
    lying,
  }
}

/** The answer's view of what is in hand (no money; the quantities in the item's base unit). */
export function handView(hand: Hand) {
  return {
    kind: hand.kind,
    code: hand.code,
    label: hand.label,
    siteId: hand.siteId,
    item: hand.item,
    colour: hand.colour,
    lot: hand.lot,
    hide: hand.hide,
    roll: hand.roll ? { id: hand.roll.id, code: hand.roll.code, state: hand.roll.state } : null,
    remnant: hand.remnant,
    quality: hand.quality,
    holdIds: hand.holds.map((hold) => hold.id),
    whole: hand.whole,
    uom: hand.item.baseUom,
    onHand: hand.lying.reduce((sum, entry) => sum.plus(entry.onHand), ZERO).toString(),
    lying: hand.lying.map((entry) => ({ locationId: entry.location.id, code: entry.location.code, name: entry.location.name, kind: entry.location.kind, onHand: entry.onHand.toString() })),
  }
}
