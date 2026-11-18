import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { effectiveHealth, type BrandHealth, type HealthRaise, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import type { BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'
import type { WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { brandProductionKey, orderSupervisorMarksOf } from '../../production/supervisor/resolver'
import { dayOf, type Reader } from './store'

/**
 * B-SA-070 (sales page plan N5, picks R5, P10, P17; 13-backend B2; 11-customer-page §3.5 "Where it is", "Waiting on", "Supervisor"):
 * the production part of a Sales › Orders row, asked with `production=true` (the customer's Work tab shows these columns; Sales ›
 * Orders offers them in Customise). Read for one page of rows from the keeper's STORED state — never the facts of each order:
 *
 *   stage, stageSince   the plain stage the customer reads too (BrandOrderProduction.stage, since its day); null: no row yet
 *   health              the shown one: the keeper's computed health, raised to At risk while a factory raise stands (the same rule
 *                       as the order page's headline, factory-domain production-brand/health effectiveHealth); null: none
 *   waitingOn, since    who acts next as the keeper keeps it (the customer, a supplier, a workshop, us) and since when
 *   held                a live work order (not a repair, not cancelled) that makes a line of the order is ON_HOLD (a boolean:
 *                       never which work order, nor whose)
 *   supervisorMark      Me / Someone else / Not set (never a name on a list, worker privacy): only with workorders.view over the
 *                       order (13-review C-19: the work orders list's own rule), else null and named in `withheld`
 *   openRequests        the customer's requests still OPEN on the order (waiting on us)
 *   openIssues          the production issues still OPEN on the order (office only: workorders.view, else null + `withheld`)
 *
 * Queries per page: the stored rows, the held cells, the requests, and — only for a reader with workorders.view over some row — the
 * issues and the supervisor marks (two reads). Every row is an order the reader's orders.view already reaches (the list's scopeWhere):
 * nothing of another customer is read into it. Pieces stay `progress=true` (./later-columns).
 *
 * The term `waiting=us` (`waitingUsWhere`) keeps the orders the keeper says wait on us, or with a customer request still OPEN: the
 * customer's Work tab's view "Waiting on us". The term `ids=` (≤ 50, comma separated) re-reads only the rows in view (a live re-read).
 */

/** The parts of the production columns a reader without workorders.view over the order does not get (null, named here). */
export const PRODUCTION_WITHHELD = ['supervisorMark', 'openIssues'] as const
export type ProductionWithheld = (typeof PRODUCTION_WITHHELD)[number]

export interface ProductionColumns {
  readonly stage: BrandStage | null
  readonly stageSince: BusinessDate | null
  readonly health: BrandHealth | null
  readonly waitingOn: WaitingOn | null
  readonly since: string | null
  readonly held: boolean
  readonly supervisorMark: SupervisorMark | null
  readonly openRequests: number
  readonly openIssues: number | null
  readonly withheld: ProductionWithheld[]
}

export interface ProductionOrder {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
}

/** The stored health columns of an order's production row. */
export interface StoredHealth {
  readonly health: string | null
  readonly healthSet: string | null
  readonly healthReasonCode: string | null
  readonly healthSetUntil: Date | null
}

/**
 * A factory raise that still stands today (its reason, the first day it no longer stands), or null — read the same way by the
 * order page's headline (./production-read) and the list.
 */
export function standingRaiseOf(row: StoredHealth, today: BusinessDate): HealthRaise | null {
  const until = row.healthSetUntil ? dayOf(row.healthSetUntil) : null
  return row.healthSet !== null && row.healthReasonCode !== null && until !== null && today < until ? { reasonCode: row.healthReasonCode as HealthReasonCode, until } : null
}

/** The health an office person reads of an order (computed, raised to At risk while a raise stands); null: none. */
export function shownHealthOf(row: StoredHealth, today: BusinessDate): BrandHealth | null {
  return effectiveHealth(row.health as BrandHealth | null, standingRaiseOf(row, today)).health
}

/** `waiting=us`: the keeper says the order waits on us, or a customer request on it is still OPEN. */
export const waitingUsWhere: Prisma.SalesOrderWhereInput = { OR: [{ brandProductions: { some: { waitingOn: 'US' } } }, { changeRequests: { some: { status: 'OPEN' } } }] }

/** The most rows `ids=` re-reads at once. */
export const IDS_TERM_MAX = 50

/** The order ids of the `ids=` term (each once), or a 400 in words. */
export function idsTermOf(text: string): string[] {
  const ids = [...new Set(text.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
  if (ids.length === 0 || ids.length > IDS_TERM_MAX || ids.some((value) => !isUuid(value))) {
    throw new ValidationError(`Name 1 to ${IDS_TERM_MAX} orders by id, comma separated.`, [{ path: 'query/ids', message: `1 to ${IDS_TERM_MAX} order ids, comma separated.` }])
  }
  return ids
}

/** The production columns of each order of the page, by order id. */
export async function orderProductionColumns(client: Reader, actor: Actor, viewerId: string, orders: readonly ProductionOrder[], today: BusinessDate): Promise<Map<string, ProductionColumns>> {
  const out = new Map<string, ProductionColumns>()
  if (orders.length === 0) return out
  const ids = orders.map((order) => order.id)
  const rows = await client.brandOrderProduction.findMany({
    where: { salesOrderId: { in: ids } },
    select: { salesOrderId: true, key: true, stage: true, stageAt: true, health: true, healthSet: true, healthReasonCode: true, healthSetUntil: true, waitingOn: true, waitingSince: true },
  })
  // One row per order (`brand-production:<salesOrderId>`); a copy of the isolation tests (a `-…` suffix) never counts.
  const rowOf = new Map(rows.filter((row) => row.key === brandProductionKey(row.salesOrderId)).map((row) => [row.salesOrderId, row]))
  const heldCells = await client.workOrderSize.findMany({
    where: { salesOrderLine: { orderId: { in: ids } }, workOrder: { kind: { not: 'REPAIR' }, status: 'ON_HOLD' } },
    select: { salesOrderLine: { select: { orderId: true } } },
  })
  const held = new Set(heldCells.flatMap((cell) => (cell.salesOrderLine ? [cell.salesOrderLine.orderId] : [])))
  const requests = await client.orderChangeRequest.groupBy({ by: ['orderId'], where: { orderId: { in: ids }, status: 'OPEN' }, _count: { _all: true } })
  const requestsOf = new Map(requests.map((row) => [row.orderId, row._count._all]))
  // The office-only parts: only over the orders the reader's workorders.view reaches.
  const seen = orders.filter((order) => can(actor, WORKORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId }))
  const seenIds = new Set(seen.map((order) => order.id))
  const issues = seen.length > 0 ? await client.productionIssue.groupBy({ by: ['salesOrderId'], where: { salesOrderId: { in: [...seenIds] }, status: 'OPEN' }, _count: { _all: true } }) : []
  const issuesOf = new Map(issues.flatMap((row) => (row.salesOrderId ? [[row.salesOrderId, row._count._all] as const] : [])))
  const marks = seen.length > 0 ? await orderSupervisorMarksOf(client, seen, viewerId) : new Map<string, SupervisorMark>()
  for (const order of orders) {
    const row = rowOf.get(order.id)
    const sees = seenIds.has(order.id)
    out.set(order.id, {
      stage: row ? (row.stage as BrandStage) : null,
      stageSince: row ? businessDate(row.stageAt) : null,
      health: row ? shownHealthOf(row, today) : null,
      waitingOn: (row?.waitingOn as WaitingOn | null | undefined) ?? null,
      since: row?.waitingSince ? toUtcIso(row.waitingSince) : null,
      held: held.has(order.id),
      supervisorMark: sees ? (marks.get(order.id) ?? 'NOT_SET') : null,
      openRequests: requestsOf.get(order.id) ?? 0,
      openIssues: sees ? (issuesOf.get(order.id) ?? 0) : null,
      withheld: sees ? [] : [...PRODUCTION_WITHHELD],
    })
  }
  return out
}
