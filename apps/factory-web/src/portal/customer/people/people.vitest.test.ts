import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../lib/api/client'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { PORTAL_AREAS, portalNavFor } from '../../shell/nav/portal-nav'
import { designScreen as accountScreen } from '../account/fixtures'
import { fetchFactoryPeople } from './api'
import { designScreen } from './fixtures'
import { factoryRowsOf } from './model'

/**
 * owb-po4.3 — People › Your people (order workflow plan § 5 "Customer portal"; design `portalTeam`): the customer's own people from
 * today's team cards, each one's role and what it does; the factory's people for the brand only when the server's read answers;
 * Account keeps the profile, the e-mail settings, the addresses, the company data and the sessions, and its "Your team" card opens
 * Your people. Written, not run (Owner rule: checks at the end).
 */

const KEY = /\b(people|team|state|status|users|role|invite|roleDialog|raise|deactivate|receipt|held|stepUp|dialog|closed|nav|band)\.[a-zA-Z_-]+/
const inFrame = (locale: 'it' | 'en', page: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, page))
const drawPeople = (id: string, locale: 'it' | 'en' = 'en') => inFrame(locale, createElement(designScreen.view, { model: designScreen.cases.find((item) => item.id === id)!.model }))
const drawAccount = (id: string, locale: 'it' | 'en' = 'en') => inFrame(locale, createElement(accountScreen.view, { model: accountScreen.cases.find((item) => item.id === id)!.model }))

describe('owb-po4.3 — Your people', () => {
  it('has its own route and its own row in the menu (People, for every customer person who reads colleagues)', () => {
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]/people/page.tsx'))).toBe(true)
    expect(PORTAL_AREAS.find((area) => area.id === 'people')).toMatchObject({ label: 'nav.people', href: '/people', permission: 'portal.colleagues.view', kinds: ['CUSTOMER'], built: true })
    expect(portalNavFor({ can: (permission) => permission !== 'portal.colleagues.view', kinds: ['CUSTOMER'] }).areas.map((area) => area.id)).not.toContain('people')
    for (const kind of ['SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const) expect(portalNavFor({ can: () => true, kinds: [kind] }).areas.map((area) => area.id), kind).not.toContain('people')
  })

  it('draws the team cards: each person, the role and what the role does; the factory’s people for the brand; the wall in one line', () => {
    const html = drawPeople('admin')
    expect(html).toContain('People of your company')
    expect(html).toContain('What this person does')
    expect(html).toContain('Factory people for your brand')
    expect(html).toContain('Sam Esempio')
    expect(html).toContain('Sales for your brand')
    expect(html).toContain('Nobody of another customer sees them.')
    const it_ = drawPeople('admin', 'it')
    expect(it_).toContain('Le persone della vostra azienda')
    expect(it_).toContain('Le persone della fabbrica per il vostro marchio')
    expect(it_).toContain('Vendite per il vostro marchio')
    expect(it_).not.toContain('Factory people for your brand')
  })

  it('no factory card without the read (not built yet, or it failed); a read that answered with nobody says so', () => {
    expect(drawPeople('factory-not-read')).not.toContain('Factory people for your brand')
    const none = drawPeople('factory-none')
    expect(none).toContain('Factory people for your brand')
    expect(none).toContain('The factory gave nobody to your brand yet.')
  })

  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(20)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = drawPeople(entry.id, locale)
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the factory people read: its own address and schema — a name, role words and a picture only (no phone, e-mail or team kept)', async () => {
    const calls: string[] = []
    const api = {
      get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => {
        calls.push(path)
        return options.schema.parse({
          people: [{ id: 'p1', name: 'Sam Esempio', role: { en: 'Sales for your brand', it: 'Vendite per il vostro marchio' }, picture: { kind: 'SOMETHING', icon: null, colour: 'blue' }, phone: '+39 000 000', email: 'sam@factory.example', team: 'Cutting A' }],
        })
      },
    } as unknown as ApiClient
    const answer = await fetchFactoryPeople(api)
    expect(calls).toEqual(['/portal/factory-people'])
    expect(JSON.stringify(answer)).not.toMatch(/phone|email|team|Cutting/)
    // An unknown picture kind falls back to letters, never a hole.
    expect(factoryRowsOf(answer, 'en')).toEqual([{ id: 'p1', name: 'Sam Esempio', role: 'Sales for your brand', picture: { kind: 'LETTERS', icon: null, colour: 'blue', letters: null } }])
    expect(factoryRowsOf(answer, 'it')![0]!.role).toBe('Vendite per il vostro marchio')
    expect(factoryRowsOf({ people: [{ id: 'p2', name: 'Dina', role: { en: 'Designer', it: 'Designer' } }] }, 'en')![0]!.picture).toEqual({ kind: 'LETTERS', icon: null, colour: null, letters: null })
    expect(factoryRowsOf(null, 'en')).toBeNull()
  })

  it('the words: every Your people key in both languages, the portal’s "voi" in Italian', () => {
    const keys = ['people.title', 'people.ours', 'people.factory.title', 'people.factory.who', 'people.factory.none', 'people.wall', 'people.closed', 'people.moved', 'people.open', 'users.col.does']
    for (const locale of ['it', 'en'] as const) expect(keys.filter((key) => !(key in (CATALOGUE[locale]['portal-account'] ?? {}))), locale).toEqual([])
    expect(CATALOGUE.it['portal-account']?.['people.title']).toBe('Le vostre persone')
    expect(CATALOGUE.it.portal?.['nav.people']).toBe('Persone')
  })
})

describe('owb-po4.3 — Account keeps the profile, the e-mails, the addresses, the company data, the sessions; its team card opens Your people', () => {
  it('the "Your team" card points to Your people (the list itself is not on Account any more)', () => {
    const html = drawAccount('admin')
    expect(html).toContain('Your colleagues, their roles and invitations are on Your people.')
    expect(html).toMatch(/<a[^>]*href="\/p\/BRAND-ALPHA\/people"[^>]*>Open Your people<\/a>/)
    expect(html).not.toContain('What this person does')
    expect(html).not.toContain('Luca Bianchi')
    // Account keeps its own cards.
    expect(html).toContain('Delivery addresses')
    expect(html).toContain('My profile')
  })

  it('no link while Your people is not built — the words only (never a door to nowhere)', () => {
    const html = drawAccount('people-not-built')
    expect(html).toContain('Your colleagues, their roles and invitations are on Your people.')
    expect(html).not.toContain('Open Your people')
  })
})
