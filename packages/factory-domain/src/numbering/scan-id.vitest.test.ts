import { describe, expect, it } from 'vitest'
import { formatScanId, MAX_SCAN_REF, parseScanId, SCAN_TYPES, tenantTag, type ScanType } from './scan-id'

const TENANT = '019a2b3c-4d5e-7f60-8123-456789abcdef'
const TAG = tenantTag(TENANT)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A small deterministic generator, so the error sweeps are the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}
const random = generator(20261028)
const TYPES = Object.keys(SCAN_TYPES) as ScanType[]
const sample = (count: number) =>
  Array.from({ length: count }, () => ({
    type: TYPES[Math.floor(random() * TYPES.length)]!,
    tenantTag: ALPHABET[Math.floor(random() * 32)]! + ALPHABET[Math.floor(random() * 32)]!,
    ref: 1 + Math.floor(random() * (random() < 0.5 ? 1_000_000 : MAX_SCAN_REF)),
  }))

describe('formatScanId and parseScanId', () => {
  it('writes a short code and reads it back', () => {
    const text = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 3_955 })
    expect(text).toMatch(/^HD-[0-9A-HJKMNP-TV-Z]{2}-0003VK-[0-9A-HJKMNP-TV-Z]$/)
    expect(parseScanId(text, { tenantTag: TAG })).toEqual({ ok: true, type: 'HIDE', tenantTag: TAG, ref: 3_955, text })
    for (const id of sample(500)) {
      const printed = formatScanId(id)
      expect(printed.length).toBeLessThanOrEqual(17)
      expect(printed).toMatch(/^[A-Z0-9-]+$/)
      expect(parseScanId(printed)).toEqual({ ok: true, ...id, text: printed })
    }
  })

  it('reads a typed code in any case, without hyphens, with spaces, and with O for 0 or I and L for 1', () => {
    const text = formatScanId({ type: 'BUNDLE', tenantTag: '10', ref: 1 })
    expect(text).toMatch(/^BN-10-000001-.$/)
    const check = text.slice(-1)
    for (const typed of [text.toLowerCase(), text.replace(/-/g, ''), ` BN 10 000001 ${check} `, `BN-1O-OOOOOI-${check}`, `bn-lo-ooooo1-${check.toLowerCase()}`]) {
      expect(parseScanId(typed)).toMatchObject({ ok: true, type: 'BUNDLE', ref: 1, text })
    }
  })

  it('refuses every code with one wrong symbol (typos)', () => {
    let tried = 0
    for (const id of sample(60)) {
      const compact = formatScanId(id).replace(/-/g, '')
      for (let at = 0; at < compact.length; at++) {
        const symbols = at < 2 ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : ALPHABET
        for (const other of symbols) {
          if (other === compact[at]) continue
          const typo = compact.slice(0, at) + other + compact.slice(at + 1)
          expect(parseScanId(typo).ok, typo).toBe(false)
          tried++
        }
      }
    }
    expect(tried).toBeGreaterThan(15_000)
  })

  it('refuses every code with two different symbols swapped, next to each other or further apart', () => {
    let tried = 0
    for (const id of sample(300)) {
      const compact = formatScanId(id).replace(/-/g, '')
      for (let left = 0; left < compact.length; left++) {
        for (let right = left + 1; right < compact.length; right++) {
          if (compact[left] === compact[right]) continue
          const swapped = [...compact]
          ;[swapped[left], swapped[right]] = [swapped[right]!, swapped[left]!]
          expect(parseScanId(swapped.join('')).ok, swapped.join('')).toBe(false)
          tried++
        }
      }
    }
    expect(tried).toBeGreaterThan(10_000)
  })

  it('says why it refused', () => {
    const text = formatScanId({ type: 'LOT', tenantTag: TAG, ref: 42 })
    const wrongCheck = text.slice(0, -1) + (text.endsWith('0') ? '1' : '0')
    expect(parseScanId(wrongCheck)).toMatchObject({ ok: false, problem: 'check', message: expect.stringMatching(/typo/) })
    expect(parseScanId('XX' + text.slice(2))).toMatchObject({ ok: false, problem: 'type' })
    expect(parseScanId(text.replace(/-..-/, '-UU-'))).toMatchObject({ ok: false, problem: 'format' })
    expect(parseScanId('HD-12')).toMatchObject({ ok: false, problem: 'format' })
    expect(parseScanId(42)).toMatchObject({ ok: false, problem: 'format' })
    const other = TAG === '00' ? '01' : '00'
    expect(parseScanId(text, { tenantTag: other })).toMatchObject({ ok: false, problem: 'tenant', message: 'This label belongs to another factory.' })
    expect(parseScanId(text, { types: ['HIDE', 'BUNDLE'] })).toMatchObject({ ok: false, problem: 'type', message: expect.stringMatching(/lot label/) })
    expect(parseScanId(text, { tenantTag: TAG, types: ['LOT'] })).toMatchObject({ ok: true, ref: 42 })
  })

  it('reads only the printed form of a long reference, and keeps references in range', () => {
    const long = formatScanId({ type: 'SERIAL', tenantTag: TAG, ref: MAX_SCAN_REF })
    expect(long).toMatch(/^SN-..-ZZZZZZZZ-.$/)
    expect(parseScanId(long)).toMatchObject({ ok: true, ref: MAX_SCAN_REF })
    // A zero in front of a reference that is already 6 symbols long is not how a label prints it.
    const id = { type: 'SERIAL' as const, tenantTag: TAG, ref: 32 ** 6 }
    const seven = formatScanId(id)
    expect(seven).toMatch(/^SN-..-1000000-.$/)
    for (const ref of [0, -1, 1.5, MAX_SCAN_REF + 1]) expect(() => formatScanId({ ...id, ref })).toThrow(RangeError)
    expect(() => formatScanId({ ...id, tenantTag: 'IL' })).toThrow(RangeError)
    expect(() => formatScanId({ ...id, type: 'PALLET' as ScanType })).toThrow(RangeError)
  })

  it('derives a stable 2-symbol tag from the tenant id', () => {
    expect(tenantTag(TENANT)).toBe(TAG)
    expect(tenantTag(TENANT.toUpperCase())).toBe(TAG)
    expect(TAG).toMatch(/^[0-9A-HJKMNP-TV-Z]{2}$/)
    const tags = new Set(Array.from({ length: 2_000 }, (_, index) => tenantTag(`tenant-${index}`)))
    expect(tags.size).toBeGreaterThan(800)
    expect(() => tenantTag('')).toThrow(TypeError)
  })
})
