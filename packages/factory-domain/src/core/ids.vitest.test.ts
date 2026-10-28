import { describe, expect, it } from 'vitest'
import { createIdGenerator, idTime, isUuid, isUuidV7, newId } from './ids'

const constantRandom = (byte: number) => (bytes: Uint8Array) => void bytes.fill(byte)

describe('newId()', () => {
  it('makes RFC 9562 UUIDv7 ids, in lower case', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isUuidV7(id)).toBe(true)
    expect(isUuid(id)).toBe(true)
  })

  it('carries the time it was made', () => {
    const at = Date.UTC(2026, 9, 28, 9, 15, 0, 123)
    const next = createIdGenerator({ now: () => at })
    expect(idTime(next()).getTime()).toBe(at)
  })

  it('stays in order inside one millisecond', () => {
    const next = createIdGenerator({ now: () => 1_800_000_000_000 })
    const ids = Array.from({ length: 5000 }, () => next())
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('moves to the next millisecond when the counter is full, never backwards', () => {
    const at = 1_800_000_000_000
    const next = createIdGenerator({ now: () => at, random: constantRandom(0xff) })
    // The counter starts at 0x7ff with these bytes; 2049 more ids fill it up to 0xfff and then roll over.
    const ids = Array.from({ length: 2050 }, () => next())
    expect([...ids].sort()).toEqual(ids)
    expect(idTime(ids[0]!).getTime()).toBe(at)
    expect(idTime(ids.at(-1)!).getTime()).toBe(at + 1)
  })

  it('does not go back when the clock does', () => {
    let now = 1_800_000_000_500
    const next = createIdGenerator({ now: () => now })
    const first = next()
    now -= 400
    const second = next()
    expect(second > first).toBe(true)
    expect(idTime(second).getTime()).toBe(1_800_000_000_500)
  })

  it('refuses a clock out of range', () => {
    expect(() => createIdGenerator({ now: () => Number.NaN })()).toThrow(/clock/)
    expect(() => createIdGenerator({ now: () => -1 })()).toThrow(/clock/)
  })

  it('is spread out: 10,000 ids have no duplicate', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()))
    expect(ids.size).toBe(10_000)
  })
})

describe('isUuid()', () => {
  it('accepts canonical UUIDs and refuses the rest', () => {
    expect(isUuid('0190f5c2-0000-4000-8000-000000000001')).toBe(true)
    expect(isUuid('0190F5C2-0000-7000-8000-000000000001')).toBe(false)
    expect(isUuid('0190f5c2-0000-7000-c000-000000000001')).toBe(false)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(42)).toBe(false)
    expect(isUuidV7('0190f5c2-0000-4000-8000-000000000001')).toBe(false)
    expect(() => idTime('0190f5c2-0000-4000-8000-000000000001')).toThrow(/UUIDv7/)
  })
})
