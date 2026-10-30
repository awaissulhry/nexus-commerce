import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { buildTraceGraph, type TraceFacts, type TraceGraph, type TraceNodeView, type TraceParty } from '@nexus/factory-domain/inventory/trace/graph'
import { traceGapMessage, type TraceDirection, type TraceStartKind } from '@nexus/factory-domain/inventory/trace/rules'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { mayAt, officeContextOf } from '../ledger/access'
import { loadTraceFacts, readStart, type StartRecord } from './load'

/**
 * The trace of one start (B-W2a-27; SCM-240, SCM-241): the start's record, the caller's inventory.stock.view on its
 * company and site (else not found), the rows around it (load.ts), the graph (factory-domain inventory/trace/graph),
 * then what the caller may see of it: a party's code and name only with parties.view on that party; a record at a site
 * its grants do not reach keeps its place in the graph and the counts, without its details (`restricted`). Read only.
 */

let clock: Clock = serverClock
/** Test only: the clock of `asOf` (default the server clock). */
export function useTraceClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}

const LABEL: Readonly<Record<TraceStartKind, string>> = { LOT: 'Lot', HIDE: 'Hide', BUNDLE: 'Bundle', WORK_ORDER: 'Work order', SERIAL: 'Serial', SHIPMENT: 'Shipment' }

export interface TraceQuery {
  readonly kind: TraceStartKind
  readonly id: string
  readonly direction: TraceDirection
}

export async function traceFrom(caller: CommandCaller, query: TraceQuery) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const start = await readStart(client, query.kind, query.id)
    if (!start || !mayAt(context, INVENTORY_STOCK_VIEW, start)) throw new NotFoundError(`${LABEL[query.kind]} not found.`)
    const facts = await loadTraceFacts(client, start, query.direction)
    const graph = buildTraceGraph(facts, start, query.direction)
    return present(actorOf(context), start, facts, graph, clock.now())
  })
}

type Site = { readonly companyId: string; readonly siteId: string }

/** The site a node lies at (parties have none: their names follow parties.view). */
function sitesOf(facts: TraceFacts): (node: TraceNodeView) => Site | null {
  const lots = new Map(facts.lots.map((lot) => [lot.id, lot]))
  const hides = new Map(facts.hides.map((hide) => [hide.id, hide]))
  const workOrders = new Map(facts.workOrders.map((row) => [row.id, row]))
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
        return site(workOrders.get(node.id))
      case 'CELL':
        return site(workOrders.get(cells.get(node.id)?.workOrderId ?? ''))
      case 'BUNDLE':
        return site(workOrders.get(bundles.get(node.id)?.workOrderId ?? ''))
      case 'SERIAL':
        return site(workOrders.get(serials.get(node.id)?.workOrderId ?? ''))
      case 'SUBCONTRACT':
        return site(workOrders.get(subcontracts.get(node.id)?.workOrderId ?? ''))
      case 'SHIPMENT':
        return site(shipments.get(node.id))
      case 'SUPPLIER':
      case 'CUSTOMER':
        return null
    }
  }
}

function present(actor: Actor, start: StartRecord, facts: TraceFacts, graph: TraceGraph, now: Date) {
  const parties = new Map(facts.parties.map((party) => [party.id, party]))
  const seesParty = (party: TraceParty | undefined) => (party && can(actor, PARTIES_VIEW, { companyId: party.companyId, partyId: party.id }) ? { id: party.id, code: party.code, name: party.name } : null)
  const siteOf = sitesOf(facts)
  const hidden = new Set<string>()
  const restricted = new Map<string, number>()
  const restrict = (permission: string) => restricted.set(permission, (restricted.get(permission) ?? 0) + 1)

  const nodes = graph.nodes.map((node) => {
    const base = { key: node.key, kind: node.kind, id: node.id, reach: node.reach, sides: [...node.sides], holds: node.holds.map((hold) => ({ ...hold })) }
    const site = siteOf(node)
    if (site && node.key !== graph.start && !can(actor, INVENTORY_STOCK_VIEW, site)) {
      hidden.add(node.key)
      restrict(INVENTORY_STOCK_VIEW)
      return { ...base, code: null, restricted: [INVENTORY_STOCK_VIEW], holds: [] }
    }
    switch (node.kind) {
      case 'SUPPLIER':
      case 'CUSTOMER': {
        const party = seesParty(node.party)
        if (!party) {
          hidden.add(node.key)
          restrict(PARTIES_VIEW)
        }
        return { ...base, code: party?.code ?? null, restricted: party ? [] : [PARTIES_VIEW], party, ...(node.kind === 'CUSTOMER' ? { received: node.received ?? false } : {}) }
      }
      case 'SUBCONTRACT': {
        const workshop = seesParty(parties.get(node.subcontract!.partyId))
        if (!workshop) restrict(PARTIES_VIEW)
        return { ...base, code: node.code, restricted: workshop ? [] : [PARTIES_VIEW], subcontract: { status: node.subcontract!.status, workOrderId: node.subcontract!.workOrderId, workshop } }
      }
      case 'SHIPMENT': {
        const { partyId: _party, ddtNumbers, ...shipment } = node.shipment!
        return { ...base, code: node.code, restricted: [], shipment: { ...shipment, ddtNumbers: [...ddtNumbers] } }
      }
      default: {
        const { key: _key, kind: _kind, id: _id, reach: _reach, sides: _sides, holds: _holds, code, party: _party, received: _received, subcontract: _subcontract, shipment: _shipment, ...detail } = node
        return { ...base, code, restricted: [], ...detail }
      }
    }
  })
  return {
    start: { key: graph.start, kind: start.kind, id: start.id, code: start.code },
    direction: graph.direction,
    asOf: now.toISOString(),
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge })),
    levels: graph.levels.map((level) => ({ ...level })),
    gaps: graph.gaps.map((gap) => (hidden.has(gap.at) ? { ...gap, message: traceGapMessage(gap.code, 'A record you may not see', gap.count) } : { ...gap })),
    customersReceived: graph.customersReceived,
    restricted: [...restricted].map(([permission, count]) => ({ permission, nodes: count })).sort((a, b) => a.permission.localeCompare(b.permission)),
  }
}
