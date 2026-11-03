import { describe, expect, it } from 'vitest'
import { AQL_COLUMNS, CODE_LETTERS, codeLetterFor, INSPECTION_LEVELS, SAMPLE_SIZES, TABLE_1, tableCell, tablePlan, type AqlColumn, type CodeLetter, type InspectionLevel } from './iso2859'
import { profileDraftProblems, reasonProblem, resolveProfile, type AssignmentFacts, type ProfileFacts } from './profiles'
import { aqlResult, aqlVerdict, classState, classWords } from './result'
import { acceptanceOf, aqlColumnOf, aqlStored, aqlWords, isAqlValue, levelOf, levelText, samplingPlan, samplingProblems } from './sampling'

/**
 * The AQL engine against the published ISO 2859-1:1999 tables (B-W2b-93; QHS-013, QHS-020, QHS-021). The tables in
 * iso2859.ts are checked cell by cell against readings that do not share their text:
 *   - Table 2-A against the master table's diagonal law: one step down the letters (a larger sample) and one step left
 *     along the AQLs (a smaller AQL) keep the same plan, so a cell is fixed by (row + column); the published table has
 *     two cells at its edges where the law would point off the table (A at AQL 10: ↓, R at AQL 0.015: ↑);
 *   - Table 1 against the published sample-size table (sample sizes, not letters, per lot range and level);
 *   - a list of plans read off the published table, the arrows followed by hand.
 */

// ---- Table 2-A ------------------------------------------------------------------------------------------------------

/** The plan series along a diagonal of Table 2-A (Re = Ac + 1). */
const SERIES = [1, 2, 3, 5, 7, 10, 14, 21] as const

function expectedCell(row: number, column: number): string {
  const letter = CODE_LETTERS[row]!
  const aql = AQL_COLUMNS[column]!
  if (letter === 'A' && aql === '10') return 'v'
  if (letter === 'R' && aql === '0.015') return '^'
  const s = row + column
  if (s <= 13) return 'v'
  if (s === 14) return '0/1'
  if (s === 15) return '^'
  if (s === 16) return 'v'
  if (s >= 25) return '^'
  const ac = SERIES[s - 17]!
  return `${ac}/${ac + 1}`
}

const cellText = (letter: CodeLetter, aql: AqlColumn): string => {
  const cell = tableCell(letter, aql)
  return cell.kind === 'plan' ? `${cell.accept}/${cell.reject}` : cell.kind === 'down' ? 'v' : '^'
}

describe('ISO 2859-1 Table 2-A (single sampling, normal inspection, master table)', () => {
  it('has 16 code letters with the published sample sizes and the AQL columns 0.010 … 10', () => {
    expect(CODE_LETTERS.join('')).toBe('ABCDEFGHJKLMNPQR')
    expect(CODE_LETTERS.map((letter) => SAMPLE_SIZES[letter])).toEqual([2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000])
    expect([...AQL_COLUMNS]).toEqual(['0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'])
  })

  it('every one of the 256 cells is the diagonal law of the master table, with its two edge cells', () => {
    const wrong: string[] = []
    CODE_LETTERS.forEach((letter, row) =>
      AQL_COLUMNS.forEach((aql, column) => {
        const want = expectedCell(row, column)
        const got = cellText(letter, aql)
        if (got !== want) wrong.push(`${letter}/${aql}: ${got}, published ${want}`)
      }),
    )
    expect(wrong).toEqual([])
  })

  it('every cell leads to a plan with Re = Ac + 1 inside the table (no arrow runs off it)', () => {
    for (const letter of CODE_LETTERS) for (const aql of AQL_COLUMNS) {
      const plan = tablePlan(letter, aql)
      expect(plan.reject).toBe(plan.accept + 1)
      expect(plan.sampleSize).toBe(SAMPLE_SIZES[plan.letter])
    }
  })

  // [letter, AQL, n, Ac, Re, arrow] read off the published table.
  const PUBLISHED: readonly [CodeLetter, AqlColumn, number, number, number, 'down' | 'up' | null][] = [
    ['H', '2.5', 50, 3, 4, null],
    ['H', '4.0', 50, 5, 6, null],
    ['H', '1.0', 50, 1, 2, null],
    ['H', '0.65', 80, 1, 2, 'down'],
    ['H', '0.40', 32, 0, 1, 'up'],
    ['H', '0.25', 50, 0, 1, null],
    ['H', '10', 50, 10, 11, null],
    ['A', '6.5', 2, 0, 1, null],
    ['A', '10', 5, 1, 2, 'down'],
    ['A', '4.0', 3, 0, 1, 'down'],
    ['A', '2.5', 5, 0, 1, 'down'],
    ['A', '0.010', 1250, 0, 1, 'down'],
    ['B', '6.5', 2, 0, 1, 'up'],
    ['B', '10', 5, 1, 2, 'down'],
    ['D', '2.5', 5, 0, 1, 'up'],
    ['D', '4.0', 13, 1, 2, 'down'],
    ['F', '1.0', 13, 0, 1, 'up'],
    ['J', '0.65', 80, 1, 2, null],
    ['J', '2.5', 80, 5, 6, null],
    ['K', '10', 125, 21, 22, null],
    ['L', '10', 125, 21, 22, 'up'],
    ['M', '6.5', 200, 21, 22, 'up'],
    ['Q', '0.010', 1250, 0, 1, null],
    ['Q', '0.015', 800, 0, 1, 'up'],
    ['Q', '0.025', 2000, 1, 2, 'down'],
    ['R', '0.010', 1250, 0, 1, 'up'],
    ['R', '0.015', 800, 0, 1, 'up'],
    ['R', '0.025', 2000, 1, 2, null],
    ['R', '0.65', 2000, 21, 22, null],
    ['R', '1.0', 1250, 21, 22, 'up'],
    ['R', '10', 125, 21, 22, 'up'],
  ]
  it.each(PUBLISHED)('%s at AQL %s: n %i, Ac %i, Re %i', (letter, aql, n, ac, re, arrow) => {
    expect(tablePlan(letter, aql)).toMatchObject({ sampleSize: n, accept: ac, reject: re, arrow })
  })
})

// ---- Table 1 --------------------------------------------------------------------------------------------------------

/** The published sample-size table: per lot range, n for I, II, III, S1, S2, S3, S4. */
const SAMPLE_SIZE_TABLE: readonly [number, number | null, number, number, number, number, number, number, number][] = [
  [2, 8, 2, 2, 3, 2, 2, 2, 2],
  [9, 15, 2, 3, 5, 2, 2, 2, 2],
  [16, 25, 3, 5, 8, 2, 2, 3, 3],
  [26, 50, 5, 8, 13, 2, 3, 3, 5],
  [51, 90, 5, 13, 20, 3, 3, 5, 5],
  [91, 150, 8, 20, 32, 3, 3, 5, 8],
  [151, 280, 13, 32, 50, 3, 5, 8, 13],
  [281, 500, 20, 50, 80, 3, 5, 8, 13],
  [501, 1200, 32, 80, 125, 5, 5, 13, 20],
  [1201, 3200, 50, 125, 200, 5, 8, 13, 32],
  [3201, 10000, 80, 200, 315, 5, 8, 20, 32],
  [10001, 35000, 125, 315, 500, 5, 8, 20, 50],
  [35001, 150000, 200, 500, 800, 8, 13, 32, 80],
  [150001, 500000, 315, 800, 1250, 8, 13, 32, 80],
  [500001, null, 500, 1250, 2000, 8, 13, 50, 125],
]

describe('ISO 2859-1 Table 1 (sample size code letters)', () => {
  it('has the 15 published lot ranges, end to end', () => {
    expect(TABLE_1.map((row) => [row.from, row.to])).toEqual(SAMPLE_SIZE_TABLE.map((row) => [row[0], row[1]]))
    TABLE_1.forEach((row, index) => index > 0 && expect(row.from).toBe(TABLE_1[index - 1]!.to! + 1))
  })

  it('every lot range and level gives the published sample size, at both ends of the range', () => {
    const order: InspectionLevel[] = ['I', 'II', 'III', 'S1', 'S2', 'S3', 'S4']
    const wrong: string[] = []
    for (const [from, to, ...sizes] of SAMPLE_SIZE_TABLE) {
      for (const lot of [from, to ?? 10_000_000]) {
        order.forEach((level, index) => {
          const n = SAMPLE_SIZES[codeLetterFor(lot, level)]
          if (n !== sizes[index]) wrong.push(`lot ${lot} level ${level}: n ${n}, published ${sizes[index]}`)
        })
      }
    }
    expect(wrong).toEqual([])
  })

  it('names the letters of the published rows (level II: 2-8 A … 500001+ Q)', () => {
    expect(SAMPLE_SIZE_TABLE.map(([from]) => codeLetterFor(from, 'II')).join('')).toBe('ABCDEFGHJKLMNPQ')
    expect(codeLetterFor(500_001, 'III')).toBe('R')
    expect(codeLetterFor(480, 'II')).toBe('H')
    expect(() => codeLetterFor(1, 'II')).toThrow(/starts at a lot of 2/)
    expect([...INSPECTION_LEVELS]).toEqual(['S1', 'S2', 'S3', 'S4', 'I', 'II', 'III'])
  })
})

// ---- the plan of a lot ----------------------------------------------------------------------------------------------

describe('samplingPlan (QHS-020)', () => {
  it('the design example: lot 480 · general level II → code letter H → inspect 50; critical 0/1, major 2.5 3/4, minor 4.0 5/6', () => {
    const plan = samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(plan).toMatchObject({ codeLetter: 'H', sampleSize: 50, hundredPercent: false, samplesDiffer: false })
    expect(plan.classes.map((entry) => [entry.defectClass, entry.aql, entry.accept, entry.reject])).toEqual([
      ['CRITICAL', '0', 0, 1],
      ['MAJOR', '2.5', 3, 4],
      ['MINOR', '4.0', 5, 6],
    ])
    expect(plan.words).toBe('Lot 480 · general level II → code letter H → inspect 50.')
    expect(plan.classWords[0]).toBe('Critical 0: accept 0, reject 1 (a critical defect is never accepted).')
    expect(acceptanceOf(plan)).toEqual({ acceptMajor: 3, acceptMinor: 5 })
  })

  it('arrows give the classes different samples: the largest is inspected, each class keeps its own plan (stricter, never looser)', () => {
    // Lot 50, level II → D (8): major 2.5 is ↑ (C, 5, 0/1), minor 4.0 is ↓ (E, 13, 1/2).
    const plan = samplingPlan({ lotSize: 50, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(plan).toMatchObject({ codeLetter: 'D', sampleSize: 13, samplesDiffer: true, hundredPercent: false })
    expect(plan.classes[1]).toMatchObject({ accept: 0, reject: 1, planLetter: 'C', planSampleSize: 5, arrow: 'up' })
    expect(plan.classes[2]).toMatchObject({ accept: 1, reject: 2, planLetter: 'E', planSampleSize: 13, arrow: 'down' })
    expect(plan.classWords[1]).toContain('Its plan asks 5; it is judged on the whole sample of 13, which is stricter.')
  })

  it('a sample as large as the lot inspects the whole lot (the seed: lot 2, level II → A, Ac 0 and 0)', () => {
    const plan = samplingPlan({ lotSize: 2, level: 'II', aqlMajor: '2.500', aqlMinor: '4.000' })
    expect(plan).toMatchObject({ codeLetter: 'A', sampleSize: 2, hundredPercent: true })
    expect(acceptanceOf(plan)).toEqual({ acceptMajor: 0, acceptMinor: 0 })
    expect(plan.words).toContain('the whole lot')
  })

  it('a lot of one unit has no code letter and accepts nothing; AQL 0 accepts nothing of its class', () => {
    const one = samplingPlan({ lotSize: 1, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(one).toMatchObject({ codeLetter: null, sampleSize: 1, hundredPercent: true })
    // The AQLs stay as asked (the record keeps them); nothing is accepted.
    expect(one.classes.map((entry) => [entry.aql, entry.accept, entry.reject])).toEqual([['0', 0, 1], ['2.5', 0, 1], ['4.0', 0, 1]])
    expect(one.classWords[1]).toContain('a lot of one unit is inspected whole')
    const zero = samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '0', aqlMinor: '4.0' })
    expect(zero.classes[1]).toMatchObject({ aql: '0', accept: 0, reject: 1, planLetter: null })
    expect(zero.sampleSize).toBe(50)
    expect(samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '0', aqlMinor: '0' }).sampleSize).toBe(50)
  })

  it('special levels and large lots', () => {
    // 501-1200 at S-3 → E (13): major 2.5 is ↓ to F (20, 1/2), minor 4.0 is E's own 1/2.
    expect(samplingPlan({ lotSize: 1000, level: 'S3', aqlMajor: '2.5', aqlMinor: '4.0' })).toMatchObject({ codeLetter: 'E', sampleSize: 20, samplesDiffer: true })
    expect(samplingPlan({ lotSize: 600_000, level: 'III', aqlMajor: '0.65', aqlMinor: '1.0' })).toMatchObject({ codeLetter: 'R', sampleSize: 2000 })
  })

  it('refuses what ISO 2859-1 has no plan for, in words', () => {
    expect(samplingProblems({ lotSize: 0, level: 'IV', aqlMajor: '3.0', aqlMinor: '15' }).map((problem) => problem.path)).toEqual(['lotSize', 'level', 'aqlMajor', 'aqlMinor'])
    expect(samplingProblems({ lotSize: 480, level: 'II', aqlMajor: '3.0', aqlMinor: '4' })[0]!.message).toContain('"3.0" is not one')
    expect(() => samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '3', aqlMinor: '4' })).toThrow(RangeError)
  })

  it('reads AQLs and levels however they are written', () => {
    expect(aqlColumnOf('2.500')).toBe('2.5')
    expect(aqlColumnOf('10.000')).toBe('10')
    expect(aqlColumnOf('0.000')).toBeNull()
    expect(isAqlValue('0.000')).toBe(true)
    expect(isAqlValue('0.1')).toBe(true)
    expect(isAqlValue('3.0')).toBe(false)
    expect(isAqlValue('-1')).toBe(false)
    expect(aqlWords('4.000')).toBe('4.0')
    expect(aqlWords('0.000')).toBe('0')
    expect(aqlStored('2.5')).toBe('2.500')
    expect(levelText('S3')).toBe('S-3')
    expect(levelOf('S-3')).toBe('S3')
    expect(levelOf(' ii ')).toBe('II')
    expect(levelOf('Level III')).toBe('III')
    expect(levelOf('IV')).toBeNull()
  })
})

// ---- the result (QHS-013) -------------------------------------------------------------------------------------------

describe('the automatic result (QHS-013), the same model as the DS AqlCounter', () => {
  it('a class is ok, at its limit or rejecting; Ac 0 with nothing found is fine', () => {
    expect(classState(0, 0)).toBe('ok')
    expect(classState(0, 1)).toBe('reject')
    expect(classState(3, 2)).toBe('ok')
    expect(classState(3, 3)).toBe('limit')
    expect(classState(3, 4)).toBe('reject')
  })

  it('rejects at once mid-sample; accepts only the whole sample; an unknown count is open', () => {
    expect(aqlVerdict({ sampleSize: 50, inspected: 10, classes: [{ accept: 3, found: 4 }] })).toBe('reject')
    expect(aqlVerdict({ sampleSize: 50, inspected: 49, classes: [{ accept: 3, found: 3 }] })).toBe('open')
    expect(aqlVerdict({ sampleSize: 50, inspected: 50, classes: [{ accept: 3, found: 3 }] })).toBe('accept')
    expect(aqlVerdict({ sampleSize: 50, inspected: null, classes: [{ accept: 3, found: 0 }] })).toBe('open')
  })

  it('says each class in words, as the design does', () => {
    expect(classWords('MAJOR', 3, 3)).toBe('Major: 3 found, accept up to 3 - passes. One more rejects the lot.')
    expect(classWords('MINOR', 5, 6)).toBe('Minor: 6 found, accept up to 5 - rejects the lot.')
    expect(classWords('CRITICAL', 0, 0)).toBe('Critical: none found - a critical defect is never accepted.')
  })

  const plan = samplingPlan({ lotSize: 480, level: 'II', aqlMajor: '2.5', aqlMinor: '4.0' })
  const counted = (critical: number, major: number, minor: number, inspected: number | null = 38) =>
    ({ sampleSize: plan.sampleSize, inspected, classes: plan.classes.map((entry) => ({ defectClass: entry.defectClass, aql: entry.aql, accept: entry.accept, found: { CRITICAL: critical, MAJOR: major, MINOR: minor }[entry.defectClass] })) }) as const

  it('within the numbers: PASS now, open until the whole sample is counted', () => {
    const result = aqlResult(counted(0, 3, 2))
    expect(result).toMatchObject({ verdict: 'open', resultNow: 'PASS', reasons: [], byCountsOnly: false, blockers: [] })
    expect(result.progress).toEqual({ inspected: 38, sampleSize: 50, remaining: 12, words: '38 of 50 inspected' })
    expect(result.classes[1]).toMatchObject({ state: 'limit', spare: 0 })
    expect(result.overrideWords).toContain('signing FAIL over it is an override')
  })

  it('over an acceptance number only: FAIL, and a PASS over it is an override with a reason', () => {
    const result = aqlResult(counted(0, 4, 2))
    expect(result).toMatchObject({ verdict: 'reject', resultNow: 'FAIL', byCountsOnly: true })
    expect(result.reasons).toEqual(['4 units with a major defect; the plan accepts 3.'])
    expect(result.overrideWords).toContain('its release needs a second person')
  })

  it('a critical defect or a failed critical check: FAIL, never a PASS over it; a missing mandatory check holds a PASS', () => {
    const critical = aqlResult(counted(1, 0, 0))
    expect(critical).toMatchObject({ verdict: 'reject', resultNow: 'FAIL', byCountsOnly: false })
    expect(critical.overrideWords).toMatch(/^A PASS over this FAIL is never signed/)
    const checks = aqlResult({ ...counted(0, 0, 0, 50), checks: { failed: ['CE mark'], failedCritical: ['CE mark'], mandatoryMissing: ['Chest'] } })
    expect(checks.reasons).toEqual(['Critical checks failed: CE mark.'])
    expect(checks.blockers).toEqual(['Mandatory checks without a result: Chest.'])
    expect(checks.verdict).toBe('accept')
    expect(aqlResult(counted(0, 0, 0, null)).progress).toBeNull()
  })
})

// ---- profiles (QHS-021) ---------------------------------------------------------------------------------------------

describe('AQL profiles and the source chain (QHS-021)', () => {
  it('a new profile needs a code, a name, a level and two AQLs of Table 2-A; critical is locked at 0', () => {
    expect(profileDraftProblems({ code: 'AQL-EXM', name: 'Brand', inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0' }, true)).toEqual([])
    expect(profileDraftProblems({ code: 'aql exm', name: ' ', inspectionLevel: 'S-3', aqlMajor: '3', aqlMinor: '15', aqlCritical: '0.65' }, true).map((problem) => problem.path)).toEqual([
      'code',
      'name',
      'inspectionLevel',
      'aqlMajor',
      'aqlMinor',
      'aqlCritical',
    ])
    expect(profileDraftProblems({ aqlCritical: '1' }, false)[0]!.message).toContain('Regulation (EU) 2016/425')
    expect(profileDraftProblems({ aqlCritical: '0.000' }, false)).toEqual([])
    expect(profileDraftProblems({ code: 'NEW' }, false)[0]!.path).toBe('code')
    expect(profileDraftProblems({ name: 'Renamed' }, false)).toEqual([])
    expect(reasonProblem('ok')?.path).toBe('reason')
    expect(reasonProblem('The customer asked for a tighter minor.')).toBeNull()
  })

  const profiles: ProfileFacts[] = [
    { id: 'p-std', code: 'AQL-STD', active: true, isDefault: true },
    { id: 'p-cust', code: 'AQL-EXM', active: true, isDefault: false },
    { id: 'p-style', code: 'AQL-JKT', active: true, isDefault: false },
    { id: 'p-pair', code: 'AQL-PAIR', active: true, isDefault: false },
    { id: 'p-old', code: 'AQL-OLD', active: false, isDefault: false },
  ]
  const assignments: AssignmentFacts[] = [
    { id: 'a-cust', profileId: 'p-cust', customerId: 'c1', styleId: null, active: true },
    { id: 'a-style', profileId: 'p-style', customerId: null, styleId: 's1', active: true },
    { id: 'a-pair', profileId: 'p-pair', customerId: 'c1', styleId: 's1', active: true },
    { id: 'a-ended', profileId: 'p-cust', customerId: 'c2', styleId: null, active: false },
    { id: 'a-retired', profileId: 'p-old', customerId: 'c3', styleId: null, active: true },
  ]

  it('takes the first step that answers: plan version, style of the customer, style, customer, company default', () => {
    expect(resolveProfile({ planProfileId: 'p-cust', styleId: 's1', customerIds: ['c1'] }, profiles, assignments)).toMatchObject({ profileId: 'p-cust', source: 'PLAN_VERSION' })
    expect(resolveProfile({ styleId: 's1', customerIds: ['c1'] }, profiles, assignments)).toMatchObject({ profileId: 'p-pair', source: 'STYLE_CUSTOMER', assignmentId: 'a-pair' })
    expect(resolveProfile({ styleId: 's1', customerIds: ['c9'] }, profiles, assignments)).toMatchObject({ profileId: 'p-style', source: 'STYLE' })
    expect(resolveProfile({ styleId: 's9', customerIds: ['c1'] }, profiles, assignments)).toMatchObject({ profileId: 'p-cust', source: 'CUSTOMER', words: "The customer's profile: AQL-EXM." })
    expect(resolveProfile({ styleId: 's9', customerIds: ['c9'] }, profiles, assignments)).toMatchObject({ profileId: 'p-std', source: 'COMPANY_DEFAULT' })
  })

  it('an ended assignment or a retired profile never answers; goods for several customers skip the customer steps', () => {
    expect(resolveProfile({ styleId: null, customerIds: ['c2'] }, profiles, assignments).source).toBe('COMPANY_DEFAULT')
    expect(resolveProfile({ styleId: null, customerIds: ['c3'] }, profiles, assignments).source).toBe('COMPANY_DEFAULT')
    expect(resolveProfile({ planProfileId: 'p-old', styleId: null, customerIds: [] }, profiles, assignments).steps[0]!.skipped).toBe('The plan names a retired profile.')
    const many = resolveProfile({ styleId: 's9', customerIds: ['c1', 'c2'] }, profiles, assignments)
    expect(many).toMatchObject({ profileId: 'p-std', source: 'COMPANY_DEFAULT' })
    expect(many.words).toContain('The goods are for 2 customers')
    expect(resolveProfile({ styleId: null, customerIds: [] }, profiles.filter((profile) => !profile.isDefault), [])).toMatchObject({ profileId: null, source: 'NONE' })
  })
})
