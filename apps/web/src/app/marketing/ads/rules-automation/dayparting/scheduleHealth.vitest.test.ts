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
