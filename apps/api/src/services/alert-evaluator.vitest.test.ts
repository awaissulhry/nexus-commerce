/**
 * RRL.7 — guards detectOverdueCrons, the generic "a cron that was running
 * silently stopped" detector that backstops the node-cron fixed-time skip class
 * across all ~36 daily/weekly crons. Pure function, no DB. It infers each cron's
 * cadence from its own success history and flags any silent well past it.
 */
import { describe, it, expect } from 'vitest'
import { detectOverdueCrons, type CronSuccessRow } from './alert-evaluator.service.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date('2026-06-09T12:00:00.000Z').getTime()

const runs = (jobName: string, agesHoursAgo: number[]): CronSuccessRow[] =>
  agesHoursAgo.map((h) => ({ jobName, startedAt: new Date(NOW - h * HOUR) }))

describe('detectOverdueCrons', () => {
  it('healthy daily cron (last run 12h ago) → not overdue', () => {
    const rows = runs('sales-report-ingest', [72, 48, 24, 12])
    expect(detectOverdueCrons(rows, NOW)).toEqual([])
  })

  it('daily cron silent for a week → overdue', () => {
    const rows = runs('sales-report-ingest', [10 * 24, 9 * 24, 8 * 24, 7 * 24])
    expect(detectOverdueCrons(rows, NOW)).toEqual(['sales-report-ingest'])
  })

  it('healthy hourly cron (last run 30m ago) → not overdue', () => {
    const rows = runs('review-request-mailer', [3, 2, 1, 0.5])
    expect(detectOverdueCrons(rows, NOW)).toEqual([])
  })

  it('hourly cron silent for 6h → overdue', () => {
    const rows = runs('review-request-mailer', [10, 9, 8, 7, 6])
    expect(detectOverdueCrons(rows, NOW)).toEqual(['review-request-mailer'])
  })

  it('cron with <3 successes → ignored (not enough history to trust cadence)', () => {
    const rows = runs('brand-new-cron', [48, 10])
    expect(detectOverdueCrons(rows, NOW)).toEqual([])
  })

  it('only the stalled cron is flagged among a mix', () => {
    const rows = [
      ...runs('healthy-daily', [72, 48, 24, 6]),
      ...runs('stalled-daily', [10 * 24, 9 * 24, 8 * 24]),
    ]
    expect(detectOverdueCrons(rows, NOW).sort()).toEqual(['stalled-daily'])
  })

  it('does not flag a weekly cron that ran 2 days ago', () => {
    const rows = runs('abc-classification', [21 * 24, 14 * 24, 7 * 24, 2 * 24])
    expect(detectOverdueCrons(rows, NOW)).toEqual([])
  })
})
