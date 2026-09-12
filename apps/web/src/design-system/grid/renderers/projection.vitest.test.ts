import { describe, expect, it } from 'vitest'
import { readinessMeta } from './readiness'
import { PROJECTION_STATES, isProjectionState, projectionMeta, type ProjectionState } from './projection'

/**
 * Two properties are worth a test here and the rest is typing.
 *
 * 1. The WORDS are spec §9's, character for character. They are operator copy on an
 *    Owner-approved canvas, so a reword is a decision, not a refactor — this is what makes one
 *    fail loudly.
 * 2. Every TONE is still the one `readinessMeta()` gives for the declared counterpart. Asserting
 *    `tone === 'success'` would pass a local copy just as happily; asserting it against the source
 *    is the only form of the check that can catch a fork, and it keeps following the source if
 *    PES.2 ever recolours a readiness state.
 */
describe('projection vocabulary', () => {
  it('says exactly the five words spec §9 fixes', () => {
    expect(PROJECTION_STATES).toEqual(['listed', 'draft', 'excluded', 'not-set-up', 'needs-value'])
    expect(PROJECTION_STATES.map((s) => projectionMeta(s).label)).toEqual([
      'Listed',
      'Draft',
      'Excluded',
      'Not set up',
      'Needs a value',
    ])
  })

  it('reads every tone from readinessMeta, never from a local table', () => {
    // A loop over a list can assert nothing and still go green. Count the arms that ran.
    let delegated = 0
    for (const state of PROJECTION_STATES) {
      const meta = projectionMeta(state)
      if (meta.from == null) {
        // The one state with no counterpart paints no status colour, so it decides none.
        expect(meta.dot).toBe('none')
        continue
      }
      const [vocabulary, name] = meta.from.split(':')
      const source =
        vocabulary === 'scope'
          ? readinessMeta(name as 'absent', 'scope')
          : readinessMeta(name as 'live', 'row')
      expect(meta.tone).toBe(source.tone)
      delegated += 1
    }
    expect(delegated).toBe(4)
  })

  it('maps each state to the dot §3.3 draws', () => {
    // success solid · neutral hollow · nothing · nothing · danger solid
    expect(projectionMeta('listed')).toMatchObject({ tone: 'success', dot: 'solid', muted: false })
    expect(projectionMeta('draft')).toMatchObject({ tone: 'neutral', dot: 'hollow', muted: false })
    expect(projectionMeta('excluded')).toMatchObject({ dot: 'none', muted: true })
    expect(projectionMeta('not-set-up')).toMatchObject({ dot: 'none', muted: true })
    expect(projectionMeta('needs-value')).toMatchObject({ tone: 'danger', dot: 'solid', muted: false })
  })

  it('holds the include checkbox on "Not set up" only, and gives it a reason', () => {
    const held = PROJECTION_STATES.filter((s) => !projectionMeta(s).interactive)
    expect(held).toEqual(['not-set-up'])
    // A held control that cannot say why is the defect check-silent-disabled exists for.
    expect(projectionMeta('not-set-up').hint.length).toBeGreaterThan(20)
    for (const state of PROJECTION_STATES) expect(projectionMeta(state).hint).not.toBe('')
  })

  it('names an unknown state instead of rendering it as one of ours', () => {
    const meta = projectionMeta('shipped')
    expect(meta.label).toBe('shipped')
    expect(meta.tone).toBe('neutral')
    expect(meta.dot).toBe('none')
    expect(meta.interactive).toBe(false)
    expect(meta.hint).toContain('Unrecognised')
  })

  it('parses a wire value rather than trusting it', () => {
    expect(isProjectionState('listed')).toBe(true)
    expect(isProjectionState('Listed')).toBe(false)
    expect(isProjectionState('shipped')).toBe(false)
    expect(isProjectionState(undefined)).toBe(false)
    expect(isProjectionState(null)).toBe(false)
    // `in` on a plain object also answers for inherited keys; a state must be one of ours.
    expect(isProjectionState('toString')).toBe(false)
    expect(isProjectionState('constructor')).toBe(false)
  })

  it('does not answer for a readiness state that is not a projection state', () => {
    // The compile error is the real guard; this pins the runtime behaviour behind it.
    for (const alien of ['ready', 'missing', 'errors', 'live', 'unlisted', 'warn', 'blocked', 'absent']) {
      expect(isProjectionState(alien)).toBe(false)
      expect(projectionMeta(alien).label).toBe(alien)
    }
  })
})

describe('projection vocabulary · the shape a caller relies on', () => {
  it('is total — every state answers every field', () => {
    for (const state of PROJECTION_STATES) {
      const meta = projectionMeta(state satisfies ProjectionState)
      expect(typeof meta.label).toBe('string')
      expect(['solid', 'hollow', 'none']).toContain(meta.dot)
      expect(typeof meta.muted).toBe('boolean')
      expect(typeof meta.interactive).toBe('boolean')
    }
  })
})
