/**
 * PES.7 — the browser store. The important cases are the hostile ones: a store that throws on
 * every access, and stored data written by a version of this code that no longer exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  asArrayOf, asBoolean, asEnum, asNumber, asRecord, asString,
  readLocal, removeLocal, storageAvailable, storageKey, writeLocal, STORAGE_SCOPE_NOTE,
} from './browserStore'

/** A store that behaves; `failOn` makes the named methods throw, as a locked-down browser does. */
function fakeStorage(failOn: Array<'getItem' | 'setItem' | 'removeItem'> = []) {
  const map = new Map<string, string>()
  const guard = <T>(name: 'getItem' | 'setItem' | 'removeItem', run: () => T): T => {
    if (failOn.includes(name)) throw new DOMException('The operation is insecure.', 'SecurityError')
    return run()
  }
  return {
    getItem: (k: string) => guard('getItem', () => map.get(k) ?? null),
    setItem: (k: string, v: string) => guard('setItem', () => { map.set(k, v) }),
    removeItem: (k: string) => guard('removeItem', () => { map.delete(k) }),
    _map: map,
  }
}

function install(storage: unknown) {
  vi.stubGlobal('window', { localStorage: storage })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('storageKey', () => {
  it('namespaces and versions every key', () => {
    expect(storageKey('autoPublish', 'prod1', 'AMAZON')).toBe(
      'nexus.studio.images.v1:autoPublish:prod1:AMAZON')
  })

  it('keeps a stable slot for an absent part rather than collapsing two keys into one', () => {
    expect(storageKey('a', null, 'b')).not.toBe(storageKey('a', 'b'))
  })
})

describe('storageAvailable — probed, not assumed', () => {
  it('is true only when a write actually succeeds', () => {
    install(fakeStorage())
    expect(storageAvailable()).toBe(true)
  })

  it('is false when the browser blocks site data', () => {
    install(fakeStorage(['setItem']))
    expect(storageAvailable()).toBe(false)
  })

  it('is false with no window at all (SSR)', () => {
    vi.stubGlobal('window', undefined)
    expect(storageAvailable()).toBe(false)
  })

  it('leaves nothing behind when it probes', () => {
    const s = fakeStorage()
    install(s)
    storageAvailable()
    expect(s._map.size).toBe(0)
  })
})

describe('readLocal / writeLocal — never throwing', () => {
  const parseFlag = (raw: unknown) => (typeof raw === 'boolean' ? raw : null)

  it('round-trips a value', () => {
    install(fakeStorage())
    expect(writeLocal('k', true)).toBe(true)
    expect(readLocal('k', parseFlag)).toBe(true)
  })

  it('reports a failed write instead of pretending it saved', () => {
    install(fakeStorage(['setItem']))
    expect(writeLocal('k', true)).toBe(false)
  })

  it('returns null rather than throwing when reads are blocked', () => {
    install(fakeStorage(['getItem']))
    expect(readLocal('k', parseFlag)).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const s = fakeStorage()
    install(s)
    s._map.set('k', '{not json')
    expect(readLocal('k', parseFlag)).toBeNull()
  })

  it('drops a stored value that no longer fits the shape', () => {
    const s = fakeStorage()
    install(s)
    s._map.set('k', '"a string where a flag used to be"')
    expect(readLocal('k', parseFlag)).toBeNull()
  })

  it('removeLocal reports failure too', () => {
    install(fakeStorage(['removeItem']))
    expect(removeLocal('k')).toBe(false)
  })

  it('is inert under SSR rather than crashing the render', () => {
    vi.stubGlobal('window', undefined)
    expect(readLocal('k', parseFlag)).toBeNull()
    expect(writeLocal('k', true)).toBe(false)
    expect(removeLocal('k')).toBe(false)
  })
})

describe('parsers — stored data is untrusted input', () => {
  it('asRecord rejects arrays and null', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1, 2])).toBeNull()
    expect(asRecord(null)).toBeNull()
  })

  it('asBoolean does not coerce truthy values', () => {
    expect(asBoolean(true)).toBe(true)
    expect(asBoolean('true')).toBe(false)
    expect(asBoolean(1)).toBe(false)
    expect(asBoolean(undefined, true)).toBe(true)
  })

  it('asString rejects the empty string, which is never a meaningful stored id', () => {
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeNull()
    expect(asString(3)).toBeNull()
  })

  it('asNumber rejects NaN and Infinity', () => {
    expect(asNumber(3)).toBe(3)
    expect(asNumber(NaN)).toBeNull()
    expect(asNumber(Infinity)).toBeNull()
    expect(asNumber('3')).toBeNull()
  })

  it('asArrayOf drops bad items and keeps good ones', () => {
    expect(asArrayOf([1, 'a', 2], (v) => (typeof v === 'number' ? v : null))).toEqual([1, 2])
    expect(asArrayOf('nope', (v) => v as number)).toEqual([])
  })

  it('asEnum returns null for an unknown member rather than defaulting to the first', () => {
    const allowed = ['AMAZON', 'EBAY'] as const
    expect(asEnum('EBAY', allowed)).toBe('EBAY')
    // The trap: silently returning 'AMAZON' here restores a choice the operator never made.
    expect(asEnum('ETSY', allowed)).toBeNull()
    expect(asEnum(7, allowed)).toBeNull()
  })
})

describe('the scope note', () => {
  it('says the three things an operator needs to know', () => {
    expect(STORAGE_SCOPE_NOTE).toMatch(/this browser only/i)
    expect(STORAGE_SCOPE_NOTE).toMatch(/not on your account/i)
    expect(STORAGE_SCOPE_NOTE).toMatch(/nobody else on the team/i)
  })
})
