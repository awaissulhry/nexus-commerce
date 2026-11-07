import { describe, expect, it } from 'vitest'
import {
  acceptedProofsOf,
  frozenProofs,
  isProofType,
  MAX_PROOFS,
  proofFileKindOf,
  proofSendBlockers,
  proofSeries,
  proofShapeOf,
  proofsFrozenRefusal,
  proofStateOf,
  proofTypeRefusal,
  shownProofsRefusal,
  tooManyRefusal,
  type ProofFileFacts,
} from './rules'

const file = (id: string, extra: Partial<ProofFileFacts> = {}): ProofFileFacts => ({ id, seriesId: null, versionNo: 1, originalName: `${id}.pdf`, status: 'AVAILABLE', supersededAt: null, quarantineReason: null, ...extra })

describe('what a proof is', () => {
  it('a PDF or a picture the browser shows in place; HEIC and office documents are not', () => {
    for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'IMAGE/JPEG; charset=binary']) expect(isProofType(type)).toBe(true)
    for (const type of ['image/heic', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv']) {
      expect(isProofType(type)).toBe(false)
      expect(proofTypeRefusal(type)).toMatch(/A proof is a PDF or a picture/)
    }
    expect(proofShapeOf('application/pdf')).toBe('PDF')
    expect(proofShapeOf('image/png')).toBe('PICTURE')
    expect(proofFileKindOf('application/pdf')).toBe('DOCUMENT')
    expect(proofFileKindOf('image/webp')).toBe('PHOTO')
  })

  it('changes only while the version is unsent, at most MAX_PROOFS', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const) expect(proofsFrozenRefusal(status, 2)).toBeNull()
    expect(proofsFrozenRefusal('SENT', 2)).toBe('Version 2 was sent: its proofs went with it and are frozen. Make a new version to change them.')
    expect(proofsFrozenRefusal('ACCEPTED', 2)).toBe('Version 2 is accepted: its proofs are frozen with it.')
    expect(tooManyRefusal(MAX_PROOFS - 1)).toBeNull()
    expect(tooManyRefusal(MAX_PROOFS)).toBe(`A version takes at most ${MAX_PROOFS} proofs: remove one first.`)
  })
})

describe('the series of a proof (B-W2b-160 versions)', () => {
  it('one entry per series in the order added: the newest version not deleted, and the current one', () => {
    const files = [
      file('a1'),
      file('b1', { status: 'DELETED' }),
      file('c1'),
      file('a2', { seriesId: 'a1', versionNo: 2 }),
      file('a3', { seriesId: 'a1', versionNo: 3, status: 'PENDING_UPLOAD' }),
    ]
    const series = proofSeries(files.map((entry) => (entry.id === 'a1' ? { ...entry, supersededAt: '2026-11-01T10:00:00.000Z' } : entry)))
    expect(series.map((entry) => [entry.root, entry.newest.id, entry.current?.id ?? null])).toEqual([
      ['a1', 'a3', 'a2'],
      ['c1', 'c1', 'c1'],
    ])
  })

  it('says what a newest version is doing', () => {
    expect(proofStateOf({ status: 'AVAILABLE' })).toBe('READY')
    expect(proofStateOf({ status: 'PENDING_UPLOAD' })).toBe('UPLOADING')
    expect(proofStateOf({ status: 'QUARANTINED', quarantineReason: 'scan_pending' })).toBe('CHECKING')
    expect(proofStateOf({ status: 'QUARANTINED', quarantineReason: 'checksum_mismatch' })).toBe('REFUSED')
  })
})

describe('the send', () => {
  it('is held by a proof not ready, named in words; freezes each current version', () => {
    const files = [file('a1'), file('b1', { originalName: 'Size chart.pdf', status: 'PENDING_UPLOAD' }), file('c1', { originalName: 'Sheet.jpg', status: 'QUARANTINED', quarantineReason: 'scan_pending' })]
    expect(proofSendBlockers(files)).toEqual([
      { fileId: 'b1', name: 'Size chart.pdf', state: 'UPLOADING', message: 'The proof "Size chart.pdf" is still uploading: finish it or remove it.' },
      { fileId: 'c1', name: 'Sheet.jpg', state: 'CHECKING', message: 'The proof "Sheet.jpg" is being checked for viruses: wait a moment.' },
    ])
    const ready = [file('a1', { supersededAt: '2026-11-01T10:00:00.000Z' }), file('a2', { seriesId: 'a1', versionNo: 2 }), file('d1')]
    expect(proofSendBlockers(ready)).toEqual([])
    expect(frozenProofs(ready).map((entry) => entry.id)).toEqual(['a2', 'd1'])
  })
})

describe('the acceptance', () => {
  it('is refused when the proofs shown differ from the version’s; the order does not matter; unsaid is accepted', () => {
    expect(shownProofsRefusal(['b', 'a'], ['a', 'b'])).toBeNull()
    expect(shownProofsRefusal(undefined, ['a'])).toBeNull()
    expect(shownProofsRefusal(['a'], ['a', 'b'])).toBe('The proofs of this quote changed while you were reading it: read them again before you accept.')
    expect(shownProofsRefusal([], ['a'])).not.toBeNull()
  })

  it('reads the evidence back from its audit entry, ignoring what is not a proof', () => {
    expect(acceptedProofsOf({ proofs: [{ fileId: 'a', name: 'A.pdf', sha256: 'ab', versionNo: 2, sizeBytes: 10, contentType: 'application/pdf' }, { fileId: 'b' }, 'x'] })).toEqual([
      { fileId: 'a', name: 'A.pdf', sha256: 'ab', versionNo: 2, sizeBytes: 10, contentType: 'application/pdf' },
    ])
    expect(acceptedProofsOf(null)).toEqual([])
    expect(acceptedProofsOf({ proofs: 'none' })).toEqual([])
  })
})
