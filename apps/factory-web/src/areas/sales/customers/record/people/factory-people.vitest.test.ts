import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { ORDER_FLOW_NS } from '../../../orders/record/flow-words'
import { FactoryPeopleCard } from '../view/people/FactoryPeopleCard'
import { factoryPeopleOf, type ByCustomerRead } from './factory-people'

/**
 * owb-of7 step 3 — the customer page parts: the card "Factory people" lists the people given to THIS customer (owb-of2's read); the door
 * to People by customer only for who may write it (owner / admin) — none for sales; the base's CustomerStructurePart stays where the base
 * mounted it (Terms & requirements). Written, not run (Owner rule).
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['orders', 'stock']) }, node))
const READ: ByCustomerRead = {
  people: [{ userId: 'u-1', name: 'Bea Esempio', roleWords: 'Sales', extra: [] }, { userId: 'u-2', name: 'Dario Prova', roleWords: 'Factory designer', extra: ['ALLOW_PRODUCTION'] }],
  customers: [{ partyId: 'p-1', code: 'SEED', name: 'Seed Racing' }, { partyId: 'p-2', code: 'ALPHA', name: 'Brand Alpha' }],
  given: [{ partyId: 'p-1', userId: 'u-2', since: '2026-11-01T09:00:00Z', byName: 'Otto' }, { partyId: 'p-1', userId: 'u-1', since: '2026-11-02T09:00:00Z', byName: 'Otto' }, { partyId: 'p-2', userId: 'u-1', since: '2026-11-03T09:00:00Z', byName: 'Otto' }],
  may: { write: false },
}

describe('owb-of7 step 3: the card lists the given people; no door for sales', () => {
  it('only this customer\'s given people, by name, once each', () => {
    const card = factoryPeopleOf(READ, 'p-1')
    expect(card.people.map((person) => person.name)).toEqual(['Bea Esempio', 'Dario Prova'])
    expect(factoryPeopleOf(READ, 'p-2').people.map((person) => person.name)).toEqual(['Bea Esempio'])
    expect(factoryPeopleOf(READ, 'p-9').people).toEqual([])
  })
  it('sales (may.write false): the names, no door; the owner / admin: the door to People by customer', () => {
    const sales = html(createElement(FactoryPeopleCard, { card: factoryPeopleOf(READ, 'p-1'), prefix: '/w/demo' }))
    expect(sales).toContain('Bea Esempio')
    expect(sales).toContain('Factory designer')
    expect(sales).not.toContain('/people/by-customer')
    const admin = html(createElement(FactoryPeopleCard, { card: factoryPeopleOf({ ...READ, may: { write: true } }, 'p-1'), prefix: '/w/demo' }))
    expect(admin).toContain('/w/demo/people/by-customer')
    expect(html(createElement(FactoryPeopleCard, { card: { people: [], door: false }, prefix: '/w/demo' }))).toContain('Nobody of the factory is given to this customer yet.')
  })
  it('the People tab draws it after People; the base\'s structure part stays on Terms; words in English and Italian', () => {
    expect(read('../view/people/PeopleTab.tsx')).toContain('{factory}')
    expect(read('../CustomerRecord.tsx')).toContain("const factoryPeople = useFactoryPeople(api, partyId, tab === 'people')")
    expect(read('../view/terms/TermsTab.tsx')).toContain('<CustomerStructurePart ')
    for (const locale of LOCALES) for (const key of ['factoryPeople.title', 'factoryPeople.count_one', 'factoryPeople.count_other', 'factoryPeople.door', 'factoryPeople.info', 'factoryPeople.none', 'factoryPeople.since']) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
