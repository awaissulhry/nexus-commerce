import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { pictureAddress } from '../../../../../lib/proofs/address'
import type { QuoteProofs } from './api'
import { proofsSchema } from './api'
import { addHeldOf, fileProblem, heldOf, PROOF_MAX_BYTES } from './model'
import { designScreen } from './fixtures'

const data = (status: QuoteProofs['versions'][number]['status'], change: boolean, count = 1): QuoteProofs =>
  proofsSchema.parse({
    quoteId: 'q',
    versions: [
      {
        versionId: 'v',
        revision: 3,
        status,
        current: true,
        sentAt: null,
        frozen: null,
        proofs: Array.from({ length: count }, (_, n) => ({ fileId: `f${n}`, seriesId: `f${n}`, name: `P${n}.pdf`, contentType: 'application/pdf', shape: 'PDF', sizeBytes: 10, sha256: 'ab', versionNo: 1, state: 'READY', currentFileId: `f${n}`, sharedWithCustomer: false, sourceFileId: null, addedAt: '2026-11-03T09:00:00.000Z', addedBy: null })),
        accepted: null,
      },
    ],
    may: { change, held: change ? null : 'English the panel never shows' },
    carry: null,
    limits: { max: 12, contentTypes: [] },
    at: '2026-11-03T09:00:00.000Z',
  })

describe('SCR-035-proofs: why a change is held, in our words (never the API’s English)', () => {
  it('a role without the right, a sent version, a closed one, an upload running, a full version', () => {
    expect(heldOf(data('DRAFT', true), false)).toBeNull()
    expect(heldOf(data('DRAFT', true), true)).toEqual({ key: 'office.held.busy' })
    expect(heldOf(data('APPROVED', false), false)).toEqual({ key: 'office.held.right' })
    expect(heldOf(data('SENT', false), false)).toEqual({ key: 'office.held.frozen', params: { revision: 3 } })
    expect(heldOf(data('ACCEPTED', false), false)).toEqual({ key: 'office.held.closed', params: { revision: 3 } })
    expect(addHeldOf(data('DRAFT', true, 12), false)).toEqual({ key: 'office.held.full', params: { max: 12 } })
    expect(addHeldOf(data('DRAFT', true, 11), false)).toBeNull()
  })

  it('checks a file before it is sent: its type, the kind of a next version, the size of its kind', () => {
    expect(fileProblem({ name: 'a.heic', type: 'image/heic', size: 10 })).toEqual({ key: 'office.upload.type', params: { name: 'a.heic' } })
    expect(fileProblem({ name: 'a.jpg', type: 'image/jpeg', size: 10 }, { shape: 'PDF' })).toEqual({ key: 'office.upload.kind' })
    expect(fileProblem({ name: 'a.jpg', type: 'image/jpeg', size: PROOF_MAX_BYTES.PICTURE + 1 })).toEqual({ key: 'office.upload.size', params: { name: 'a.jpg', max: '15 MB' } })
    expect(fileProblem({ name: 'a.pdf', type: 'application/pdf', size: PROOF_MAX_BYTES.PICTURE + 1 })).toBeNull()
  })
})

describe('the words', () => {
  it('every key the panel, the viewer and the link section say is in Italian and English', () => {
    const keys = [
      'office.title', 'office.hint', 'office.drop', 'office.dropShort', 'office.loading', 'office.problem', 'office.retry', 'office.none', 'office.noneSent', 'office.versionHead',
      'office.fileVersion', 'office.copied', 'office.shared', 'office.notShared', 'office.addedBy', 'office.addedAt', 'office.code', 'office.open', 'office.newVersion', 'office.remove',
      'office.carry_one', 'office.carry_other', 'office.held.right', 'office.held.frozen', 'office.held.closed', 'office.held.busy', 'office.held.full',
      'office.removeConfirm.title', 'office.removeConfirm.body', 'office.removeConfirm.go', 'office.removeConfirm.back',
      'office.upload.reading', 'office.upload.sending', 'office.upload.type', 'office.upload.kind', 'office.upload.size', 'office.upload.failed',
      'office.accepted.title', 'office.accepted.by', 'office.accepted.none', 'office.accepted.name', 'office.accepted.version', 'office.accepted.code', 'office.accepted.size',
      'office.notice.added', 'office.notice.removed', 'office.notice.carried_one', 'office.notice.carried_other', 'office.notice.conflict',
      ...['READY', 'UPLOADING', 'CHECKING', 'REFUSED'].map((state) => `office.state.${state}`),
      ...['UPLOADING', 'CHECKING', 'REFUSED'].map((state) => `office.stateHint.${state}`),
      ...['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'].map((status) => `office.versionStatus.${status}`),
      'viewer.title', 'viewer.previous', 'viewer.next', 'viewer.first', 'viewer.last', 'viewer.only', 'viewer.count', 'viewer.loading', 'viewer.problem', 'viewer.retry', 'viewer.picture',
      'link.title', 'link.hint_one', 'link.hint_other', 'link.open', 'link.version', 'link.code', 'link.kind.PDF', 'link.kind.PICTURE', 'link.loading', 'link.problem', 'link.retry',
      'link.signLine_one', 'link.signLine_other', 'link.accepted',
    ]
    for (const locale of ['it', 'en'] as const) for (const key of keys) expect(CATALOGUE[locale]['quote-proofs']?.[key], `${locale} ${key}`).toBeTruthy()
    for (const locale of ['it', 'en'] as const) expect(CATALOGUE[locale].sales?.['check.PROOF_NOT_READY']).toBeTruthy()
  })
})

describe('the design cases', () => {
  it('cover the states of the panel', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['draft', 'empty', 'uploading', 'sent', 'accepted', 'no-right', 'full', 'viewer-picture', 'viewer-pdf', 'loading', 'error']))
  })
})

describe('a picture read once', () => {
  it('becomes a data address of its own type', () => {
    expect(pictureAddress(Uint8Array.from([0xff, 0xd8, 0xff]), 'IMAGE/JPEG; x=1')).toBe('data:image/jpeg;base64,/9j/')
  })
})
