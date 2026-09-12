import { describe, expect, it } from 'vitest'

import { executionNotice, readSchedule, summariseSchedules, type ScheduleRow } from './schedule'

const NOW = new Date('2026-09-01T12:00:00Z')

const row = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: 's1', channel: 'AMAZON', marketplace: 'IT',
  scheduledFor: '2026-09-02T09:00:00Z', status: 'PENDING',
  firedAt: null, cancelledAt: null, fireError: null, ...over,
})

describe('readSchedule — with the cron switched off (production today)', () => {
  it('says a future row will not run, rather than "Scheduled"', () => {
    const r = readSchedule(row(), false, NOW)
    expect(r.label).toBe('Will not run')
    expect(r.stranded).toBe(true)
    expect(r.note).toMatch(/switched off on this deployment/)
  })

  it('says a past row never ran, rather than "Overdue"', () => {
    const r = readSchedule(row({ scheduledFor: '2026-08-01T09:00:00Z' }), false, NOW)
    expect(r.label).toBe('Never ran')
    expect(r.stranded).toBe(true)
  })

  it('never labels a stranded row in a way that implies it is waiting', () => {
    for (const when of ['2026-08-01T09:00:00Z', '2026-09-02T09:00:00Z']) {
      const r = readSchedule(row({ scheduledFor: when }), false, NOW)
      expect(r.label).not.toMatch(/scheduled|pending|waiting/i)
    }
  })
})

describe('readSchedule — with the cron running', () => {
  it('a future row is simply scheduled', () => {
    const r = readSchedule(row(), true, NOW)
    expect(r.label).toBe('Scheduled')
    expect(r.stranded).toBe(false)
    expect(r.note).toBeUndefined()
  })

  it('a past row is overdue, and does not claim to be broken', () => {
    const r = readSchedule(row({ scheduledFor: '2026-08-01T09:00:00Z' }), true, NOW)
    expect(r.label).toBe('Overdue')
    expect(r.stranded).toBe(false)
  })

  it.each([
    ['FIRED', 'Published'],
    ['CANCELLED', 'Cancelled'],
    ['FAILED', 'Failed'],
  ])('settled rows read the same either way: %s', (status, label) => {
    for (const enabled of [true, false]) {
      expect(readSchedule(row({ status }), enabled, NOW).label).toBe(label)
      expect(readSchedule(row({ status }), enabled, NOW).stranded).toBe(false)
    }
  })

  it('carries a failure reason through', () => {
    const r = readSchedule(row({ status: 'FAILED', fireError: 'feed rejected' }), true, NOW)
    expect(r.note).toBe('feed rejected')
  })

  it('reports an unrecognised status as itself rather than guessing', () => {
    const r = readSchedule(row({ status: 'WEIRD' }), true, NOW)
    expect(r.state).toBe('unknown')
    expect(r.label).toBe('WEIRD')
  })
})

describe('summariseSchedules', () => {
  const rows = [
    row({ id: 'a', scheduledFor: '2026-09-02T09:00:00Z' }),
    row({ id: 'b', scheduledFor: '2026-08-01T09:00:00Z' }),
    row({ id: 'c', status: 'FIRED' }),
    row({ id: 'd', status: 'CANCELLED' }),
  ]

  it('counts every pending row as stranded when nothing will fire them', () => {
    expect(summariseSchedules(rows, false, NOW)).toEqual({ total: 4, pending: 2, stranded: 2, overdue: 1 })
  })

  it('strands nothing when the cron runs', () => {
    expect(summariseSchedules(rows, true, NOW)).toEqual({ total: 4, pending: 2, stranded: 0, overdue: 1 })
  })

  it('an empty list is still summarised, not skipped', () => {
    expect(summariseSchedules([], false, NOW)).toEqual({ total: 0, pending: 0, stranded: 0, overdue: 0 })
  })
})

describe('executionNotice', () => {
  it('is silent when scheduling actually works', () => {
    expect(executionNotice(true, 0)).toBeNull()
    expect(executionNotice(true, 5)).toBeNull()
  })

  it('warns even when there is nothing scheduled — the empty case is the trap', () => {
    const n = executionNotice(false, 0)!
    expect(n).toMatch(/switched off on this deployment/)
    expect(n).toMatch(/would be stored and never fired/)
  })

  it('counts the stored rows when there are some', () => {
    expect(executionNotice(false, 1)).toMatch(/1 scheduled publish is stored here and none of them will run/)
    expect(executionNotice(false, 3)).toMatch(/3 scheduled publishes are stored here/)
  })
})
