/**
 * PES.7 — the publish gate. This is the only surface in the tab that reaches a real marketplace,
 * so every refusal and every claim it makes is pinned here rather than trusted to a component.
 */
import { describe, expect, it } from 'vitest'

import { buildPublishPlan, type ValidationResult } from './publishPlan'

const clean: ValidationResult = {
  hardFails: [], softWarnings: [],
  blockedAsins: [],
  summary: { totalAsins: 4, asinsWithIssues: 0, asinsBlocked: 0 },
}

const withBlocked: ValidationResult = {
  hardFails: [{ sku: 'A', asin: 'B01', slot: 'MAIN', code: 'MAIN_MISSING', message: 'no MAIN', level: 'error' }],
  softWarnings: [],
  blockedAsins: ['B01'],
  summary: { totalAsins: 4, asinsWithIssues: 1, asinsBlocked: 1 },
}

const live = { enabled: true, mode: 'live' as const }

describe('the gate comes from the SERVER, never from a guess', () => {
  it('refuses to offer a submission before readiness has answered', () => {
    // Not "gated" and not "live" — unknown. Guessing either way is wrong in a different direction.
    const p = buildPublishPlan({ readiness: null, validation: clean, dryRun: true })
    expect(p.canSubmit).toBe(false)
    expect(p.actionLabel).toMatch(/Checking/)
    expect(p.advisory).toMatch(/Nothing is submitted/)
  })

  it('refuses to offer a submission before preflight has run', () => {
    const p = buildPublishPlan({ readiness: live, validation: null, dryRun: true })
    expect(p.canSubmit).toBe(false)
    expect(p.actionLabel).toMatch(/preflight/i)
  })

  it('says nothing will reach Amazon when the server mode is not live', () => {
    const p = buildPublishPlan({ readiness: { enabled: true, mode: 'gated' }, validation: clean, dryRun: false })
    expect(p.rehearsalOnly).toBe(true)
    expect(p.advisory).toMatch(/nothing will reach Amazon/)
    // Even with dry-run OFF the label must not promise a live submission.
    expect(p.actionLabel).toMatch(/Dry run/)
  })

  it('says so when publishing is disabled outright', () => {
    const p = buildPublishPlan({ readiness: { enabled: false, mode: 'live' }, validation: clean, dryRun: false })
    expect(p.rehearsalOnly).toBe(true)
    expect(p.advisory).toMatch(/disabled on the server/)
  })

  it('tells the operator the gate is closed even when they turned dry-run off', () => {
    // Two different facts. Silencing the gate because dry-run is off would hide the important one.
    const p = buildPublishPlan({ readiness: { enabled: true, mode: 'dry-run' }, validation: clean, dryRun: false })
    expect(p.advisory).toMatch(/dry-run mode on the server/)
  })
})

describe('preflight decides what may be submitted', () => {
  it('offers the whole set when nothing is blocked', () => {
    const p = buildPublishPlan({ readiness: live, validation: clean, dryRun: false })
    expect(p.canSubmit).toBe(true)
    expect(p.partial).toBe(false)
    expect(p.actionLabel).toBe('Queue 4 ASINs to Amazon')
  })

  it('describes a PARTIAL submission as partial, with the skipped count', () => {
    const p = buildPublishPlan({ readiness: live, validation: withBlocked, dryRun: false })
    expect(p.partial).toBe(true)
    expect(p.actionLabel).toBe('Queue 3 of 4 ASINs to Amazon')
    expect(p.advisory).toMatch(/1 ASIN is blocked by preflight and will be skipped/)
  })

  it('refuses entirely when every ASIN is blocked', () => {
    const all: ValidationResult = { ...withBlocked, summary: { totalAsins: 2, asinsWithIssues: 2, asinsBlocked: 2 } }
    const p = buildPublishPlan({ readiness: live, validation: all, dryRun: false })
    expect(p.canSubmit).toBe(false)
    expect(p.actionLabel).toBe('Blocked by preflight')
    expect(p.advisory).toMatch(/Amazon would reject/)
  })

  it('refuses when there is nothing resolved for this market at all', () => {
    const none: ValidationResult = { ...clean, summary: { totalAsins: 0, asinsWithIssues: 0, asinsBlocked: 0 } }
    expect(buildPublishPlan({ readiness: live, validation: none, dryRun: false }).canSubmit).toBe(false)
  })

  it('reports warnings without letting them block', () => {
    const warned: ValidationResult = {
      ...clean,
      softWarnings: [{ sku: 'A', asin: 'B01', slot: 'SWCH', code: 'SWCH_MISSING_ON_COLOR', message: 'no swatch', level: 'warning' }],
      summary: { totalAsins: 4, asinsWithIssues: 1, asinsBlocked: 0 },
    }
    const p = buildPublishPlan({ readiness: live, validation: warned, dryRun: false })
    expect(p.canSubmit).toBe(true)
    expect(p.advisory).toMatch(/do not block/)
  })
})

describe('the wording never overclaims', () => {
  it('never says "published" — an Amazon feed is asynchronous', () => {
    const labels = [
      buildPublishPlan({ readiness: live, validation: clean, dryRun: false }).actionLabel,
      buildPublishPlan({ readiness: live, validation: clean, dryRun: true }).actionLabel,
      buildPublishPlan({ readiness: { enabled: true, mode: 'gated' }, validation: clean, dryRun: false }).actionLabel,
    ]
    expect(labels.every((l) => !/publish(ed)?\b/i.test(l))).toBe(true)
    expect(labels[0]).toMatch(/Queue/)
  })

  it('says "dry run" when dry run is on, even with a live gate', () => {
    expect(buildPublishPlan({ readiness: live, validation: clean, dryRun: true }).actionLabel).toMatch(/^Dry run/)
  })
})

describe('the shared PublishMode — every non-live member degrades to a rehearsal (P4-3)', () => {
  /*
   * The union is OPEN and now carries four members, `sandbox` among them. The safety property is
   * not "the listed modes are handled" but "only `live` submits" — so it must hold for a member
   * this file has never seen. Before P4-3 this lane's copy had three members and no `sandbox`; it
   * was safe for exactly this reason, and could not say the word.
   */
  it.each(['gated', 'dry-run', 'sandbox', 'a-mode-added-next-year'])(
    'mode %s is a rehearsal, never a submission',
    (mode) => {
      const p = buildPublishPlan({
        readiness: { enabled: true, mode }, validation: clean, dryRun: false,
      })
      expect(p.rehearsalOnly).toBe(true)
      expect(p.actionLabel).not.toMatch(/^Queue/)
    },
  )

  it('only live submits, and only when the gate is also enabled', () => {
    expect(buildPublishPlan({ readiness: { enabled: true, mode: 'live' }, validation: clean, dryRun: false }).rehearsalOnly).toBe(false)
    // `enabled: false` outranks the mode — both have to agree before anything reaches Amazon.
    expect(buildPublishPlan({ readiness: { enabled: false, mode: 'live' }, validation: clean, dryRun: false }).rehearsalOnly).toBe(true)
  })
})
