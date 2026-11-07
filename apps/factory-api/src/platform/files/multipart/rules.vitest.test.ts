import { describe, expect, it } from 'vitest'
import { outsideUploadsRefusal } from './outside'
import { largeMaxOf, largeUploadProblems, missingParts, partCountOf, partSizeOf, partsDoneOf, PART_SIZE_DEFAULT } from './rules'

const MIB = 1_048_576
const SHA = 'ab'.repeat(32)

describe('uploads in parts (COL-052)', () => {
  it('cuts a file into parts of the part size, the last one the rest', () => {
    expect(partCountOf(17 * MIB, 8 * MIB)).toBe(3)
    expect([1, 2, 3].map((n) => partSizeOf(n, 17 * MIB, 8 * MIB))).toEqual([8 * MIB, 8 * MIB, MIB])
    expect(partCountOf(8 * MIB, 8 * MIB)).toBe(1)
    expect(partSizeOf(1, 3, 5 * MIB)).toBe(3)
  })

  it('says which parts are still missing, in order', () => {
    expect(missingParts([{ partNumber: 3 }, { partNumber: 1 }], 4)).toEqual([2, 4])
    expect(missingParts([], 2)).toEqual([1, 2])
    expect(partsDoneOf([{ partNumber: 1, etag: '"a"', sizeBytes: 5 }, { nope: true }, 'x'])).toEqual([{ partNumber: 1, etag: '"a"', sizeBytes: 5 }])
  })

  it('takes a large tech pack or a pattern within the kind and tenant limits, never a fiscal archive file', () => {
    const ok = { kind: 'DOCUMENT' as const, contentType: 'application/pdf', sizeBytes: 150 * MIB, sha256: SHA, partSizeBytes: PART_SIZE_DEFAULT }
    expect(largeUploadProblems(ok)).toEqual([])
    expect(largeUploadProblems({ ...ok, contentType: 'application/dxf' })).toEqual([])
    expect(largeUploadProblems({ ...ok, kind: 'PHOTO', contentType: 'application/dxf' })[0]!.path).toBe('body/contentType')
    expect(largeUploadProblems({ ...ok, sizeBytes: largeMaxOf('DOCUMENT') + 1 })[0]!.message).toBe('A DOCUMENT file sent in parts holds 1 byte to 200 MiB.')
    expect(largeUploadProblems({ ...ok, kind: 'FISCAL_ARCHIVE' })).toEqual([{ path: 'body/kind', message: 'A FISCAL_ARCHIVE file is not sent in parts.' }])
    expect(largeUploadProblems({ ...ok, partSizeBytes: 4 * MIB })[0]!.path).toBe('body/partSizeBytes')
    expect(largeUploadProblems({ ...ok, sha256: 'AB' })[0]!.path).toBe('body/sha256')
  })
})

describe('uploads from outside need the scanner (FV1:02)', () => {
  it('closes portal and link uploads in a live environment unless the scanner is ClamAV; local and test runs are open', () => {
    expect(outsideUploadsRefusal('production', null)).toContain('virus scanner is not running')
    expect(outsideUploadsRefusal('staging', null)).toContain('virus scanner is not running')
    expect(outsideUploadsRefusal('production', 'clamav')).toBeNull()
    expect(outsideUploadsRefusal('staging', 'clamav')).toBeNull()
    expect(outsideUploadsRefusal('local', null)).toBeNull()
    expect(outsideUploadsRefusal('test', 'fake')).toBeNull()
    expect(outsideUploadsRefusal(undefined, null)).toBeNull()
  })
})
