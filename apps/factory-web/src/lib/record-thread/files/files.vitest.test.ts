import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { bulkReach } from '../files-view/model'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { leftKeys, render, textOf } from '../parts/testing'
import { fromApiFile, toViewerFile, type ThreadFile } from './model'
import { fileSeries, isPricedLock, namedSeries, previewOf, pricedLockedOf, pricedMarkOf, pricedRefusalKey } from './model' // F-CP-144
import { FileStrip } from './view/FileStrip' // F-CP-144
import { pickerGroups, pickerPricedLocked } from '../attachments/model' // F-CP-144
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
    const partial = textOf(render(createElement(UseOnBody, { model: { ...base, failed: [{ name: 'b.jpg', reason: 'useOn.refused.notFound' }], copied: 1 }, actions })))
    expect(partial).toContain('1 copied; these did not go:')
    expect(partial).toContain('b.jpg')
    expect(partial).toContain('The file or the record is out of your reach, or gone.')
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

// ── F-CP-144 (customer page plan C4, the money wall; design 11-money §4.5; B-CP-014, B-CP-023) ──────────────────────────────────
// The PRICED lock as the thread draws it, as Sales worker / as Production manager (no price grain): a priced document is never
// named, never previewed, never a tile and never offered to attach — the files line says "2 priced documents — you cannot open
// them" once; Mark as priced for a file not priced yet; taking the mark off only where the file opens (a price holder).
describe('F-CP-144: the PRICED lock on the files line and in the attach picker', () => {
  const apiFile = {
    id: 'po',
    companyId: null,
    recordType: 'SalesOrder',
    recordId: 'so-alpha',
    kind: 'DOCUMENT' as const,
    originalName: 'Brand Alpha PO 4471.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    status: 'AVAILABLE' as const,
    visibility: ['OFFICE' as const],
    retainUntil: null,
    quarantineReason: null,
    availableAt: null,
    createdAt: '2026-11-17T08:00:00.000Z',
    version: 3,
  }
  const lockedOne = file({ id: 'p1', name: '', locked: 'PRICED', previewUrl: 'https://store.example.com/preview-p1.webp' })
  const lockedTwo = file({ id: 'p2', name: '', locked: 'PRICED', createdAt: '2026-11-16T08:00:00.000Z' })
  const plain = file({ id: 'f1', version: 2, previewUrl: 'https://store.example.com/preview-f1.webp' })

  it('fromApiFile: a priced file the reader opens says so and carries its version; a locked one is not "priced" to them', () => {
    const opened = fromApiFile({ ...apiFile, priced: true })
    expect(opened).toMatchObject({ priced: true, version: 3 })
    const locked = fromApiFile({ ...apiFile, originalName: '', locked: 'PRICED', priced: true })
    expect(locked.priced).toBeUndefined()
    expect(isPricedLock(locked)).toBe(true)
    expect(fromApiFile(apiFile).priced).toBeUndefined()
  })

  it('counted, never named, never previewed: the lock is one count; the named documents leave it out', () => {
    const series = fileSeries([lockedOne, lockedTwo, plain])
    expect(pricedLockedOf(series)).toBe(2)
    expect(namedSeries(series).map((one) => one.latest.id)).toEqual(['f1'])
    expect(previewOf(lockedOne)).toBeNull()
    expect(previewOf(plain)).toBe('https://store.example.com/preview-f1.webp')
    expect(toViewerFile(lockedOne, undefined, 'Priced document — you cannot open it')).toMatchObject({ mayOpen: false, name: 'Priced document — you cannot open it' })
  })

  it('the files line: no tile and no preview of a priced document, one counted line, in it and en (as Sales worker)', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(FileStrip, { model: { files: [lockedOne, lockedTwo, plain], party: null, open: true } }), locale)
      expect(textOf(html)).toContain(locale === 'en' ? '2 priced documents — you cannot open them' : '2 documenti con prezzi — non puoi aprirli')
      expect(html).not.toContain('preview-p1')
      expect(html).toContain('preview-f1')
      expect(html.match(/data-tile/g)?.length).toBe(2) // the plain file's tile and "All files": none for the priced ones
      expect(leftKeys(html, ['priced', 'chip', 'strip'])).toEqual([])
    }
  })

  it('the order\'s dock line: the read\'s pricedLeftOut counted on one line; the chip counts only the files the reader sees', async () => {
    const { stripFilesOf } = await import('../../../areas/_shared/record-thread/use-order-files')
    const read = { order: { id: 'so-alpha', number: 'SO-2026-0142' }, groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [], leftOut: 0, measurementsLeftOut: 0, pricedLeftOut: 2 }], total: 0, truncated: false }
    const tiles = stripFilesOf(read, null)
    expect(tiles.map((tile) => tile.locked)).toEqual(['PRICED', 'PRICED'])
    expect(tiles.every((tile) => tile.name === '' && tile.previewUrl === null)).toBe(true)
    const shut = textOf(render(createElement(FileStrip, { model: { files: tiles, party: null, open: false } })))
    expect(shut).toContain('2 priced documents — you cannot open them')
    expect(shut).not.toContain('Files (2)')
    const mixed = textOf(render(createElement(FileStrip, { model: { files: [...tiles, plain], party: null, open: false } })))
    expect(mixed).toContain('Files (1)')
  })

  it('never offered to attach: the picker leaves out every locked file and counts the priced ones', () => {
    const files = [
      { id: 'p1', name: '', sizeBytes: 1, contentType: 'application/pdf', shared: false, available: true, locked: 'PRICED' as const },
      { id: 's1', name: '', sizeBytes: 1, contentType: 'application/pdf', shared: false, available: true, locked: 'MEASUREMENTS' as const },
      { id: 'f1', name: 'Label sketch.jpg', sizeBytes: 1, contentType: 'image/jpeg', shared: true, available: true },
    ]
    const groups = pickerGroups(files)
    expect([...groups.shared, ...groups.office].map((one) => one.id)).toEqual(['f1'])
    expect(pickerPricedLocked(files)).toBe(1)
    // The container passes the lock through (use-record-thread's recordFiles).
    const container = readFileSync(new URL('../../../areas/_shared/record-thread/use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain('...(file.locked ? { locked: file.locked } : {})')
  })

  it('Mark as priced (anyone who reaches the record), take the mark off only where it opens; refusals in words', () => {
    expect(pricedMarkOf({ ...plain, version: 2 }, { mark: true })).toBe('mark')
    expect(pricedMarkOf({ ...plain, priced: true, version: 2 }, { mark: true })).toBe('unmark')
    expect(pricedMarkOf(lockedOne, { mark: true })).toBeNull()
    expect(pricedMarkOf({ ...plain, version: 2 }, { mark: false })).toBeNull()
    expect(pricedMarkOf({ ...plain, version: undefined }, { mark: true })).toBeNull()
    expect(pricedMarkOf({ ...plain, status: 'QUARANTINED', version: 2 }, { mark: true })).toBeNull()
    expect(pricedRefusalKey('forbidden', 'PRICED_UNMARK')).toBe('priced.unmarkHeld')
    expect(pricedRefusalKey('conflict', null)).toBe('priced.stale')
    expect(pricedRefusalKey('not_found', null)).toBe('priced.gone')
    expect(pricedRefusalKey(null, null)).toBe('priced.markFailed')
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['record-files'])['record-files'] ?? {})
      for (const key of ['priced.tick', 'priced.tickHint', 'priced.floor', 'priced.mark', 'priced.unmark', 'priced.unmarkHint', 'priced.unmarkHeld', 'priced.isPriced', 'priced.marked', 'priced.unmarked', 'priced.stale', 'priced.gone', 'priced.markFailed']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('priced.markFor', { name: 'x.pdf' })).toContain('x.pdf')
    }
    const en = createTranslator('en', messagesFor('en', ['record-files'])['record-files'] ?? {})
    expect(en('priced.tick')).toBe('This file shows prices')
    expect(en('priced.unmarkHeld')).toBe('Only people who see prices take the "shows prices" mark off a file.')
  })
})
// ── end F-CP-144 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
