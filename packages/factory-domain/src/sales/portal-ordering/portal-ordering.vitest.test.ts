import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { parseRow } from '../../imports/plan'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { ATTENTION_KINDS, KIND_RULES } from '../../insights/attention'
import { decisionProblem, refuseReasonProblem, withdrawProblem } from './office'
import { PORTAL_ADDRESSES_MANAGE, PORTAL_ADDRESSES_VIEW, PORTAL_CATALOGUE_VIEW, PORTAL_ORDER_REQUESTS_MANAGE, PORTAL_ORDERING_PERMISSIONS } from './permissions'
import { reorderPlan, type ReorderFacts } from './reorder'
import { draftTotals, headerProblems, heldWords, lineProblems, lineShapeProblems, lowestPrice, mayOffer, offeredSizes, rangeLabel, type LineFacts } from './rules'
import { linesOfReady, portalOrderLinesImporter, refusedRowsCsv, uploadVerdicts, type CatalogueEntry } from './upload'

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'
const A = '00000000-0000-4000-8000-0000000000aa'
const facts = (more: Partial<LineFacts> = {}): LineFacts => ({ styleCode: 'JKT-100', sold: true, colourwayName: 'Black', colourwayActive: true, offered: ['48', '50', '52'], priceNow: '410.00', ...more })

describe('permissions and templates (B-W2b-190)', () => {
  it('declares four partner permissions, never office ones', () => {
    for (const name of PORTAL_ORDERING_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner, name).toBe(true)
    expect(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name)).not.toContain(PORTAL_CATALOGUE_VIEW)
  })

  it('gives the catalogue and addresses to every customer role, requests to the Buyer, address changes to the Admin only', () => {
    for (const key of ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin']) {
      expect(partnerTemplateOf(key)?.permissions, key).toEqual(expect.arrayContaining([PORTAL_CATALOGUE_VIEW, PORTAL_ADDRESSES_VIEW]))
    }
    expect(partnerTemplateOf('customer-buyer')?.permissions).toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    expect(partnerTemplateOf('customer-admin')?.permissions).toEqual(expect.arrayContaining([PORTAL_ORDER_REQUESTS_MANAGE, PORTAL_ADDRESSES_MANAGE]))
    for (const key of ['customer-finance', 'customer-viewer', 'customer-designer', 'customer-quality']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    for (const key of ['customer-buyer', 'customer-finance', 'customer-viewer']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_ADDRESSES_MANAGE)
    for (const key of ['supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_CATALOGUE_VIEW)
  })

  it('declares the request events and the Approvals kind', () => {
    const types = EVENT_DEFINITIONS.map((definition) => definition.type as string)
    for (const type of ['portal_order_request.sent', 'portal_order_request.accepted', 'portal_order_request.refused', 'portal_order_request.withdrawn']) expect(types).toContain(type)
    expect(ATTENTION_KINDS).toContain('PORTAL_ORDER_REQUEST')
    expect(KIND_RULES.PORTAL_ORDER_REQUEST).toMatchObject({ category: 'APPROVAL', view: 'orders.view', act: ['orders.manage'], decide: 'OPEN' })
  })
})

describe('the catalogue (SAL-071)', () => {
  it('offers the open range and the customer own label, never another customer label, a draft or an archived style', () => {
    expect(mayOffer({ status: 'ACTIVE', companyId: null, brandPartyId: null }, P1, A)).toBe(true)
    expect(mayOffer({ status: 'ACTIVE', companyId: A, brandPartyId: P1 }, P1, A)).toBe(true)
    expect(mayOffer({ status: 'ACTIVE', companyId: A, brandPartyId: P2 }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'DRAFT', companyId: A, brandPartyId: null }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'ARCHIVED', companyId: A, brandPartyId: null }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'ACTIVE', companyId: P2, brandPartyId: null }, P1, A)).toBe(false)
  })

  it('keeps the range order, says the range and the lowest price', () => {
    expect(offeredSizes(['48', '50', '52', '54'], ['54', '50'])).toEqual(['50', '54'])
    expect(rangeLabel(['48', '50', '52'])).toBe('48–52')
    expect(rangeLabel(['52'])).toBe('52')
    expect(lowestPrice(['410.000000', null, '395.5'])).toBe('395.50')
    expect(lowestPrice([null])).toBeNull()
  })
})

describe('a draft and its problems (SAL-074)', () => {
  it('refuses a line shape without sizes, with a size twice or a quantity out of range', () => {
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [] })).toEqual(['A line asks at least one size.'])
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [{ size: '50', quantity: 1 }, { size: '50', quantity: 2 }] })).toEqual(['Size 50 is asked twice on the line.'])
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [{ size: '50', quantity: 0 }] })).toEqual(['Size 50: 1 to 99999 pieces.'])
  })

  it('names a style no longer sold, a discontinued colour, a size not offered and a changed price', () => {
    const line = { id: 'l1', sizes: [{ size: '50', quantity: 2 }, { size: '62', quantity: 1 }], unitPriceShown: '400.000000' }
    expect(lineProblems(line, null, true).map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    expect(lineProblems(line, facts({ sold: false }), true).map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    const problems = lineProblems(line, facts(), true)
    expect(problems.map((entry) => [entry.code, entry.size])).toEqual([
      ['SIZE_NOT_OFFERED', '62'],
      ['PRICE_CHANGED', null],
    ])
    expect(problems[1]!.words.en).toBe('Price now 410.00 (was 400.00).')
    expect(lineProblems(line, facts({ colourwayActive: false }), true).map((entry) => entry.code)).toEqual(['COLOUR_DISCONTINUED', 'PRICE_CHANGED'])
    // A person without prices never meets a price problem.
    expect(lineProblems({ ...line, unitPriceShown: null }, facts({ offered: ['50', '62'] }), false)).toEqual([])
    expect(lineProblems({ ...line, unitPriceShown: '410' }, facts({ offered: ['50', '62'] }), true)).toEqual([])
  })

  it('holds the send without lines, with a past date or an archived address', () => {
    expect(headerProblems({ requestedDate: '2026-11-01', shipToActive: false, lineCount: 0 }, '2026-11-07').map((entry) => entry.code)).toEqual(['NO_LINES', 'DATE_PAST', 'SHIP_TO_ARCHIVED'])
    expect(headerProblems({ requestedDate: '2026-11-07', shipToActive: true, lineCount: 1 }, '2026-11-07')).toEqual([])
    expect(heldWords(2)?.en).toBe('2 problems to fix')
    expect(heldWords(0)).toBeNull()
  })

  it('adds up lines, pieces and the net of the prices shown (none without prices)', () => {
    const lines = [
      { sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }], unitPriceShown: '410.000000' },
      { sizes: [{ size: '52', quantity: 4 }], unitPriceShown: '395.000000' },
    ]
    expect(draftTotals(lines, true)).toEqual({ lines: 2, pieces: 9, net: '3630.00' })
    expect(draftTotals(lines, false)).toEqual({ lines: 2, pieces: 9, net: null })
    expect(draftTotals([{ sizes: [{ size: '50', quantity: 1 }], unitPriceShown: null }], true).net).toBeNull()
  })
})

describe('the office decision', () => {
  it('decides a SENT request only, and the customer withdraws only a SENT one', () => {
    expect(decisionProblem('SENT')).toBeNull()
    expect(decisionProblem('DRAFT')).toMatch(/still writing/)
    expect(decisionProblem('ACCEPTED')).toMatch(/already accepted/)
    expect(withdrawProblem('SENT')).toBeNull()
    expect(withdrawProblem('REFUSED')).toMatch(/already decided/)
    expect(refuseReasonProblem('  ')).toMatch(/Say why/)
    expect(refuseReasonProblem('Out of season')).toBeNull()
  })
})

describe('reorder (SAL-072)', () => {
  const past = { kind: 'SIZE_GRID' as const, unitPrice: '389.000000', revision: 1, sizes: [{ size: '50', quantity: 2 }, { size: '56', quantity: 1 }] }
  const now = (more: Partial<ReorderFacts> = {}): ReorderFacts => ({ ...facts(), revisionNow: 2, ...more })

  it('copies at today\'s price, naming the price, the revision and the sizes left out', () => {
    const plan = reorderPlan(past, now(), true)
    expect(plan.addable).toBe(true)
    expect(plan.sizes).toEqual([{ size: '50', quantity: 2 }])
    expect(plan.notices.map((entry) => entry.code)).toEqual(['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED'])
    expect(plan.notices[0]!.words.en).toBe('Price now 410.00 (was 389.00)')
    expect(plan.notices[2]!.words.en).toBe('Sizes no longer offered, left out: 56')
    expect(reorderPlan(past, now(), false).notices.map((entry) => entry.code)).toEqual(['REVISION_CHANGED', 'SIZES_DROPPED'])
  })

  it('asks for another colour, refuses a style no longer sold, made to measure, or no size left', () => {
    expect(reorderPlan(past, now({ colourwayActive: false, colourwayName: 'Brown' }), true)).toMatchObject({ addable: false, needsColour: true })
    expect(reorderPlan(past, now({ sold: false }), true).notices.map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    expect(reorderPlan(past, null, true).addable).toBe(false)
    expect(reorderPlan({ ...past, kind: 'MADE_TO_MEASURE' }, now(), true).notices.map((entry) => entry.code)).toEqual(['MADE_TO_MEASURE'])
    expect(reorderPlan(past, now({ offered: ['48'] }), true)).toMatchObject({ addable: false, sizes: [] })
  })
})

describe('order upload (SAL-073)', () => {
  const catalogue = new Map<string, CatalogueEntry>([['JKT-100', { styleId: 's1', styleCode: 'JKT-100', colourways: [{ id: 'c1', code: 'BLK', name: 'Black', offered: ['50', '52'] }] }]])
  const read = (headers: string[], rows: (string | number)[][]) => {
    const mapping = mapHeaders(portalOrderLinesImporter.columns, headers, {})
    return rows.map((cells, index) => parseRow(portalOrderLinesImporter, mapping.columns, { rowNumber: index + 2, cells }, { numberFormat: 'it' }))
  }

  it('maps the Italian headers and gives every row a verdict before anything lands', () => {
    const parsed = read(['Codice', 'Colore', 'Taglia', 'Quantità', 'Vostro codice'], [
      ['jkt-100', 'BLK', '50', 4, 'R-1'],
      ['JKT-100', 'black', 52, 6, 'R-1'],
      ['JKT-100', 'BLK', '62', 1, ''],
      ['JKT-999', 'BLK', '50', 1, ''],
      ['JKT-100', 'RED', '50', 1, ''],
      ['JKT-100', 'BLK', '50', 2, ''],
      ['JKT-100', 'BLK', '52', 'tre', ''],
    ])
    const verdicts = uploadVerdicts(parsed, catalogue)
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['READY', 'READY', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED'])
    expect(verdicts[2]!.reasons[0]!.en).toBe('Size 62 not offered for JKT-100 BLK.')
    expect(verdicts[3]!.reasons[0]!.en).toBe('JKT-999 is not in your catalogue.')
    expect(verdicts[4]!.reasons[0]!.en).toBe('JKT-100 has no colour RED.')
    expect(verdicts[5]!.reasons[0]!.en).toBe('Repeats row 2 (same style, colour and size).')
    expect(verdicts[6]!.reasons[0]!.en).toMatch(/^quantity: /)
    expect(linesOfReady(verdicts)).toEqual([{ styleId: 's1', colourwayId: 'c1', sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 6 }], note: 'R-1' }])
    const csv = refusedRowsCsv(verdicts, 'en')
    expect(csv.split('\r\n')[0]).toBe('Row;Style;Colour;Size;Quantity;Your code;Reason')
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(6)
  })
})
