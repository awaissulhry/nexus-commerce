import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../lib/api/client'
import { createTranslator, catalogueFor, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { setEveryCustomer, setExtra, setGiven, type ByCustomer } from './api'
import { bulkStepOf, customersOfPerson, givenSetOf, nextGiven, withEvery, withExtra, withTick } from './model'
import { PeopleCards } from './PeopleByCustomerPage'

const t = createTranslator('en', catalogueFor('en', 'people-by-customer', 'office'))
const given = (partyId: string, userId: string) => ({ partyId, userId, since: '2026-11-20T09:00:00Z', byName: 'Olga Owner' })

const READ: ByCustomer = {
  people: [
    { userId: 'u1', name: 'Sam Sales', roleWords: 'Sales', extra: [] },
    { userId: 'u2', name: 'Dina Designer', roleWords: 'Designer', extra: ['PRINT_AND_START'] },
  ],
  customers: [
    { partyId: 'p1', code: 'C-ALPHA', name: 'Alpha Racing' },
    { partyId: 'p2', code: 'C-BETA', name: 'Beta Moto' },
  ],
  given: [given('p1', 'u1'), given('p2', 'u2')],
  may: { write: true },
}

/** A client that records each call and answers what the test gives it. */
function recording(answer: unknown): { api: ApiClient; calls: Array<{ method: string; path: string; body: unknown }> } {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const request = async (method: string, path: string, options?: { body?: unknown }) => {
    calls.push({ method, path, body: options?.body })
    return answer
  }
  const api = { request, get: (path: string, options?: { body?: unknown }) => request('GET', path, options), post: (path: string, options?: { body?: unknown }) => request('POST', path, options) } as unknown as ApiClient
  return { api, calls }
}

describe('owb-of4 step 3 — People by customer', () => {
  it('a tick calls PUT with given true for a person not given yet, and false for one given', async () => {
    const set = givenSetOf(READ.given)
    expect(nextGiven(set, 'p2', 'u1')).toBe(true)
    expect(nextGiven(set, 'p1', 'u1')).toBe(false)
    const { api, calls } = recording({ given: [] })
    await setGiven(api, 'p2', 'u1', nextGiven(set, 'p2', 'u1'))
    await setGiven(api, 'p1', 'u1', nextGiven(set, 'p1', 'u1'))
    expect(calls).toEqual([
      { method: 'PUT', path: '/people/by-customer/p2/u1', body: { given: true } },
      { method: 'PUT', path: '/people/by-customer/p1/u1', body: { given: false } },
    ])
  })

  it('"Take out for every customer…" asks before it calls; "Give to every customer" runs at once; a reader without write gets nothing', () => {
    expect(bulkStepOf('takeOut', ['u1', 'u2'], READ.given, true)).toEqual({ kind: 'ask', userIds: ['u1', 'u2'], rows: 2 })
    expect(bulkStepOf('give', ['u1'], READ.given, true)).toEqual({ kind: 'run', given: true, userIds: ['u1'] })
    expect(bulkStepOf('give', ['u1'], READ.given, false)).toEqual({ kind: 'none' })
    expect(bulkStepOf('takeOut', [], READ.given, true)).toEqual({ kind: 'none' })
  })

  it('every customer and the extra rights call their own routes with their bodies', async () => {
    const { api, calls } = recording({ given: [] })
    await setEveryCustomer(api, 'u1', false)
    const extra = recording({ person: { userId: 'u1', extra: ['PACK_AND_SEND'] } })
    await setExtra(extra.api, 'u1', 'PACK_AND_SEND', true)
    expect(calls).toEqual([{ method: 'POST', path: '/people/by-customer/every-customer', body: { userId: 'u1', given: false } }])
    expect(extra.calls).toEqual([{ method: 'PUT', path: '/people/by-customer/extra/u1', body: { right: 'PACK_AND_SEND', on: true } }])
  })

  it('answers land in place: a tick, every customer (keeps the rows it had), an extra right', () => {
    expect(givenSetOf(withTick(READ, 'p2', 'u1', true, [given('p2', 'u1')]).given).has('p2:u1')).toBe(true)
    expect(givenSetOf(withTick(READ, 'p1', 'u1', false, [given('p1', 'u1')]).given).has('p1:u1')).toBe(false)
    expect(customersOfPerson(withEvery(READ, 'u1', true, [given('p2', 'u1')]), 'u1').map((customer) => customer.partyId)).toEqual(['p1', 'p2'])
    expect(customersOfPerson(withEvery(READ, 'u2', false, []), 'u2')).toEqual([])
    expect(withExtra(READ, { person: { userId: 'u1', extra: ['ALLOW_PRODUCTION'] } }).people[0]?.extra).toEqual(['ALLOW_PRODUCTION'])
  })
})

describe('owb-of4 step 4 — the phone: one card per person, its customers as chips', () => {
  it('draws a card per person with the customers it works for and its extra rights', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['people-by-customer']) }, createElement(PeopleCards, { read: READ, write: true, selected: [], onSelect: () => undefined, t })))
    expect(html.match(/class="fw-pbc-card"/g)).toHaveLength(2)
    expect(html).toContain('Alpha Racing')
    expect(html).toContain('Print and start')
    expect(html).not.toContain('ag-root')
  })
})
