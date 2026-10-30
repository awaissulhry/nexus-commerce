import { describe, expect, it } from 'vitest'
import { buildTraceGraph, workOrdersOfMaterial, type TraceFacts, type TraceGraph, type TraceSerialFact } from './graph'
import { nodeKey, TRACE_SERIAL_NODE_LIMIT, type TraceNodeKind } from './rules'

/**
 * The trace both ways (B-W2a-27; SCM-240, SCM-241) on made-up facts: a leather lot L1 (two hides) received on GR-1 from
 * the tannery S1; a lining lot L2 of opening stock; WO-1 (serial style) issued hide H1 whole and 10 m of lining, cut H1
 * for its BLK 52 cell, one bundle B1 naming the cut, split into B1a; serials SN-1, SN-2 in B1, SN-3 without a bundle;
 * SH-1 (shipped, to C1) carries SN-1 and SN-3, SH-2 (draft, to C2) one garment without a serial; WO-2 (batch style) cut
 * H2, bundle B2, shipped by size on SH-3 to C3. Every name and number is invented.
 */

const ITEM_LEATHER = { id: 'i-lea', code: 'LEA', name: 'Leather', baseUom: 'FT2', tracking: 'HIDE' }
const ITEM_LINING = { id: 'i-lin', code: 'LIN', name: 'Lining', baseUom: 'M', tracking: 'LOT' }
const lotBase = { companyId: 'co', siteId: 'si', colourCode: null, supplierLotRef: null, dyeBatch: null, purchaseOrder: null, receivedAt: null, qualityStatus: 'RELEASED', crVi: { status: 'PASS', valueMgKg: '1.200', limitMgKg: '3.000' }, labResults: 1, documents: 1, onHand: '0.0000', scrapped: '0.0000' }
const woBase = { companyId: 'co', siteId: 'si', status: 'IN_PROGRESS', kind: 'SIZE_GRID', finishedReceived: 0 }
const serial = (id: string, bundleId: string | null, shipmentLineId: string | null, status = 'RELEASED', workOrderId = 'wo1', cellId = 'c1'): TraceSerialFact => ({ id, serial: id.toUpperCase(), workOrderId, cellId, bundleId, status, shipmentLineId })

function world(): TraceFacts {
  return {
    lots: [
      { ...lotBase, id: 'l1', code: 'L1', item: ITEM_LEATHER, supplierId: 's1', receiptId: 'gr1', purchaseOrder: { id: 'po1', number: 'PO-1', lineSeq: 10 }, receivedAt: '2026-11-01T08:00:00.000Z' },
      { ...lotBase, id: 'l2', code: 'L2', item: ITEM_LINING, supplierId: null, receiptId: null, onHand: '110.0000' },
    ],
    hides: [
      { id: 'h1', code: 'H1', lotId: 'l1', state: 'PARTLY_CUT', baseArea: '50.0000', onHand: '0.0000' },
      { id: 'h2', code: 'H2', lotId: 'l1', state: 'PARTLY_CUT', baseArea: '48.0000', onHand: '0.0000' },
    ],
    receipts: [{ id: 'gr1', number: 'GR-1', status: 'POSTED', receivedAt: '2026-11-01T08:00:00.000Z', supplierId: 's1', supplierDdtNumber: 'DDT-9', supplierDdtDate: '2026-10-31' }],
    parties: [
      { id: 's1', companyId: null, code: 'S1', name: 'Tannery One' },
      { id: 'c1', companyId: null, code: 'C1', name: 'Customer One' },
      { id: 'c2', companyId: null, code: 'C2', name: 'Customer Two' },
      { id: 'c3', companyId: null, code: 'C3', name: 'Customer Three' },
      { id: 'w1', companyId: null, code: 'W1', name: 'Workshop One' },
    ],
    issues: [
      { id: 'm1', reason: 'ISSUE', lotId: 'l1', hideId: 'h1', workOrderId: 'wo1', baseQuantity: '50.0000', reversalOfId: null },
      { id: 'm2', reason: 'ISSUE', lotId: 'l2', hideId: null, workOrderId: 'wo1', baseQuantity: '10.0000', reversalOfId: null },
      { id: 'm3', reason: 'ISSUE', lotId: 'l1', hideId: 'h2', workOrderId: 'wo2', baseQuantity: '48.0000', reversalOfId: null },
    ],
    workOrders: [
      { ...woBase, id: 'wo1', number: 'WO-1', batchNumber: 'BT-1', styleCode: 'JKT-S', tracking: 'SERIAL' },
      { ...woBase, id: 'wo2', number: 'WO-2', batchNumber: 'BT-2', styleCode: 'JKT-B', tracking: 'BATCH' },
    ],
    cells: [
      { id: 'c1', workOrderId: 'wo1', colourwayCode: 'BLK', size: '52', quantity: 4, released: 3 },
      { id: 'c2', workOrderId: 'wo2', colourwayCode: 'RED', size: '50', quantity: 2, released: 2 },
    ],
    cuts: [
      { id: 'k1', workOrderId: 'wo1', hideId: 'h1', lotId: 'l1', baseAreaUsed: '20.0000', pieces: 8, live: true },
      { id: 'k2', workOrderId: 'wo2', hideId: 'h2', lotId: 'l1', baseAreaUsed: '18.0000', pieces: 4, live: true },
    ],
    bundles: [
      { id: 'b1', code: 'B1', workOrderId: 'wo1', cellId: 'c1', quantity: 3, part: null, status: 'ACTIVE', cutLogIds: ['k1'], parentBundleId: null },
      { id: 'b1a', code: 'B1A', workOrderId: 'wo1', cellId: 'c1', quantity: 1, part: null, status: 'ACTIVE', cutLogIds: ['k1'], parentBundleId: 'b1' },
      { id: 'b2', code: 'B2', workOrderId: 'wo2', cellId: 'c2', quantity: 2, part: null, status: 'ACTIVE', cutLogIds: ['k2'], parentBundleId: null },
    ],
    serials: [serial('sn1', 'b1', 'ln1'), serial('sn2', 'b1', null), serial('sn3', null, 'ln1'), serial('sn4', 'b1a', null, 'MADE')],
    lines: [
      { id: 'ln1', shipmentId: 'sh1', workOrderId: 'wo1', cellId: 'c1', quantity: 2 },
      { id: 'ln2', shipmentId: 'sh2', workOrderId: 'wo1', cellId: 'c1', quantity: 1 },
      { id: 'ln3', shipmentId: 'sh3', workOrderId: 'wo2', cellId: 'c2', quantity: 2 },
    ],
    shipments: [
      { id: 'sh1', companyId: 'co', siteId: 'si', number: 'SH-1', status: 'SHIPPED', partyId: 'c1', shippedAt: '2026-11-20T08:00:00.000Z', deliveredAt: null, ddtNumbers: ['1/2026'] },
      { id: 'sh2', companyId: 'co', siteId: 'si', number: 'SH-2', status: 'DRAFT', partyId: 'c2', shippedAt: null, deliveredAt: null, ddtNumbers: [] },
      { id: 'sh3', companyId: 'co', siteId: 'si', number: 'SH-3', status: 'DELIVERED', partyId: 'c3', shippedAt: '2026-11-21T08:00:00.000Z', deliveredAt: '2026-11-22T08:00:00.000Z', ddtNumbers: ['2/2026'] },
    ],
    subcontracts: [],
    holds: [],
  }
}

const node = (graph: TraceGraph, kind: TraceNodeKind, id: string) => graph.nodes.find((row) => row.key === nodeKey(kind, id))
const reachOf = (graph: TraceGraph, kind: TraceNodeKind, id: string) => node(graph, kind, id)?.reach ?? null
const keysOf = (graph: TraceGraph, kind: TraceNodeKind) => graph.nodes.filter((row) => row.kind === kind).map((row) => `${row.id}:${row.reach}`).sort()
const gapCodes = (graph: TraceGraph) => graph.gaps.map((gap) => `${gap.code}@${gap.at}`).sort()
const hasEdge = (graph: TraceGraph, from: string, to: string, link: string) => graph.edges.some((edge) => edge.from === from && edge.to === to && edge.link === link)

describe('backward: where a garment came from (SCM-240)', () => {
  it('a serial in a bundle reaches the hide of its cut, its lot, the receipt and the supplier exactly; lining issued by quantity is possible', () => {
    const graph = buildTraceGraph(world(), { kind: 'SERIAL', id: 'sn1' }, 'BACKWARD')
    expect(graph.start).toBe('SERIAL:sn1')
    expect(node(graph, 'SERIAL', 'sn1')?.sides).toEqual(['START'])
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b1:EXACT'])
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:EXACT'])
    expect(keysOf(graph, 'LOT')).toEqual(['l1:EXACT', 'l2:POSSIBLE'])
    expect(keysOf(graph, 'RECEIPT')).toEqual(['gr1:EXACT'])
    expect(keysOf(graph, 'SUPPLIER')).toEqual(['s1:EXACT'])
    expect(keysOf(graph, 'WORK_ORDER')).toEqual(['wo1:EXACT'])
    expect(hasEdge(graph, 'HIDE:h1', 'BUNDLE:b1', 'CUT')).toBe(true)
    expect(graph.edges.find((edge) => edge.link === 'CUT')).toMatchObject({ quantity: '20.0000', uom: 'FT2', exact: true })
    expect(hasEdge(graph, 'SUPPLIER:s1', 'RECEIPT:gr1', 'SUPPLIED')).toBe(true)
    // The opening-stock lining has no receipt: the chain is broken there, and said.
    expect(gapCodes(graph)).toEqual(['ISSUED_BY_QUANTITY@WORK_ORDER:wo1', 'NO_SUPPLIER@LOT:l2', 'OPENING_STOCK@LOT:l2'])
    expect(graph.gaps.find((gap) => gap.code === 'OPENING_STOCK')).toMatchObject({ severity: 'BROKEN', message: expect.stringContaining('L2 came in as opening stock') })
    // Nothing forward, and nothing of the other work order.
    expect(node(graph, 'SHIPMENT', 'sh1')).toBeUndefined()
    expect(node(graph, 'HIDE', 'h2')).toBeUndefined()
  })

  it('a serial without its bundle reaches every bundle of its size as possible, and says so', () => {
    const graph = buildTraceGraph(world(), { kind: 'SERIAL', id: 'sn3' }, 'BACKWARD')
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b1:POSSIBLE', 'b1a:POSSIBLE'])
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:POSSIBLE'])
    expect(reachOf(graph, 'CELL', 'c1')).toBe('EXACT')
    expect(gapCodes(graph)).toContain('SERIAL_WITHOUT_BUNDLE@CELL:c1')
  })

  it('a split bundle goes back through its parent to the same cut', () => {
    const graph = buildTraceGraph(world(), { kind: 'BUNDLE', id: 'b1a' }, 'BACKWARD')
    expect(hasEdge(graph, 'BUNDLE:b1', 'BUNDLE:b1a', 'SPLIT')).toBe(true)
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:EXACT'])
  })

  it('a work order (its batch) took every lot and hide issued to it, exactly', () => {
    const graph = buildTraceGraph(world(), { kind: 'WORK_ORDER', id: 'wo1' }, 'BACKWARD')
    expect(keysOf(graph, 'LOT')).toEqual(['l1:EXACT', 'l2:EXACT'])
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:EXACT'])
    expect(gapCodes(graph)).not.toContain('ISSUED_BY_QUANTITY@WORK_ORDER:wo1')
    expect(graph.edges.find((edge) => edge.from === 'LOT:l2' && edge.link === 'ISSUED')).toMatchObject({ quantity: '10.0000', uom: 'M' })
  })

  it('a batch-tracked shipment names the size: every bundle of it is possible', () => {
    const graph = buildTraceGraph(world(), { kind: 'SHIPMENT', id: 'sh3' }, 'BACKWARD')
    expect(reachOf(graph, 'CELL', 'c2')).toBe('EXACT')
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b2:POSSIBLE'])
    expect(keysOf(graph, 'HIDE')).toEqual(['h2:POSSIBLE'])
    expect(gapCodes(graph)).toContain('BATCH_TRACKED@WORK_ORDER:wo2')
    expect(graph.edges.find((edge) => edge.from === 'CELL:c2' && edge.to === 'SHIPMENT:sh3')).toMatchObject({ link: 'SHIPPED', quantity: '2', uom: 'PCS' })
  })

  it('a serial-tracked shipment: serials exactly, garments without a serial by size', () => {
    const graph = buildTraceGraph(world(), { kind: 'SHIPMENT', id: 'sh2' }, 'BACKWARD')
    expect(gapCodes(graph)).toContain('LINE_WITHOUT_SERIALS@SHIPMENT:sh2')
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b1:POSSIBLE', 'b1a:POSSIBLE'])
  })

  it('a reversed cut is no link: the bundle is said to name none, and the work order’s hides are possible', () => {
    const facts = world()
    const graph = buildTraceGraph({ ...facts, cuts: facts.cuts.map((cut) => (cut.id === 'k1' ? { ...cut, live: false } : cut)) }, { kind: 'BUNDLE', id: 'b1' }, 'BACKWARD')
    expect(gapCodes(graph)).toContain('BUNDLE_WITHOUT_CUTS@BUNDLE:b1')
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:POSSIBLE'])
  })

  it('a work order with nothing issued says the trace cannot reach a lot', () => {
    const facts = world()
    const graph = buildTraceGraph({ ...facts, issues: facts.issues.filter((move) => move.workOrderId !== 'wo2'), cuts: facts.cuts.filter((cut) => cut.workOrderId !== 'wo2') }, { kind: 'WORK_ORDER', id: 'wo2' }, 'BACKWARD')
    expect(gapCodes(graph)).toEqual(['NO_ISSUE@WORK_ORDER:wo2'])
    expect(graph.gaps[0]).toMatchObject({ severity: 'BROKEN', message: expect.stringContaining('WO-2 has no material') })
  })
})

describe('forward: where a lot went (SCM-241)', () => {
  it('a leather lot: its hides, the work orders, the bundles naming their cuts, serials, shipments and customers', () => {
    const graph = buildTraceGraph(world(), { kind: 'LOT', id: 'l1' }, 'FORWARD')
    expect(keysOf(graph, 'HIDE')).toEqual(['h1:EXACT', 'h2:EXACT'])
    expect(keysOf(graph, 'WORK_ORDER')).toEqual(['wo1:EXACT', 'wo2:EXACT'])
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b1:EXACT', 'b1a:EXACT', 'b2:EXACT'])
    // SN-3 has no bundle: possible; SN-1, SN-2 in B1 and SN-4 in its split are exact.
    expect(keysOf(graph, 'SERIAL')).toEqual(['sn1:EXACT', 'sn2:EXACT', 'sn3:POSSIBLE', 'sn4:EXACT'])
    expect(keysOf(graph, 'SHIPMENT')).toEqual(['sh1:EXACT', 'sh2:POSSIBLE', 'sh3:POSSIBLE'])
    expect(keysOf(graph, 'CUSTOMER')).toEqual(['c1:EXACT', 'c2:POSSIBLE', 'c3:POSSIBLE'])
    // C2's shipment is a draft: not received yet.
    expect(node(graph, 'CUSTOMER', 'c2')?.received).toBe(false)
    expect(graph.customersReceived).toEqual({ exact: 1, possible: 1 })
    expect(hasEdge(graph, 'WORK_ORDER:wo1', 'CELL:c1', 'SIZE')).toBe(true)
    expect(hasEdge(graph, 'CELL:c1', 'BUNDLE:b1', 'BUNDLED')).toBe(true)
    expect(hasEdge(graph, 'BUNDLE:b1', 'BUNDLE:b1a', 'SPLIT')).toBe(true)
    expect(gapCodes(graph)).toEqual(['BATCH_TRACKED@WORK_ORDER:wo2', 'LINE_WITHOUT_SERIALS@SHIPMENT:sh2', 'SERIAL_WITHOUT_BUNDLE@CELL:c1'])
    expect(graph.levels.map((level) => level.kind)).toEqual(['LOT', 'HIDE', 'WORK_ORDER', 'CELL', 'BUNDLE', 'SERIAL', 'SHIPMENT', 'CUSTOMER'])
    // Nothing backward.
    expect(node(graph, 'SUPPLIER', 's1')).toBeUndefined()
  })

  it('lining issued by quantity: the work order exactly, every garment of it as possible', () => {
    const graph = buildTraceGraph(world(), { kind: 'LOT', id: 'l2' }, 'FORWARD')
    expect(keysOf(graph, 'WORK_ORDER')).toEqual(['wo1:EXACT'])
    expect(keysOf(graph, 'SERIAL')).toEqual(['sn1:POSSIBLE', 'sn2:POSSIBLE', 'sn3:POSSIBLE', 'sn4:POSSIBLE'])
    expect(keysOf(graph, 'CUSTOMER')).toEqual(['c1:POSSIBLE', 'c2:POSSIBLE'])
    expect(gapCodes(graph)).toEqual(['ISSUED_BY_QUANTITY@LOT:l2'])
    expect(graph.edges.find((edge) => edge.link === 'ISSUED')).toMatchObject({ from: 'LOT:l2', to: 'WORK_ORDER:wo1', quantity: '10.0000', uom: 'M' })
  })

  it('a work order forward is whole: every garment and shipment exactly', () => {
    const graph = buildTraceGraph(world(), { kind: 'WORK_ORDER', id: 'wo2' }, 'FORWARD')
    expect(keysOf(graph, 'SHIPMENT')).toEqual(['sh3:EXACT'])
    expect(keysOf(graph, 'CUSTOMER')).toEqual(['c3:EXACT'])
    expect(graph.gaps).toEqual([])
    expect(node(graph, 'CELL', 'c2')?.cell).toMatchObject({ shipped: 2, packed: 0, released: 2 })
  })

  it('a hide issued but not cut, and a cut in no bundle, end the trace in words', () => {
    const facts = world()
    const graph = buildTraceGraph(
      {
        ...facts,
        issues: [...facts.issues, { id: 'm4', reason: 'ISSUE', lotId: 'l1', hideId: 'h2', workOrderId: 'wo1', baseQuantity: '1.0000', reversalOfId: null }],
        bundles: facts.bundles.filter((bundle) => bundle.id !== 'b2'),
      },
      { kind: 'HIDE', id: 'h2' },
      'FORWARD',
    )
    expect(gapCodes(graph)).toEqual(['CUT_NOT_BUNDLED@HIDE:h2', 'ISSUED_NOT_CUT@HIDE:h2'])
    expect(graph.gaps.map((gap) => gap.severity)).toEqual(['IN_WORK', 'IN_WORK'])
  })

  it('an issue undone is no link', () => {
    const facts = world()
    const graph = buildTraceGraph(
      { ...facts, issues: [...facts.issues, { id: 'm2r', reason: 'RETURN', lotId: 'l2', hideId: null, workOrderId: 'wo1', baseQuantity: '10.0000', reversalOfId: 'm2' }] },
      { kind: 'LOT', id: 'l2' },
      'FORWARD',
    )
    expect(graph.nodes.map((row) => row.key)).toEqual(['LOT:l2'])
  })

  it('a kit sent to a workshop reaches its work order as possible, and says why', () => {
    const facts = world()
    const graph = buildTraceGraph(
      { ...facts, issues: facts.issues.filter((move) => move.lotId !== 'l2'), subcontracts: [{ id: 'sc1', number: 'SC-1', status: 'AT_WORKSHOP', partyId: 'w1', workOrderId: 'wo1', kit: [{ lotId: 'l2', hideId: null, baseQuantity: '5.0000', status: 'SENT' }] }] },
      { kind: 'LOT', id: 'l2' },
      'FORWARD',
    )
    expect(keysOf(graph, 'SUBCONTRACT')).toEqual(['sc1:EXACT'])
    expect(keysOf(graph, 'WORK_ORDER')).toEqual(['wo1:POSSIBLE'])
    expect(hasEdge(graph, 'LOT:l2', 'SUBCONTRACT:sc1', 'KIT')).toBe(true)
    expect(graph.edges.find((edge) => edge.link === 'WORKED_FOR')).toMatchObject({ exact: false })
    expect(gapCodes(graph)).toEqual(['SUBCONTRACT_RETURN@SUBCONTRACT:sc1'])
  })

  it('cancelled shipments, void bundles and void serials carry nothing', () => {
    const facts = world()
    const graph = buildTraceGraph(
      {
        ...facts,
        shipments: facts.shipments.map((row) => (row.id === 'sh1' ? { ...row, status: 'CANCELLED' } : row)),
        bundles: facts.bundles.map((row) => (row.id === 'b1a' ? { ...row, status: 'VOID' } : row)),
        serials: facts.serials.map((row) => (row.id === 'sn2' ? { ...row, status: 'VOID' } : row)),
      },
      { kind: 'HIDE', id: 'h1' },
      'FORWARD',
    )
    expect(keysOf(graph, 'BUNDLE')).toEqual(['b1:EXACT'])
    // SN-4's bundle is void: the serial is known only by its size.
    expect(keysOf(graph, 'SERIAL')).toEqual(['sn1:EXACT', 'sn3:POSSIBLE', 'sn4:POSSIBLE'])
    expect(keysOf(graph, 'SHIPMENT')).toEqual(['sh2:POSSIBLE'])
  })
})

describe('both ways, holds and size', () => {
  it('BOTH from a bundle is the two walks from it; the start is only the start', () => {
    const graph = buildTraceGraph(world(), { kind: 'BUNDLE', id: 'b1' }, 'BOTH')
    expect(node(graph, 'BUNDLE', 'b1')?.sides).toEqual(['START'])
    expect(node(graph, 'LOT', 'l1')?.sides).toEqual(['BACKWARD'])
    expect(node(graph, 'CUSTOMER', 'c1')?.sides).toEqual(['FORWARD'])
    // Backward never walks forward again: the other work order's garments are not reached.
    expect(node(graph, 'BUNDLE', 'b2')).toBeUndefined()
    expect(keysOf(graph, 'SHIPMENT')).toEqual(['sh1:EXACT', 'sh2:POSSIBLE'])
  })

  it('a node names the ACTIVE holds on it', () => {
    const facts = world()
    const graph = buildTraceGraph({ ...facts, holds: [{ id: 'hold1', subjectType: 'GarmentSerial', subjectIds: ['sn1', 'sn2'], reasonCode: 'COMPLAINT', placedAt: '2026-11-25T08:00:00.000Z' }] }, { kind: 'BUNDLE', id: 'b1' }, 'FORWARD')
    expect(node(graph, 'SERIAL', 'sn1')?.holds).toEqual([{ id: 'hold1', reasonCode: 'COMPLAINT', placedAt: '2026-11-25T08:00:00.000Z' }])
    expect(node(graph, 'BUNDLE', 'b1')?.holds).toEqual([])
  })

  it('beyond the serial limit, serials are counted on their bundles and sizes, never dropped from the shipments', () => {
    const facts = world()
    const many = Array.from({ length: TRACE_SERIAL_NODE_LIMIT + 1 }, (_, n) => serial(`x${n}`, 'b1', n === 0 ? 'ln2' : null))
    const graph = buildTraceGraph({ ...facts, serials: [...facts.serials, ...many], cells: facts.cells.map((cell) => (cell.id === 'c1' ? { ...cell, quantity: 3000 } : cell)) }, { kind: 'BUNDLE', id: 'b1' }, 'FORWARD')
    expect(keysOf(graph, 'SERIAL')).toEqual([])
    expect(gapCodes(graph)).toContain('SERIALS_COLLAPSED@BUNDLE:b1')
    expect(graph.edges.find((edge) => edge.from === 'BUNDLE:b1' && edge.to === 'SHIPMENT:sh2')).toMatchObject({ link: 'SHIPPED', exact: true, quantity: '1' })
    expect(keysOf(graph, 'CUSTOMER')).toContain('c1:EXACT')
  })

  it('a start the facts lack is refused', () => {
    expect(() => buildTraceGraph(world(), { kind: 'LOT', id: 'nope' }, 'BOTH')).toThrow(RangeError)
  })

  it('the work orders a material reaches: issues (less undone), cuts and kits', () => {
    expect(workOrdersOfMaterial(world().issues, world().cuts, [])).toEqual(['wo1', 'wo2'])
    expect(
      workOrdersOfMaterial(
        [{ id: 'a', reason: 'ISSUE', lotId: 'l', hideId: null, workOrderId: 'wo9', baseQuantity: '1', reversalOfId: null }, { id: 'b', reason: 'RETURN', lotId: 'l', hideId: null, workOrderId: 'wo9', baseQuantity: '1', reversalOfId: 'a' }],
        [],
        [{ id: 'sc', number: 'SC', status: 'ISSUED', partyId: 'w', workOrderId: 'wo8', kit: [{ lotId: 'l', hideId: null, baseQuantity: '1', status: 'SENT' }] }],
      ),
    ).toEqual(['wo8'])
  })
})
