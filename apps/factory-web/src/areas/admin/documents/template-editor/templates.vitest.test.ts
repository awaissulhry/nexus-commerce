import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { createDocumentTemplate, deleteDocumentTemplate, documentTemplatePreviewHref, listDocumentTemplates, printsNowHref, publishDocumentTemplate, saveDocumentTemplate } from '../doc-templates/api'
import { DOCUMENT_TEMPLATE_KINDS, MANDATORY_PARTS } from '@nexus/factory-domain/templates/documents'
import { answerOf, COMMERCIAL_EN_V1, DEMO_TEMPLATES, PO_IT_V1, PROFORMA_IT_V1, QUOTE_IT_V2, QUOTE_IT_V3 } from '../doc-templates/fixtures'
import { designScreen as docListScreen } from '../doc-templates/fixtures'
import { bulkReach, counts, openTarget, rowHeld, rowId, rowsOf, startHeld } from '../doc-templates/model'
import { createEmailTemplate, previewEmailTemplate, saveEmailTemplate } from '../mail-templates/api'
import { EVENTS, MAIL_TEMPLATES, mailAnswerOf, SERVICE_IT_V3 } from '../mail-templates/fixtures'
import { designScreen as mailListScreen } from '../mail-templates/fixtures'
import { draftsOf, mailBulkReach, mailOpenTarget, mailRowHeld, mailRowId, mailRowsOf, mailStarts } from '../mail-templates/model'
import { languageUnread } from '../mail-templates/model' // th-backend-g step 3
import { designScreen as editorScreen } from './fixtures'
// B-TH-279: Saved replies (Admin › Documents › E-mail templates › Saved replies).
import { REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'
import { createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply } from '../mail-templates/replies/api'
import { REPLIES, repliesAnswer } from '../mail-templates/replies/fixtures'
import { deleteReach, draftBody, draftOf, draftProblems, mailPartOf, newDraft, NO_FILTER, replyPreview, replyRowHeld, replyRowsOf, saveHeld as replySaveHeld } from '../mail-templates/replies/model'
import { designScreen as mailEditorScreen } from './mail/fixtures'
import {
  documentChanges,
  documentDraftOf,
  documentProblems,
  documentSaveBody,
  droppedColumns,
  insertAt,
  layoutColumns,
  mailProblems,
  newVersionHeld,
  partWhyKey,
  publishHeld,
  refusalOf,
  refusalReloads,
  saveHeld,
  toggleColumn,
  wordProblems,
} from './model'

/**
 * B-W2b-432 — Admin › Documents' templates: the words' problems in this web's words, the draft and what a save sends, what
 * each button waits for, a refusal said by its code, the document and e-mail lists' rows, opens and bulk reaches, the calls
 * to platform/templates, the `admin-templates` catalogue, and every design case of SCR-630 to SCR-633 in both languages
 * with no key left on screen.
 */

const QUOTE_PLACEHOLDERS = ['quote.number', 'party.name']

describe('the words of a template', () => {
  it('says too long first, then a broken placeholder, then each name the template does not offer', () => {
    expect(wordProblems('x'.repeat(12), 10, QUOTE_PLACEHOLDERS)).toEqual([{ key: 'tpl.problem.tooLong', params: { limit: 10, over: 2 } }])
    expect(wordProblems('Ciao {{party.name', 100, QUOTE_PLACEHOLDERS)).toEqual([{ key: 'tpl.problem.syntax' }])
    expect(wordProblems('{{quote.number}} {{ordine.numero}} {{ordine.numero}}', 100, QUOTE_PLACEHOLDERS)).toEqual([{ key: 'tpl.problem.notOffered', params: { name: '{{ordine.numero}}' } }])
    expect(wordProblems('Gentile {{ party.name }}', 100, QUOTE_PLACEHOLDERS)).toEqual([])
  })

  it('puts a placeholder at the caret (or at the end) and says where the caret goes', () => {
    expect(insertAt('Gentile ,', '{{party.name}}', { start: 8, end: 8 })).toEqual({ text: 'Gentile {{party.name}},', caret: 22 })
    expect(insertAt('abc', '{{x}}', { start: 1, end: 2 })).toEqual({ text: 'a{{x}}c', caret: 6 })
    expect(insertAt('abc', '{{x}}', null)).toEqual({ text: 'abc{{x}}', caret: 8 })
  })

  it('a refusal by its code, a stale version, no right, else the shared problem', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/DRAFT_OPEN', message: 'x' }])
    expect(refusalOf(refused)).toEqual({ key: 'tpl.refusal.DRAFT_OPEN' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'tpl.problem.stale' })
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'tpl.problem.noRight' })
    expect(refusalOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/header', message: 'x' }]))).toEqual({ key: 'tpl.problem.invalid' })
    expect(refusalOf(new ApiError('unavailable', 503, 'unavailable', 'x'))).toEqual({ key: 'problem.unavailable' })
    expect(refusalReloads(refused)).toBe(true)
    expect(refusalReloads(new ApiError('invalid', 400, 'invalid', 'x'))).toBe(false)
  })
})

describe('a document template draft', () => {
  const draft = documentDraftOf(QUOTE_IT_V3)

  it('keeps the optional columns in the layout order whatever order they are ticked in', () => {
    expect(toggleColumn('QUOTE', ['unitPrice'], 'code', true)).toEqual(['code', 'unitPrice'])
    expect(toggleColumn('QUOTE', ['code', 'unitPrice', 'discount'], 'unitPrice', false)).toEqual(['code', 'discount'])
    expect(layoutColumns('QUOTE', { mandatoryColumns: ['description', 'quantity', 'amount'], optionalColumns: ['code', 'uom', 'unitPrice', 'discount'] }).map((column) => `${column.key}${column.mandatory ? '!' : ''}`)).toEqual(['code', 'description!', 'quantity!', 'uom', 'unitPrice', 'discount', 'amount!'])
  })

  it('leaves out a column the kind’s layout lacks (as the seed’s draft lists one) and counts it as a change to save', () => {
    const saved = { ...QUOTE_IT_V3, fieldsShown: ['code', 'unitPrice', 'delivery'] }
    expect(documentDraftOf(saved).fieldsShown).toEqual(['code', 'unitPrice'])
    expect(droppedColumns(saved)).toEqual(['delivery'])
    expect(documentChanges(saved, documentDraftOf(saved))).toEqual(['fieldsShown'])
    expect(documentSaveBody(saved, documentDraftOf(saved))).toEqual({ fieldsShown: ['code', 'unitPrice'] })
  })

  it('sends only what changed, an emptied text as null (the company’s own footer)', () => {
    expect(documentChanges(QUOTE_IT_V3, draft)).toEqual([])
    const next = { ...draft, footer: '  ', fieldsShown: ['code'] }
    expect(documentChanges(QUOTE_IT_V3, next)).toEqual(['footer', 'fieldsShown'])
    expect(documentSaveBody(QUOTE_IT_V3, next)).toEqual({ footer: null, fieldsShown: ['code'] })
  })

  it('finds the problems of each text with the kind’s placeholders and limits', () => {
    const kind = { placeholders: QUOTE_PLACEHOLDERS, limits: { header: 20, terms: 100, footer: 5 } }
    expect(documentProblems(kind, { ...draft, header: '{{quote.number}}', terms: '', footer: '' })).toEqual({})
    const problems = documentProblems(kind, { ...draft, header: '{{ordine}}', terms: '', footer: 'troppo lungo' })
    expect(Object.keys(problems)).toEqual(['header', 'footer'])
    expect(documentProblems(null, draft)).toEqual({})
  })

  it('Save, Publish and New version wait with a reason', () => {
    const state = { status: 'DRAFT' as const, mayManage: true, busy: false, changed: 0, problems: 0 }
    expect(saveHeld(state)).toBe('tpl.held.nothingChanged')
    expect(saveHeld({ ...state, changed: 1 })).toBeNull()
    expect(saveHeld({ ...state, changed: 1, problems: 2 })).toBe('tpl.held.problems')
    expect(saveHeld({ ...state, status: 'ACTIVE', changed: 1 })).toBe('tpl.held.published')
    expect(saveHeld({ ...state, mayManage: false })).toBe('tpl.held.noRight')
    expect(publishHeld(state)).toBeNull()
    expect(publishHeld({ ...state, changed: 1 })).toBe('tpl.held.saveFirst')
    expect(publishHeld({ ...state, status: 'ACTIVE' })).toBe('tpl.held.inUse')
    expect(publishHeld({ ...state, status: 'RETIRED' })).toBe('tpl.held.retired')
    expect(newVersionHeld(state, { revision: 3 })).toBe('tpl.held.draftOpen')
    expect(newVersionHeld(state, null)).toBeNull()
  })
})

describe('an e-mail template draft', () => {
  it('a subject is one line and never empty; the body is never empty; names the event does not offer are said', () => {
    const offered = EVENTS.events.find((event) => event.event === 'service.status_changed')!.placeholders
    expect(mailProblems(offered, { subject: SERVICE_IT_V3.subject, body: SERVICE_IT_V3.body })).toEqual({})
    expect(mailProblems(offered, { subject: '', body: ' ' })).toEqual({ subject: [{ key: 'tpl.problem.subjectEmpty' }], body: [{ key: 'tpl.problem.bodyEmpty' }] })
    expect(mailProblems(offered, { subject: 'a\nb', body: '{{order.number}}' })).toEqual({ subject: [{ key: 'tpl.problem.oneLine' }], body: [{ key: 'tpl.problem.notOffered', params: { name: '{{order.number}}' } }] })
  })
})

describe('the document templates list', () => {
  const rows = rowsOf(answerOf(DEMO_TEMPLATES))
  const row = (id: string) => rows.find((entry) => entry.id === id)!

  it('one row per kind and language; a row opens its draft, else its version in use, else nothing', () => {
    // B-W2b-F60: eight documents in two languages, the proforma and the commercial invoice last.
    expect(rows).toHaveLength(16)
    expect(rows.map((entry) => entry.id).slice(-4)).toEqual([rowId('PROFORMA', 'it'), rowId('PROFORMA', 'en'), rowId('COMMERCIAL_INVOICE', 'it'), rowId('COMMERCIAL_INVOICE', 'en')])
    expect(row(rowId('QUOTE', 'it')).active?.id).toBe(QUOTE_IT_V2.id)
    expect(openTarget(row(rowId('QUOTE', 'it')))).toBe(QUOTE_IT_V3.id)
    expect(openTarget(row(rowId('PURCHASE_ORDER', 'it')))).toBe(PO_IT_V1.id)
    expect(openTarget(row(rowId('DDT', 'it')))).toBeNull()
    expect(openTarget(row(rowId('PROFORMA', 'it')))).toBe(PROFORMA_IT_V1.id)
    expect(row(rowId('COMMERCIAL_INVOICE', 'en')).active?.id).toBe(COMMERCIAL_EN_V1.id)
    expect(row(rowId('COMMERCIAL_INVOICE', 'en')).slot.layout).toBe('COMMERCIAL_INVOICE/1+t1')
    expect(rowHeld(row(rowId('COMMERCIAL_INVOICE', 'it')), true)).toBe('tpl.list.nothingToDo')
    expect(counts(rows)).toEqual({ inUse: 3, drafts: 3, fixed: 13 })
  })

  it('names every kind in both languages, and says in its own words what the proforma and the commercial invoice always print (B-W2b-F60)', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['admin-templates'] ?? {}
      for (const kind of DOCUMENT_TEMPLATE_KINDS) {
        expect(words[`tpl.kind.${kind}`], `${locale} ${kind}`).toBeTruthy()
        for (const part of MANDATORY_PARTS) expect(words[partWhyKey(kind, part)], `${locale} ${kind} ${part}`).toBeTruthy()
      }
    }
    expect(partWhyKey('COMMERCIAL_INVOICE', 'FACTS')).toBe('tpl.partWhyOf.COMMERCIAL_INVOICE.FACTS')
    expect(partWhyKey('PROFORMA', 'NOTICES')).toBe('tpl.partWhyOf.PROFORMA.NOTICES')
    expect(partWhyKey('QUOTE', 'FACTS')).toBe('tpl.partWhy.FACTS')
    expect(partWhyKey('COMMERCIAL_INVOICE', 'COMPANY_LEGAL')).toBe('tpl.partWhy.COMPANY_LEGAL')
  })

  it('a fixed-layout row without a draft cannot be ticked; bulk actions say their reach', () => {
    expect(rowHeld(row(rowId('DDT', 'it')), true)).toBe('tpl.list.nothingToDo')
    expect(rowHeld(row(rowId('QUOTE', 'it')), false)).toBe('tpl.held.noRight')
    const chosen = [row(rowId('QUOTE', 'it')), row(rowId('PURCHASE_ORDER', 'it')), row(rowId('INVOICE_COPY', 'en'))]
    expect(bulkReach(chosen, 'publish').applies.map((entry) => entry.id)).toEqual([rowId('QUOTE', 'it'), rowId('INVOICE_COPY', 'en')])
    expect(bulkReach(chosen, 'retire').applies.map((entry) => entry.id)).toEqual([rowId('QUOTE', 'it'), rowId('PURCHASE_ORDER', 'it')])
    expect(bulkReach(chosen, 'delete').left.map((entry) => entry.why)).toEqual(['tpl.bulk.left.noDraft'])
    expect(startHeld(false, false)).toBe('tpl.held.noRight')
    expect(startHeld(true, true)).toBe('tpl.held.busy')
  })
})

describe('the e-mail templates list', () => {
  const answer = { list: mailAnswerOf(MAIL_TEMPLATES), events: EVENTS }
  const rows = mailRowsOf(answer)
  const row = (id: string) => rows.find((entry) => entry.id === id)!
  const may = { company: true, all: true }

  it('what each mail goes out with now, its subject, and which version a row opens', () => {
    const service = row(mailRowId('service.status_changed', 'it'))
    expect(service.slot.inUse).toBe('COMPANY')
    expect(service.subject).toContain('Officina Demo')
    expect(mailOpenTarget(service)).toBe(service.companyDraft!.id)
    const english = row(mailRowId('service.status_changed', 'en'))
    expect(english.slot.inUse).toBe('CODE')
    expect(english.subject).toBe(EVENTS.events[0]!.words.en!.subject)
    expect(mailOpenTarget(english)).toBeNull()
    expect(row(mailRowId('shipping.tracking_link', 'it')).slot.inUse).toBe('ALL')
  })

  it('drafts and starts follow the rights; bulk reaches say what they leave out', () => {
    const tracking = row(mailRowId('shipping.tracking_link', 'en'))
    expect(draftsOf(tracking, may)).toHaveLength(1)
    expect(draftsOf(tracking, { company: true, all: false })).toHaveLength(0)
    expect(mailStarts(tracking, may)).toEqual(['company'])
    expect(mailStarts(row(mailRowId('service.status_changed', 'en')), { company: true, all: false })).toEqual(['company'])
    expect(mailRowHeld(row(mailRowId('service.status_changed', 'en')), may)).toBe('tpl.list.nothingToDo')
    expect(mailRowHeld(tracking, { company: false, all: false })).toBe('tpl.held.noRight')
    const chosen = [row(mailRowId('service.status_changed', 'it')), tracking]
    expect(mailBulkReach(chosen, 'publish', may).applies).toHaveLength(2)
    expect(mailBulkReach(chosen, 'retire', may).left.map((entry) => entry.why)).toEqual(['tpl.bulk.left.noOwn'])
  })

  // ---- th-backend-g step 3 (B-TH-098's web half): the de / fr / es slots, Claude's drafts "to be read once" until someone has.
  it('th-backend-g step 3: a German slot reads Claude’s draft and says "to be read once" until German is read; a person’s version needs no reading', () => {
    const draftWords = { subject: 'Ihre Serviceanfrage {{case.number}}', body: 'Guten Tag' }
    const events = { ...EVENTS, events: EVENTS.events.map((event) => ({ ...event, drafts: { de: draftWords, fr: draftWords, es: draftWords } })), messageLanguages: ['it', 'en', 'de', 'fr', 'es'] as ('it' | 'en' | 'de' | 'fr' | 'es')[], review: { de: { readBy: null, readOn: null }, fr: { readBy: 'Owner', readOn: '2026-11-20' }, es: { readBy: null, readOn: null } } }
    const slot = (event: string, language: 'de' | 'fr' | 'es', inUse: 'CODE' | 'COMPANY') => ({ event: event as never, language, inUse, company: { active: inUse === 'COMPANY' ? { id: 'own-de', revision: 1, at: '2026-11-17T08:00:00.000Z' } : null, draft: null }, all: { active: null, draft: null }, lastChangedAt: null })
    const list = { templates: [], slots: [slot('service.status_changed', 'de', 'CODE'), slot('service.status_changed', 'fr', 'CODE'), slot('shipping.tracking_link', 'de', 'COMPANY')], mayManage: { company: true, all: true } }
    const fives = mailRowsOf({ list, events })
    expect(fives.map((entry) => [entry.id, entry.unread, entry.subject])).toEqual([
      ['service.status_changed:de', true, draftWords.subject],
      ['service.status_changed:fr', false, draftWords.subject],
      ['shipping.tracking_link:de', false, null],
    ])
    expect(languageUnread('de', events.review)).toBe(true)
    expect(languageUnread('it', events.review)).toBe(false)
    expect(languageUnread('de', undefined)).toBe(false)
  })
})

type Call = { method: string; url: string; headers: Headers; body: unknown }
function mockApi(answers: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the template calls (platform/templates)', () => {
  it('documents: list, a new draft with its key, save at the version read, publish, delete a draft', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: answerOf(DEMO_TEMPLATES) },
      { status: 201, body: { template: QUOTE_IT_V3 } },
      { status: 200, body: { template: QUOTE_IT_V3 } },
      { status: 200, body: { template: { ...QUOTE_IT_V3, status: 'ACTIVE' }, retired: { id: QUOTE_IT_V2.id, revision: 2 } } },
      { status: 200, body: { deleted: QUOTE_IT_V3.id } },
    ])
    expect((await listDocumentTemplates(api, { companyId: 'c1' })).slots).toHaveLength(16)
    await createDocumentTemplate(api, { companyId: 'c1', kind: 'QUOTE', language: 'it', from: QUOTE_IT_V2.id }, 'key-1')
    await saveDocumentTemplate(api, QUOTE_IT_V3, { footer: null })
    expect((await publishDocumentTemplate(api, QUOTE_IT_V3)).retired?.revision).toBe(2)
    expect(await deleteDocumentTemplate(api, QUOTE_IT_V3)).toBe(QUOTE_IT_V3.id)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/templates/documents?companyId=c1',
      'POST /api/templates/documents',
      `PUT /api/templates/documents/${QUOTE_IT_V3.id}`,
      `POST /api/templates/documents/${QUOTE_IT_V3.id}/publish`,
      `DELETE /api/templates/documents/${QUOTE_IT_V3.id}?version=${QUOTE_IT_V3.version}`,
    ])
    expect(calls[1]!.headers.get('idempotency-key')).toBe('key-1')
    expect(calls[1]!.body).toEqual({ companyId: 'c1', kind: 'QUOTE', language: 'it', from: QUOTE_IT_V2.id })
    expect(calls[2]!.body).toEqual({ version: QUOTE_IT_V3.version, footer: null })
    expect(calls[3]!.body).toEqual({ version: QUOTE_IT_V3.version })
    expect(calls[2]!.headers.get('x-csrf-token')).toBe('csrf-demo')
  })

  it('the PDFs are plain addresses through /api: a version’s preview, what prints now', () => {
    expect(documentTemplatePreviewHref('t1')).toBe('/api/templates/documents/t1/preview')
    expect(printsNowHref('c1', 'ORDER_CONFIRMATION', 'en')).toBe('/api/documents/sample?companyId=c1&type=ORDER_CONFIRMATION&language=en')
  })

  it('mail: a new every-company draft, save, the preview (nothing sent)', async () => {
    const { api, calls } = mockApi([
      { status: 201, body: { template: { ...SERVICE_IT_V3, companyId: null } } },
      { status: 200, body: { template: SERVICE_IT_V3 } },
      { status: 200, body: { subject: 's', body: 'b', missing: ['message'] } },
    ])
    await createEmailTemplate(api, { companyId: null, event: 'shipping.tracking_link', language: 'en' })
    await saveEmailTemplate(api, SERVICE_IT_V3, { subject: 'x' })
    expect((await previewEmailTemplate(api, SERVICE_IT_V3.id, 'c1')).missing).toEqual(['message'])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/templates/mail', `PUT /api/templates/mail/${SERVICE_IT_V3.id}`, `POST /api/templates/mail/${SERVICE_IT_V3.id}/preview`])
    expect(calls[0]!.body).toEqual({ companyId: null, event: 'shipping.tracking_link', language: 'en' })
    expect(calls[2]!.body).toEqual({ companyId: 'c1' })
  })
})

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FOLDERS = ['documents/doc-templates', 'documents/mail-templates', 'documents/template-editor', 'languages/partner', '../_shared/document-send/language', '../_shared/document-send/template']
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })

describe('the admin-templates catalogue', () => {
  const en = CATALOGUE.en['admin-templates'] ?? {}
  const itc = CATALOGUE.it['admin-templates'] ?? {}

  it('the same keys and placeholders in it and en, all under tpl., none empty', () => {
    expect(Object.keys(en).length).toBeGreaterThan(250)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(key.startsWith('tpl.'), key).toBe(true)
      expect(en[key]?.trim(), `en ${key}`).not.toBe('')
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the code names literally exists', () => {
    const keys = new Set<string>()
    for (const folder of FOLDERS) for (const file of sources(join(ROOT, folder))) for (const match of readFileSync(file, 'utf8').matchAll(/['"`](tpl\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) keys.add(match[1]!)
    expect(keys.size).toBeGreaterThan(150)
    const has = (key: string) => LOCALES.every((locale) => key in (CATALOGUE[locale]['admin-templates'] ?? {}) || (`${key}_one` in (CATALOGUE[locale]['admin-templates'] ?? {}) && `${key}_other` in (CATALOGUE[locale]['admin-templates'] ?? {})))
    expect([...keys].filter((key) => !has(key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:tpl|docs|problem|common|list|held)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const SCREENS = [docListScreen, editorScreen, mailListScreen, mailEditorScreen]

function render(view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))
}

describe('SCR-630 to SCR-633 draw every case in both languages with no key left on screen', () => {
  it('are the step’s screens, with their states', () => {
    expect(SCREENS.map((screen) => screen.screen)).toEqual(['SCR-630', 'SCR-631', 'SCR-632', 'SCR-633'])
    for (const screen of SCREENS) {
      const ids = screen.cases.map((item) => item.id)
      expect(ids.some((id) => id === 'loading'), screen.screen).toBe(true)
      expect(ids.some((id) => ['failed', 'not-found'].includes(id)), screen.screen).toBe(true)
      expect(ids.some((id) => id === 'read-only'), screen.screen).toBe(true)
    }
  })
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const screen of SCREENS)
        for (const item of screen.cases) {
          const html = render(screen.view as ComponentType<{ model: unknown }>, item.model, locale)
          expect(html.length, `${screen.screen} ${item.id}`).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
        }
    })
  }

  it('says the editor’s words: the title, the locked parts, the held Publish, the placeholders’ problems', () => {
    const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(editorScreen.view as ComponentType<{ model: unknown }>, editorScreen.cases.find((item) => item.id === id)!.model, locale).replace(/<!-- -->/g, '')
    expect(draw('draft')).toContain('Template: Quote (Italiano)')
    expect(draw('draft', 'it')).toContain('Modello: Preventivo (Italiano)')
    expect(draw('draft')).toContain('Always printed')
    expect(draw('draft')).toContain('The company&#x27;s legal data')
    expect(draw('problems')).toContain('{{ordine.numero}} is not offered here')
    expect(draw('in-use-draft-open')).toContain('Open draft version 3')
    // B-W2b-F60: the commercial invoice's own lines, and the proforma's, in both languages.
    expect(draw('commercial-invoice')).toContain('Template: Commercial invoice (for customs) (English)')
    expect(draw('commercial-invoice')).toContain('The exporter&#x27;s EORI, the reason for the export, the destination country')
    expect(draw('commercial-invoice', 'it')).toContain('Modello: Fattura commerciale (uso doganale) (English)')
    expect(draw('commercial-invoice', 'it')).toContain('non imponibile (art. 8 DPR 633/1972)')
    expect(draw('proforma-draft')).toContain('That it is not a tax document')
    expect(draw('proforma-draft', 'it')).toContain('Che non è un documento fiscale')
  })
})

// ---- B-TH-279 (threads plan TH-6, O-ADM-MAILTPL.replies-F01; back end B-W2b-422 + B-TH-046): Saved replies ------------------------------
describe('B-TH-279 saved replies: the rows, the draft, what a save sends, what each button waits for', () => {
  const answer = repliesAnswer()
  const reply = (n: number) => REPLIES[n - 1]!

  it('the rows of a language, a kind of record (ANY = for any record) and a search; the shared first, then by name', () => {
    expect(replyRowsOf(answer).map((row) => row.shared)).toEqual([true, true, true, true, false, false])
    expect(replyRowsOf(answer, { ...NO_FILTER, language: 'en' }).map((row) => row.name)).toEqual(['Sizes and quantities, please', 'Thanks, talk soon'])
    expect(replyRowsOf(answer, { ...NO_FILTER, record: 'Inquiry' }).map((row) => row.id)).toEqual([reply(1).id, reply(2).id])
    expect(replyRowsOf(answer, { ...NO_FILTER, record: 'ANY' }).every((row) => row.recordType === null)).toBe(true)
    expect(replyRowsOf(answer, { ...NO_FILTER, q: 'taglie' }).map((row) => row.id)).toEqual([reply(1).id])
    expect(replyRowsOf(null)).toEqual([])
  })

  it('requests of Sales › Incoming are a kind of record with their own placeholders (B-TH-046)', () => {
    expect(REPLY_RECORD_TYPES).toContain('Inquiry')
    const forRequest = { ...newDraft(NO_FILTER), name: 'Sizes', body: 'Request {{inquiry.number}} for {{contact.name}}' }
    expect(draftProblems(forRequest)).toEqual({ name: [], body: [] })
    expect(draftProblems({ ...forRequest, record: 'ANY' }).body).toEqual([{ key: 'tpl.problem.notOffered', params: { name: '{{inquiry.number}}' } }])
    expect(draftProblems({ ...forRequest, body: 'Order {{order.number}}' }).body).toEqual([{ key: 'tpl.problem.notOffered', params: { name: '{{order.number}}' } }])
  })

  it('the name is one line of 1 to 120; the words are never empty', () => {
    expect(draftProblems({ ...newDraft(), name: 'Two\nlines', body: 'x' }).name).toEqual([{ key: 'tpl.replies.problem.name', params: { limit: 120 } }])
    expect(draftProblems({ ...newDraft(), name: ' ', body: 'x' }).name).toHaveLength(1)
    expect(draftProblems({ ...newDraft(), name: 'ok', body: '  ' }).body).toEqual([{ key: 'tpl.replies.problem.body' }])
  })

  it('a new reply is sent whole (shared or own, the company); a change sends only what changed, else nothing', () => {
    const draft = { ...newDraft({ language: 'en', record: 'Inquiry', q: '' }, true), name: ' Sizes ', body: 'Hello {{contact.name}}\r\n' }
    expect(draftBody(null, draft, 'c1')).toEqual({ name: 'Sizes', language: 'en', body: 'Hello {{contact.name}}', recordType: 'Inquiry', companyId: 'c1', shared: true })
    expect(draftBody(reply(1), draftOf(reply(1)), 'c1')).toBeNull()
    expect(draftBody(reply(1), { ...draftOf(reply(1)), name: 'Taglie, per favore' }, 'c1')).toEqual({ name: 'Taglie, per favore' })
    expect(draftBody(reply(5), { ...draftOf(reply(5)), record: 'Inquiry' }, 'c1')).toEqual({ recordType: 'Inquiry' })
  })

  it('Save waits: no right to send e-mail; sharing without the share right; another’s or a shared reply one may not change; busy; problems; nothing changed', () => {
    const state = { reply: null, draft: { ...newDraft(), name: 'n', body: 'b' }, mayWrite: true, mayShare: true, busy: false, companyId: 'c1' }
    expect(replySaveHeld(state)).toBeNull()
    expect(replySaveHeld({ ...state, mayWrite: false })).toBe('tpl.replies.held.noRight')
    expect(replySaveHeld({ ...state, draft: { ...state.draft, shared: true }, mayShare: false })).toBe('tpl.replies.held.share')
    expect(replySaveHeld({ ...state, reply: reply(4), draft: draftOf(reply(4)) })).toBe('tpl.replies.held.sharedNoRight')
    expect(replySaveHeld({ ...state, reply: { ...reply(5), mayChange: false }, draft: draftOf(reply(5)) })).toBe('tpl.replies.held.notYours')
    expect(replySaveHeld({ ...state, busy: true })).toBe('tpl.held.busy')
    expect(replySaveHeld({ ...state, draft: { ...state.draft, body: '{{nope}}' } })).toBe('tpl.held.problems')
    expect(replySaveHeld({ ...state, reply: reply(1), draft: draftOf(reply(1)) })).toBe('tpl.held.nothingChanged')
  })

  it('Delete N reaches only the replies one may change; the others cannot be ticked, said why', () => {
    expect(deleteReach([reply(1), reply(4), reply(5)])).toEqual({ applies: [reply(1), reply(5)], left: 1 })
    expect(replyRowHeld(reply(4))).toBe('tpl.replies.held.sharedNoRight')
    expect(replyRowHeld({ shared: false, mayChange: false })).toBe('tpl.replies.held.notYours')
    expect(replyRowHeld(reply(1))).toBeNull()
  })

  it('the preview fills only the placeholders the record offers, with made-up values (nothing is sent, no real record)', () => {
    const filled = replyPreview({ body: 'Gentile {{contact.name}}, richiesta {{inquiry.number}}; ordine {{order.number}}', language: 'it', record: 'Inquiry' })
    expect(filled).toBe('Gentile Anna Esempio, richiesta INQ-2026-0007; ordine')
    expect(replyPreview({ body: 'Dear {{contact.name}}', language: 'en', record: 'ANY' })).toBe('Dear Ann Example')
  })

  it('the section’s part from the address: the mails Nexus sends, or the saved replies', () => {
    expect(mailPartOf(new URLSearchParams('view=mail&part=replies'))).toBe('replies')
    expect(mailPartOf(new URLSearchParams('view=mail'))).toBe('templates')
    expect(mailPartOf(null)).toBe('templates')
  })

  it('the calls: the list for a company, a new one with its key, a change at the version read, a delete at the version read', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: answer },
      { status: 201, body: { reply: reply(1) } },
      { status: 200, body: { reply: reply(1) } },
      { status: 200, body: { deleted: reply(1).id } },
    ])
    expect((await listSavedReplies(api, { companyId: 'c1' })).replies).toHaveLength(REPLIES.length)
    await createSavedReply(api, { name: 'n', language: 'it', body: 'b', recordType: 'Inquiry', companyId: 'c1', shared: true }, 'key-r1')
    await updateSavedReply(api, reply(1), { name: 'x' })
    expect(await deleteSavedReply(api, reply(1))).toBe(reply(1).id)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/templates/replies?companyId=c1', 'POST /api/templates/replies', `PUT /api/templates/replies/${reply(1).id}`, `DELETE /api/templates/replies/${reply(1).id}?version=${reply(1).version}`])
    expect(calls[1]!.headers.get('idempotency-key')).toBe('key-r1')
    expect(calls[1]!.body).toEqual({ name: 'n', language: 'it', body: 'b', recordType: 'Inquiry', companyId: 'c1', shared: true })
    expect(calls[2]!.body).toEqual({ version: reply(1).version, name: 'x' })
  })
})

// The design cases (with the editor drawn in place) are drawn in mail-templates/replies/replies.vitest.test.ts.
// ---- end B-TH-279
