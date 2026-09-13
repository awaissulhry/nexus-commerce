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
  it('says exactly the five words spec §9 fixes, the sixth VX D9 adds, and the four MX §3.4 adds', () => {
    expect(PROJECTION_STATES).toEqual([
      'listed', 'draft', 'excluded', 'not-set-up', 'needs-value', 'collides',
      /* MX.G, design §3.4 — the Matrix's four. The ORDER is the declaration order in the table and
         is asserted because `PROJECTION_STATES` is what a legend and a filter's options render. */
      'suppressed', 'closed', 'error', 'ended',
    ])
    expect(PROJECTION_STATES.map((s) => projectionMeta(s).label)).toEqual([
      'Listed',
      'Draft',
      'Excluded',
      'Not set up',
      'Needs a value',
      'Collides',
      'Suppressed',
      'Closed',
      'Error',
      'Ended',
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
    // 9 of the 10 delegate: `excluded` is still the only member that paints no status colour.
    // The count is the positive control on the loop above — it is what makes a silently skipped
    // member fail rather than pass (the arm that would have failed is the one never run).
    expect(delegated).toBe(9)
  })

  it('maps each state to the dot §3.3 draws', () => {
    // info solid · neutral hollow · nothing · nothing · warning solid
    expect(projectionMeta('listed')).toMatchObject({ tone: 'info', dot: 'solid', muted: false })
    expect(projectionMeta('draft')).toMatchObject({ tone: 'neutral', dot: 'hollow', muted: false })
    expect(projectionMeta('excluded')).toMatchObject({ dot: 'none', muted: true })
    expect(projectionMeta('not-set-up')).toMatchObject({ dot: 'none', muted: true })
    expect(projectionMeta('needs-value')).toMatchObject({ tone: 'warning', dot: 'solid', muted: false })
    // VT.4 / VX D9 — the sixth word shares the row-warning SEVERITY and declares the same source.
    expect(projectionMeta('collides')).toMatchObject({ tone: 'warning', dot: 'solid', muted: false, from: 'row:missing' })
    expect(projectionMeta('collides').tone).toBe(readinessMeta('missing', 'row').tone)
    /* MX.G, design §3.4 + the mandate's counterparts, verbatim: `suppressed` → row:errors,
       `closed`/`ended` → row:unlisted, `error` → row:errors. Asserted against the SOURCE, not
       against a colour name, so a recolour of a readiness state follows here automatically. */
    expect(projectionMeta('suppressed')).toMatchObject({ dot: 'solid', muted: false, from: 'row:errors' })
    expect(projectionMeta('suppressed').tone).toBe(readinessMeta('errors', 'row').tone)
    expect(projectionMeta('closed')).toMatchObject({ dot: 'hollow', muted: true, from: 'row:unlisted' })
    expect(projectionMeta('closed').tone).toBe(readinessMeta('unlisted', 'row').tone)
    expect(projectionMeta('error')).toMatchObject({ dot: 'solid', muted: false, from: 'row:errors' })
    expect(projectionMeta('error').tone).toBe(readinessMeta('errors', 'row').tone)
    expect(projectionMeta('ended')).toMatchObject({ dot: 'hollow', muted: true, from: 'row:unlisted' })
    expect(projectionMeta('ended').tone).toBe(readinessMeta('unlisted', 'row').tone)
  })

  it('gives each of the four Matrix words its own remedy sentence', () => {
    /* Same test `collides` earns: two states that share a tone must not share a hint, or the word
       tells the operator a severity and nothing about where to go. `Closed` and `Ended` share
       `row:unlisted` and must still point at two different controls. */
    const hints = ['suppressed', 'closed', 'error', 'ended'].map((s) => projectionMeta(s).hint)
    expect(new Set(hints).size).toBe(4)
    expect(projectionMeta('closed').hint).toContain('Sync Control')
    expect(projectionMeta('ended').hint.toLowerCase()).toContain('relist')
    expect(projectionMeta('suppressed').hint).toContain('Needs attention')
    expect(projectionMeta('error').hint).toContain('Needs attention')
    expect(projectionMeta('suppressed').hint).not.toBe(projectionMeta('error').hint)
  })

  it('gives `collides` its own remedy sentence, not `needs a value`\u2019s', () => {
    // The two share a tone on purpose and must NOT share the hint: one is fixed in the cell, the
    // other in the mapping dock, and the hint is the only thing that says which.
    expect(projectionMeta('collides').hint).not.toBe(projectionMeta('needs-value').hint)
    expect(projectionMeta('collides').hint).toContain('mapping dock')
    expect(projectionMeta('collides').label).not.toBe(projectionMeta('needs-value').label)
    // Excluding a variant IS one of the three resolvers, so the checkbox may not be held here.
    expect(projectionMeta('collides').interactive).toBe(true)
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
