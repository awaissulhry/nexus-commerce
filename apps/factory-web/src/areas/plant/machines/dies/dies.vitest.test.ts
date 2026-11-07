import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DIE_CONDITIONS, DIE_REFUSALS, DIE_ROWS } from '@nexus/factory-domain/plant/machines/dies'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { createDie, findDieStyles, listDies, retireDie, updateDie } from './api'
import { DIES, designScreen } from './fixtures'
import { blankDieDraft, createBodyOf, csvRows, dieCan, dieDraftHeld, dieProblemOf, diesAddressOf, diesFiltered, diesQuery, rackChange, retireHeldOf, withDiesAddress } from './model'

/**
 * Plant › Machines & tools › Clicking dies (SCR-150-dies; B-W2b-136 on its own API, modules/plant/dies): the pure rules
 * (the section's own address terms, the saved rows ⇄ the API's conditions, New die and why Create waits, a refusal in the
 * section's words, the inline rack, the CSV), the calls as the API takes them, and every design case in both languages
 * with no key and no placeholder left on screen.
 */

const params = (text: string) => new URLSearchParams(text)

describe('the section\'s address and the API\'s filters', () => {
  it('reads and writes only its own terms (dq, drows, dnew), keeping the page\'s', () => {
    expect(diesAddressOf(params('section=dies&dq=FD&drows=worn&dnew=1'))).toEqual({ q: 'FD', rows: 'worn', isNew: true })
    expect(diesAddressOf(params('drows=nonsense'))).toEqual({ q: '', rows: 'inUse', isNew: false })
    expect(withDiesAddress('?section=dies&site=s1&dq=old', { q: ' rack ', rows: 'retired', isNew: false })).toBe('?section=dies&site=s1&dq=rack&drows=retired')
    expect(withDiesAddress('section=dies', { q: '', rows: 'inUse', isNew: true })).toBe('?section=dies&dnew=1')
    expect(withDiesAddress('dq=x', { q: '', rows: 'inUse', isNew: false })).toBe('')
  })

  it('a saved row is the API\'s conditions; in use never lists retired dies', () => {
    expect(diesQuery({ q: '', rows: 'inUse' }, 's1')).toEqual({ siteId: 's1', condition: ['GOOD', 'WORN', 'DAMAGED'] })
    expect(diesQuery({ q: ' manica ', rows: 'worn' }, null)).toEqual({ siteId: null, condition: ['WORN', 'DAMAGED'], q: 'manica' })
    expect(diesQuery({ q: '', rows: 'all' }, null).condition).toEqual([...DIE_CONDITIONS])
    expect(diesFiltered({ q: '', rows: 'inUse' })).toBe(false)
    expect(diesFiltered({ q: '', rows: 'retired' })).toBe(true)
  })
})

describe('what a person may do', () => {
  const keeper = dieCan(['plant.view', 'plant.machines.manage', 'parties.view'])
  const owner = dieCan(['plant.view', 'plant.machines.manage', 'money.cost'])

  it('New die waits for the site, the number, the style, the piece, and a cost it can read', () => {
    const style = { id: 'st', code: 'S', name: 'Style', sizes: ['50'] }
    expect(dieDraftHeld(blankDieDraft('s1'), dieCan(['plant.view']))).toBe('held.noManage')
    expect(dieDraftHeld(blankDieDraft(null), keeper)).toBe('held.siteNeeded')
    expect(dieDraftHeld(blankDieDraft('s1'), keeper)).toBe('held.codeNeeded')
    expect(dieDraftHeld({ ...blankDieDraft('s1'), code: 'fd 1' }, keeper)).toBe('held.styleNeeded')
    expect(dieDraftHeld({ ...blankDieDraft('s1'), code: 'FD#1', style }, keeper)).toBe('held.codeNeeded')
    expect(dieDraftHeld({ ...blankDieDraft('s1'), code: 'FD-1', style }, keeper)).toBe('held.pieceNeeded')
    expect(dieDraftHeld({ ...blankDieDraft('s1'), code: 'FD-1', style, piece: 'Manica', cost: '12,3,4' }, owner)).toBe('held.costBad')
    expect(dieDraftHeld({ ...blankDieDraft('s1'), code: 'FD-1', style, piece: 'Manica', cost: '12,3,4' }, keeper)).toBeNull()
  })

  it('the body sends the number stamped, every size as none, and the cost only with the grain', () => {
    const draft = { ...blankDieDraft('s1'), code: ' fd 9 ', style: { id: 'st', code: 'S', name: 'Style', sizes: ['50'] }, piece: ' Manica ', rackLocation: ' R2 ', cost: '12,50', supplier: { id: 'p1', code: 'P1', legalName: 'P' } }
    expect(createBodyOf(draft, owner)).toEqual({ siteId: 's1', code: 'FD9', styleId: 'st', piece: 'Manica', rackLocation: 'R2', supplierId: 'p1', purchaseCost: 1250 })
    expect(createBodyOf({ ...draft, size: '50' }, keeper)).toEqual({ siteId: 's1', code: 'FD9', styleId: 'st', piece: 'Manica', size: '50', rackLocation: 'R2', supplierId: 'p1' })
  })

  it('a rack typed inline sends only a change; blank clears it', () => {
    expect(rackChange({ rackLocation: 'R1' }, ' R1 ')).toBeUndefined()
    expect(rackChange({ rackLocation: 'R1' }, 'R2')).toBe('R2')
    expect(rackChange({ rackLocation: 'R1' }, '  ')).toBeNull()
    expect(rackChange({ rackLocation: null }, '')).toBeUndefined()
  })

  it('a retired die is never retired again', () => {
    expect(retireHeldOf(DIES.retired)).toBe('held.alreadyRetired')
    expect(retireHeldOf(DIES.front50)).toBeNull()
  })
})

describe('a failure in the section\'s words', () => {
  it('a refusal by its code; a field; else the kind', () => {
    const refusal = new ApiError('conflict', 409, 'conflict', 'taken', null, [{ path: 'refusal/DIE_NUMBER_TAKEN', message: 'x' }, { path: 'fix', message: 'y' }])
    expect(dieProblemOf(refusal)).toEqual({ key: 'refusal.DIE_NUMBER_TAKEN' })
    expect(dieProblemOf(new ApiError('invalid', 400, 'validation', 'bad', null, [{ path: 'body/code', message: 'x' }]))).toEqual({ key: 'problem.field.code' })
    expect(dieProblemOf(new ApiError('forbidden', 403, 'forbidden', 'no'))).toEqual({ key: 'problem.forbidden' })
    expect(dieProblemOf(new Error('network'))).toEqual({ key: 'problem.unavailable' })
  })

  it('every refusal, condition and row has its words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['plant-dies'])['plant-dies']!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const code of DIE_REFUSALS) has(`refusal.${code}`)
      for (const condition of DIE_CONDITIONS) has(`condition.${condition}`)
      for (const rows of DIE_ROWS) has(`rows.${rows}`)
    }
  })

  it('the CSV says every size in words and the cost only with the grain', () => {
    const words = { everySize: 'Every size', condition: (condition: string) => condition.toLowerCase() }
    expect(csvRows([DIES.sleeve], words, false)[0]).toEqual([DIES.sleeve.code, 'STAB-N', 'DEMO-GIA-01', 'Every size', 'Manica', 'Manica', 'Rastrelliera R2', 'Acciaio forgiato', 'DEMO-F1', 'good'])
    expect(csvRows([DIES.sleeve], words, true)[0]!.at(-1)).toBe('260.00')
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the calls as the API takes them', () => {
  it('lists with the conditions and the words; finds styles', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { dies: [DIES.front50], nextCursor: 'c1', canManage: true } },
      { status: 200, body: { styles: [{ id: 'st', code: 'S', name: 'Style', sizes: ['50'] }] } },
    ])
    const page = await listDies(api, { ...diesQuery({ q: ' manica ', rows: 'worn' }, 's1'), limit: 50 })
    expect(calls[0]!.url).toBe('/api/plant/dies?siteId=s1&condition=WORN%2CDAMAGED&q=manica&limit=50')
    expect(page.nextCursor).toBe('c1')
    await findDieStyles(api, ' gia ')
    expect(calls[1]!.url).toBe('/api/plant/dies/styles?q=gia')
  })

  it('every write carries an Idempotency-Key and the version read', async () => {
    const { api, calls } = mockApi([
      { status: 201, body: { die: DIES.front50, replayed: false } },
      { status: 200, body: { die: DIES.front52 } },
      { status: 200, body: { die: DIES.retired, replayed: false } },
    ])
    await createDie(api, { siteId: 's1', code: 'FD-1', styleId: 'st', piece: 'Manica' }, 'key-1')
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/plant/dies', body: { siteId: 's1', code: 'FD-1', styleId: 'st', piece: 'Manica' } })
    expect(calls[0]!.headers.get('idempotency-key')).toBe('key-1')
    await updateDie(api, DIES.front52.id, { version: 3, condition: 'WORN', rackLocation: 'R3' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: `/api/plant/dies/${DIES.front52.id}`, body: { version: 3, condition: 'WORN', rackLocation: 'R3' } })
    await retireDie(api, DIES.retired.id, { version: 1, reason: 'Crepata' })
    expect(calls[2]).toMatchObject({ method: 'POST', url: `/api/plant/dies/${DIES.retired.id}/retire`, body: { version: 1, reason: 'Crepata' } })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })
})

const LEFT_KEY = /\b(?:common|problem|refusal|cell|condition|rows|col|die|dies|keys|held|newDie|retire|done|csv)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("plant.machines.manage"). */
const SAID = /\b(?:plant\.[a-zA-Z.]+|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'plant', 'plant-dies']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
        expect(html.length, `${designScreen.screen}/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${designScreen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${designScreen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the cost column is the owner\'s only, and New die is held for the floor supervisor', () => {
    const one = (id: string) => render(designScreen as unknown as DesignScreen<unknown>, designScreen.cases.find((item) => item.id === id)!.model, 'en')
    // The grid draws its rows in the browser: the server draws the foot, which says whether the cost shows.
    expect(one('owner-cost')).toContain('The cost shows only with the cost grain.')
    expect(one('maintenance')).not.toContain('The cost shows only with the cost grain.')
    expect(one('supervisor')).toContain('Your role does not keep the register')
    expect(one('empty')).toContain('No dies registered.')
    expect(one('sales')).not.toContain('FD-0001')
  })
})
