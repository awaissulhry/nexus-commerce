import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import { OPEN_REPAIR_STAGES, REPAIR_LIMITS, REPAIR_STAGES, safetyStateOf, statusWords, WAITING_WORK_STAGES, type RepairListView, type RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf } from './access'
import { peopleOf, REPAIR_COLUMNS, safetyFactsOf } from './store'

/**
 * The repairs of the returns and repairs list, and their tiles (B-W2a-57; design sales.returns returns.tiles "Repairs in
 * progress", returns.grid "Open repairs"; SAL-390 the stage of each). Office only, within the caller's companies, sites
 * and customers (sales.repairs.view). No amount (the repair cost and the estimate are W2b).
 *
 *   GET /sales/repairs         newest first: `view` open (default) | awaiting (the garment not here yet) | received (here,
 *                              the work not started) | inRepair | toCheck (a repaired protective garment without a passed
 *                              check since the repair) | toShip (repaired and cleared to go back) | closed | all, or
 *                              `stage` (one or a comma list), `partyId`, `siteId`, `returnId` (the repairs of an RMA's
 *                              lines), `complaintId`, `owner` me | <id>, `q` (number, serial, customer code or name); at
 *                              most 200 (`truncated`).
 *   GET /sales/repairs/counts  the tiles: awaiting, received, in repair, to check, to ship, open.
 */

export interface ListQuery {
  readonly view?: RepairListView | undefined
  readonly stage?: string | undefined
  readonly partyId?: string | undefined
  readonly siteId?: string | undefined
  readonly returnId?: string | undefined
  readonly complaintId?: string | undefined
  readonly owner?: string | undefined
  readonly q?: string | undefined
}

const SCOPE = { company: 'companyId', site: 'siteId', party: 'partyId' } as const

function viewWhere(client: FactoryClient, view: RepairListView): Prisma.RepairOrderWhereInput {
  const repairedAt = client.repairOrder.fields.repairedAt
  switch (view) {
    case 'open':
      return { stage: { in: [...OPEN_REPAIR_STAGES] } }
    case 'awaiting':
      return { stage: 'AWAITING_GOODS' }
    case 'received':
      return { stage: { in: [...WAITING_WORK_STAGES] } }
    case 'inRepair':
      return { stage: 'IN_REPAIR' }
    case 'toCheck':
      return { stage: 'REPAIRED', safetyCheckRequired: true, OR: [{ safetyCheckResult: null }, { safetyCheckResult: 'FAIL' }, { safetyCheckedAt: { lt: repairedAt } }] }
    case 'toShip':
      return { stage: 'REPAIRED', OR: [{ safetyCheckRequired: false }, { safetyCheckResult: 'PASS', safetyCheckedAt: { gte: repairedAt } }] }
    case 'closed':
      return { stage: { in: ['SHIPPED', 'CANCELLED'] } }
    case 'all':
      return {}
  }
}

function whereOf(caller: CommandCaller, client: FactoryClient, query: ListQuery): Prisma.RepairOrderWhereInput {
  const context = officeOf(caller)
  const stages = query.stage ? query.stage.split(',').map((entry) => entry.trim()).filter(Boolean) : []
  const bad = stages.find((stage) => !(REPAIR_STAGES as readonly string[]).includes(stage))
  if (bad) throw new ValidationError('Not a repair stage.', [{ path: 'querystring/stage', message: `One or more of ${REPAIR_STAGES.join(', ')}.` }])
  if (query.owner && query.owner !== 'me' && !isUuid(query.owner)) throw new ValidationError('Not an owner.', [{ path: 'querystring/owner', message: "A person's id, or me." }])
  const q = (query.q ?? '').trim()
  return {
    AND: [
      scopeWhere(actorOf(context), SALES_REPAIRS_VIEW, SCOPE) as Prisma.RepairOrderWhereInput,
      stages.length > 0 ? { stage: { in: stages as RepairStage[] } } : viewWhere(client, query.view ?? 'open'),
      query.partyId ? { partyId: query.partyId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.returnId ? { returnLine: { returnId: query.returnId } } : {},
      query.complaintId ? { complaintId: query.complaintId } : {},
      query.owner ? { ownerId: query.owner === 'me' ? context.actorId : query.owner } : {},
      q
        ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { serial: { contains: q, mode: 'insensitive' } }, { party: { legalName: { contains: q, mode: 'insensitive' } } }, { party: { code: { contains: q, mode: 'insensitive' } } }] }
        : {},
    ],
  }
}

/** GET /sales/repairs */
export async function listRepairs(caller: CommandCaller, query: ListQuery) {
  return caller.withClient(async (client) => {
    const where = whereOf(caller, client, query)
    const rows = await client.repairOrder.findMany({ where, select: REPAIR_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: REPAIR_LIMITS.list + 1 })
    const shown = rows.slice(0, REPAIR_LIMITS.list)
    const unique = <T>(values: readonly (T | null)[]): T[] => [...new Set(values.filter((value): value is T => value !== null))]
    const parties = shown.length ? await client.party.findMany({ where: { id: { in: unique(shown.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true } }) : []
    const sites = shown.length ? await client.site.findMany({ where: { id: { in: unique(shown.map((row) => row.siteId)) } }, select: { id: true, code: true } }) : []
    const styleIds = unique(shown.map((row) => row.styleId))
    const styles = styleIds.length ? await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
    const lineIds = unique(shown.map((row) => row.returnLineId))
    const lines = lineIds.length ? await client.returnLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, rma: { select: { number: true } } } }) : []
    const complaintIds = unique(shown.map((row) => row.complaintId))
    const complaints = complaintIds.length ? await client.complaint.findMany({ where: { id: { in: complaintIds } }, select: { id: true, number: true } }) : []
    const workOrderIds = unique(shown.map((row) => row.workOrderId))
    const workOrders = workOrderIds.length ? await client.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true } }) : []
    const by = <T extends { id: string }>(list: readonly T[]) => new Map(list.map((row) => [row.id, row]))
    const [partyOf, siteOf, styleOf, lineOf, complaintOf, workOrderOf] = [by(parties), by(sites), by(styles), by(lines), by(complaints), by(workOrders)]
    return {
      repairs: shown.map((row) => {
        const safety = safetyFactsOf(row)
        return {
          id: row.id,
          number: row.number,
          kind: row.kind,
          stage: row.stage,
          status: statusWords({ stage: row.stage as RepairStage, ...safety }),
          companyId: row.companyId,
          siteId: row.siteId,
          siteCode: siteOf.get(row.siteId)?.code ?? '',
          party: partyOf.get(row.partyId)!,
          serial: row.serial,
          style: row.styleId ? (styleOf.get(row.styleId) ?? null) : null,
          size: row.size,
          problem: row.problem,
          source: row.returnLineId ? ('RETURN' as const) : row.complaintId ? ('COMPLAINT' as const) : ('HAND' as const),
          returnNumber: row.returnLineId ? (lineOf.get(row.returnLineId)?.rma.number ?? null) : null,
          complaintNumber: row.complaintId ? (complaintOf.get(row.complaintId)?.number ?? null) : null,
          receivedAt: row.receivedAt ? toUtcIso(row.receivedAt) : null,
          repairedAt: row.repairedAt ? toUtcIso(row.repairedAt) : null,
          shippedAt: row.shippedAt ? toUtcIso(row.shippedAt) : null,
          safety: safetyStateOf(safety),
          workOrder: row.workOrderId ? (workOrderOf.get(row.workOrderId) ?? null) : null,
          ownerId: row.ownerId,
          createdAt: toUtcIso(row.createdAt),
        }
      }),
      truncated: rows.length > REPAIR_LIMITS.list,
      people: await peopleOf(client, shown.map((row) => row.ownerId)),
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

/** GET /sales/repairs/counts */
export async function repairCounts(caller: CommandCaller) {
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actorOf(officeOf(caller)), SALES_REPAIRS_VIEW, SCOPE) as Prisma.RepairOrderWhereInput
    const count = async (view: RepairListView) => client.repairOrder.count({ where: { AND: [scope, viewWhere(client, view)] } })
    return {
      counts: { awaiting: await count('awaiting'), received: await count('received'), inRepair: await count('inRepair'), toCheck: await count('toCheck'), toShip: await count('toShip'), open: await count('open') },
      asOf: toUtcIso(serverClock.now()),
    }
  })
}
