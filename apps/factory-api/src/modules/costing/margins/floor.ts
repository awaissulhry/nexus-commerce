import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { floorFlagOf, WATCHED_STATUSES, type FloorAlertFacts, type FloorFigures, type FloorFlag, type FloorSource } from '@nexus/factory-domain/costing/profitability/floor'
import type { FloorView } from '@nexus/factory-domain/costing/profitability/contracts'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { floorFor } from '@nexus/factory-domain/sales/price-waterfall/rules'
import type { CommandTx } from '../../../core/command'
import { floorsInForce, roleKeysOver, versionPersonOf } from '../../sales/price-waterfall/floors'
import { quoteRulesFor } from '../../sales/quotes/rules'
import type { Reader } from '../actual/store'

/**
 * Orders below the margin floor (B-W2b-416; FIN-050 low-margin alert; follow-up KA3:01 "the margins page's belowFloor
 * reads the margin floors of Sales settings"). An order is held to the floor of the person it was sold by, read now from
 * the Sales settings exactly as a quote is (B-W2b-330 sales/price-waterfall/floors): the maker of its accepted quote
 * version (else the quote's maker; an order typed by the office: the order's maker), the lowest floor of their live office
 * roles over the order's company and customer (the company's row, else the tenant's), else the company's floor (W1's
 * quote rules). The flag is judged on the final margin once the order is final, else on the margin as estimated now
 * (factory-domain costing/profitability/floor). The floor and the flag are the margin grain.
 *
 * The low-margin alert is the exception rules' kind MARGIN_BELOW_FLOOR (factory-domain alerts/kinds): `floorFindings`
 * finds, in the tenant's system scope, the watched orders below their floor; the alert clears when the order is no longer
 * below it (a better estimate, a new floor) or leaves the watched states. Its facts carry no figure.
 */

export interface OrderFloor {
  readonly pct: string
  readonly from: FloorSource
  readonly roleKey: string | null
  readonly role: string | null
  /** The accepted version was priced under its floor (a yes let it through). */
  readonly quotedBelow: boolean
}

const FLOOR_ORDER = {
  id: true,
  companyId: true,
  partyId: true,
  createdById: true,
  quoteVersion: { select: { createdById: true, marginFloorBreached: true, quote: { select: { createdById: true } } } },
} as const

/** The floor each order is held to now (every order has one: a company always has a floor). */
export async function orderFloors(db: Reader, orderIds: readonly string[], now: Date): Promise<Map<string, OrderFloor>> {
  const out = new Map<string, OrderFloor>()
  if (orderIds.length === 0) return out
  const orders = await db.salesOrder.findMany({ where: { id: { in: [...orderIds] } }, select: FLOOR_ORDER })
  const companies = new Map<string, { floors: Record<string, string> | null; companyFloor: string }>()
  for (const companyId of new Set(orders.map((order) => order.companyId))) {
    const [{ floors }, rules] = await Promise.all([floorsInForce(db, companyId), quoteRulesFor(db, companyId)])
    companies.set(companyId, { floors, companyFloor: rules.marginFloorPct })
  }
  const keysOf = new Map<string, string[]>()
  const picked = orders.map((order) => {
    const company = companies.get(order.companyId)!
    const person = order.quoteVersion ? versionPersonOf(order.quoteVersion.quote, order.quoteVersion) : order.createdById
    return { order, company, person }
  })
  for (const { order, company, person } of picked) {
    if (company.floors === null || person === null) continue
    const key = `${person}|${order.companyId}|${order.partyId}`
    if (!keysOf.has(key)) keysOf.set(key, await roleKeysOver(db, person, { companyId: order.companyId, partyId: order.partyId }, now))
  }
  const floors = picked.map(({ order, company, person }) => {
    const keys = company.floors === null || person === null ? [] : (keysOf.get(`${person}|${order.companyId}|${order.partyId}`) ?? [])
    return { order, floor: floorFor(company.floors, keys, company.companyFloor) }
  })
  const roleKeys = [...new Set(floors.map((row) => row.floor.roleKey).filter((key): key is string => key !== null))]
  const names = new Map(roleKeys.length === 0 ? [] : (await db.role.findMany({ where: { key: { in: roleKeys }, audience: 'OFFICE' }, select: { key: true, name: true } })).map((row) => [row.key, row.name]))
  for (const { order, floor } of floors) {
    out.set(order.id, { pct: floor.marginFloorPct, from: floor.source, roleKey: floor.roleKey, role: floor.roleKey === null ? null : (names.get(floor.roleKey) ?? floor.roleKey), quotedBelow: order.quoteVersion?.marginFloorBreached ?? false })
  }
  return out
}

/** An order's flag against its floor. */
export const flagOf = (figures: FloorFigures, floor: OrderFloor | undefined): FloorFlag => floorFlagOf(figures, floor?.pct ?? null)

/** The row's floor fields (the margin grain: the API drops them for a caller without it). */
export function floorFields(flag: FloorFlag, floor: OrderFloor | undefined) {
  const view: FloorView | null = floor ? { pct: floor.pct, from: floor.from, role: floor.role, basis: flag.basis, quotedBelow: floor.quotedBelow } : null
  return { belowFloor: asMoney('margin', flag.below), floor: asMoney('margin', view) }
}

/** The margins' figures of some orders, as the margins read computes them (margins.ts floorFiguresOf). */
export type FiguresOf = (db: Reader, orderIds: readonly string[], now: Date) => Promise<Map<string, FloorFigures & { readonly number: string; readonly companyId: string; readonly partyId: string; readonly status: string }>>

const LIMIT = 500

/**
 * The alert kind MARGIN_BELOW_FLOOR's finder (platform/alerts/evaluators FINDERS): the watched orders of the rule's company
 * (all its sites: an order has none) whose margin is below their floor now. `only`: a recheck's orders.
 */
export function floorFindingsWith(figuresOf: FiguresOf) {
  return async function floorFindings(tx: CommandTx, rule: RulePlace & { readonly threshold: unknown }, now: Date, only?: readonly string[]): Promise<Finding[]> {
    const orders = await tx.salesOrder.findMany({
      where: { ...(only ? { id: { in: [...only] } } : {}), ...(rule.companyId ? { companyId: rule.companyId } : {}), status: { in: [...WATCHED_STATUSES] } },
      orderBy: { id: 'asc' },
      take: LIMIT,
      select: { id: true },
    })
    const ids = orders.map((order) => order.id)
    if (ids.length === 0) return []
    const [figures, floors] = await Promise.all([figuresOf(tx, ids, now), orderFloors(tx, ids, now)])
    const findings: Finding[] = []
    for (const id of ids) {
      const row = figures.get(id)
      const floor = floors.get(id)
      if (!row || !floor) continue
      const flag = flagOf(row, floor)
      if (flag.below !== true || flag.basis === null) continue
      const facts: FloorAlertFacts = { basis: flag.basis, quotedBelow: floor.quotedBelow, status: row.status }
      findings.push({ recordType: 'SalesOrder', recordId: id, label: row.number, scope: { companyId: row.companyId, siteId: null, partyId: row.partyId }, facts: { ...facts } })
    }
    return findings
  }
}
