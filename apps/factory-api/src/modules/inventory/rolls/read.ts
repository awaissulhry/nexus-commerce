import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_ISSUE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { IN_STOCK_STATES, isLengthUom, lengthIn, rollsWords, type LengthUom, type RollState } from '@nexus/factory-domain/inventory/rolls/rolls'
import { ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf, stockContextOf } from '../ledger/access'
import { lengthUom, lotCheckOf, LOT_SELECT, ROLL_SELECT, rollView, type RollRow } from './facts'

/**
 * The rolls' reads (B-W2b-107; SCM-260; design production.cutting "rolls by shade, width and shrinkage group", floor.fabriccut
 * "Scan each roll label", warehouse.lots "rolls"): a site's rolls with the filters a cut order allocates by (office,
 * inventory.stock.view, within the caller's grants), one roll with its history (its audit rows) and its lot's check, and the
 * lookup of a scanned RL tag (office and the floor at its own site, inventory.issue: the fabric cutting and issue screens).
 * The list's totals are rolls beside length ("3 rolls · 164.5 m"); with a lot named, the lot's rolls against its ledger. No
 * money; no person in a list (the history names an office person, a floor action by its audience only).
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const

export interface RollsQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  /** Default `inStock` (FULL, PARTIAL, END); one state, or `all`. */
  readonly state?: RollState | 'inStock' | 'all' | undefined
  readonly shadeGroupId?: string | undefined
  readonly shade?: string | undefined
  readonly shrinkageGroup?: string | undefined
  readonly minWidthCm?: string | undefined
  readonly maxWidthCm?: string | undefined
  /** At least this much left, in the roll's unit (a cut order's lay length). */
  readonly minLengthLeft?: string | undefined
  /** A tag (or its start) or the supplier's roll number. */
  readonly q?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

/** GET /inventory/rolls: the site's rolls, newest first, with rolls beside length for the whole selection. */
export async function listRolls(caller: CommandCaller, query: RollsQuery) {
  const context = officeContextOf(caller)
  const state = query.state ?? 'inStock'
  const q = query.q?.trim()
  const where: Prisma.FabricRollWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.FabricRollWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      state === 'all' ? {} : state === 'inStock' ? { state: { in: [...IN_STOCK_STATES] }, locationId: { not: null } } : { state },
      query.itemId ? { itemId: query.itemId } : {},
      query.itemColourId ? { lot: { itemColourId: query.itemColourId } } : {},
      query.lotId ? { lotId: query.lotId } : {},
      query.shadeGroupId ? { shadeGroupId: query.shadeGroupId } : {},
      query.shade ? { shade: query.shade.trim() } : {},
      query.shrinkageGroup ? { shrinkageGroup: query.shrinkageGroup.trim() } : {},
      query.minWidthCm ? { widthCm: { gte: query.minWidthCm } } : {},
      query.maxWidthCm ? { widthCm: { lte: query.maxWidthCm } } : {},
      query.minLengthLeft ? { lengthLeft: { gte: query.minLengthLeft } } : {},
      q ? { OR: [{ code: { startsWith: q.toUpperCase() } }, { supplierRollRef: { equals: q } }] } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.fabricRoll.findMany({ where: { AND: [where, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}] }, select: ROLL_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const all = await client.fabricRoll.findMany({ where, select: { lengthLeft: true, uom: true } })
    // One total per unit: metres are never added to centimetres unconverted (a total is in metres when units mix).
    const units = new Set(all.map((row) => lengthUom(row.uom)))
    const unit: LengthUom = units.size === 1 ? [...units][0]! : 'M'
    const length = all.reduce<Decimal>((sum, row) => sum.plus(lengthIn(row.lengthLeft.toString(), lengthUom(row.uom), unit)), ZERO)
    let lot = null
    if (query.lotId) {
      const lotRow = await client.lot.findUnique({ where: { id: query.lotId }, select: LOT_SELECT })
      if (lotRow && isLengthUom(lotRow.item.baseUom) && mayAt(context, INVENTORY_STOCK_VIEW, lotRow)) lot = (await lotCheckOf(client, lotRow, lotRow.item.baseUom)).view
    }
    return {
      rows: page.map(rollView),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      summary: { rolls: all.length, length: length.toFixed(4), uom: unit, words: { it: rollsWords(all.length, length, unit, 'it'), en: rollsWords(all.length, length, unit, 'en') } },
      lot,
    }
  })
}

const HISTORY_ACTIONS = ['inventory.tagRoll', 'inventory.describeRoll', 'inventory.issueRoll', 'inventory.returnRoll', 'inventory.moveRoll', 'inventory.scrapRoll', 'inventory.correctRoll'] as const
type HistoryWord = 'TAGGED' | 'DESCRIBED' | 'ISSUED' | 'RETURNED' | 'MOVED' | 'SCRAPPED' | 'CORRECTED'
const HISTORY_WORDS: Readonly<Record<(typeof HISTORY_ACTIONS)[number], HistoryWord>> = {
  'inventory.tagRoll': 'TAGGED',
  'inventory.describeRoll': 'DESCRIBED',
  'inventory.issueRoll': 'ISSUED',
  'inventory.returnRoll': 'RETURNED',
  'inventory.moveRoll': 'MOVED',
  'inventory.scrapRoll': 'SCRAPPED',
  'inventory.correctRoll': 'CORRECTED',
}

/** GET /inventory/rolls/:rollId: one roll, its lot's rolls against the ledger, and its history (audit rows, newest first). */
export async function rollRecord(caller: CommandCaller, rollId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(rollId) ? await caller.withClient((client) => client.fabricRoll.findUnique({ where: { id: rollId }, select: ROLL_SELECT })) : null
  if (!row || !mayAt(context, INVENTORY_STOCK_VIEW, row)) throw new NotFoundError('Roll not found.')
  return caller.withClient(async (client) => {
    const base = isLengthUom(row.lot.item.baseUom) ? row.lot.item.baseUom : lengthUom(row.uom)
    const lot = (await lotCheckOf(client, { id: row.lotId, code: row.lot.code }, base)).view
    const audit = await client.auditLog.findMany({
      where: { recordType: 'FabricRoll', recordId: row.id, action: { in: [...HISTORY_ACTIONS] } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { at: true, action: true, audience: true, actorId: true, before: true, after: true, reason: true },
      take: 100,
    })
    const officeIds = [...new Set(audit.filter((entry) => entry.audience === 'OFFICE' && entry.actorId).map((entry) => entry.actorId!))]
    const users = new Map((officeIds.length ? await client.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    const workOrderIds = [...new Set(audit.flatMap((entry) => { const id = (entry.after as { workOrderId?: unknown } | null)?.workOrderId; return typeof id === 'string' && isUuid(id) ? [id] : [] }))]
    const workOrders = new Map((workOrderIds.length ? await client.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } }) : []).map((order) => [order.id, order.number]))
    return {
      roll: rollView(row),
      lot,
      history: audit.map((entry) => {
        const before = (entry.before ?? {}) as { state?: string; lengthLeft?: string }
        const after = (entry.after ?? {}) as { state?: string; lengthLeft?: string; workOrderId?: string; quantity?: string }
        return {
          at: toUtcIso(entry.at),
          action: HISTORY_WORDS[entry.action as (typeof HISTORY_ACTIONS)[number]] ?? 'DESCRIBED',
          from: before.state ?? null,
          to: after.state ?? null,
          lengthBefore: before.lengthLeft ?? null,
          lengthAfter: after.lengthLeft ?? null,
          workOrderNumber: after.workOrderId ? (workOrders.get(after.workOrderId) ?? null) : null,
          // An office person by name; a floor action says FLOOR (no worker named in the history).
          by: entry.audience === 'OFFICE' ? (users.get(entry.actorId ?? '') ?? null) : null,
          audience: entry.audience,
          reason: entry.reason,
        }
      }),
    }
  })
}

/** GET /inventory/rolls/lookup?code=: a scanned RL tag (office, or the floor at its own site). */
export async function lookupRoll(caller: CommandCaller, code: string): Promise<{ roll: ReturnType<typeof rollView> }> {
  const context = stockContextOf(caller)
  const row: RollRow | null = await caller.withClient((client) => client.fabricRoll.findFirst({ where: { code: code.trim().toUpperCase() }, select: ROLL_SELECT }))
  if (!row || !mayAt(context, INVENTORY_ISSUE, row)) throw new NotFoundError('No roll has this tag at your sites.')
  return { roll: rollView(row) }
}

