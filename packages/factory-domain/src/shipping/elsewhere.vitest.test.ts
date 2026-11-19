import { describe, expect, it } from 'vitest'
import {
  citableOnInvoice,
  coveringReleaseAt,
  documentsLineOf,
  earliestLeaving,
  ELSEWHERE_LIMITS,
  ELSEWHERE_WORDS,
  elsewhereProblems,
  elsewhereRefusalPath,
  holdRefusal,
  isHeld,
  leftOn,
  nexusDdtWords,
  overrideLineOf,
  paperDdtNumber,
  type ElsewhereCell,
  type ElsewhereInput,
} from './elsewhere'

/** B-OP-032 (order page N5; R-2, R-9, R-10, R-23): "Record a shipment made elsewhere", its pure rules. Made-up data only. */

const NOW = new Date('2026-11-19T10:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
const daysAgo = (days: number) => hoursAgo(days * 24)
const cell = (over: Partial<ElsewhereCell> = {}): ElsewhereCell => ({ workOrderSizeId: 'c1', label: 'WO-DEMO-0042 BLK 52', quantity: 3, shippable: 5, releasedAt: daysAgo(5), serialTracked: false, serials: 0, ...over })
const input = (over: Partial<ElsewhereInput> = {}): ElsewhereInput => ({ shippedAt: daysAgo(2), externalDdt: { number: '123/2026', date: '2026-11-17' }, ddtRequired: true, cells: [cell()], ...over })
const codes = (value: ElsewhereInput) => elsewhereProblems(value, NOW).map((problem) => problem.code)

describe('the release that covers a cell’s garments', () => {
  it('is the first release whose running sum reaches what the cell has on shipments plus these', () => {
    const releases = [
      { quantity: 2, at: '2026-11-03T09:00:00.000Z' },
      { quantity: 4, at: '2026-11-01T09:00:00.000Z' },
      { quantity: 3, at: '2026-11-10T09:00:00.000Z' },
    ]
    expect(coveringReleaseAt(releases, 4)).toBe('2026-11-01T09:00:00.000Z')
    expect(coveringReleaseAt(releases, 6)).toBe('2026-11-03T09:00:00.000Z')
    expect(coveringReleaseAt(releases, 7)).toBe('2026-11-10T09:00:00.000Z')
    expect(coveringReleaseAt(releases, 10)).toBeNull()
    expect(coveringReleaseAt([], 1)).toBeNull()
  })

  it('the earliest the goods may have left is the latest covering release; unknown while a line is not covered', () => {
    expect(earliestLeaving([{ releasedAt: '2026-11-01T09:00:00.000Z' }, { releasedAt: '2026-11-04T09:00:00.000Z' }])).toBe('2026-11-04T09:00:00.000Z')
    expect(earliestLeaving([{ releasedAt: '2026-11-01T09:00:00.000Z' }, { releasedAt: null }])).toBeNull()
  })
})

describe('when the goods left (R-2)', () => {
  it('not in the future (5 minutes of tolerance, as the database), at most 60 days back, not before the release', () => {
    expect(codes(input())).toEqual([])
    expect(codes(input({ shippedAt: new Date(NOW.getTime() + 4 * 60_000).toISOString() }))).toEqual([])
    expect(codes(input({ shippedAt: new Date(NOW.getTime() + 6 * 60_000).toISOString() }))).toContain('FUTURE')
    expect(codes(input({ shippedAt: daysAgo(ELSEWHERE_LIMITS.daysBack - 0.01), externalDdt: { number: '1', date: '2026-09-20' }, cells: [cell({ releasedAt: daysAgo(61) })] }))).toEqual([])
    expect(codes(input({ shippedAt: daysAgo(ELSEWHERE_LIMITS.daysBack + 0.01), externalDdt: { number: '1', date: '2026-09-19' }, cells: [cell({ releasedAt: daysAgo(70) })] }))).toContain('TOO_OLD')
    expect(codes(input({ shippedAt: daysAgo(6), externalDdt: { number: '1', date: '2026-11-13' } }))).toEqual(['BEFORE_RELEASE'])
  })

  it('only released garments: more than the cell can ship, or nothing released, is refused with the cell named', () => {
    const over = elsewhereProblems(input({ cells: [cell({ quantity: 6, shippable: 5 })] }), NOW)
    expect(over.map((problem) => [problem.code, problem.path])).toEqual([['NOT_RELEASED', 'body/lines/0/quantity']])
    expect(over[0]!.message).toContain('WO-DEMO-0042 BLK 52 has 5 released')
    expect(codes(input({ cells: [cell({ releasedAt: null })] }))).toEqual(['NOT_RELEASED'])
    expect(codes(input({ cells: [] }))).toContain('NO_LINES')
  })

  it('a serial-tracked style names the serial of each garment (Q31)', () => {
    expect(codes(input({ cells: [cell({ serialTracked: true, serials: 2 })] }))).toEqual(['SERIALS'])
    expect(codes(input({ cells: [cell({ serialTracked: true, serials: 3 })] }))).toEqual([])
  })
})

describe('the paper DDT (R-23, R-10)', () => {
  it('is required unless an immediate invoice travelled instead', () => {
    expect(codes(input({ externalDdt: null }))).toEqual(['DDT_REQUIRED'])
    expect(codes(input({ externalDdt: null, ddtRequired: false }))).toEqual([])
  })

  it('its number is 1 to 40 characters on one line, as printed (trimmed); dated on or before the day it left in Rome', () => {
    expect(codes(input({ externalDdt: { number: '   ', date: '2026-11-17' } }))).toEqual(['DDT_NUMBER'])
    expect(codes(input({ externalDdt: { number: 'x'.repeat(41), date: '2026-11-17' } }))).toEqual(['DDT_NUMBER'])
    expect(codes(input({ externalDdt: { number: '12\n3', date: '2026-11-17' } }))).toEqual(['DDT_NUMBER'])
    expect(paperDdtNumber('  123/2026 ')).toBe('123/2026')
    expect(codes(input({ externalDdt: { number: '123', date: '2026-11-18' } }))).toEqual(['DDT_AFTER_LEFT'])
    // 23:30 UTC on 10 November is already 11 November in Rome: a DDT of the 11th is on the day it left.
    expect(leftOn('2026-11-10T23:30:00.000Z')).toBe('2026-11-11')
    expect(codes(input({ shippedAt: '2026-11-10T23:30:00.000Z', externalDdt: { number: '123', date: '2026-11-11' }, cells: [cell({ releasedAt: '2026-11-09T08:00:00.000Z' })] }))).toEqual([])
  })

  it('"already recorded" names no customer; a Nexus DDT of it is refused with its paper DDT; the e-invoice cites up to 20 plain characters', () => {
    expect(ELSEWHERE_WORDS.DDT_NUMBER_USED).toBe('That DDT number and date are already recorded.')
    expect(elsewhereRefusalPath('DDT_NUMBER_USED')).toBe('refusal/DDT_NUMBER_USED')
    expect(nexusDdtWords({ number: '123/2026' })).toBe('This shipment left with paper DDT n. 123/2026: Nexus issues no DDT of it.')
    expect(nexusDdtWords(null)).toContain('immediate invoice')
    expect(citableOnInvoice('123/2026')).toBe(true)
    expect(citableOnInvoice('x'.repeat(21))).toBe(false)
    expect(citableOnInvoice('DDT n° 12')).toBe(false)
  })
})

describe('a customer on hold (R-9)', () => {
  const held = { accountHold: 'C-DEMO-01 is on hold: the invoices are overdue.', creditHeld: false }
  it('is refused unless a person who may release holds says why', () => {
    expect(isHeld({ accountHold: null, creditHeld: false })).toBe(false)
    expect(holdRefusal({ accountHold: null, creditHeld: false }, { mayRelease: false, reason: null })).toBeNull()
    expect(holdRefusal(held, { mayRelease: false, reason: 'Delivered by the van that morning' })?.code).toBe('HELD')
    expect(holdRefusal(held, { mayRelease: true, reason: '  ' })?.code).toBe('REASON_REQUIRED')
    expect(holdRefusal(held, { mayRelease: true, reason: 'Delivered by the van that morning' })).toBeNull()
    expect(holdRefusal({ accountHold: null, creditHeld: true }, { mayRelease: false, reason: null })?.message).toBe(ELSEWHERE_WORDS.HELD)
  })

  it('the office lines say what was recorded over the hold, and which documents were not on file (it + en)', () => {
    expect(overrideLineOf({ shipment: 'SH-00170', reason: 'Delivered by the van that morning', ddt: '123/2026' }, 'en')).toBe('SH-00170 (paper DDT 123/2026) was recorded as made elsewhere while the customer was on hold. Reason: Delivered by the van that morning')
    expect(overrideLineOf({ shipment: 'SH-00170', reason: 'Consegnata dal furgone', ddt: null }, 'it')).toBe('SH-00170 è registrata come fatta altrove mentre il cliente era bloccato. Motivo: Consegnata dal furgone')
    expect(documentsLineOf({ shipment: 'SH-00170', missing: ['DEMO-JKT-01 has no Declaration of Conformity on file.'] }, 'en')).toContain('left without every PPE document on file')
  })
})
