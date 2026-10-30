import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import type { CountView, LineView } from './contract'
import { COUNT_COLUMNS, readCount } from './store'
import { COUNT_SCOPE, countViews, lineViews, listWhere, pageOfLines, scopeOf } from './views'

/**
 * The counts' reads (B-W2a-15; design warehouse.counts): the list with its filters, the tiles, the adjustment reasons a
 * difference is given, and a count's lines a page at a time. Office only; scopeWhere() for lists, can() for one count.
 */

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: string | undefined
  readonly kind?: string | undefined
  readonly open?: 'true' | 'false' | undefined
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
