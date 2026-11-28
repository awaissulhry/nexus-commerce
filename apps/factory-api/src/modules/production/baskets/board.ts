import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, holds, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { boardColumns } from '@nexus/factory-domain/production/baskets/board'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { workerGatesFor } from '../../people/privacy/worker-gate'
import { smallAddresses } from '../../product/images/small-pictures'
import { floorOrderPicture } from '../../sales/orders/floor-picture'
import { systemView } from '../scans/access'
import { workerNames, type Reader } from '../scans/store'
import { scanSubjectFor } from '../settings/subject'
import { workOrderWhere } from '../work-orders/scope'
import { basketFacts, ofSalesOrder, ofTeamOrders, type BasketFact } from './board-store'
import { leaderTeam } from './team'

/**
 * The Baskets board (owb- order workflow, S5 fl4 step 2; `_owb-fl-common.md` § 3 "fl4"; design § 2 "Boards: a column for each
 * department in use", P/ui.js boardHTML + basketCard, P/floor.js floorBoard; the office page Production › Baskets board and the
 * leader's phone tab "Board"):
 *
 *   GET /production/baskets/board?scope=team|floor&teamId&departmentId&salesOrderId
 *
 * Who: the office with workorders.view (the base's page row), every basket of a customer it reaches (the brand wall: a person
 * limited to customer A never sees B's basket at all, `workOrderWhere`); the floor with floor.lead at its own site (a worker has
 * no Board tab): scope `team` (default) = the leader's team's baskets, `floor` = every basket of the site. One column per
 * department in use (factory-domain production/baskets/board boardColumns) + Ready to ship. Card: the customer's CODE (the
 * floor) or also its name (the office, for a customer it reaches), the team, the worker only where the site allows names (the
 * office: the PERFORMANCE worker gate; the floor: scanSubject WORKER), "k of n" steps, the late warning, Do this first, an open
 * problem. S2's order Production tab reads this with `salesOrderId` — keep the answer stable.
 */

export const FLOOR_LEAD = 'floor.lead' as Permission

type BoardContext = OfficeContext | FloorContext

function boardContextOf(caller: Pick<CommandCaller, 'factoryContext'>): BoardContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The right the reader reads baskets with: the office's work orders, the floor's team leader; else a 403 in words. */
function boardRight(context: BoardContext): Permission {
  const actor = actorOf(context)
  if (context.audience === 'floor') {
    if (holds(actor, FLOOR_LEAD)) return FLOOR_LEAD
    throw new ForbiddenError('The Baskets board is the team leader’s: ask your team leader.')
  }
  if (holds(actor, WORKORDERS_VIEW)) return WORKORDERS_VIEW
  throw new ForbiddenError('The Baskets board needs the right to see the work orders.')
}

export interface PictureRef {
  readonly fileId: string
  readonly src: string | null
}

/**
 * The orders' pictures as the reader may see them: the floor only a picture shared with its site's floor (the base's
 * floorOrderPicture); the office the order's chosen picture when available. The small preview's address, one per file.
 */
export async function orderPictures(caller: CommandCaller, db: Reader, orders: readonly { readonly salesOrderId: string; readonly siteId: string }[], audience: 'office' | 'floor'): Promise<Map<string, PictureRef>> {
  const fileOf = new Map<string, string>()
  for (const order of new Map(orders.map((entry) => [entry.salesOrderId, entry])).values()) {
    if (audience === 'floor') {
      const picture = await floorOrderPicture(db, order)
      if (picture) fileOf.set(order.salesOrderId, picture.fileId)
    } else {
      const row = await db.salesOrder.findUnique({ where: { id: order.salesOrderId }, select: { pictureFileId: true } })
      if (row?.pictureFileId) fileOf.set(order.salesOrderId, row.pictureFileId)
    }
  }
  const ids = [...new Set(fileOf.values())]
  const files = ids.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } })
  const addresses = await smallAddresses(systemView(caller), files)
  const available = new Set(files.map((file) => file.id))
  const out = new Map<string, PictureRef>()
  for (const [salesOrderId, fileId] of fileOf) if (available.has(fileId)) out.set(salesOrderId, { fileId, src: addresses.get(fileId)?.url ?? null })
  return out
}

/** Who may be named on a card, by site: the office per the worker gate, the floor per its scanSubject. */
async function namerOf(db: Reader, context: BoardContext, facts: readonly BasketFact[]): Promise<(fact: BasketFact) => string | null> {
  const workerIds = facts.map((fact) => fact.workerId)
  if (context.audience === 'floor') {
    if ((await scanSubjectFor(db, context.siteId)) !== 'WORKER') return () => null
    const names = await workerNames(db, workerIds)
    return (fact) => (fact.workerId ? (names.get(fact.workerId) ?? null) : null)
  }
  const gates = await workerGatesFor(db, facts.map((fact) => fact.siteId))
  const open = facts.filter((fact) => gates.at(fact.siteId).open)
  const names = await workerNames(db, open.map((fact) => fact.workerId))
  return (fact) => gates.at(fact.siteId).name(fact.workerId, names)
}

/** One basket as a row (the team home) and as a card (the board). */
export function rowOf(fact: BasketFact, pictures: ReadonlyMap<string, PictureRef>) {
  return {
    bundleId: fact.bundleId,
    code: fact.code,
    picture: fact.salesOrderId ? (pictures.get(fact.salesOrderId) ?? null) : null,
    customerCode: fact.customerCode,
    step: { operationId: fact.operationId, department: fact.department ? { id: fact.department.id, number: fact.department.number, name: fact.department.name, shortName: fact.department.shortName, tone: fact.department.tone, icon: fact.department.icon, nameI18n: fact.department.nameI18n } : null },
    state: fact.state,
    flags: { first: fact.first, late: fact.late !== null, problem: fact.problem },
    salesOrderId: fact.salesOrderId,
  }
}

/** The reader's Bundle scope: the office within the brand wall; the floor at its own site. */
function readerScope(context: BoardContext, right: Permission, actor: Actor): Prisma.BundleWhereInput {
  return context.audience === 'floor' ? { siteId: context.siteId } : { workOrder: { is: workOrderWhere(actor, right) } }
}

export interface BoardQuery {
  readonly scope?: 'team' | 'floor' | undefined
  readonly teamId?: string | undefined
  readonly departmentId?: string | undefined
  readonly salesOrderId?: string | undefined
}

/** GET /production/baskets/board. */
export async function basketsBoard(caller: CommandCaller, query: BoardQuery) {
  const context = boardContextOf(caller)
  const right = boardRight(context)
  const actor = actorOf(context)
  const now = serverClock.now()
  return systemView(caller).withClient(async (db) => {
    const filters: Prisma.BundleWhereInput[] = [readerScope(context, right, actor)]
    if (query.salesOrderId) filters.push(ofSalesOrder(query.salesOrderId))
    const scope = query.scope ?? (context.audience === 'floor' ? 'team' : 'floor')
    if (query.teamId || scope === 'team') {
      const team = query.teamId
        ? await db.team.findUnique({ where: { id: query.teamId }, select: { id: true, siteId: true, companyId: true } })
        : context.audience === 'floor'
          ? await leaderTeam(db, context, now)
          : null
      if (query.teamId && (!team || (context.audience === 'floor' && team.siteId !== context.siteId) || !can(actor, right, { companyId: team.companyId, siteId: team.siteId }))) throw new NotFoundError('Team not found.')
      const rows = team ? await db.orderTeam.findMany({ where: { teamId: team.id, endedAt: null }, select: { salesOrderId: true, bundleIds: true } }) : []
      filters.push(ofTeamOrders(rows))
    }
    const { facts: all, departments, more } = await basketFacts(db, { AND: filters }, now)
    const facts = query.departmentId ? all.filter((fact) => fact.department?.id === query.departmentId) : all
    const pictures = await orderPictures(caller, db, facts.flatMap((fact) => (fact.salesOrderId ? [{ salesOrderId: fact.salesOrderId, siteId: fact.siteId }] : [])), context.audience)
    const nameOf = await namerOf(db, context, facts)
    // The customer's name: the office only, and only for the customers it reaches (the scope above already left the others out).
    const partyIds = context.audience === 'office' ? [...new Set(facts.flatMap((fact) => (fact.partyId ? [fact.partyId] : [])))] : []
    const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, legalName: true, tradeName: true } })).map((party) => [party.id, party.tradeName ?? party.legalName]))
    const cards = facts.map((fact) => {
      const name = nameOf(fact)
      return {
        ...rowOf(fact, pictures),
        customer: { code: fact.customerCode, name: fact.partyId ? (parties.get(fact.partyId) ?? null) : null },
        team: fact.team,
        worker: name ? { name } : null,
        progress: fact.progress,
        late: fact.late ? { days: fact.late.days, reason: fact.late.reason, state: fact.late.state } : null,
        departmentId: fact.department?.id ?? null,
        ready: fact.ready,
        routeDepartmentIds: fact.routeDepartmentIds,
      }
    })
    // The board's sorting fields (departmentId, ready, routeDepartmentIds) stay out of the answer: output() strips them.
    const board = boardColumns(departments, cards)
    // The office's "Give it to": names only where the one site of the answer names workers and its gate lets names through.
    const sites = [...new Set(facts.map((fact) => fact.siteId))]
    let people: { workerId: string; name: string }[] | null = null
    if (context.audience === 'office' && sites.length === 1 && (await scanSubjectFor(db, sites[0]!)) === 'WORKER' && (await workerGatesFor(db, sites)).at(sites[0]!).open) {
      people = (await db.worker.findMany({ where: { siteId: sites[0]!, status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, displayName: true } })).map((worker) => ({ workerId: worker.id, name: worker.displayName }))
    }
    return {
      columns: board.columns.map((column) => ({ department: { id: column.department.id, number: column.department.number, name: column.department.name, shortName: column.department.shortName, tone: column.department.tone, icon: column.department.icon, nameI18n: column.department.nameI18n }, baskets: column.baskets })),
      readyToShip: board.readyToShip,
      elsewhere: board.elsewhere,
      more,
      people,
      asOf: toUtcIso(now),
    }
  })
}
