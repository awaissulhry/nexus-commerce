import { describe, expect, it } from 'vitest'
import { chunkRowsParentsFirst } from './saveChunks.pure'

const row = (sku: string, parentage: string) => ({ item_sku: sku, parentage_level: parentage })

describe('chunkRowsParentsFirst (FFT.1)', () => {
  it('returns [] for no rows', () => {
    expect(chunkRowsParentsFirst([])).toEqual([])
  })

  it('puts every parent before every child, preserving relative order', () => {
    const rows = [row('c1', 'child'), row('p1', 'parent'), row('c2', 'child'), row('p2', 'parent')]
    const flat = chunkRowsParentsFirst(rows, 25).flat()
    expect(flat.map((r) => r.item_sku)).toEqual(['p1', 'p2', 'c1', 'c2'])
  })

  it('splits into chunks of the given size and loses no row', () => {
    const rows = Array.from({ length: 53 }, (_, i) => row(`s${i}`, i < 3 ? 'parent' : 'child'))
    const chunks = chunkRowsParentsFirst(rows, 25)
    expect(chunks.map((c) => c.length)).toEqual([25, 25, 3])
    expect(new Set(chunks.flat().map((r) => r.item_sku)).size).toBe(53)
  })

  it('treats blank/unknown parentage as non-parent and is case/space tolerant', () => {
    const rows = [row('a', ''), row('b', ' Parent '), row('c', 'CHILD')]
    const flat = chunkRowsParentsFirst(rows, 2).flat()
    expect(flat[0].item_sku).toBe('b')
  })
})
