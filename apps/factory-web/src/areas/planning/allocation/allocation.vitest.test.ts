import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { allocate, getAllocation } from './api'
import { ALLOCATION } from './fixtures'
import { allocationOf, controlsOf, drawAllocation, NAMESPACE, planAllocation, queryOf, refusalOf, WINDOW, type Words } from './model'

/**
 * Planning › Lines & subcontractors (SCR-126; B-W2a-45 on the allocation API of B-W2a-34): the address, the columns
 * (lines and workshops with the next four weeks' capacity; a workshop's is not known, never 0), the cards, what a card
 * move asks (factory-domain's moveAllocation → the work order's whole allocation with its version), refusals in our
 * words, and the calls as the API takes them. The design cases are drawn in both languages by board.vitest.test.ts.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const [LINE1, LINE2, BETA, GAMMA] = ALLOCATION.lanes
const key = (lane: { kind: string; id: string }) => `${lane.kind}:${lane.id}`
const cardOfWo = (number: string, part = false) => ALLOCATION.cards.find((card) => card.workOrder.number === number && (card.slot !== null) === part)!

describe('allocation: the address and the columns', () => {
  it('keeps the site and the open card in the address', () => {
    expect(controlsOf(new URLSearchParams('site=s1&card=c1'))).toEqual({ site: 's1', card: 'c1' })
    expect(queryOf({ site: null, card: null })).toBe('')
  })

  it('one column per line and workshop; a line has its four weeks of capacity, a workshop none (not known)', () => {
    const drawn = drawAllocation(ALLOCATION, words())
    expect(drawn.lanes.map((lane) => lane.label)).toEqual(['Linea 1', 'Linea 2', 'Laboratorio Beta', 'Laboratorio Gamma'])
    expect(drawn.lanes[0]!.capacity).toEqual({ [WINDOW]: 61200 })
    expect(drawn.lanes[0]!.detail).toBe('160 garments booked')
    expect(drawn.lanes[2]!.capacity).toBeUndefined()
    expect(drawn.lanes[2]!.detail).toBe('30 garments booked · 1 subcontract order')
    expect(drawn.buckets).toEqual([{ id: WINDOW, label: 'Next 4 weeks' }])
    const part = drawn.cards.find((card) => card.id === cardOfWo('WO-0102', true).id)!
    expect(part).toMatchObject({ label: 'WO-0102', laneId: key(BETA!), late: true })
    expect(part.marks?.[0]?.label).toBe('Part: 20 of 80')
    expect(drawn.cards.filter((card) => card.laneId === null).map((card) => card.label)).toEqual(['WO-0104', 'WO-0106'])
    expect(drawAllocation(ALLOCATION, words('it')).lanes[0]!.detail).toBe('160 capi prenotati')
  })
})

describe('allocation: what a card move asks', () => {
  it('reads the work order allocation from its cards', () => {
    expect(allocationOf(ALLOCATION, cardOfWo('WO-0102').workOrder.id)).toEqual({ lineId: LINE2!.id, parts: [{ lane: { kind: 'WORKSHOP', id: BETA!.id }, pieces: 20 }] })
    expect(allocationOf(ALLOCATION, cardOfWo('WO-0104').workOrder.id)).toEqual({ lineId: null, parts: [] })
  })

  it('a not-allocated order dropped on a line takes that line; the line part to another line moves the order', () => {
    const fresh = cardOfWo('WO-0104')
    expect(planAllocation(ALLOCATION, fresh.id, key(LINE1!))).toEqual({ kind: 'put', workOrderId: fresh.workOrder.id, body: { version: 1, lineId: LINE1!.id, parts: [] } })
    const main = cardOfWo('WO-0101')
    expect(planAllocation(ALLOCATION, main.id, key(LINE2!))).toEqual({ kind: 'put', workOrderId: main.workOrder.id, body: { version: 3, lineId: LINE2!.id, parts: [] } })
  })

  it('part of the garments to a workshop is a part; a part back onto the line joins the line part', () => {
    const main = cardOfWo('WO-0101')
    expect(planAllocation(ALLOCATION, main.id, key(GAMMA!), 40)).toEqual({ kind: 'put', workOrderId: main.workOrder.id, body: { version: 3, lineId: LINE1!.id, parts: [{ lane: { kind: 'WORKSHOP', id: GAMMA!.id }, pieces: 40 }] } })
    const part = cardOfWo('WO-0102', true)
    expect(planAllocation(ALLOCATION, part.id, key(LINE2!))).toEqual({ kind: 'put', workOrderId: part.workOrder.id, body: { version: 3, lineId: LINE2!.id, parts: [] } })
  })

  it('refuses in our words: too many garments, the same column, a part left unallocated', () => {
    const main = cardOfWo('WO-0101')
    expect(planAllocation(ALLOCATION, main.id, key(GAMMA!), 999)).toEqual({ kind: 'refused', code: 'TOO_MANY' })
    expect(planAllocation(ALLOCATION, main.id, key(LINE1!))).toEqual({ kind: 'refused', code: 'SAME' })
    expect(planAllocation(ALLOCATION, cardOfWo('WO-0102', true).id, null)).toEqual({ kind: 'refused', code: 'UNALLOCATED_PART' })
    expect(planAllocation(ALLOCATION, 'gone', key(LINE1!))).toEqual({ kind: 'refused', code: 'STALE' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'This WorkOrder changed since it was read (version 3); it is now at version 4. Reload it and apply the change again.', null, [{ path: 'version', message: '' }]))).toBe('CHANGED')
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'WO-0101 is completed: its allocation is kept as it was.'))).toBe('LOCKED')
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('FORBIDDEN')
    for (const locale of LOCALES) {
      const t = words(locale).t
      for (const code of ['STALE', 'WHOLE', 'TOO_MANY', 'SAME', 'UNALLOCATED_PART', 'CHANGED', 'LOCKED', 'NOT_OPEN', 'LANE_INACTIVE', 'INVALID', 'FORBIDDEN', 'NOT_FOUND', 'OFFLINE', 'FAILED']) expect(t(`refusal.${code}`), `${locale}: ${code}`).not.toBe(`refusal.${code}`)
    }
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> } {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('allocation: the calls as the API takes them', () => {
  it('reads the site board and puts the work order allocation with its version and a key', async () => {
    const main = cardOfWo('WO-0101')
    const { api, calls } = mockApi([{ status: 200, body: ALLOCATION }, { status: 200, body: { workOrder: { id: main.workOrder.id, version: 4, lineId: LINE1!.id }, cards: [], planVersion: 13, replayed: false } }])
    expect((await getAllocation(api, 's1')).cards).toHaveLength(ALLOCATION.cards.length)
    expect(calls[0]!.url).toBe('/api/planning/allocation?siteId=s1')
    const plan = planAllocation(ALLOCATION, main.id, key(GAMMA!), 40)
    if (plan.kind !== 'put') throw new Error('expected a put')
    await allocate(api, plan.workOrderId, plan.body)
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `/api/planning/allocation/work-orders/${main.workOrder.id}`, body: { version: 3, lineId: LINE1!.id, parts: [{ lane: { kind: 'WORKSHOP', id: GAMMA!.id }, pieces: 40 }] } })
    expect(calls[1]!.headers.get('idempotency-key')).toBeTruthy()
  })
})
