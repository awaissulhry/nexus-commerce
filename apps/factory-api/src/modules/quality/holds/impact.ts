import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { buildTraceGraph, type TraceFacts, type TraceNodeView } from '@nexus/factory-domain/inventory/trace/graph'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import {
  AFFECTED_TRACE_LIMIT,
  GENEALOGY_START_TYPES,
  impactLevels,
  impactStates,
  mergeImpact,
  nodeHoldOf,
  TRACE_START_OF,
  type GenealogyStartType,
  type ImpactGraph,
  type ImpactNode,
} from '@nexus/factory-domain/quality/holds/depth'
import { QUALITY_HOLDS_PLACE, QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import { STOCK_SUBJECTS, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { loadTraceFacts, readStart, type StartRecord } from '../../inventory/trace/load'
import { officeOf } from './holds'
import { readHold, type HoldRow, type Reader } from './store'

/**
 * What a hold reaches (B-W2b-114; QHS-075; design quality.holds qh-genealogy "TraceTree: hides → cut pieces → bundles →
 * work orders → garments → cartons → shipments → customers, with counts per state" and the Hold record's Affected tab "What
 * it touches"). B-W2a-27's forward trace (modules/inventory/trace load.ts, factory-domain inventory/trace graph.ts) from
 * each record, merged, and said for a hold: what each node is to a hold (factory-domain quality/holds/depth nodeHoldOf),
 * what the whole touches by state. Read only, office only, on the caller's client.
 *
 *   GET /quality/holds/genealogy?type=Lot|Hide&id=&holdId=   (quality.holds.place over the suspect record's site) the
 *       tree a person ticks, the sites it reaches with their quarantine places and whether the person places holds
 *       there, and — `holdId`: extending that hold — its group.
 *   GET /quality/holds/:holdId/affected                      (quality.holds.view) the tree of the hold's own records
 *       (at most AFFECTED_TRACE_LIMIT traced), its group, and where "Extend hold" starts (or why it does not).
 *
 * Rights: a node at a site the caller's quality.holds.view does not reach is counted, never shown nor held (`hidden`);
 * a supplier's or customer's name only with parties.view on it. No cost, price, value or worker is read.
 */

type Site = { readonly companyId: string; readonly siteId: string }

/** The site a node lies at (B-W2a-27's rule; parties have none). */
function sitesOf(facts: TraceFacts): (node: TraceNodeView) => Site | null {
  const lots = new Map(facts.lots.map((lot) => [lot.id, lot]))
  const hides = new Map(facts.hides.map((hide) => [hide.id, hide]))
  const orders = new Map(facts.workOrders.map((row) => [row.id, row]))
  const cells = new Map(facts.cells.map((cell) => [cell.id, cell]))
  const bundles = new Map(facts.bundles.map((bundle) => [bundle.id, bundle]))
  const serials = new Map(facts.serials.map((serial) => [serial.id, serial]))
  const shipments = new Map(facts.shipments.map((shipment) => [shipment.id, shipment]))
  const subcontracts = new Map(facts.subcontracts.map((order) => [order.id, order]))
  const receiptLot = new Map(facts.lots.filter((lot) => lot.receiptId).map((lot) => [lot.receiptId!, lot]))
  const site = (row: Site | undefined): Site | null => (row ? { companyId: row.companyId, siteId: row.siteId } : null)
  return (node) => {
    switch (node.kind) {
      case 'LOT':
        return site(lots.get(node.id))
      case 'HIDE':
        return site(lots.get(hides.get(node.id)?.lotId ?? ''))
      case 'RECEIPT':
        return site(receiptLot.get(node.id))
      case 'WORK_ORDER':
        return site(orders.get(node.id))
      case 'CELL':
        return site(orders.get(cells.get(node.id)?.workOrderId ?? ''))
      case 'BUNDLE':
        return site(orders.get(bundles.get(node.id)?.workOrderId ?? ''))
      case 'SERIAL':
        return site(orders.get(serials.get(node.id)?.workOrderId ?? ''))
      case 'SUBCONTRACT':
        return site(orders.get(subcontracts.get(node.id)?.workOrderId ?? ''))
      case 'SHIPMENT':
        return site(shipments.get(node.id))
      case 'SUPPLIER':
      case 'CUSTOMER':
        return null
    }
  }
}

const stateOf = (node: TraceNodeView): string | null =>
  node.lot?.qualityStatus ?? node.hide?.state ?? node.workOrder?.status ?? node.bundle?.status ?? node.serial?.status ?? node.shipment?.status ?? null

/** One node for the Holds screens: its place, what it is to a hold, its facts in figures (never a status said in words). */
function impactNodeOf(actor: Actor, node: TraceNodeView, site: Site | null, isStart: boolean, restrict: (permission: string) => void): ImpactNode {
  const hidden = !isStart && site !== null && !can(actor, QUALITY_HOLDS_VIEW, site)
  if (hidden) restrict(QUALITY_HOLDS_VIEW)
  const party = node.party && can(actor, PARTIES_VIEW, { companyId: node.party.companyId, partyId: node.party.id }) ? node.party : null
  const isParty = node.kind === 'SUPPLIER' || node.kind === 'CUSTOMER'
  if (isParty && !party) restrict(PARTIES_VIEW)
  const state = hidden ? null : stateOf(node)
  const fact = nodeHoldOf({ kind: node.kind, code: node.code, state, heldBy: node.holds.length, hidden })
  const workOrderId = node.kind === 'WORK_ORDER' ? node.id : (node.cell?.workOrderId ?? node.bundle?.workOrderId ?? node.serial?.workOrderId ?? null)
  const code = hidden || (isParty && !party) ? null : isParty ? party!.code : node.code
  return {
    key: node.key,
    kind: node.kind,
    id: node.id,
    code,
    reach: node.reach,
    companyId: site?.companyId ?? null,
    siteId: site?.siteId ?? null,
    hidden: hidden || (isParty && !party),
    state,
    holdKind: fact.holdKind,
    hold: fact.hold,
    problem: fact.problem,
    holds: hidden ? [] : node.holds.map((hold) => ({ id: hold.id, reasonCode: hold.reasonCode })),
    workOrderId,
    ...(hidden ? {} : {
      cell: node.cell ? { colourwayCode: node.cell.colourwayCode, size: node.cell.size, quantity: node.cell.quantity, released: node.cell.released, packed: node.cell.packed, shipped: node.cell.shipped, returned: node.cell.returned } : null,
      lot: node.lot ? { itemCode: node.lot.item.code, itemName: node.lot.item.name, uom: node.lot.item.baseUom, onHand: node.lot.onHand, colourCode: node.lot.colourCode } : null,
      hideOnHand: node.hide?.onHand ?? null,
      workOrder: node.workOrder ? { styleCode: node.workOrder.styleCode, batchNumber: node.workOrder.batchNumber, status: node.workOrder.status } : null,
      bundle: node.bundle ? { quantity: node.bundle.quantity, part: node.bundle.part } : null,
      shipment: node.shipment ? { ddtNumbers: [...node.shipment.ddtNumbers], left: node.shipment.left } : null,
    }),
    ...(isParty ? { partyName: party?.name ?? null } : {}),
    ...(node.kind === 'CUSTOMER' ? { received: node.received ?? false } : {}),
  }
}

/** The forward trace of each start, merged, as the Holds screens read it. */
export async function impactOf(client: Reader, actor: Actor, starts: readonly StartRecord[]) {
  const restricted = new Map<string, number>()
  const restrict = (permission: string) => restricted.set(permission, (restricted.get(permission) ?? 0) + 1)
  const graphs: ImpactGraph[] = []
  for (const start of starts) {
    const facts = await loadTraceFacts(client as unknown as FactoryClient, start, 'FORWARD')
    const graph = buildTraceGraph(facts, start, 'FORWARD')
    const siteOf = sitesOf(facts)
    graphs.push({
      starts: [graph.start],
      nodes: graph.nodes.map((node) => impactNodeOf(actor, node, siteOf(node), node.key === graph.start, restrict)),
      edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, link: edge.link, exact: edge.exact, quantity: edge.quantity, uom: edge.uom })),
      gaps: graph.gaps.map((gap) => ({ code: gap.code, severity: gap.severity, at: gap.at, count: gap.count })),
    })
  }
  const merged = mergeImpact(graphs)
  const states = impactStates(merged.nodes)
  // A node counted once however many traces reached it: the counts per permission are the merged nodes' (hidden ones).
  const hiddenBy = (permission: string) => merged.nodes.filter((node) => node.hidden && (permission === PARTIES_VIEW ? node.kind === 'SUPPLIER' || node.kind === 'CUSTOMER' : node.kind !== 'SUPPLIER' && node.kind !== 'CUSTOMER')).length
  return {
    starts: starts.map((start) => ({ key: `${start.kind}:${start.id}`, kind: start.kind, id: start.id, code: start.code })),
    asOf: serverClock.now().toISOString(),
    nodes: merged.nodes.map((node) => ({ ...node, holds: [...node.holds], shipment: node.shipment ? { ...node.shipment, ddtNumbers: [...node.shipment.ddtNumbers] } : null })),
    edges: [...merged.edges],
    levels: impactLevels(merged.nodes),
    gaps: [...merged.gaps],
    states: { ...states, material: [...states.material], garments: { ...states.garments } },
    restricted: [...restricted.keys()].map((permission) => ({ permission, nodes: hiddenBy(permission) })).filter((entry) => entry.nodes > 0).sort((a, b) => a.permission.localeCompare(b.permission)),
  }
}
export type Impact = Awaited<ReturnType<typeof impactOf>>

// ---- the hold group --------------------------------------------------------------------------------------------------------

/** A hold by genealogy as the screens show it: where it started, why, what it counts and the holds it is made of. */
export async function groupViewOf(db: Reader, groupId: string) {
  const group = await db.qualityHoldGroup.findUnique({ where: { id: groupId }, select: { id: true, companyId: true, sourceType: true, sourceId: true, reasonCode: true, reasonNote: true, counts: true, placedAt: true, placedById: true, version: true } })
  if (!group) return null
  const code =
    group.sourceType === 'Lot'
      ? ((await db.lot.findUnique({ where: { id: group.sourceId }, select: { code: true } }))?.code ?? null)
      : group.sourceType === 'Hide'
        ? ((await db.hide.findUnique({ where: { id: group.sourceId }, select: { code: true } }))?.code ?? null)
        : null
  const holds = await db.qualityHold.findMany({ where: { groupId }, select: { id: true, number: true, subjectType: true, subjectIds: true, status: true, siteId: true }, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
  const sites = new Map((await db.site.findMany({ where: { id: { in: [...new Set(holds.map((hold) => hold.siteId))] } }, select: { id: true, code: true } })).map((site) => [site.id, site.code]))
  const counts = Object.fromEntries(Object.entries((group.counts ?? {}) as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0))
  return {
    id: group.id,
    sourceType: group.sourceType,
    sourceId: group.sourceId,
    sourceCode: code,
    reasonCode: group.reasonCode,
    reasonNote: group.reasonNote,
    counts,
    placedAt: group.placedAt.toISOString(),
    placedBy: group.placedById ? ('USER' as const) : ('SYSTEM' as const),
    version: group.version,
    holds: holds.map((hold) => ({ id: hold.id, number: hold.number, subjectType: hold.subjectType as HoldSubjectType, count: hold.subjectIds.length, status: hold.status as 'ACTIVE' | 'RELEASED' | 'CLOSED', siteCode: sites.get(hold.siteId) ?? null })),
  }
}
export type GroupView = NonNullable<Awaited<ReturnType<typeof groupViewOf>>>

// ---- the reads ---------------------------------------------------------------------------------------------------------------

/** The suspect record a genealogy starts from, visible to the caller with quality.holds.view (else not found). */
export async function genealogyStart(db: Reader, actor: Actor, type: GenealogyStartType, id: string): Promise<StartRecord> {
  const start = isUuid(id) ? await readStart(db as unknown as FactoryClient, TRACE_START_OF[type]!, id) : null
  if (!start || !can(actor, QUALITY_HOLDS_VIEW, start)) throw new NotFoundError(`${type === 'Lot' ? 'Lot' : 'Hide'} not found.`)
  return start
}

/** The sites a tree reaches with something to hold: their quarantine places, and whether the caller places holds there. */
async function sitesFacts(db: Reader, actor: Actor, nodes: readonly ImpactNode[]) {
  const ids = [...new Set(nodes.filter((node) => node.holdKind !== null && !node.hidden && node.siteId).map((node) => node.siteId!))].sort()
  if (ids.length === 0) return []
  const sites = await db.site.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, companyId: true }, orderBy: { code: 'asc' } })
  const places = await db.location.findMany({ where: { siteId: { in: ids }, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true, name: true, siteId: true }, orderBy: { code: 'asc' } })
  return sites.map((site) => ({
    id: site.id,
    code: site.code,
    name: site.name,
    mayPlace: can(actor, QUALITY_HOLDS_PLACE, { companyId: site.companyId, siteId: site.id }),
    quarantinePlaces: places.filter((place) => place.siteId === site.id).map((place) => ({ id: place.id, code: place.code, name: place.name })),
  }))
}

/** A hold the caller sees (quality.holds.view over its site), else not found. */
async function seenHold(db: Reader, actor: Actor, holdId: string): Promise<HoldRow> {
  const row = await readHold(db, holdId)
  if (!row || !can(actor, QUALITY_HOLDS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Hold not found.')
  return row
}

/** GET /quality/holds/genealogy */
export async function readGenealogy(caller: CommandCaller, query: { readonly type: GenealogyStartType; readonly id: string; readonly holdId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const start = await genealogyStart(client, actor, query.type, query.id)
    if (!can(actor, QUALITY_HOLDS_PLACE, start)) throw new ForbiddenError('A hold by genealogy needs quality.holds.place at the suspect record\'s site.')
    const extending = query.holdId ? await seenHold(client, actor, query.holdId) : null
    const impact = await impactOf(client, actor, [start])
    return {
      start: { type: query.type, id: start.id, code: start.code, companyId: start.companyId, siteId: start.siteId },
      ...impact,
      sites: await sitesFacts(client, actor, impact.nodes),
      extending: extending ? { holdId: extending.id, number: extending.number, status: extending.status as 'ACTIVE' | 'RELEASED' | 'CLOSED', groupId: extending.groupId } : null,
      group: extending?.groupId ? await groupViewOf(client, extending.groupId) : null,
    }
  })
}

/** Where "Extend hold" starts for a hold (its group's suspect record, else its first lot or hide), or why it does not. */
type ExtendHeld = 'NOT_ACTIVE' | 'NO_RIGHT' | 'KIND'

async function extendOf(db: Reader, actor: Actor, row: HoldRow, group: GroupView | null): Promise<{ start: { type: GenealogyStartType; id: string; code: string } | null; held: ExtendHeld | null }> {
  if (row.status !== 'ACTIVE') return { start: null, held: 'NOT_ACTIVE' }
  if (!can(actor, QUALITY_HOLDS_PLACE, { companyId: row.companyId, siteId: row.siteId })) return { start: null, held: 'NO_RIGHT' }
  const type = (group && (GENEALOGY_START_TYPES as readonly string[]).includes(group.sourceType) ? group.sourceType : row.subjectType) as HoldSubjectType
  const id = group && (GENEALOGY_START_TYPES as readonly string[]).includes(group.sourceType) ? group.sourceId : row.subjectIds[0]
  if (!(GENEALOGY_START_TYPES as readonly string[]).includes(type) || !STOCK_SUBJECTS.includes(type) || !id) return { start: null, held: 'KIND' }
  const start = await readStart(db as unknown as FactoryClient, TRACE_START_OF[type]!, id)
  if (!start || !can(actor, QUALITY_HOLDS_PLACE, start)) return { start: null, held: 'NO_RIGHT' }
  return { start: { type: type as GenealogyStartType, id: start.id, code: start.code }, held: null }
}

/** GET /quality/holds/:holdId/affected */
export async function readAffected(caller: CommandCaller, holdId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const row = await seenHold(client, actor, holdId)
    const kind = TRACE_START_OF[row.subjectType as HoldSubjectType]
    const starts: StartRecord[] = []
    if (kind) {
      for (const id of [...row.subjectIds].sort().slice(0, AFFECTED_TRACE_LIMIT)) {
        const start = await readStart(client as unknown as FactoryClient, kind, id)
        if (start) starts.push(start)
      }
    }
    const impact = await impactOf(client, actor, starts)
    const group = row.groupId ? await groupViewOf(client, row.groupId) : null
    return {
      holdId: row.id,
      traced: starts.length,
      of: row.subjectIds.length,
      /** A hold of parcels: its records are not traced (a parcel is not a node of the trace yet). */
      traceable: kind !== undefined,
      ...impact,
      group,
      extend: await extendOf(client, actor, row, group),
    }
  })
}
