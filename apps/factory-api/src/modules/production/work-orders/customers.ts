import { z } from 'zod'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { can, reachesEveryParty, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_BUNDLES_VIEW } from '@nexus/factory-domain/production/bundles/permissions'
import { PRODUCTION_CALLS_VIEW } from '@nexus/factory-domain/production/calls/permissions'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import { PRODUCTION_INSTRUCTIONS_VIEW } from '@nexus/factory-domain/production/instructions/permissions'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from './access'
import { workOrderWhere } from './scope'
import type { Reader } from './store'

/**
 * F-PR-02 (production plan §2 and §5, 06-tree A.0: "One customer filter, carried between Overview, Floor now and every
 * production list. Its options are the customers in the person's scope only"; Owner rule 2026-11-16: "One brand must not be
 * able to see anything related to any other brand. But we, as the production unit, should be able to see it all."):
 *
 *   - `GET /production/customers?view=<page>`: the customers a production page may be narrowed to — those of the work orders
 *     the reader reaches with that page's own permission (the B-PR-03 wall, `workOrderWhere`: a person limited to customer B
 *     never reads customer A's name), and for Work instructions also the brands of the styles they reach (B-PR-37). Never a
 *     customer the person cannot reach, never a count of one.
 *   - `customerFacts` / `workOrderCustomers`: the customer a production list row names (its work order's one customer, or the
 *     mixed flag of one made before the one-customer rule), read once per page of rows.
 */

/** A customer as the office's production screens name it (the brand-limited reader only ever gets their own). */
export interface CustomerFact {
  readonly id: string
  readonly code: string
  readonly name: string
}

export const customerSchema = output({ id: id(), code: z.string(), name: z.string() })

/** The production pages that take the customer filter, and the permission each one's API reads with. */
export const CUSTOMER_VIEWS = ['floor', 'work-orders', 'cutting', 'bundles', 'scrap', 'calls', 'instructions', 'reports', 'dispatch'] as const
export type CustomerView = (typeof CUSTOMER_VIEWS)[number]

export const VIEW_PERMISSIONS: Readonly<Record<CustomerView, Permission>> = {
  floor: WORKORDERS_VIEW,
  'work-orders': WORKORDERS_VIEW,
  cutting: PRODUCTION_CUTTING_VIEW,
  bundles: PRODUCTION_BUNDLES_VIEW,
  scrap: PRODUCTION_SCRAP_VIEW,
  calls: PRODUCTION_CALLS_VIEW,
  instructions: PRODUCTION_INSTRUCTIONS_VIEW,
  reports: PRODUCTION_REPORTS_VIEW,
  dispatch: PRODUCTION_DISPATCH_VIEW,
}

const PARTY = { id: true, code: true, legalName: true, tradeName: true } as const

/** The customers of these parties, by id (the name the office uses: the trade name, else the legal name). */
export async function customerFacts(db: Reader, partyIds: readonly (string | null | undefined)[]): Promise<Map<string, CustomerFact>> {
  const wanted = [...new Set(partyIds.filter((value): value is string => typeof value === 'string'))]
  if (wanted.length === 0) return new Map()
  const rows = await db.party.findMany({ where: { id: { in: wanted } }, select: PARTY })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
}

export interface WorkOrderCustomer {
  readonly customer: CustomerFact | null
  /** Made before the one-customer rule with cells of several customers ("Mixed brands (made before the rule)"). */
  readonly mixedCustomers: boolean
}

/** Each work order's one customer (B-PR-01), read once for a page of rows (rows of no work order pass none). */
export async function workOrderCustomers(db: Reader, workOrderIds: readonly (string | null | undefined)[]): Promise<Map<string, WorkOrderCustomer>> {
  const wanted = [...new Set(workOrderIds.filter((value): value is string => typeof value === 'string'))]
  if (wanted.length === 0) return new Map()
  const rows = await db.workOrder.findMany({ where: { id: { in: wanted } }, select: { id: true, partyId: true, sizes: { select: { partyId: true } } } })
  const parties = await customerFacts(db, rows.map((row) => row.partyId))
  return new Map(
    rows.map((row) => [
      row.id,
      {
        customer: row.partyId ? (parties.get(row.partyId) ?? null) : null,
        mixedCustomers: row.partyId === null && row.sizes.some((cell) => cell.partyId !== null),
      },
    ]),
  )
}

/** A row's customer facts for its work order (none known: no customer, not mixed). */
export const customerOfRow = (map: ReadonlyMap<string, WorkOrderCustomer>, workOrderId: string | null | undefined): WorkOrderCustomer =>
  (workOrderId ? map.get(workOrderId) : undefined) ?? { customer: null, mixedCustomers: false }

export const productionCustomersContract = defineContract({
  querystring: input({ view: z.enum(CUSTOMER_VIEWS) }),
  response: {
    200: output({
      /** The customers the reader may narrow this page to, by name (never one outside their reach). */
      customers: z.array(customerSchema),
      /** Whether the reader reaches every customer with this page's permission (a limited reader: false). */
      everyCustomer: z.boolean(),
    }),
  },
})

/** GET /production/customers?view=<page>: the page's permission is checked here (the manifest asks a session only). */
export async function productionCustomers(caller: CommandCaller, query: { readonly view: CustomerView }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const permission = VIEW_PERMISSIONS[query.view]
  if (!can(actor, permission)) throw new ForbiddenError()
  return caller.withClient(async (db) => {
    const ofWorkOrders = await db.workOrder.findMany({ where: { AND: [workOrderWhere(actor, permission), { partyId: { not: null } }] }, select: { partyId: true }, distinct: ['partyId'] })
    const partyIds = new Set(ofWorkOrders.map((row) => row.partyId!))
    if (query.view === 'instructions') {
      // Work instructions are walled by the style's brand (B-PR-37): the brands of the styles the reader reaches.
      const styles = await db.style.findMany({ where: { brandPartyId: { not: null } }, select: { brandPartyId: true, companyId: true }, distinct: ['brandPartyId', 'companyId'] })
      for (const style of styles) if (can(actor, permission, { ...(style.companyId ? { companyId: style.companyId } : {}), partyId: style.brandPartyId! })) partyIds.add(style.brandPartyId!)
    }
    const customers = [...(await customerFacts(db, [...partyIds])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    // Some grant of the page's permission reaches every customer: the page's views that mix customers open (B-PR-07).
    return { customers, everyCustomer: reachesEveryParty(actor, permission) }
  })
}
