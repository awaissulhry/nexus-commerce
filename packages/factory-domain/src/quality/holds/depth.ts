import type { Issue } from '../../core/errors'
import { TRACE_NODE_KINDS, type TraceNodeKind, type TraceReach, type TraceStartKind } from '../../inventory/trace/rules'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { HOLD_LIMITS, subjectNoun, unholdableWords, type HoldStatus, type HoldSubjectType } from './rules'

/**
 * Holds in depth (B-W2b-114; QHS-075 hold by genealogy, QHS-077 the hold board, QHS-078 the quarantine move; design
 * quality.holds qh-genealogy, sec:qh-board, the Hold record's Affected tab, qh-move), pure. apps/factory-api's
 * modules/quality/holds (impact.ts, genealogy.ts, depth.ts) reads and writes; the Holds screens say the same in their words.
 *
 *   board       an ACTIVE hold stands in one lane of its next step (QualityHold.nextStep: New · Investigating · Waiting
 *               decision · Ready to release); a person moves it, never the release (a drop on Released opens the release).
 *   genealogy   from one suspect lot or hide, the forward trace (B-W2a-27's impact tree) as nodes a person ticks: what can
 *               be held (a lot, a hide, a work order, an active bundle, a garment not yet gone, a shipment not yet left),
 *               what is held already, what has left (the PPE register's: a recall, not a hold). The ticks become ONE
 *               hold group and one hold per kind of record and site (at most 100 records each): a bundle or a garment of
 *               a work order held in the same group is covered by the work order's hold.
 *   affected    the same tree from a hold's own records, with what it touches by state: material on hand, garments in
 *               work, in stock, packed, shipped (with the customers who received them).
 *   quarantine  the move of held stock (lots, hides) to a QUARANTINE place: asked, then confirmed by the place's code
 *               (the office types or scans it until the tablet's floor.move); confirming moves every balance of the held
 *               stock at the site (not at an outside workshop) into the place.
 */

// ---- the hold board (QHS-077) ------------------------------------------------------------------------------------------

export const HOLD_NEXT_STEPS = ['NEW', 'INVESTIGATING', 'WAITING_DECISION', 'READY_TO_RELEASE'] as const
export type HoldNextStep = (typeof HOLD_NEXT_STEPS)[number]

/** Why a hold may not move to this next step (English words; the screens say their own), or null. */
export function nextStepProblem(hold: { readonly status: HoldStatus; readonly nextStep: HoldNextStep }, to: HoldNextStep): string | null {
  if (hold.status !== 'ACTIVE') return `This hold is ${hold.status.toLowerCase()}: only an active hold moves on the board.`
  if (hold.nextStep === to) return 'The hold is at this step already.'
  return null
}

export interface LaneFact {
  readonly step: HoldNextStep
  readonly count: number
  /** The oldest hold's age in whole days; null: an empty lane. */
  readonly oldestDays: number | null
}

/** The board's lane heads: how many ACTIVE holds stand in each lane and the oldest one's age. */
export function laneFacts(holds: readonly { readonly status: HoldStatus; readonly nextStep: HoldNextStep; readonly ageDays: number }[]): LaneFact[] {
  return HOLD_NEXT_STEPS.map((step) => {
    const lane = holds.filter((hold) => hold.status === 'ACTIVE' && hold.nextStep === step)
    return { step, count: lane.length, oldestDays: lane.length > 0 ? Math.max(...lane.map((hold) => hold.ageDays)) : null }
  })
}

// ---- the impact tree: what a hold can reach (QHS-075) ----------------------------------------------------------------------

/** The suspect records a hold by genealogy starts from (design qh-genealogy "Start: one suspect lot"; a protector lot is a lot). */
export const GENEALOGY_START_TYPES = ['Lot', 'Hide'] as const satisfies readonly HoldSubjectType[]
export type GenealogyStartType = (typeof GENEALOGY_START_TYPES)[number]

/** The trace's start of each kind of held record (a parcel has none: its shipment is traced). */
export const TRACE_START_OF: Readonly<Partial<Record<HoldSubjectType, TraceStartKind>>> = Object.freeze({
  Lot: 'LOT',
  Hide: 'HIDE',
  WorkOrder: 'WORK_ORDER',
  Bundle: 'BUNDLE',
  GarmentSerial: 'SERIAL',
  Shipment: 'SHIPMENT',
})

/** The kind of hold a trace node takes (null: a supplier, a receipt, a size, a workshop's order, a customer). */
export const HOLD_KIND_OF: Readonly<Partial<Record<TraceNodeKind, HoldSubjectType>>> = Object.freeze({
  LOT: 'Lot',
  HIDE: 'Hide',
  WORK_ORDER: 'WorkOrder',
  BUNDLE: 'Bundle',
  SERIAL: 'GarmentSerial',
  SHIPMENT: 'Shipment',
})

/** What a node is to a hold by genealogy. */
export const NODE_HOLD_STATES = ['HOLDABLE', 'HELD', 'LEFT', 'NOT_HOLDABLE', 'NONE', 'HIDDEN'] as const
export type NodeHoldState = (typeof NODE_HOLD_STATES)[number]

/** The shipment states whose goods have left the site (B-W2a-27 LEFT_SHIPMENT_STATUSES) and a garment gone with one. */
const LEFT_SHIPMENTS: readonly string[] = ['SHIPPED', 'DELIVERED']

export interface NodeHoldFacts {
  readonly kind: TraceNodeKind
  readonly code: string | null
  /** The record's state the hold guard reads (a lot's quality status, a hide's state, a work order's status …). */
  readonly state: string | null
  /** ACTIVE holds naming it. */
  readonly heldBy: number
  /** Its site lies outside the reader's reach (counted, never shown or held). */
  readonly hidden: boolean
}

/** A node as a hold by genealogy sees it: its kind of hold, what it is to the hold, and the words when it cannot be held. */
export function nodeHoldOf(node: NodeHoldFacts): { readonly holdKind: HoldSubjectType | null; readonly hold: NodeHoldState; readonly problem: string | null } {
  const holdKind = HOLD_KIND_OF[node.kind] ?? null
  if (holdKind === null) return { holdKind, hold: 'NONE', problem: null }
  if (node.hidden) return { holdKind, hold: 'HIDDEN', problem: 'At a site you do not reach: counted, not held here.' }
  const state = node.state ?? ''
  if ((node.kind === 'SHIPMENT' && LEFT_SHIPMENTS.includes(state)) || (node.kind === 'SERIAL' && state === 'SHIPPED')) {
    return { holdKind, hold: 'LEFT', problem: `${node.kind === 'SHIPMENT' ? 'Shipment' : 'Garment'} ${node.code ?? ''} has left: what has left is the PPE register's (a recall), not a hold's.`.replace('  ', ' ') }
  }
  if (node.heldBy > 0) return { holdKind, hold: 'HELD', problem: null }
  const problem = unholdableWords(holdKind, { label: node.code ?? '—', state })
  return problem ? { holdKind, hold: 'NOT_HOLDABLE', problem } : { holdKind, hold: 'HOLDABLE', problem: null }
}

/** A node of the impact tree, as the API serves it to the Holds screens (no cost, price, value or worker). */
export interface ImpactNode {
  readonly key: string
  readonly kind: TraceNodeKind
  readonly id: string
  /** Null when hidden (a site or a party the reader may not see). */
  readonly code: string | null
  readonly reach: TraceReach
  readonly companyId: string | null
  readonly siteId: string | null
  readonly hidden: boolean
  readonly state: string | null
  readonly holdKind: HoldSubjectType | null
  readonly hold: NodeHoldState
  readonly problem: string | null
  readonly holds: readonly { readonly id: string; readonly reasonCode: string }[]
  /** A size, bundle or garment's work order. */
  readonly workOrderId: string | null
  /** A size: its garments by state. */
  readonly cell?: { readonly colourwayCode: string; readonly size: string; readonly quantity: number; readonly released: number; readonly packed: number; readonly shipped: number; readonly returned: number } | null
  /** A lot: its item and what is on hand at its site, base unit. */
  readonly lot?: { readonly itemCode: string; readonly itemName: string; readonly uom: string; readonly onHand: string; readonly colourCode: string | null } | null
  readonly hideOnHand?: string | null
  readonly workOrder?: { readonly styleCode: string; readonly batchNumber: string | null; readonly status: string } | null
  readonly bundle?: { readonly quantity: number; readonly part: string | null } | null
  readonly shipment?: { readonly ddtNumbers: readonly string[]; readonly left: boolean } | null
  /** A customer or a supplier by name (null: no parties.view on it). */
  readonly partyName?: string | null
  /** A customer one of whose shipments carrying the goods left the site. */
  readonly received?: boolean
}

export interface ImpactEdge {
  readonly from: string
  readonly to: string
  readonly link: string
  readonly exact: boolean
  readonly quantity: string | null
  readonly uom: string | null
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const garmentsOf = (edges: readonly ImpactEdge[], to: string): number =>
  edges.filter((edge) => edge.to === to && edge.link === 'SHIPPED' && edge.quantity).reduce((sum, edge) => sum + Number.parseInt(new Dec(edge.quantity!).toDecimalPlaces(0).toFixed(0), 10), 0)

/** One hold a genealogy would place: one kind of record at one site, at most HOLD_LIMITS.subjects records. */
export interface PlannedHold {
  readonly subjectType: HoldSubjectType
  readonly siteId: string
  readonly companyId: string
  readonly ids: readonly string[]
  readonly codes: readonly string[]
}

/** What a hold group counts (QualityHoldGroup.counts): records held per kind, garments held, and the recall's facts. */
export const GROUP_COUNT_KEYS = ['Lot', 'Hide', 'WorkOrder', 'Bundle', 'GarmentSerial', 'Shipment', 'garments', 'shippedGarments', 'customers'] as const
export type GroupCountKey = (typeof GROUP_COUNT_KEYS)[number]
export type GroupCounts = Readonly<Record<GroupCountKey, number>>

export interface GenealogyPlan {
  readonly holds: readonly PlannedHold[]
  /** Picked bundles and garments of a work order held in the same plan (its hold covers them). */
  readonly covered: readonly string[]
  /** Picked records already on hold (left as they are). */
  readonly alreadyHeld: readonly string[]
  /** Picked records that cannot be held, each with its words (left out). */
  readonly refused: readonly { readonly key: string; readonly code: string | null; readonly hold: NodeHoldState; readonly words: string }[]
  readonly counts: GroupCounts
}

/**
 * The holds a set of ticked nodes makes (design qh-genealogy "Tick branches to hold"): each holdable node once, by kind
 * and site; a bundle or garment of a picked work order covered by it; nodes without a kind of hold (sizes, customers)
 * skipped silently (they are branches of the tree); shipped, hidden or unholdable ones said. The counts: what is held
 * (records per kind, garments) and what the whole tree says has left (garments shipped, customers who received them).
 */
export function genealogyPlan(nodes: readonly ImpactNode[], edges: readonly ImpactEdge[], picks: readonly string[]): GenealogyPlan {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const chosen: ImpactNode[] = []
  const alreadyHeld: string[] = []
  const refused: { key: string; code: string | null; hold: NodeHoldState; words: string }[] = []
  for (const key of sortedUnique(picks)) {
    const node = byKey.get(key)
    if (!node) {
      refused.push({ key, code: null, hold: 'NONE', words: 'Not in the trace any more: read it again.' })
      continue
    }
    if (node.hold === 'HOLDABLE' && node.siteId && node.companyId) chosen.push(node)
    else if (node.hold === 'HELD') alreadyHeld.push(key)
    else if (node.hold !== 'NONE') refused.push({ key, code: node.code, hold: node.hold, words: node.problem ?? 'Cannot be held.' })
  }
  const heldOrders = new Set(chosen.filter((node) => node.kind === 'WORK_ORDER').map((node) => node.id))
  const covered = chosen.filter((node) => (node.kind === 'BUNDLE' || node.kind === 'SERIAL') && node.workOrderId !== null && heldOrders.has(node.workOrderId)).map((node) => node.key)
  const coveredSet = new Set(covered)
  const kept = chosen.filter((node) => !coveredSet.has(node.key))

  const groups = new Map<string, ImpactNode[]>()
  for (const node of kept) {
    const group = `${node.holdKind}|${node.siteId}`
    groups.set(group, [...(groups.get(group) ?? []), node])
  }
  const order = (type: HoldSubjectType) => (Object.values(HOLD_KIND_OF) as HoldSubjectType[]).indexOf(type)
  const holds: PlannedHold[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '') || a.id.localeCompare(b.id))
    for (let index = 0; index < sorted.length; index += HOLD_LIMITS.subjects) {
      const part = sorted.slice(index, index + HOLD_LIMITS.subjects)
      holds.push({ subjectType: part[0]!.holdKind!, siteId: part[0]!.siteId!, companyId: part[0]!.companyId!, ids: part.map((node) => node.id), codes: part.map((node) => node.code ?? '—') })
    }
  }
  holds.sort((a, b) => order(a.subjectType) - order(b.subjectType) || a.siteId.localeCompare(b.siteId) || (a.codes[0] ?? '').localeCompare(b.codes[0] ?? ''))

  // Garments held: a work order's not yet gone, a bundle's, a garment, a shipment's from a work order not held here.
  const cells = nodes.filter((node) => node.kind === 'CELL' && node.cell)
  let garments = 0
  for (const node of kept) {
    if (node.kind === 'WORK_ORDER') garments += cells.filter((cell) => cell.workOrderId === node.id).reduce((sum, cell) => sum + Math.max(0, cell.cell!.quantity - cell.cell!.shipped), 0)
    else if (node.kind === 'BUNDLE') garments += node.bundle?.quantity ?? 0
    else if (node.kind === 'SERIAL') garments += 1
    else if (node.kind === 'SHIPMENT') {
      const fromHeld = edges.some((edge) => edge.to === node.key && edge.link === 'SHIPPED' && heldOrders.has(byKey.get(edge.from)?.workOrderId ?? ''))
      if (!fromHeld) garments += garmentsOf(edges, node.key)
    }
  }
  const count = (type: HoldSubjectType) => kept.filter((node) => node.holdKind === type).length
  const counts: GroupCounts = {
    Lot: count('Lot'),
    Hide: count('Hide'),
    WorkOrder: count('WorkOrder'),
    Bundle: count('Bundle'),
    GarmentSerial: count('GarmentSerial'),
    Shipment: count('Shipment'),
    garments,
    shippedGarments: cells.reduce((sum, cell) => sum + cell.cell!.shipped, 0),
    customers: nodes.filter((node) => node.kind === 'CUSTOMER' && node.received === true).length,
  }
  return { holds, covered, alreadyHeld, refused, counts }
}

/** "Hold 4 work orders and 126 garments; 18 garments already shipped to 2 customers." (English; the audit's words). */
export function genealogyWords(counts: GroupCounts): string {
  const held = (['Lot', 'Hide', 'WorkOrder', 'Bundle', 'GarmentSerial', 'Shipment'] as const)
    .filter((type) => counts[type] > 0 && type !== 'GarmentSerial')
    .map((type) => `${counts[type]} ${subjectNoun(type, counts[type])}`)
  if (counts.garments > 0) held.push(`${counts.garments} ${counts.garments === 1 ? 'garment' : 'garments'}`)
  const head = held.length > 0 ? `Hold ${held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}` : held[0]}` : 'Nothing to hold'
  const left = counts.shippedGarments > 0 ? `; ${counts.shippedGarments} ${counts.shippedGarments === 1 ? 'garment' : 'garments'} already shipped to ${counts.customers} ${counts.customers === 1 ? 'customer' : 'customers'}` : ''
  return `${head}${left}.`
}

/** An extended group's counts: the records and garments held add up; the recall's facts are the latest trace's. */
export function extendedCounts(before: Readonly<Partial<Record<string, number>>>, added: GroupCounts): GroupCounts {
  const prior = (key: GroupCountKey) => (typeof before[key] === 'number' && Number.isInteger(before[key]) && before[key]! >= 0 ? before[key]! : 0)
  return {
    Lot: prior('Lot') + added.Lot,
    Hide: prior('Hide') + added.Hide,
    WorkOrder: prior('WorkOrder') + added.WorkOrder,
    Bundle: prior('Bundle') + added.Bundle,
    GarmentSerial: prior('GarmentSerial') + added.GarmentSerial,
    Shipment: prior('Shipment') + added.Shipment,
    garments: prior('garments') + added.garments,
    shippedGarments: added.shippedGarments,
    customers: added.customers,
  }
}

/** The body's own rules of a hold by genealogy (the trace, the reason list and the rights are the command's). */
export function genealogyProblems(body: { readonly picks: readonly string[]; readonly reasonNote?: string | null; readonly note?: string | null; readonly expectedReleaseOn?: string | null }, today: string): Issue[] {
  const problems: Issue[] = []
  if (body.picks.length === 0) problems.push({ path: 'picks', message: 'Tick what to hold: one or more branches of the trace.' })
  else if (body.picks.length > GENEALOGY_PICK_LIMIT) problems.push({ path: 'picks', message: `At most ${GENEALOGY_PICK_LIMIT} records in one hold by genealogy.` })
  if (body.expectedReleaseOn && body.expectedReleaseOn < today) problems.push({ path: 'expectedReleaseOn', message: 'The expected release is today or later.' })
  if ((body.reasonNote ?? '').length > HOLD_LIMITS.reasonNote) problems.push({ path: 'reasonNote', message: `At most ${HOLD_LIMITS.reasonNote} characters.` })
  if ((body.note ?? '').length > HOLD_LIMITS.note) problems.push({ path: 'note', message: `At most ${HOLD_LIMITS.note} characters.` })
  return problems
}

/** The most nodes one hold by genealogy takes (and the most holds it may make: 20 holds of 100 records). */
export const GENEALOGY_PICK_LIMIT = 2000

/** The most records of one hold traced for its Affected tab (each a forward trace). */
export const AFFECTED_TRACE_LIMIT = 20

// ---- merging the traces of several records (a hold of 3 lots) -----------------------------------------------------------

export interface ImpactGraph {
  readonly starts: readonly string[]
  readonly nodes: readonly ImpactNode[]
  readonly edges: readonly ImpactEdge[]
  readonly gaps: readonly { readonly code: string; readonly severity: string; readonly at: string; readonly count: number }[]
}

const KIND_ORDER = new Map<string, number>(TRACE_NODE_KINDS.map((kind, index) => [kind, index]))

/** One graph of several forward traces: a node once (EXACT over POSSIBLE), an edge once, a gap once; nodes in tree order. */
export function mergeImpact(graphs: readonly ImpactGraph[]): ImpactGraph {
  const nodes = new Map<string, ImpactNode>()
  const edges = new Map<string, ImpactEdge>()
  const gaps = new Map<string, ImpactGraph['gaps'][number]>()
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const known = nodes.get(node.key)
      if (!known || (known.reach === 'POSSIBLE' && node.reach === 'EXACT')) nodes.set(node.key, node)
    }
    for (const edge of graph.edges) {
      const key = `${edge.from}|${edge.to}|${edge.link}`
      const known = edges.get(key)
      if (!known || (!known.exact && edge.exact)) edges.set(key, edge)
    }
    for (const gap of graph.gaps) gaps.set(`${gap.code}|${gap.at}`, gap)
  }
  return {
    starts: sortedUnique(graphs.flatMap((graph) => graph.starts)),
    nodes: [...nodes.values()].sort((a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || (a.code ?? '').localeCompare(b.code ?? '') || a.id.localeCompare(b.id)),
    edges: [...edges.values()],
    gaps: [...gaps.values()],
  }
}

/** Per kind of node: how many, exact and possible (the levels above the tree). */
export function impactLevels(nodes: readonly ImpactNode[]): { readonly kind: TraceNodeKind; readonly exact: number; readonly possible: number }[] {
  return TRACE_NODE_KINDS.flatMap((kind) => {
    const of = nodes.filter((node) => node.kind === kind)
    return of.length > 0 ? [{ kind, exact: of.filter((node) => node.reach === 'EXACT').length, possible: of.filter((node) => node.reach === 'POSSIBLE').length }] : []
  })
}

/** What a hold touches by state (design Hold › Affected "In stock · in work · packed · shipped (with customers)"). */
export interface ImpactStates {
  /** Material on hand at its site per base unit (lots; hides of a lot not in the tree are counted apart). */
  readonly material: readonly { readonly uom: string; readonly onHand: string }[]
  readonly hidesInStock: number
  readonly garments: { readonly inWork: number; readonly inStock: number; readonly packed: number; readonly shipped: number; readonly returned: number }
  readonly customers: number
}

const OPEN_ORDERS: readonly string[] = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD']

export function impactStates(nodes: readonly ImpactNode[]): ImpactStates {
  const material = new Map<string, Decimal>()
  for (const node of nodes) {
    if (node.kind !== 'LOT' || !node.lot) continue
    const amount = new Dec(node.lot.onHand)
    if (amount.gt(0)) material.set(node.lot.uom, (material.get(node.lot.uom) ?? ZERO).plus(amount))
  }
  const lotsInTree = nodes.some((node) => node.kind === 'LOT')
  const hidesInStock = lotsInTree ? 0 : nodes.filter((node) => node.kind === 'HIDE' && new Dec(node.hideOnHand ?? '0').gt(0)).length
  const orders = new Map(nodes.filter((node) => node.kind === 'WORK_ORDER').map((node) => [node.id, node.workOrder?.status ?? '']))
  const garments = { inWork: 0, inStock: 0, packed: 0, shipped: 0, returned: 0 }
  for (const node of nodes) {
    if (node.kind !== 'CELL' || !node.cell) continue
    const cell = node.cell
    if (OPEN_ORDERS.includes(orders.get(node.workOrderId ?? '') ?? '')) garments.inWork += Math.max(0, cell.quantity - cell.released)
    garments.inStock += Math.max(0, cell.released - cell.packed - cell.shipped)
    garments.packed += cell.packed
    garments.shipped += cell.shipped
    garments.returned += cell.returned
  }
  return {
    material: [...material.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([uom, amount]) => ({ uom, onHand: amount.toDecimalPlaces(4).toString() })),
    hidesInStock,
    garments,
    customers: nodes.filter((node) => node.kind === 'CUSTOMER' && node.received === true).length,
  }
}

// ---- the quarantine move (QHS-078) ---------------------------------------------------------------------------------------

/** A place code as a scanner reads it or a person types it: case, spaces and hyphens aside ("q-01" reads "Q01"). */
export const placeCodeKey = (code: string): string => code.toUpperCase().replace(/[\s_-]+/g, '')

/** The QUARANTINE place a typed or scanned code names among the site's places, or null. */
export function placeOfCode<P extends { readonly code: string }>(typed: string, places: readonly P[]): P | null {
  const key = placeCodeKey(typed)
  if (!key) return null
  return places.find((place) => placeCodeKey(place.code) === key) ?? null
}

/**
 * The kinds of places held stock leaves for quarantine (never our stock at an outside workshop, a customer's or in transit: it
 * is not here). B-W2b-292: the pick faces and bulk racks of B-W2b-277 are store places too (the tablet's quarantine scan moves
 * what lies there).
 */
export const QUARANTINE_FROM_KINDS: readonly string[] = Object.freeze(['WAREHOUSE', 'ZONE', 'BIN', 'RECEIVING', 'QUARANTINE', 'PRODUCTION', 'SHIPPING', 'FINISHED_GOODS', 'PICK_FACE', 'BULK'])

export interface HeldBalance {
  readonly locationId: string
  readonly locationKind: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  /** On hand, base unit, a decimal string above 0. */
  readonly onHand: string
}

/** The transfers that put held stock into the place: every balance not there already and not at an outside workshop. */
export function quarantineTransfers(balances: readonly HeldBalance[], placeId: string): { readonly moves: readonly HeldBalance[]; readonly stays: readonly HeldBalance[] } {
  const moves: HeldBalance[] = []
  const stays: HeldBalance[] = []
  for (const balance of balances) {
    if (balance.locationId === placeId || !new Dec(balance.onHand).gt(0)) continue
    if (QUARANTINE_FROM_KINDS.includes(balance.locationKind)) moves.push(balance)
    else stays.push(balance)
  }
  return { moves, stays }
}
