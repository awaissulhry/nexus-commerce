import { describe, expect, it } from 'vitest'
import { databaseCostRateRefusal } from './refusals'
import { availableMinutesOf, calcWords, costPerMinuteOf, cpmKey, figuresProblems, fitsCostPerMinute, minutesBasisProblems, monthEnd, monthsOf, monthsProblems, seatsOf } from './rules'

/** The cost-per-minute calculator (B-W2b-419; FIN-005), pure. Made-up figures, worked out by hand. */

describe('the cost per minute of a department', () => {
  it('is direct ÷ minutes + indirect + overhead, rounded once, half up, to 6 places', () => {
    // 41,600.00 ÷ 104,000 = 0.40; + 0.06 + 0.04 = 0.50.
    expect(costPerMinuteOf({ directLabourCost: '41600', availableMinutes: '104000', indirectPerMinute: '0.06', overheadPerMinute: '0.04' })).toBe('0.500000')
    // 1 ÷ 3 = 0.333333|33… down; 2 ÷ 3 = 0.666666|66… up.
    expect(costPerMinuteOf({ directLabourCost: '1', availableMinutes: '3', indirectPerMinute: '0', overheadPerMinute: '0' })).toBe('0.333333')
    expect(costPerMinuteOf({ directLabourCost: '2', availableMinutes: '3', indirectPerMinute: '0', overheadPerMinute: '0' })).toBe('0.666667')
    // Exactly half at the 7th place rounds up once (not twice): 0.0000005 → 0.000001.
    expect(costPerMinuteOf({ directLabourCost: '0.000001', availableMinutes: '2', indirectPerMinute: '0', overheadPerMinute: '0' })).toBe('0.000001')
    // The parts are added before the one rounding: 0.1234564 + 0.0000001 = 0.1234565 → 0.123457.
    expect(costPerMinuteOf({ directLabourCost: '0.1234564', availableMinutes: '1', indirectPerMinute: '0.0000001', overheadPerMinute: '0' })).toBe('0.123457')
    expect(fitsCostPerMinute('999999999999.999999')).toBe(true)
    expect(fitsCostPerMinute('1000000000000.000000')).toBe(false)
  })

  it('takes costs of 0 or more and minutes above 0', () => {
    expect(figuresProblems({ directLabourCost: '0', availableMinutes: '1', indirectPerMinute: '0', overheadPerMinute: '0' })).toEqual([])
    expect(figuresProblems({ directLabourCost: '-1', availableMinutes: '0', indirectPerMinute: '0.1234567', overheadPerMinute: '1e3' }).map((issue) => issue.path)).toEqual([
      'body/directLabourCost',
      'body/indirectPerMinute',
      'body/overheadPerMinute',
      'body/availableMinutes',
    ])
    expect(figuresProblems({ availableMinutes: '0.00001' })[0]?.path).toBe('body/availableMinutes')
  })

  it('covers whole months, at most a year', () => {
    expect(monthsProblems('2026-10-01', '2026-10-31', { maxMonths: 12 })).toEqual([])
    expect(monthsProblems('2026-02-01', '2026-02-28')).toEqual([])
    expect(monthsProblems('2028-02-01', '2028-02-29')).toEqual([])
    expect(monthsProblems('2026-10-02', '2026-10-31').map((issue) => issue.path)).toEqual(['body/periodStart'])
    expect(monthsProblems('2026-10-01', '2026-10-30').map((issue) => issue.path)).toEqual(['body/periodEnd'])
    expect(monthsProblems('2026-10-01', '2026-09-30')).toEqual([{ path: 'body/periodEnd', message: 'The last day is not before the first day (2026-10-01).' }])
    expect(monthsProblems('2026-01-01', '2027-01-31', { maxMonths: 12 })).toEqual([{ path: 'body/periodEnd', message: 'At most 12 months.' }])
    expect(monthsProblems('2026-10-01', null).map((issue) => issue.path)).toEqual(['body/periodEnd'])
    expect(monthsProblems('2026-10-01', null, { open: true })).toEqual([])
    expect(monthsProblems('2026-10-01', '2026-10-30', { prefix: 'querystring/' })[0]?.path).toBe('querystring/periodEnd')
    expect([monthEnd('2026-02-10'), monthEnd('2026-12-01'), monthEnd('2028-02-01')]).toEqual(['2026-02-28', '2026-12-31', '2028-02-29'])
    expect(monthsOf('2026-11-01', '2027-10-31')).toBe(12)
  })

  it('counts the available minutes as working minutes × planned seats, and the seats as planning does', () => {
    // Sewing: 22 days × 480 minutes × 8 seats = 84,480; the cutting table: 22 × 480 × 2 = 21,120.
    expect(availableMinutesOf([{ workingMinutes: 10_560, seats: 8 }, { workingMinutes: 10_560, seats: 2 }])).toBe('105600')
    expect(availableMinutesOf([])).toBe('0')
    expect([seatsOf(8, 2), seatsOf(null, 2), seatsOf(null, 0)]).toEqual([8, 2, 0])
  })

  it('keeps how the minutes were counted without a headcount, a person or a pay', () => {
    expect(minutesBasisProblems(undefined)).toEqual([])
    expect(minutesBasisProblems({ source: 'CALENDARS', workCentres: [{ id: 'x', workingDays: 22, availableMinutes: '84480', capacityFrom: 'CAPACITY' }] })).toEqual([])
    expect(minutesBasisProblems({ headcount: 8, lines: [{ peoplePerShift: 4 }], 'avg-wage': 1 }).map((issue) => issue.path)).toEqual([
      'body/minutesBasis/headcount',
      'body/minutesBasis/lines/0/peoplePerShift',
      'body/minutesBasis/avg-wage',
    ])
    expect(minutesBasisProblems([1, 2])).toEqual([{ path: 'body/minutesBasis', message: 'Expected an object.' }])
    expect(minutesBasisProblems({ note: 'x'.repeat(70_000) })).toEqual([{ path: 'body/minutesBasis', message: 'At most 64 KiB.' }])
  })

  it('has the key of the database and words without a figure', () => {
    expect(cpmKey('c', 'SEWING', null)).toBe('cpm:c:SEWING:all')
    expect(cpmKey('c', 'CUTTING', 'w')).toBe('cpm:c:CUTTING:w')
    expect(calcWords(false, null)).toMatch(/^Not applied/)
    expect(calcWords(true, '2026-12-01')).toBe('Applied: the labour rate from 2026-12-01 came from this calculation. It changes no more.')
    expect(calcWords(true, null)).toMatch(/^Applied as the labour rate/)
  })
})

describe("the database's refusals of the cost rates", () => {
  it('reads them back in words, without the record id', () => {
    const id = '0190a8b2-1111-7222-8333-444455556666'
    expect(databaseCostRateRefusal(`costing: overhead rule ${id} overlaps another active rule of the same company, basis and kind of work centre; end that one first`)).toEqual({
      code: 'OVERLAPS',
      message: 'Overhead rule overlaps another active rule of the same company, basis and kind of work centre; end that one first.',
    })
    expect(databaseCostRateRefusal(`costing: cost-per-minute calculation ${id} was applied as a labour rate: it changes no more`)?.code).toBe('APPLIED')
    expect(databaseCostRateRefusal(`costing: cost-per-minute calculation ${id} has costs of 0 or more over minutes above 0`)).toEqual({ code: 'DATABASE', message: 'Cost-per-minute calculation has costs of 0 or more over minutes above 0.' })
    expect(databaseCostRateRefusal('costing: cost sheet line x is …')).toBeNull()
    expect(databaseCostRateRefusal('cost: work order x is CLOSED')).toBeNull()
  })
})
