import { describe, expect, it } from 'vitest'
import { checkBlockUses, DEVICE_BLOCK_SIZE, LOW_WATER, MAX_BLOCK_SIZE, MAX_LIVE_BLOCKS, nextRange, scanCodes, SCAN_TYPE_OF, topUpFor, type DeviceBlock } from './blocks'
import { DOCUMENT_KINDS, isDocumentKind, isScanIdKind, MAX_NUMBER, NUMBER_KINDS, SCAN_ID_KINDS } from './kinds'
import { formatScanId, parseScanId, tenantTag } from './scan-id'

const TENANT = '019a2b3c-4d5e-7f60-8123-456789abcdef'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const TAG = tenantTag(TENANT)
const hide = (ref: number, tenant = TENANT) => formatScanId({ type: 'HIDE', tenantTag: tenantTag(tenant), ref })

describe('scan-id kinds', () => {
  it('are number kinds of their own: one tenant-wide counter each, never a document series', () => {
    expect(SCAN_ID_KINDS).toEqual(['BUNDLE', 'HIDE', 'GARMENT_SERIAL'])
    expect(SCAN_ID_KINDS.every((kind) => NUMBER_KINDS.includes(kind))).toBe(true)
    expect(DOCUMENT_KINDS).toContain('GOODS_RECEIPT')
    expect(DOCUMENT_KINDS).toContain('LOT')
    expect(DOCUMENT_KINDS.some(isScanIdKind)).toBe(false)
    expect(DOCUMENT_KINDS.length + SCAN_ID_KINDS.length).toBe(NUMBER_KINDS.length)
    expect(['INVOICE', 'LOT'].every(isDocumentKind)).toBe(true)
    expect(['HIDE', 'nope', 3].some(isDocumentKind)).toBe(false)
    expect(SCAN_TYPE_OF).toEqual({ BUNDLE: 'BUNDLE', HIDE: 'HIDE', GARMENT_SERIAL: 'SERIAL' })
  })
})

describe('ranges and codes', () => {
  it('run on after the highest reference handed out, within one block', () => {
    expect(nextRange(null, 3)).toEqual({ fromRef: 1, toRef: 3 })
    expect(nextRange(200, 200)).toEqual({ fromRef: 201, toRef: 400 })
    expect(nextRange(41, 1)).toEqual({ fromRef: 42, toRef: 42 })
    expect(() => nextRange(null, 0)).toThrow(RangeError)
    expect(() => nextRange(null, MAX_BLOCK_SIZE + 1)).toThrow(RangeError)
    expect(() => nextRange(MAX_NUMBER - 1, 2)).toThrow('used up')
    expect(nextRange(MAX_NUMBER - 1, 1)).toEqual({ fromRef: MAX_NUMBER, toRef: MAX_NUMBER })
  })

  it("print the tenant's scan ids of the kind, one per reference", () => {
    const codes = scanCodes(TENANT, 'GARMENT_SERIAL', { fromRef: 31, toRef: 33 })
    expect(codes).toHaveLength(3)
    expect(codes.map((code) => parseScanId(code, { tenantTag: TAG, types: ['SERIAL'] }))).toMatchObject([{ ok: true, ref: 31 }, { ok: true, ref: 32 }, { ok: true, ref: 33 }])
    // 32 is "10" in base 32.
    expect(codes[1]).toMatch(new RegExp(`^SN-${TAG}-000010-.$`))
    expect(scanCodes(TENANT, 'BUNDLE', { fromRef: 7, toRef: 7 })).toEqual([formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 7 })])
  })
})

describe('the numbers a tablet used', () => {
  const blocks: DeviceBlock[] = [
    { id: 'b1', fromRef: 1, toRef: 200, status: 'ACTIVE' },
    { id: 'b2', fromRef: 601, toRef: 800, status: 'CLOSED' },
  ]
  const used = new Map([[hide(5), new Date('2026-10-29T08:15:00Z')]])

  it('takes numbers inside its own open blocks, each once', () => {
    expect(checkBlockUses({ tenantId: TENANT, kind: 'HIDE', codes: [hide(1), hide(200), hide(6).toLowerCase()], blocks, used })).toEqual({
      ok: true,
      uses: [
        { code: hide(1), ref: 1, blockId: 'b1' },
        { code: hide(200), ref: 200, blockId: 'b1' },
        { code: hide(6), ref: 6, blockId: 'b1' },
      ],
    })
  })

  it('refuses, all at once and each with its fix: a typo, another factory, another kind, a number not given to it, a closed block, twice, again', () => {
    const typo = hide(7).slice(0, -1) + (hide(7).endsWith('0') ? '1' : '0')
    const check = checkBlockUses({
      tenantId: TENANT,
      kind: 'HIDE',
      codes: [typo, hide(8, OTHER), formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 9 }), hide(201), hide(650), hide(10), hide(10), hide(5), hide(11)],
      blocks,
      used,
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusals.map((refusal) => [refusal.index, refusal.code])).toEqual([
      [0, 'NOT_A_CODE'],
      [1, 'OTHER_FACTORY'],
      [2, 'WRONG_KIND'],
      [3, 'NOT_RESERVED'],
      [4, 'BLOCK_CLOSED'],
      [6, 'USED_TWICE'],
      [7, 'ALREADY_USED'],
    ])
    expect(check.refusals.find((refusal) => refusal.code === 'ALREADY_USED')?.message).toBe(`${hide(5)} was used already (2026-10-29 08:15 UTC).`)
    expect(check.refusals.find((refusal) => refusal.code === 'NOT_RESERVED')?.message).toBe(`${hide(201)} is not a number this tablet was given: it cannot be used here.`)
    expect(check.refusals.every((refusal) => refusal.fix.length > 0)).toBe(true)
  })
})

describe('top-up', () => {
  it('gives a new block when fewer than the low-water mark are left, and never more than three live blocks', () => {
    expect(topUpFor('HIDE', [])).toEqual({ remaining: 0, reserve: DEVICE_BLOCK_SIZE.HIDE })
    // 200 − 151 = 49 left: below 50.
    expect(topUpFor('HIDE', [{ fromRef: 1, toRef: 200, used: 151 }])).toEqual({ remaining: 49, reserve: 200 })
    expect(topUpFor('HIDE', [{ fromRef: 1, toRef: 200, used: 150 }])).toEqual({ remaining: 50, reserve: null })
    // The tablet printed labels it has not sent yet: its own lower count wins, never a higher one.
    expect(topUpFor('BUNDLE', [{ fromRef: 1, toRef: 200, used: 10 }], 20)).toEqual({ remaining: 20, reserve: 200 })
    expect(topUpFor('BUNDLE', [{ fromRef: 1, toRef: 200, used: 190 }], 500)).toEqual({ remaining: 10, reserve: 200 })
    const three = [1, 2, 3].map((n) => ({ fromRef: n * 1000, toRef: n * 1000 + 9, used: 5 }))
    expect(topUpFor('GARMENT_SERIAL', three)).toEqual({ remaining: 15, reserve: null })
    expect(MAX_LIVE_BLOCKS).toBe(3)
    // A used-up block does not count as live.
    expect(topUpFor('GARMENT_SERIAL', [...three.slice(0, 2), { fromRef: 9000, toRef: 9009, used: 10 }])).toEqual({ remaining: 10, reserve: 500 })
    expect(LOW_WATER.GARMENT_SERIAL).toBe(125)
  })
})
