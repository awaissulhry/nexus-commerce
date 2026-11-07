import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../core/errors'
import { composeDocument } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { addDays } from '../../planning/buy'
import { purchaseOrderDocument, type SupplierOrder } from '../document'
import {
  planPortalAnswer,
  portalDeclineText,
  portalDoneMessage,
  portalLineOfStored,
  portalLineText,
  portalProposalColumnsOf,
  substituteAcceptProblem,
  type PortalAskedLine,
} from './answer'
import { PRICE_FREE_LAYOUT, priceFreeCopy } from './copy'
import { CHIP_STATUSES, confirmTaskKey, defaultChipOf, portalAnswerProblem, supplierStateOf } from './views'

/** B-W2b-174: the supplier's answer in the portal, its words, the order's state for the supplier, the price-free copy. */

const TODAY = '2026-11-09'
const L10 = '00000000-0000-7000-8000-000000000010'
const L20 = '00000000-0000-7000-8000-000000000020'
const L30 = '00000000-0000-7000-8000-000000000030'
const OFFERED = '00000000-0000-7000-8000-0000000000aa'
const NOT_OFFERED = '00000000-0000-7000-8000-0000000000bb'
const choices = new Set([OFFERED])

const asked = (overrides: Partial<Record<string, Partial<PortalAskedLine>>> = {}): PortalAskedLine[] => [
  { id: L10, seq: 10, quantity: '1200.0000', uom: 'FT2', needDate: addDays(TODAY, 20), confirmed: false, ...overrides[L10] },
  { id: L20, seq: 20, quantity: '24.0000', uom: 'PCS', needDate: addDays(TODAY, 25), confirmed: false, ...overrides[L20] },
]

const issuesOf = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    if (error instanceof ValidationError) return (error.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`)
    throw error
  }
  return []
}

describe('planPortalAnswer (SCM-085, SCM-086)', () => {
  it('confirms every open line as asked in one answer', () => {
    const plan = planPortalAnswer(asked(), { mode: 'ALL_AS_ASKED', supplierRef: ' OC-1 ', note: '' }, choices, TODAY)
    expect(plan.outcome).toBe('CONFIRMED')
    expect(plan.confirmNow).toEqual([L10, L20])
    expect(plan.summary).toBe('all 2 lines as asked')
    expect(plan.supplierRef).toBe('OC-1')
    expect(plan.note).toBeNull()
  })

  it('confirms the lines as asked at once and lets a substitute wait for the buyer', () => {
    const plan = planPortalAnswer(
      asked(),
      { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'AS_ASKED' }, { lineId: L20, answer: 'SUBSTITUTE', substituteItemId: OFFERED, substituteNote: 'Our level 1 model', date: addDays(TODAY, 30), reason: 'Level 2 out of stock' }] },
      choices,
      TODAY,
    )
    expect(plan.outcome).toBe('PROPOSED')
    expect(plan.confirmNow).toEqual([L10])
    expect(plan.summary).toBe('1 line as asked · 1 later date · 1 substitute')
    const substitute = plan.lines.find((line) => line.lineId === L20)!
    expect(substitute).toMatchObject({ kind: 'SUBSTITUTE', quantity: '24.0000', date: addDays(TODAY, 30), needsBuyer: true, substitute: { itemId: OFFERED, note: 'Our level 1 model' }, changes: ['LATER'] })
    expect(portalProposalColumnsOf(substitute)).toEqual({
      proposedQuantity: '24.0000',
      proposedDate: addDays(TODAY, 30),
      proposedSplitQuantity: null,
      proposedSplitDate: null,
      proposalReason: 'Level 2 out of stock',
      proposedSubstituteItemId: OFFERED,
      proposedSubstituteNote: 'Our level 1 model',
      proposalNeedsBuyer: true,
    })
    expect(portalProposalColumnsOf(plan.lines[0]!)).toMatchObject({ proposedQuantity: '1200.0000', proposedDate: addDays(TODAY, 20), proposalNeedsBuyer: false, proposedSubstituteItemId: null })
    expect(portalLineText(substitute, 'SEED-PRO-100 Protector level 1')).toBe(
      `Line 20: a substitute instead, SEED-PRO-100 Protector level 1 — Our level 1 model: 24 PCS by ${addDays(TODAY, 30)} (asked 24 PCS by ${addDays(TODAY, 25)}). Reason: Level 2 out of stock`,
    )
  })

  it('takes a change in words that needs the buyer, and W1\'s answers checked by W1\'s rules', () => {
    const plan = planPortalAnswer(
      asked(),
      { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'CHANGE', reason: 'Two dye batches, 600 ft² each' }, { lineId: L20, answer: 'SPLIT', deliveries: [{ quantity: '12', date: addDays(TODAY, 25) }, { quantity: '12', date: addDays(TODAY, 40) }], reason: 'Half now' }] },
      choices,
      TODAY,
    )
    expect(plan.outcome).toBe('PROPOSED')
    expect(plan.confirmNow).toEqual([])
    expect(plan.lines.map((line) => [line.kind, line.needsBuyer])).toEqual([
      ['CHANGE', true],
      ['SPLIT', true],
    ])
    expect(plan.summary).toBe('1 later date · 1 split · 1 change to agree')
    expect(portalLineText(plan.lines[0]!)).toBe(`Line 10: a change to agree (asked 1200 ft² by ${addDays(TODAY, 20)}): Two dye batches, 600 ft² each`)
  })

  it('is a decline when no line can be delivered, and a proposal when an earlier answer confirmed a line', () => {
    const none = { mode: 'BY_LINE' as const, lines: [{ lineId: L10, answer: 'CANNOT_DELIVER' as const, reason: 'No hides' }, { lineId: L20, answer: 'CANNOT_DELIVER' as const, reason: 'No stock' }] }
    const declined = planPortalAnswer(asked(), none, choices, TODAY)
    expect(declined.outcome).toBe('DECLINED')
    expect(declined.declineReason).toContain('Cannot deliver any line of the order.')
    const locked = planPortalAnswer(asked({ [L10]: { confirmed: true } }), { mode: 'BY_LINE', lines: [none.lines[1]!] }, choices, TODAY)
    expect(locked.outcome).toBe('PROPOSED')
    expect(locked.lines.map((line) => line.lineId)).toEqual([L20])
    // A line confirmed before is locked: "confirm all as asked" confirms the rest.
    expect(planPortalAnswer(asked({ [L10]: { confirmed: true } }), { mode: 'ALL_AS_ASKED' }, choices, TODAY)).toMatchObject({ outcome: 'CONFIRMED', confirmNow: [L20] })
  })

  it('names every problem at once, at the answer\'s own paths', () => {
    expect(
      issuesOf(() =>
        planPortalAnswer(
          asked({ [L10]: { confirmed: true } }),
          { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'AS_ASKED' }, { lineId: L20, answer: 'SUBSTITUTE', substituteItemId: NOT_OFFERED }, { lineId: L30, answer: 'AS_ASKED' }] },
          choices,
          TODAY,
        ),
      ),
    ).toEqual(['body/lines/0/lineId: Line 10 is confirmed already: it is not answered again.', 'body/lines/1/substituteItemId: Choose one of the articles offered for this line.', 'body/lines/2/lineId: Not a line of this order.'])
    expect(issuesOf(() => planPortalAnswer(asked(), { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'OTHER', quantity: '1200', reason: 'x' }, { lineId: L20, answer: 'CHANGE', date: TODAY }] }, choices, TODAY))).toEqual([
      'body/lines/0: That is the quantity and date asked: answer "as asked".',
      'body/lines/1/date: Not part of an answer CHANGE: say the change in words (another date or quantity is an answer OTHER).',
      'body/lines/1/reason: Say what you would change (a few words for the buyer).',
    ])
    expect(issuesOf(() => planPortalAnswer(asked(), { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'AS_ASKED', substituteNote: 'x' }, { lineId: L20, answer: 'SUBSTITUTE' }] }, choices, TODAY))).toEqual([
      'body/lines/0/substituteNote: Not part of an answer AS_ASKED.',
      'body/lines/1/substituteItemId: Choose the article you offer instead, or describe your own.',
    ])
    expect(issuesOf(() => planPortalAnswer(asked(), { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'AS_ASKED' }] }, choices, TODAY))).toEqual(['body/lines: Answer line 20 too.'])
  })
})

describe('the words around an answer', () => {
  it('declines with a reason, the price one included (prices are talked about in the thread)', () => {
    expect(portalDeclineText({ reason: 'PRICE' })).toBe('The price does not work for us.')
    expect(portalDeclineText({ reason: 'NO_CAPACITY', note: ' Full until March ' })).toBe('No capacity for this order: Full until March')
    expect(issuesOf(() => portalDeclineText({ reason: 'OTHER' }))).toEqual(['body/note: Say why you decline the order.'])
  })

  it('reads a stored proposal back with its substitute or its change in words', () => {
    const read = { lineId: L20, seq: 20, kind: 'AS_ASKED' as const, asked: { quantity: '24.0000', uom: 'PCS', needDate: TODAY }, deliveries: [{ quantity: '24.0000', date: TODAY }], quantity: '24.0000', date: TODAY, reason: 'x', changes: [] }
    expect(portalLineOfStored(read, { proposedSubstituteItemId: OFFERED, proposedSubstituteNote: null, proposalNeedsBuyer: true })).toMatchObject({ kind: 'SUBSTITUTE', substitute: { itemId: OFFERED, note: null }, needsBuyer: true })
    expect(portalLineOfStored(read, { proposedSubstituteItemId: null, proposedSubstituteNote: null, proposalNeedsBuyer: true })).toMatchObject({ kind: 'CHANGE', substitute: null, needsBuyer: true })
    expect(portalLineOfStored(read, { proposedSubstituteItemId: null, proposedSubstituteNote: null, proposalNeedsBuyer: false })).toMatchObject({ kind: 'AS_ASKED', needsBuyer: false })
  })

  it('tells the buyer a substitute is taken by a new version, and the supplier what comes next', () => {
    expect(substituteAcceptProblem([])).toBeNull()
    expect(substituteAcceptProblem([20])).toMatch(/^Line 20 offers another article instead: accepting would confirm the article you asked for\. To take the substitute, counter-propose/)
    expect(substituteAcceptProblem([10, 20])).toMatch(/^Lines 10, 20 offer/)
    expect(portalDoneMessage('PROPOSED', 'Bianca', 1)).toBe('Thank you: the line as asked is confirmed, and your changes are with Bianca, who accepts or refuses them. You will see the answer here.')
    expect(portalDoneMessage('PROPOSED', null, 0)).toBe('Thank you: your changes are with the buyer, who accepts or refuses them. You will see the answer here.')
  })
})

describe('the order in the supplier\'s words', () => {
  it('maps statuses to states and chips, and only a SENT order is answered', () => {
    expect(['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'DECLINED', 'DRAFT', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'].map(supplierStateOf)).toEqual([
      'TO_CONFIRM',
      'CONFIRMED',
      'CHANGE_PROPOSED',
      'DECLINED',
      'BEING_CHANGED',
      'PARTLY_DELIVERED',
      'DELIVERED',
      'CLOSED',
      'CANCELLED',
    ])
    expect(CHIP_STATUSES.CLOSED).toEqual(['CLOSED', 'CANCELLED', 'DECLINED'])
    expect([defaultChipOf(2), defaultChipOf(0)]).toEqual(['TO_CONFIRM', 'ALL'])
    expect(portalAnswerProblem('SENT')).toBeNull()
    expect(portalAnswerProblem('DRAFT')).toBe('We are changing this order: its new version comes to you to confirm.')
    expect(confirmTaskKey(L10, 2)).toBe(`PurchaseOrder:${L10}:r2`)
  })
})

describe('the price-free copy (Owner answer C2)', () => {
  it('prints the order without a price column or a total, and says where the prices are', () => {
    const order: SupplierOrder = {
      number: 'PO-2026-0101',
      revision: 2,
      language: 'en',
      date: TODAY,
      currency: 'EUR',
      supplier: { name: 'Example Tannery S.r.l.', address: { line1: 'Via Esempio 1', postalCode: '00000', city: 'Esempio', country: 'IT' }, vatNumber: null, fiscalCode: null, email: null },
      deliverTo: { name: 'Plant A1', line1: 'Via Prova 2', postalCode: '00000', city: 'Prova', country: 'IT' },
      requestedDate: null,
      incoterms: 'EXW Example',
      paymentTerms: null,
      note: null,
      netAmount: 0,
      lines: [{ seq: 10, code: 'ART-1', name: 'Example cowhide', colour: null, description: null, quantity: '120.0000', uom: 'FT2', unitPrice: '0.000000', netAmount: 0, needDate: addDays(TODAY, 20), leather: null, requiresCrViTest: true, note: null }],
    }
    const company: CompanyLegal = {
      legalName: 'Example Factory S.r.l.',
      tradeName: null,
      address: { line1: 'Via Uno 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
      vatNumber: 'IT12345670009',
      fiscalCode: '12345670009',
      reaOffice: 'MI',
      reaNumber: '0000001',
      shareCapital: '10000.00',
      currency: 'EUR',
      soleShareholder: true,
      pec: null,
      documentFooter: null,
    }
    const composed = composeDocument({ ...purchaseOrderDocument(order), company, sample: false })
    const copy = priceFreeCopy(composed)
    expect(copy.layout).toBe(PRICE_FREE_LAYOUT)
    expect(copy.table.columns.map((column) => column.key)).toEqual(['code', 'description', 'quantity', 'uom', 'delivery'])
    expect(copy.table.columns.reduce((sum, column) => sum + column.width, 0)).toBe(1000)
    expect(copy.table.rows[0]).toHaveLength(5)
    expect(copy.totals).toEqual([])
    expect(copy.title).toBe('Purchase order - copy without prices')
    expect(copy.notices.at(-1)).toMatch(/^Copy without prices for the supplier portal\./)
    expect(JSON.stringify(copy.table)).not.toMatch(/0[.,]00/)
  })
})
