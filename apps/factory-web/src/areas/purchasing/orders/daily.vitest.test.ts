import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DELIVERY_STATES } from '@nexus/factory-domain/purchasing/orders/delivery'
import { LINE_DIFF_KINDS, REVISION_ANSWERS } from '@nexus/factory-domain/purchasing/revisions/revisions'
import { createApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { canOf } from '../../_shared/buying/fixtures'
import { getOrder, getReach, sendMany } from './api'
import { addedInDraft, cancelLineHeld, cardHeld, cardsBySupplier, changeHeld, closeShortHeld, confirmByHeld, counterHeld, outcomeWords, reachHeld, remindHeld, sendManyBody } from './daily-model'
import { leatherLine, order, protectorLine } from './demo/fixtures'
import { reachOf, revisionsDraftTwo, SEND_CARDS, SEND_OUTCOMES } from './demo/daily/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import { cancelHeld, ORDER_TILES, orderQuery, orderViewOf } from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * Purchasing every day (B-W2a-69) on the PO list (SCR-058) and the PO studio (SCR-059): the rules of the changes after the
 * send (Change, counter-propose, cancel lines, close short, the cancel's reach, confirm-by, reminders, Send n) held in
 * words, the API calls' shapes, and every design case in both languages with no key left on screen.
 */

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so every dialog's words
// are checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), subtitle as never, children as never, footer as never) : null
  return { ...actual, Modal }
})

const buyer = canOf('buyer')
const planner = canOf('planner')
const params = (query: string) => new URLSearchParams(query)

describe('the changes after the send, held in words', () => {
  it('Change: a sent, declined or confirmed order with the send right; a draft, a proposal or received goods say why', () => {
    for (const status of ['SENT', 'DECLINED', 'CONFIRMED'] as const) expect(changeHeld(order(status), buyer)).toBeNull()
    expect(changeHeld(order('SENT'), planner)).toEqual({ key: 'buying:held.noSend' })
    expect(changeHeld(order('DRAFT'), buyer)).toEqual({ key: 'change.held.draft' })
    expect(changeHeld(order('CHANGES_PROPOSED'), buyer)).toEqual({ key: 'change.held.proposed' })
    expect(changeHeld(order('PARTLY_RECEIVED'), buyer)).toEqual({ key: 'change.held.received' })
    expect(counterHeld(order('CHANGES_PROPOSED'), buyer)).toBeNull()
    expect(counterHeld(order('SENT'), buyer)).toEqual({ key: 'counter.held.noProposal' })
  })

  it('Remind and Move confirm-by: only a sent order still waiting; remind needs send and an e-mail, the deadline needs manage', () => {
    expect(remindHeld(order('SENT'), buyer)).toBeNull()
    expect(remindHeld(order('CONFIRMED'), buyer)).toEqual({ key: 'remind.held.notWaiting' })
    expect(remindHeld(order('SENT', { contact: null }), buyer)).toEqual({ key: 'remind.held.noEmail' })
    expect(remindHeld(order('SENT'), planner)).toEqual({ key: 'buying:held.noSend' })
    expect(confirmByHeld(order('SENT'), buyer)).toBeNull()
    expect(confirmByHeld(order('DRAFT'), buyer)).toEqual({ key: 'confirmBy.held.notSent' })
    expect(confirmByHeld(order('SENT'), planner)).toEqual({ key: 'buying:held.noManage' })
  })

  it('W2a: a confirmed order may be cancelled; goods received or a waiting proposal hold it', () => {
    expect(cancelHeld(order('CONFIRMED'), buyer)).toBeNull()
    expect(cancelHeld(order('PARTLY_RECEIVED'), buyer)).toEqual({ key: 'po.cancelHeld.received' })
    expect(cancelHeld(order('CHANGES_PROPOSED'), buyer)).toEqual({ key: 'po.cancelHeld.proposed' })
  })

  it('cancel a line: a draft of revision 1 removes; revision 2 cancels what revision 1 sent; goods that came close short', () => {
    const none = new Set<string>()
    expect(cancelLineHeld(order('DRAFT'), leatherLine(), none, buyer)).toEqual({ key: 'line.held.newInDraft' })
    const draftTwo = order('DRAFT', { revision: 2 })
    expect(cancelLineHeld(draftTwo, protectorLine(), addedInDraft(revisionsDraftTwo()), buyer)).toBeNull()
    expect(cancelLineHeld(draftTwo, protectorLine(), new Set([protectorLine().id]), buyer)).toEqual({ key: 'line.held.newInDraft' })
    expect(cancelLineHeld(order('SENT'), leatherLine(), none, buyer)).toBeNull()
    expect(cancelLineHeld(order('PARTLY_RECEIVED'), leatherLine({ receivedBaseQuantity: '10.0000' }), none, buyer)).toEqual({ key: 'line.held.cameCloseShort' })
    expect(cancelLineHeld(order('SENT'), leatherLine({ ended: { kind: 'CANCELLED', at: 'x', byId: null, reason: null } }), none, buyer)).toEqual({ key: 'line.held.cancelled' })
  })

  it('close short: part came, the rest still expected, on a partly received order', () => {
    expect(closeShortHeld(order('PARTLY_RECEIVED'), leatherLine({ receivedBaseQuantity: '212.4000' }), buyer)).toBeNull()
    expect(closeShortHeld(order('PARTLY_RECEIVED'), leatherLine({ receivedBaseQuantity: '0.0000' }), buyer)).toEqual({ key: 'line.held.nothingCameLine' })
    expect(closeShortHeld(order('PARTLY_RECEIVED'), protectorLine({ receivedBaseQuantity: '24.0000' }), buyer)).toEqual({ key: 'line.held.allCameLine' })
    expect(closeShortHeld(order('CONFIRMED'), leatherLine(), buyer)).toEqual({ key: 'line.held.nothingCame' })
    expect(closeShortHeld(order('PARTLY_RECEIVED'), leatherLine({ receivedBaseQuantity: '212.4000' }), planner)).toEqual({ key: 'buying:held.noManage' })
  })

  it('the reach: allowed → nothing held; refused → our words from the facts, never the API sentence', () => {
    const none = new Set<string>()
    expect(reachHeld(order('SENT'), 'CANCEL_ORDER', reachOf('CANCEL_ORDER', order('SENT')), none, buyer)).toBeNull()
    const refused = reachOf('CANCEL_ORDER', order('PARTLY_RECEIVED'), { allowed: false, problems: ['Goods were received…'] })
    expect(reachHeld(order('PARTLY_RECEIVED'), 'CANCEL_ORDER', refused, none, buyer)).toEqual({ key: 'buying:po.cancelHeld.received' })
    const partly = order('PARTLY_RECEIVED', { lines: [leatherLine({ receivedBaseQuantity: '0.0000' })] })
    expect(reachHeld(partly, 'CLOSE_SHORT', reachOf('CLOSE_SHORT', partly, { allowed: false }), none, buyer)).toEqual({ key: 'reach.held.someLine', params: { seq: 10 } })
    expect(reachHeld(order('SENT'), 'CANCEL_ORDER', reachOf('CANCEL_ORDER', order('SENT'), { mayDo: false }), none, planner)).toEqual({ key: 'buying:held.noSend' })
  })
})

describe('the list: due this week and late as saved views; Send n', () => {
  it('the address and the API filters', () => {
    expect(orderViewOf(params('due=THIS_WEEK'))).toBe('dueThisWeek')
    expect(orderViewOf(params('due=LATE'))).toBe('deliveryLate')
    expect(orderViewOf(params('pastConfirmBy=true'))).toBe('pastConfirmBy')
    expect(orderQuery('dueThisWeek', '')).toEqual({ status: null, waitingOver48h: false, q: '', cursor: null, due: 'THIS_WEEK' })
    expect(orderQuery('pastConfirmBy', '')).toEqual({ status: null, waitingOver48h: false, q: '', cursor: null, pastConfirmBy: true })
    const due = ORDER_TILES.find((tile) => tile.id === 'dueThisWeek')!
    expect(due.count({ drafts: 0, waiting: 0, notConfirmedAfter48h: 0, changesProposed: 0, declined: 0, dueThisWeek: null, late: null, pastConfirmBy: 0 })).toBeNull()
    expect(due.count({ drafts: 0, waiting: 0, notConfirmedAfter48h: 0, changesProposed: 0, declined: 0, dueThisWeek: 3, late: 1, pastConfirmBy: 0 })).toBe(3)
  })

  it('Send n: one card per supplier; held cards say why; only the ready ones are sent with their chosen confirm-by', () => {
    const groups = cardsBySupplier(SEND_CARDS, (id) => ({ [SEND_CARDS[0]!.partyId!]: 'Conceria Demo', [SEND_CARDS[2]!.partyId!]: 'Protezioni Prova', [SEND_CARDS[3]!.partyId!]: 'Tessitura Esempio' })[id ?? ''] ?? '?')
    expect(groups.map((group) => [group.name, group.cards.length])).toEqual([
      ['Conceria Demo', 2],
      ['Protezioni Prova', 1],
      ['Tessitura Esempio', 1],
    ])
    expect(cardHeld(SEND_CARDS[2]!)).toEqual({ key: 'buying:po.check.LINE_NOT_PRICED' })
    expect(cardHeld(SEND_CARDS[3]!)).toEqual({ key: 'sendMany.held.notDraft' })
    expect(sendManyBody(SEND_CARDS, { [SEND_CARDS[1]!.id]: '2026-11-02T11:00:00.000Z' })).toEqual([
      { id: SEND_CARDS[0]!.id, version: 2 },
      { id: SEND_CARDS[1]!.id, version: 2, confirmBy: '2026-11-02T11:00:00.000Z' },
    ])
    expect(outcomeWords(SEND_OUTCOMES[0]!)).toEqual({ key: 'sendMany.sent', params: { to: 'ordini@tannery-demo.example.com' } })
    expect(outcomeWords(SEND_OUTCOMES[1]!)).toEqual({ key: 'sendMany.refused.conflict' })
  })

  it('Requests to buy is an Office page with its list address (B-W2a-69 nav)', () => {
    expect(OFFICE_PAGES.has('/purchasing/requests')).toBe(true)
    expect(LIST_PAGES['/purchasing/requests']).toBe('/purchasing/requests')
  })
})

describe('the API calls', () => {
  it('Send n posts each order with its version and one Idempotency-Key; the reach names its lines comma-separated', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      const body = String(url).includes('/send-many')
        ? { sent: 1, refused: 0, outcomes: [SEND_OUTCOMES[0]] }
        : { ...reachOf('CLOSE_SHORT', order('PARTLY_RECEIVED')) }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fetcher as unknown as typeof fetch, csrfToken: () => 'csrf' })
    const outcomes = await sendMany(api, { orders: [{ id: 'a', version: 3 }], message: null }, 'key-1')
    expect(outcomes[0]!.outcome).toBe('SENT')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ orders: [{ id: 'a', version: 3 }], message: null })
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe('key-1')
    const reach = await getReach(api, 'po1', 'CLOSE_SHORT', ['l1', 'l2'])
    expect(reach.action).toBe('CLOSE_SHORT')
    expect(calls[1]!.url).toContain('/purchasing/orders/po1/reach?action=CLOSE_SHORT&lineIds=l1%2Cl2')
  })

  it('an order read before B-W2a-52 (no confirm-by, no ended lines) still parses', async () => {
    const { confirmBy: _c, openNetAmount: _o, ...old } = { ...order('SENT'), confirmBy: null, openNetAmount: 1 }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ order: { ...old, lines: old.lines.map(({ ended: _e, ...line }) => line) } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fetcher as unknown as typeof fetch, csrfToken: () => 'csrf' })
    const read = await getOrder(api, 'po1')
    expect(read.confirmBy ?? null).toBeNull()
    expect(read.lines.every((line) => !line.ended)).toBe(true)
  })
})

const LEFT_KEY =
  /\b(?:tile|view|delivery|language|list|sendMany|send|change|counter|revisionDraft|revisions|field|value|reminders|confirmBy|remind|line|ended|closeShort|end|cancel|reach|refused|notice|common|po|held|problem|record|uom|poStatus|rcStatus|rc|live)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names and example mail domains are said on purpose. */
const SAID = /\b(?:purchasing\.[a-z.]+|money\.cost|[a-z-]+\.example\.com|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'buying', 'lists', 'records', 'send']) }, createElement(View, { model })))
}

describe('every design case of the PO list and studio draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the W2a parts say what they do', () => {
    const html = (screen: DesignScreen<unknown>, id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    const record = recordScreen as unknown as DesignScreen<unknown>
    const list = listScreen as unknown as DesignScreen<unknown>
    expect(html(record, 'w2a-revision-draft', 'en')).toContain('Revision 2 draft — the supplier sees it after you send it')
    expect(html(record, 'w2a-revision-draft', 'it')).toContain('Bozza della revisione 2')
    expect(html(record, 'w2a-revisions', 'en')).toContain('Quantity: 420 ft² → 560 ft²')
    expect(html(record, 'w2a-revisions', 'en')).toContain('Net: €1,920.00 → €2,352.00')
    expect(html(record, 'w2a-revisions-no-cost', 'en')).not.toContain('€')
    expect(html(record, 'w2a-reminders', 'en')).toContain('Off for this company')
    expect(html(record, 'w2a-cancel-confirmed', 'en')).toContain('cancelling ends a contract')
    expect(html(record, 'w2a-cancel-confirmed', 'en')).toContain('WO-2026-0221')
    expect(html(record, 'w2a-close-short', 'it')).toContain('Chiudi 1 riga a saldo')
    expect(html(record, 'w2a-send-revision', 'en')).toContain('The supplier reads what changed in revision 2')
    expect(html(list, 'w2a-send-many', 'en')).toContain('Send 2 orders')
    expect(html(list, 'w2a-tiles-unknown', 'en')).toContain('Due this week')
  })

  it('has words for every delivery state, revision answer, diff kind and line end in both languages', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['purchasing-orders'])['purchasing-orders'] ?? {})
      const has = (key: string) => expect(words(key), `${locale}: ${key}`).not.toBe(key)
      for (const state of DELIVERY_STATES) has(`delivery.${state}`)
      for (const answer of REVISION_ANSWERS) has(`revisions.answer.${answer}`)
      for (const kind of LINE_DIFF_KINDS) has(`revisions.kind.${kind}`)
      for (const kind of ['CANCELLED', 'CLOSED_SHORT']) has(`ended.${kind}`)
    }
  })
})
