import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SUPPLIER_DOCUMENT_CATEGORIES, SUPPLIER_DOCUMENT_STATES } from '@nexus/factory-domain/purchasing/portal-profile/documents'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { DOCUMENT_STATES, type AskedRow, type DocumentRow, type SupplierDocuments } from './api'
import { designScreen } from './fixtures'
import { askGroups, askItems, codesOf, docRows, downloadHeld, dueStateOf, emptyDraft, forWords, kindKey, sendRefusal, uploadBody, uploadHeld, uploadProblems, whyOf } from './model'

/**
 * The supplier's Documents (B-W2b-193, SCR-190): what "We ask for" says and holds, the documents' states, the upload's own
 * rules and what it sends, and every design case drawn in Italian and English with no raw key and made-up data only.
 */

const PARTY = { type: 'Party', id: 'p', label: 'SUP' }
const PO = { type: 'PurchaseOrder', id: 'po', label: 'PO-1' }
const ask = (over: Partial<AskedRow> & Pick<AskedRow, 'key' | 'source'>): AskedRow => ({ category: null, record: PARTY, forRecords: [PARTY], dueOn: null, level: null, state: null, taskId: null, askedBy: null, waiting: false, ...over })
const doc = (over: Partial<DocumentRow> & Pick<DocumentRow, 'fileId' | 'state'>): DocumentRow => ({ uploadFileId: null, category: 'TEST_REPORT', name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, record: PO, issuer: null, number: null, issuedOn: null, expiresOn: null, daysLeft: null, articles: [], lots: [], sentAt: null, decidedAt: null, reason: null, canReplace: false, ...over })
const read = (over: Partial<SupplierDocuments> = {}): SupplierDocuments => ({ today: '2026-11-09', mayUpload: true, categories: [...SUPPLIER_DOCUMENT_CATEGORIES], requested: [], documents: [], counts: { requested: 0, waiting: 0, expiring: 0, refused: 0 }, live: { events: [] }, ...over })
const FACTS = { preview: false, offline: false, mayUpload: true }

describe('the API’s codes', () => {
  it('knows every state and kind the API sends', () => {
    expect([...DOCUMENT_STATES]).toEqual([...SUPPLIER_DOCUMENT_STATES])
    for (const category of SUPPLIER_DOCUMENT_CATEGORIES) expect(kindKey(category)).toBe(`documents.kind.${category}`)
    expect(kindKey(null)).toBe('documents.kind.OTHER')
    expect(forWords(PARTY)).toEqual({ key: 'documents.for.Party' })
    expect(forWords(PO)).toEqual({ key: 'documents.for.PurchaseOrder', params: { label: 'PO-1' } })
  })
})

describe('We ask for', () => {
  it('says why in our words from the codes, never the API’s sentence', () => {
    expect(whyOf(ask({ key: 'r', source: 'RULE', level: 'BLOCK', state: 'MISSING', record: PO, forRecords: [PO] }), [])).toEqual({ key: 'documents.why.ruleBlock', params: { records: 'PO-1', count: 1 } })
    expect(whyOf(ask({ key: 'r', source: 'RULE', level: 'WARN', state: 'MISSING', forRecords: [PO, { ...PO, id: 'po2', label: 'PO-2' }] }), [])).toEqual({ key: 'documents.why.ruleWarn', params: { records: 'PO-1, PO-2', count: 2 } })
    expect(whyOf(ask({ key: 'r', source: 'RULE', level: 'BLOCK', state: 'EXPIRED' }), [])).toEqual({ key: 'documents.why.companyExpired' })
    expect(whyOf(ask({ key: 't', source: 'ASKED', askedBy: 'Anna' }), [])).toEqual({ key: 'documents.why.askedBy', params: { name: 'Anna' } })
    expect(whyOf(ask({ key: 't', source: 'EXPIRY' }), [])).toEqual({ key: 'documents.why.expiry' })
    const refused = doc({ fileId: 'f', state: 'REJECTED', reason: 'Wrong batch.' })
    expect(whyOf(ask({ key: 't', source: 'REFUSED', record: PO, category: 'TEST_REPORT' }), [refused])).toEqual({ key: 'documents.why.refusedReason', params: { reason: 'Wrong batch.' } })
    expect(whyOf(ask({ key: 't', source: 'REFUSED', record: PO }), [])).toEqual({ key: 'documents.why.refused' })
  })

  it('a request answers by its task, a rule by its record; groups keep the page’s order', () => {
    const items = askItems(read({ requested: [ask({ key: 'a', source: 'ASKED', taskId: 'task-1' }), ask({ key: 'b', source: 'RULE', category: 'TEST_REPORT', record: PO, forRecords: [PO], level: 'BLOCK', state: 'MISSING', dueOn: '2026-11-08' })] }), FACTS)
    expect(items[0]!.target).toMatchObject({ taskId: 'task-1' })
    expect(items[1]!.target).toMatchObject({ recordType: 'PurchaseOrder', recordId: 'po', category: 'TEST_REPORT' })
    expect(items[1]!.due).toEqual({ day: '2026-11-08', state: 'overdue' })
    expect(askGroups(items).map((group) => group.group)).toEqual(['NEEDED', 'ASKED'])
    expect(items[0]!.records).toEqual([])
  })

  it('holds Upload with the reason: a preview, no connection, no right to upload, already with us', () => {
    expect(uploadHeld({ ...FACTS, preview: true })).toBe('held.preview')
    expect(uploadHeld({ ...FACTS, offline: true })).toBe('held.offline')
    expect(uploadHeld({ ...FACTS, mayUpload: false })).toBe('held.mayNotUpload')
    expect(askItems(read({ requested: [ask({ key: 'w', source: 'RULE', waiting: true })] }), FACTS)[0]!.held).toBe('held.waiting')
  })

  it('places a due day today, within a week, later or overdue', () => {
    expect(dueStateOf('2026-11-09', '2026-11-09')).toBe('today')
    expect(dueStateOf('2026-11-16', '2026-11-09')).toBe('soon')
    expect(dueStateOf('2026-11-17', '2026-11-09')).toBe('later')
    expect(dueStateOf('2026-11-01', '2026-11-09')).toBe('overdue')
  })
})

describe('Your documents', () => {
  it('only what we shared back opens; a refused one is sent again for its request; an accepted one is replaced', () => {
    const value = read({
      requested: [ask({ key: 't', source: 'REFUSED', taskId: 'task-9', record: PO, category: 'TEST_REPORT' })],
      documents: [doc({ fileId: 'r', state: 'REJECTED', reason: 'No.' }), doc({ fileId: 'w', state: 'WAITING' }), doc({ fileId: 'a', state: 'ACCEPTED', canReplace: true, expiresOn: '2026-11-30', daysLeft: 21 }), doc({ fileId: 'x', state: 'EXPIRED', canReplace: true, daysLeft: -2 })],
    })
    const rows = docRows(value)
    expect(rows.map((row) => [row.id, row.shared, downloadHeld(row)])).toEqual([
      ['r', false, 'held.notAccepted'],
      ['w', false, 'held.notShared'],
      ['a', true, null],
      ['x', true, null],
    ])
    expect(rows[0]!.again).toMatchObject({ taskId: 'task-9' })
    expect(rows[2]!.replace).toMatchObject({ replacesFileId: 'a', category: 'TEST_REPORT' })
    expect(rows[2]!.expiringSoon).toBe(true)
    expect(rows[3]!.expiringSoon).toBe(false)
  })
})

describe('the upload', () => {
  const pdf = { name: 'a.pdf', size: 1000, type: 'application/pdf' }
  it('checks what the API checks, and the file', () => {
    expect(uploadProblems(emptyDraft(null), null, '2026-11-09')).toEqual({ category: 'upload.problem.kind', file: 'upload.problem.file' })
    expect(uploadProblems({ ...emptyDraft('TEST_REPORT'), issuedOn: '2026-11-10', expiresOn: '2026-11-01' }, pdf, '2026-11-09')).toMatchObject({ issuedOn: 'upload.problem.issued', expiresOn: 'upload.problem.expires' })
    expect(uploadProblems(emptyDraft('TEST_REPORT'), { ...pdf, type: 'text/plain' }, '2026-11-09')).toEqual({ file: 'upload.problem.fileType' })
    expect(uploadProblems(emptyDraft('TEST_REPORT'), { ...pdf, size: 21 * 1024 * 1024 }, '2026-11-09')).toEqual({ file: 'upload.problem.fileSize' })
    expect(uploadProblems({ ...emptyDraft('DECLARATION'), lots: 'x'.repeat(61) }, pdf, '2026-11-09')).toEqual({ lots: 'upload.problem.codes' })
    expect(uploadProblems(emptyDraft('DECLARATION'), pdf, '2026-11-09')).toEqual({})
  })

  it('sends the details, the file and what it answers', () => {
    expect(codesOf(' 2231, 2232\n2233;; ')).toEqual(['2231', '2232', '2233'])
    const body = uploadBody({ ...emptyDraft('TEST_REPORT'), issuer: ' Lab ', lots: '2231' }, { taskId: 't1', category: 'TEST_REPORT', for: { key: 'x' } }, pdf, 'f'.repeat(64))
    expect(body).toMatchObject({ category: 'TEST_REPORT', issuer: 'Lab', number: null, lots: ['2231'], articles: [], taskId: 't1', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1000 })
    expect(uploadBody(emptyDraft('TEST_REPORT'), { recordType: 'PurchaseOrder', recordId: 'po', category: null, for: { key: 'x' } }, pdf, '0')).toMatchObject({ recordType: 'PurchaseOrder', recordId: 'po' })
    expect(uploadBody(emptyDraft('TEST_REPORT'), { replacesFileId: 'a', category: null, for: { key: 'x' } }, pdf, '0')).toMatchObject({ replacesFileId: 'a' })
    expect('taskId' in uploadBody(emptyDraft('TEST_REPORT'), { category: null, for: { key: 'x' } }, pdf, '0')).toBe(false)
  })

  it('says a refusal in our words', () => {
    expect(sendRefusal('conflict')).toBe('upload.failed.answered')
    expect(sendRefusal('invalid', ['body.taskId'])).toBe('upload.failed.gone')
    expect(sendRefusal('invalid', ['body.issuer'])).toBe('upload.failed.invalid')
    expect(sendRefusal('store')).toBe('upload.failed.store')
    expect(sendRefusal(null)).toBe('upload.failed.network')
  })
})

const KEY = /\b(documents|upload|held|receipt|keys|band|state|status)\.[a-zA-Z_.-]+/

describe('SCR-190 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(20)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        expect(html).not.toMatch(/€|EUR\b/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'normal')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Ti chiediamo')
    expect(html).toContain('I tuoi documenti')
    expect(html).not.toContain('Your documents')
    expect(html).not.toContain('We ask for')
  })

  it('has its words in both languages', () => {
    const en = CATALOGUE.en['portal-supplier-profile'] ?? {}
    const it = CATALOGUE.it['portal-supplier-profile'] ?? {}
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort())
  })
})
