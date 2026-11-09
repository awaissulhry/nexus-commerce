import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { addArea, isAreaUom, noArea, twoNumbersWords, withOtherUnit, type AreaUom, type TwoNumbers } from '@nexus/factory-domain/inventory/hides/area'
import { INVENTORY_ISSUE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { MINIMUM_REMNANT, minimumRemnantIn, type RemnantState } from '@nexus/factory-domain/inventory/remnants/rules'
import { minimumRemnantFor } from './size'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf, stockContextOf } from '../ledger/access'
import { REMNANT_SELECT, type RemnantRow } from './lifecycle'

/**
 * The remnants' reads (B-W2b-100; SCM-254; design warehouse.hides "Remnants" view and tile, floor.scan "remnant"): the list
 * of a site's tagged pieces (office, inventory.stock.view, within the caller's grants), one piece with its history (its
 * audit rows), and the lookup of a scanned RM tag (office and the floor at its own site, inventory.issue: the pick screen
 * issues a remnant by its tag). Areas carry the other unit; the list's totals are the two numbers ("2 pieces · 8.00 ft²
 * (0.7 m²)"). No figure carries money; no person is named in a list (the history names the office person who did it, and
 * a floor action by its audience only).
 */

const PIECE_SELECT = {
  ...REMNANT_SELECT,
  hide: { select: { id: true, code: true, state: true, grade: true, shade: true, shadeGroup: { select: { label: true, outOfShade: true } }, lot: { select: { id: true, code: true, dyeBatch: true, itemColourId: true, item: { select: { id: true, code: true, name: true, baseUom: true } } } } } },
  grade: { select: { id: true, code: true } },
  location: { select: { id: true, code: true, name: true } },
  move: { select: { id: true, reason: true, workOrderId: true, reversalOfId: true, occurredAt: true } },
} as const satisfies Prisma.RemnantSelect
type PieceRow = Prisma.RemnantGetPayload<{ select: typeof PIECE_SELECT }>

const SCOPE = { company: 'companyId', site: 'siteId' } as const

function pieceView(row: PieceRow, colours: ReadonlyMap<string, { code: string; name: string }>, workOrders: ReadonlyMap<string, string>) {
  const uom: AreaUom = isAreaUom(row.areaUom) ? row.areaUom : 'M2'
  const lot = row.hide.lot
  const colour = lot.itemColourId ? colours.get(lot.itemColourId) : undefined
  return {
    id: row.id,
    code: row.code,
    state: row.state,
    area: withOtherUnit(row.area.toFixed(4), uom),
    baseArea: row.baseArea.toFixed(4),
    baseUom: lot.item.baseUom,
    // Its own grade when it has one, else the hide's (record or W1 text).
    grade: row.grade?.code ?? row.hide.grade,
    hide: { id: row.hide.id, code: row.hide.code, state: row.hide.state },
    lot: { id: lot.id, code: lot.code, dyeBatch: lot.dyeBatch },
    item: { id: lot.item.id, code: lot.item.code, name: lot.item.name },
    colour: colour ? { code: colour.code, name: colour.name } : null,
    shade: row.hide.shadeGroup?.label ?? row.hide.shade,
    outOfShade: row.hide.shadeGroup?.outOfShade ?? false,
    location: row.location ? { id: row.location.id, code: row.location.code, name: row.location.name } : null,
    move: { id: row.move.id, reason: row.move.reason, workOrderNumber: row.move.workOrderId ? (workOrders.get(row.move.workOrderId) ?? null) : null, occurredAt: toUtcIso(row.move.occurredAt) },
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

async function namesOf(db: Pick<Prisma.TransactionClient, 'itemColour' | 'workOrder'>, rows: readonly PieceRow[]) {
  const colourIds = [...new Set(rows.flatMap((row) => (row.hide.lot.itemColourId ? [row.hide.lot.itemColourId] : [])))]
  const workOrderIds = [...new Set(rows.flatMap((row) => (row.move.workOrderId ? [row.move.workOrderId] : [])))]
  const colours = new Map((colourIds.length ? await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const workOrders = new Map((workOrderIds.length ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
  return { colours, workOrders }
}

export interface RemnantsQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  /** Default IN_STOCK; `all` for every state. */
  readonly state?: RemnantState | 'all' | undefined
  /** A tag, or its start. */
  readonly q?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

/** GET /inventory/remnants: the site's tagged pieces, newest first, with the two numbers of the whole selection. */
export async function listRemnants(caller: CommandCaller, query: RemnantsQuery) {
  const context = officeContextOf(caller)
  const state = query.state ?? 'IN_STOCK'
  const where: Prisma.RemnantWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.RemnantWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      state === 'all' ? {} : { state },
      query.lotId ? { lotId: query.lotId } : {},
      query.hideId ? { hideId: query.hideId } : {},
      query.itemId ? { hide: { itemId: query.itemId } } : {},
      query.itemColourId ? { hide: { lot: { itemColourId: query.itemColourId } } } : {},
      query.q ? { code: { startsWith: query.q.trim().toUpperCase() } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.remnant.findMany({ where: { AND: [where, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}] }, select: PIECE_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const all = await client.remnant.findMany({ where, select: { area: true, areaUom: true } })
    const totals = new Map<AreaUom, TwoNumbers>()
    for (const row of all) {
      const uom: AreaUom = isAreaUom(row.areaUom) ? row.areaUom : 'M2'
      // One total per unit of entry: m² and ft² are never added up.
      totals.set(uom, addArea(totals.get(uom) ?? noArea(uom), 1, row.area.toString(), uom))
    }
    const names = await namesOf(client, page)
    return {
      rows: page.map((row) => pieceView(row, names.colours, names.workOrders)),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      totals: [...totals.values()].map((total) => ({ uom: total.uom, pieces: total.hides, area: total.area.toFixed(4), words: { it: twoNumbersWords(total, 'it', 'pieces'), en: twoNumbersWords(total, 'en', 'pieces') } })),
      // B-W2b-219: the site's own smallest remnant when the list is of one site, else the default every site starts from.
      minimum: query.siteId ? await minimumRemnantFor(client, query.siteId) : { area: MINIMUM_REMNANT.area, uom: MINIMUM_REMNANT.uom, setting: false },
    }
  })
}

/** GET /inventory/remnants/:remnantId: one piece, its history (audit rows, newest first). */
export async function remnantRecord(caller: CommandCaller, remnantId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(remnantId) ? await caller.withClient((client) => client.remnant.findUnique({ where: { id: remnantId }, select: PIECE_SELECT })) : null
  if (!row || !mayAt(context, INVENTORY_STOCK_VIEW, row)) throw new NotFoundError('Remnant not found.')
  return caller.withClient(async (client) => {
    const names = await namesOf(client, [row])
    const audit = await client.auditLog.findMany({
      where: { recordType: 'Remnant', recordId: row.id, action: { in: ['inventory.tagRemnant', 'inventory.remnantState', 'inventory.remnantPlace'] } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { at: true, action: true, audience: true, actorId: true, before: true, after: true, reason: true },
      take: 100,
    })
    const officeIds = [...new Set(audit.filter((entry) => entry.audience === 'OFFICE' && entry.actorId).map((entry) => entry.actorId!))]
    const users = new Map((officeIds.length ? await client.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    // B-W2b-219: the smallest remnant of the piece's site, in its leather's base unit.
    const siteMinimum = await minimumRemnantFor(client, row.siteId)
    const minimum = minimumRemnantIn(row.hide.lot.item.baseUom, siteMinimum)
    return {
      remnant: pieceView(row, names.colours, names.workOrders),
      minimum: minimum ? { baseArea: minimum.toFixed(4), setting: siteMinimum.setting } : null,
      history: audit.map((entry) => {
        const after = (entry.after ?? {}) as { state?: string; cause?: string; locationId?: string | null; source?: string }
        const before = (entry.before ?? {}) as { state?: string; locationId?: string | null }
        return {
          at: toUtcIso(entry.at),
          action: entry.action === 'inventory.tagRemnant' ? ('TAGGED' as const) : entry.action === 'inventory.remnantPlace' ? ('MOVED' as const) : ('STATE' as const),
          from: before.state ?? null,
          to: after.state ?? null,
          cause: after.cause ?? after.source ?? null,
          // An office person by name; a floor action says FLOOR (no worker named in the history).
          by: entry.audience === 'OFFICE' ? (users.get(entry.actorId ?? '') ?? null) : null,
          audience: entry.audience,
          reason: entry.reason,
        }
      }),
    }
  })
}

/** GET /inventory/remnants/lookup?code=: a scanned RM tag (office, or the floor at its own site), with its hide's tag. */
export async function lookupRemnant(caller: CommandCaller, code: string): Promise<{ remnant: ReturnType<typeof pieceView> }> {
  const context = stockContextOf(caller)
  const row = await caller.withClient((client) => client.remnant.findFirst({ where: { code: code.trim().toUpperCase() }, select: PIECE_SELECT }))
  if (!row || !mayAt(context, INVENTORY_ISSUE, row)) throw new NotFoundError('No remnant has this tag at your sites.')
  const names = await caller.withClient((client) => namesOf(client, [row]))
  return { remnant: pieceView(row, names.colours, names.workOrders) }
}

export type { RemnantRow }
