/**
 * C1 (2026-10-10) — the "Ads automation at AUTO" check knows that writing nothing can be by design: the hourly bid plans
 * (A10) write nothing to a campaign that is not enabled, so a run whose every evaluated campaign is paused (or the bid
 * brain's) has nothing it could write. Pure: fixture facts, no database.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

import { IDLE_BY_DESIGN, idleByDesign, judgeEngines } from './automation.checks.js'

const engine = (id: string, verdicts: string[], lastSummary: string | null = null) =>
  ({ id, name: id === 'A10' ? 'Hourly bid plans (schedules and product plans)' : id, level: 'AUTO', runs: 600, writes: 0, verdicts, lastEverAt: '2026-10-01T00:00:00.000Z', lastSummary })

describe('idleByDesign — read off the run line', () => {
  it('every evaluated campaign paused → by design', () => {
    expect(idleByDesign('evaluated=20 applied=0 paused=20 (not enabled: nothing written) brain-owned=5 (the bid brain runs them)')).toBe(true)
    expect(idleByDesign('evaluated=20 applied=0 paused=20')).toBe(true)
  })
  it('nothing evaluated because the brain owns every campaign → by design', () => {
    expect(idleByDesign('evaluated=0 applied=0 brain-owned=5 (the bid brain runs them)')).toBe(true)
  })
  it('some campaign served, nothing evaluated at all, a skip, or no line → not by design', () => {
    expect(idleByDesign('evaluated=20 applied=0 paused=19')).toBe(false)
    expect(idleByDesign('evaluated=4 applied=0')).toBe(false)
    expect(idleByDesign('evaluated=0 applied=0')).toBe(false)
    expect(idleByDesign('skipped: a run is already in progress')).toBe(false)
    expect(idleByDesign(null)).toBe(false)
    expect(idleByDesign('reevaluated=3 paused=3')).toBe(false)
  })
})

describe('judgeEngines — an engine idle by design is ok, with the note', () => {
  it('A10 whose last run reads evaluated=20 applied=0 paused=20 → ok, and the message says why', () => {
    const v = judgeEngines({ days: 7, engines: [engine('A10', ['not-written-in-window'], 'evaluated=20 applied=0 paused=20 (not enabled: nothing written) brain-owned=5 (the bid brain runs them)')], unreadable: [] })
    expect(v.status).toBe('ok')
    expect(v.message).toContain(IDLE_BY_DESIGN)
    expect(v.message).toContain('Hourly bid plans (schedules and product plans) (A10)')
    expect((v.evidence as { atAuto: Array<{ id: string; note?: string }> }).atAuto[0].note).toBe(IDLE_BY_DESIGN)
  })
  it('the same engine with a campaign it could have written → still flagged', () => {
    const v = judgeEngines({ days: 7, engines: [engine('A10', ['not-written-in-window'], 'evaluated=20 applied=0 paused=10')], unreadable: [] })
    expect(v.status).toBe('warn')
    expect(v.message).toMatch(/wrote nothing: Hourly bid plans/)
  })
  it('an idle-by-design engine does not hide another idle one, and does not count as one that ran', () => {
    const v = judgeEngines({ days: 7, engines: [engine('A10', ['not-written-in-window'], 'evaluated=5 applied=0 paused=5'), engine('A2', ['never-written']), engine('A3', ['never-written'])], unreadable: [] })
    expect(v.status).toBe('fail') // A2 and A3 are every engine that ran and could write
    expect(v.message).toMatch(/^2 Amazon ads automations at AUTO ran/)
    expect(v.message).toContain(IDLE_BY_DESIGN)
  })
})
