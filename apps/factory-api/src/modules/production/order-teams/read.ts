import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { BASKET_WORK_ORDER_STATUSES, isSmallPartsType } from '@nexus/factory-domain/production/baskets/at-print'
import { PRODUCTION_TEAMS_ASSIGN } from '@nexus/factory-domain/production/order-teams/permissions'
import { isOverLimit, orderTeamMode, teamMarks, type TeamMark } from '@nexus/factory-domain/production/order-teams/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { dateOf, dayOf, todayOf } from '../../people/employees/access'
import { faceOnly, teamFaces, type TeamFace } from '../../people/teams/faces'
import { loansOfDay } from '../../people/teams/teams'
import { mayOn, officeContextOf, type OrderScope } from '../../sales/orders/access'

/**
 * Teams own the work (owb-ss5 step 5.1; build/briefs/owb-ss5.md § Shape; design § 5za; _owb-ss-common L3, walls). Reads only.
 *
 *   GET /production/orders/:orderId/teams     the order's open team rows with each team's face and facts, the mode, the baskets
 *                                             the order makes (planned), whether it was printed, and what the caller may do
 *   GET /production/teams/board?siteId=       one column per open team of the site that takes orders, its load and marks and
 *                                             its open orders; first "No team yet": the confirmed and in-production orders
 *                                             made at the site that no team has
 *
 * Who reads: the order's teams, whoever sees the order (orders.view) or gives its work (production.teams.assign) over its company
 * and customer — the designer (orders.view.own only) and the floor do not; the board, workorders.view over the site (the Teams
 * page), and on it only the orders the caller's grants reach (company, site and customer). A team's figure (baskets in work,
 * missing today, late, an order's baskets in its column) is null for a team smaller than its company's smallest group. The customer
 * is its CODE, never its name.
 */

type Client = FactoryClient | CommandTx

/** An order no team works on any more (it left, or it ended). */
export const ORDER_DONE_STATUSES = ['SHIPPED', 'CLOSED', 'CANCELLED', 'DELIVERED'] as const
/** The orders "No team yet" lists. */
const WAITING_STATUSES = ['CONFIRMED', 'IN_PRODUCTION'] as const
const isDone = (status: string): boolean => (ORDER_DONE_STATUSES as readonly string[]).includes(status)

export interface OrderRow {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly number: string
  readonly status: string
  readonly promiseDate: Date | null
}

const ORDER_SELECT = { id: true, companyId: true, partyId: true, number: true, status: true, promiseDate: true } as const

export const readOrder = async (client: Client, orderId: string): Promise<OrderRow | null> =>
  isUuid(orderId) ? ((await client.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT })) as OrderRow | null) : null

/** The caller sees the order's teams: orders.view or production.teams.assign over its company and customer. */
export const seesOrderTeams = (context: OfficeContext, scope: OrderScope): boolean => mayOn(context, ORDERS_VIEW, scope) || mayOn(context, PRODUCTION_TEAMS_ASSIGN, scope)

/** Late: its promise day is before today and it has not left. */
const isLate = (order: Pick<OrderRow, 'status' | 'promiseDate'>, today: BusinessDate): boolean => order.promiseDate !== null && !isDone(order.status) && dayOf(order.promiseDate) < today

/** The baskets of these orders: per order its ACTIVE baskets in work (work order released or in progress) and how many it makes. */
export async function basketsOfOrders(client: Client, orderIds: readonly string[]): Promise<Map<string, { readonly inWork: readonly { readonly id: string; readonly siteId: string }[]; readonly planned: number }>> {
  const result = new Map<string, { inWork: { id: string; siteId: string }[]; planned: number }>()
  if (orderIds.length === 0) return result
  const lines = await client.salesOrderLine.findMany({ where: { orderId: { in: [...orderIds] } }, select: { id: true, orderId: true, quantity: true } })
  const sizes = lines.length === 0 ? [] : await client.workOrderSize.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) } }, select: { workOrderId: true, salesOrderLineId: true, quantity: true } })
  const workOrderIds = [...new Set(sizes.map((size) => size.workOrderId))]
  const workOrders = workOrderIds.length === 0 ? [] : await client.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, status: true, styleId: true } })
  const styleIds = [...new Set(workOrders.map((order) => order.styleId))]
  const styles = new Map(styleIds.length === 0 ? [] : (await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, productType: true } })).map((style) => [style.id, style.productType as string]))
  const live = workOrders.filter((order) => order.status !== 'CANCELLED')
  const bundles = live.length === 0 ? [] : await client.bundle.findMany({ where: { workOrderId: { in: live.map((order) => order.id) }, status: 'ACTIVE' }, select: { id: true, workOrderId: true, siteId: true } })
  const workOrderOf = new Map(workOrders.map((order) => [order.id, order]))
  const lineOrder = new Map(lines.map((line) => [line.id, line.orderId]))
  for (const orderId of orderIds) {
    const ownSizes = sizes.filter((size) => size.salesOrderLineId !== null && lineOrder.get(size.salesOrderLineId) === orderId)
    const ownWorkOrders = new Set(ownSizes.map((size) => size.workOrderId))
    const ownBundles = bundles.filter((bundle) => ownWorkOrders.has(bundle.workOrderId))
    const inWork = ownBundles.filter((bundle) => (BASKET_WORK_ORDER_STATUSES as readonly string[]).includes(workOrderOf.get(bundle.workOrderId)?.status ?? ''))
    // Made already: its baskets; else one basket a garment (a small-parts cell: one basket); else, before any work order, its pieces.
    const fromCells = ownSizes
      .filter((size) => workOrderOf.get(size.workOrderId)?.status !== 'CANCELLED')
      .reduce((sum, size) => sum + (isSmallPartsType(styles.get(workOrderOf.get(size.workOrderId)?.styleId ?? '') ?? null) ? 1 : size.quantity), 0)
    const fromLines = lines.filter((line) => line.orderId === orderId).reduce((sum, line) => sum + Number(line.quantity), 0)
    result.set(orderId, { inWork: inWork.map((bundle) => ({ id: bundle.id, siteId: bundle.siteId })), planned: ownBundles.length > 0 ? ownBundles.length : fromCells > 0 ? fromCells : fromLines })
  }
  return result
}

/** What the board and an order's rows say of a team; every figure null for a team smaller than its company's smallest group. */
export interface TeamFacts {
  readonly inWork: number | null
  readonly maxBaskets: number | null
  readonly takesNewOrders: boolean
  readonly missingToday: number | null
  readonly late: number | null
  readonly overLimit: boolean
  readonly marks: TeamMark[]
}

/** The facts of these teams (their open order rows, their people today). */
export async function teamFactsOf(client: Client, faces: ReadonlyMap<string, TeamFace & { readonly siteId: string }>, today: BusinessDate): Promise<Map<string, TeamFacts>> {
  const ids = [...faces.keys()]
  const result = new Map<string, TeamFacts>()
  if (ids.length === 0) return result
  const teams = await client.team.findMany({ where: { id: { in: ids } }, select: { id: true, maxBaskets: true, takesNewOrders: true } })
  const rows = await client.orderTeam.findMany({ where: { teamId: { in: ids }, endedAt: null }, select: { teamId: true, salesOrderId: true, bundleIds: true } })
  const orders = new Map(rows.length === 0 ? [] : (await client.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.salesOrderId))] } }, select: { id: true, status: true, promiseDate: true } })).map((order) => [order.id, order]))
  const openRows = rows.filter((row) => { const order = orders.get(row.salesOrderId); return order !== undefined && !isDone(order.status) })
  const baskets = await basketsOfOrders(client, [...new Set(openRows.map((row) => row.salesOrderId))])
  const members = await client.teamMember.findMany({ where: { teamId: { in: ids }, until: null }, select: { teamId: true, employeeId: true } })
  const memberIds = [...new Set(members.map((member) => member.employeeId))]
  const absent = new Set(memberIds.length === 0 ? [] : (await client.absenceEntry.findMany({ where: { employeeId: { in: memberIds }, date: dateOf(today) }, select: { employeeId: true } })).map((row) => row.employeeId))
  const loans = memberIds.length === 0 ? [] : await loansOfDay(client, today, { employeeId: { in: memberIds } })
  for (const team of teams) {
    const face = faces.get(team.id)!
    const shown = face.people !== null
    const own = openRows.filter((row) => row.teamId === team.id)
    const inWork = own.reduce((sum, row) => {
      const active = baskets.get(row.salesOrderId)?.inWork ?? []
      if (row.bundleIds.length > 0) return sum + active.filter((bundle) => row.bundleIds.includes(bundle.id)).length
      return sum + active.filter((bundle) => bundle.siteId === face.siteId).length
    }, 0)
    const people = members.filter((member) => member.teamId === team.id).map((member) => member.employeeId)
    const missing = people.filter((employeeId) => absent.has(employeeId) || loans.some((loan) => loan.employeeId === employeeId && loan.toTeamId !== team.id)).length
    const late = own.filter((row) => isLate(orders.get(row.salesOrderId)!, today)).length
    const facts = { inWork: shown ? inWork : null, maxBaskets: team.maxBaskets, takesNewOrders: team.takesNewOrders, missingToday: shown ? missing : null, late: shown ? late : null }
    result.set(team.id, { ...facts, overLimit: isOverLimit(facts), marks: teamMarks(facts) })
  }
  return result
}

/** The order's teams version: 1 + its rows ever written + its rows ended (every PUT that changes something moves it). */
export async function orderTeamsVersion(client: Client, orderId: string): Promise<number> {
  const [rows, ended] = await Promise.all([client.orderTeam.count({ where: { salesOrderId: orderId } }), client.orderTeam.count({ where: { salesOrderId: orderId, endedAt: { not: null } } })])
  return 1 + rows + ended
}

/** The answer of GET (and of PUT) for one order the caller sees. */
export async function orderTeamsAnswer(client: Client, context: OfficeContext, order: OrderRow, now: Date) {
  const today = todayOf(now)
  const rows = await client.orderTeam.findMany({ where: { salesOrderId: order.id, endedAt: null }, orderBy: [{ inCharge: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { teamId: true, inCharge: true, basketShare: true, givenBy: true } })
  const faces = await teamFaces(client, rows.map((row) => row.teamId))
  const facts = await teamFactsOf(client, faces, today)
  const history = rows.length === 0 ? [] : await client.orderTeam.findMany({ where: { teamId: { in: rows.map((row) => row.teamId) }, partyId: order.partyId, salesOrderId: { not: order.id } }, select: { teamId: true } })
  const printed = (await client.orderPrint.findFirst({ where: { salesOrderId: order.id, kind: 'FIRST' }, select: { id: true } })) !== null
  const planned = (await basketsOfOrders(client, [order.id])).get(order.id)?.planned ?? 0
  const scope = { companyId: order.companyId, partyId: order.partyId }
  return {
    orderId: order.id,
    version: await orderTeamsVersion(client, order.id),
    printed,
    mode: orderTeamMode(rows),
    plannedBaskets: planned,
    rows: rows.flatMap((row) => {
      const face = faces.get(row.teamId)
      const fact = facts.get(row.teamId)
      if (!face || !fact) return []
      return [
        {
          team: faceOnly(face),
          inCharge: row.inCharge,
          basketShare: row.basketShare,
          givenBy: row.givenBy as 'USER' | 'RULE',
          facts: { inWork: fact.inWork, maxBaskets: fact.maxBaskets, workedForCustomer: history.some((past) => past.teamId === row.teamId), takesNewOrders: fact.takesNewOrders, overLimit: fact.overLimit, missingToday: fact.missingToday, late: fact.late },
        },
      ]
    }),
    may: { give: mayOn(context, PRODUCTION_TEAMS_ASSIGN, scope), ask: mayOn(context, ORDERS_VIEW, scope) },
  }
}

/** GET /production/orders/:orderId/teams. */
export async function orderTeams(caller: CommandCaller, orderId: string, now: Date = new Date()) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = await readOrder(client, orderId)
    if (!order || !seesOrderTeams(context, order)) throw new NotFoundError('Sales order not found.')
    return orderTeamsAnswer(client, context, order, now)
  })
}

/** GET /production/teams/board?siteId=. */
export async function teamsBoard(caller: CommandCaller, siteId: string, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })
    if (!site || !can(actor, WORKORDERS_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const teams = await client.team.findMany({ where: { siteId, status: 'ACTIVE', takesOrders: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, takesNewOrders: true } })
    const faces = await teamFaces(client, teams.map((team) => team.id))
    const facts = await teamFactsOf(client, faces, today)
    const rows = teams.length === 0 ? [] : await client.orderTeam.findMany({ where: { teamId: { in: teams.map((team) => team.id) }, endedAt: null }, select: { teamId: true, salesOrderId: true, inCharge: true } })
    const waiting = await client.salesOrder.findMany({
      where: { companyId: site.companyId, status: { in: [...WAITING_STATUSES] }, lines: { some: { siteId } }, orderTeams: { none: { endedAt: null } } },
      orderBy: [{ promiseDate: 'asc' }, { number: 'asc' }],
      take: 500,
      select: ORDER_SELECT,
    })
    const ordersOfTeams = rows.length === 0 ? [] : await client.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.salesOrderId))] } }, select: ORDER_SELECT })
    // Only the orders the caller's grants reach (its company, the site, its customers): a customer-limited role sees its own.
    const reach = (order: OrderRow): boolean => can(actor, WORKORDERS_VIEW, { companyId: order.companyId, siteId, partyId: order.partyId })
    const shown = new Map([...waiting, ...ordersOfTeams].filter((order) => !isDone(order.status) && reach(order as OrderRow)).map((order) => [order.id, order as OrderRow]))
    const codes = new Map((await client.party.findMany({ where: { id: { in: [...new Set([...shown.values()].map((order) => order.partyId))] } }, select: { id: true, code: true } })).map((party) => [party.id, party.code]))
    const baskets = await basketsOfOrders(client, [...shown.keys()])
    const orderLine = (order: OrderRow, inCharge: boolean, teamShown: boolean) => ({
      orderId: order.id,
      number: order.number,
      customerCode: codes.get(order.partyId) ?? '',
      baskets: teamShown ? (baskets.get(order.id)?.planned ?? 0) : null,
      inCharge,
      due: order.promiseDate ? dayOf(order.promiseDate) : null,
      late: isLate(order, today),
    })
    const noTeam = {
      team: null,
      load: { inWork: null, maxBaskets: null },
      marks: [] as TeamMark[],
      orders: waiting.filter((order) => shown.has(order.id)).map((order) => orderLine(order as OrderRow, false, true)),
    }
    const columns = teams.flatMap((team) => {
      const face = faces.get(team.id)
      const fact = facts.get(team.id)
      if (!face || !fact) return []
      const teamShown = face.people !== null
      return [
        {
          team: faceOnly(face),
          load: { inWork: fact.inWork, maxBaskets: fact.maxBaskets },
          marks: fact.marks,
          orders: rows.filter((row) => row.teamId === team.id && shown.has(row.salesOrderId)).map((row) => orderLine(shown.get(row.salesOrderId)!, row.inCharge, teamShown)),
        },
      ]
    })
    return {
      columns: [noTeam, ...columns],
      teams: teams.flatMap((team) => { const face = faces.get(team.id); return face ? [{ ...faceOnly(face), takesNewOrders: team.takesNewOrders }] : [] }),
    }
  })
}
