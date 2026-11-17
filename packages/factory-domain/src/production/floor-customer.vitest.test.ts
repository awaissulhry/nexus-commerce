import { describe, expect, it } from 'vitest'
import { floorCustomer } from './floor-customer'
import { travellerPaper, type TravellerFacts } from './work-orders/traveller'

/*
 * B-PR-11 (production plan §2, lead pick L13: "Shared floor surfaces show the customer code, never the name"): the one label a
 * shared floor surface gives the customer, and the traveller that prints it. Pure; every code and name is made up.
 */

describe('the customer on a shared floor surface (L13)', () => {
  it('is the code: one customer, several once and sorted (a mixed work order made before the rule), none as null', () => {
    expect(floorCustomer([{ code: 'C-BETA' }])).toBe('C-BETA')
    expect(floorCustomer([{ code: 'C-BETA' }, { code: 'C-ALPHA' }, { code: 'C-BETA' }])).toBe('C-ALPHA · C-BETA')
    expect(floorCustomer([])).toBeNull()
    expect(floorCustomer([{ code: '  ' }])).toBeNull()
    // A party with its names: only the code is read.
    const party = { code: 'C-BETA', legalName: 'Made-up Brand Beta S.r.l.', tradeName: 'Brand Beta' }
    expect(floorCustomer([party])).toBe('C-BETA')
  })

  it('the traveller prints the code as a fact of its own, in the paper’s language; no customer, no fact', () => {
    const facts: TravellerFacts = {
      number: 'WO-00077',
      batchNumber: null,
      status: 'RELEASED',
      kind: 'SIZE_GRID',
      rush: false,
      priority: 0,
      dueDate: null,
      site: { code: 'A1', name: 'Made-up plant' },
      style: { code: 'JKT-DEMO', name: 'Demo jacket' },
      revision: 1,
      orders: ['SO-DEMO-9'],
      customer: floorCustomer([{ code: 'C-BETA' }]),
      splitFrom: null,
      note: null,
      holdReason: null,
      releasedAt: null,
      sizes: ['50'],
      cells: [{ colourway: 'BLK', size: '50', quantity: 1 }],
      frozen: true,
      operations: [],
      materials: [],
      printedAt: new Date('2026-11-17T08:00:00.000Z'),
      timeZone: 'Europe/Rome',
    }
    expect(travellerPaper(facts, 'en').facts.find((fact) => fact.label === 'Customer')?.value).toBe('C-BETA')
    expect(travellerPaper(facts, 'it').facts.find((fact) => fact.label === 'Cliente')?.value).toBe('C-BETA')
    expect(travellerPaper({ ...facts, customer: null }, 'en').facts.map((fact) => fact.label)).not.toContain('Customer')
    expect(JSON.stringify(travellerPaper(facts, 'en'))).not.toContain('Brand Beta')
  })
})
