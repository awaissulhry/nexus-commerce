import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { bulkStrategy, listStrategy, setStrategy } from './api'
import { FIXTURES } from './fixtures'
import { bulkBody, bulkLines, cellBody, cellHeld, colourRows, controlsOf, everyColourRow, mpsCan, queryOf, reasonProblem, refusalOf, undoBody, withSaved } from './model'

/**
 * Planning › Long range › Master schedule & S&OP, the production strategy per item (SCR-202; B-W2b-339 on B-W2b-319's API):
 * the address, the row a cell saves and its version, a saved answer put back, the bulk review and its Undo, the refusals in our
 * words, and the calls as the API takes them (the design cases are drawn by demand.vitest.test.ts with SCR-374's).
 */

const { ITEMS, ANSWER, PICKED } = FIXTURES
const [CMP500, CMP510, NER50, , , CMP520] = ITEMS

describe('mps: the address and the rights', () => {
  it('keeps search, kind, strategy and set or default; unknown terms are dropped', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&q=jkt&kind=COMPONENT&strategy=MAKE_TO_STOCK&set=default'))
    expect(controls).toEqual({ site: 's1', q: 'jkt', kind: 'COMPONENT', strategy: 'MAKE_TO_STOCK', set: 'default' })
    expect(queryOf(controls)).toBe('site=s1&q=jkt&kind=COMPONENT&strategy=MAKE_TO_STOCK&set=default')
    expect(controlsOf(new URLSearchParams('kind=LEATHER&strategy=X&set=maybe'))).toEqual({ site: null, q: '', kind: null, strategy: null, set: null })
  })

  it('a cell changes only with planning.strategy.manage', () => {
    expect(cellHeld(mpsCan(['planning.view']))).toBe('held.noManage')
    expect(cellHeld(mpsCan(['planning.view', 'planning.strategy.manage']))).toBeNull()
  })
})

describe('mps: one cell', () => {
  it('saves the every-colour row with its version; an item without one sends none', () => {
    expect(everyColourRow(CMP500!)?.version).toBe(3)
    expect(cellBody(CMP500!, 's1', 'MAKE_TO_ORDER')).toEqual({ siteId: 's1', strategy: 'MAKE_TO_ORDER', version: 3 })
    expect(cellBody(CMP510!, 's1', 'MAKE_TO_STOCK')).toEqual({ siteId: 's1', strategy: 'MAKE_TO_STOCK' })
    expect(colourRows(CMP520!).map((row) => [row.colour?.name, row.strategy])).toEqual([['Nero', 'MAKE_TO_STOCK']])
  })

  it('a saved answer puts its row, the strategy and the last change back; the colours set apart stay', () => {
    const row = { itemPlanningId: 'p1', colour: null, stored: 'MAKE_TO_STOCK' as const, strategy: 'MAKE_TO_STOCK' as const, version: 4, lastChange: { at: '2026-11-12T10:00:00.000Z', by: { id: 'u1', name: 'Marta Esempio' }, from: 'MAKE_TO_ORDER' as const, to: 'MAKE_TO_STOCK' as const, reason: null } }
    const next = withSaved(CMP520!, { row, change: 'EDITED' }, 'MAKE_TO_STOCK')
    expect(next).toMatchObject({ strategy: 'MAKE_TO_STOCK', set: true, lastChange: row.lastChange })
    expect(next.rows.map((entry) => entry.colour?.name ?? null)).toEqual([null, 'Nero'])
    expect(withSaved(CMP510!, { row: null, change: 'UNCHANGED' }, 'MAKE_TO_ORDER')).toBe(CMP510)
  })
})

describe('mps: the bulk change and its Undo', () => {
  it('reviews what changes and what is already so, and sends only what changes', () => {
    const { changing, already } = bulkLines(PICKED, 'MAKE_TO_STOCK')
    expect(changing.map((line) => line.item.item.code)).toEqual(['CMP-DEMO-510', 'JKT-DEMO-07-ROS-50'])
    expect(already.map((item) => item.item.code)).toEqual(['JKT-DEMO-07-NER-52'])
    expect(bulkBody('s1', changing, '  ')).toEqual({ siteId: 's1', items: [{ itemId: CMP510!.item.id, strategy: 'MAKE_TO_STOCK' }, { itemId: PICKED[1]!.item.id, strategy: 'MAKE_TO_STOCK' }] })
    expect(bulkBody('s1', bulkLines([NER50!], 'MAKE_TO_ORDER').changing, ' Season ')).toEqual({ siteId: 's1', reason: 'Season', items: [{ itemId: NER50!.item.id, strategy: 'MAKE_TO_ORDER', version: 3 }] })
    expect(reasonProblem('x'.repeat(501))).toBe('bulk.reasonLong')
    expect(reasonProblem('')).toBeNull()
  })

  it('Undo sends each item back to what it was, at its new version', () => {
    expect(undoBody('s1', ANSWER)).toEqual({ siteId: 's1', items: ANSWER.changes.map((change) => ({ itemId: change.itemId, strategy: 'MAKE_TO_ORDER', version: 1 })) })
    expect(undoBody('s1', { changes: [{ ...ANSWER.changes[0]!, change: 'UNCHANGED' }], changed: 0, replayed: false })).toBeNull()
  })

  it('says each refusal in our words', () => {
    expect(refusalOf(new ApiError('conflict', 409, 'stale_version', 'x'))).toBe('refusal.changed')
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/items/0/itemId' }]))).toBe('refusal.item')
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/items/1/itemColourId' }]))).toBe('refusal.colour')
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/items' }]))).toBe('refusal.twice')
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('refusal.forbidden')
    expect(refusalOf(new Error('x'))).toBe('refusal.failed')
  })
})

function mockApi(answers: unknown[]) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null, key: new Headers(init.headers).get('idempotency-key') })
    return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('mps: the calls as the API takes them', () => {
  it('reads the list (and the review’s items), saves a cell, saves a bulk change, each write with its own Idempotency-Key', async () => {
    const { api, calls } = mockApi([
      { site: { id: 's1', companyId: 'c1', code: 'ST1', name: 'Site', timeZone: 'Europe/Rome' }, items: ITEMS, nextCursor: null, hint: { en: 'x', it: 'y' } },
      { row: null, change: 'UNCHANGED', from: 'MAKE_TO_ORDER', replayed: false },
      ANSWER,
    ])
    await listStrategy(api, { siteId: 's1', q: 'jkt', kind: 'FINISHED', strategy: null, set: true, itemIds: ['a', 'b'], limit: 100 })
    expect(calls[0]!.url).toBe('/api/planning/strategy?siteId=s1&q=jkt&kind=FINISHED&set=true&itemIds=a%2Cb&limit=100')
    await setStrategy(api, 'i1', { siteId: 's1', strategy: 'MAKE_TO_ORDER' })
    expect(calls[1]).toMatchObject({ method: 'PUT', url: '/api/planning/strategy/items/i1', body: { siteId: 's1', strategy: 'MAKE_TO_ORDER' } })
    await bulkStrategy(api, { siteId: 's1', items: [{ itemId: 'i1', strategy: 'MAKE_TO_STOCK', version: 2 }] })
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/planning/strategy/bulk' })
    expect(calls[1]!.key).toBeTruthy()
    expect(calls[2]!.key).toBeTruthy()
    expect(calls[1]!.key).not.toBe(calls[2]!.key)
  })
})
