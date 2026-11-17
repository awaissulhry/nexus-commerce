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
// B-TH-287: the New order draft on the server.
import { draftSaver, fromServerDraft, keptLineOf, newerDraft, serverDraftBody, type ServerDraftBody } from './server-draft'

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

// ── B-TH-221: the office's New request draws the same compose in its own place and voice ──
describe('the compose in the office (B-TH-221)', () => {
  const office = (view: RequestComposeModel, slots: Parameters<typeof RequestCompose>[0]['slots'], label?: (key: string) => string | null) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'en', messages: messagesFor('en', [COMPOSE_NS, 'ds-words']) },
        createElement(RequestCompose, { model: view, words: { day: (iso: string) => iso, ...(label ? { label } : {}) }, to: createElement('fieldset', { 'data-office-from': true }, 'From: a customer'), slots }),
      ),
    )

  it('the portal draws as before when no slot is given: its card, the held files sentence, Send', () => {
    const html = render('en', model('en'))
    expect(html).toContain('nds-card')
    expect(html).toContain('Discard draft')
    expect(html).toContain('>Send<')
  })

  it('plain: no card and no Send row (the dialog sends); the office’s From in the To place, its files and details in theirs', () => {
    const html = office(model('en', { goesTo: null }), { plain: true, files: createElement('div', { 'data-office-files': true }, 'Drop files'), details: createElement('div', { 'data-office-details': true }, 'Target price') })
    expect(html).toContain('data-office-from')
    expect(html).not.toContain('Goes to')
    expect(html).toContain('data-office-files')
    expect(html).not.toContain('Uploads from outside are closed')
    expect(html).toContain('data-office-details')
    expect(html).not.toContain('Discard draft')
    expect(html).not.toContain('>Send<')
    expect(html).not.toContain('nds-card')
  })

  it('the office’s voice replaces the labels that speak to the customer, and only those', () => {
    const voice = (key: string) => (key === 'message.label' ? 'What they asked' : key === 'details.ref' ? 'Their PO' : null)
    const html = office(model('en', { goesTo: null }), { plain: true }, voice)
    expect(html).toContain('What they asked')
    expect(html).toContain('Their PO')
    expect(html).not.toContain('Your message')
    expect(html).toContain('Subject (optional)')
  })
})


// ---- B-TH-287 (threads plan TH-9, N6; P-CUS-NEW.message-F02; wall W08, W37): the portal's New order on the server -------------------
describe('B-TH-287 — the New order draft on the server', () => {
  const view = (over: Partial<{ body: string; fields: Record<string, unknown>; savedAt: string; version: number }> = {}) => ({
    body: BRAND_BETA.message,
    fields: { subject: 'Rain jackets', customerRef: BRAND_BETA.customerRef, wantedDate: '2026-12-01', shipToAddressId: 'a1' },
    savedAt: '2026-11-17T09:42:00.000Z',
    version: 3,
    ...over,
  })

  it('reads the server’s draft as the compose holds it (the message is its words); a bad day is dropped; nothing typed is no draft', () => {
    expect(fromServerDraft(view())).toEqual({ draft: { subject: 'Rain jackets', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef, wantedDate: '2026-12-01', shipToAddressId: 'a1' }, savedAt: Date.parse('2026-11-17T09:42:00.000Z'), version: 3 })
    expect(fromServerDraft(view({ fields: { wantedDate: '1 December', subject: 5 } }))?.draft).toEqual({ ...EMPTY_COMPOSE, message: BRAND_BETA.message })
    expect(fromServerDraft(view({ body: '', fields: {} }))).toBeNull()
    expect(fromServerDraft(null)).toBeNull()
  })

  it('the body names no person, party or company (the API takes them from the session): the typed fields and the version read', () => {
    const body = serverDraftBody(typed({ customerRef: BRAND_BETA.customerRef }), 4)
    expect(body).toEqual({ audience: null, body: BRAND_BETA.message, fields: { subject: 'Rain jackets', customerRef: BRAND_BETA.customerRef, wantedDate: '', shipToAddressId: '' }, version: 4 })
    expect(Object.keys(body)).not.toContain('partyId')
    expect(JSON.stringify(body)).not.toMatch(/partyId|userId|companyId|person/)
    expect(serverDraftBody(typed(), null)).not.toHaveProperty('version')
  })

  it('opens with the newer copy (the same moment: the server’s); a device copy the server no longer keeps is forgotten', () => {
    const server = { draft: typed({ subject: 'From the server' }), savedAt: 2_000, version: 2 }
    const device = { draft: typed({ subject: 'From this device' }), savedAt: 1_000 }
    expect(newerDraft(server, device, true)).toMatchObject({ source: 'server', draft: { subject: 'From the server' }, forget: false })
    expect(newerDraft(server, { ...device, savedAt: 3_000 }, true)).toMatchObject({ source: 'device', draft: { subject: 'From this device' } })
    expect(newerDraft(server, { ...device, savedAt: 2_000 }, true)?.source).toBe('server')
    expect(newerDraft(null, device, true)).toMatchObject({ source: 'device', forget: false })
    // Saved on the server once, and the server — read without a fault — keeps none: sent or discarded on another computer.
    expect(newerDraft(null, { ...device, onServer: true }, true)).toMatchObject({ forget: true })
    // The server could not be read: this device's copy stays.
    expect(newerDraft(null, { ...device, onServer: true }, false)).toMatchObject({ source: 'device', forget: false })
    expect(newerDraft(null, null, true)).toBeNull()
  })

  it('the device copy remembers that the server had the same words', () => {
    const storage = memory()
    const key = composeDraftKey('person-1', BRAND_BETA.code)
    expect(writeKeptCompose(storage, key, typed(), 5_000, true)).toEqual({ draft: typed(), savedAt: 5_000, onServer: true })
    expect(readKeptCompose(storage, key, 6_000)).toEqual({ draft: typed(), savedAt: 5_000, onServer: true })
    writeKeptCompose(storage, key, typed({ subject: 'Typed since' }), 7_000)
    expect(readKeptCompose(storage, key, 8_000)?.onServer).toBeUndefined()
  })

  it('the line under the message: saved, replaced, not saved (and whether the text stays here), else the device’s own line', () => {
    const time = () => '10:42'
    expect(keptLineOf({ state: 'saved', at: 1, replaced: false }, { state: 'none' }, time)).toEqual({ state: 'saved', at: '10:42', replaced: false })
    expect(keptLineOf({ state: 'failed' }, { state: 'kept', at: '10:40' }, time)).toEqual({ state: 'notSaved', device: true })
    expect(keptLineOf({ state: 'failed' }, { state: 'failed' }, time)).toEqual({ state: 'notSaved', device: false })
    expect(keptLineOf({ state: 'idle' }, { state: 'kept', at: '10:40' }, time)).toEqual({ state: 'kept', at: '10:40' })
  })

  it('draws “Draft saved 10:42”, the newest-wins warning and “Not saved · Retry” in Italian and English', () => {
    const KEY = /\b(?:kept)\.[a-zA-Z_]+\b/
    const cases: Array<[RequestComposeModel['kept'], { en: string[]; it: string[] }]> = [
      [{ state: 'saved', at: '10:42' }, { en: ['Draft saved 10:42'], it: ['Bozza salvata alle 10:42'] }],
      [{ state: 'saved', at: '10:42', replaced: true }, { en: ['Draft saved 10:42', 'A newer draft from another tab or computer was replaced.'], it: ['Bozza salvata alle 10:42', 'È stata sostituita una bozza più recente'] }],
      [{ state: 'notSaved', device: false }, { en: ['Not saved', 'Retry'], it: ['Non salvata', 'Riprova'] }],
      [{ state: 'notSaved', device: true }, { en: ['Not saved — your text stays on this device', 'Retry'], it: ['Non salvata: il testo resta su questo dispositivo', 'Riprova'] }],
    ]
    for (const locale of ['it', 'en'] as const) {
      for (const [kept, expected] of cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, [COMPOSE_NS, 'ds-words']) }, createElement(RequestCompose, { model: model(locale, { kept }), actions: { onRetryKeep: () => undefined }, words: { day: (iso: string) => iso } })))
        for (const text of expected[locale]) expect(html, `${kept.state} (${locale})`).toContain(text)
        expect(html.match(KEY)?.[0] ?? null).toBeNull()
        expect(scanText(html, BRAND_ALPHA)).toEqual([])
      }
      // Offline says so first: the text stays on this device (never a "saved" that was not).
      const offline = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, [COMPOSE_NS, 'ds-words']) }, createElement(RequestCompose, { model: model(locale, { kept: { state: 'saved', at: '10:42' }, offline: true }), words: { day: (iso: string) => iso } })))
      expect(offline).toContain(locale === 'en' ? 'You are offline: your text stays on this device.' : 'Siete offline: il testo resta su questo dispositivo.')
      expect(offline).not.toContain(locale === 'en' ? 'Draft saved' : 'Bozza salvata')
    }
  })

  describe('the saver', () => {
    /** A clock the test moves by hand, and an API whose answers the test lets land one by one. */
    function harness(options: { enabled?: () => boolean } = {}) {
      const timers: Array<{ run: () => void; at: number; id: number } | null> = []
      let now = 0
      const calls: Array<{ kind: 'save'; body: ServerDraftBody } | { kind: 'discard' }> = []
      const waiting: Array<{ resolve: (answer: { savedAt: string; version: number; replacedNewer: boolean }) => void; reject: (error: unknown) => void }> = []
      const saved: Array<{ version: number; replacedNewer: boolean; typedSince: boolean }> = []
      let failed = 0
      let version = 1
      const saver = draftSaver(
        {
          enabled: options.enabled ?? (() => true),
          save: (body) => {
            calls.push({ kind: 'save', body })
            return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
          },
          discard: async () => {
            calls.push({ kind: 'discard' })
          },
          onSaved: (answer) => saved.push({ version: answer.version, replacedNewer: answer.replacedNewer, typedSince: answer.typedSince }),
          onFailed: () => {
            failed += 1
          },
          setTimer: (run, ms) => {
            const id = timers.length
            timers.push({ run, at: now + ms, id })
            return id
          },
          clearTimer: (id) => {
            timers[id as number] = null
          },
        },
        2000,
      )
      const tick = (ms: number) => {
        now += ms
        for (const timer of [...timers]) {
          if (timer && timer.at <= now) {
            timers[timer.id] = null
            timer.run()
          }
        }
      }
      const land = async (replacedNewer = false) => {
        version += 1
        waiting.shift()!.resolve({ savedAt: '2026-11-17T09:42:00.000Z', version, replacedNewer })
        await Promise.resolve()
        await Promise.resolve()
      }
      const refuse = async () => {
        waiting.shift()!.reject(new Error('no answer'))
        await Promise.resolve()
        await Promise.resolve()
      }
      return { saver, calls, saved, tick, land, refuse, failed: () => failed, flying: () => waiting.length }
    }

    it('saves after a pause with the version read, then with the version answered; the newest-wins answer is passed on', async () => {
      const h = harness()
      h.saver.known(1)
      h.saver.typed(typed({ message: 'R' }))
      h.tick(1000)
      h.saver.typed(typed({ message: 'Rain' }))
      h.tick(1999)
      expect(h.calls).toEqual([])
      h.tick(1)
      expect(h.calls).toEqual([{ kind: 'save', body: serverDraftBody(typed({ message: 'Rain' }), 1) }])
      await h.land(true)
      expect(h.saved).toEqual([{ version: 2, replacedNewer: true, typedSince: false }])
      h.saver.typed(typed({ message: 'Rain jackets' }))
      h.tick(2000)
      expect(h.calls[1]).toEqual({ kind: 'save', body: serverDraftBody(typed({ message: 'Rain jackets' }), 2) })
    })

    it('emptied by the person: the server’s copy is removed, not saved empty', async () => {
      const h = harness()
      h.saver.known(5)
      h.saver.typed(EMPTY_COMPOSE)
      h.tick(2000)
      expect(h.calls).toEqual([{ kind: 'discard' }])
      // Nothing on the server: nothing to remove.
      const fresh = harness()
      fresh.saver.typed(EMPTY_COMPOSE)
      fresh.tick(2000)
      expect(fresh.calls).toEqual([])
    })

    it('a save on its way when the request is sent never brings the words back: it is taken back once it lands', async () => {
      const h = harness()
      h.saver.typed(typed())
      h.tick(2000)
      expect(h.flying()).toBe(1)
      h.saver.sending()
      h.saver.sent()
      await h.land()
      expect(h.saved).toEqual([])
      expect(h.calls.map((call) => call.kind)).toEqual(['save', 'discard'])
    })

    it('a save that was on its way when the send started and landed before it went is taken back too', async () => {
      const h = harness()
      h.saver.typed(typed())
      h.tick(2000)
      h.saver.sending()
      await h.land()
      h.saver.sent()
      expect(h.calls.map((call) => call.kind)).toEqual(['save', 'discard'])
    })

    it('nothing saves while the request goes; a failed send lets the words be saved again; a send with nothing on its way removes nothing', async () => {
      const h = harness()
      h.saver.typed(typed())
      h.saver.sending()
      h.tick(5000)
      expect(h.calls).toEqual([])
      h.saver.typed(typed({ message: 'Changed while sending' }))
      h.tick(5000)
      expect(h.calls).toEqual([])
      h.saver.sendFailed()
      h.tick(2000)
      expect(h.calls).toEqual([{ kind: 'save', body: serverDraftBody(typed({ message: 'Changed while sending' }), null) }])
      await h.land()
      h.saver.sending()
      h.saver.sent()
      // The send cleared it on the server itself: no DELETE, and the next draft starts without a version.
      expect(h.calls.map((call) => call.kind)).toEqual(['save'])
      h.saver.typed(typed({ message: 'A new one' }))
      h.tick(2000)
      expect(h.calls[1]).toEqual({ kind: 'save', body: serverDraftBody(typed({ message: 'A new one' }), null) })
    })

    it('Discard draft removes the server’s copy; a save on its way is taken back after it lands', async () => {
      const h = harness()
      h.saver.typed(typed())
      h.tick(2000)
      h.saver.discarded()
      await h.land()
      expect(h.saved).toEqual([])
      expect(h.calls.map((call) => call.kind)).toEqual(['save', 'discard', 'discard'])
    })

    it('offline or a preview saves nothing; back online it saves what waited; a failed save waits for Retry', async () => {
      let online = false
      const h = harness({ enabled: () => online })
      h.saver.typed(typed())
      h.tick(2000)
      expect(h.calls).toEqual([])
      online = true
      h.saver.flush()
      expect(h.calls).toHaveLength(1)
      await h.refuse()
      expect(h.failed()).toBe(1)
      h.saver.flush()
      expect(h.calls).toHaveLength(2)
      expect(h.calls[1]).toEqual(h.calls[0])
    })

    it('typed again while a save was on its way: that one goes next', async () => {
      const h = harness()
      h.saver.typed(typed({ message: 'One' }))
      h.tick(2000)
      h.saver.typed(typed({ message: 'One two' }))
      await h.land()
      expect(h.saved[0]?.typedSince).toBe(true)
      h.tick(2000)
      expect(h.calls[1]).toEqual({ kind: 'save', body: serverDraftBody(typed({ message: 'One two' }), 2) })
    })
  })
})
// ---- end B-TH-287
