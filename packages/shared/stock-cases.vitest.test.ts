import { describe, expect, it } from 'vitest'
import {
  AMAZON_EU_BOX,
  CASE_COPY,
  CASE_OWNERS,
  type CasePackValues,
  MAX_UNITS_PER_CASE,
  amazonBoxWarning,
  caseCountProblem,
  caseSplit,
  casesAfterMove,
  isCaseOwner,
  packProblem,
  sealedCases,
} from './stock-cases'

const pack = (over: Partial<CasePackValues> = {}): CasePackValues => ({
  unitsPerCase: 12,
  caseLengthCm: 60,
  caseWidthCm: 40,
  caseHeightCm: 35,
  caseWeightKg: 14.5,
  fbaPrepOwner: 'SELLER',
  fbaLabelOwner: 'SELLER',
  ...over,
})

describe('sealedCases — what a reader shows', () => {
  it('never more sealed cases than the units allow', () => {
    expect(sealedCases(4, 51, 12)).toBe(4)
    expect(sealedCases(4, 48, 12)).toBe(4)
    expect(sealedCases(4, 47, 12)).toBe(3)
    expect(sealedCases(4, 11, 12)).toBe(0)
    expect(sealedCases(4, 0, 12)).toBe(0)
  })

  it('no case size (or a broken one) → 0; a negative stored or quantity reads as 0', () => {
    expect(sealedCases(4, 51, null)).toBe(0)
    expect(sealedCases(4, 51, 0)).toBe(0)
    expect(sealedCases(4, 51, 2.5)).toBe(0)
    expect(sealedCases(-2, 51, 12)).toBe(0)
    expect(sealedCases(4, -5, 12)).toBe(0)
  })
})

describe('casesAfterMove — the clamp: loose units first, then a case opens', () => {
  // 4 cases + 3 loose at 12 / case = 51 units.
  it.each([
    { label: 'sell 3: the 3 loose go, every case stays sealed', quantityAfter: 48, cases: 4, opened: 0 },
    { label: 'sell 4: a case opens, 11 loose', quantityAfter: 47, cases: 3, opened: 1 },
    { label: 'sell 15: one case opens', quantityAfter: 36, cases: 3, opened: 1 },
    { label: 'sell 16: two cases open', quantityAfter: 35, cases: 2, opened: 2 },
    { label: 'sell everything: every case opens', quantityAfter: 0, cases: 0, opened: 4 },
    { label: 'a negative balance opens every case', quantityAfter: -3, cases: 0, opened: 4 },
  ])('$label', ({ quantityAfter, cases, opened }) => {
    expect(casesAfterMove({ cases: 4, quantityAfter, unitsPerCase: 12 })).toEqual({ cases, opened })
  })

  it('a unit increase never touches the count (received units arrive loose)', () => {
    expect(casesAfterMove({ cases: 4, quantityAfter: 100, unitsPerCase: 12 })).toEqual({ cases: 4, opened: 0 })
    expect(casesAfterMove({ cases: 0, quantityAfter: 100, unitsPerCase: 12 })).toEqual({ cases: 0, opened: 0 })
  })

  it('a stored count already above the units (a pool door before its settle) clamps down', () => {
    expect(casesAfterMove({ cases: 5, quantityAfter: 40, unitsPerCase: 12 })).toEqual({ cases: 3, opened: 2 })
  })

  it('no case size is refused', () => {
    expect(casesAfterMove({ cases: 4, quantityAfter: 47, unitsPerCase: 0 })).toEqual({ refused: { code: 'NO_CASE_SIZE', message: CASE_COPY.noSize } })
  })
})

describe('casesAfterMove — explicit whole cases (Step 4)', () => {
  it('🔴 4 cases + 30 loose, 2 whole cases leave → 2 cases (the clamp alone would keep 4)', () => {
    // 78 units → 54 after 24 left as two cases.
    expect(casesAfterMove({ cases: 4, quantityAfter: 54, unitsPerCase: 12 })).toEqual({ cases: 4, opened: 0 })
    expect(casesAfterMove({ cases: 4, quantityAfter: 54, unitsPerCase: 12, casesChange: -2 })).toEqual({ cases: 2, opened: 0 })
  })

  it('whole cases plus more loose units than are loose: one more case opens', () => {
    // 4 cases + 3 loose (51); 2 cases + 5 units leave → 22 units: 1 case + 10 loose.
    expect(casesAfterMove({ cases: 4, quantityAfter: 22, unitsPerCase: 12, casesChange: -2 })).toEqual({ cases: 1, opened: 1 })
  })

  it('more cases cannot leave than are sealed', () => {
    const r = casesAfterMove({ cases: 1, quantityAfter: 0, unitsPerCase: 12, casesChange: -2 })
    expect(r).toMatchObject({ refused: { code: 'INVALID_CASES' } })
  })

  it('whole cases that arrive sealed add to the count; units that do not cover them are refused', () => {
    expect(casesAfterMove({ cases: 1, quantityAfter: 40, unitsPerCase: 12, casesChange: 2 })).toEqual({ cases: 3, opened: 0 })
    expect(casesAfterMove({ cases: 1, quantityAfter: 30, unitsPerCase: 12, casesChange: 2 })).toEqual({
      refused: { code: 'CASES_EXCEED_UNITS', message: CASE_COPY.exceeds(3, 12, 30) },
    })
  })

  it('a casesChange that is not a whole number is refused; 0 is the clamp', () => {
    expect(casesAfterMove({ cases: 4, quantityAfter: 51, unitsPerCase: 12, casesChange: 0.5 })).toMatchObject({ refused: { code: 'INVALID_CASES' } })
    expect(casesAfterMove({ cases: 4, quantityAfter: 47, unitsPerCase: 12, casesChange: 0 })).toEqual({ cases: 3, opened: 1 })
  })
})

describe('caseSplit — sealed, loose, and what holds leave free (a hold takes loose units first)', () => {
  it('no holds: everything is free', () => {
    expect(caseSplit({ quantity: 51, reserved: 0, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 4, freeLoose: 3 })
  })

  it('a hold within the loose units leaves every case free', () => {
    expect(caseSplit({ quantity: 51, reserved: 2, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 4, freeLoose: 1 })
    expect(caseSplit({ quantity: 51, reserved: 3, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 4, freeLoose: 0 })
  })

  it('a hold beyond the loose units takes whole cases (rounded up)', () => {
    expect(caseSplit({ quantity: 51, reserved: 5, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 3, freeLoose: 0 })
    expect(caseSplit({ quantity: 51, reserved: 15, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 3, freeLoose: 0 })
    expect(caseSplit({ quantity: 51, reserved: 16, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 2, freeLoose: 0 })
    expect(caseSplit({ quantity: 51, reserved: 51, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 4, loose: 3, freeSealed: 0, freeLoose: 0 })
  })

  it('the stored count is clamped by the units; no case size = everything loose', () => {
    expect(caseSplit({ quantity: 47, reserved: 0, cases: 4, unitsPerCase: 12 })).toEqual({ sealed: 3, loose: 11, freeSealed: 3, freeLoose: 11 })
    expect(caseSplit({ quantity: 51, reserved: 5, cases: 4, unitsPerCase: null })).toEqual({ sealed: 0, loose: 51, freeSealed: 0, freeLoose: 46 })
  })
})

describe('caseCountProblem — an absolute sealed count', () => {
  const at = (cases: number, over: Partial<{ quantity: number; unitsPerCase: number | null; locationType: string }> = {}) =>
    caseCountProblem({ cases, quantity: 51, unitsPerCase: 12, locationType: 'WAREHOUSE', ...over })

  it('allowed while the cases fit the units', () => {
    expect(at(0)).toBeNull()
    expect(at(3)).toBeNull()
    expect(at(4)).toBeNull()
  })

  it('more cases than units → CASES_EXCEED_UNITS, with the operator sentence', () => {
    expect(at(5)).toEqual({ code: 'CASES_EXCEED_UNITS', message: '5 cases need 60 units; on hand is 51' })
  })

  it('only at own warehouses: FBA and Shopify stay units', () => {
    expect(at(1, { locationType: 'AMAZON_FBA' })).toEqual({ code: 'NOT_A_WAREHOUSE', message: CASE_COPY.notHere })
    expect(at(0, { locationType: 'SHOPIFY_LOCATION' })).toEqual({ code: 'NOT_A_WAREHOUSE', message: CASE_COPY.notHere })
  })

  it('no case size → NO_CASE_SIZE (0 is still allowed: it can never break the invariant)', () => {
    expect(at(1, { unitsPerCase: null })).toEqual({ code: 'NO_CASE_SIZE', message: CASE_COPY.noSize })
    expect(at(0, { unitsPerCase: null })).toBeNull()
  })

  it('a count that is not a whole number of 0 or more → INVALID_CASES', () => {
    expect(at(-1)).toMatchObject({ code: 'INVALID_CASES' })
    expect(at(1.5)).toMatchObject({ code: 'INVALID_CASES' })
    expect(at(Number.NaN)).toMatchObject({ code: 'INVALID_CASES' })
  })
})

describe('packProblem — what a case pack may hold', () => {
  it('a full pack and an empty one are fine', () => {
    expect(packProblem(pack())).toBeNull()
    expect(packProblem({ unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null })).toBeNull()
  })

  it('units per case: a whole number from 1 to 10000', () => {
    expect(packProblem(pack({ unitsPerCase: 1 }))).toBeNull()
    expect(packProblem(pack({ unitsPerCase: MAX_UNITS_PER_CASE }))).toBeNull()
    for (const bad of [0, -1, 1.5, MAX_UNITS_PER_CASE + 1, Number.NaN]) {
      expect(packProblem(pack({ unitsPerCase: bad }))).toBe('Units per case must be a whole number from 1 to 10000')
    }
  })

  it('each side more than 0 and at most 300 cm; weight more than 0 and at most 1000 kg', () => {
    expect(packProblem(pack({ caseLengthCm: 300 }))).toBeNull()
    expect(packProblem(pack({ caseLengthCm: 0 }))).toBe('Case length must be more than 0 and at most 300 cm')
    expect(packProblem(pack({ caseWidthCm: 300.1 }))).toBe('Case width must be more than 0 and at most 300 cm')
    expect(packProblem(pack({ caseHeightCm: -1 }))).toBe('Case height must be more than 0 and at most 300 cm')
    expect(packProblem(pack({ caseWeightKg: 1000 }))).toBeNull()
    expect(packProblem(pack({ caseWeightKg: 0 }))).toBe('Case weight must be more than 0 and at most 1000 kg')
    expect(packProblem(pack({ caseWeightKg: Number.POSITIVE_INFINITY }))).toBe('Case weight must be more than 0 and at most 1000 kg')
  })

  it('prep and label owners: Amazon or Seller', () => {
    expect(CASE_OWNERS).toEqual(['AMAZON', 'SELLER'])
    expect(packProblem(pack({ fbaPrepOwner: 'NONE' as never }))).toBe('Prep by must be Amazon or Seller')
    expect(packProblem(pack({ fbaLabelOwner: 'seller' as never }))).toBe('Labels by must be Amazon or Seller')
    expect(isCaseOwner('AMAZON')).toBe(true)
    expect(isCaseOwner('seller')).toBe(false)
    expect(isCaseOwner(null)).toBe(false)
  })
})

describe('amazonBoxWarning — Amazon EU box limits, a warning only', () => {
  it('within 63.5 cm a side and 23 kg → none', () => {
    expect(amazonBoxWarning(pack())).toBeNull()
    expect(amazonBoxWarning(pack({ caseLengthCm: AMAZON_EU_BOX.maxSideCm, caseWeightKg: AMAZON_EU_BOX.maxKg }))).toBeNull()
    expect(amazonBoxWarning(pack({ caseLengthCm: null, caseWeightKg: null }))).toBeNull()
  })

  it('a side over 63.5 cm or a weight over 23 kg → the warning', () => {
    expect(amazonBoxWarning(pack({ caseHeightCm: 63.6 }))).toBe(CASE_COPY.boxLimit)
    expect(amazonBoxWarning(pack({ caseWeightKg: 23.01 }))).toBe(CASE_COPY.boxLimit)
    // A warning, not a refusal: the pack still saves.
    expect(packProblem(pack({ caseHeightCm: 80, caseWeightKg: 30 }))).toBeNull()
  })
})

describe('CASE_COPY — the operator words', () => {
  it('reads as the screens show it', () => {
    expect(CASE_COPY.perCase(12)).toBe('12 / case')
    expect(CASE_COPY.split(4, 3)).toBe('4 + 3')
    expect(CASE_COPY.sealedOpen(1, 'IT-MAIN')).toBe('1 sealed case at IT-MAIN becomes loose units. Count them again under Stock.')
    expect(CASE_COPY.sealedOpen(4, 'IT-MAIN')).toBe('4 sealed cases at IT-MAIN become loose units. Count them again under Stock.')
  })
})
