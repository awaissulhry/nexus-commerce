import { describe, expect, it } from 'vitest'
import { demandKey, demandOfKey, demandWords, proposeServes, receptionNoteText, reportHeld, serveOrder, type DemandFacts } from './rules'

/** The reception report (B-W2b-300; SCM-119), the pure rules. Made-up ids and codes only. */

const wo = (id: string, extra: Partial<DemandFacts> = {}): DemandFacts => ({ key: demandKey('WORK_ORDER', id), why: 'NEEDS', needDate: null, pegged: null, open: '10.0000', openDemand: true, ...extra })

describe('whom the goods serve', () => {
  it('serves pegged demands first, then the earliest need, then by key', () => {
    const rows = [wo('c', { needDate: '2026-11-20' }), wo('b', { why: 'PEGGED', pegged: '5', needDate: '2026-12-01' }), wo('a', { needDate: '2026-11-15' }), wo('d')]
    expect([...rows].sort(serveOrder).map((row) => row.key)).toEqual(['WORK_ORDER:b', 'WORK_ORDER:a', 'WORK_ORDER:c', 'WORK_ORDER:d'])
  })

  it('takes the smaller of the pegged and the still needed quantity, lot by lot, and leaves the rest to stock', () => {
    const { plans, left } = proposeServes(
      [wo('a', { why: 'PEGGED', pegged: '30', open: '20' }), wo('b', { open: '25', needDate: '2026-11-20' })],
      [
        { lotId: 'L1', free: '15', held: false },
        { lotId: 'L2', free: '40', held: false },
      ],
    )
    expect(plans).toEqual([
      { key: 'WORK_ORDER:a', proposed: '20.0000', lots: [{ lotId: 'L1', quantity: '15.0000' }, { lotId: 'L2', quantity: '5.0000' }], held: null },
      { key: 'WORK_ORDER:b', proposed: '25.0000', lots: [{ lotId: 'L2', quantity: '25.0000' }], held: null },
    ])
    expect(left).toBe('10.0000')
  })

  it('says why nothing is proposed: not needed, not open, nothing left, still in quarantine', () => {
    expect(proposeServes([wo('a', { open: '0' })], [{ lotId: 'L1', free: '5', held: false }]).plans[0]!.held).toBe('NOT_NEEDED')
    expect(proposeServes([wo('a', { openDemand: false })], [{ lotId: 'L1', free: '5', held: false }]).plans[0]!.held).toBe('NOT_OPEN')
    expect(proposeServes([wo('a', { open: '5' }), wo('b', { open: '5' })], [{ lotId: 'L1', free: '5', held: false }]).plans[1]!.held).toBe('NOTHING_LEFT')
    const held = proposeServes([wo('a')], [{ lotId: 'L1', free: '12', held: true }])
    expect(held.plans[0]!.held).toBe('IN_QUARANTINE')
    expect(held.left).toBe('0.0000')
  })

  it('reserves an untracked material by material and colour (no lot)', () => {
    expect(proposeServes([wo('a', { open: '3' })], [{ lotId: null, free: '24', held: false }])).toEqual({ plans: [{ key: 'WORK_ORDER:a', proposed: '3.0000', lots: [{ lotId: null, quantity: '3.0000' }], held: null }], left: '21.0000' })
  })

  it('reads its keys back', () => {
    expect(demandOfKey('ORDER_LINE:abc')).toEqual({ kind: 'ORDER_LINE', id: 'abc' })
    expect(demandOfKey('PLAN:abc')).toBeNull()
  })

  it('reports only a posted receipt of an order', () => {
    expect(reportHeld({ status: 'OPEN', purchaseOrderId: 'po' })).toBe('NOT_POSTED')
    expect(reportHeld({ status: 'POSTED', purchaseOrderId: null })).toBe('NO_ORDER')
    expect(reportHeld({ status: 'POSTED', purchaseOrderId: 'po' })).toBeNull()
  })
})

describe('the note to the buyer', () => {
  const lines = [{ label: 'Line 10 SEED-LEA BLK', received: '152.5000', uom: 'FT2' as const, serves: [{ label: demandWords('en', { kind: 'WORK_ORDER', number: 'WO-0001' }), open: '80', reservedNow: '80' }, { label: demandWords('en', { kind: 'ORDER_LINE', number: 'SO-0003', seq: 10 }), open: '20', reservedNow: '0' }], left: '52.5' }]

  it('says per line what came, whom it serves and what goes to stock', () => {
    expect(receptionNoteText('en', { receipt: 'GR-2026-0001', order: 'PO-2026-0002', lines, note: 'Grade A only' })).toBe(
      ['Reception report GR-2026-0001 (PO-2026-0002):', '- Line 10 SEED-LEA BLK, received 152.5 ft²: work order WO-0001 needs 80 ft² (reserved now 80 ft²); order SO-0003 line 10 needs 20 ft²; 52.5 ft² to stock.', '', 'Grade A only'].join('\n'),
    )
  })

  it('speaks Italian by default and says when nothing waits', () => {
    const text = receptionNoteText(null, { receipt: 'GR-2026-0001', order: 'PO-2026-0002', lines: [{ label: 'Riga 10 SEED-ZIP', received: '24', uom: 'PCS', serves: [], left: '24' }] })
    expect(text).toBe(['Rapporto di ricevimento GR-2026-0001 (PO-2026-0002):', '- Riga 10 SEED-ZIP, ricevuti 24 pz: nessun ordine di lavoro o ordine lo aspetta; 24 pz a magazzino.'].join('\n'))
    expect(demandWords('it', { kind: 'ORDER_LINE', number: 'SO-1', seq: 20 })).toBe('ordine SO-1 riga 20')
  })
})
