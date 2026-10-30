import { describe, expect, it } from 'vitest'
import { composeDocument } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { events } from '../events'
import {
  cancelSourceDdtProblems,
  DDT_SOURCE_TYPES,
  draftSourceDdt,
  garmentDescription,
  materialDescription,
  SOURCE_DDT_REASONS,
  SOURCE_TRAVEL_STATES,
  sourceDdtDocument,
  sourceIssueStateProblems,
  type DdtSourceFacts,
  type SourceDdtFacts,
  type SourceDdtRequest,
  type SourceGoods,
} from './sources'

/* Every name, code, number and address here is made up. */

const NOW = new Date('2026-11-24T08:00:00.000Z')
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000)

const COMPANY: CompanyLegal = {
  legalName: 'Fabbrica Esempio S.r.l.',
  address: { line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: null,
  currency: 'EUR',
}

const goods = (fields: Partial<SourceGoods> = {}): SourceGoods => ({
  sourceLineId: 'kit-10',
  seq: 10,
  code: 'LIN-GREY',
  description: 'Fodera grigia, Grigio - lotto LOT-0001',
  quantity: '12.6',
  uom: 'M',
  batchNumber: 'LOT-0001',
  serials: [],
  held: null,
  ...fields,
})

const source = (fields: Partial<DdtSourceFacts> = {}): DdtSourceFacts => ({ type: 'SubcontractOrder', id: 'sc-1', number: 'SC-2026-0001', state: 'ISSUED', ...fields })

const facts = (fields: Partial<SourceDdtFacts> = {}): SourceDdtFacts => ({
  source: source(),
  company: COMPANY,
  recipient: { name: 'Laboratorio Esempio S.n.c.', address: { line1: 'Via Laboratorio 3', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' }, vatNumber: 'IT00000002014', fiscalCode: null },
  defaultDestination: { name: 'Reparto cucito', line1: 'Via Capannone 9', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' },
  defaultAppearance: 'Scatole di cartone',
  goods: [goods({ sourceLineId: 'kit-20', seq: 20, code: 'THR-BLK', description: 'Filo nero', quantity: '4', uom: 'CONE', batchNumber: null }), goods()],
  liveDdts: [],
  cancelledDdts: [],
  references: [{ kind: 'PURCHASE_ORDER', number: 'SC-2026-0001', date: '2026-11-16' }],
  language: 'it',
  ...fields,
})

const REQUEST: SourceDdtRequest = { transportBy: 'SENDER', packages: 2, grossWeightKg: '8.5' }

const problemsOf = (request: SourceDdtRequest, base: SourceDdtFacts = facts(), now = NOW) => draftSourceDdt(base, request, now).problems.map((problem) => `${problem.path}: ${problem.message}`)

describe('a DDT for another reason (LOG-056; DPR 472/1996 art. 1 c. 3)', () => {
  it("states every field from the source, its party and the company: a subcontract kit on conto lavorazione", () => {
    const { draft, problems } = draftSourceDdt(facts(), REQUEST, NOW)
    expect(problems).toEqual([])
    expect(draft).toMatchObject({
      documentDate: '2026-11-24',
      reason: 'WORK_ON_ACCOUNT',
      reasonText: null,
      transportBy: 'SENDER',
      carrier: null,
      startAt: '2026-11-24T08:00:00.000Z',
      appearance: 'Scatole di cartone',
      packages: 2,
      grossWeightKg: '8.5000',
      netWeightKg: null,
      sender: { name: 'Fabbrica Esempio S.r.l.', vatNumber: 'IT12345670009' },
      recipient: { name: 'Laboratorio Esempio S.n.c.', vatNumber: 'IT00000002014', fiscalCode: null },
      destination: { name: 'Reparto cucito', line1: 'Via Capannone 9', city: 'Bologna' },
      documentRefs: [{ kind: 'PURCHASE_ORDER', number: 'SC-2026-0001', date: '2026-11-16' }],
      replacement: false,
    })
    // The source's lines in their order, then typed ones; each names the line it carries.
    expect(draft.lines).toEqual([
      { seq: 1, code: 'LIN-GREY', description: 'Fodera grigia, Grigio - lotto LOT-0001', quantity: '12.6', uom: 'M', sourceLineId: 'kit-10', batchNumber: 'LOT-0001', serials: [] },
      { seq: 2, code: 'THR-BLK', description: 'Filo nero', quantity: '4', uom: 'CONE', sourceLineId: 'kit-20', batchNumber: null, serials: [] },
    ])
  })

  it('composes into a DDT the documents layout accepts, with the reason printed in words', () => {
    const { draft } = draftSourceDdt(facts(), { ...REQUEST, otherGoods: [{ description: 'Parti tagliate giacca, taglie 50-54', quantity: '7', uom: 'SET' }] }, NOW)
    const composed = composeDocument({ ...sourceDdtDocument({ ...draft, number: '146/2026' }, 'it', 'EUR'), company: COMPANY })
    expect(composed.layout).toBe('DDT/1')
    expect(composed.facts.map((fact) => fact.value)).toEqual(expect.arrayContaining(['Conto lavorazione', 'Scatole di cartone', '2']))
    expect(composed.table.rows.map((row) => row[0])).toEqual(['LIN-GREY', 'THR-BLK', ''])
    expect(composed.signatures).toHaveLength(3)
    const other = draftSourceDdt(facts({ source: source({ type: 'SupplierClaim', number: 'CLM-2026-0001', state: 'SENT', claimKind: 'RETURN' }) }), { ...REQUEST, reason: 'OTHER', reasonText: 'Campionatura di prova' }, NOW).draft
    expect(composeDocument({ ...sourceDdtDocument({ ...other, number: '147/2026' }, 'en', 'EUR'), company: COMPANY }).facts.map((fact) => fact.value)).toContain('Campionatura di prova')
  })

  it('gives each source its reasons, the default first, and OTHER only in words', () => {
    expect(SOURCE_DDT_REASONS).toEqual({
      SubcontractOrder: ['WORK_ON_ACCOUNT', 'OTHER'],
      SupplierClaim: ['RETURN', 'OTHER'],
      RepairOrder: ['REPAIR', 'RETURN_FROM_WORK', 'OTHER'],
      ReturnAuthorisation: ['RETURN', 'OTHER'],
    })
    expect(problemsOf({ ...REQUEST, reason: 'SALE' })).toEqual(['body/reason: A kit sent to a workshop travels on conto lavorazione (WORK_ON_ACCOUNT), or OTHER said in words.'])
    expect(problemsOf({ ...REQUEST, reason: 'RETURN' }, facts({ source: source({ type: 'RepairOrder', state: 'REPAIRED' }), goods: [goods({ sourceLineId: 'sc-1' })] }))).toEqual([
      'body/reason: A garment going back from repair travels as REPAIR or RETURN_FROM_WORK, or OTHER said in words.',
    ])
    expect(problemsOf({ ...REQUEST, reason: 'OTHER', reasonText: '  ' })).toEqual(['body/reasonText: Say the reason for the transport in words.'])
    expect(draftSourceDdt(facts({ source: source({ type: 'RepairOrder', state: 'REPAIRED' }), goods: [goods({ sourceLineId: 'sc-1' })] }), { ...REQUEST, reason: 'RETURN_FROM_WORK' }, NOW).problems).toEqual([])
  })

  it('travels only from the states the database names, a RETURN claim, a repaired PPE garment checked safe, one live DDT per repair', () => {
    expect(SOURCE_TRAVEL_STATES.SubcontractOrder).toEqual(['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'])
    const state = (fields: Partial<DdtSourceFacts>, live: SourceDdtFacts['liveDdts'] = []) => sourceIssueStateProblems({ source: source(fields), liveDdts: live })
    expect(state({})).toEqual([])
    expect(state({ state: 'DRAFT' })).toEqual(['The subcontract order SC-2026-0001 is DRAFT: its kit travels while it is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED.'])
    expect(state({ type: 'SupplierClaim', number: 'CLM-1', state: 'SENT', claimKind: 'CLAIM' })).toEqual(['The supplier claim CLM-1 keeps the goods (a claim for credit or replacement): only a RETURN claim sends goods back.'])
    expect(state({ type: 'SupplierClaim', number: 'CLM-1', state: 'DRAFT', claimKind: 'RETURN' })).toEqual(['The supplier claim CLM-1 is DRAFT: its goods go back once it is SENT or ACCEPTED.'])
    expect(state({ type: 'RepairOrder', number: 'REP-1', state: 'IN_REPAIR' })[0]).toMatch(/^The repair REP-1 is IN_REPAIR: the garment goes back from RECEIVED/)
    expect(state({ type: 'RepairOrder', number: 'REP-1', state: 'REPAIRED', repairedUnchecked: true })).toEqual(['The repair REP-1 is a repaired PPE garment: it goes back only after a passed safety check made after the repair.'])
    expect(state({ type: 'RepairOrder', number: 'REP-1', state: 'SHIPPED' }, [{ id: 'd1', number: '145/2026', startAt: NOW, lineIds: ['sc-1'] }])).toEqual(['DDT 145/2026 is live for this repair: cancel it first (the garment travels with one live DDT).'])
    expect(state({ type: 'ReturnAuthorisation', number: 'RMA-1', state: 'AUTHORISED' })).toEqual(['The return RMA-1 is AUTHORISED: its goods are sent back once they arrived (RECEIVED, INSPECTED or CLOSED).'])
    for (const type of DDT_SOURCE_TYPES) expect(SOURCE_TRAVEL_STATES[type].length).toBeGreaterThan(0)
  })

  it('takes by default every line that may travel; a named line that cannot is refused in words, at its index', () => {
    const base = facts({
      goods: [goods(), goods({ sourceLineId: 'kit-20', seq: 20, held: 'Kit line 20 is not sent yet: its transfer to the workshop comes first.' }), goods({ sourceLineId: 'kit-30', seq: 30 })],
      liveDdts: [{ id: 'd1', number: '150/2026', startAt: NOW, lineIds: ['kit-30'] }],
    })
    expect(draftSourceDdt(base, REQUEST, NOW).draft.lines.map((line) => line.sourceLineId)).toEqual(['kit-10'])
    expect(problemsOf({ ...REQUEST, lineIds: ['kit-20', 'kit-30', 'nope', 'kit-10', 'kit-10'] }, base)).toEqual([
      'body/lineIds/0: Kit line 20 is not sent yet: its transfer to the workshop comes first.',
      'body/lineIds/1: Line 30 travels with DDT 150/2026 already.',
      'body/lineIds/2: Not a line of subcontract order SC-2026-0001.',
      'body/lineIds/4: Line 10 is named twice.',
    ])
    expect(problemsOf(REQUEST, facts({ goods: [goods({ held: 'Kit line 10 is not sent yet: its transfer to the workshop comes first.' })] }))).toEqual([
      'source/lines: Nothing of subcontract order SC-2026-0001 may travel now: Kit line 10 is not sent yet: its transfer to the workshop comes first.',
    ])
    expect(problemsOf({ ...REQUEST, lineIds: [] })).toEqual(['body/lineIds: Name the goods that travel: a DDT lists at least one line.'])
    // Typed lines alone are a DDT too (a kit of cut pieces the order has no line for).
    expect(problemsOf({ ...REQUEST, lineIds: [], otherGoods: [{ description: 'Parti tagliate', quantity: '7', uom: 'SET' }] })).toEqual([])
  })

  it("checks typed lines: a description, a quantity above 0 with 4 decimals at most, a known unit", () => {
    expect(problemsOf({ ...REQUEST, otherGoods: [{ code: ' X1 ', description: ' ', quantity: '0', uom: 'BUCKET' }, { description: 'Bottoni', quantity: '1.00001', uom: 'PCS' }] })).toEqual([
      'body/otherGoods/0/description: Describe the goods: their nature and quality (DPR 472/1996).',
      'body/otherGoods/0/quantity: Expected a quantity above 0, with at most 4 decimals.',
      expect.stringMatching(/^body\/otherGoods\/0\/uom: Expected a unit of PCS, PAIR/),
      'body/otherGoods/1/quantity: Expected a quantity above 0, with at most 4 decimals.',
    ])
    const { draft } = draftSourceDdt(facts(), { ...REQUEST, otherGoods: [{ code: ' CUT ', description: ' Parti tagliate ', quantity: '7.500', uom: 'SET' }] }, NOW)
    expect(draft.lines[2]).toEqual({ seq: 3, code: 'CUT', description: 'Parti tagliate', quantity: '7.5', uom: 'SET', sourceLineId: null, batchNumber: null, serials: [] })
  })

  it('carries a repair its garment, always; lines named for a repair are refused', () => {
    const repair = facts({ source: source({ type: 'RepairOrder', number: 'REP-2026-0001', state: 'RECEIVED' }), goods: [goods({ sourceLineId: 'sc-1', seq: 10, code: 'JKT-01', quantity: '1', uom: 'PCS', serials: ['SN-1'] })] })
    expect(draftSourceDdt(repair, REQUEST, NOW).draft.lines.map((line) => [line.sourceLineId, line.serials])).toEqual([['sc-1', ['SN-1']]])
    expect(problemsOf({ ...REQUEST, lineIds: ['sc-1'] }, repair)).toEqual(["body/lineIds: A repair's DDT carries its garment: leave the lines out."])
  })

  it('says who carries the goods, the carrier when a carrier does, the packages and the weights', () => {
    expect(problemsOf({})).toEqual([
      'body/transportBy: Say who carries the goods: SENDER, RECIPIENT or CARRIER (DPR 472/1996).',
      'body/packages: Give the number of packages (numero colli), from 1.',
      'body/grossWeightKg: Give the gross weight in kilograms, above 0, with at most 4 decimals.',
    ])
    expect(problemsOf({ ...REQUEST, transportBy: 'CARRIER' })).toEqual(['body/carrier/name: Name the carrier (DPR 472/1996: the identity of whoever carries the goods).'])
    expect(problemsOf({ ...REQUEST, carrier: { name: 'Corriere' } })).toEqual(['body/carrier: A carrier is named only when a carrier carries the goods (transportBy CARRIER).'])
    expect(draftSourceDdt(facts(), { ...REQUEST, transportBy: 'CARRIER', carrier: { name: ' Corriere Esempio ', vatNumber: 'IT00000003012' } }, NOW).draft.carrier).toEqual({ name: 'Corriere Esempio', address: null, vatNumber: 'IT00000003012' })
    expect(problemsOf({ ...REQUEST, packages: 0, grossWeightKg: '-1', netWeightKg: '2' })).toEqual([
      'body/packages: Give the number of packages (numero colli), from 1.',
      'body/grossWeightKg: Give the gross weight in kilograms, above 0, with at most 4 decimals.',
    ])
    expect(problemsOf({ ...REQUEST, netWeightKg: '9' })).toEqual(['body/netWeightKg: The net weight is at most the gross weight (8.5000 kg).'])
    expect(problemsOf({ ...REQUEST, appearance: null }, facts({ defaultAppearance: null }))).toEqual([
      "body/appearance: Describe the goods' external appearance, e.g. 'scatole di cartone' (aspetto esteriore dei beni, DPR 472/1996).",
    ])
  })

  it('starts the transport from now to a week ahead; a replacement keeps the start of goods that left', () => {
    expect(problemsOf({ ...REQUEST, startAt: minutes(-30).toISOString() })).toEqual(['body/startAt: The transport starts once the DDT is issued (DPR 472/1996: the DDT travels with the goods), not before.'])
    expect(problemsOf({ ...REQUEST, startAt: minutes(8 * 24 * 60).toISOString() })).toEqual(['body/startAt: Give a start at most 7 days ahead: a DDT is issued for goods about to leave.'])
    expect(problemsOf({ ...REQUEST, startAt: 'tomorrow' })).toEqual(['body/startAt: Give the date and time the transport starts, ISO 8601 with a zone.'])
    const left = facts({ cancelledDdts: [{ id: 'd0', number: '148/2026', startAt: minutes(-120), lineIds: ['kit-10'] }, { id: 'd9', number: '149/2026', startAt: minutes(60), lineIds: ['kit-20'] }] })
    const replacement = draftSourceDdt(left, REQUEST, NOW).draft
    expect(replacement).toMatchObject({ replacement: true, startAt: minutes(-120).toISOString() })
    expect(problemsOf({ ...REQUEST, startAt: minutes(30).toISOString() }, left)).toEqual(['body/startAt: The goods left already: the transport started before now.'])
    // A cancelled DDT whose goods had not left yet starts again from now.
    expect(draftSourceDdt(left, { ...REQUEST, lineIds: ['kit-20'] }, NOW).draft).toMatchObject({ replacement: false, startAt: NOW.toISOString() })
    const shipped = facts({ source: source({ type: 'RepairOrder', state: 'SHIPPED', shippedAt: minutes(-600) }), goods: [goods({ sourceLineId: 'sc-1' })] })
    expect(draftSourceDdt(shipped, { ...REQUEST, reason: 'REPAIR' }, NOW).draft).toMatchObject({ replacement: true, startAt: minutes(-600).toISOString() })
  })

  it("prints the place of delivery only when it is not the recipient's address; the office may name another or none", () => {
    expect(draftSourceDdt(facts({ defaultDestination: { line1: ' via laboratorio  3 ', postalCode: '40121', city: 'Bologna', country: 'IT' } }), REQUEST, NOW).draft.destination).toBeNull()
    expect(draftSourceDdt(facts(), { ...REQUEST, destination: null }, NOW).draft.destination).toBeNull()
    expect(draftSourceDdt(facts(), { ...REQUEST, destination: { line1: 'Via Altra 2', postalCode: '20100', city: 'Milano', country: 'IT' } }, NOW).draft.destination).toEqual({ line1: 'Via Altra 2', line2: null, postalCode: '20100', city: 'Milano', province: null, country: 'IT' })
    expect(problemsOf({ ...REQUEST, destination: { line1: 'Via Altra 2', postalCode: '', city: 'Milano', country: 'IT' } })).toEqual(['body/destination: The place of delivery needs its street, postal code, city and country.'])
    expect(problemsOf(REQUEST, facts({ recipient: { name: '', address: null } }))).toEqual([
      'source/recipient: The workshop has no name: the DDT names the recipient (DPR 472/1996).',
      'source/recipient/address: The workshop has no complete address (street, postal code, city, country): the DDT prints it (DPR 472/1996).',
    ])
    expect(problemsOf(REQUEST, facts({ company: { ...COMPANY, vatNumber: null } })).length).toBeGreaterThan(0)
  })

  it('cancels while the source still takes a replacement and no issued invoice bills the goods', () => {
    const repair = { type: 'RepairOrder' as const, number: 'REP-1', state: 'SHIPPED' }
    expect(cancelSourceDdtProblems({ cancelled: false, source: repair, invoiceNumbers: [] })).toEqual([])
    expect(cancelSourceDdtProblems({ cancelled: true, source: repair, invoiceNumbers: [] })).toEqual(['This DDT is cancelled already.'])
    expect(cancelSourceDdtProblems({ cancelled: false, source: { type: 'SubcontractOrder', number: 'SC-1', state: 'RECEIVED' }, invoiceNumbers: ['FT-2026-00009'] })).toEqual([
      'The subcontract order SC-1 is RECEIVED: its transport is over, so its DDT stays as issued.',
      'Invoice FT-2026-00009 bills the goods of this DDT: an invoiced DDT stays as issued (a credit note corrects the invoice).',
    ])
  })

  it('describes materials and garments in the DDT language (no price)', () => {
    expect(materialDescription({ name: 'Pelle bovina', colour: 'Nero', lot: 'LOT-7', hide: 'HD-001' }, 'it')).toBe('Pelle bovina, Nero - lotto LOT-7 - pelle HD-001')
    expect(materialDescription({ name: 'Cowhide', lot: 'LOT-7' }, 'en')).toBe('Cowhide - lot LOT-7')
    expect(garmentDescription({ styleName: 'Giacca moto', colourway: 'Nero', size: '52', serial: 'SN-9', ppe: { category: 'CATEGORY_II', standard: 'EN 17092-3:2020', class: 'AA' } }, 'it')).toBe(
      'Giacca moto, Nero, taglia 52 (DPI cat. II, EN 17092-3:2020, classe AA) - matricole SN-9',
    )
    expect(garmentDescription({ serial: 'SN-9' }, 'en')).toBe('Garment - serials SN-9')
  })

  it('declares its events with the source and no money', () => {
    const types = events.map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(['ddt.source_issued', 'ddt.source_cancelled']))
    const issued = events.find((event) => event.type === 'ddt.source_issued')!
    expect(issued.payload.safeParse({ ddtId: '0193a6a0-0000-7000-8000-000000000001', sourceType: 'RepairOrder', sourceId: '0193a6a0-0000-7000-8000-000000000002', number: '146/2026', documentDate: '2026-11-24', reason: 'REPAIR', replacement: false }).success).toBe(true)
    expect(issued.payload.safeParse({ ddtId: '0193a6a0-0000-7000-8000-000000000001', sourceType: 'Shipment', sourceId: '0193a6a0-0000-7000-8000-000000000002', number: '146/2026', documentDate: '2026-11-24', reason: 'REPAIR', replacement: false }).success).toBe(false)
  })
})
