import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { listContactLanguages, setContactLanguage, type ContactLanguage } from './api'
import { designScreen } from './fixtures'
import { changeHeld, languageName, ownChoice, setReach, withOwn } from './model'

/**
 * B-W2b-432 — Admin › Languages › per partner contact (SCR-634): the language a contact's documents go out in after their
 * own language changes (as the API works it out), which selected contacts a "set to" reaches, why it waits, the calls
 * (the templates read, the parties' contact write at the version read), and every design case in both languages.
 */

const row: ContactLanguage = {
  contactId: 'k1',
  name: 'Anna Esempio',
  email: 'anna@moda-demo.example.com',
  own: null,
  party: { id: 'p1', code: 'PRT-0001', name: 'Moda Demo S.r.l.', language: 'it' },
  language: 'it',
  source: 'PARTY',
  notOffered: null,
  version: 3,
}

describe('a partner contact’s language', () => {
  it('their own wins over their organisation’s; one we do not write goes out in English', () => {
    expect(withOwn(row, 'en', 4)).toMatchObject({ own: 'en', language: 'en', source: 'CONTACT', notOffered: null, version: 4 })
    expect(withOwn({ ...row, own: 'en' }, null, 5)).toMatchObject({ own: null, language: 'it', source: 'PARTY' })
    expect(withOwn(row, 'de', 4)).toMatchObject({ language: 'en', source: 'CONTACT', notOffered: 'de' })
    expect(ownChoice(row)).toBe('')
  })

  it('a "set to" reaches the selected contacts not so already; it waits without the right', () => {
    const rows = [row, { ...row, contactId: 'k2', own: 'it' }, { ...row, contactId: 'k3', own: 'en' }]
    expect(setReach(rows, 'it').applies.map((entry) => entry.contactId)).toEqual(['k1', 'k3'])
    expect(setReach(rows, '').applies.map((entry) => entry.contactId)).toEqual(['k2', 'k3'])
    expect(changeHeld({ canManage: false }, false)).toBe('tpl.partner.held.manage')
    expect(changeHeld({ canManage: true }, true)).toBe('tpl.held.busy')
    expect(changeHeld({ canManage: true }, false)).toBeNull()
    expect(languageName('de', 'en')).toBe('German')
  })

  it('reads the contacts with the search and the cursor; writes a contact’s language at its version', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = []
    const answers = [
      { contacts: [row], nextCursor: 'n1', languages: ['it', 'en'] },
      { party: { contacts: [{ id: 'k1', version: 4 }] } },
    ]
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const api = createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf' })
    expect((await listContactLanguages(api, { q: ' anna ', cursor: 'c0' })).nextCursor).toBe('n1')
    await setContactLanguage(api, row, 'en').catch(() => undefined)
    expect(calls[0]!.url).toBe('/api/templates/languages/contacts?q=anna&cursor=c0&limit=50')
    expect(`${calls[1]!.method} ${calls[1]!.url}`).toBe('PATCH /api/parties/p1/contacts/k1')
    expect(calls[1]!.body).toEqual({ version: 3, language: 'en' })
  })
})

const LEFT_KEY = /\b(?:tpl|langs|problem|common|list)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-634 draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('without parties.view the part says what it needs', () => {
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases.find((item) => item.id === 'no-right')!.model })))
    expect(html).toContain('need the right to see customers and suppliers')
  })
})
