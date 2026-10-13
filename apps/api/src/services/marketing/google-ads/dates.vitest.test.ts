/**
 * Google Ads step 1a — the read's windows in the ACCOUNT's time zone: the 06:25 UTC run on a Tuesday is still
 * Monday evening in Los Angeles; Sunday re-reads 35 days; daylight-saving days; the change history's 30 days.
 */
import { describe, expect, it } from 'vitest'
import {
  accountToday, accountYesterday, addDays, backfillWindow, changeHistoryWindow, chunkWindow, dailyWindow, dateToDay, dayCount,
  dayIn, daysOf, dayToDate, localDateTime, weekdayOf, zonedToUtc,
} from './dates.js'

const RUN = new Date('2026-10-13T06:25:00Z') // a Tuesday, the cron's minute

describe('account days', () => {
  it('06:25 UTC: Rome is already on Tuesday, Los Angeles still on Monday', () => {
    expect(accountToday('Europe/Rome', RUN)).toBe('2026-10-13')
    expect(accountYesterday('Europe/Rome', RUN)).toBe('2026-10-12')
    expect(accountToday('America/Los_Angeles', RUN)).toBe('2026-10-12')
    expect(accountYesterday('America/Los_Angeles', RUN)).toBe('2026-10-11')
  })

  it('the daily window: 14 days ending yesterday, never today', () => {
    expect(dailyWindow('Europe/Rome', RUN)).toEqual({ from: '2026-09-29', to: '2026-10-12', kind: 'DAILY' })
    expect(dailyWindow('America/Los_Angeles', RUN)).toEqual({ from: '2026-09-28', to: '2026-10-11', kind: 'DAILY' })
    expect(dayCount(dailyWindow('Europe/Rome', RUN))).toBe(14)
  })

  it('on the account\'s Sunday the window is 35 days', () => {
    const sunday = new Date('2026-10-18T06:25:00Z')
    expect(weekdayOf('2026-10-18')).toBe(0)
    expect(dailyWindow('Europe/Rome', sunday)).toEqual({ from: '2026-09-13', to: '2026-10-17', kind: 'WEEKLY' })
    expect(dayCount(dailyWindow('Europe/Rome', sunday))).toBe(35)
    // Still Saturday evening in Los Angeles: its Sunday re-read comes with the next day's run.
    expect(dailyWindow('America/Los_Angeles', sunday)).toEqual({ from: '2026-10-03', to: '2026-10-16', kind: 'DAILY' })
    expect(dailyWindow('America/Los_Angeles', new Date('2026-10-19T06:25:00Z')).kind).toBe('WEEKLY')
  })

  it('the daylight-saving day: Rome falls back on Sunday 25 October', () => {
    const run = new Date('2026-10-25T06:25:00Z')
    expect(accountToday('Europe/Rome', run)).toBe('2026-10-25')
    expect(dailyWindow('Europe/Rome', run)).toEqual({ from: '2026-09-20', to: '2026-10-24', kind: 'WEEKLY' })
    expect(zonedToUtc('2026-10-24 12:00:00', 'Europe/Rome').toISOString()).toBe('2026-10-24T10:00:00.000Z')
    expect(zonedToUtc('2026-10-25 12:00:00', 'Europe/Rome').toISOString()).toBe('2026-10-25T11:00:00.000Z')
    // Just before and after midnight UTC on the switch day.
    expect(dayIn(new Date('2026-10-24T22:30:00Z'), 'Europe/Rome')).toBe('2026-10-25')
    expect(dayIn(new Date('2026-10-25T22:30:00Z'), 'Europe/Rome')).toBe('2026-10-25')
    // Spring forward: 02:30 does not exist in Rome on 29 March; it is read as the hour after.
    expect(zonedToUtc('2026-03-29 02:30:00', 'Europe/Rome').toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // Los Angeles falls back on 1 November: 01:30 happens twice, the first one is meant.
    expect(zonedToUtc('2026-11-01 01:30:00', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  it('the backfill: 400 days ending yesterday', () => {
    expect(backfillWindow('Europe/Rome', RUN)).toEqual({ from: '2025-09-08', to: '2026-10-12' })
    expect(dayCount(backfillWindow('Europe/Rome', RUN))).toBe(400)
    expect(backfillWindow('Europe/Rome', RUN, 30)).toEqual({ from: '2026-09-13', to: '2026-10-12' })
  })

  it('chunks are contiguous, oldest first, the last one partial', () => {
    const chunks = chunkWindow(backfillWindow('Europe/Rome', RUN), 30)
    expect(chunks).toHaveLength(14)
    expect(chunks[0]).toEqual({ from: '2025-09-08', to: '2025-10-07' })
    expect(chunks.at(-1)).toEqual({ from: '2026-10-03', to: '2026-10-12' })
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].from).toBe(addDays(chunks[i - 1].to, 1))
    expect(chunks.reduce((n, c) => n + dayCount(c), 0)).toBe(400)
    expect(() => chunkWindow({ from: '2026-10-01', to: '2026-10-02' }, 0)).toThrow()
  })

  it('days, @db.Date values and wall clocks', () => {
    expect(daysOf({ from: '2026-02-27', to: '2026-03-02' })).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
    expect(dayToDate('2026-10-12').toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(dateToDay(dayToDate('2026-10-12'))).toBe('2026-10-12')
    expect(localDateTime(RUN, 'Europe/Rome')).toBe('2026-10-13 08:25:00')
    expect(localDateTime(RUN, 'America/Los_Angeles')).toBe('2026-10-12 23:25:00')
    expect(localDateTime(new Date('2026-10-12T22:00:00Z'), 'Europe/Rome')).toBe('2026-10-13 00:00:00')
    expect(zonedToUtc('2026-10-12 13:00:00.123456', 'Europe/Rome').toISOString()).toBe('2026-10-12T11:00:00.123Z')
    expect(zonedToUtc('2026-10-12', 'America/Los_Angeles').toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(() => zonedToUtc('12/10/2026', 'Europe/Rome')).toThrow()
    expect(() => accountToday('Not/AZone', RUN)).toThrow(RangeError)
  })
})

describe('the change history window', () => {
  it('a first read starts at the first second of the account day 29 days ago', () => {
    const w = changeHistoryWindow('Europe/Rome', RUN, null)
    expect(w.startLiteral).toBe('2026-09-14 00:00:00')
    expect(w.start.toISOString()).toBe('2026-09-13T22:00:00.000Z')
    expect(w.endLiteral).toBe('2026-10-13 08:25:00')
    expect(w.end).toEqual(RUN)
    expect(w.gap).toBe(false)
  })

  it('a later read starts 10 minutes before the last one stopped', () => {
    const last = new Date('2026-10-12T06:27:13Z')
    const w = changeHistoryWindow('Europe/Rome', RUN, last)
    expect(w.start.toISOString()).toBe('2026-10-12T06:17:13.000Z')
    expect(w.startLiteral).toBe('2026-10-12 08:17:13')
    expect(w.gap).toBe(false)
  })

  it('a read that stopped more than 30 days ago starts where Google still answers, and says changes were missed', () => {
    const w = changeHistoryWindow('America/Los_Angeles', RUN, new Date('2026-08-01T00:00:00Z'))
    expect(w.startLiteral).toBe('2026-09-13 00:00:00')
    expect(w.gap).toBe(true)
  })
})
