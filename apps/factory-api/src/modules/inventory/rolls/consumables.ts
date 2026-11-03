import type { Prisma, Uom } from '@nexus/factory-db'
import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { CONSUMABLE_KINDS, levelOf, packProblems, packsOf, packWords, type LevelState, type PackUom } from '@nexus/factory-domain/inventory/rolls/consumables'
import { numberText } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PLANNING_ITEMS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import { PRODUCT_MATERIALS_MANAGE } from '@nexus/factory-domain/product/materials/permissions'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readReservations } from '../../planning/inputs'
import { readPurchases, readStock } from '../../planning/store'
import { assertMayWrite, contextOf, mayWrite, readMaterial } from '../../product/materials/store'
import { officeContextOf, siteFor } from '../ledger/access'
import { fixed } from '../stock/read-kit'

/**
 * Consumables by pack (B-W2b-107; SCM-263; design products.materials "Approved suppliers with … pack size", planning.settings
 * "Reorder rules"): thread, needles and glue kept by the pack, with a minimum and maximum per site.
 *
 *   GET /inventory/consumables?siteId=        office (inventory.stock.view at the site): every active material with a pack
 *                                             (and every thread), per colour where the site keeps levels per colour: on hand in
 *                                             packs beside the base unit ("12 cones · 60,000 m"), what open purchase lines still
 *                                             bring, what ACTIVE reservations hold, the site's MIN_MAX levels (planning's item
 *                                             parameters), the state (below the minimum, ok, above the maximum, no levels) and
 *                                             what to order now, up to the maximum in whole packs. The levels are kept with
 *                                             POST|PATCH /planning/item-parameters (method MIN_MAX; planning.items.manage), the
 *                                             one writer of ItemPlanning: `levels.itemPlanningId` names the row.
 *   PUT /inventory/consumables/:itemId/pack   office (product.materials.manage over the material's company; a tenant-wide
 *                                             material needs every company): the pack at the material's version: size (base
 *                                             units in one pack) and unit (CONE, BOX, ROLL, SET, PCS, PAIR), both or neither
 *                                             (null removes it). Audit before → after on the Item, consumable.pack_changed.
 *
 * No money (the stock is counted, never valued here); no person.
 */

const ITEM_SELECT = { id: true, code: true, name: true, kind: true, baseUom: true, packSize: true, packUom: true, companyId: true, version: true } as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_SELECT }>

export interface ConsumablesQuery {
  readonly siteId: string
  readonly q?: string | undefined
  readonly state?: LevelState | undefined
  readonly limit: number
}

const keyOf = (itemId: string, colourId: string | null) => `${itemId}|${colourId ?? '-'}`

/** GET /inventory/consumables. */
export async function listConsumables(caller: CommandCaller, query: ConsumablesQuery) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'siteId')
  const actor = actorOf(context)
  const q = query.q?.trim()
  return caller.withClient(async (client) => {
    const items: ItemRow[] = await client.item.findMany({
      where: {
        status: 'ACTIVE',
        kind: { not: 'FINISHED' },
        AND: [
          { OR: [{ packSize: { not: null } }, { kind: { in: [...CONSUMABLE_KINDS] } }] },
          { OR: [{ companyId: null }, { companyId: site.companyId }] },
          q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {},
        ],
      },
      select: ITEM_SELECT,
      orderBy: { code: 'asc' },
      take: 500,
    })
    const itemIds = items.map((item) => item.id)
    const planning = itemIds.length ? await client.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: itemIds } }, select: { id: true, itemId: true, itemColourId: true, method: true, minStock: true, maxStock: true, version: true } }) : []
    const stock = await readStock(client, site.id, itemIds)
    const purchases = await readPurchases(client, site.id, itemIds)
    const reservations = (await readReservations(client, site.id, itemIds)).filter((row) => row.demandOpen)
    const colourIds = [...new Set(planning.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
    const colours = new Map((colourIds.length ? await client.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    const canEditLevels = can(actor, PLANNING_ITEMS_MANAGE, { companyId: site.companyId, siteId: site.id })

    // A row per item (every colour together) and one per colour the site keeps its own levels for.
    const sum = (entries: readonly { itemId: string; itemColourId: string | null; quantity: Decimal }[], itemId: string, colourId: string | null | 'all') =>
      entries.filter((entry) => entry.itemId === itemId && (colourId === 'all' || entry.itemColourId === colourId)).reduce((total, entry) => total.plus(entry.quantity), ZERO)
    const onHandOf = stock.map((entry) => ({ itemId: entry.itemId, itemColourId: entry.itemColourId, quantity: new Dec(entry.quantity) }))
    const onOrderOf = purchases.map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId, quantity: new Dec(line.openQuantity.toString()) }))
    const reservedOf = reservations.map((row) => ({ itemId: row.itemId, itemColourId: row.itemColourId, quantity: new Dec(row.open) }))
    const rows = items.flatMap((item) => {
      const own = planning.filter((row) => row.itemId === item.id)
      const scopes: (string | null)[] = [null, ...own.flatMap((row) => (row.itemColourId ? [row.itemColourId] : []))]
      return [...new Set(scopes.map((colour) => keyOf(item.id, colour)))].map((key) => {
        const colourId = key.split('|')[1] === '-' ? null : key.split('|')[1]!
        const scope = colourId ?? 'all'
        const levelsRow = own.find((row) => row.itemColourId === colourId) ?? null
        const minMax = levelsRow && levelsRow.method === 'MIN_MAX' ? levelsRow : null
        const onHand = sum(onHandOf, item.id, scope)
        const onOrder = sum(onOrderOf, item.id, scope)
        const reserved = sum(reservedOf, item.id, scope)
        const pack = item.packSize !== null && item.packUom !== null ? { packSize: new Dec(item.packSize.toString()).toFixed(4), packUom: item.packUom } : null
        const level = levelOf({
          onHand,
          onOrder,
          reserved,
          minStock: minMax?.minStock === null || minMax?.minStock === undefined ? null : new Dec(minMax.minStock.toString()).toFixed(4),
          maxStock: minMax?.maxStock === null || minMax?.maxStock === undefined ? null : new Dec(minMax.maxStock.toString()).toFixed(4),
          packSize: pack?.packSize ?? null,
        })
        const colour = colourId ? colours.get(colourId) : undefined
        const packs = pack ? packsOf(onHand, pack.packSize) : null
        return {
          item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom, version: item.version },
          colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
          pack,
          onHand: fixed(onHand),
          onHandPacks: packs ? { packs: packs.packs.toFixed(0), loose: fixed(packs.loose) } : null,
          onOrder: fixed(onOrder),
          reserved: fixed(reserved),
          words: { it: packWords(onHand, item.baseUom, pack, 'it'), en: packWords(onHand, item.baseUom, pack, 'en') },
          levels: levelsRow
            ? {
                itemPlanningId: levelsRow.id,
                method: levelsRow.method,
                minStock: minMax?.minStock === null || minMax?.minStock === undefined ? null : fixed(new Dec(minMax.minStock.toString())),
                maxStock: minMax?.maxStock === null || minMax?.maxStock === undefined ? null : fixed(new Dec(minMax.maxStock.toString())),
                version: levelsRow.version,
              }
            : null,
          state: level.state,
          position: fixed(level.position),
          reorder: level.reorder.greaterThan(0)
            ? {
                quantity: fixed(level.reorder),
                packs: level.reorderPacks ? level.reorderPacks.toFixed(0) : null,
                words: { it: packWords(level.reorder, item.baseUom, pack, 'it'), en: packWords(level.reorder, item.baseUom, pack, 'en') },
              }
            : null,
          canEditPack: mayWrite(actor, PRODUCT_MATERIALS_MANAGE, item.companyId),
          canEditLevels,
        }
      })
    })
    const shown = query.state ? rows.filter((row) => row.state === query.state) : rows
    const counts = { belowMin: rows.filter((row) => row.state === 'BELOW_MIN').length, ok: rows.filter((row) => row.state === 'OK').length, aboveMax: rows.filter((row) => row.state === 'ABOVE_MAX').length, noLevels: rows.filter((row) => row.state === 'NO_LEVELS').length }
    return { site: { id: site.id, code: site.code, name: site.name }, rows: shown.slice(0, query.limit), more: shown.length > query.limit, counts }
  })
}

// ---- the pack ---------------------------------------------------------------------------------------------------------------

export interface PackBody {
  readonly version: number
  readonly packSize: string | null
  readonly packUom: PackUom | null
}

/** PUT /inventory/consumables/:itemId/pack. */
export async function setPack(caller: CommandCaller, itemId: string, body: PackBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, itemId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, seen.companyId)
  if (seen.status !== 'ACTIVE') throw new InvalidStateError(`Material ${seen.code} is ${seen.status}: reactivate it first.`)
  const problems = packProblems(body, seen.baseUom as Uom)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The pack is not valid.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  const packSize = body.packSize === null ? null : new Dec(body.packSize.trim()).toFixed(4)

  const { result } = await command(caller, { name: 'inventory.setConsumablePack', idempotencyKey, input: { itemId, ...body }, record: { type: 'Item', id: itemId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const before = await tx.item.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_SELECT })
    const beforeSize = before.packSize === null ? null : new Dec(before.packSize.toString()).toFixed(4)
    await tx.item.update({ where: { id: itemId }, data: { packSize, packUom: body.packUom }, select: { id: true } })
    tools.audit({
      action: 'inventory.setConsumablePack',
      recordType: 'Item',
      recordId: itemId,
      companyId: before.companyId,
      before: { packSize: beforeSize, packUom: before.packUom },
      after: { packSize, packUom: body.packUom },
    })
    tools.emit({ type: 'consumable.pack_changed', subject: itemId, companyId: before.companyId, payload: { itemId, code: before.code, packSize, packUom: body.packUom } })
    const after = await tx.item.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_SELECT })
    return {
      item: { id: after.id, code: after.code, name: after.name, kind: after.kind, baseUom: after.baseUom, version: after.version },
      pack: after.packSize !== null && after.packUom !== null ? { packSize: new Dec(after.packSize.toString()).toFixed(4), packUom: after.packUom, words: { it: `1 ${UNITS[after.packUom].name.it} = ${numberText(after.packSize.toString(), 'it')} ${UNITS[after.baseUom].symbol}`, en: `1 ${UNITS[after.packUom].name.en} = ${numberText(after.packSize.toString(), 'en')} ${UNITS[after.baseUom].symbol}` } } : null,
    }
  })
  return result
}
