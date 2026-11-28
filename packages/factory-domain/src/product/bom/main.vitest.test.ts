import { describe, expect, it } from 'vitest'
import { mainLineOf, mainRefusalOf, removeRefusalOf } from './main'

/**
 * owb-pd3 step 3.3 (S4; design plan § 5zc) — the main material: never taken out nor unmarked (MAIN_REQUIRED), the same material twice
 * at the same place refused (SAME_MATERIAL), the same leather at another placement allowed. Written, not run (Owner rule).
 */

const LINES = [
  { id: 'l1', itemId: 'leather', placement: 'Body', colourwayId: null, isMain: true },
  { id: 'l2', itemId: 'lining', placement: 'Body', colourwayId: null, isMain: false },
  { id: 'l3', itemId: 'leather', placement: 'Collar', colourwayId: null },
]

describe('the main material', () => {
  it('the main line; it is not taken out, nor unmarked', () => {
    expect(mainLineOf(LINES)?.id).toBe('l1')
    expect(removeRefusalOf(LINES[0]!)).toBe('MAIN_REQUIRED')
    expect(removeRefusalOf(LINES[1]!)).toBeNull()
    expect(mainRefusalOf(LINES, { lineId: 'l1', itemId: 'leather', placement: 'Body', colourwayId: null, wantsMain: false })).toBe('MAIN_REQUIRED')
    // Marking another line main moves the mark: allowed.
    expect(mainRefusalOf(LINES, { lineId: 'l2', itemId: 'lining', placement: 'Body', colourwayId: null, wantsMain: true })).toBeNull()
  })

  it('the same material twice at the same place is refused (case and spaces aside); another placement or colourway is not', () => {
    expect(mainRefusalOf(LINES, { lineId: null, itemId: 'leather', placement: ' body ', colourwayId: null, wantsMain: undefined })).toBe('SAME_MATERIAL')
    expect(mainRefusalOf(LINES, { lineId: null, itemId: 'leather', placement: 'Sleeves', colourwayId: null, wantsMain: undefined })).toBeNull()
    expect(mainRefusalOf(LINES, { lineId: null, itemId: 'leather', placement: 'Body', colourwayId: 'red', wantsMain: undefined })).toBeNull()
    expect(mainRefusalOf(LINES, { lineId: 'l3', itemId: 'leather', placement: 'Body', colourwayId: null, wantsMain: undefined })).toBe('SAME_MATERIAL')
  })
})
