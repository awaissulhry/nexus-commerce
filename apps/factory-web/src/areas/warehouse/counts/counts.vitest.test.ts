import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COUNT_ITEM_KINDS, STOCK_COUNT_STATUSES } from '@nexus/factory-domain/inventory/counts/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { applyCount, countLines, countPlaces, createCount, findMaterials, listCounts, recordLines, signOffCount } from './api'
import { canAs, COUNT_PLACES, COUNT_ROWS, COUNTING, LINES, MATERIALS, OWN_VARIANCE, SUBMITTED, YEAR_END_APPLIED, YEAR_END_DRAFT } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import {
  addressOf,
  addressText,
  COUNT_CSV_COLUMNS,
  countProblem,
  countsCan,
  differenceSelectable,
  heldPhrase,
  LIST_VIEWS,
  lineState,
  nextStep,
  readCount,
  recordTabOf,
  sameQuantity,
  scopeParts,
  startsLater,
  TILES,
  typedField,
  typedText,
  viewQuery,
  yearEndChoices,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * Warehouse › Counts (SCR-132, SCR-132-record; B-W2a-28): the pure rules (saved rows ⇄ the API's filters and the part it
 * cannot filter, the address, a typed count read in either language, the next step and why it is held in our words, a
 * refused write in words, the year-end dates), the calls as the API of B-W2a-15 takes them (one line per autosave with its
 * version, ⌘Z as counted null, the sign-off phrase), the record links, and every design case drawn in Italian and English
 * with no message key or placeholder left on screen.
 */

const row = COUNT_ROWS[0]!

describe('counts: saved rows, the address and the tiles', () => {
  it('maps each saved row to the API filter (B-W2b-15: waiting and to apply too)', () => {
    expect(viewQuery('open').query).toEqual({ open: true })
    expect(viewQuery('counting').query).toEqual({ status: 'COUNTING' })
    expect(viewQuery('yearEnd').query).toEqual({ kind: 'YEAR_END', open: true })
    expect(viewQuery('all').query).toEqual({})
    // B-W2b-15: the API filters waiting for approval and to apply (`view`) as the tiles count them; nothing is dropped here.
    const waiting = viewQuery('waiting')
    expect(waiting.query).toEqual({ view: 'waitingApproval' })
    expect(COUNT_ROWS.filter(waiting.keep).length).toBe(COUNT_ROWS.length)
    const toApply = viewQuery('toApply')
    expect(toApply.query).toEqual({ view: 'toApply' })
    expect(COUNT_ROWS.filter(toApply.keep).length).toBe(COUNT_ROWS.length)
    expect(TILES.map((tile) => tile.count({ drafts: 1, counting: 2, waitingApproval: 3, toApply: 4, yearEnd: 5 }))).toEqual([2, 3, 4, 5])
  })

  it('reads and writes the address (open is the default; ?new=1 opens New count)', () => {
    const address = addressOf(new URLSearchParams('view=waiting&q=rack&site=s1&new=1'))
    expect(address).toEqual({ view: 'waiting', q: 'rack', siteId: 's1', isNew: true })
    expect(addressText(address)).toBe('?view=waiting&q=rack&site=s1&new=1')
    expect(addressOf(new URLSearchParams('view=nonsense')).view).toBe('open')
    expect(addressText({ view: 'open', q: ' ', siteId: null, isNew: false })).toBe('')
    expect(recordTabOf('approval')).toBe('approval')
    expect(recordTabOf('x')).toBe('lines')
  })

  it('says the scope in parts: the whole site when nothing narrows it', () => {
    expect(scopeParts(row.scope)).toEqual([{ key: 'scope.location', params: { code: 'N-MAG-A', name: 'Scaffale A' } }])
    expect(scopeParts({ location: null, item: null, lot: null, itemKind: null })).toEqual([{ key: 'scope.site' }])
    expect(scopeParts({ location: null, item: { id: 'i', code: 'Z', name: 'Zip' }, lot: { id: 'l', code: 'L1' }, itemKind: 'LEATHER' }).map((part) => part.key)).toEqual(['scope.item', 'scope.lot', 'itemKind.LEATHER'])
  })
})

describe('counts: abilities, the next step and why it is held', () => {
  it('reads the roles: the warehouse counts and approves, finance signs off with costs, read-only only sees', () => {
    expect(canAs('warehouse')).toMatchObject({ view: true, manage: true, approve: true, signOff: false, apply: true, cost: false })
    expect(canAs('finance')).toMatchObject({ view: true, manage: false, approve: false, signOff: true, cost: true })
    expect(canAs('readOnly')).toMatchObject({ view: true, manage: false, approve: false, cost: false })
    expect(canAs('sales').view).toBe(false)
    expect(countsCan(['inventory.counts.view', 'money.cost']).cost).toBe(true)
  })

  it('names one step per state', () => {
    expect(nextStep({ status: 'DRAFT', kind: 'CYCLE', approvalRequired: null })).toBe('start')
    expect(nextStep({ status: 'COUNTING', kind: 'CYCLE', approvalRequired: null })).toBe('submit')
    expect(nextStep({ status: 'SUBMITTED', kind: 'CYCLE', approvalRequired: true })).toBe('approve')
    expect(nextStep({ status: 'SUBMITTED', kind: 'CYCLE', approvalRequired: false })).toBe('apply')
    expect(nextStep({ status: 'APPLIED', kind: 'YEAR_END', approvalRequired: true })).toBe('signOff')
    expect(nextStep({ status: 'APPLIED', kind: 'CYCLE', approvalRequired: false })).toBeNull()
    expect(nextStep({ status: 'SIGNED_OFF', kind: 'YEAR_END', approvalRequired: true })).toBeNull()
  })

  it('says why a step is held from the record’s figures and codes, never the API’s English', () => {
    expect(heldPhrase(COUNTING, 'submit', canAs('warehouse'))).toEqual({ key: 'held.uncounted', params: { count: 1 } })
    expect(heldPhrase({ ...COUNTING, summary: { ...COUNTING.summary, uncounted: 0 } }, 'submit', canAs('warehouse'))).toEqual({ key: 'held.recountsDue', params: { count: 1 } })
    expect(heldPhrase({ ...COUNTING, summary: { ...COUNTING.summary, uncounted: 0, recountsDue: 0 } }, 'submit', canAs('warehouse'))).toEqual({ key: 'held.unreasoned', params: { count: 2 } })
    expect(heldPhrase(COUNTING, 'submit', canAs('readOnly'))).toEqual({ key: 'held.noManage' })
    expect(heldPhrase(OWN_VARIANCE, 'approve', canAs('warehouse'))).toEqual({ key: 'held.ownVariance' })
    expect(heldPhrase(SUBMITTED, 'approve', canAs('owner'))).toBeNull()
    expect(heldPhrase(SUBMITTED, 'apply', canAs('owner'))).toEqual({ key: 'held.approveFirst' })
    expect(heldPhrase(SUBMITTED, 'apply', canAs('finance'))).toEqual({ key: 'held.waitingApprover' })
    expect(heldPhrase(YEAR_END_DRAFT, 'start', canAs('owner'), '31/12/2026')).toEqual({ key: 'held.tooEarly', params: { date: '31/12/2026' } })
    expect(heldPhrase(YEAR_END_APPLIED, 'signOff', canAs('finance'))).toBeNull()
    const refused = { ...YEAR_END_APPLIED, actions: { ...YEAR_END_APPLIED.actions, signOff: { allowed: false, reason: 'x' } } }
    expect(heldPhrase(refused, 'signOff', canAs('warehouse'))).toEqual({ key: 'held.noSignOff' })
    expect(heldPhrase(refused, 'signOff', countsCan(['inventory.counts.view', 'inventory.counts.signoff']))).toEqual({ key: 'held.noCostSignOff' })
  })

  it('lets a Differences row be picked only while counting, and never one not counted yet', () => {
    expect(differenceSelectable(LINES[1]!, COUNTING, canAs('warehouse'))).toBeNull()
    expect(differenceSelectable(LINES[2]!, COUNTING, canAs('warehouse'))).toBe('diff.select.uncounted')
    expect(differenceSelectable(LINES[1]!, SUBMITTED, canAs('warehouse'))).toBe('diff.select.closed')
    expect(differenceSelectable(LINES[1]!, COUNTING, canAs('readOnly'))).toBe('held.noManage')
  })
})

describe('counts: a typed count', () => {
  it('reads either language’s decimal mark, 0 for not found, empty to take back; refuses what the API would', () => {
    expect(readCount('12,5')).toEqual({ value: '12.5', problem: null })
    expect(readCount(' 12.25 ')).toEqual({ value: '12.25', problem: null })
    expect(readCount('0')).toEqual({ value: '0', problem: null })
    expect(readCount('')).toEqual({ value: null, problem: null })
    expect(readCount('1.234,5').problem).toBe('line.problem.number')
    expect(readCount('-3').problem).toBe('line.problem.number')
    expect(readCount('1,23456').problem).toBe('line.problem.decimals')
    expect(readCount('60', '57.1000').problem).toBe('line.problem.hideArea')
    expect(readCount('57,1', '57.1000').problem).toBeNull()
  })

  it('shows the API’s decimal in the language, types the recount once one is asked, and knows the line’s state', () => {
    expect(typedText('112.5000', 'it')).toBe('112,5')
    expect(typedText('112.5000', 'en')).toBe('112.5')
    expect(typedText('120.0000', 'it')).toBe('120')
    expect(typedText(null, 'en')).toBe('')
    expect(sameQuantity('12.5', '12.5000')).toBe(true)
    expect(sameQuantity(null, '0')).toBe(false)
    expect(typedField(LINES[4]!)).toBe('recount')
    expect(typedField(LINES[1]!)).toBe('counted')
    expect(LINES.map((line) => lineState(line))).toEqual(['agrees', 'differs', 'uncounted', 'differs', 'recountDue', 'agrees', 'differs', 'differs'])
  })

  it('offers 31 December of last year and this year, the nearer one first; a year-end inventory starts on its day', () => {
    expect(yearEndChoices(new Date('2026-10-30T10:00:00Z'))).toEqual({ years: [2025, 2026], preset: 2026 })
    expect(yearEndChoices(new Date('2027-01-08T10:00:00Z'))).toEqual({ years: [2026, 2027], preset: 2026 })
    expect(startsLater('2026-12-31', new Date('2026-10-30T10:00:00Z'))).toBe(true)
    expect(startsLater('2026-12-31', new Date('2026-12-30T23:30:00Z'))).toBe(false)
    expect(startsLater('2025-12-31', new Date('2026-10-30T10:00:00Z'))).toBe(false)
  })
})

describe('counts: refused writes in words', () => {
  const refusal = (code: string, message: string) => new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: `problem/${code}`, message }])
  it('reads the count’s own refusal codes, the fields it names, and the kind', () => {
    expect(countProblem(refusal('HELD_BY_OTHER_COUNT', '2 of its stock keys are being counted by CNT-2026-0003; finish or cancel that count first.'))).toEqual({
      key: 'problem.HELD_BY_OTHER_COUNT',
      params: { counts: 'CNT-2026-0003' },
    })
    expect(countProblem(refusal('OWN_VARIANCE', 'You counted 2 line(s).')).key).toBe('problem.OWN_VARIANCE')
    expect(countProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/phrase', message: 'x' }])).key).toBe('problem.phrase')
    expect(countProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/lines/0/counted', message: 'x' }])).key).toBe('problem.quantity')
    expect(countProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }])).key).toBe('stock:problem.changed')
    expect(countProblem(new ApiError('conflict', 409, 'invalid_state', 'x', null, [])).key).toBe('stock:problem.notNow')
    expect(countProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('stock:problem.forbidden')
    expect(countProblem(new Error('boom')).key).toBe('stock:problem.write')
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

describe('counts: the calls as the API takes them', () => {
  const record = { ...COUNTING }
  it('lists with the API’s own filters and reads a page of lines', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { counts: COUNT_ROWS, nextCursor: null } },
      { status: 200, body: { lines: LINES, nextCursor: 80 } },
    ])
    await listCounts(api, { ...viewQuery('yearEnd').query, q: ' rack ', siteId: 's1', limit: 50 })
    expect(calls[0]!.url).toBe('/api/inventory/stock-counts?siteId=s1&kind=YEAR_END&open=true&q=rack&limit=50')
    const page = await countLines(api, row.id, { filter: 'differs', cursor: 40, limit: 200 })
    expect(page.nextCursor).toBe(80)
    expect(calls[1]!.url).toBe(`/api/inventory/stock-counts/${row.id}/lines?filter=differs&cursor=40&limit=200`)
  })

  it('B-W2b-15: the saved rows waiting / to apply as the API\'s view, the lines per place, and the item search with finished garments', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { counts: COUNT_ROWS, nextCursor: null } },
      { status: 200, body: { places: COUNT_PLACES } },
      { status: 200, body: { items: MATERIALS } },
    ])
    await listCounts(api, { ...viewQuery('waiting').query, siteId: 's1', limit: 50 })
    expect(calls[0]!.url).toBe('/api/inventory/stock-counts?siteId=s1&view=waitingApproval&limit=50')
    expect(await countPlaces(api, row.id)).toEqual(COUNT_PLACES)
    expect(calls[1]!.url).toBe(`/api/inventory/stock-counts/${row.id}/places`)
    const found = await findMaterials(api, 's1', ' giacca ')
    expect(calls[2]!.url).toBe('/api/inventory/stock-counts/items?siteId=s1&q=giacca&limit=20')
    expect(found.find((item) => item.kind === 'FINISHED')).toMatchObject({ code: 'GIACCA-DEMO-01-NER-50', colours: [] })
  })

  it('saves one typed line with its version (autosave per cell); ⌘Z sends counted null; every write has its own key', async () => {
    const answer = { status: 200, body: { lines: [LINES[1]], counted: 7, all: 8 } }
    const { api, calls } = mockApi([answer, answer])
    await recordLines(api, row.id, [{ lineId: LINES[1]!.id, version: 2, counted: '112.5' }])
    await recordLines(api, row.id, [{ lineId: LINES[1]!.id, version: 3, counted: null }])
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/inventory/stock-counts/${row.id}/lines/record`, body: { lines: [{ lineId: LINES[1]!.id, version: 2, counted: '112.5' }] } })
    expect(calls[1]!.body).toEqual({ lines: [{ lineId: LINES[1]!.id, version: 3, counted: null }] })
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy()
    expect(calls[0]!.headers.get('idempotency-key')).not.toBe(calls[1]!.headers.get('idempotency-key'))
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-demo')
  })

  it('creates the year-end inventory as of 31 December, applies with the version, signs off with the typed number', async () => {
    const one = { status: 200, body: { count: record } }
    const { api, calls } = mockApi([{ status: 201, body: { count: record } }, { status: 200, body: { count: record, moves: [] } }, one])
    await createCount(api, { siteId: 's1', kind: 'YEAR_END', inventoryDate: '2026-12-31', countTeam: 'Tutto il magazzino' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/inventory/stock-counts', body: { siteId: 's1', kind: 'YEAR_END', inventoryDate: '2026-12-31' } })
    await applyCount(api, { id: row.id, version: 6 })
    expect(calls[1]).toMatchObject({ url: `/api/inventory/stock-counts/${row.id}/apply`, body: { version: 6 } })
    await signOffCount(api, { id: row.id, version: 7 }, 'CNT-D-0009', 'it')
    expect(calls[2]).toMatchObject({ url: `/api/inventory/stock-counts/${row.id}/sign-off`, body: { version: 7, phrase: 'CNT-D-0009', language: 'it' } })
  })
})

describe('record links: a count opens its record; the API list opens Counts', () => {
  it('opens the built pages', () => {
    expect(recordAddress({ type: 'StockCount', id: 'c1' }, OFFICE_PAGES)).toBe('/warehouse/counts/c1')
    expect(LIST_PAGES['/inventory/stock-counts']).toBe('/warehouse/counts')
  })
})

const LEFT_KEY =
  /\b(?:list|col|view|tile|tileHint|status|kind|kindShort|itemKind|scope|csv|sheets|new|held|step|record|tab|lines|line|diff|approval|check|valued|edit|cancel|approve|sendBack|reason|apply|signOff|found|done|problem|keys|common|uom|live)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs inventory.counts.manage"); file names and domains are not keys. */
const SAID = /\b(?:inventory\.counts\.[a-z]+|inventory\.adjust|files\.read|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'records', 'warehouse-counts']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (states, kinds, views, tiles, steps, refusals, CSV)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['warehouse-counts'])['warehouse-counts']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of STOCK_COUNT_STATUSES) has(`status.${status}`)
      for (const kind of COUNT_ITEM_KINDS) has(`itemKind.${kind}`)
      for (const view of LIST_VIEWS) has(`view.${view}`)
      for (const tile of TILES) {
        has(`tile.${tile.id}`)
        has(`tileHint.${tile.id}`)
      }
      for (const step of ['start', 'submit', 'approve', 'signOff']) has(`step.${step}`)
      has('step.apply', 3)
      for (const state of ['uncounted', 'recountDue', 'agrees', 'differs']) has(`line.state.${state}`)
      for (const state of ['empty', 'partial', 'mismatch', 'match']) has(`signOff.state.${state}`)
      for (const state of ['done', 'open', 'failed', 'skipped']) has(`check.state.${state}`)
      for (const filter of ['all', 'uncounted', 'differs', 'recount', 'added']) has(`lines.filter.${filter}`)
      for (const column of COUNT_CSV_COLUMNS) has(`csv.${column}`)
      for (const code of ['TOO_EARLY', 'TOO_MANY_LINES', 'HELD_BY_OTHER_COUNT', 'UNCOUNTED', 'RECOUNT_DUE', 'NO_REASON', 'OWN_VARIANCE', 'ALREADY_COUNTED', 'SNAPSHOT_LINE', 'NOT_APPROVED', 'NOT_CANCELLABLE', 'SIGNED_OFF', 'NOT_APPLIED', 'NOT_STARTED']) has(`problem.${code}`)
    }
  })
})
