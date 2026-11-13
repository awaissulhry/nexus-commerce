import { describe, expect, it } from 'vitest'
import type { WaterfallStep } from '../price-waterfall/rules'
import { SEND_CHECK_CODES } from '../quotes/send'
import {
  artworkKindOf,
  artworkTypeProblem,
  CONFIGURATOR_LINE_CODES,
  findingMessage,
  findingSeverity,
  frozenSurcharges,
  marginPctOf,
  netOfBasis,
  optionsPriced,
  optionSourceIds,
  orderChangeHeld,
  orderOptionsRefusal,
  orderSurcharges,
  picksProblems,
  surchargeChange,
  surchargeTotal,
  manualChangeOf,
} from './rules'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const S1 = '00000000-0000-4000-8000-0000000000f1'
const S2 = '00000000-0000-4000-8000-0000000000f2'

describe('picks (SAL-139)', () => {
  it('a choice takes a library colour or a material, never both; a colour of a material only with it', () => {
    expect(picksProblems([{ valueId: A, colourId: B }])).toEqual([])
    expect(picksProblems([{ valueId: A, itemId: B, itemColourId: C }])).toEqual([])
    expect(picksProblems([{ valueId: A, colourId: B, itemId: C }]).map((issue) => issue.path)).toEqual(['body/picks/0'])
    expect(picksProblems([{ valueId: A, itemColourId: C }]).map((issue) => issue.path)).toEqual(['body/picks/0/itemColourId'])
  })
  it('at most 40 options on a line', () => {
    expect(picksProblems(Array.from({ length: 41 }, () => ({ valueId: A })))[0]?.path).toBe('body/picks')
  })
})

describe('surcharges (SAL-136)', () => {
  const prices = [
    { valueId: A, amount: '60', currency: 'EUR', pct: null },
    { valueId: B, amount: null, currency: null, pct: '5' },
  ]
  it('an amount as the library says it, a percent taken once of the start (never compounded)', () => {
    const result = frozenSurcharges([A, B, C], prices, '400', 'EUR')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.get(A)).toEqual({ amount: '60', pct: null })
    expect(result.rows.get(B)).toEqual({ amount: '20', pct: '5' })
    expect(result.rows.get(C)).toEqual({ amount: null, pct: null })
  })
  it('an amount in another currency is refused in words, never converted', () => {
    const result = frozenSurcharges([A], prices, '400', 'USD')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message.en).toMatch(/EUR.*USD.*not converted/)
    expect(result.message.it).toMatch(/non si converte/)
  })
  it('an order keeps the surcharge a value was accepted with; a new value takes today', () => {
    const fresh = new Map([
      [A, { amount: '65', pct: null }],
      [B, { amount: '20', pct: '5' }],
    ])
    const merged = orderSurcharges([{ valueId: A, amount: '60', pct: null }], fresh)
    expect(merged.get(A)).toEqual({ amount: '60', pct: null })
    expect(merged.get(B)).toEqual({ amount: '20', pct: '5' })
    expect(surchargeTotal(merged.values())).toBe('80')
    expect(surchargeChange([{ amount: '60' }], merged.values())).toBe('20')
    expect(orderChangeHeld('20', false)).toBe(true)
    expect(orderChangeHeld('20', true)).toBe(false)
    expect(orderChangeHeld('0', false)).toBe(false)
  })
})

describe('does the price hold the options? (SAL-133)', () => {
  const steps: WaterfallStep[] = [
    { kind: 'LIST', unitPrice: '400', source: { type: 'PriceListEntry', id: C } },
    { kind: 'OPTION', delta: '60', unitPrice: '460', source: { type: 'QuoteLineOption', id: S1 }, label: 'Liner' },
    { kind: 'NET', unitPrice: '460' },
  ]
  const sources = new Map([[S1, { valueId: A, amount: '60' }]])
  it('every option that adds something is an OPTION step with the same amount', () => {
    expect(optionSourceIds(steps)).toEqual([S1])
    expect(optionsPriced(steps, sources, [{ valueId: A, amount: '60.000000' }])).toBe(true)
    expect(optionsPriced(steps, sources, [{ valueId: A, amount: '65' }])).toBe(false)
    expect(optionsPriced(steps, sources, [{ valueId: A, amount: '60' }, { valueId: B, amount: '15' }])).toBe(false)
  })
  it('options that add nothing need no step; priced options without a waterfall are not held', () => {
    expect(optionsPriced(null, new Map(), [{ valueId: A, amount: null }])).toBe(true)
    expect(optionsPriced(null, new Map(), [{ valueId: A, amount: '60' }])).toBe(false)
    expect(optionsPriced([steps[0]!, { kind: 'NET', unitPrice: '400' }], new Map([[S2, { valueId: A, amount: '60' }]]), [{ valueId: A, amount: '60' }])).toBe(false)
  })
  it('a manual change is kept as its amount (the last MANUAL after the start)', () => {
    expect(manualChangeOf(steps)).toBeNull()
    expect(manualChangeOf([...steps.slice(0, 2), { kind: 'MANUAL', delta: '-10', unitPrice: '450', reasonCode: 'COMPETITION', note: 'Matched' }, { kind: 'NET', unitPrice: '450' }])).toEqual({ delta: '-10', reasonCode: 'COMPETITION', note: 'Matched' })
    expect(manualChangeOf([{ kind: 'MANUAL', unitPrice: '400', reasonCode: 'OTHER' }, { kind: 'NET', unitPrice: '400' }])).toBeNull()
  })
})

describe('margin and basis', () => {
  it('the margin of a net over a cost, 2 places; none without a cost or a price', () => {
    expect(marginPctOf('400', '300')).toBe('25')
    expect(marginPctOf('460', '300')).toBe('34.78')
    expect(marginPctOf('400', null)).toBeNull()
    expect(marginPctOf('0', '10')).toBeNull()
  })
  it("a consumer's gross price back to its net", () => {
    expect(netOfBasis('122', 'GROSS', '22')).toBe('100')
    expect(netOfBasis('122', 'NET', '22')).toBe('122')
  })
})

describe('the order (CF1:03)', () => {
  it('options change while the order is open and before any work order makes the line', () => {
    expect(orderOptionsRefusal('CONFIRMED', 0)).toBeNull()
    expect(orderOptionsRefusal('IN_PRODUCTION', 0)).toBeNull()
    expect(orderOptionsRefusal('PENDING_APPROVAL', 0)?.en).toMatch(/confirmed, in production or ready/)
    expect(orderOptionsRefusal('CONFIRMED', 2)?.en).toMatch(/Work orders already make this line/)
    expect(orderOptionsRefusal('CONFIRMED', 2)?.it).toMatch(/ordini di lavoro/)
  })
})

describe('artwork (SAL-140)', () => {
  it('a PDF or a picture, never an SVG', () => {
    expect(artworkTypeProblem('application/pdf')).toBeNull()
    expect(artworkTypeProblem('image/png')).toBeNull()
    expect(artworkTypeProblem('image/svg+xml')).toMatch(/PDF or a picture/)
    expect(artworkKindOf('image/webp')).toBe('PHOTO')
    expect(artworkKindOf('application/pdf')).toBe('DOCUMENT')
  })
})

describe('line checks', () => {
  it('the codes are send checks; a quote blocks on a refused or missing choice, an order only warns', () => {
    for (const code of CONFIGURATOR_LINE_CODES) expect(SEND_CHECK_CODES).toContain(code)
    expect(findingSeverity('OPTIONS_REFUSED', 'QUOTE')).toBe('BLOCKS')
    expect(findingSeverity('OPTIONS_MISSING', 'QUOTE')).toBe('BLOCKS')
    expect(findingSeverity('OPTIONS_OUTSIDE_CERTIFICATE', 'QUOTE')).toBe('WARNING')
    expect(findingSeverity('OPTIONS_NOT_PRICED', 'QUOTE')).toBe('WARNING')
    expect(findingSeverity('OPTIONS_REFUSED', 'ORDER')).toBe('WARNING')
    expect(findingMessage('OPTIONS_REFUSED', 10, 'Full perforation excludes Thermal liner')).toBe('Line 10: its options no longer pass their rules: Full perforation excludes Thermal liner.')
  })
})
