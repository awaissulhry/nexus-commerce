import { describe, expect, it } from 'vitest'
import { pointsByZone, walkOrder } from './rules'

/** B-W2b-224 (SZ1:02): the measurement link groups a point by its library point of measure's body zone, by its code only without one. */
describe('body zones of the measurement link (SZ1:02)', () => {
  const point = (code: string, seq: number, zone?: 'UPPER' | 'ARMS' | 'LEGS' | 'RIDING' | 'OTHER' | null) => ({ code, seq, ...(zone === undefined ? {} : { zone }) })

  it("takes the point's own zone first, its code only when it has none", () => {
    const groups = pointsByZone([point('waist', 1, 'LEGS'), point('chest', 2), point('custom_reach', 3, 'RIDING'), point('custom', 4, null)])
    expect(groups.map((group) => [group.zone, group.points.map((entry) => entry.code)])).toEqual([
      ['UPPER', ['chest']],
      ['LEGS', ['waist']],
      ['RIDING', ['custom_reach']],
      ['OTHER', ['custom']],
    ])
    expect(walkOrder([point('waist', 1, 'LEGS'), point('chest', 2)]).map((entry) => entry.code)).toEqual(['chest', 'waist'])
  })
})
