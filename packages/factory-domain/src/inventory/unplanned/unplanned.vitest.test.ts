import { describe, expect, it } from 'vitest'
import { events } from '../../inventory-receiving/events'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { INVENTORY_UNPLANNED_DECIDE } from './permissions'
import { buyerTaskWords, candidateLines, hideAreasOf, holdingProblem, namingProblems, quantityOf, sendBackProblem, sentBackNote, totalOf, unplannedLineProblems, unplannedStateOf } from './rules'

/** Goods without a PO (B-W2b-300; SCM-122), the pure rules. Made-up ids and codes only. */

const waiting = [
  { id: 'r1', seq: 10, itemId: 'lin', itemColourId: 'gry', label: 'Line 10 (SEED-LIN GRY)' },
  { id: 'r2', seq: 20, itemId: 'zip', itemColourId: null, label: 'Line 20 (SEED-ZIP)' },
]
const orderLines = [
  { id: 'o10', seq: 10, itemId: 'lin', itemColourId: 'gry', ended: false },
  { id: 'o20', seq: 20, itemId: 'zip', itemColourId: null, ended: false },
  { id: 'o30', seq: 30, itemId: 'zip', itemColourId: null, ended: true },
  { id: 'o40', seq: 40, itemId: 'lin', itemColourId: 'blk', ended: false },
]

describe('the floor takes goods without a PO in', () => {
  it('reads a quantity above 0 with at most 4 decimals', () => {
    expect(quantityOf('15')).toBe('15.0000')
    expect(quantityOf(' 2.5 ')).toBe('2.5000')
    expect(quantityOf('0')).toBeNull()
    expect(quantityOf('1.23456')).toBeNull()
    expect(quantityOf('-3')).toBeNull()
    expect(quantityOf('abc')).toBeNull()
  })

  it('counts hides only on leather', () => {
    expect(unplannedLineProblems({ itemId: 'x', quantity: '40', hideCount: 3 }, { code: 'LEA', tracking: 'HIDE' })).toEqual([])
    expect(unplannedLineProblems({ itemId: 'x', quantity: '40', hideCount: 3 }, { code: 'LIN', tracking: 'LOT' })).toEqual([{ path: 'hideCount', message: 'LIN is not leather: it has no hides to count.' }])
    expect(unplannedLineProblems({ itemId: 'x', quantity: '0', hideCount: 0 }, { code: 'LEA', tracking: 'HIDE' }).map((issue) => issue.path)).toEqual(['quantity', 'hideCount'])
  })

  it('holds goods in a place that takes stock, never a workshop, a customer, transit, shipping or production place', () => {
    expect(holdingProblem({ code: 'A1-HOLD', status: 'ACTIVE', kind: 'BIN' })).toBeNull()
    expect(holdingProblem({ code: 'A1-QUA', status: 'ACTIVE', kind: 'QUARANTINE' })).toBeNull()
    expect(holdingProblem({ code: 'A1-T', status: 'ACTIVE', kind: 'TRANSIT' })).toMatch(/no place for goods without a PO/)
    expect(holdingProblem({ code: 'A1-OLD', status: 'ARCHIVED', kind: 'BIN' })).toMatch(/archived/)
    expect(holdingProblem(null)).toMatch(/scan the label/)
  })

  it('says where the goods stand from the receipt', () => {
    expect(unplannedStateOf('OPEN')).toBe('WAITING')
    expect(unplannedStateOf('POSTED')).toBe('ORDER_NAMED')
    expect(unplannedStateOf('CANCELLED')).toBe('SENT_BACK')
  })
})

describe('the buyer names the order', () => {
  it('offers the open lines of the same material and colour', () => {
    expect(candidateLines(waiting, orderLines)).toEqual(new Map([['r1', ['o10']], ['r2', ['o20']]]))
  })

  it('takes a naming of every line to a line of its material and colour', () => {
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'r1', purchaseOrderLineId: 'o10' }, { receiptLineId: 'r2', purchaseOrderLineId: 'o20' }])).toEqual([])
  })

  it('refuses another colour, an ended line, a line named twice and a line left out', () => {
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'r1', purchaseOrderLineId: 'o40' }, { receiptLineId: 'r2', purchaseOrderLineId: 'o20' }])[0]).toEqual({ path: 'lines/0/purchaseOrderLineId', message: 'Line 10 (SEED-LIN GRY): order line 40 is of another material or colour.' })
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'r1', purchaseOrderLineId: 'o10' }, { receiptLineId: 'r2', purchaseOrderLineId: 'o30' }])[0]!.message).toMatch(/cancelled or closed short/)
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'r1', purchaseOrderLineId: 'o10' }, { receiptLineId: 'r1', purchaseOrderLineId: 'o10' }]).map((issue) => issue.path)).toEqual(['lines/1/receiptLineId', 'lines'])
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'r1', purchaseOrderLineId: 'o10' }])).toEqual([{ path: 'lines', message: 'Name an order line for Line 20 (SEED-ZIP): every line of the goods goes to the order.' }])
    expect(namingProblems(waiting, orderLines, [{ receiptLineId: 'nope', purchaseOrderLineId: 'o10' }, { receiptLineId: 'r1', purchaseOrderLineId: 'o10' }, { receiptLineId: 'r2', purchaseOrderLineId: 'o20' }])[0]!.path).toBe('lines/0/receiptLineId')
  })

  it('reads the areas of the hides as typed', () => {
    expect(hideAreasOf('52,3 48.9\n50.4')).toEqual({ areas: ['52.3000', '48.9000', '50.4000'], problem: null })
    expect(hideAreasOf('52; x').problem).toMatch(/"x" is no area/)
    expect(hideAreasOf('  ').problem).toMatch(/hide by hide/)
    expect(totalOf(['52.3000', '48.9000'])).toBe('101.2000')
  })

  it('sends goods back only with the reason', () => {
    expect(sendBackProblem('  ')).toMatch(/Say why/)
    expect(sendBackProblem('x'.repeat(501))).toMatch(/500/)
    expect(sendBackProblem('Not ours: wrong address')).toBeNull()
    expect(sentBackNote(' Not ours ')).toBe('Sent back to the supplier (goods without a PO): Not ours')
  })

  it('asks the buyer in their language', () => {
    const facts = { number: 'GR-2026-0004', supplier: 'Made-up Tannery', place: 'A1-HOLD', lines: 2 }
    expect(buyerTaskWords('en', facts).title).toBe('Goods without a PO: GR-2026-0004 from Made-up Tannery')
    expect(buyerTaskWords('it', facts).title).toBe('Merce senza ordine: GR-2026-0004 da Made-up Tannery')
    expect(buyerTaskWords(null, facts).description).toContain('2 righe')
  })
})

describe('the catalogues', () => {
  it('declares the permission and gives it to the buyer and the warehouse only (the owner from every())', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(INVENTORY_UNPLANNED_DECIDE)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((template) => template.permissions.includes(INVENTORY_UNPLANNED_DECIDE))
      .map((template) => template.key)
      .sort()
    expect(holders).toEqual(['buyer', 'owner', 'warehouse'])
  })

  it('declares the two events without a person or a quantity', () => {
    expect(events.map((event) => event.type)).toEqual(['inventory.unplanned_changed', 'inventory.reception_reported'])
    for (const event of events) expect(Object.keys(event.payload.shape)).not.toContain('quantity')
  })
})
