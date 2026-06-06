/**
 * M4 verifier — pre-publish mirror-diff categorization.
 */

import { describe, it, expect } from 'vitest'
import { categorizeAsinDiff } from '../images/amazon-mirror-diff.service.js'

describe('categorizeAsinDiff', () => {
  it('categorizes adds / replaces / deletes / unchanged vs live', () => {
    const plan = [
      { slot: 'MAIN', url: 'm' },
      { slot: 'PT01', url: 'a' },
      { slot: 'PT02', url: 'b' },
    ]
    const deleteSlots = ['PT03', 'SWCH']
    const live = { MAIN: 'm', PT01: 'OLD', PT03: 'gone' }
    const d = categorizeAsinDiff(plan, deleteSlots, live)
    expect(d.unchanged).toBe(1) // MAIN
    expect(d.adds.map((x) => x.slot)).toEqual(['PT02'])
    expect(d.replaces.map((x) => x.slot)).toEqual(['PT01'])
    // PT03 is live → real delete; SWCH not live → not shown
    expect(d.deletes.map((x) => x.slot)).toEqual(['PT03'])
  })

  it('treats an Amazon size-modifier difference as unchanged, not a replace', () => {
    const d = categorizeAsinDiff(
      [{ slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/x.jpg' }],
      [],
      { MAIN: 'https://m.media-amazon.com/images/I/x._SL75_.jpg' },
    )
    expect(d.replaces).toHaveLength(0)
    expect(d.unchanged).toBe(1)
  })

  it('reports no deletes when live is empty (additive-first)', () => {
    const d = categorizeAsinDiff([{ slot: 'MAIN', url: 'm' }], ['PT01', 'PT02', 'SWCH'], {})
    expect(d.deletes).toHaveLength(0)
    expect(d.adds.map((x) => x.slot)).toEqual(['MAIN'])
  })
})
