import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, reachesEveryParty, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../core/context'
import { reachesWorkOrder, type WorkOrderReach } from '../production/work-orders/scope'

/**
 * B-PR-06 (production plan §2, the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): the ONE place
 * quality asks which customers a quality record names, so an office person limited to some customers (a grant's `parties`)
 * meets only theirs:
 *
 *   - a record of one work order (an inspection, a release per cell, a check on it, its bundle, its serial) follows its work
 *     order: B-PR-03's reachesWorkOrder (a work order of no customer, or mixed before the rule: only who reaches every customer);
 *   - a hold or an NCR names the customers of everything it is about (its work orders, bundles, serials, shipments, parcels, and
 *     for an NCR also its style's brand, its source and its links: a complaint, a return, a sales order …). It is shown only when
 *     EVERY one of them is reached; one of several customers needs every-customer readers ("several brands: every-brand readers
 *     only"). A hold or an NCR of a lot, a hide or a machine names no customer and stays with the company and site;
 *   - a refusal is the one a missing record gets (404 in the record's own words, or no row): it never says another customer
 *     exists.
 *
 * The production unit (grants that reach every customer) pays nothing: `seesEveryCustomer` skips every lookup.
 */

type Reader = FactoryClient | CommandTx
type Place = { readonly companyId?: string | null; readonly siteId?: string | null }

/** The customers a quality record names. */
export interface Customers {
  /** Each customer it names: every one must be reached. */
  readonly parties: readonly string[]
  /** It names customer work of no customer (a work order mixed before the rule, a sample of no customer): every customer only. */
  readonly unnamed: boolean
}

export const NO_CUSTOMER: Customers = Object.freeze({ parties: Object.freeze([]) as readonly string[], unnamed: false })

/** Every grant of the permission reaches every customer: nothing is hidden from this person. */
export function seesEveryCustomer(actor: Actor, permission: Permission): boolean {
  const grants = grantsFor(actor, permission)
  return grants.length > 0 && grants.every((grant) => grant.parties === 'all')
}

/** The permission reaches every customer the record names, at its company and site. */
export function reachesCustomers(actor: Actor, permission: Permission, place: Place, customers: Customers): boolean {
  const at = { ...(place.companyId ? { companyId: place.companyId } : {}), ...(place.siteId ? { siteId: place.siteId } : {}) }
  if (customers.unnamed && !reachesEveryParty(actor, permission, at)) return false
  return customers.parties.every((partyId) => can(actor, permission, { ...at, partyId }))
}

/** May the caller (office, or a floor device at its own site) do this on a work order: its company, site and customer? */
export function mayOnWorkOrder(context: FloorContext | OfficeContext, permission: Permission, row: WorkOrderReach): boolean {
  if (context.audience === 'floor' && context.siteId !== row.siteId) return false
  return reachesWorkOrder(actorOf(context), permission, row)
}

/** The scope of each work order asked (its company, site and customer); an unknown id is left out. */
export async function workOrderReachOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<Map<string, WorkOrderReach>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && isUuid(id)))]
  if (wanted.length === 0) return new Map()
  const rows = await db.workOrder.findMany({ where: { id: { in: wanted } }, select: { id: true, companyId: true, siteId: true, partyId: true } })
  return new Map(rows.map((row) => [row.id, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId }]))
}

/** A record a hold or an NCR is about (its type as the hold, the NCR's source and links name it). */
export interface RecordRef {
  readonly type: string
  readonly id: string
}

const keyOf = (type: string, id: string) => `${type}:${id}`
const merge = (...all: readonly Customers[]): Customers => ({ parties: [...new Set(all.flatMap((one) => one.parties))].sort(), unnamed: all.some((one) => one.unnamed) })
const ofParty = (partyId: string | null | undefined): Customers => (partyId ? { parties: [partyId], unnamed: false } : NO_CUSTOMER)
const ofWork = (partyId: string | null | undefined): Customers => (partyId ? { parties: [partyId], unnamed: false } : { parties: [], unnamed: true })

/**
 * The customers each record names, by `type:id`: a work order, a bundle, a serial, an inspection, an operation scan or a rework
 * order its work order's (none: customer work of no customer); a check its work order's when it has one (a line check names
 * none); a shipment, a parcel, a sales order, a complaint, a return (or a line of it), a repair order, a PPE register entry their
 * customer; a style its brand (none: our own collection); a hold what it holds. Anything else (a lot, a hide, a receipt, a
 * supplier claim, a purchase order …) names no customer. An unknown record names none.
 */
export async function customersOf(db: Reader, refs: readonly RecordRef[]): Promise<Map<string, Customers>> {
  const out = new Map<string, Customers>()
  const idsOf = (type: string) => [...new Set(refs.filter((ref) => ref.type === type && isUuid(ref.id)).map((ref) => ref.id))]
  const some = (ids: readonly string[]) => ids.length > 0
  // The records of one work order: their work order first, then its customer.
  const viaWorkOrder = new Map<string, string>()
  const workOrderIds = idsOf('WorkOrder')
  const bundles = idsOf('Bundle')
  if (some(bundles)) for (const row of await db.bundle.findMany({ where: { id: { in: bundles } }, select: { id: true, workOrderId: true } })) viaWorkOrder.set(keyOf('Bundle', row.id), row.workOrderId)
  const serials = idsOf('GarmentSerial')
  if (some(serials)) for (const row of await db.garmentSerial.findMany({ where: { id: { in: serials } }, select: { id: true, workOrderId: true } })) viaWorkOrder.set(keyOf('GarmentSerial', row.id), row.workOrderId)
  const inspections = idsOf('Inspection')
  if (some(inspections)) for (const row of await db.inspection.findMany({ where: { id: { in: inspections } }, select: { id: true, workOrderId: true } })) viaWorkOrder.set(keyOf('Inspection', row.id), row.workOrderId)
  const scans = idsOf('OperationScan')
  if (some(scans)) for (const row of await db.operationScan.findMany({ where: { id: { in: scans } }, select: { id: true, workOrderId: true } })) viaWorkOrder.set(keyOf('OperationScan', row.id), row.workOrderId)
  const reworks = idsOf('ReworkOrder')
  if (some(reworks)) for (const row of await db.reworkOrder.findMany({ where: { id: { in: reworks } }, select: { id: true, workOrderId: true } })) viaWorkOrder.set(keyOf('ReworkOrder', row.id), row.workOrderId)
  const checks = idsOf('InProcessCheck')
  if (some(checks)) {
    for (const row of await db.inProcessCheck.findMany({ where: { id: { in: checks } }, select: { id: true, workOrderId: true } })) {
      if (row.workOrderId) viaWorkOrder.set(keyOf('InProcessCheck', row.id), row.workOrderId)
      else out.set(keyOf('InProcessCheck', row.id), NO_CUSTOMER)
    }
  }
  const reach = await workOrderReachOf(db, [...workOrderIds, ...viaWorkOrder.values()])
  for (const id of workOrderIds) if (reach.has(id)) out.set(keyOf('WorkOrder', id), ofWork(reach.get(id)!.partyId))
  for (const [key, workOrderId] of viaWorkOrder) if (reach.has(workOrderId)) out.set(key, ofWork(reach.get(workOrderId)!.partyId))
  // The records of one customer.
  const byParty = async (type: string, read: (ids: string[]) => Promise<readonly { readonly id: string; readonly partyId: string | null }[]>) => {
    const ids = idsOf(type)
    if (some(ids)) for (const row of await read(ids)) out.set(keyOf(type, row.id), ofParty(row.partyId))
  }
  await byParty('Shipment', (ids) => db.shipment.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('Parcel', (ids) => db.parcel.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('SalesOrder', (ids) => db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('Complaint', (ids) => db.complaint.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('ReturnAuthorisation', (ids) => db.returnAuthorisation.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('ReturnLine', (ids) => db.returnLine.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('RepairOrder', (ids) => db.repairOrder.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('PpeRegisterEntry', (ids) => db.ppeRegisterEntry.findMany({ where: { id: { in: ids } }, select: { id: true, partyId: true } }))
  await byParty('Style', async (ids) => (await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, brandPartyId: true } })).map((row) => ({ id: row.id, partyId: row.brandPartyId })))
  // A hold: what it holds.
  const holds = idsOf('QualityHold')
  if (some(holds)) {
    const rows = await db.qualityHold.findMany({ where: { id: { in: holds } }, select: { id: true, subjectType: true, subjectIds: true } })
    const held = await holdCustomersOf(db, rows)
    for (const row of rows) out.set(keyOf('QualityHold', row.id), held.get(row.id) ?? NO_CUSTOMER)
  }
  return out
}

/** What a hold holds that may name a customer (a lot or a hide names none). */
export const CUSTOMER_SUBJECTS: readonly string[] = Object.freeze(['WorkOrder', 'Bundle', 'GarmentSerial', 'Shipment', 'Parcel'])

/** The customers of each hold: of every record it holds. */
export async function holdCustomersOf(db: Reader, holds: readonly { readonly id: string; readonly subjectType: string; readonly subjectIds: readonly string[] }[]): Promise<Map<string, Customers>> {
  const named = holds.filter((hold) => CUSTOMER_SUBJECTS.includes(hold.subjectType))
  const records = await customersOf(db, named.flatMap((hold) => hold.subjectIds.map((id) => ({ type: hold.subjectType, id }))))
  return new Map(holds.map((hold) => [hold.id, CUSTOMER_SUBJECTS.includes(hold.subjectType) ? merge(...hold.subjectIds.map((id) => records.get(keyOf(hold.subjectType, id)) ?? NO_CUSTOMER)) : NO_CUSTOMER]))
}

/** An NCR as its customers are read: what it is about, where it was raised from, what it is linked to. */
export interface NcrFacts {
  readonly id: string
  readonly workOrderId: string | null
  readonly styleId: string | null
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly links: readonly { readonly recordType: string; readonly recordId: string }[]
}

export const NCR_FACTS = { id: true, companyId: true, siteId: true, workOrderId: true, styleId: true, sourceType: true, sourceId: true, links: { select: { recordType: true, recordId: true } } } as const

/** The customers of each NCR: its work order's, its style's brand, its source's and every linked record's. */
export async function ncrCustomersOf(db: Reader, ncrs: readonly NcrFacts[]): Promise<Map<string, Customers>> {
  const refsOf = (ncr: NcrFacts): RecordRef[] => [
    ...(ncr.workOrderId ? [{ type: 'WorkOrder', id: ncr.workOrderId }] : []),
    ...(ncr.styleId ? [{ type: 'Style', id: ncr.styleId }] : []),
    ...(ncr.sourceType && ncr.sourceId ? [{ type: ncr.sourceType, id: ncr.sourceId }] : []),
    ...ncr.links.map((link) => ({ type: link.recordType, id: link.recordId })),
  ]
  const records = await customersOf(db, ncrs.flatMap(refsOf))
  return new Map(ncrs.map((ncr) => [ncr.id, merge(NO_CUSTOMER, ...refsOf(ncr).map((ref) => records.get(keyOf(ref.type, ref.id)) ?? NO_CUSTOMER))]))
}

/**
 * A hold list's `where` behind the wall: `where` less the holds the permission does not reach (one of their customers is not
 * reached); with `partyId` (the customer filter), only the holds of that customer's goods. A person who reaches every customer
 * and asks no customer gets `where` as it is, without a read.
 */
export async function holdListWhere(db: Reader, actor: Actor, permission: Permission, where: Prisma.QualityHoldWhereInput, partyId?: string): Promise<Prisma.QualityHoldWhereInput> {
  const every = seesEveryCustomer(actor, permission)
  if (every && !partyId) return where
  const rows = await db.qualityHold.findMany({ where: { AND: [where, { subjectType: { in: [...CUSTOMER_SUBJECTS] } }] }, select: { id: true, companyId: true, siteId: true, subjectType: true, subjectIds: true } })
  const customers = await holdCustomersOf(db, rows)
  return narrowed(where, rows, customers, every ? null : (row) => reachesCustomers(actor, permission, row, customers.get(row.id) ?? NO_CUSTOMER), partyId) as Prisma.QualityHoldWhereInput
}

/** An NCR list's `where` behind the wall (as holdListWhere): less the NCRs not reached; with `partyId`, only that customer's. */
export async function ncrListWhere(db: Reader, actor: Actor, permission: Permission, where: Prisma.NonconformanceWhereInput, partyId?: string): Promise<Prisma.NonconformanceWhereInput> {
  const every = seesEveryCustomer(actor, permission)
  if (every && !partyId) return where
  const rows = await db.nonconformance.findMany({ where, select: NCR_FACTS })
  const customers = await ncrCustomersOf(db, rows)
  return narrowed(where, rows, customers, every ? null : (row) => reachesCustomers(actor, permission, row, customers.get(row.id) ?? NO_CUSTOMER), partyId) as Prisma.NonconformanceWhereInput
}

function narrowed<W extends object, R extends { readonly id: string }>(where: W, rows: readonly R[], customers: ReadonlyMap<string, Customers>, reached: ((row: R) => boolean) | null, partyId: string | undefined): { AND: object[] } {
  const hidden = reached ? rows.filter((row) => !reached(row)).map((row) => row.id) : []
  const naming = partyId ? rows.filter((row) => (customers.get(row.id) ?? NO_CUSTOMER).parties.includes(partyId)).map((row) => row.id) : null
  return { AND: [where, hidden.length > 0 ? { id: { notIn: hidden } } : {}, naming ? { id: { in: naming } } : {}] }
}

/** A hold the permission reaches: its company and site, and every customer of what it holds. */
export async function reachesHold(db: Reader, actor: Actor, permission: Permission, hold: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly subjectType: string; readonly subjectIds: readonly string[] }): Promise<boolean> {
  if (!can(actor, permission, { companyId: hold.companyId, siteId: hold.siteId })) return false
  if (seesEveryCustomer(actor, permission)) return true
  return reachesCustomers(actor, permission, hold, (await holdCustomersOf(db, [hold])).get(hold.id) ?? NO_CUSTOMER)
}

/** An NCR the permission reaches: its company and site, and every customer it names. */
export async function reachesNcr(db: Reader, actor: Actor, permission: Permission, ncrId: string, place: { readonly companyId: string; readonly siteId: string }): Promise<boolean> {
  if (!can(actor, permission, place)) return false
  if (seesEveryCustomer(actor, permission)) return true
  const facts = await db.nonconformance.findUnique({ where: { id: ncrId }, select: NCR_FACTS })
  if (!facts) return false
  return reachesCustomers(actor, permission, place, (await ncrCustomersOf(db, [facts])).get(ncrId) ?? NO_CUSTOMER)
}

// ---- B-PR-08a part 2 (production plan §2; the threads' wall party and the alerts' party, B-PR-37): ONE party for what names
// customers, where only one id fits — a fixed id that is no party's stands for "several customers, or customer work of none".
/**
 * The every-party marker: only a grant that reaches EVERY customer reaches it (can(), scopeWhere and roleReaches find it in no
 * customer list). An alert of goods of several customers carries it (platform/alerts/evaluators.ts), and so does the office's
 * wall party of a work order, hold or NCR thread of several customers or of none (platform/threads/records.ts).
 */
export const EVERY_PARTY_MARKER = 'ffffffff-ffff-8fff-bfff-ffffffffffff'

/** The one party of what these customers name: none → null (company and site only), one → it, several or unnamed → the marker. */
export function partyOfCustomers(customers: Customers): string | null {
  if (customers.parties.length === 0 && !customers.unnamed) return null
  return customers.parties.length === 1 && !customers.unnamed ? customers.parties[0]! : EVERY_PARTY_MARKER
}
// ---- end B-PR-08a
