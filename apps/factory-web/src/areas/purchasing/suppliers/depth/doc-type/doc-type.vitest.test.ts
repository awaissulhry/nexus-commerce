import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen } from '../../record/fixtures'
import { DOC_TYPES } from './demo'
import { docTypeHeld, docTypeProblem, typeWords, type DocTypeDialog } from './model'

/**
 * B-W2b-382 (the screen gap B-W2b-377 left): the supplier's document vault says what each document is (a code of the tenant's
 * SUPPLIER_DOCUMENT_TYPE list, in the list's own words) and offers the picker (`PUT …/documents/:fileId/type`, files.upload).
 */
const dialog = (over: Partial<DocTypeDialog> = {}): DocTypeDialog => ({ fileId: 'f1', name: 'audit.pdf', current: null, chosen: 'LWG_AUDIT', version: 3, busy: false, problem: null, ...over })

describe('a document’s type', () => {
  it('is said in the list’s own words, or by its code when the list no longer has it', () => {
    expect(typeWords('CR_VI_TEST_REPORT', DOC_TYPES, 'it')).toBe('Rapporto di prova cromo VI')
    expect(typeWords('CR_VI_TEST_REPORT', DOC_TYPES, 'en')).toBe('Chromium VI test report')
    expect(typeWords('OLD_CODE', DOC_TYPES, 'en')).toBe('OLD_CODE')
  })
  it('holds Save with why', () => {
    expect(docTypeHeld(dialog(), { mayType: false, offline: false })).toBe('docType.held.noRight')
    expect(docTypeHeld(dialog(), { mayType: true, offline: true })).toBe('docType.held.offline')
    expect(docTypeHeld(dialog({ version: null }), { mayType: true, offline: false })).toBe('docType.held.reading')
    expect(docTypeHeld(dialog({ chosen: '' }), { mayType: true, offline: false })).toBe('docType.held.same')
    expect(docTypeHeld(dialog({ current: 'DURC', chosen: '' }), { mayType: true, offline: false })).toBeNull()
    expect(docTypeHeld(dialog(), { mayType: true, offline: false })).toBeNull()
  })
  it('says the API’s refusals in words', () => {
    expect(docTypeProblem(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/documentTypeCode', message: 'Not active' }]))).toEqual({ key: 'docType.problem.code', reload: true })
    expect(docTypeProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ key: 'docType.problem.moved', reload: true })
    expect(docTypeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'docType.held.noRight', reload: false })
  })
})

describe('SCR-057 draws the types in both languages', () => {
  const View = designScreen.view as unknown as ComponentType<{ model: unknown }>
  const render = (id: string, locale: 'it' | 'en') =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: designScreen.cases.find((item) => item.id === id)!.model })))
  it.each(designScreen.cases.filter((item) => item.id.startsWith('w2b-382-')).map((item) => item.id))('%s: no key left on screen', (id) => {
    for (const locale of ['it', 'en'] as const) expect(render(id, locale)).not.toMatch(/\bdocType\.[a-zA-Z]+/)
  })
  it('a typed document says its type; an untyped one says it meets any ask of its kind', () => {
    const it_ = render('w2b-382-documents-types', 'it')
    expect(it_).toContain('Rapporto di prova cromo VI')
    expect(it_).toContain('Tipo non indicato')
    expect(render('w2b-382-documents-types', 'en')).toContain('Say what it is')
    expect(render('w2b-382-documents-type-saved', 'en')).toContain('audit-lwg-gold.pdf: its type is saved.')
    // The picker is a centred dialog (a portal: not drawn by a server render).
  })
})
