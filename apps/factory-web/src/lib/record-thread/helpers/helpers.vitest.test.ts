import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_BETA } from '../../testing/two-brands'
import { designScreen } from './fixtures'
// B-TH-236
import { AMOUNT_CURRENCIES, amountBody, amountMinor, amountOffered, amountProblem, floorPriceFound } from './amount'
import { AmountField } from './view/AmountField'
import {
  completeMention,
  DRAFT_DAYS,
  draftKey,
  MAX_MENTIONS,
  mentionAt,
  mentionCandidates,
  mentionsIn,
  mentionSuggestions,
  mentionWarnings,
  readDraft,
  replyGroups,
  writeDraft,
  type MentionPerson,
} from './model'
import { registerMentionTagSource, withMentionTags } from './tags'
import { SavedReplies } from './view/SavedReplies'

/**
 * B-TH-208 — the composer's helpers (T8): @ lists office readers only — never a customer's portal person, never the floor
 * (W08, W34); a person who cannot read the record is warned, never mentioned silently; tagged people first (the production
 * page's T7 supplies the tag through the registry, the thread never imports it); saved replies grouped and filled from
 * THIS record only; the draft kept on this device; every case drawn in it and en.
 */

const KEY_ON_SCREEN = /\b(mention|replies|language|draft|design)\.[a-zA-Z]/

const PEOPLE: MentionPerson[] = [
  { id: 'a', name: 'Alex Demo' },
  { id: 'b', name: 'Bea Esempio' },
  { id: 'c', name: 'Carlo Prova', tag: 'Supervisor' },
  { id: 'd', name: 'Dora Campione', canRead: false },
  { id: 'x', name: 'Bruno Inattivo', active: false },
  { id: 'p', name: BRAND_BETA.portalPerson.name, audience: 'partner' },
  { id: 'f', name: 'Banco Taglio 2', audience: 'floor' },
]

describe('@ mentions', () => {
  it('offers office people only: never a customer’s portal person, never the floor, never an inactive one (W08, W34)', () => {
    const ids = mentionCandidates(PEOPLE).map((person) => person.id)
    expect(ids).not.toContain('p')
    expect(ids).not.toContain('f')
    expect(ids).not.toContain('x')
    expect(mentionSuggestions('', mentionCandidates(PEOPLE), []).map((person) => person.name)).not.toContain(BRAND_BETA.portalPerson.name)
  })

  it('lists tagged people first, and works the same without a tag', () => {
    expect(mentionCandidates(PEOPLE).map((person) => person.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(mentionCandidates(PEOPLE.map(({ tag: _tag, ...person }) => person)).map((person) => person.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('finds the @ word before the caret, suggests by name or a word of it, and completes it', () => {
    const text = 'Please check, @Pro and thanks'
    const caret = 'Please check, @Pro'.length
    expect(mentionAt(text, caret)).toEqual({ query: 'Pro', start: 14 })
    expect(mentionAt('mail@example.com', 16)).toBeNull()
    expect(mentionSuggestions('pro', mentionCandidates(PEOPLE), []).map((person) => person.id)).toEqual(['c'])
    expect(mentionSuggestions('', mentionCandidates(PEOPLE), ['a']).map((person) => person.id)).toEqual(['c', 'b', 'd'])
    expect(completeMention(text, caret, { name: 'Carlo Prova' })).toEqual({ text: 'Please check, @Carlo Prova and thanks', caret: 'Please check, @Carlo Prova '.length })
  })

  it('never mentions a person who cannot read the record silently: warned, not counted', () => {
    const text = 'Thanks @Alex Demo, @Dora Campione and @Mario Esempio'
    expect(mentionsIn(text, PEOPLE)).toEqual(['a'])
    const keys = mentionWarnings(text, mentionCandidates(PEOPLE)).map((warning) => `${warning.key}:${warning.params.name}`)
    expect(keys).toContain('mention.cannotRead:Dora Campione')
    expect(keys).toContain('mention.nobody:Mario Esempio')
    expect(keys).not.toContain('mention.nobody:Alex Demo')
  })

  it('tells at most 20 people and says so', () => {
    const many: MentionPerson[] = Array.from({ length: 22 }, (_, n) => ({ id: `p${n}`, name: `Person N${String.fromCharCode(65 + n)}` }))
    const text = many.map((person) => `@${person.name}`).join(' ')
    expect(mentionsIn(text, many)).toHaveLength(MAX_MENTIONS)
    expect(mentionWarnings(text, many).map((warning) => warning.key)).toContain('mention.tooMany')
  })
})

describe('mention tags from another module', () => {
  let remove: (() => void) | null = null
  afterEach(() => remove?.())

  it('a registered source tags people of its record type only; the API’s own tag wins; a failing source is skipped', () => {
    remove = registerMentionTagSource('WorkOrder', (people) => Object.fromEntries(people.filter((person) => person.name.startsWith('Bea')).map((person) => [person.id, 'Supervisor'])))
    const unregisterBroken = registerMentionTagSource('WorkOrder', () => {
      throw new Error('broken')
    })
    const tagged = withMentionTags({ type: 'WorkOrder', id: 'w1' }, [{ id: 'a', name: 'Alex Demo' }, { id: 'b', name: 'Bea Esempio' }, { id: 'c', name: 'Bea Two', tag: 'Lead' }])
    expect(tagged.map((person) => person.tag ?? null)).toEqual([null, 'Supervisor', 'Lead'])
    expect(withMentionTags({ type: 'SalesOrder', id: 's1' }, [{ id: 'b', name: 'Bea Esempio' }])[0]!.tag).toBeUndefined()
    unregisterBroken()
    remove()
    remove = null
    expect(withMentionTags({ type: 'WorkOrder', id: 'w1' }, [{ id: 'b', name: 'Bea Esempio' }])[0]!.tag).toBeUndefined()
  })
})

describe('saved replies', () => {
  it('groups shared then mine, the customer’s language first, never the reply’s text', () => {
    const groups = replyGroups(
      [
        { id: '1', name: 'Zeta', language: 'it', shared: true },
        { id: '2', name: 'Beta', language: 'en', shared: true },
        { id: '3', name: 'Alfa', language: 'it', shared: true },
        { id: '4', name: 'Mine', language: 'en', shared: false },
      ],
      'it',
      'en',
    )
    expect(groups.shared.map((reply) => reply.id)).toEqual(['3', '1', '2'])
    expect(groups.mine.map((reply) => reply.id)).toEqual(['4'])
  })

  it('picking sends only the reply’s id: the API fills it from THIS record (W34)', () => {
    const picked: string[] = []
    const element = createElement(SavedReplies, { model: { status: 'ready', language: 'en', replies: [{ id: 'r1', name: 'Sample on its way', language: 'en', shared: true }] }, onPick: (replyId: string) => picked.push(replyId) })
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, element))
    expect(html).toContain('Saved replies')
    // The view model carries no party and no record values: there is nothing of another customer to fill with.
    expect(Object.keys((element.props as { model: object }).model)).toEqual(['status', 'language', 'replies'])
  })
})

describe('the draft kept on this device', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) }
  const key = draftKey('p1', { type: 'SalesOrder', id: 's1' }, 'note')
  const now = Date.UTC(2026, 10, 17, 9, 42)

  it('keeps one draft per person, record and audience, forgets an empty one and an old one', () => {
    expect(key).not.toBe(draftKey('p1', { type: 'SalesOrder', id: 's1' }, 'reply'))
    expect(key).not.toBe(draftKey('p2', { type: 'SalesOrder', id: 's1' }, 'note'))
    expect(writeDraft(storage, key, 'Ask the cutting room', now)).toEqual({ text: 'Ask the cutting room', savedAt: now })
    expect(readDraft(storage, key, now + 1000)).toEqual({ text: 'Ask the cutting room', savedAt: now })
    expect(readDraft(storage, key, now + (DRAFT_DAYS + 1) * 86_400_000)).toBeNull()
    writeDraft(storage, key, '  ', now)
    expect(store.has(key)).toBe(false)
    store.set(key, '{not json')
    expect(readDraft(storage, key, now)).toBeNull()
  })

  it('a closed storage keeps nothing and never throws', () => {
    const closed = { getItem: () => { throw new Error('closed') }, setItem: () => { throw new Error('closed') }, removeItem: () => { throw new Error('closed') } }
    expect(readDraft(closed, key, now)).toBeNull()
    expect(writeDraft(closed, key, 'x', now)).toBeNull()
  })
})

describe('the words', () => {
  it('draws every case of SCR-006-helpers with no key on screen, in it and en', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
        expect(html, `${item.id} ${locale}`).not.toContain(BRAND_BETA.portalPerson.name)
      }
    }
  })

  it('the open suggestions are a labelled listbox; a non-reader is marked, tagged people show their tag', () => {
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases[0]!.model })))
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('Supervisor')
    expect(html).toContain('cannot read this record')
    expect(html).toContain('aria-disabled="true"')
  })
})

// ---- B-TH-236 (B-TH-049): the amount field by grain, and the floor's price check (W08, W34: money never in a floor note's words).
describe('B-TH-236: the amount field and the floor’s price check', () => {
  it('the field is offered on an office note to a price reader only (money.price)', () => {
    expect(amountOffered('note', true)).toBe(true)
    expect(amountOffered('note', false)).toBe(false)
    expect(amountOffered('note', undefined)).toBe(false)
    expect(amountOffered('reply', true)).toBe(false)
    expect(amountOffered('portal', true)).toBe(false)
  })

  it('reads the amount in Italian and English numbers, in minor units; anything else is held', () => {
    expect(amountMinor('1.250,00')).toBe(125_000)
    expect(amountMinor('1,250.00')).toBe(125_000)
    expect(amountMinor('1250.5')).toBe(125_050)
    expect(amountMinor('12,5')).toBe(1_250)
    expect(amountMinor('1 250')).toBe(125_000)
    expect(amountMinor('€ 18.450')).toBe(1_845_000)
    expect(amountMinor('')).toBeNull()
    expect(amountMinor('twelve')).toBeNaN()
    expect(amountMinor('12.5.5,1x')).toBeNaN()
    expect(amountProblem('twelve', { forFloor: false })).toEqual({ key: 'amount.invalid' })
    expect(amountProblem('99999999999', { forFloor: false })).toEqual({ key: 'amount.tooLarge' })
    expect(amountProblem('10', { forFloor: true })).toEqual({ key: 'amount.floor' })
    expect(amountProblem('', { forFloor: true })).toBeNull()
    expect(amountProblem(undefined, { forFloor: false })).toBeNull()
  })

  it('what POST …/notes takes: minor units and the currency, or nothing', () => {
    expect(amountBody('1.250,00', 'EUR')).toEqual({ value: 125_000, currency: 'EUR' })
    expect(amountBody('10', undefined)).toEqual({ value: 1_000, currency: 'EUR' })
    expect(amountBody('10', 'eur')).toEqual({ value: 1_000, currency: 'EUR' })
    expect(amountBody('', 'EUR')).toBeNull()
    expect(amountBody('ten', 'EUR')).toBeNull()
    expect(amountBody(undefined, 'EUR')).toBeNull()
    expect(AMOUNT_CURRENCIES[0]).toBe('EUR')
  })

  it('a floor note whose words look like a price is found; an office note is never checked', () => {
    expect(floorPriceFound('Lining at € 4,50 a metre.', true)).toBe('€ 4,50')
    expect(floorPriceFound('costo 12 al pezzo', true)).toBe('costo 12')
    expect(floorPriceFound('Cut 40 pieces, total 120.', true)).toBeNull()
    expect(floorPriceFound('Lining at € 4,50 a metre.', false)).toBeNull()
  })

  it('the field draws its words in it and en, with the hint or the problem', () => {
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(AmountField, { value: '12,50', currency: 'EUR', forFloor: false, onChange: () => undefined, onRemove: () => undefined })))
      expect(html).not.toMatch(/\bamount\.[a-zA-Z]/)
      expect(html).toMatch(/inputmode="decimal"/i)
    }
    const bad = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AmountField, { value: 'ten', currency: 'EUR', forFloor: false, onChange: () => undefined, onRemove: () => undefined })))
    expect(bad).toContain('Write a number with at most two decimals')
    expect(bad).toContain('aria-invalid="true"')
  })
})
// ---- end B-TH-236

// ---- B-TH-287 (B-TH-092 drafts on the server, B-TH-098 languages) and B-TH-289 (B-TH-096 "Remind me in 3 days if no answer") --------
import { MESSAGE_LANGUAGES } from '@nexus/factory-domain/templates/message-languages'
import { FOLLOW_UP_DAYS, followUpAt, followUpOffered, REPLY_LANGUAGES, replyLanguageOf } from './model'
import { DraftLine } from './view/SavedReplies'
import { FollowUpTick } from './view/FollowUp'
import { render as drawAll, textOf } from '../parts/testing'

describe('B-TH-287 — saved replies in five languages, the draft line on the server', () => {
  it('lists the five languages written to a customer (never more, never a machine-translated one)', () => {
    expect([...REPLY_LANGUAGES]).toEqual([...MESSAGE_LANGUAGES])
    expect(REPLY_LANGUAGES).toEqual(['it', 'en', 'de', 'fr', 'es'])
    expect(replyLanguageOf('de')).toBe('de')
    expect(replyLanguageOf('pt')).toBeNull()
    expect(replyLanguageOf(null)).toBeNull()
  })

  it('puts the customer’s language first among German, French and Spanish replies too', () => {
    const lines = [
      { id: 'a', name: 'Quote follow-up', language: 'en' as const, shared: true },
      { id: 'b', name: 'Angebot nachfassen', language: 'de' as const, shared: true },
      { id: 'c', name: 'Relance devis', language: 'fr' as const, shared: false },
    ]
    expect(replyGroups(lines, 'de', 'en').shared.map((line) => line.id)).toEqual(['b', 'a'])
    expect(replyGroups(lines, 'fr', 'en').mine.map((line) => line.id)).toEqual(['c'])
    for (const locale of LOCALES) {
      const html = drawAll(createElement(SavedReplies, { model: { status: 'ready', replies: lines, language: 'de' } }), locale)
      expect(textOf(html)).not.toMatch(/\blanguage\.[a-z]/)
    }
  })

  it('the draft line says where the draft is: “Draft saved 10:42”, saving, “Not saved · Retry”, offline, replaced — in it and en', () => {
    const at = '2026-11-17T09:42:00.000Z'
    for (const locale of LOCALES) {
      const saved = textOf(drawAll(createElement(DraftLine, { draft: null, saved: { state: 'saved', at }, timeZone: 'Europe/Rome' }), locale))
      expect(saved).toContain(locale === 'en' ? 'Draft saved 10:42' : 'Bozza salvata alle 10:42')
      const failed = drawAll(createElement(DraftLine, { draft: null, saved: { state: 'failed' }, onRetry: () => undefined }), locale)
      expect(textOf(failed)).toContain(locale === 'en' ? 'Not saved' : 'Non salvata')
      expect(textOf(failed)).toContain(locale === 'en' ? 'Retry' : 'Riprova')
      expect(textOf(drawAll(createElement(DraftLine, { draft: null, saved: { state: 'offline' } }), locale))).toContain(locale === 'en' ? 'You are offline' : 'Sei offline')
      expect(textOf(drawAll(createElement(DraftLine, { draft: null, saved: { state: 'replaced', at } }), locale))).toContain(locale === 'en' ? 'a newer draft' : 'una bozza più recente')
      for (const state of [{ state: 'saving' as const }]) expect(textOf(drawAll(createElement(DraftLine, { draft: null, saved: state }), locale))).not.toMatch(/\bdraft\.[a-z]/)
    }
    // Without a server state the device line stays (as before N6); with neither, nothing.
    expect(textOf(drawAll(createElement(DraftLine, { draft: { text: 'x', savedAt: Date.UTC(2026, 10, 17, 9, 42) }, timeZone: 'Europe/Rome' })))).toContain('Draft kept on this device')
    expect(drawAll(createElement(DraftLine, { draft: null }))).toBe('')
  })
})

describe('B-TH-289 — “Remind me in 3 days if no answer”', () => {
  it('is offered on a message to the customer only (a reply or the portal), never on an office note, and held offline', () => {
    expect(followUpOffered('reply', { remind: true })).toBe(true)
    expect(followUpOffered('portal', { remind: true })).toBe(true)
    expect(followUpOffered('note', { remind: true })).toBe(false)
    expect(followUpOffered('reply', { remind: false })).toBe(false)
    expect(followUpOffered('reply', { remind: true, offline: true })).toBe(false)
  })

  it('comes back three days after the send', () => {
    expect(FOLLOW_UP_DAYS).toBe(3)
    expect(followUpAt(Date.UTC(2026, 10, 17, 10, 0))).toBe('2026-11-20T10:00:00.000Z')
  })

  it('the tick says who stops it (only the customer’s answer), held with why, in it and en', () => {
    for (const locale of LOCALES) {
      const html = drawAll(createElement(FollowUpTick, { model: { on: true, held: null, party: BRAND_BETA.tradeName } }), locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? 'Remind me in 3 days if no answer' : 'Ricordamelo tra 3 giorni se non rispondono')
      expect(text).toContain(BRAND_BETA.tradeName)
      expect(html).toContain('checked')
      const held = drawAll(createElement(FollowUpTick, { model: { on: true, held: { key: 'followUp.offline' }, party: BRAND_BETA.tradeName } }), locale)
      expect(held).toContain('disabled')
      expect(held).not.toContain('checked=""')
      expect(textOf(held)).not.toMatch(/\bfollowUp\.[a-z]/)
    }
  })
})
// ---- end B-TH-287 / B-TH-289
