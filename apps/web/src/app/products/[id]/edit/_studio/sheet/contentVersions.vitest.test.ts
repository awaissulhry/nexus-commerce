import { describe, expect, it } from 'vitest'
import { adoptContentVersions, contentVersionsOf } from './contentVersions'

const pin = { tier: 'pin', language: 'it' }
const row = () => ({
  id: 'p1',
  values: {
    bulletPoints_1: { contentAddress: pin, contentVersion: 4 },
    bulletPoints_2: { contentAddress: pin, contentVersion: 4 },
    title_de: { contentAddress: { tier: 'pin', language: 'de' }, contentVersion: 9 },
    shared: { contentAddress: { tier: 'language', language: 'it' }, contentVersion: 2 },
    material: { contentAddress: null },
  } as Record<string, { contentAddress: { tier: string; language?: string } | null; contentVersion?: number }>,
})

describe('a save moves the write token of every cell on the content row it wrote', () => {
  it('moves the pin cells of that language on that row, and nothing else', () => {
    const r = row()
    expect(adoptContentVersions(r, { contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: 5 }] })).toEqual(['bulletPoints_1', 'bulletPoints_2'])
    expect(r.values.bulletPoints_1.contentVersion).toBe(5)
    expect(r.values.bulletPoints_2.contentVersion).toBe(5)
    expect(r.values.title_de.contentVersion).toBe(9)
    expect(r.values.shared.contentVersion).toBe(2)
    expect(r.values.material.contentVersion).toBeUndefined()
  })
  it('ignores another row, a malformed entry, and an answer without versions', () => {
    const r = row()
    expect(adoptContentVersions(r, { contentVersions: [{ id: 'p2', tier: 'pin', language: 'it', version: 5 }, { id: 'p1', tier: 'source', language: 'it', version: 5 }, { id: 'p1', tier: 'pin', language: 'it', version: '5' }] })).toEqual([])
    expect(adoptContentVersions(r, { updated: 1 })).toEqual([])
    expect(adoptContentVersions(null, { contentVersions: [] })).toEqual([])
    expect(contentVersionsOf({ contentVersions: 'x' })).toEqual([])
    expect(r.values.bulletPoints_1.contentVersion).toBe(4)
  })
})
