import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { curveFill, curveNameProblems, curveWords, packFill, sharesOf, sharesProblems } from './rules'

const SCALE = ['46', '48', '50', '52', '54', '56', '58']
const EU = { '48': '5', '50': '20', '52': '40', '54': '25', '56': '10' }

describe('size curves (SAL-269)', () => {
  it('takes shares of the scale totalling exactly 100, at most 4 decimals', () => {
    expect(sharesProblems(EU, SCALE)).toEqual([])
    expect(sharesProblems({ '50': '33.3333', '52': '33.3333', '54': '33.3334' }, SCALE)).toEqual([])
    expect(sharesProblems({ '50': '50', '52': '49' }, SCALE)[0]?.message).toBe('The shares total 99 %: a curve totals exactly 100 %.')
    expect(sharesProblems({ '60': '100' }, SCALE)[0]?.path).toBe('body/shares/60')
    expect(sharesProblems({ '50': '0', '52': '100' }, SCALE)[0]?.path).toBe('body/shares/50')
    expect(sharesProblems({ '50': '12.34567', '52': '87.65433' }, SCALE).length).toBeGreaterThan(0)
    expect(sharesProblems({}, SCALE)[0]?.path).toBe('body/shares')
    expect(curveNameProblems(' ')[0]?.path).toBe('body/name')
    expect(curveNameProblems('Spring\nrun')).toHaveLength(1)
    expect(curveNameProblems(undefined)).toEqual([])
  })

  it('stores the shares in the scale order with 4 decimals, and says them', () => {
    expect(Object.entries(sharesOf({ '54': '25', '50': '75' }, SCALE))).toEqual([
      ['50', '75.0000'],
      ['54', '25.0000'],
    ])
    expect(curveWords(sharesOf(EU, SCALE))).toBe('48 5 % · 50 20 % · 52 40 % · 54 25 % · 56 10 %')
  })

  it('fills whole pieces, what rounding leaves on the base size', () => {
    const fill = curveFill({ shares: EU, total: 23, offered: ['48', '50', '52', '54', '56'], baseSize: '52' })
    if (Array.isArray(fill)) throw new Error('refused')
    // 23 × 5 % = 1.15 → 1; × 20 % = 4.6 → 4; × 40 % = 9.2 → 9; × 25 % = 5.75 → 5; × 10 % = 2.3 → 2; 21, so 2 more on 52.
    expect(fill.sizes).toEqual([
      { size: '48', quantity: 1 },
      { size: '50', quantity: 4 },
      { size: '52', quantity: 11 },
      { size: '54', quantity: 5 },
      { size: '56', quantity: 2 },
    ])
    expect(fill.remainder).toEqual({ size: '52', pieces: 2 })
    expect(fill.leftOut).toEqual([])
    expect(fill.words).toContain('2 left by rounding on size 52')
  })

  it("shares the pieces among the sizes the line takes, and names the curve's other sizes", () => {
    // A style made in 50-54 only: 20 + 40 + 25 = 85; 100 pieces → 23.5 → 23, 47.05 → 47, 29.4 → 29 (99): 1 more on 52.
    const fill = curveFill({ shares: EU, total: 100, offered: ['50', '52', '54'], baseSize: '52' })
    if (Array.isArray(fill)) throw new Error('refused')
    expect(fill.sizes.map((row) => row.quantity)).toEqual([23, 48, 29])
    expect(fill.leftOut).toEqual(['48', '56'])
    // No base size on the line: the largest share takes the rest.
    const noBase = curveFill({ shares: EU, total: 7, offered: ['50', '54'], baseSize: '52' })
    if (Array.isArray(noBase)) throw new Error('refused')
    expect(noBase.remainder?.size).toBe('54')
    expect(curveFill({ shares: EU, total: 0, offered: ['50'], baseSize: null })).toEqual([{ path: 'body/total', message: expect.stringContaining('whole pieces from 1') }])
    expect((curveFill({ shares: EU, total: 10, offered: ['60'], baseSize: null }) as { message: string }[])[0]!.message).toContain('shares none of the sizes')
  })

  it('fills from a prepack × packs, the colourway its own pieces', () => {
    const lines = [
      { size: '50', colourwayId: null, quantity: 2 },
      { size: '52', colourwayId: 'blk', quantity: 2 },
      { size: '52', colourwayId: 'red', quantity: 1 },
    ]
    const black = packFill({ lines, packs: 3, colourwayId: 'blk', offered: ['50', '52', '54'] })
    if (Array.isArray(black)) throw new Error('refused')
    expect(black.sizes).toEqual([
      { size: '50', quantity: 6 },
      { size: '52', quantity: 6 },
    ])
    expect((packFill({ lines: lines.slice(1), packs: 1, colourwayId: 'grn', offered: ['52'] }) as { message: string }[])[0]!.message).toContain('names other colourways')
    expect((packFill({ lines, packs: 1, colourwayId: 'blk', offered: ['52'] }) as { message: string }[])[0]!.message).toContain('sizes this line does not take (50)')
    expect((packFill({ lines, packs: 0, colourwayId: 'blk', offered: ['50', '52'] }) as { path: string }[])[0]!.path).toBe('body/packs')
  })

  it('declares size_curve.changed', () => {
    expect(EVENT_CATALOGUE.get('size_curve.changed', 1)).toBeTruthy()
  })
})
