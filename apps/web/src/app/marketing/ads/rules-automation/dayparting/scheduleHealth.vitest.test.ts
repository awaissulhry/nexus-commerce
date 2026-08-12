import { describe, expect, it } from 'vitest'
import { scheduleHealth, STALE_AFTER_MS, type HealthInput } from './scheduleHealth'

const NOW = Date.parse('2026-08-02T12:00:00Z')
const base: HealthInput = { enabled: true, lastEvaluatedAt: new Date(NOW - 60_000).toISOString(), failedWrites: 0, governedElsewhere: 0, membersTotal: 5 }
const h = (patch: Partial<HealthInput>) => scheduleHealth({ ...base, ...patch }, NOW)

describe('scheduleHealth', () => {
  it('reports OK for a schedule evaluated recently with no failures', () => {
    expect(h({})).toMatchObject({ tone: 'ok', label: 'OK' })
  })

  it('surfaces failed writes above everything else — including Paused', () => {
    expect(h({ failedWrites: 3 })).toMatchObject({ tone: 'bad', label: '3 writes failing' })
    // The exact defect A3 exists to close: a schedule paused because it was failing must not
    // hide the reason behind a neutral "Paused".
    expect(h({ failedWrites: 3, enabled: false })).toMatchObject({ tone: 'bad' })
  })

  it('singularises a single failed write', () => {
    expect(h({ failedWrites: 1 }).label).toBe('1 write failing')
  })

  it('never calls a paused schedule stale', () => {
    expect(h({ enabled: false, lastEvaluatedAt: new Date(NOW - 5 * 86_400_000).toISOString() })).toMatchObject({ tone: 'muted', label: 'Paused' })
  })

  it('flags a group that holds no campaigns', () => {
    expect(h({ membersTotal: 0 })).toMatchObject({ tone: 'warn', label: 'No campaigns' })
  })

  it('distinguishes partly- from fully-governed schedules', () => {
    expect(h({ governedElsewhere: 2, membersTotal: 5 })).toMatchObject({ tone: 'warn', label: '2 governed elsewhere' })
    expect(h({ governedElsewhere: 5, membersTotal: 5 })).toMatchObject({ tone: 'warn', label: 'Governed elsewhere' })
  })

  it('separates "never run" from "stale"', () => {
    expect(h({ lastEvaluatedAt: null })).toMatchObject({ tone: 'muted', label: 'Never run' })
    expect(h({ lastEvaluatedAt: new Date(NOW - STALE_AFTER_MS - 1000).toISOString() })).toMatchObject({ tone: 'warn', label: 'Stale' })
  })

  it('does not call a schedule stale just inside the threshold', () => {
    expect(h({ lastEvaluatedAt: new Date(NOW - STALE_AFTER_MS + 1000).toISOString() })).toMatchObject({ tone: 'ok' })
  })
})

/**
 * RD.P2 — `Cannot converge`, and the position that makes it useful.
 *
 * The ordering is the policy, so these tests pin the ORDER rather than the string: a config fault
 * that never self-heals must outrank a transient the next cron tick clears, and must not outrank a
 * campaign this schedule does not own.
 */
describe('Cannot converge', () => {
  const base = { enabled: true, lastEvaluatedAt: new Date().toISOString(), failedWrites: 0, governedElsewhere: 0, membersTotal: 11 }

  it('fires when every member is stuck, and carries the engine’s own reason', () => {
    const h = scheduleHealth({ ...base, cannotConverge: 11, cannotConvergeReason: 'The ceiling equals the floor (75%).' })
    expect(h.label).toBe('Cannot converge')
    expect(h.tone).toBe('warn')
    expect(h.detail).toContain('ceiling equals the floor')
  })

  it('counts the members when only some are stuck', () => {
    expect(scheduleHealth({ ...base, cannotConverge: 8, membersTotal: 10 }).label).toBe('8 cannot converge')
  })

  it('outranks Stale — a config fault does not heal on the next tick', () => {
    const stale = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    expect(scheduleHealth({ ...base, lastEvaluatedAt: stale, cannotConverge: 3 }).label).toBe('3 cannot converge')
    expect(scheduleHealth({ ...base, lastEvaluatedAt: stale, cannotConverge: 0 }).label).toBe('Stale')
  })

  it('outranks Never run, which is transient for a freshly armed schedule', () => {
    expect(scheduleHealth({ ...base, lastEvaluatedAt: null, cannotConverge: 2 }).label).toBe('2 cannot converge')
  })

  it('does NOT outrank Governed elsewhere — that row is not this schedule’s to converge', () => {
    expect(scheduleHealth({ ...base, governedElsewhere: 11, cannotConverge: 11 }).label).toBe('Governed elsewhere')
  })

  it('does NOT outrank failing writes or Paused', () => {
    expect(scheduleHealth({ ...base, failedWrites: 2, cannotConverge: 11 }).tone).toBe('bad')
    expect(scheduleHealth({ ...base, enabled: false, cannotConverge: 11 }).label).toBe('Paused')
  })

  it('is absent when nothing is stuck, and the field is optional for existing callers', () => {
    expect(scheduleHealth(base).label).toBe('OK')
    expect(scheduleHealth({ ...base, cannotConverge: 0 }).label).toBe('OK')
  })
})
