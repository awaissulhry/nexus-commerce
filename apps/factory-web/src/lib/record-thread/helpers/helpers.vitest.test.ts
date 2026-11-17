import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_BETA } from '../../testing/two-brands'
import { designScreen } from './fixtures'
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
