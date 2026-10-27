import { describe, expect, it } from 'vitest'
import { reviewCardFields } from './reviewChangesPanelModel'

/** 2026-10-26 — the review on a phone: each change a card, its columns on their own lines, Now → New as one. */
describe('reviewCardFields', () => {
  it('keeps the table order and joins Now and New', () => {
    const f = reviewCardFields(['Where', 'What', 'Now', 'New', 'Note'], ['Amazon IT', 'Remove protection', 'Protected', 'Not protected', 'Step 1'])
    expect(f.map((x) => x.key)).toEqual(['Where', 'What', 'now-new', 'Note'])
    expect(f[2]).toEqual({ key: 'now-new', kind: 'change', now: 'Protected', next: 'Not protected' })
  })
  it('leaves out a column this change has nothing in', () => {
    const f = reviewCardFields(['Where', 'What', 'Now', 'New', 'Note'], ['', 'Negative exact', 'Running', 'Negative', ''])
    expect(f.map((x) => x.key)).toEqual(['What', 'now-new'])
  })
  it('shows a Result once done', () => {
    const f = reviewCardFields(['What', 'Now', 'New', 'Result'], ['Mode', 'Watch', 'Auto', 'Saved'])
    expect(f.at(-1)).toEqual({ key: 'Result', kind: 'value', label: 'Result', value: 'Saved' })
  })
})
