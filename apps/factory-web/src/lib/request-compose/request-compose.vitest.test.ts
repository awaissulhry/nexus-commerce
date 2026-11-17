import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PORTAL_REQUEST_LIMITS, requestProblems } from '@nexus/factory-domain/sales/portal-requests/rules'
import { CATALOGUE, createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { scanText } from '../testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../testing/two-brands'
import {
  composeDraftKey,
  COMPOSE_LIMITS,
  COMPOSE_NS,
  counterLimit,
  detailsSummary,
  EMPTY_COMPOSE,
  fieldOfIssue,
  fingerprintOf,
  problemsOf,
  readKeptCompose,
  readLastSent,
  sameAsLast,
  sendBodyOf,
  sendHeld,
  subjectUsed,
  typedIn,
  writeKeptCompose,
  writeLastSent,
  type ComposeDraft,
} from './model'
import { RequestCompose, type RequestComposeModel } from './view/RequestCompose'

/**
 * B-TH-220 — the request written like an e-mail, shared by the portal's New order and (B-TH-221) the office's New request: what
 * holds Send, the body the API takes (never a party, a company or a person: the session's, W11), the limits the API checks,
 * the draft kept on this device, the same words twice, and the view: ONE fixed "Goes to" line and no To field, the files'
 * place held with the API's own sentence, the details folded, every word in Italian and English, nothing of another brand.
 */

const TODAY = '2026-11-17'
const FACTS = { preview: false, offline: false, sending: false, closed: false }
const typed = (over: Partial<ComposeDraft> = {}): ComposeDraft => ({ ...EMPTY_COMPOSE, subject: 'Rain jackets', message: BRAND_BETA.message, ...over })

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('what holds Send, in words', () => {
  it('nothing written, a day in the past, a PO too long, offline, sending, a preview, a company that takes no request', () => {
    expect(sendHeld(EMPTY_COMPOSE, TODAY, FACTS)).toBe('held.empty')
    expect(sendHeld(typed({ message: '   \n ' }), TODAY, FACTS)).toBe('held.empty')
    expect(sendHeld(typed(), TODAY, FACTS)).toBeNull()
    expect(sendHeld(typed({ wantedDate: '2026-11-16' }), TODAY, FACTS)).toBe('held.problems')
    expect(sendHeld(typed({ wantedDate: TODAY }), TODAY, FACTS)).toBeNull()
    expect(sendHeld(typed({ customerRef: 'x'.repeat(COMPOSE_LIMITS.customerRef + 1) }), TODAY, FACTS)).toBe('held.problems')
    expect(sendHeld(typed(), TODAY, { ...FACTS, offline: true })).toBe('held.offline')
    expect(sendHeld(typed(), TODAY, { ...FACTS, sending: true })).toBe('held.sending')
    expect(sendHeld(typed(), TODAY, { ...FACTS, preview: true })).toBe('held.preview')
    expect(sendHeld(typed(), TODAY, { ...FACTS, closed: true })).toBe('held.closed')
  })

  it('checks the limits as the API does (factory-domain portal-requests)', () => {
    const long = typed({ subject: 'S', message: 'm'.repeat(PORTAL_REQUEST_LIMITS.message - 2) })
    expect(problemsOf(long, TODAY).message).toBe('problem.tooLong')
    expect(requestProblems({ subject: long.subject, message: long.message }, TODAY).map((issue) => issue.path)).toEqual(['body/message'])
    const fits = typed({ subject: '', message: 'm'.repeat(PORTAL_REQUEST_LIMITS.message) })
    expect(problemsOf(fits, TODAY)).toEqual({})
    expect(requestProblems({ subject: null, message: fits.message }, TODAY)).toEqual([])
    expect(problemsOf(typed({ wantedDate: '2020-01-01' }), TODAY)).toEqual({ wantedDate: 'problem.datePast' })
  })

  it('shows the counter only near the end of the box (90 %)', () => {
    expect(counterLimit(typed())).toBeNull()
    expect(counterLimit(typed({ subject: '', message: 'm'.repeat(Math.ceil(COMPOSE_LIMITS.message * 0.9)) }))).toBe(COMPOSE_LIMITS.message)
  })

  it('uses the first line when no subject is typed, and cuts a long one with "…"', () => {
    expect(subjectUsed({ subject: '', message: '\n  Forty rain jackets\nsizes S to XL' })).toBe('Forty rain jackets')
    expect(subjectUsed({ subject: '  Spring  ', message: 'x' })).toBe('Spring')
    expect(subjectUsed({ subject: '', message: 'a'.repeat(300) })).toHaveLength(200)
    expect(subjectUsed({ subject: '', message: 'a'.repeat(300) }).endsWith('…')).toBe(true)
  })
})

describe('the body the API takes (W11: the request is the session’s)', () => {
  it('holds only what was typed: never a party, a company, a person or a recipient', () => {
    const body = sendBodyOf(typed({ customerRef: ` ${BRAND_BETA.customerRef} `, wantedDate: '2026-12-20', shipToAddressId: BRAND_BETA.ids.order }))
    expect(Object.keys(body).sort()).toEqual(['customerRef', 'message', 'shipToAddressId', 'subject', 'wantedDate'])
    expect(body.customerRef).toBe(BRAND_BETA.customerRef)
    for (const key of ['partyId', 'party', 'companyId', 'company', 'to', 'recipient', 'contactId', 'userId']) expect(body).not.toHaveProperty(key)
    expect(sendBodyOf(typed({ subject: '  ' }))).toEqual({ message: BRAND_BETA.message })
  })

  it('reads the API’s refusal at a field', () => {
    expect(fieldOfIssue('body/wantedDate')).toBe('wantedDate')
    expect(fieldOfIssue('body.shipToAddressId')).toBe('shipToAddressId')
    expect(fieldOfIssue('request/closed')).toBeNull()
  })
})

describe('the draft kept on this device (until drafts live on the server)', () => {
  it('keeps, reads back and forgets a draft; per person and portal; nothing when storage is closed', () => {
    const storage = memory()
    const key = composeDraftKey('person-1', BRAND_BETA.code)
    expect(key).not.toBe(composeDraftKey('person-2', BRAND_BETA.code))
    expect(key).not.toBe(composeDraftKey('person-1', BRAND_ALPHA.code))
    const kept = writeKeptCompose(storage, key, typed(), 1_000)
    expect(kept).toEqual({ draft: typed(), savedAt: 1_000 })
    expect(readKeptCompose(storage, key, 2_000)?.draft).toEqual(typed())
    expect(readKeptCompose(storage, key, 1_000 + 31 * 86_400_000)).toBeNull()
    expect(writeKeptCompose(storage, key, EMPTY_COMPOSE, 3_000)).toBeNull()
    expect(storage.data.has(key)).toBe(false)
    expect(writeKeptCompose(null, key, typed(), 1)).toBeNull()
    const refusing = { ...memory(), setItem: () => { throw new Error('full') } }
    expect(writeKeptCompose(refusing, key, typed(), 1)).toBe('failed')
    storage.setItem(key, '{broken')
    expect(readKeptCompose(storage, key, 1)).toBeNull()
    expect(typedIn(EMPTY_COMPOSE)).toBe(false)
  })

  it('asks before sending the same words twice within ten minutes', () => {
    const storage = memory()
    const key = 'sent'
    writeLastSent(storage, key, { fingerprint: fingerprintOf(typed()), at: 0, yours: { en: 'Your request 7', it: 'La vostra richiesta 7' } })
    const last = readLastSent(storage, key)
    expect(sameAsLast(typed({ message: `  ${BRAND_BETA.message.toUpperCase()} ` }), last, 9 * 60_000)?.yours?.en).toBe('Your request 7')
    expect(sameAsLast(typed(), last, 11 * 60_000)).toBeNull()
    expect(sameAsLast(typed({ message: 'Something else' }), last, 60_000)).toBeNull()
  })
})

const words = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][COMPOSE_NS] ?? {})

function model(locale: 'it' | 'en', over: Partial<RequestComposeModel> = {}): RequestComposeModel {
  const draft = over.draft ?? typed({ customerRef: BRAND_BETA.customerRef })
  return {
    goesTo: locale === 'it' ? 'Ufficio vendite di Pelletteria Esempio' : 'Sales at Pelletteria Esempio',
    draft,
    today: TODAY,
    problems: {},
    shipTo: { state: 'ready', choices: [{ id: 'a1', label: `Lager, ${BRAND_BETA.address.line1}`, waiting: false, isDefault: true }] },
    detailsOpen: true,
    kept: { state: 'kept', at: '10:42' },
    offline: false,
    readOnly: false,
    sending: false,
    sendHeld: null,
    failed: null,
    same: null,
    filesHeld: words(locale)('files.closed'),
    notice: null,
    ...over,
  }
}

const render = (locale: 'it' | 'en', view: RequestComposeModel) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, [COMPOSE_NS, 'ds-words']) }, createElement(RequestCompose, { model: view, words: { day: (iso: string) => iso } })))

describe('the compose view', () => {
  it('one fixed "Goes to" line and no To field: the session is one company', () => {
    const html = render('en', model('en'))
    expect(html).toContain('Goes to')
    expect(html).toContain('Sales at Pelletteria Esempio')
    expect(html).not.toMatch(/<input[^>]*(name|aria-label)="(to|To|recipient)"/)
    expect(html).not.toMatch(/<select[^>]*>[^]*?Brand Alpha/)
    // Subject, the message, the PO and the delivery address: the only fields (the day wanted is the DS date picker's button).
    expect(html.match(/<(input|textarea|select)\b/g)?.length).toBe(4)
  })

  it('the files’ place says the API’s own sentence while uploads from outside are closed', () => {
    const en = render('en', model('en'))
    expect(en).toContain('Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.')
    expect(en).not.toMatch(/type="file"/)
  })

  it('every state draws in Italian and English with no raw key, and nothing of another brand', () => {
    const KEY = /\b(?:compose|to|subject|message|problem|kept|files|details|same|send|held|state)\.[a-zA-Z_]+\b/
    for (const locale of ['it', 'en'] as const) {
      const t = words(locale)
      for (const view of [
        model(locale),
        model(locale, { draft: EMPTY_COMPOSE, sendHeld: t('held.empty'), detailsOpen: false }),
        model(locale, { problems: { wantedDate: 'problem.datePast', customerRef: 'problem.refLong', message: 'problem.tooLong' } }),
        model(locale, { kept: { state: 'failed' } }),
        model(locale, { offline: true, sendHeld: t('held.offline') }),
        model(locale, { same: { at: '10:40', yours: locale === 'it' ? 'La vostra richiesta 7' : 'Your request 7' } }),
        model(locale, { readOnly: true, sendHeld: t('held.preview') }),
        model(locale, { shipTo: { state: 'error', choices: [] } }),
        model(locale, { shipTo: { state: 'none', choices: [] } }),
        model(locale, { detailsOpen: false }),
      ]) {
        const html = render(locale, view)
        expect(html.match(KEY)?.[0] ?? null, locale).toBeNull()
        expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      }
    }
  })

  it('the folded details say what is in them', () => {
    const t = words('en')
    expect(detailsSummary(typed({ customerRef: 'BETA-1', wantedDate: '2026-12-01', shipToAddressId: 'a1' }), [{ id: 'a1', label: 'Lager', waiting: false, isDefault: true }], { t, day: (iso) => iso })).toBe('Your PO BETA-1 · wanted by 2026-12-01 · to Lager')
    expect(detailsSummary(typed(), [], { t, day: (iso) => iso })).toBeNull()
  })
})
