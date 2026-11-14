import { describe, expect, it } from 'vitest'
import { carrierKeyOf, cutOffFor, cutOffProblems, minuteOf, weekdayOf } from './cutoff'
import { requirementRemarks } from './ddt-remarks'
import { earliestDay, riskOf, type RiskInput } from './risk'
import { cartonCodeOf, looksLikeSscc, searchTerm } from './search'

// Made-up days, carriers and numbers.
describe('carrier cut-offs (LOG-018)', () => {
  it('reads a weekday and an HH:MM time', () => {
    expect(weekdayOf('2026-11-16')).toBe('MONDAY')
    expect(weekdayOf('2026-11-15')).toBe('SUNDAY')
    expect(minuteOf('16:30')).toBe(990)
    expect(minuteOf('24:00')).toBeNull()
  })

  it("takes the carrier's own cut-off, else the site's; none for the customer collecting", () => {
    const rows = [{ carrierCode: 'test-express', weekday: 'MONDAY' as const, cutOffTime: '16:30' }]
    expect(cutOffFor(rows, 'test-express', 'MONDAY', '17:00')).toEqual({ time: '16:30', source: 'CARRIER' })
    expect(cutOffFor(rows, 'test-express', 'TUESDAY', '17:00')).toEqual({ time: '17:00', source: 'SITE' })
    expect(cutOffFor(rows, 'SENDER', 'MONDAY', '17:00')).toEqual({ time: '17:00', source: 'SITE' })
    expect(cutOffFor(rows, 'RECIPIENT', 'MONDAY', '17:00')).toBeNull()
    expect(cutOffFor([], 'none', 'MONDAY', null)).toBeNull()
    expect(carrierKeyOf({ transportBy: 'CARRIER', carrierCode: null })).toBe('none')
    expect(carrierKeyOf({ transportBy: 'SENDER', carrierCode: 'test-express' })).toBe('SENDER')
  })

  it('refuses a table with a bad code, time or a weekday twice', () => {
    const issues = cutOffProblems([
      { carrierCode: 'test express', weekday: 'MONDAY', time: '16:30' },
      { carrierCode: 'test-van', weekday: 'MONDAY', time: '25:00' },
      { carrierCode: 'test-van', weekday: 'MONDAY', time: '15:00' },
    ])
    expect(issues.map((issue) => issue.path)).toEqual(['cutOffs/0/carrierCode', 'cutOffs/1/time', 'cutOffs/2/weekday'])
  })
})

describe('what will miss the promise (LOG-018, LOG-110)', () => {
  const now = new Date('2026-11-16T13:00:00Z')
  const input = (over: Partial<RiskInput>): RiskInput => ({ shipBy: '2026-11-16', today: '2026-11-16', now, status: 'DRAFT', held: false, siteOpen: true, cutOffAt: new Date('2026-11-16T15:30:00Z'), dayEnd: new Date('2026-11-16T23:00:00Z'), ...over })

  it('says late, held, past the cut-off, at risk, due today, later or no date', () => {
    expect(riskOf(input({ shipBy: null }))).toBe('NO_DATE')
    expect(riskOf(input({ shipBy: '2026-11-17' }))).toBe('LATER')
    expect(riskOf(input({ held: true }))).toBe('HELD')
    expect(riskOf(input({ shipBy: '2026-11-13' }))).toBe('LATE')
    expect(riskOf(input({ siteOpen: false }))).toBe('MISSED_CUT_OFF')
    expect(riskOf(input({ cutOffAt: new Date('2026-11-16T12:59:00Z') }))).toBe('MISSED_CUT_OFF')
    // 150 minutes left: a DRAFT is on track with the 120-minute window, at risk with a 180-minute one.
    expect(riskOf(input({}))).toBe('DUE_TODAY')
    expect(riskOf(input({ warnMinutes: 180 }))).toBe('AT_RISK')
    expect(riskOf(input({ status: 'PACKED', warnMinutes: 180 }))).toBe('DUE_TODAY')
    // No shipment yet counts as not packed; no cut-off known: the end of the site's day.
    expect(riskOf(input({ status: null, cutOffAt: null, now: new Date('2026-11-16T21:30:00Z') }))).toBe('AT_RISK')
    expect(earliestDay([null, '2026-11-18', '2026-11-16'])).toBe('2026-11-16')
  })
})

describe('the search box (LOG-120) and the DDT remarks (LQ1:02)', () => {
  it('cleans the term, reads a carton marks code and knows an SSCC', () => {
    expect(searchTerm('  SH-00012  ')).toBe('SH-00012')
    expect(searchTerm('S')).toBeNull()
    expect(cartonCodeOf('SH-00012-3')).toEqual({ shipmentNumber: 'SH-00012', cartonNumber: 3 })
    expect(cartonCodeOf('SH-00012-0')).toBeNull()
    expect(looksLikeSscc('(00)123456789012345675')).toBe(true)
    expect(looksLikeSscc('TEST-SN-0001')).toBe(false)
  })

  it("prints the customer's requirements once each, within 1000 characters", () => {
    expect(requirementRemarks([])).toBeNull()
    expect(requirementRemarks([{ words: 'Put the PO number on every carton.' }, { words: ' Put the PO number on every carton. ' }, { words: 'Deliver before noon.' }])).toBe('Put the PO number on every carton.\nDeliver before noon.')
    const long = requirementRemarks([{ words: 'x'.repeat(1200) }])!
    expect(long.length).toBe(1000)
    expect(long.endsWith('…')).toBe(true)
  })
})
