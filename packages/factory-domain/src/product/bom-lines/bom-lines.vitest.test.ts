import { describe, expect, it } from 'vitest'
import type { ItemUnits } from '../units/units'
import {
  alternateProblems,
  alternateUse,
  certificateCheckRequired,
  customerProblems,
  kitNote,
  kitPlan,
  nextPriority,
  orderProblems,
  outputProblems,
  prioritiesOf,
  type AlternateDraft,
  type AlternateLine,
  type AlternateMaterial,
} from './rules'
import { addAlternateBody, setOutputBody, setSupplyBody, updateAlternateBody } from './contracts'

/** B-W2b-228's rules (PRD-083, PRD-084, PRD-099, PRD-108). Every code is made up. */

const metres: ItemUnits = { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' }
const pieces: ItemUnits = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }

const lining: AlternateLine = { seq: 20, itemId: 'lin-200', uom: 'M', material: { code: 'LIN-200', isPpeComponent: false } }
const protectorLine: AlternateLine = { seq: 30, itemId: 'pro-300', uom: 'PCS', material: { code: 'PRO-300', isPpeComponent: true } }

const material = (over: Partial<AlternateMaterial> = {}): AlternateMaterial => ({
  id: 'lin-210',
  code: 'LIN-210',
  kind: 'LINING',
  status: 'ACTIVE',
  approval: 'APPROVED',
  approvalNote: null,
  isPpeComponent: false,
  companyId: null,
  units: metres,
  colours: [
    { id: 'gry', code: 'GRY', status: 'ACTIVE' },
    { id: 'red', code: 'RED', status: 'ARCHIVED' },
  ],
  ...over,
})
const draft = (over: Partial<AlternateDraft> = {}): AlternateDraft => ({ itemId: 'lin-210', itemColourId: null, qty: null, allowedWhen: 'WHEN_SHORT', certificateCheck: false, note: null, ...over })
const fresh = { companyId: 'company-a', fresh: { material: true, colour: true } }

describe('alternates (PRD-083)', () => {
  it('takes another material of the company, counted in the line unit, its own colour', () => {
    expect(alternateProblems(lining, draft({ itemColourId: 'gry', qty: '1.9' }), material(), [], fresh)).toEqual([])
    expect(alternateProblems(lining, draft(), material({ companyId: 'company-a' }), [], fresh)).toEqual([])
  })

  it('refuses the line own material, a material twice, archived, blocked, another company and units that do not convert', () => {
    const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path)
    expect(alternateProblems(lining, draft({ itemId: 'lin-200' }), material({ id: 'lin-200', code: 'LIN-200' }), [], fresh)[0]!.message).toBe("LIN-200 is line 20's own material: an alternate is another one.")
    expect(alternateProblems(lining, draft(), material(), [{ id: 'a1', priority: 1, itemId: 'lin-210' }], fresh)[0]!.message).toBe('LIN-210 is already alternate 1 of line 20.')
    expect(alternateProblems(lining, draft(), material({ status: 'ARCHIVED' }), [], fresh)[0]!.message).toBe('LIN-210 is archived: it is no alternate.')
    expect(alternateProblems(lining, draft(), material({ approval: 'BLOCKED', approvalNote: 'Made-up test failed.' }), [], fresh)[0]!.message).toBe('LIN-210 is blocked (refused for use): it is no alternate. Why: Made-up test failed.')
    expect(alternateProblems(lining, draft(), material({ companyId: 'company-b' }), [], fresh)[0]!.message).toBe("LIN-210 belongs to another company than the style's.")
    expect(alternateProblems(lining, draft(), material({ units: pieces }), [], fresh)[0]!.message).toContain('does not convert m (line 20\'s unit) to its base unit pz')
    expect(paths(alternateProblems(lining, draft({ itemColourId: 'blu' }), material(), [], fresh))).toEqual(['itemColourId'])
    expect(alternateProblems(lining, draft({ itemColourId: 'red' }), material(), [], fresh)[0]!.message).toBe('Colour RED of LIN-210 is archived.')
    expect(alternateProblems(lining, draft(), undefined, [], fresh)).toEqual([{ path: 'itemId', message: 'No such material.' }])
    expect(alternateProblems(lining, draft(), material({ kind: 'FINISHED' }), [], fresh)[0]!.message).toBe('LIN-210 is a finished garment, not a material: it is no alternate.')
  })

  it('keeps an archived or blocked material it already names (refused only when newly named)', () => {
    const kept = { companyId: 'company-a', fresh: { material: false, colour: false } }
    expect(alternateProblems(lining, draft({ itemColourId: 'red' }), material({ status: 'ARCHIVED', approval: 'BLOCKED' }), [], kept)).toEqual([])
  })

  it('asks the certificate check whenever a PPE component is involved (the notified body may have to agree)', () => {
    const protector = material({ id: 'pro-310', code: 'PRO-310', kind: 'PROTECTOR', isPpeComponent: true, units: pieces, colours: [] })
    expect(certificateCheckRequired(protectorLine, protector)).toBe(true)
    expect(certificateCheckRequired(lining, material())).toBe(false)
    expect(certificateCheckRequired(lining, protector)).toBe(true)
    expect(alternateProblems(protectorLine, draft({ itemId: 'pro-310' }), protector, [], fresh)).toEqual([
      { path: 'certificateCheck', message: "line 30's PRO-300 is a PPE component, so the alternate needs a certificate check before it is used (the notified body may have to agree)." },
    ])
    expect(alternateProblems(protectorLine, draft({ itemId: 'pro-310', certificateCheck: true }), protector, [], fresh)).toEqual([])
    expect(alternateProblems(lining, draft({ itemId: 'pro-310' }), { ...protector, units: metres }, [], fresh)[0]!.message).toBe(
      'PRO-310 is a PPE component, so the alternate needs a certificate check before it is used (the notified body may have to agree).',
    )
  })

  it('keeps priorities 1..n: after the last, and a new order naming each alternate once', () => {
    expect(nextPriority([])).toBe(1)
    expect(nextPriority([{ priority: 1 }, { priority: 2 }])).toBe(3)
    const current = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderProblems(current, ['c', 'a', 'b'])).toEqual([])
    expect(orderProblems(current, ['c', 'a'])).toEqual([{ path: 'alternateIds', message: 'Name every alternate of the line in its new order (1 left out).' }])
    expect(orderProblems(current, ['c', 'c', 'x', 'a', 'b'])).toEqual([
      { path: 'alternateIds/1', message: 'Each alternate once.' },
      { path: 'alternateIds/2', message: 'Not an alternate of this line.' },
    ])
    expect([...prioritiesOf(['c', 'a', 'b'])]).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ])
  })

  it('says when an alternate may be used (W2b-5 substitution)', () => {
    const facts = { priority: 1, code: 'PRO-310', allowedWhen: 'WITH_APPROVAL' as const, certificateCheck: true, ownShort: false, approved: false, certificateChecked: false }
    expect(alternateUse(facts)).toEqual({
      may: false,
      held: ['NEEDS_APPROVAL', 'NEEDS_CERTIFICATE_CHECK'],
      message: 'Alternate 1 (PRO-310) is not used now: each use needs a person’s approval; the certificate check comes first (the notified body may have to agree).',
    })
    expect(alternateUse({ ...facts, approved: true, certificateChecked: true })).toEqual({ may: true, held: [], message: 'Alternate 1 (PRO-310) may be used.' })
    expect(alternateUse({ ...facts, allowedWhen: 'WHEN_SHORT', certificateCheck: false }).held).toEqual(['ONLY_WHEN_SHORT'])
    expect(alternateUse({ ...facts, allowedWhen: 'WHEN_SHORT', certificateCheck: false, ownShort: true }).may).toBe(true)
    expect(alternateUse({ ...facts, allowedWhen: 'ALWAYS', certificateCheck: false }).may).toBe(true)
  })

  it('reads bodies: a positive quantity, something to change', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    expect(addAlternateBody.safeParse({ version: 1, itemId: id, qty: '0' }).success).toBe(false)
    expect(addAlternateBody.safeParse({ version: 1, itemId: id, qty: '1.25', allowedWhen: 'ALWAYS' }).success).toBe(true)
    expect(updateAlternateBody.safeParse({ version: 1 }).success).toBe(false)
    expect(updateAlternateBody.safeParse({ version: 1, note: 'Cooler mesh.' }).success).toBe(true)
  })
})

describe('customer-supplied material (PRD-084)', () => {
  const brand = { id: 'p1', code: 'P1', roles: ['BRAND'], status: 'ACTIVE', companyId: null }
  const line = { seq: 50, supplier: null, subAssembly: false }
  const context = { companyId: 'company-a', fresh: true }

  it('is sent by a customer or a brand of the company, never bought, never a sub-assembly', () => {
    expect(customerProblems(line, brand, context)).toEqual([])
    expect(customerProblems(line, { ...brand, roles: ['CUSTOMER'], companyId: 'company-a' }, context)).toEqual([])
    expect(customerProblems(line, { ...brand, roles: ['SUPPLIER'] }, context)[0]!.message).toBe('P1 is neither a customer nor a brand: the material is sent by a party with the CUSTOMER or BRAND role.')
    expect(customerProblems(line, { ...brand, status: 'BLOCKED' }, context)[0]!.message).toBe('P1 is blocked.')
    expect(customerProblems(line, { ...brand, companyId: 'company-b' }, context)[0]!.message).toBe("P1 belongs to another company than the style's.")
    expect(customerProblems({ ...line, supplier: { id: 's1', code: 'S1' } }, brand, context)[0]!.message).toBe('Line 50 is bought from S1: clear its supplier first (a material the customer sends is not bought).')
    expect(customerProblems({ ...line, subAssembly: true }, brand, context)[0]!.message).toBe('Line 50 is a sub-assembly we make: the customer does not send it. Clear the sub-assembly first.')
    expect(customerProblems(line, undefined, context)).toEqual([{ path: 'customerSuppliedByPartyId', message: 'No such party.' }])
    expect(setSupplyBody.safeParse({ version: 1 }).success).toBe(false)
    expect(setSupplyBody.safeParse({ version: 1, customerSuppliedByPartyId: null }).success).toBe(true)
  })
})

describe('the output (PRD-099)', () => {
  it('makes one piece, pair or set; more than one unit is refused in words for now', () => {
    expect(outputProblems(1, 'PAIR')).toEqual([])
    expect(outputProblems(1, 'SET')).toEqual([])
    expect(outputProblems(1, 'M')).toEqual([{ path: 'outputUom', message: 'A BOM makes pieces, pairs or sets (PCS, PAIR or SET).' }])
    expect(outputProblems(0, 'PCS')[0]!.message).toBe('A BOM makes 1 to 1000 units.')
    expect(outputProblems(10, 'SET')).toEqual([
      { path: 'outputQuantity', message: 'A BOM for more than one unit (here 10 set) is not counted by work orders, costing and planning yet: write its lines for 1 set.' },
    ])
    expect(setOutputBody.safeParse({ version: 1, outputQuantity: 1, outputUom: 'M' }).success).toBe(false)
  })
})

describe('the subcontract kit from the BOM (PRD-108)', () => {
  const lines = [
    { id: 'shell', seq: 10, issueToSubcontract: false, routingSeq: null },
    { id: 'thread', seq: 15, issueToSubcontract: true, routingSeq: null },
    { id: 'lining', seq: 20, issueToSubcontract: true, routingSeq: 30 },
    { id: 'label', seq: 50, issueToSubcontract: true, routingSeq: 40 },
  ]

  it('takes the lines for the workshop; a step-bound line only with its step', () => {
    const plan = kitPlan(lines, new Set([30]))
    expect(plan.from).toBe('BOM')
    expect([...plan.lineIds]).toEqual(['thread', 'lining'])
    expect(plan.leftOut).toEqual([{ lineId: 'label', seq: 50, routingSeq: 40 }])
    expect([...kitPlan(lines, new Set()).lineIds]).toEqual(['thread'])
    expect(kitNote('BOM')).toBe('From the BOM’s lines for the workshop.')
  })

  it('keeps W2a kit (every planned material) when the BOM marks no line', () => {
    const plan = kitPlan(lines.map((line) => ({ ...line, issueToSubcontract: false })), new Set([30]))
    expect(plan.from).toBe('ALL')
    expect(plan.lineIds.size).toBe(4)
    expect(kitNote('ALL')).toBe('From the work order’s planned materials.')
  })
})
