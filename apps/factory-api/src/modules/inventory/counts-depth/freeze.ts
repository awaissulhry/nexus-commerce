import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'

/**
 * Frozen lines (B-W2b-299; SCM-226 "a started count freezes its lines and their moves until each is counted"; design
 * warehouse.counts cn-lines "frozen lines block moves of the counted items at that location"): a count made with `freeze`
 * writes its snapshot's lines frozen (../counts/counts.ts, the start); while it is COUNTING the database refuses every move
 * but a COUNT of a frozen line's item into or out of its location until the line is counted (and its asked recount done).
 * The moves' own commands answer that in words (409 warehouse/COUNT_FROZEN: postMoves' mapper, the bin moves' check first).
 *
 *   GET /inventory/stock-counts/frozen?siteId&locationId&itemId   the lines that hold their moves now (inventory.counts.view)
 */

export const FROZEN_WORDS = {
  en: 'A count is counting these materials at these places: their moves wait until each line is counted (and recounted when a recount was asked). A COUNT move is never held.',
  it: 'Un inventario sta contando questi materiali in queste ubicazioni: i loro movimenti attendono che ogni riga sia contata (e ricontata quando è stato chiesto un riconteggio). Un movimento di inventario non è mai bloccato.',
} as const

/** GET /inventory/stock-counts/frozen */
export async function frozenLines(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly locationId?: string | undefined; readonly itemId?: string | undefined }) {
  const context = officeContextOf(caller)
  const counts = scopeWhere(actorOf(context), INVENTORY_COUNTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.StockCountWhereInput
  return caller.withClient(async (db) => {
    const lines = await db.stockCountLine.findMany({
      where: {
        frozenAt: { not: null },
        count: { AND: [counts, { status: 'COUNTING' }] },
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
        OR: [{ countedAt: null }, { recountRequestedAt: { not: null }, recountedAt: null }],
      },
      select: {
        id: true,
        seq: true,
        frozenAt: true,
        countedAt: true,
        count: { select: { id: true, number: true } },
        location: { select: { id: true, code: true, name: true, labelCode: true } },
        item: { select: { id: true, code: true, name: true } },
        lot: { select: { id: true, code: true } },
        hide: { select: { id: true, code: true } },
      },
      orderBy: [{ countId: 'asc' }, { seq: 'asc' }],
      take: 500,
    })
    return {
      lines: lines.map((line) => ({
        lineId: line.id,
        seq: line.seq,
        count: line.count,
        location: line.location,
        item: line.item,
        lot: line.lot,
        hide: line.hide,
        frozenAt: toUtcIso(line.frozenAt!),
        waitsFor: line.countedAt === null ? ('COUNT' as const) : ('RECOUNT' as const),
      })),
      words: FROZEN_WORDS,
    }
  })
}
