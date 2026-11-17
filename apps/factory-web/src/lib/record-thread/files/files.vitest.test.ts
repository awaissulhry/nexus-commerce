import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { bulkReach } from '../files-view/model'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { leftKeys, render, textOf } from '../parts/testing'
import { fromApiFile, toViewerFile, type ThreadFile } from './model'
import { carriable, offeredTargets, openRefusal, queryReady, sourceLine, targetLabel, useOnRefusal, type UseOnTarget } from './use-on'
import { UseOnBody, type UseOnModel } from './view/UseOnDialog'

/**
 * B-TH-231 — carry a file to another record (T9-F05; B-TH-024's POST /files/:fileId/use-on and its picker): only records of the
 * file's own customer or of none are offered (W25, W26), another customer's record is refused in words that name no customer,
 * the copy says where it came from, a file the reader may not open says "One file you cannot open" (B-TH-029) and a measurement
 * sheet locked for them is named as such (B-TH-083), every case in it and en.
 */

const ALPHA = 'party-alpha'
const BETA = 'party-beta'
const FROM = { recordType: 'SalesOrder', recordId: 'so-alpha', partyId: ALPHA }
const target = (over: Partial<UseOnTarget>): UseOnTarget => ({ recordType: 'Quote', recordId: 'q-alpha', number: 'Q-2026-0012', title: `${BRAND_ALPHA.tradeName} jackets`, subtitle: null, area: 'sales', partyId: ALPHA, ...over })
const KEYS = ['useOn', 'locked', 'files', 'search']

const file = (over: Partial<ThreadFile>): ThreadFile => ({
  id: 'f1',
  recordType: FROM.recordType,
  recordId: FROM.recordId,
  name: BRAND_ALPHA.fileName,
  contentType: 'application/pdf',
  kind: 'DOCUMENT',
  sizeBytes: 2048,
  status: 'AVAILABLE',
  quarantineReason: null,
  visibility: ['OFFICE'],
  partyId: null,
  createdAt: '2026-11-17T08:00:00.000Z',
  previewUrl: null,
  ...over,
})

describe('the picker offers the same customer’s records or none (W25, W26)', () => {
  it('another customer’s record is never offered, nor the file’s own record; each says whose it is', () => {
    const offered = offeredTargets(
      [
        target({}),
        target({ recordType: 'SalesOrder', recordId: 'so-beta', number: 'SO-2026-0099', title: `${BRAND_BETA.tradeName} order`, partyId: BETA }),
        target({ recordType: 'SalesOrder', recordId: 'so-alpha', number: 'SO-2026-0042' }),
        target({ recordType: 'Style', recordId: 'style-ours', number: 'ST-7', title: 'Our own jacket block', partyId: null }),
        target({}),
      ],
      FROM,
    )
    expect(offered.map((one) => [one.recordId, one.relation])).toEqual([
      ['q-alpha', 'same'],
      ['style-ours', 'none'],
    ])
    expect(scanText(JSON.stringify(offered), BRAND_BETA)).toEqual([])
  })

  it('a file of no customer may go to any customer’s record (said: a customer’s record)', () => {
    const offered = offeredTargets([target({ partyId: BETA, recordId: 'q-beta' }), target({ partyId: null, recordId: 'style' })], { recordType: 'Company', recordId: 'c', partyId: null })
    expect(offered.map((one) => one.relation)).toEqual(['customer', 'none'])
  })

  it('labels, the query rule and the files a carry may take', () => {
    expect(targetLabel({ number: 'Q-2026-0012', title: 'Jackets' })).toBe('Q-2026-0012 · Jackets')
    expect(targetLabel({ number: null, title: 'Jackets' })).toBe('Jackets')
    expect(queryReady('q ')).toBe(false)
    expect(queryReady('Q-2')).toBe(true)
    expect(carriable([file({}), file({ id: 'held', status: 'QUARANTINED' }), file({ id: 'sheet', locked: 'MEASUREMENTS' })]).map((one) => one.id)).toEqual(['f1'])
  })
})

describe('refusals in words that name no customer', () => {
  it('maps the API’s answers', () => {
    expect(useOnRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/OTHER_PARTY', message: `${BRAND_BETA.fileName} belongs to another customer's record` }]))).toBe('useOn.refused.otherParty')
    expect(useOnRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/recordId' }]))).toBe('useOn.refused.sameRecord')
    expect(useOnRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/recordType' }]))).toBe('useOn.refused.owned')
    expect(useOnRefusal(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('useOn.refused.notFound')
    expect(useOnRefusal(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('useOn.refused.forbidden')
    expect(useOnRefusal(new Error('offline'))).toBe('useOn.refused.network')
  })

  it('a file read refused by its record’s scope says “One file you cannot open” (B-TH-029)', () => {
    expect(openRefusal(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('notice.cannotOpen')
    expect(openRefusal(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('notice.cannotOpen')
    expect(openRefusal(new Error('network'))).toBe('notice.openFailed')
  })

  it('the refusal words never name a customer, in it and en', () => {
    const model: UseOnModel = { files: [{ id: 'f1', name: BRAND_ALPHA.fileName }], party: { name: BRAND_ALPHA.tradeName }, query: 'q-20', targets: [], searching: false, chosen: null, share: false, canShare: true, busy: false, problem: 'useOn.refused.otherParty', failed: [], copied: 0 }
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(UseOnBody, { model, actions: { onQuery: () => {}, onChoose: () => {}, onShare: () => {}, onConfirm: () => {}, onClose: () => {} } }), locale)
      expect(leftKeys(html, KEYS)).toEqual([])
      expect(scanText(html, BRAND_BETA)).toEqual([])
    }
    expect(textOf(render(createElement(UseOnBody, { model, actions: { onQuery: () => {}, onChoose: () => {}, onShare: () => {}, onConfirm: () => {}, onClose: () => {} } })))).toContain('a file goes only to a record of the same customer, or to one of no customer')
  })
})

describe('the window', () => {
  const actions = { onQuery: () => {}, onChoose: () => {}, onShare: () => {}, onConfirm: () => {}, onClose: () => {} }
  const offered = offeredTargets([target({}), target({ recordType: 'Style', recordId: 'style', number: 'ST-7', title: 'Our own jacket block', partyId: null })], FROM)
  const base: UseOnModel = { files: [{ id: 'f1', name: BRAND_ALPHA.fileName }], party: { name: BRAND_ALPHA.tradeName }, query: 'jacket', targets: offered, searching: false, chosen: null, share: false, canShare: true, busy: false, problem: null, failed: [], copied: 0 }

  it('lists the offered records with whose they are; Copy waits for a record; the share tick only for a customer’s record', () => {
    const html = render(createElement(UseOnBody, { model: base, actions }))
    const text = textOf(html)
    // The window's title and Copy are the Modal's (drawn in the browser): their words.
    const words = createTranslator('en', messagesFor('en', ['record-thread-files'])['record-thread-files'] ?? {})
    expect(words('useOn.title', { count: 1, name: BRAND_ALPHA.fileName })).toBe(`Use “${BRAND_ALPHA.fileName}” on another record`)
    expect(words('useOn.confirm', { count: 2 })).toBe('Copy 2 files')
    expect(text).toContain('Q-2026-0012')
    expect(text).toContain('Same customer')
    expect(text).toContain('No customer')
    expect(text).not.toContain('Also share the copy')
    const chosen = textOf(render(createElement(UseOnBody, { model: { ...base, chosen: offered[0]!.key }, actions })))
    expect(chosen).toContain(`Also share the copy with ${BRAND_ALPHA.tradeName}`)
    expect(textOf(render(createElement(UseOnBody, { model: { ...base, chosen: offered[1]!.key }, actions })))).not.toContain('Also share the copy')
    expect(leftKeys(html, KEYS)).toEqual([])
  })

  it('too short a query, nothing found, several files, a partial carry — in it and en', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const model of [
        { ...base, query: 'q', targets: null },
        { ...base, targets: [] },
        { ...base, files: [{ id: 'a', name: 'a.pdf' }, { id: 'b', name: 'b.jpg' }] },
        { ...base, failed: [{ name: 'b.jpg', reason: 'useOn.refused.notFound' }], copied: 1 },
      ]) {
        expect(leftKeys(render(createElement(UseOnBody, { model, actions }), locale), KEYS)).toEqual([])
      }
    }
    expect(textOf(render(createElement(UseOnBody, { model: { ...base, query: 'q', targets: null }, actions })))).toContain('Type 3 characters or more.')
    expect(textOf(render(createElement(UseOnBody, { model: { ...base, failed: [{ name: 'b.jpg', reason: 'useOn.refused.notFound' }], copied: 1 }, actions })))).toContain('1 copied; these did not go: b.jpg: The file or the record is out of your reach, or gone.')
  })
})

describe('the copy names its source; a locked sheet is named as such (B-TH-083)', () => {
  const api = {
    id: 'copy',
    companyId: null,
    recordType: 'Quote',
    recordId: 'q-alpha',
    kind: 'DOCUMENT' as const,
    originalName: BRAND_ALPHA.fileName,
    contentType: 'application/pdf',
    sizeBytes: 10,
    status: 'AVAILABLE' as const,
    visibility: ['OFFICE' as const],
    retainUntil: null,
    quarantineReason: null,
    availableAt: null,
    createdAt: '2026-11-17T08:00:00.000Z',
    version: 1,
  }

  it('fromApiFile carries the source and the lock; the source line says where it came from', () => {
    const copy = fromApiFile({ ...api, sourceFileId: 'f1', origin: { fileId: 'f1', recordType: 'SalesOrder', recordId: 'so-alpha', originalName: BRAND_ALPHA.fileName, versionNo: 2 } })
    expect(copy.source).toEqual({ recordType: 'SalesOrder', recordId: 'so-alpha', name: BRAND_ALPHA.fileName, versionNo: 2 })
    expect(sourceLine(copy)).toEqual({ key: 'useOn.source.line', params: { name: BRAND_ALPHA.fileName, n: 2 } })
    expect(sourceLine(fromApiFile({ ...api, sourceFileId: 'f1', origin: null }))).toEqual({ key: 'useOn.source.hidden' })
    expect(sourceLine(fromApiFile(api))).toBeNull()
    const locked = fromApiFile({ ...api, originalName: '', locked: 'MEASUREMENTS', category: 'MEASUREMENTS' })
    expect(locked.locked).toBe('MEASUREMENTS')
    expect(toViewerFile(locked, undefined, 'Measurement sheet — you cannot open it')).toMatchObject({ mayOpen: false, name: 'Measurement sheet — you cannot open it' })
    expect(bulkReach([locked], null, { upload: true, share: true, delete: true }).download).toEqual([])
  })

  it('the Files view’s parts: the chosen files a carry takes, the source words, the lock words — in it and en', () => {
    const files = [
      file({}),
      file({ id: 'copy', name: 'Copied photo.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sourceFileId: 'src', source: { recordType: 'Inquiry', recordId: 'inq', name: 'Rider photo.jpg', versionNo: 1 } }),
      file({ id: 'sheet', name: '', locked: 'MEASUREMENTS' }),
    ]
    expect(carriable(files).map((one) => one.id)).toEqual(['f1', 'copy'])
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files'])['record-thread-files'] ?? {})
      for (const key of ['useOn.action', 'useOn.bulk', 'useOn.source.line', 'useOn.source.hidden', 'useOn.source.locked', 'locked.sheet']) expect(t(key, { count: 1, name: 'x', n: 1, type: 'y' }), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['record-thread-files'])['record-thread-files'] ?? {})
    const line = sourceLine(files[1]!)!
    expect(en(line.key, { ...line.params, type: 'Inquiry' })).toBe('Copied from Inquiry · Rider photo.jpg (version 1)')
    expect(en('locked.sheet')).toBe('Measurement sheet — you cannot open it')
  })
})
