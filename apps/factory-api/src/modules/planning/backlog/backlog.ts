import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_BACKLOG_MANAGE } from '@nexus/factory-domain/planning/backlog/permissions'
import { rankedBacklog, rankProblems, ruleCompare, RULE_WORDS, whyWords, type BacklogOrder, type PriorityLevel, type RankItem } from '@nexus/factory-domain/planning/backlog/rank'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { currentPromiseOf, dayWords } from '@nexus/factory-domain/planning/promise/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../access'
import { ORDER_DEMAND_STATUSES, readPromiseRows } from '../promise/store'
import { dayOf, type Reader } from '../store'

/**
 * The backlog ranked (B-W2b-317; PLN-177 "Backlog ranking drives allocation"; factory-domain planning/backlog/rank for the
 * order): a company's open sales orders (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED: what must still be made and
 * shipped) in the order planning serves them — ranked by hand first (SalesOrder.backlogRank), then by the rule (priority,
 * promise, customer). Read with planning.view over the company (each order also with orders.view over its customer);
 * ranked with planning.backlog.manage over the company.
 *
 *   GET  /planning/backlog                  the ranked backlog, each order with its place, its place by the rule, why
 *   PUT  /planning/backlog/ranks            ranks by hand (or none: back to the rule), each with the rank the planner saw
 *   POST /planning/backlog/rank-by-rule     the rule's order written as the ranks 1..n (a preview first)
 *
 * Every ranking is ONE command under the company's backlog lock; each order's row is locked and its rank compared with the
 * one the planner saw (409 in words when someone ranked it since). The rank is planning's field: writing it does not move
 * the order's version (sales keeps working on the order meanwhile). Allocation reads the ranked backlog (`backlogPositions`:
 * B-W2b-318's scarce material by the backlog's priority, PLN-088; the promise list asks the promise engine in this order).
 */

export const BACKLOG_STATUSES = ORDER_DEMAND_STATUSES

/** The most orders one read lists. */
export const BACKLOG_LIMIT = 500

const ORDER_SELECT = {
  id: true,
  number: true,
  status: true,
  companyId: true,
  partyId: true,
  orderDate: true,
  promiseDate: true,
  priorityLevel: true,
  priority: true,
  backlogRank: true,
  party: { select: { id: true, code: true, legalName: true, tradeName: true } },
  lines: { where: { kind: { not: 'FEE' }, closedShortAt: null }, select: { id: true, siteId: true, promiseDate: true, quantity: true, sizes: { select: { size: true } } } },
} as const satisfies Prisma.SalesOrderSelect

type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_SELECT }>

export interface BacklogEntry extends BacklogOrder {
  readonly status: string
  readonly companyId: string
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly lines: number
  readonly pieces: number
  readonly siteIds: readonly (string | null)[]
}

/** The order's promise for the rule: the earliest current promise of its open lines (each line's latest size), else the order's. */
function promiseOf(order: OrderRow, rows: ReadonlyMap<string, Parameters<typeof currentPromiseOf>[1]>): BusinessDate | null {
  let earliest: BusinessDate | null = null
  for (const line of order.lines) {
    const typed = line.promiseDate ? dayOf(line.promiseDate) : order.promiseDate ? dayOf(order.promiseDate) : null
    const own = rows.get(line.id) ?? []
    const sizes = line.sizes.length > 0 ? line.sizes.map((entry) => entry.size) : [null]
    let latest: BusinessDate | null = null
    for (const size of sizes) {
      const current = currentPromiseOf(size, own, typed)
      if (current && (latest === null || current.date > latest)) latest = current.date
    }
    if (latest !== null && (earliest === null || latest < earliest)) earliest = latest
  }
  return earliest ?? (order.promiseDate ? dayOf(order.promiseDate) : null)
}

/** The company's open orders the reader sees, ranked (`context` null: every order, the system's read for allocation). */
export async function backlogOf(db: Reader, companyId: string, context: OfficeContext | null, options: { readonly siteId?: string | undefined } = {}): Promise<(BacklogEntry & { position: number; rulePosition: number })[]> {
  const where: Prisma.SalesOrderWhereInput = {
    AND: [
      { companyId, status: { in: [...BACKLOG_STATUSES] } },
      ...(context ? [scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput] : []),
      ...(options.siteId ? [{ lines: { some: { OR: [{ siteId: options.siteId }, { siteId: null }] } } }] : []),
    ],
  }
  const orders = await db.salesOrder.findMany({ where, select: ORDER_SELECT, orderBy: [{ number: 'asc' }, { id: 'asc' }], take: BACKLOG_LIMIT })
  const rows = await readPromiseRows(
    db,
    orders.flatMap((order) => order.lines.map((line) => line.id)),
  )
  return rankedBacklog(
    orders.map(
      (order): BacklogEntry => ({
        id: order.id,
        number: order.number,
        rank: order.backlogRank,
        priorityLevel: order.priorityLevel as PriorityLevel,
        priority: order.priority,
        promise: promiseOf(order, rows),
        customerCode: order.party.code,
        orderDate: dayOf(order.orderDate),
        status: order.status,
        companyId: order.companyId,
        customer: { id: order.party.id, code: order.party.code, name: order.party.tradeName ?? order.party.legalName },
        lines: order.lines.length,
        pieces: order.lines.reduce((sum, line) => sum + line.quantity, 0),
        siteIds: [...new Set(order.lines.map((line) => line.siteId))],
      }),
    ),
  )
}

/** The orders' places in the company's ranked backlog (1 first): what allocation reads. */
export async function backlogPositions(db: Reader, companyId: string): Promise<Map<string, number>> {
  return new Map((await backlogOf(db, companyId, null)).map((entry) => [entry.id, entry.position]))
}

async function companyFor(caller: CommandCaller, db: Reader, companyId: string, permission: Permission) {
  const context = officeContextOf(caller)
  const row = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } }) : null
  if (!row || !can(actorOf(context), PLANNING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (permission !== PLANNING_VIEW && !can(actorOf(context), permission, { companyId })) throw new ForbiddenError()
  return { context, company: { id: row.id, code: row.code, name: row.tradeName ?? row.legalName } }
}

function viewOf(company: { id: string; code: string; name: string }, entries: Awaited<ReturnType<typeof backlogOf>>, context: OfficeContext, now: Date, q?: string) {
  const today = businessDate(now)
  const words = (date: BusinessDate) => dayWords(date, today)
  const needle = q?.trim().toLowerCase() ?? ''
  const shown = needle ? entries.filter((entry) => entry.number.toLowerCase().includes(needle) || entry.customer.code.toLowerCase().includes(needle) || entry.customer.name.toLowerCase().includes(needle)) : entries
  return {
    company,
    today,
    asOf: toUtcIso(now),
    rule: RULE_WORDS,
    counts: { open: entries.length, ranked: entries.filter((entry) => entry.rank !== null).length },
    complete: entries.length < BACKLOG_LIMIT,
    may: { rank: can(actorOf(context), PLANNING_BACKLOG_MANAGE, { companyId: company.id }) },
    orders: shown.map((entry) => ({
      id: entry.id,
      number: entry.number,
      status: entry.status,
      customer: entry.customer,
      priorityLevel: entry.priorityLevel,
      priority: entry.priority,
      rank: entry.rank,
      position: entry.position,
      rulePosition: entry.rulePosition,
      promise: entry.promise,
      orderDate: entry.orderDate,
      lines: entry.lines,
      pieces: entry.pieces,
      why: whyWords(entry, words),
    })),
  }
}

/** GET /planning/backlog */
export async function readBacklog(caller: CommandCaller, query: { readonly companyId: string; readonly siteId?: string | undefined; readonly q?: string | undefined }) {
  return caller.withClient(async (db) => {
    const { context, company } = await companyFor(caller, db, query.companyId, PLANNING_VIEW)
    if (query.siteId) {
      const site = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: { companyId: true } }) : null
      if (!site || site.companyId !== company.id) throw new ValidationError('The site is not a site of the company.', [{ path: 'querystring/siteId', message: 'Name a site of the company.' }])
    }
    return viewOf(company, await backlogOf(db, company.id, context, { siteId: query.siteId }), context, serverClock.now(), query.q)
  })
}

const lockBacklog = (tx: CommandTx, tenantId: string, companyId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.backlog', ${tenantId}::uuid, ${companyId}::uuid), 0))`

export interface RanksBody {
  readonly companyId: string
  readonly ranks: readonly RankItem[]
}

/** PUT /planning/backlog/ranks — ranks by hand, or back to the rule. */
export async function setRanks(caller: CommandCaller, body: RanksBody, idempotencyKey?: string) {
  const problems = rankProblems(body.ranks)
  if (problems.length > 0) throw new ValidationError('The ranking cannot be saved like this.', problems)
  const { context, company } = await caller.withClient((db) => companyFor(caller, db, body.companyId, PLANNING_BACKLOG_MANAGE))
  const outcome = await command(caller, { name: 'planning.backlog.rank', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockBacklog(tx, context.tenantId, company.id)
    const issues: { path: string; message: string }[] = []
    const changed: string[] = []
    for (const [index, item] of body.ranks.entries()) {
      const rows = isUuid(item.orderId) ? await tx.$queryRaw<{ id: string; companyId: string; partyId: string; status: string; backlogRank: number | null; number: string }[]>`SELECT id, "companyId", "partyId", status::text AS status, "backlogRank", number FROM "SalesOrder" WHERE id = ${item.orderId}::uuid FOR UPDATE` : []
      const order = rows[0]
      if (!order || order.companyId !== company.id || !can(actorOf(context), ORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })) {
        issues.push({ path: `body/ranks/${index}/orderId`, message: 'Not an order of this company.' })
        continue
      }
      if (!(BACKLOG_STATUSES as readonly string[]).includes(order.status)) {
        issues.push({ path: `body/ranks/${index}/orderId`, message: `${order.number} is ${order.status}: it is not in the backlog.` })
        continue
      }
      if (order.backlogRank !== item.from) {
        issues.push({ path: `body/ranks/${index}/from`, message: `${order.number} was ranked ${order.backlogRank ?? 'by the rule'} since you read the backlog: read it again.` })
        continue
      }
      if (order.backlogRank === item.to) continue
      await tx.salesOrder.update({ where: { id: order.id }, data: { backlogRank: item.to }, select: { id: true } })
      tools.audit({ action: 'planning.backlog.rank', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { backlogRank: order.backlogRank }, after: { backlogRank: item.to } })
      changed.push(order.id)
    }
    if (issues.length > 0) throw new DomainError('conflict', issues[0]!.message, issues)
    if (changed.length === 0) throw new ConflictError('Nothing to change: every order named has that rank already.')
    tools.emit({ type: 'backlog.ranked', subject: company.id, companyId: company.id, payload: { companyId: company.id, mode: 'BY_HAND', orderIds: changed } })
    return { changed: changed.length }
  })
  const view = await caller.withClient(async (db) => viewOf(company, await backlogOf(db, company.id, context), context, serverClock.now()))
  return { changed: outcome.result.changed, replayed: outcome.replayed, backlog: view }
}

/** POST /planning/backlog/rank-by-rule — the rule's order as the ranks 1..n (preview, or apply). */
export async function rankByRule(caller: CommandCaller, body: { readonly companyId: string; readonly apply: boolean }, idempotencyKey?: string) {
  const { context, company } = await caller.withClient((db) => companyFor(caller, db, body.companyId, body.apply ? PLANNING_BACKLOG_MANAGE : PLANNING_VIEW))
  const preview = async (db: Reader) => {
    const entries = await backlogOf(db, company.id, context)
    const byRule = [...entries].sort(ruleCompare)
    return byRule.map((entry, index) => ({ id: entry.id, number: entry.number, from: entry.rank, to: index + 1 }))
  }
  if (!body.apply) {
    const ranks = await caller.withClient(preview)
    return { applied: false, changed: ranks.filter((entry) => entry.from !== entry.to).length, ranks, replayed: false, backlog: null }
  }
  const outcome = await command(caller, { name: 'planning.backlog.rankByRule', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockBacklog(tx, context.tenantId, company.id)
    const ranks = await preview(tx)
    const changed: string[] = []
    for (const entry of ranks) {
      if (entry.from === entry.to) continue
      await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${entry.id}::uuid FOR UPDATE`
      await tx.salesOrder.update({ where: { id: entry.id }, data: { backlogRank: entry.to }, select: { id: true } })
      tools.audit({ action: 'planning.backlog.rank', recordType: 'SalesOrder', recordId: entry.id, companyId: company.id, before: { backlogRank: entry.from }, after: { backlogRank: entry.to, byRule: true } })
      changed.push(entry.id)
    }
    if (changed.length === 0) throw new ConflictError('Nothing to change: the backlog is ranked by the rule already.')
    tools.emit({ type: 'backlog.ranked', subject: company.id, companyId: company.id, payload: { companyId: company.id, mode: 'BY_RULE', orderIds: changed.slice(0, 500) } })
    return { changed: changed.length, ranks }
  })
  const view = await caller.withClient(async (db) => viewOf(company, await backlogOf(db, company.id, context), context, serverClock.now()))
  return { applied: true, changed: outcome.result.changed, ranks: outcome.result.ranks, replayed: outcome.replayed, backlog: view }
}
