import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearLastUsed, lastUsedKey, LAST_USED_SCHEMA, readLastUsed, writeLastUsed } from './useGridState'

/** A localStorage the node environment does not have. */
class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}

const g = globalThis as unknown as { window?: { localStorage: MemoryStorage } }

describe('last-used grid state', () => {
  beforeEach(() => {
    g.window = { localStorage: new MemoryStorage() }
  })
  afterEach(() => {
    delete g.window
  })

  it('round-trips gridState + page under a versioned, surface-scoped key', () => {
    writeLastUsed('products-next', { gridState: { sort: { sortModel: [{ colId: 'price', sort: 'desc' }] } }, page: { density: 'cozy' } })
    const back = readLastUsed<{ density: string }>('products-next')
    expect(back?.v).toBe(LAST_USED_SCHEMA)
    expect(back?.gridState).toEqual({ sort: { sortModel: [{ colId: 'price', sort: 'desc' }] } })
    expect(back?.page).toEqual({ density: 'cozy' })
    expect(typeof back?.savedAt).toBe('string')
    expect(lastUsedKey('products-next')).toBe('nds-grid:products-next:v1')
  })

  it('a different surface reads nothing', () => {
    writeLastUsed('a', { gridState: {}, page: {} })
    expect(readLastUsed('b')).toBeNull()
  })

  it('an older schema or a corrupt value reads as nothing — never as a partial state', () => {
    g.window!.localStorage.setItem(lastUsedKey('s'), JSON.stringify({ v: 0, gridState: {}, page: {} }))
    expect(readLastUsed('s')).toBeNull()
    g.window!.localStorage.setItem(lastUsedKey('s'), '{not json')
    expect(readLastUsed('s')).toBeNull()
    g.window!.localStorage.setItem(lastUsedKey('s'), JSON.stringify({ v: LAST_USED_SCHEMA, page: {} }))
    expect(readLastUsed('s')).toBeNull()
  })

  it('forget clears it', () => {
    writeLastUsed('s', { gridState: {}, page: {} })
    clearLastUsed('s')
    expect(readLastUsed('s')).toBeNull()
  })

  it('is a no-op without a window (SSR)', () => {
    delete g.window
    expect(() => writeLastUsed('s', { gridState: {}, page: {} })).not.toThrow()
    expect(readLastUsed('s')).toBeNull()
  })
})
