import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import type { CountListView, CountItemKind } from '@nexus/factory-domain/inventory/counts/rules'
import { differs } from '@nexus/factory-domain/inventory/counts/rules'
import type { CountView, LineView } from './contract'
import { siteLocations } from './ledger-at'
import { COUNT_COLUMNS, readCount } from './store'
import { COUNT_SCOPE, countViews, factsOf, lineViews, listWhere, pageOfLines, scopeOf } from './views'

/**
 * The counts' reads (B-W2a-15; design warehouse.counts): the list with its filters, the tiles, the adjustment reasons a
 * difference is given, and a count's lines a page at a time. Office only; scopeWhere() for lists, can() for one count.
 */

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: string | undefined
  readonly kind?: string | undefined
  readonly open?: 'true' | 'false' | undefined
  /** B-W2b-15: waiting for approval / to apply (the tiles' rows). */
  readonly view?: CountListView | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The counts the caller may see, newest first. */
export async function listCounts(caller: CommandCaller, query: ListQuery): Promise<{ counts: CountView[]; nextCursor: string | null }> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.stockCount.findMany({
      where: { AND: [listWhere(context, query), query.cursor ? { id: { lt: query.cursor } } : {}] },
      select: COUNT_COLUMNS,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    return { counts: await countViews(client, page), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** The list's tiles (the same scope as the list). */
export async function countTiles(caller: CommandCaller, siteId: string | undefined) {
  const context = officeContextOf(caller)
  const scope = { AND: [scopeWhere(actorOf(context), INVENTORY_COUNTS_VIEW, COUNT_SCOPE), siteId ? { siteId } : {}] }
  return caller.withClient(async (client) => {
    const count = (where: object) => client.stockCount.count({ where: { AND: [scope, where] } })
    return {
      drafts: await count({ status: 'DRAFT' }),
      counting: await count({ status: 'COUNTING' }),
      waitingApproval: await count({ status: 'SUBMITTED', approvalRequired: true }),
      toApply: await count({ OR: [{ status: 'APPROVED' }, { status: 'SUBMITTED', approvalRequired: false }] }),
      yearEnd: await count({ kind: 'YEAR_END', status: { in: ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'APPLIED'] } }),
    }
  })
}

/** The adjustment reasons a difference is given (the tenant's ADJUSTMENT list, active, in its order). */
export async function countReasons(caller: CommandCaller) {
  officeContextOf(caller)
  return caller.withClient(async (client) => ({
    reasons: await client.reasonCode.findMany({
      where: { list: 'ADJUSTMENT', active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, labelIt: true, labelEn: true, needsDetail: true },
    }),
  }))
}

export interface LinesQuery {
  readonly filter: string
  readonly locationId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: number | undefined
  readonly limit: number
}

/** A page of a count's lines in sheet order. */
export async function listLines(caller: CommandCaller, countId: string, query: LinesQuery): Promise<{ lines: LineView[]; nextCursor: number | null }> {
  const context = officeContextOf(caller)
  if (!isUuid(countId)) throw new NotFoundError('Stock count not found.')
  return caller.withClient(async (client) => {
    const count = await readCount(client, countId)
    if (!count || !can(actorOf(context), INVENTORY_COUNTS_VIEW, scopeOf(count))) throw new NotFoundError('Stock count not found.')
    const page = await pageOfLines(client, countId, query)
    return { lines: await lineViews(client, count, page.lines, context), nextCursor: page.nextCursor }
  })
}

/**
 * B-W2b-15 (follow-up Z2:05): a count's lines per place, for the Lines tab's place filter — every place the count has
 * lines at (not only those of the page read so far), with how many lines, how many are counted and how many differ.
 */
export async function countPlaces(caller: CommandCaller, countId: string) {
  const context = officeContextOf(caller)
  if (!isUuid(countId)) throw new NotFoundError('Stock count not found.')
  return caller.withClient(async (client) => {
    const count = await readCount(client, countId)
    if (!count || !can(actorOf(context), INVENTORY_COUNTS_VIEW, scopeOf(count))) throw new NotFoundError('Stock count not found.')
    const lines = await client.stockCountLine.findMany({ where: { countId }, select: { locationId: true, expectedQuantity: true, countedQuantity: true, recountRequestedAt: true, recountQuantity: true } })
    const per = new Map<string, { lines: number; counted: number; differing: number }>()
    for (const line of lines) {
      const entry = per.get(line.locationId) ?? { lines: 0, counted: 0, differing: 0 }
      entry.lines++
      if (line.countedQuantity !== null) entry.counted++
      if (line.countedQuantity !== null && differs(factsOf(line))) entry.differing++
      per.set(line.locationId, entry)
    }
    const nodes = await siteLocations(client, count.siteId)
    const places = [...per.entries()].map(([locationId, figures]) => {
      const node = nodes.get(locationId)
      return { location: { id: locationId, code: node?.code ?? '', name: node?.name ?? '', path: node?.path ?? '' }, ...figures }
    })
    return { places: places.sort((a, b) => (a.location.path < b.location.path ? -1 : a.location.path > b.location.path ? 1 : 0)) }
  })
}

export interface ItemsQuery {
  readonly siteId: string
  readonly q: string
  readonly kind?: CountItemKind | undefined
  readonly limit: number
}

/**
 * B-W2b-15 (follow-up Z2:06): what a count names, by code or name — the materials AND the finished garments (FINISHED
 * items, one per SKU: Products › Materials & trims leaves them out) of the site's company and the tenant's shared ones,
 * active, with their colours (in use). inventory.counts.view at the site; no cost.
 */
export async function countItems(caller: CommandCaller, query: ItemsQuery) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } })
    if (!site || !can(actorOf(context), INVENTORY_COUNTS_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const items = await client.item.findMany({
      where: {
        AND: [
          { status: 'ACTIVE' },
          { OR: [{ companyId: site.companyId }, { companyId: null }] },
          query.kind ? { kind: query.kind } : {},
          { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] },
        ],
      },
      select: { id: true, code: true, name: true, kind: true, baseUom: true, tracking: true },
      orderBy: [{ code: 'asc' }],
      take: query.limit,
    })
    const colours = items.length === 0 ? [] : await client.itemColour.findMany({ where: { itemId: { in: items.map((item) => item.id) }, status: 'ACTIVE' }, select: { id: true, itemId: true, code: true, name: true }, orderBy: { code: 'asc' } })
    return {
      items: items.map((item) => ({ ...item, colours: colours.filter((colour) => colour.itemId === item.id).map(({ itemId: _item, ...colour }) => colour) })),
    }
  })
}
