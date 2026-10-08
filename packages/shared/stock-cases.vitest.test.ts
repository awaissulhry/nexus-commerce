import { describe, expect, it } from 'vitest'
import {
  AMAZON_EU_BOX,
  CASE_COPY,
  CASE_OWNERS,
  type CaseCount,
  type CaseSizeValues,
  MAX_CASE_SIZES,
  MAX_UNITS_PER_CASE,
  amazonBoxWarning,
  caseCountProblem,
  caseSplit,
  casesAfterMove,
  countsFor,
  isCaseOwner,
  ownersProblem,
  sealedCases,
  sealedUnits,
  sizeProblem,
  sizesProblem,
  withCounts,
} from './stock-cases'

const c = (unitsPerCase: number, cases: number): CaseCount => ({ unitsPerCase, cases })
const size = (over: Partial<CaseSizeValues> = {}): CaseSizeValues => ({
  unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, ...over,
})

describe('sealedCases — what a reader shows', () => {
  it('one size: never more sealed cases than the units allow', () => {
    expect(sealedCases([c(12, 4)], 51)).toEqual([c(12, 4)])
    expect(sealedCases([c(12, 4)], 48)).toEqual([c(12, 4)])
    expect(sealedCases([c(12, 4)], 47)).toEqual([c(12, 3)])
    expect(sealedCases([c(12, 4)], 11)).toEqual([c(12, 0)])
    expect(sealedCases([c(12, 4)], 0)).toEqual([c(12, 0)])
  })

  it('several sizes: biggest first, a shortfall opens the smallest case first', () => {
    // 2×12 + 1×6 + 3 loose = 33.
    expect(sealedCases([c(6, 1), c(12, 2)], 33)).toEqual([c(12, 2), c(6, 1)])
    expect(sealedCases([c(12, 2), c(6, 1)], 30)).toEqual([c(12, 2), c(6, 1)])
    expect(sealedCases([c(12, 2), c(6, 1)], 29)).toEqual([c(12, 2), c(6, 0)])
    expect(sealedCases([c(12, 2), c(6, 1)], 23)).toEqual([c(12, 1), c(6, 1)])
    expect(sealedCases([c(12, 2), c(6, 1)], 5)).toEqual([c(12, 0), c(6, 0)])
  })

  it('a valid split comes back unchanged', () => {
    expect(sealedCases([c(10, 1), c(6, 2), c(3, 1)], 25)).toEqual([c(10, 1), c(6, 2), c(3, 1)])
  })

  it('a broken size is dropped; a size named twice keeps its first count; negatives read as 0', () => {
    expect(sealedCases([c(0, 4), c(2.5, 1), c(12, 4)], 51)).toEqual([c(12, 4)])
    expect(sealedCases([c(12, 1), c(12, 3)], 51)).toEqual([c(12, 1)])
    expect(sealedCases([c(12, -2)], 51)).toEqual([c(12, 0)])
    expect(sealedCases([c(12, 4)], -5)).toEqual([c(12, 0)])
    expect(sealedCases([], 51)).toEqual([])
  })
})

describe('countsFor / withCounts / sealedUnits', () => {
  it('countsFor: every size of the SKU, the stored count or 0, biggest first', () => {
    expect(countsFor([6, 12], [c(12, 3)])).toEqual([c(12, 3), c(6, 0)])
    expect(countsFor([], [c(12, 3)])).toEqual([])
  })
  it('withCounts: the typed sizes absolute, the others kept', () => {
    expect(withCounts([c(12, 3), c(6, 1)], [c(6, 4)])).toEqual([c(12, 3), c(6, 4)])
  })
  it('sealedUnits: Σ cases × units', () => {
    expect(sealedUnits([c(12, 2), c(6, 1)])).toBe(30)
    expect(sealedUnits([])).toBe(0)
  })
})

describe('casesAfterMove — the clamp: loose units first, then the smallest case opens', () => {
  // 4 cases + 3 loose at 12 / case = 51 units.
  it.each([
    { label: 'sell 3: the 3 loose go, every case stays sealed', quantityAfter: 48, cases: 4, opened: 0 },
    { label: 'sell 4: a case opens, 11 loose', quantityAfter: 47, cases: 3, opened: 1 },
    { label: 'sell 16: two cases open', quantityAfter: 35, cases: 2, opened: 2 },
    { label: 'sell everything: every case opens', quantityAfter: 0, cases: 0, opened: 4 },
    { label: 'a negative balance opens every case', quantityAfter: -3, cases: 0, opened: 4 },
  ])('one size — $label', ({ quantityAfter, cases, opened }) => {
    expect(casesAfterMove({ cases: [c(12, 4)], quantityAfter })).toEqual({ cases: [c(12, cases)], opened })
  })

  it('several sizes: the small case opens, the big ones stay sealed', () => {
    // 2×12 + 1×6 + 3 loose = 33; sell 4 → 29.
    expect(casesAfterMove({ cases: [c(12, 2), c(6, 1)], quantityAfter: 29 })).toEqual({ cases: [c(12, 2), c(6, 0)], opened: 1 })
    // Sell 10 → 23: the units force a big case open, the small one stays.
    expect(casesAfterMove({ cases: [c(12, 2), c(6, 1)], quantityAfter: 23 })).toEqual({ cases: [c(12, 1), c(6, 1)], opened: 1 })
  })

  it('a unit increase never touches a count (received units arrive loose)', () => {
    expect(casesAfterMove({ cases: [c(12, 4), c(6, 1)], quantityAfter: 100 })).toEqual({ cases: [c(12, 4), c(6, 1)], opened: 0 })
  })

  it('whole cases leave per size: 4×12 + 30 loose, send 2 cases → 2 stay', () => {
    expect(casesAfterMove({ cases: [c(12, 4)], quantityAfter: 54, casesChange: [{ unitsPerCase: 12, change: -2 }] }))
      .toEqual({ cases: [c(12, 2)], opened: 0 })
  })

  it('cases of two sizes leave in one move', () => {
    // 3×12 + 2×6 + 4 loose = 52; 1×12 + 1×6 + 4 loose leave (22) → 30 = 2×12 + 1×6.
    expect(casesAfterMove({ cases: [c(12, 3), c(6, 2)], quantityAfter: 30, casesChange: [{ unitsPerCase: 12, change: -1 }, { unitsPerCase: 6, change: -1 }] }))
      .toEqual({ cases: [c(12, 2), c(6, 1)], opened: 0 })
  })

  it('loose units that leave with whole cases may open one more (the clamp after the change)', () => {
    // 4×12 + 3 loose = 51; 2 cases + 5 loose leave (29) → 22: 2 cases would need 24 → one opens.
    expect(casesAfterMove({ cases: [c(12, 4)], quantityAfter: 22, casesChange: [{ unitsPerCase: 12, change: -2 }] }))
      .toEqual({ cases: [c(12, 1)], opened: 1 })
  })

  it('refusals: more cases leave than are sealed, a size the SKU lacks, not a whole number, too many arrive, no size', () => {
    expect(casesAfterMove({ cases: [c(12, 1)], quantityAfter: 0, casesChange: [{ unitsPerCase: 12, change: -2 }] })).toMatchObject({ refused: { code: 'INVALID_CASES' } })
    expect(casesAfterMove({ cases: [c(12, 1)], quantityAfter: 6, casesChange: [{ unitsPerCase: 6, change: -1 }] })).toMatchObject({ refused: { code: 'NO_CASE_SIZE', message: CASE_COPY.noSizeOf(6) } })
    expect(casesAfterMove({ cases: [c(12, 1)], quantityAfter: 12, casesChange: [{ unitsPerCase: 12, change: 0.5 }] })).toMatchObject({ refused: { code: 'INVALID_CASES' } })
    expect(casesAfterMove({ cases: [c(12, 1)], quantityAfter: 20, casesChange: [{ unitsPerCase: 12, change: 1 }] })).toMatchObject({ refused: { code: 'CASES_EXCEED_UNITS' } })
    expect(casesAfterMove({ cases: [], quantityAfter: 20 })).toMatchObject({ refused: { code: 'NO_CASE_SIZE' } })
  })

  it('cases that arrive sealed and fit are counted', () => {
    expect(casesAfterMove({ cases: [c(12, 1), c(6, 0)], quantityAfter: 30, casesChange: [{ unitsPerCase: 6, change: 2 }] }))
      .toEqual({ cases: [c(12, 1), c(6, 2)], opened: 0 })
  })
})

describe('caseSplit — sealed, loose and what holds leave free', () => {
  it('no hold: everything is free', () => {
    expect(caseSplit({ quantity: 51, reserved: 0, cases: [c(12, 4)] })).toEqual({ sealed: [c(12, 4)], loose: 3, freeSealed: [c(12, 4)], freeLoose: 3 })
  })
  it('a hold takes loose units first', () => {
    expect(caseSplit({ quantity: 51, reserved: 3, cases: [c(12, 4)] })).toEqual({ sealed: [c(12, 4)], loose: 3, freeSealed: [c(12, 4)], freeLoose: 0 })
  })
  it('a bigger hold opens a case; what it leaves of that case is free and loose', () => {
    // 51 − 5 = 46 free = 3×12 + 10.
    expect(caseSplit({ quantity: 51, reserved: 5, cases: [c(12, 4)] })).toEqual({ sealed: [c(12, 4)], loose: 3, freeSealed: [c(12, 3)], freeLoose: 10 })
  })
  it('several sizes: a hold opens the smallest case first', () => {
    // 2×12 + 1×6 + 0 = 30, hold 4 → 26 free = 2×12 + 2.
    expect(caseSplit({ quantity: 30, reserved: 4, cases: [c(12, 2), c(6, 1)] }))
      .toEqual({ sealed: [c(12, 2), c(6, 1)], loose: 0, freeSealed: [c(12, 2), c(6, 0)], freeLoose: 2 })
  })
  it('more held than on hand: nothing is free', () => {
    expect(caseSplit({ quantity: 10, reserved: 15, cases: [c(6, 1)] })).toEqual({ sealed: [c(6, 1)], loose: 4, freeSealed: [c(6, 0)], freeLoose: 0 })
  })
  it('no case size: everything is loose', () => {
    expect(caseSplit({ quantity: 51, reserved: 1, cases: [] })).toEqual({ sealed: [], loose: 51, freeSealed: [], freeLoose: 50 })
  })
})

describe('caseCountProblem — an absolute count at one location', () => {
  const at = (cases: CaseCount[], quantity = 51, sizes = [12, 6], locationType = 'WAREHOUSE') => caseCountProblem({ cases, quantity, sizes, locationType })
  it('allowed: counts the units hold, all 0', () => {
    expect(at([c(12, 3), c(6, 2)])).toBeNull()
    expect(at([c(12, 0), c(6, 0)], 0, [])).toBeNull()
  })
  it('refused: not a warehouse, not whole, a size the SKU lacks, more than the units', () => {
    expect(at([c(12, 0)], 51, [12], 'AMAZON_FBA')?.code).toBe('NOT_A_WAREHOUSE')
    expect(at([c(12, -1)])?.code).toBe('INVALID_CASES')
    expect(at([c(12, 1.5)])?.code).toBe('INVALID_CASES')
    expect(at([c(8, 1)])).toEqual({ code: 'NO_CASE_SIZE', message: CASE_COPY.noSizeOf(8) })
    expect(at([c(12, 1)], 51, [])).toEqual({ code: 'NO_CASE_SIZE', message: CASE_COPY.noSize })
    expect(at([c(12, 4), c(6, 1)])).toEqual({ code: 'CASES_EXCEED_UNITS', message: '4×12 + 1×6 need 54 units; on hand is 51' })
    expect(at([c(12, 5)], 51, [12])).toEqual({ code: 'CASES_EXCEED_UNITS', message: '5 cases need 60 units; on hand is 51' })
  })
})

describe('the words', () => {
  it('sizes, split and cases', () => {
    expect(CASE_COPY.sizes([6, 12])).toBe('12 · 6 / case')
    expect(CASE_COPY.sizes([12])).toBe('12 / case')
    expect(CASE_COPY.sizes([])).toBe('')
    expect(CASE_COPY.split([c(12, 4)], 3)).toBe('4 + 3')
    expect(CASE_COPY.split([c(12, 2), c(6, 1)], 3)).toBe('2×12 + 1×6 + 3')
    expect(CASE_COPY.split([c(12, 2), c(6, 0)], 5)).toBe('2×12 + 5')
    expect(CASE_COPY.split([c(12, 0), c(6, 0)], 5)).toBe('0 + 5')
    expect(CASE_COPY.cases([c(12, 1)])).toBe('1 case')
  })
})

describe('case sizes and owners — what a save accepts', () => {
  it('a full size passes; units 1..10000 whole; sides 0 < cm ≤ 300; 0 < kg ≤ 1000; nulls allowed', () => {
    expect(sizeProblem(size())).toBeNull()
    expect(sizeProblem(size({ caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null }))).toBeNull()
    expect(sizeProblem(size({ unitsPerCase: 0 }))).toMatch(/Units per case/)
    expect(sizeProblem(size({ unitsPerCase: MAX_UNITS_PER_CASE + 1 }))).toMatch(/Units per case/)
    expect(sizeProblem(size({ unitsPerCase: 2.5 }))).toMatch(/Units per case/)
    expect(sizeProblem(size({ caseWidthCm: 0 }))).toMatch(/Case width/)
    expect(sizeProblem(size({ caseHeightCm: 301 }))).toMatch(/Case height/)
    expect(sizeProblem(size({ caseWeightKg: 1001 }))).toMatch(/Case weight/)
  })
  it('a list: at most MAX_CASE_SIZES, no units per case twice, every size valid', () => {
    expect(sizesProblem([size(), size({ unitsPerCase: 6 })])).toBeNull()
    expect(sizesProblem([])).toBeNull()
    expect(sizesProblem([size(), size()])).toBe(CASE_COPY.sameSize(12))
    expect(sizesProblem(Array.from({ length: MAX_CASE_SIZES + 1 }, (_, k) => size({ unitsPerCase: k + 1 })))).toBe(CASE_COPY.tooManySizes)
    expect(sizesProblem([size(), size({ unitsPerCase: 0 })])).toMatch(/Units per case/)
  })
  it('owners: Amazon | Seller | not set', () => {
    expect(CASE_OWNERS).toEqual(['AMAZON', 'SELLER'])
    expect(isCaseOwner('SELLER')).toBe(true)
    expect(isCaseOwner('seller')).toBe(false)
    expect(ownersProblem({ fbaPrepOwner: 'AMAZON', fbaLabelOwner: null })).toBeNull()
    expect(ownersProblem({ fbaPrepOwner: 'X' as never })).toMatch(/Prep by/)
    expect(ownersProblem({ fbaLabelOwner: 'X' as never })).toMatch(/Labels by/)
  })
  it('Amazon EU box limit: a warning over 63.5 cm or 23 kg', () => {
    expect(amazonBoxWarning(size())).toBeNull()
    expect(amazonBoxWarning(size({ caseLengthCm: AMAZON_EU_BOX.maxSideCm + 0.1 }))).toBe(CASE_COPY.boxLimit)
    expect(amazonBoxWarning(size({ caseWeightKg: 23.5 }))).toBe(CASE_COPY.boxLimit)
  })
})
