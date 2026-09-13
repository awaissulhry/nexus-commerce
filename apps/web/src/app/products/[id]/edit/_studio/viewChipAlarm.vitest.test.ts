import { describe, expect, it } from 'vitest'

import { viewChipIsAlarm } from './viewChips'
import type { ViewChip } from './types'

const chip = (over: Partial<ViewChip> = {}): ViewChip =>
  ({ id: 'c', label: 'C', count: { n: 0, unit: 'cells' }, cells: { byRow: {} }, ...over })

/*
 * §6.2 / DS1-11. The bar rendered an `AlertTriangle` for EVERY chip, so a count of available work
 * ("✦ AI drafts (12)") wore an alarm. A warning glyph on a non-warning is a FALSE POSITIVE, and a
 * false positive costs more than a missing one: it teaches operators the alarm means nothing, and
 * then the real alarms mean nothing too.
 */
describe('viewChipIsAlarm — only a warning wears the warning glyph', () => {
  it('alarms on the tones that ARE alarms', () => {
    expect(viewChipIsAlarm(chip({ tone: 'warning' }))).toBe(true)
    expect(viewChipIsAlarm(chip({ tone: 'danger' }))).toBe(true)
  })

  it('🔴 does NOT alarm on info, neutral, or no tone at all', () => {
    expect(viewChipIsAlarm(chip({ tone: 'info' }))).toBe(false)
    expect(viewChipIsAlarm(chip({ tone: 'neutral' }))).toBe(false)
    // The `ai-drafts` case, and the load-bearing one: a producer that has not said its chip is a
    // warning has not said it is one. The renderer must never decide that for the producer.
    expect(viewChipIsAlarm(chip())).toBe(false)
  })

  it('the real chips today land where they should', () => {
    // master `missing-required`, and the channel's three — all genuinely warnings.
    expect(viewChipIsAlarm(chip({ id: 'missing-required', tone: 'warning' }))).toBe(true)
    expect(viewChipIsAlarm(chip({ id: 'mapping-errors', tone: 'danger' }))).toBe(true)
    // ...and PES.8's, which is the chip this whole fix exists for.
    expect(viewChipIsAlarm(chip({ id: 'ai-drafts', label: '✦ AI drafts', count: { n: 12, unit: 'cells' } }))).toBe(false)
  })

  it('a count of zero or null does not change whether it is an alarm', () => {
    // Whether a chip is a WARNING is about its kind, not its size — visibility is a separate rule.
    expect(viewChipIsAlarm(chip({ tone: 'warning', count: null }))).toBe(true)
    expect(viewChipIsAlarm(chip({ tone: 'info', count: { n: 99, unit: 'cells' } }))).toBe(false)
  })
})
