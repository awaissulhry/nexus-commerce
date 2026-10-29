import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { lotView } from './read'
import { LOT_SELECT, officeOf } from './store'

/**
 * The lots list (design warehouse.lots "Lots & traceability", lt-grid; Owner answer Q3 (a): goods on hold are reached
 * from here before the Holds page of W2a; B-W1-45): newest received first, within the caller's companies and sites
 * (quality.lots.view), each lot as its record shows it. `onHold` keeps the lots in QUARANTINE or BLOCKED (not usable:
 * the release step refuses garments made from them).
 */

export interface LotQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly status?: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | undefined
  readonly onHold?: boolean | undefined
  readonly q?: string | undefined
  readonly limit: number
}

export async function listLots(caller: CommandCaller, query: LotQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LotWhereInput
  const filter: Prisma.LotWhereInput = {
    ...(query.companyId ? { companyId: query.companyId } : {}),
    ...(query.siteId ? { siteId: query.siteId } : {}),
    ...(query.status ? { qualityStatus: query.status } : {}),
    ...(query.onHold ? { qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } } : {}),
    ...(query.q?.trim() ? { code: { contains: query.q.trim(), mode: 'insensitive' } } : {}),
  }
  return caller.withClient(async (client) => {
    const rows = await client.lot.findMany({ where: { AND: [scope, filter] }, select: LOT_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit })
    const lots = []
    for (const row of rows) lots.push(await lotView(client, row))
    return { lots }
  })
}
