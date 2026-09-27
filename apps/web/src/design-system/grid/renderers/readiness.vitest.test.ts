// @vitest-environment node
/**
 * The scope vocabulary is a SET CLAIM, so it is derived here, not retyped.
 *
 * LX.F R-LX-9 added the fifth member: `notComputed`. `absent` says an operator
 * has set nothing up for this scope; `notComputed` says nobody has computed it
 * yet (no `ReadinessIndex` row for the coordinate and language — production held
 * 0 rows). Rendering both as "Not set up" is the "could not measure vs measured
 * empty" failure on a chip.
 */
import { expect, it } from 'vitest'
import { readinessMeta, readinessPillLabel, readyPillTone, SCOPE_READINESS_STATES, ROW_READINESS_STATES } from './readiness'

it('says Not computed, in its own words, neutral like absent but not the same label', () => {
  expect(readinessMeta('notComputed', 'scope')).toMatchObject({ label: 'Not computed', tone: 'neutral', vocabulary: 'scope' })
  expect(readinessMeta('absent', 'scope').label).toBe('Not set up')
  expect(readinessMeta('notComputed', 'scope').label).not.toBe(readinessMeta('absent', 'scope').label)
  expect(readinessMeta('notComputed', 'scope').hint).toContain('not a score of zero')
})

it('exposes the member through the derived list every filter and parser reads', () => {
  expect([...SCOPE_READINESS_STATES].sort()).toEqual(['absent', 'blocked', 'notComputed', 'ready', 'warn'])
  // POSITIVE CONTROL: the row vocabulary is untouched and still has no such word.
  expect(ROW_READINESS_STATES).not.toContain('notComputed')
  // An unknown state is still named verbatim rather than rendered as one of ours.
  expect(readinessMeta('invented' as never, 'scope')).toMatchObject({ label: 'invented', tone: 'neutral' })
})

it('says Published · ASIN pending for an Amazon row whose ASIN is not back yet, in the tone of a listed row', () => {
  expect(readinessMeta('pending', 'row')).toMatchObject({ label: 'Published · ASIN pending', vocabulary: 'row' })
  expect(readinessMeta('pending', 'row').tone).toBe(readinessMeta('live', 'row').tone)
  expect(readyPillTone('pending')).toBe(readinessMeta('live', 'row').tone)
  expect(ROW_READINESS_STATES).toContain('pending')
  // A row word, not a scope word.
  expect(SCOPE_READINESS_STATES).not.toContain('pending' as never)
})

it('readinessPillLabel — the pill says the label exactly for a pending row, with or without warnings', () => {
  expect(readinessPillLabel({ state: 'pending' })).toBe('Published · ASIN pending')
  expect(readinessPillLabel({ state: 'pending', issues: ['a', 'b'] })).toBe('Published · ASIN pending')
  // The other states read as before.
  expect(readinessPillLabel({ state: 'live', ref: 'B0TEST0001' })).toBe('Listed · B0TEST0001')
  expect(readinessPillLabel({ state: 'live', issues: ['warn'] })).toBe('Listed')
  expect(readinessPillLabel({ state: 'missing', issues: ['a', 'b'] })).toBe('Missing · 2')
  expect(readinessPillLabel({ state: 'ready', issues: ['a'] })).toBe('Ready')
  expect(readinessPillLabel({ state: 'unlisted' })).toBe('No listing here')
})
