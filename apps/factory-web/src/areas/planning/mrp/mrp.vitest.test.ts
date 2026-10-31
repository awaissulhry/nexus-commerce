import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { canOf } from '../../_shared/buying/fixtures'
import { firmLine, getShortages, sendChecks, sendMany, type PlanLine, type SendCard, type Shortage } from './api'
import { designScreen } from './fixtures'
import { buyLinesOf, fixHeld, inView, moveFirmProblem, MRP_NAMESPACE, sendable, shortageId, shortWorkOrders, viewOf } from './model'

/**
 * What to buy & make, the W2a parts (SCR-055; B-W2a-70 on B-W2a-22 and B-W2a-52): Short on open work orders and its
 * fixes (Buy the plan's line, Expedite the PO, Move the firm order), the firm order moved, Send n of the drafts made,
 * the calls as the API takes them, and the W2a design cases in both languages with no key or placeholder on screen.
 */

const plan = designScreen.cases.find((item) => item.id === 'short-wo')!.model.model.plan
const LINES: PlanLine[] = plan.status === 'ready' ? plan.value.lines : []
const SHORT = designScreen.cases.find((item) => item.id === 'short-wo')!.model.model.shortages!
const ROWS: Shortage[] = SHORT.status === 'ready' ? SHORT.value.rows : []
const buyer = { ...canOf('buyer'), planFirm: true }
const planner = { ...canOf('planner'), planFirm: true }

describe('Short on open work orders: its own view, its fixes', () => {
  it('is a view of its own (the plan grid shows none of its lines)', () => {
    expect(viewOf('shortWo')).toBe('shortWo')
    expect(LINES.some((line) => inView(line, 'shortWo'))).toBe(false)
    expect(shortWorkOrders({ siteId: 's', asOf: '2026-10-29', latestRunId: null, rows: ROWS })).toBe(3)
    expect(new Set(ROWS.map(shortageId)).size).toBe(ROWS.length)
  })

  it('Buy drafts the plan’s open line; Expedite opens the PO; Move needs the firm order and planning.firm', () => {
    const [buy, expedite, move] = ROWS.map((row) => row.fixes[0]!)
    expect(fixHeld(buy!, LINES, buyer)).toBeNull()
    expect(fixHeld(buy!, LINES, planner)).toBe('held.noPurchasingRequests')
    expect(fixHeld(expedite!, LINES, buyer)).toBeNull()
    expect(fixHeld(expedite!, LINES, { ...buyer, poView: false })).toBe('held.noPoView')
    expect(fixHeld(move!, LINES, buyer)).toBeNull()
    expect(fixHeld(move!, LINES, { ...buyer, planFirm: false })).toBe('held.noFirm')
    expect(fixHeld(move!, LINES.map((line) => ({ ...line, firm: null })), buyer)).toBe('held.notFirm')
    expect(fixHeld({ ...buy!, requirementId: 'gone' }, LINES, buyer)).toBe('held.lineGone')
    expect(buyLinesOf(ROWS, LINES)).toEqual([buy!.requirementId])
  })

  it('a firm order moves to a day from today, not the same day', () => {
    const firm = LINES.find((line) => line.firm)!
    expect(moveFirmProblem(firm, '2026-11-09', '2026-10-29')).toBeNull()
    expect(moveFirmProblem(firm, '2026-10-01', '2026-10-29')).toBe('move.past')
    expect(moveFirmProblem(firm, firm.firm!.date, '2026-10-29')).toBe('move.same')
    expect(moveFirmProblem(firm, '', '2026-10-29')).toBe('move.pickDate')
    expect(moveFirmProblem({ ...firm, firm: null }, '2026-11-09', '2026-10-29')).toBe('held.notFirm')
  })

  it('Send n sends only the ready cards, each with its version', () => {
    const cards = [{ id: 'a', version: 3, ready: true }, { id: 'b', version: 1, ready: false }, { id: 'c', version: null, ready: true }] as unknown as SendCard[]
    expect(sendable(cards)).toEqual([{ id: 'a', version: 3 }])
    expect(sendable(null)).toEqual([])
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

describe('the W2a calls as the API takes them', () => {
  it('shortages, a firm order moved, send-checks and send-many', async () => {
    const firm = LINES.find((line) => line.firm)!
    const { api, calls } = mockApi([
      { status: 200, body: { siteId: 's1', asOf: '2026-10-29', latestRunId: null, rows: ROWS.map((row) => ({ ...row, reason: 'English, never drawn', fixes: row.fixes.map((fix) => ({ ...fix, words: 'x' })) })) } },
      { status: 200, body: { line: { ...firm, version: firm.version + 1 }, replayed: false } },
      { status: 200, body: { ready: 1, cards: [{ id: 'p1', number: 'PO-1', partyId: null, status: 'DRAFT', version: 2, ready: true, checks: [], recipient: null, documentNumber: 'PO-1', language: 'it', linkExpiresAt: null, subject: null, message: null, confirmBy: null, revision: 1, changes: null, refused: null }] } },
      { status: 200, body: { sent: 1, refused: 0, outcomes: [{ id: 'p1', number: 'PO-1', outcome: 'SENT', sent: null, delivery: 'sent', refused: null }] } },
    ])
    expect((await getShortages(api, 's1')).rows).toHaveLength(ROWS.length)
    expect(calls[0]!.url).toBe('/api/planning/shortages?siteId=s1')
    await firmLine(api, firm.id, { version: firm.version, quantity: firm.firm!.quantity, date: '2026-11-09' })
    expect(calls[1]).toMatchObject({ method: 'POST', url: `/api/planning/requirements/${firm.id}/firm`, body: { version: firm.version, quantity: '210.0000', date: '2026-11-09' } })
    expect((await sendChecks(api, ['p1']))[0]).toMatchObject({ ready: true, version: 2 })
    expect(calls[2]).toMatchObject({ url: '/api/purchasing/orders/send-checks', body: { orderIds: ['p1'] } })
    expect((await sendMany(api, [{ id: 'p1', version: 2 }]))[0]!.outcome).toBe('SENT')
    expect(calls[3]).toMatchObject({ url: '/api/purchasing/orders/send-many', body: { orders: [{ id: 'p1', version: 2 }] } })
    for (const call of [calls[1]!, calls[3]!]) expect(call.headers.get('idempotency-key')).toBeTruthy()
  })
})

const LEFT_KEY = /\b(?:held|move|notice|view|menu|tile|short|why|peg|send|plan|common|uom|po|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.(?:view|run|decide|firm)|purchasing\.(?:view|manage|send)|money\.cost|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('the W2a design cases draw in both languages with no key left on screen', () => {
  it('SCR-055 W2a cases × it, en', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const cases = screen.cases.filter((item) => item.label.startsWith('W2a') || item.id === 'why' || item.id === 'plan')
    expect(cases.length).toBeGreaterThanOrEqual(11)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the pegging, the hold and the new held words are said in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [MRP_NAMESPACE])[MRP_NAMESPACE]!)
      for (const kind of ['STOCK', 'RESERVATION', 'PURCHASE_ORDER', 'PLANNED', 'FIRM']) expect(t(`peg.supply.${kind}`)).not.toBe(`peg.supply.${kind}`)
      for (const kind of ['ORDER_LINE', 'WORK_ORDER', 'SAFETY_STOCK', 'REORDER']) expect(t(`peg.kind.${kind}`)).not.toBe(`peg.kind.${kind}`)
      for (const word of ['NOT_ENOUGH', 'DELAYED']) expect(t(`short.word.${word}`)).not.toBe(`short.word.${word}`)
      for (const key of ['held.noPurchasingRequests', 'held.noSend', 'held.noneReady', 'move.changed', 'move.refused', 'move.failed']) expect(t(key)).not.toBe(key)
    }
  })
})
