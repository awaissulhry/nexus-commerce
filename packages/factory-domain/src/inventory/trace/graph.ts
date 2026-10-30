import { workOrderUses, type TraceMove } from '../../quality/lab/trace'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../ledger/moves'
import {
  HOLD_SUBJECT_OF,
  LEFT_SHIPMENT_STATUSES,
  nodeKey,
  TRACE_GAP_SEVERITY,
  TRACE_NODE_KINDS,
  TRACE_SERIAL_NODE_LIMIT,
  traceGapMessage,
  type TraceDirection,
  type TraceGapCode,
  type TraceGapSeverity,
  type TraceLink,
  type TraceNodeKind,
  type TraceReach,
  type TraceSide,
  type TraceStartKind,
} from './rules'

/**
 * The trace graph (B-W2a-27; SCM-240, SCM-241), pure: given the rows the API read around a start (TraceFacts), the nodes
 * reached backward (to the supplier's lot) and forward (to the customer), the recorded edges between them, how sure each
 * node is (EXACT or POSSIBLE, rules.ts) and the gaps in words.
 *
 * Backward from a garment serial: its bundle → the live cut log entries the bundle names → their hides → lots →
 * receipts → suppliers (EXACT); its work order's material issued by quantity (lining, protectors, trims) is POSSIBLE.
 * Forward from a lot: its hides → the work orders they were issued to → the bundles naming their cuts → the serials of
 * those bundles → shipments → customers (EXACT); a lot issued by quantity reaches its work orders EXACT and their
 * garments POSSIBLE. A work order (its batch) is whole: forward every garment and shipment, backward every lot issued.
 * A bundle names every live cut of its cell (B-W1-41's genealogy rule), so the hides it names are the ones its cell
 * used; a split bundle copies its parent's cuts. A batch-tracked style ships by size: a shipment line names the cell, not
 * the bundle. Cancelled shipments, void bundles and void serials carry nothing. Nothing here reads a cost, a price or a
 * worker.
 */

export interface TraceParty {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly name: string
}

export interface TraceLotFact {
  readonly id: string
  readonly code: string
  readonly companyId: string
  readonly siteId: string
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly baseUom: string; readonly tracking: string }
  readonly colourCode: string | null
  readonly supplierId: string | null
  readonly supplierLotRef: string | null
  readonly dyeBatch: string | null
  /** The goods receipt it came with; null for opening stock (B-W1-35). */
  readonly receiptId: string | null
  readonly purchaseOrder: { readonly id: string; readonly number: string; readonly lineSeq: number | null } | null
  readonly receivedAt: string | null
  readonly qualityStatus: string
  readonly crVi: { readonly status: string; readonly valueMgKg: string | null; readonly limitMgKg: string | null }
  /** Lab results recorded and ACTIVE documents of the lot. */
  readonly labResults: number
  readonly documents: number
  /** The site's ledger: on hand now and taken out as scrap (less reversals), base unit. */
  readonly onHand: string
  readonly scrapped: string
}

export interface TraceHideFact {
  readonly id: string
  readonly code: string
  readonly lotId: string
  readonly state: string
  readonly baseArea: string
  readonly onHand: string
}

export interface TraceReceiptFact {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly receivedAt: string
  readonly supplierId: string
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: string | null
}

/** An ISSUE or RETURN of the ledger naming a work order (and its reversals). */
export interface TraceIssueFact extends TraceMove {
  readonly lotId: string | null
}

export interface TraceWorkOrderFact {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly number: string
  readonly batchNumber: string | null
  readonly status: string
  readonly kind: string
  readonly styleCode: string
  /** How its style traces garments (Q31): BATCH (the batch number on every label) or SERIAL (one serial per garment). */
  readonly tracking: 'BATCH' | 'SERIAL'
  /** Garments received into finished-goods stock (PRODUCTION_RECEIPT less reversals). */
  readonly finishedReceived: number
}

export interface TraceCellFact {
  readonly id: string
  readonly workOrderId: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
  /** Released less reversed. */
  readonly released: number
}

export interface TraceCutFact {
  readonly id: string
  readonly workOrderId: string
  readonly hideId: string
  readonly lotId: string
  readonly baseAreaUsed: string
  readonly pieces: number
  /** Not a reversal and not reversed. */
  readonly live: boolean
}

export interface TraceBundleFact {
  readonly id: string
  readonly code: string
  readonly workOrderId: string
  readonly cellId: string
  readonly quantity: number
  readonly part: string | null
  readonly status: string
  readonly cutLogIds: readonly string[]
  readonly parentBundleId: string | null
}

export interface TraceSerialFact {
  readonly id: string
  readonly serial: string
  readonly workOrderId: string
  readonly cellId: string
  readonly bundleId: string | null
  readonly status: string
  readonly shipmentLineId: string | null
}

export interface TraceShipmentLineFact {
  readonly id: string
  readonly shipmentId: string
  readonly workOrderId: string
  readonly cellId: string
  readonly quantity: number
}

export interface TraceShipmentFact {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly number: string
  readonly status: string
  readonly partyId: string
  readonly shippedAt: string | null
  readonly deliveredAt: string | null
  /** The DDTs that carry it, not cancelled. */
  readonly ddtNumbers: readonly string[]
}

export interface TraceSubcontractFact {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly partyId: string
  readonly workOrderId: string
  /** Its kit lines that name a lot (PLANNED lines before the pick name none). */
  readonly kit: readonly { readonly lotId: string; readonly hideId: string | null; readonly baseQuantity: string; readonly status: string }[]
}

export interface TraceHoldFact {
  readonly id: string
  readonly subjectType: string
  readonly subjectIds: readonly string[]
  readonly reasonCode: string
  readonly placedAt: string
}

export interface TraceFacts {
  readonly lots: readonly TraceLotFact[]
  readonly hides: readonly TraceHideFact[]
  readonly receipts: readonly TraceReceiptFact[]
  readonly parties: readonly TraceParty[]
  readonly issues: readonly TraceIssueFact[]
  readonly workOrders: readonly TraceWorkOrderFact[]
  readonly cells: readonly TraceCellFact[]
  readonly cuts: readonly TraceCutFact[]
  readonly bundles: readonly TraceBundleFact[]
  readonly serials: readonly TraceSerialFact[]
  readonly lines: readonly TraceShipmentLineFact[]
  readonly shipments: readonly TraceShipmentFact[]
  readonly subcontracts: readonly TraceSubcontractFact[]
  readonly holds: readonly TraceHoldFact[]
}

export interface TraceStart {
  readonly kind: TraceStartKind
  readonly id: string
}

// ---- the answer ---------------------------------------------------------------------------------------------------------

export interface TraceNodeView {
  readonly key: string
  readonly kind: TraceNodeKind
  readonly id: string
  /** What a person reads: lot code, hide tag, receipt or work order number, "BLK 52", bundle code, serial, party code. */
  readonly code: string
  readonly reach: TraceReach
  readonly sides: readonly TraceSide[]
  /** ACTIVE quality holds that name it. */
  readonly holds: readonly { readonly id: string; readonly reasonCode: string; readonly placedAt: string }[]
  readonly party?: TraceParty
  readonly receipt?: Omit<TraceReceiptFact, 'id' | 'number' | 'supplierId'>
  readonly lot?: Omit<TraceLotFact, 'id' | 'code' | 'supplierId' | 'receiptId'>
  readonly hide?: Omit<TraceHideFact, 'id' | 'code'>
  readonly subcontract?: { readonly status: string; readonly partyId: string; readonly workOrderId: string }
  readonly workOrder?: Omit<TraceWorkOrderFact, 'id' | 'number'>
  readonly cell?: Omit<TraceCellFact, 'id'> & { readonly serials: Readonly<Record<string, number>>; readonly packed: number; readonly shipped: number; readonly returned: number }
  readonly bundle?: Omit<TraceBundleFact, 'id' | 'code' | 'cutLogIds'> & { readonly cuts: number; readonly serials: number }
  readonly serial?: Omit<TraceSerialFact, 'id' | 'serial'>
  readonly shipment?: Omit<TraceShipmentFact, 'id' | 'number'> & { readonly left: boolean }
  /** A customer: one of its shipments that carry the goods left the site. */
  readonly received?: boolean
}

export interface TraceEdgeView {
  readonly from: string
  readonly to: string
  readonly link: TraceLink
  /** A record links the two (false: inferred through the work order or the size, see the gaps). */
  readonly exact: boolean
  /** The base unit's quantity for material (ISSUED, KIT, CUT area), garments for SHIPPED, else null. */
  readonly quantity: string | null
  readonly uom: string | null
}

export interface TraceGapView {
  readonly code: TraceGapCode
  readonly severity: TraceGapSeverity
  readonly at: string
  readonly count: number
  readonly message: string
}

export interface TraceLevel {
  readonly kind: TraceNodeKind
  readonly exact: number
  readonly possible: number
}

export interface TraceGraph {
  readonly start: string
  readonly direction: TraceDirection
  readonly nodes: readonly TraceNodeView[]
  readonly edges: readonly TraceEdgeView[]
  /** Per kind, in tree order: how many nodes, exact and possible. */
  readonly levels: readonly TraceLevel[]
  readonly gaps: readonly TraceGapView[]
  /** Customers one of whose shipments that carry the goods left the site (EXACT and POSSIBLE). */
  readonly customersReceived: { readonly exact: number; readonly possible: number }
}

// ---- the walk -----------------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<TraceReach, number>> = { POSSIBLE: 0, EXACT: 1 }
const weakest = (a: TraceReach, b: TraceReach): TraceReach => (a === 'EXACT' && b === 'EXACT' ? 'EXACT' : 'POSSIBLE')
const fixed = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const sum = (values: readonly string[]): Decimal => values.reduce<Decimal>((total, value) => total.plus(new Dec(value)), ZERO)

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const value = key(row)
    if (value === null) continue
    const list = map.get(value) ?? []
    list.push(row)
    map.set(value, list)
  }
  return map
}
const byId = <T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> => new Map(rows.map((row) => [row.id, row]))

/** Backward from a work order: WHOLE (the batch itself), PART (a garment or bundle of it), PART_LOST (a part whose cuts are unknown). */
type WorkOrderMode = 'WHOLE' | 'PART' | 'PART_LOST'
const MODE_RANK: Readonly<Record<WorkOrderMode, number>> = { PART: 0, PART_LOST: 1, WHOLE: 2 }

class Index {
  readonly lots: Map<string, TraceLotFact>
  readonly hides: Map<string, TraceHideFact>
  readonly receipts: Map<string, TraceReceiptFact>
  readonly parties: Map<string, TraceParty>
  readonly workOrders: Map<string, TraceWorkOrderFact>
  readonly cells: Map<string, TraceCellFact>
  readonly cuts: Map<string, TraceCutFact>
  readonly bundles: Map<string, TraceBundleFact>
  readonly serials: Map<string, TraceSerialFact>
  readonly lines: Map<string, TraceShipmentLineFact>
  readonly shipments: Map<string, TraceShipmentFact>
  readonly subcontracts: Map<string, TraceSubcontractFact>
  readonly hidesOfLot: Map<string, TraceHideFact[]>
  readonly issuesOfLot: Map<string, TraceIssueFact[]>
  readonly issuesOfHide: Map<string, TraceIssueFact[]>
  readonly issuesOfWorkOrder: Map<string, TraceIssueFact[]>
  readonly cellsOfWorkOrder: Map<string, TraceCellFact[]>
  readonly cutsOfHide: Map<string, TraceCutFact[]>
  readonly cutsOfWorkOrder: Map<string, TraceCutFact[]>
  readonly bundlesOfCell: Map<string, TraceBundleFact[]>
  readonly bundlesOfCut: Map<string, TraceBundleFact[]>
  readonly childrenOf: Map<string, TraceBundleFact[]>
  readonly serialsOfBundle: Map<string, TraceSerialFact[]>
  readonly serialsOfCell: Map<string, TraceSerialFact[]>
  readonly serialsOfLine: Map<string, TraceSerialFact[]>
  readonly linesOfCell: Map<string, TraceShipmentLineFact[]>
  readonly linesOfShipment: Map<string, TraceShipmentLineFact[]>
  readonly subcontractsOfWorkOrder: Map<string, TraceSubcontractFact[]>
  readonly holdsOf: Map<string, TraceHoldFact[]>

  constructor(facts: TraceFacts) {
    const shipments = facts.shipments.filter((shipment) => shipment.status !== 'CANCELLED')
    const liveShipments = new Set(shipments.map((shipment) => shipment.id))
    const lines = facts.lines.filter((line) => liveShipments.has(line.shipmentId))
    const bundles = facts.bundles.filter((bundle) => bundle.status !== 'VOID')
    const serials = facts.serials.filter((serial) => serial.status !== 'VOID')
    this.lots = byId(facts.lots)
    this.hides = byId(facts.hides)
    this.receipts = byId(facts.receipts)
    this.parties = byId(facts.parties)
    this.workOrders = byId(facts.workOrders)
    this.cells = byId(facts.cells)
    this.cuts = byId(facts.cuts)
    this.bundles = byId(bundles)
    this.serials = byId(serials)
    this.lines = byId(lines)
    this.shipments = byId(shipments)
    this.subcontracts = byId(facts.subcontracts)
    this.hidesOfLot = groupBy(facts.hides, (hide) => hide.lotId)
    this.issuesOfLot = groupBy(facts.issues, (move) => (move.hideId === null ? move.lotId : null))
    this.issuesOfHide = groupBy(facts.issues, (move) => move.hideId)
    this.issuesOfWorkOrder = groupBy(facts.issues, (move) => move.workOrderId)
    this.cellsOfWorkOrder = groupBy(facts.cells, (cell) => cell.workOrderId)
    const live = facts.cuts.filter((cut) => cut.live)
    this.cutsOfHide = groupBy(live, (cut) => cut.hideId)
    this.cutsOfWorkOrder = groupBy(live, (cut) => cut.workOrderId)
    this.bundlesOfCell = groupBy(bundles, (bundle) => bundle.cellId)
    this.bundlesOfCut = new Map()
    for (const bundle of bundles) {
      for (const cutId of new Set(bundle.cutLogIds)) {
        const list = this.bundlesOfCut.get(cutId) ?? []
        list.push(bundle)
        this.bundlesOfCut.set(cutId, list)
      }
    }
    this.childrenOf = groupBy(bundles, (bundle) => bundle.parentBundleId)
    this.serialsOfBundle = groupBy(serials, (serial) => serial.bundleId)
    this.serialsOfCell = groupBy(serials, (serial) => serial.cellId)
    this.serialsOfLine = groupBy(serials, (serial) => (serial.shipmentLineId && this.lines.has(serial.shipmentLineId) ? serial.shipmentLineId : null))
    this.linesOfCell = groupBy(lines, (line) => line.cellId)
    this.linesOfShipment = groupBy(lines, (line) => line.shipmentId)
    this.subcontractsOfWorkOrder = groupBy(facts.subcontracts, (order) => order.workOrderId)
    this.holdsOf = new Map()
    for (const hold of facts.holds) {
      for (const subjectId of hold.subjectIds) {
        const key = `${hold.subjectType}:${subjectId}`
        const list = this.holdsOf.get(key) ?? []
        list.push(hold)
        this.holdsOf.set(key, list)
      }
    }
  }

  /** The live cut log entries a bundle names (a split bundle carries its parent's). */
  liveCutsOf(bundle: TraceBundleFact): TraceCutFact[] {
    return [...new Set(bundle.cutLogIds)].map((id) => this.cuts.get(id)).filter((cut): cut is TraceCutFact => cut !== undefined && cut.live)
  }

  /** A cell's garments on one shipment, and how many of them carry a serial on record. */
  onShipment(cellId: string, shipmentId: string): { garments: number; withSerial: number } {
    const lines = (this.linesOfCell.get(cellId) ?? []).filter((line) => line.shipmentId === shipmentId)
    return {
      garments: lines.reduce((total, line) => total + line.quantity, 0),
      withSerial: lines.reduce((total, line) => total + (this.serialsOfLine.get(line.id)?.length ?? 0), 0),
    }
  }
}

interface NodeState {
  readonly kind: TraceNodeKind
  readonly id: string
  reach: TraceReach
  readonly sides: Set<TraceSide>
}

class Walk {
  private readonly nodes = new Map<string, NodeState>()
  private readonly edges = new Map<string, TraceEdgeView>()
  private readonly gaps = new Map<string, { code: TraceGapCode; at: string; count: number }>()
  private readonly visited = new Map<string, [number, number][]>()
  private side: TraceSide = 'BACKWARD'

  constructor(
    private readonly index: Index,
    private readonly startKey: string,
  ) {}

  run(side: TraceSide, walk: () => void): void {
    this.side = side
    walk()
  }

  /** True when this handler has not yet run for the record at this reach and mode, or at a stronger one of both: run it. */
  private first(handler: string, id: string, reach: TraceReach, mode = 0): boolean {
    const key = `${handler}|${id}`
    const runs = this.visited.get(key) ?? []
    if (runs.some(([rank, done]) => rank >= RANK[reach] && done >= mode)) return false
    runs.push([RANK[reach], mode])
    this.visited.set(key, runs)
    return true
  }

  mark(kind: TraceNodeKind, id: string, reach: TraceReach): string {
    const key = nodeKey(kind, id)
    const node = this.nodes.get(key)
    if (node) {
      if (RANK[reach] > RANK[node.reach]) node.reach = reach
      if (key !== this.startKey) node.sides.add(this.side)
    } else {
      this.nodes.set(key, { kind, id, reach: key === this.startKey ? 'EXACT' : reach, sides: new Set([key === this.startKey ? 'START' : this.side]) })
    }
    return key
  }

  edge(from: string, to: string, link: TraceLink, exact: boolean, quantity: string | null = null, uom: string | null = null): void {
    const key = `${from}|${to}|${link}`
    const known = this.edges.get(key)
    if (!known || (exact && !known.exact)) this.edges.set(key, { from, to, link, exact, quantity, uom })
  }

  gap(code: TraceGapCode, at: string, count = 1): void {
    const key = `${code}|${at}`
    const known = this.gaps.get(key)
    this.gaps.set(key, { code, at, count: Math.max(count, known?.count ?? 0) })
  }

  // ---- forward: where it went -------------------------------------------------------------------------------------------

  forwardLot(lotId: string, reach: TraceReach): void {
    const lot = this.index.lots.get(lotId)
    if (!lot || !this.first('fLot', lotId, reach)) return
    const key = this.mark('LOT', lotId, reach)
    for (const hide of this.index.hidesOfLot.get(lotId) ?? []) {
      this.edge(key, this.mark('HIDE', hide.id, reach), 'HIDE_OF', true)
      this.forwardHide(hide.id, reach)
    }
    const uses = workOrderUses(this.index.issuesOfLot.get(lotId) ?? [])
    for (const use of uses) {
      if (!this.index.workOrders.has(use.workOrderId)) continue
      this.edge(key, this.mark('WORK_ORDER', use.workOrderId, reach), 'ISSUED', true, use.issued, lot.item.baseUom)
      this.forwardWorkOrder(use.workOrderId, reach, 'POSSIBLE')
    }
    if (uses.length > 0) this.gap('ISSUED_BY_QUANTITY', key, uses.length)
    this.forwardKits(key, lot.item.baseUom, reach, (line) => line.lotId === lotId && line.hideId === null)
  }

  forwardHide(hideId: string, reach: TraceReach): void {
    const hide = this.index.hides.get(hideId)
    if (!hide || !this.first('fHide', hideId, reach)) return
    const key = this.mark('HIDE', hideId, reach)
    const uom = this.index.lots.get(hide.lotId)?.item.baseUom ?? null
    const cuts = this.index.cutsOfHide.get(hideId) ?? []
    const uses = workOrderUses(this.index.issuesOfHide.get(hideId) ?? [])
    const workOrders = new Set([...uses.map((use) => use.workOrderId), ...cuts.map((cut) => cut.workOrderId)])
    let notCut = 0
    for (const workOrderId of workOrders) {
      if (!this.index.workOrders.has(workOrderId)) continue
      const issued = uses.find((use) => use.workOrderId === workOrderId)?.issued ?? null
      this.edge(key, this.mark('WORK_ORDER', workOrderId, reach), 'ISSUED', true, issued, uom)
      this.forwardWorkOrder(workOrderId, reach, null)
      if (!cuts.some((cut) => cut.workOrderId === workOrderId)) notCut += 1
    }
    if (notCut > 0) this.gap('ISSUED_NOT_CUT', key, notCut)
    let unbundled = 0
    for (const cut of cuts) {
      const bundles = (this.index.bundlesOfCut.get(cut.id) ?? []).filter((bundle) => bundle.parentBundleId === null || !this.index.bundles.has(bundle.parentBundleId))
      if (bundles.length === 0) unbundled += 1
      for (const bundle of bundles) {
        const area = sum(this.index.liveCutsOf(bundle).filter((named) => named.hideId === hideId).map((named) => named.baseAreaUsed))
        this.edge(key, this.mark('BUNDLE', bundle.id, reach), 'CUT', true, fixed(area), uom)
        this.forwardBundle(bundle.id, reach, 'CUT')
      }
    }
    if (unbundled > 0) this.gap('CUT_NOT_BUNDLED', key, unbundled)
    this.forwardKits(key, uom, reach, (line) => line.hideId === hideId)
  }

  private forwardKits(from: string, uom: string | null, reach: TraceReach, sent: (line: TraceSubcontractFact['kit'][number]) => boolean): void {
    for (const order of this.index.subcontracts.values()) {
      const lines = order.kit.filter(sent)
      if (lines.length === 0) continue
      this.edge(from, this.mark('SUBCONTRACT', order.id, reach), 'KIT', true, fixed(sum(lines.map((line) => line.baseQuantity))), uom)
      this.forwardSubcontract(order.id, reach)
    }
  }

  forwardSubcontract(orderId: string, reach: TraceReach): void {
    const order = this.index.subcontracts.get(orderId)
    if (!order || !this.first('fSub', orderId, reach)) return
    const key = this.mark('SUBCONTRACT', orderId, reach)
    if (!this.index.workOrders.has(order.workOrderId)) return
    this.edge(key, this.mark('WORK_ORDER', order.workOrderId, 'POSSIBLE'), 'WORKED_FOR', false)
    this.gap('SUBCONTRACT_RETURN', key)
    this.forwardWorkOrder(order.workOrderId, 'POSSIBLE', 'POSSIBLE')
  }

  /** `content`: how sure its garments are (EXACT for the batch itself, POSSIBLE for material issued by quantity); null: none of them. */
  forwardWorkOrder(workOrderId: string, reach: TraceReach, content: TraceReach | null): void {
    if (!this.index.workOrders.has(workOrderId)) return
    const key = this.mark('WORK_ORDER', workOrderId, reach)
    if (content === null) return
    const garments = weakest(reach, content)
    if (!this.first('fWo', workOrderId, garments)) return
    for (const cell of this.index.cellsOfWorkOrder.get(workOrderId) ?? []) {
      this.edge(key, this.mark('CELL', cell.id, garments), 'SIZE', true)
      this.forwardWholeCell(cell.id, garments)
    }
  }

  /** Every garment of the cell is concerned: all its bundles, its serials and its shipments. */
  forwardWholeCell(cellId: string, reach: TraceReach): void {
    if (!this.first('fCell', cellId, reach)) return
    const key = this.mark('CELL', cellId, reach)
    for (const bundle of this.index.bundlesOfCell.get(cellId) ?? []) {
      if (bundle.parentBundleId !== null && this.index.bundles.has(bundle.parentBundleId)) continue
      this.edge(key, this.mark('BUNDLE', bundle.id, reach), 'BUNDLED', true)
      this.forwardBundle(bundle.id, reach, 'CELL')
    }
    for (const serial of this.index.serialsOfCell.get(cellId) ?? []) {
      if (serial.bundleId !== null && this.index.bundles.has(serial.bundleId)) continue
      this.edge(key, this.mark('SERIAL', serial.id, reach), 'SERIAL', true)
      this.forwardSerial(serial.id, reach)
    }
    const shipments = new Set((this.index.linesOfCell.get(cellId) ?? []).map((line) => line.shipmentId))
    for (const shipmentId of shipments) {
      this.edge(key, this.mark('SHIPMENT', shipmentId, reach), 'SHIPPED', true, String(this.index.onShipment(cellId, shipmentId).garments), 'PCS')
      this.forwardShipment(shipmentId, reach)
    }
  }

  /**
   * `via`: CUT (a hide's cut: its work order and cell are shown above it, and the cell's shipments it may be on below),
   * START (the bundle traced: the same shipments), CELL (its whole cell is traced) or SPLIT (its parent's walk covers the
   * cell).
   */
  forwardBundle(bundleId: string, reach: TraceReach, via: 'CUT' | 'START' | 'CELL' | 'SPLIT'): void {
    const bundle = this.index.bundles.get(bundleId)
    if (!bundle || !this.first(`fBundle:${via}`, bundleId, reach)) return
    const key = this.mark('BUNDLE', bundleId, reach)
    if (via === 'CUT' && this.index.workOrders.has(bundle.workOrderId) && this.index.cells.has(bundle.cellId)) {
      const workOrder = this.mark('WORK_ORDER', bundle.workOrderId, reach)
      const cell = this.mark('CELL', bundle.cellId, reach)
      this.edge(workOrder, cell, 'SIZE', true)
      this.edge(cell, key, 'BUNDLED', true)
    }
    for (const child of this.index.childrenOf.get(bundleId) ?? []) {
      this.edge(key, this.mark('BUNDLE', child.id, reach), 'SPLIT', true)
      this.forwardBundle(child.id, reach, via === 'CELL' ? 'CELL' : 'SPLIT')
    }
    for (const serial of this.index.serialsOfBundle.get(bundleId) ?? []) {
      this.edge(key, this.mark('SERIAL', serial.id, reach), 'SERIAL', true)
      this.forwardSerial(serial.id, reach)
    }
    if (via === 'CUT' || via === 'START') this.forwardPartOfCell(bundle, key)
  }

  /** A bundle's cell is only partly traced: the garments the records cannot tie to a bundle, and the shipments by size. */
  private forwardPartOfCell(bundle: TraceBundleFact, key: string): void {
    const workOrder = this.index.workOrders.get(bundle.workOrderId)
    if (!workOrder) return
    const lines = this.index.linesOfCell.get(bundle.cellId) ?? []
    if (workOrder.tracking === 'SERIAL') {
      const loose = (this.index.serialsOfCell.get(bundle.cellId) ?? []).filter((serial) => serial.bundleId === null || !this.index.bundles.has(serial.bundleId))
      for (const serial of loose) {
        this.edge(key, this.mark('SERIAL', serial.id, 'POSSIBLE'), 'SERIAL', false)
        this.forwardSerial(serial.id, 'POSSIBLE')
      }
      if (loose.length > 0) this.gap('SERIAL_WITHOUT_BUNDLE', nodeKey('CELL', bundle.cellId), loose.length)
      for (const shipmentId of new Set(lines.map((line) => line.shipmentId))) {
        const on = this.index.onShipment(bundle.cellId, shipmentId)
        if (on.garments <= on.withSerial) continue
        const shipment = this.mark('SHIPMENT', shipmentId, 'POSSIBLE')
        this.edge(key, shipment, 'SHIPPED', false, String(on.garments - on.withSerial), 'PCS')
        this.gap('LINE_WITHOUT_SERIALS', shipment, on.garments - on.withSerial)
        this.forwardShipment(shipmentId, 'POSSIBLE')
      }
    } else if (lines.length > 0) {
      for (const shipmentId of new Set(lines.map((line) => line.shipmentId))) {
        this.edge(key, this.mark('SHIPMENT', shipmentId, 'POSSIBLE'), 'SHIPPED', false, String(this.index.onShipment(bundle.cellId, shipmentId).garments), 'PCS')
        this.forwardShipment(shipmentId, 'POSSIBLE')
      }
      this.gap('BATCH_TRACKED', nodeKey('WORK_ORDER', workOrder.id))
    }
  }

  forwardSerial(serialId: string, reach: TraceReach): void {
    const serial = this.index.serials.get(serialId)
    if (!serial || !this.first('fSerial', serialId, reach)) return
    const key = this.mark('SERIAL', serialId, reach)
    const line = serial.shipmentLineId ? this.index.lines.get(serial.shipmentLineId) : undefined
    if (!line) return
    this.edge(key, this.mark('SHIPMENT', line.shipmentId, reach), 'SHIPPED', true, '1', 'PCS')
    this.forwardShipment(line.shipmentId, reach)
  }

  forwardShipment(shipmentId: string, reach: TraceReach): void {
    const shipment = this.index.shipments.get(shipmentId)
    if (!shipment || !this.first('fShipment', shipmentId, reach)) return
    const key = this.mark('SHIPMENT', shipmentId, reach)
    this.edge(key, this.mark('CUSTOMER', shipment.partyId, reach), 'DELIVERED_TO', true)
  }

  // ---- backward: where it came from -------------------------------------------------------------------------------------

  backwardShipment(shipmentId: string, reach: TraceReach): void {
    const shipment = this.index.shipments.get(shipmentId)
    if (!shipment || !this.first('bShipment', shipmentId, reach)) return
    const key = this.mark('SHIPMENT', shipmentId, reach)
    for (const cellId of new Set((this.index.linesOfShipment.get(shipmentId) ?? []).map((line) => line.cellId))) {
      const cell = this.index.cells.get(cellId)
      if (!cell) continue
      const on = this.index.onShipment(cellId, shipmentId)
      const cellKey = this.mark('CELL', cellId, reach)
      this.edge(cellKey, key, 'SHIPPED', true, String(on.garments), 'PCS')
      this.backwardCell(cellId, reach)
      for (const line of (this.index.linesOfShipment.get(shipmentId) ?? []).filter((row) => row.cellId === cellId)) {
        for (const serial of this.index.serialsOfLine.get(line.id) ?? []) {
          this.edge(this.mark('SERIAL', serial.id, reach), key, 'SHIPPED', true, '1', 'PCS')
          this.backwardSerial(serial.id, reach)
        }
      }
      if (on.garments > on.withSerial) {
        // Garments the records know only by their size: any bundle of the cell may have made them.
        const workOrder = this.index.workOrders.get(cell.workOrderId)
        if (workOrder?.tracking === 'SERIAL') this.gap('LINE_WITHOUT_SERIALS', key, on.garments - on.withSerial)
        else this.gap('BATCH_TRACKED', nodeKey('WORK_ORDER', cell.workOrderId))
        this.backwardBundlesOfCell(cellId, cellKey)
      }
    }
  }

  backwardSerial(serialId: string, reach: TraceReach): void {
    const serial = this.index.serials.get(serialId)
    if (!serial || !this.first('bSerial', serialId, reach)) return
    const key = this.mark('SERIAL', serialId, reach)
    const bundle = serial.bundleId ? this.index.bundles.get(serial.bundleId) : undefined
    if (bundle) {
      this.edge(this.mark('BUNDLE', bundle.id, reach), key, 'SERIAL', true)
      this.backwardBundle(bundle.id, reach)
      return
    }
    if (!this.index.cells.has(serial.cellId)) return
    const cellKey = this.mark('CELL', serial.cellId, reach)
    this.edge(cellKey, key, 'SERIAL', true)
    this.backwardCell(serial.cellId, reach)
    this.gap('SERIAL_WITHOUT_BUNDLE', cellKey, (this.index.serialsOfCell.get(serial.cellId) ?? []).filter((row) => row.bundleId === null).length)
    this.backwardBundlesOfCell(serial.cellId, cellKey)
  }

  /** The bundles of a cell, any of which may have made the garments (POSSIBLE); without any, the work order's hides. */
  private backwardBundlesOfCell(cellId: string, cellKey: string): void {
    const bundles = this.index.bundlesOfCell.get(cellId) ?? []
    for (const bundle of bundles) {
      this.edge(cellKey, this.mark('BUNDLE', bundle.id, 'POSSIBLE'), 'BUNDLED', true)
      this.backwardBundle(bundle.id, 'POSSIBLE')
    }
    const cell = this.index.cells.get(cellId)
    if (bundles.length === 0 && cell) this.backwardWorkOrder(cell.workOrderId, 'POSSIBLE', 'PART_LOST')
  }

  backwardBundle(bundleId: string, reach: TraceReach): void {
    const bundle = this.index.bundles.get(bundleId)
    if (!bundle || !this.first('bBundle', bundleId, reach)) return
    const key = this.mark('BUNDLE', bundleId, reach)
    if (this.index.cells.has(bundle.cellId)) {
      this.edge(this.mark('CELL', bundle.cellId, reach), key, 'BUNDLED', true)
      this.backwardCell(bundle.cellId, reach)
    }
    const parent = bundle.parentBundleId ? this.index.bundles.get(bundle.parentBundleId) : undefined
    if (parent) {
      this.edge(this.mark('BUNDLE', parent.id, reach), key, 'SPLIT', true)
      this.backwardBundle(parent.id, reach)
    }
    const cuts = this.index.liveCutsOf(bundle)
    for (const hideId of new Set(cuts.map((cut) => cut.hideId))) {
      const hide = this.index.hides.get(hideId)
      if (!hide) continue
      const uom = this.index.lots.get(hide.lotId)?.item.baseUom ?? null
      this.edge(this.mark('HIDE', hideId, reach), key, 'CUT', true, fixed(sum(cuts.filter((cut) => cut.hideId === hideId).map((cut) => cut.baseAreaUsed))), uom)
      this.backwardHide(hideId, reach)
    }
    if (cuts.length === 0) {
      this.gap('BUNDLE_WITHOUT_CUTS', key)
      this.backwardWorkOrder(bundle.workOrderId, 'POSSIBLE', 'PART_LOST')
    }
  }

  /** A cell's work order holds it; the work order's material issued by quantity may be in it. */
  private backwardCell(cellId: string, reach: TraceReach): void {
    const cell = this.index.cells.get(cellId)
    if (!cell || !this.index.workOrders.has(cell.workOrderId)) return
    this.edge(this.mark('WORK_ORDER', cell.workOrderId, reach), this.mark('CELL', cellId, reach), 'SIZE', true)
    this.backwardWorkOrder(cell.workOrderId, reach, 'PART')
  }

  backwardWorkOrder(workOrderId: string, reach: TraceReach, mode: WorkOrderMode): void {
    if (!this.index.workOrders.has(workOrderId) || !this.first('bWo', workOrderId, reach, MODE_RANK[mode])) return
    const key = this.mark('WORK_ORDER', workOrderId, reach)
    const material = mode === 'WHOLE' ? reach : 'POSSIBLE'
    const issues = this.index.issuesOfWorkOrder.get(workOrderId) ?? []
    // Lining, protectors, trims: issued by quantity to the whole work order.
    const byLot = groupBy(
      issues.filter((move) => move.hideId === null),
      (move) => move.lotId,
    )
    let byQuantity = 0
    for (const [lotId, moves] of byLot) {
      const lot = this.index.lots.get(lotId)
      const use = workOrderUses(moves).find((row) => row.workOrderId === workOrderId)
      if (!lot || !use) continue
      byQuantity += 1
      this.edge(this.mark('LOT', lotId, material), key, 'ISSUED', true, use.issued, lot.item.baseUom)
      this.backwardLot(lotId, material)
    }
    if (byQuantity > 0 && mode !== 'WHOLE') this.gap('ISSUED_BY_QUANTITY', key, byQuantity)
    // Hides: the whole batch took every one; a part of it only when its cuts are unknown.
    if (mode !== 'PART') {
      const hideReach = mode === 'WHOLE' ? reach : 'POSSIBLE'
      const byHide = groupBy(
        issues.filter((move) => move.hideId !== null),
        (move) => move.hideId,
      )
      const hides = new Set([...byHide.keys(), ...(this.index.cutsOfWorkOrder.get(workOrderId) ?? []).map((cut) => cut.hideId)])
      for (const hideId of hides) {
        const hide = this.index.hides.get(hideId)
        if (!hide) continue
        const use = workOrderUses(byHide.get(hideId) ?? []).find((row) => row.workOrderId === workOrderId)
        this.edge(this.mark('HIDE', hideId, hideReach), key, 'ISSUED', true, use?.issued ?? null, this.index.lots.get(hide.lotId)?.item.baseUom ?? null)
        this.backwardHide(hideId, hideReach)
      }
    }
    if (issues.length === 0 && (this.index.cutsOfWorkOrder.get(workOrderId) ?? []).length === 0) this.gap('NO_ISSUE', key)
    // Material sent to a workshop for it may have come back in its garments.
    for (const order of this.index.subcontractsOfWorkOrder.get(workOrderId) ?? []) {
      if (order.kit.length === 0) continue
      const orderKey = this.mark('SUBCONTRACT', order.id, 'POSSIBLE')
      this.edge(orderKey, key, 'WORKED_FOR', false)
      this.gap('SUBCONTRACT_RETURN', orderKey)
      for (const line of order.kit) {
        const lot = this.index.lots.get(line.lotId)
        if (!lot) continue
        const from = line.hideId && this.index.hides.has(line.hideId) ? this.mark('HIDE', line.hideId, 'POSSIBLE') : this.mark('LOT', line.lotId, 'POSSIBLE')
        const sent = order.kit.filter((row) => (line.hideId ? row.hideId === line.hideId : row.lotId === line.lotId && row.hideId === null))
        this.edge(from, orderKey, 'KIT', true, fixed(sum(sent.map((row) => row.baseQuantity))), lot.item.baseUom)
        if (line.hideId && this.index.hides.has(line.hideId)) this.backwardHide(line.hideId, 'POSSIBLE')
        else this.backwardLot(line.lotId, 'POSSIBLE')
      }
    }
  }

  backwardHide(hideId: string, reach: TraceReach): void {
    const hide = this.index.hides.get(hideId)
    if (!hide || !this.first('bHide', hideId, reach)) return
    const key = this.mark('HIDE', hideId, reach)
    if (!this.index.lots.has(hide.lotId)) return
    this.edge(this.mark('LOT', hide.lotId, reach), key, 'HIDE_OF', true)
    this.backwardLot(hide.lotId, reach)
  }

  backwardLot(lotId: string, reach: TraceReach): void {
    const lot = this.index.lots.get(lotId)
    if (!lot || !this.first('bLot', lotId, reach)) return
    const key = this.mark('LOT', lotId, reach)
    const receipt = lot.receiptId ? this.index.receipts.get(lot.receiptId) : undefined
    if (receipt) {
      const receiptKey = this.mark('RECEIPT', receipt.id, reach)
      this.edge(receiptKey, key, 'RECEIVED', true)
      if (this.index.parties.has(receipt.supplierId)) this.edge(this.mark('SUPPLIER', receipt.supplierId, reach), receiptKey, 'SUPPLIED', true)
      return
    }
    if (lot.receiptId === null) this.gap('OPENING_STOCK', key)
    if (lot.supplierId && this.index.parties.has(lot.supplierId)) this.edge(this.mark('SUPPLIER', lot.supplierId, reach), key, 'SUPPLIED', true)
    else this.gap('NO_SUPPLIER', key)
  }

  // ---- the answer -------------------------------------------------------------------------------------------------------

  result(direction: TraceDirection): TraceGraph {
    let nodes = [...this.nodes.values()]
    let edges = [...this.edges.values()]
    const gaps = [...this.gaps.values()]
    const serials = nodes.filter((node) => node.kind === 'SERIAL' && nodeKey('SERIAL', node.id) !== this.startKey)
    if (serials.length > TRACE_SERIAL_NODE_LIMIT) {
      // Too many to list: each serial's parent (bundle or cell) takes its shipments, counted in garments.
      const dropped = new Set(serials.map((node) => nodeKey('SERIAL', node.id)))
      const parentOf = new Map<string, TraceEdgeView>()
      for (const edge of edges) if (dropped.has(edge.to) && !dropped.has(edge.from) && (!parentOf.has(edge.to) || (edge.exact && !parentOf.get(edge.to)!.exact))) parentOf.set(edge.to, edge)
      const rolled = new Map<string, { from: string; to: string; exact: boolean; count: number }>()
      for (const edge of edges) {
        if (!dropped.has(edge.from) || edge.link !== 'SHIPPED') continue
        const parent = parentOf.get(edge.from)
        if (!parent) continue
        const key = `${parent.from}|${edge.to}`
        const known = rolled.get(key) ?? { from: parent.from, to: edge.to, exact: true, count: 0 }
        known.exact = known.exact && parent.exact && edge.exact
        known.count += 1
        rolled.set(key, known)
      }
      edges = edges.filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to))
      for (const roll of rolled.values()) {
        const same = edges.find((edge) => edge.from === roll.from && edge.to === roll.to && edge.link === 'SHIPPED')
        if (!same) edges.push({ from: roll.from, to: roll.to, link: 'SHIPPED', exact: roll.exact, quantity: String(roll.count), uom: 'PCS' })
      }
      nodes = nodes.filter((node) => !dropped.has(nodeKey(node.kind, node.id)))
      gaps.push({ code: 'SERIALS_COLLAPSED', at: this.startKey, count: serials.length })
    }
    const views = nodes.map((node) => this.view(node))
    const order = new Map(TRACE_NODE_KINDS.map((kind, position) => [kind, position]))
    views.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
    const codeOf = new Map(views.map((view) => [view.key, view.code]))
    const shown = new Set(views.map((view) => view.key))
    const received = { exact: 0, possible: 0 }
    for (const view of views) if (view.kind === 'CUSTOMER' && view.received) received[view.reach === 'EXACT' ? 'exact' : 'possible'] += 1
    return {
      start: this.startKey,
      direction,
      nodes: views,
      edges: edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to)).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.link.localeCompare(b.link)),
      levels: TRACE_NODE_KINDS.map((kind) => ({
        kind,
        exact: views.filter((view) => view.kind === kind && view.reach === 'EXACT').length,
        possible: views.filter((view) => view.kind === kind && view.reach === 'POSSIBLE').length,
      })).filter((level) => level.exact + level.possible > 0),
      gaps: gaps
        .map((gap) => ({ code: gap.code, severity: TRACE_GAP_SEVERITY[gap.code], at: gap.at, count: gap.count, message: traceGapMessage(gap.code, codeOf.get(gap.at) ?? gap.at, gap.count) }))
        .sort((a, b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code) || a.at.localeCompare(b.at)),
      customersReceived: received,
    }
  }

  private view(node: NodeState): TraceNodeView {
    const index = this.index
    const key = nodeKey(node.kind, node.id)
    const subject = HOLD_SUBJECT_OF[node.kind]
    const holds = subject ? (index.holdsOf.get(`${subject}:${node.id}`) ?? []).map((hold) => ({ id: hold.id, reasonCode: hold.reasonCode, placedAt: hold.placedAt })) : []
    const base = { key, kind: node.kind, id: node.id, reach: node.reach, sides: [...node.sides].sort(), holds }
    switch (node.kind) {
      case 'SUPPLIER':
      case 'CUSTOMER': {
        const party = index.parties.get(node.id)!
        if (node.kind === 'SUPPLIER') return { ...base, code: party?.code ?? '', party }
        const left = [...this.edges.values()].some((edge) => edge.to === key && edge.link === 'DELIVERED_TO' && LEFT_SHIPMENT_STATUSES.includes(index.shipments.get(edge.from.slice('SHIPMENT:'.length))?.status ?? ''))
        return { ...base, code: party?.code ?? '', party, received: left }
      }
      case 'RECEIPT': {
        const { id: _id, number, supplierId: _supplier, ...receipt } = index.receipts.get(node.id)!
        return { ...base, code: number, receipt }
      }
      case 'LOT': {
        const { id: _id, code, supplierId: _supplier, receiptId: _receipt, ...lot } = index.lots.get(node.id)!
        return { ...base, code, lot }
      }
      case 'HIDE': {
        const { id: _id, code, ...hide } = index.hides.get(node.id)!
        return { ...base, code, hide }
      }
      case 'SUBCONTRACT': {
        const order = index.subcontracts.get(node.id)!
        return { ...base, code: order.number, subcontract: { status: order.status, partyId: order.partyId, workOrderId: order.workOrderId } }
      }
      case 'WORK_ORDER': {
        const { id: _id, number, ...workOrder } = index.workOrders.get(node.id)!
        return { ...base, code: number, workOrder }
      }
      case 'CELL': {
        const { id: _id, ...cell } = index.cells.get(node.id)!
        const serials: Record<string, number> = {}
        for (const serial of index.serialsOfCell.get(node.id) ?? []) serials[serial.status] = (serials[serial.status] ?? 0) + 1
        let packed = 0
        let shipped = 0
        let returned = 0
        for (const line of index.linesOfCell.get(node.id) ?? []) {
          const status = index.shipments.get(line.shipmentId)?.status
          if (status === 'DRAFT' || status === 'PACKED') packed += line.quantity
          else if (status === 'SHIPPED' || status === 'DELIVERED') shipped += line.quantity
          else if (status === 'RETURNED') returned += line.quantity
        }
        return { ...base, code: `${cell.colourwayCode} ${cell.size}`, cell: { ...cell, serials, packed, shipped, returned } }
      }
      case 'BUNDLE': {
        const { id: _id, code, cutLogIds: _cuts, ...bundle } = index.bundles.get(node.id)!
        return { ...base, code, bundle: { ...bundle, cuts: index.liveCutsOf(index.bundles.get(node.id)!).length, serials: index.serialsOfBundle.get(node.id)?.length ?? 0 } }
      }
      case 'SERIAL': {
        const { id: _id, serial: code, ...serial } = index.serials.get(node.id)!
        return { ...base, code, serial }
      }
      case 'SHIPMENT': {
        const { id: _id, number, ...shipment } = index.shipments.get(node.id)!
        return { ...base, code: number, shipment: { ...shipment, left: LEFT_SHIPMENT_STATUSES.includes(shipment.status) } }
      }
    }
  }
}

/** The start's own record, so the graph can be asked (and a start the facts lack is said). */
function startExists(index: Index, start: TraceStart): boolean {
  switch (start.kind) {
    case 'LOT':
      return index.lots.has(start.id)
    case 'HIDE':
      return index.hides.has(start.id)
    case 'BUNDLE':
      return index.bundles.has(start.id)
    case 'WORK_ORDER':
      return index.workOrders.has(start.id)
    case 'SERIAL':
      return index.serials.has(start.id)
    case 'SHIPMENT':
      return index.shipments.has(start.id)
  }
}

/** The trace of one start, backward, forward or both (BOTH is the two walks from the same start, never a walk of a walk). */
export function buildTraceGraph(facts: TraceFacts, start: TraceStart, direction: TraceDirection): TraceGraph {
  const index = new Index(facts)
  if (!startExists(index, start)) throw new RangeError(`the facts hold no ${start.kind} ${start.id}`)
  const walk = new Walk(index, nodeKey(start.kind, start.id))
  walk.mark(start.kind, start.id, 'EXACT')
  if (direction !== 'FORWARD') {
    walk.run('BACKWARD', () => {
      switch (start.kind) {
        case 'LOT':
          return walk.backwardLot(start.id, 'EXACT')
        case 'HIDE':
          return walk.backwardHide(start.id, 'EXACT')
        case 'BUNDLE':
          return walk.backwardBundle(start.id, 'EXACT')
        case 'WORK_ORDER':
          return walk.backwardWorkOrder(start.id, 'EXACT', 'WHOLE')
        case 'SERIAL':
          return walk.backwardSerial(start.id, 'EXACT')
        case 'SHIPMENT':
          return walk.backwardShipment(start.id, 'EXACT')
      }
    })
  }
  if (direction !== 'BACKWARD') {
    walk.run('FORWARD', () => {
      switch (start.kind) {
        case 'LOT':
          return walk.forwardLot(start.id, 'EXACT')
        case 'HIDE':
          return walk.forwardHide(start.id, 'EXACT')
        case 'BUNDLE':
          return walk.forwardBundle(start.id, 'EXACT', 'START')
        case 'WORK_ORDER':
          return walk.forwardWorkOrder(start.id, 'EXACT', 'EXACT')
        case 'SERIAL':
          return walk.forwardSerial(start.id, 'EXACT')
        case 'SHIPMENT':
          return walk.forwardShipment(start.id, 'EXACT')
      }
    })
  }
  return walk.result(direction)
}

/**
 * The records a trace from this start reads (the API's loader): the work orders and lots it may reach. Backward from a
 * garment, a bundle, a shipment or a work order stays inside their work orders and the lots issued there; forward from
 * a lot or a hide reaches the work orders its stock went to (issues, cuts, subcontract kits) and nothing beyond their
 * garments.
 */
export function workOrdersOfMaterial(issues: readonly TraceIssueFact[], cuts: readonly TraceCutFact[], subcontracts: readonly TraceSubcontractFact[]): string[] {
  const ids = new Set<string>()
  for (const use of workOrderUses(issues)) ids.add(use.workOrderId)
  for (const cut of cuts) ids.add(cut.workOrderId)
  for (const order of subcontracts) if (order.kit.length > 0) ids.add(order.workOrderId)
  return [...ids].sort()
}
