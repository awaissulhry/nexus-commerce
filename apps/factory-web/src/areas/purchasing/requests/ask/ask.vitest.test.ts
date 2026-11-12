import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PURCHASE_REQUEST_STATUSES } from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { ROLES } from '../../../_shared/buying/fixtures'
import { rejectHeld, requestsCan, sourcePhrase, say as sayRequests, selectableWhy, statusPhrase } from '../model'
import { askFromShortage, askToBuy, cancelAsked, listAsked } from './api'
import { asked, designScreen as askScreen, OPTIONS } from './fixtures'
import { askBodyOf, askCan, doneOf, mineSelectableWhy, newDraft, say, sendHeld, sendRefusal, shortageBodyOf, shortageDraft, takeBackHeld, withMaterial, type AskModel, type ShortageLine } from './model'
import { designScreen as shortageScreen } from './shortage/fixtures'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so the dialog's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * Ask to buy (B-W2b-332; SCR-356, SCR-357): who may ask, why "Send request" is held, the bodies the API takes, a refusal in
 * our words, the asker's own list, the queue's words for an asked request, the calls as the API takes them, and every design
 * case drawn in Italian and English with no message key or placeholder left on screen.
 */

const TODAY = '2026-11-12'
const words = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, ['purchasing-ask'])['purchasing-ask'] ?? {})
const requestWords = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, ['purchasing-requests'])['purchasing-requests'] ?? {})
const can = askCan([...ROLES.planner, 'purchasing.requests.ask'])
const model = (over: Partial<AskModel> = {}): AskModel => ({ prefix: '/w/DEMO', can, draft: newDraft(TODAY, OPTIONS.siteId), shortage: null, options: { status: 'ready', value: OPTIONS }, busy: false, offline: false, problem: null, done: null, ...over })
const leather = OPTIONS.materials[0]!
const LINE: ShortageLine = { siteId: 's1', workOrder: { id: 'w1', number: 'WO-1' }, material: { itemId: leather.id, itemColourId: null, label: 'DEMO-LEA-01', uom: 'FT2' }, word: 'NOT_ENOUGH', short: '18.0000', neededBy: '2026-11-10' }

describe('ask to buy: who may ask, the draft, why Send is held', () => {
  it('reads the rights: anyone who may ask; drafting a PO is the buyer’s', () => {
    expect(askCan(['purchasing.requests.ask'])).toEqual({ ask: true, draft: false, view: false })
    expect(askCan([...ROLES.buyer, 'purchasing.requests.ask'])).toEqual({ ask: true, draft: true, view: true })
    expect(askCan(ROLES.readOnly).ask).toBe(false)
  })

  it('holds Send with the first thing missing, in order', () => {
    const t = words('en')
    const held = (over: Partial<AskModel>) => {
      const phrase = sendHeld(model(over))
      return phrase ? say(t, phrase) : null
    }
    expect(held({ can: { ...can, ask: false } })).toMatch(/needs purchasing.requests.ask/)
    expect(held({ options: { status: 'loading' } })).toBe('Still reading the materials.')
    expect(held({})).toBe('Pick the material first.')
    const picked = withMaterial(model().draft, leather)
    expect(picked.uom).toBe('FT2')
    expect(held({ draft: picked })).toBe('Pick the colour first.')
    const ready = { ...picked, itemColourId: leather.colours[0]!.id, quantity: '40', reason: 'Per la campionatura' }
    expect(held({ draft: { ...ready, quantity: '0' } })).toMatch(/^Type how much/)
    expect(held({ draft: { ...ready, needDate: '2026-11-11' } })).toBe('Pick a day from today on.')
    expect(held({ draft: { ...ready, reason: ' ' } })).toBe('Say why it is needed.')
    expect(held({ draft: ready, offline: true })).toMatch(/^Offline/)
    expect(held({ draft: ready, busy: true })).toBe('Sending…')
    expect(held({ draft: ready })).toBeNull()
  })

  it('a shortage: what is short, by today when that has passed; a buyer drafts at once, others send to the buyers', () => {
    const draft = shortageDraft(LINE, TODAY, 'Mancanza per WO-1', false)
    expect(draft).toMatchObject({ mode: 'SHORTAGE', quantity: '18.0000', needDate: TODAY, then: 'REQUEST', workOrderId: 'w1' })
    expect(shortageDraft(LINE, TODAY, 'x', true).then).toBe('DRAFT')
    expect(sendHeld(model({ draft: { ...draft, then: 'DRAFT' }, shortage: LINE }))?.key).toBe('held.noDraft')
    expect(sendHeld(model({ draft, shortage: LINE }))).toBeNull()
    expect(shortageBodyOf(draft, LINE)).toEqual({ siteId: 's1', workOrderId: 'w1', itemId: leather.id, itemColourId: null, reason: 'Mancanza per WO-1', then: 'REQUEST', note: null })
  })

  it('writes the bodies the API takes (a comma is a decimal point; empty words are left out)', () => {
    const draft = { ...withMaterial(newDraft(TODAY, 's1'), leather), itemColourId: 'c1', quantity: ' 2,5 ', reason: ' Serve ', description: '  ', note: '' }
    expect(askBodyOf(draft)).toEqual({ siteId: 's1', itemId: leather.id, itemColourId: 'c1', description: null, quantity: '2.5', uom: 'FT2', needDate: '2026-11-19', reason: 'Serve', workOrderId: null, note: null })
  })

  it('says what happened: sent, waiting for a yes, drafted', () => {
    expect(doneOf({ request: asked(1), approval: { asked: false, taskId: null, approverRoleId: null, approverUserId: null, dueAt: null } }).kind).toBe('sent')
    expect(doneOf({ request: asked(1, { status: 'PENDING_APPROVAL' }), approval: { asked: true, taskId: 't', approverRoleId: null, approverUserId: null, dueAt: null } }).kind).toBe('waiting')
    expect(doneOf({ request: asked(1, { status: 'CONVERTED' }), approval: null, draft: { purchaseOrderId: 'p', number: 'PO-1', created: true, purchaseOrderLineId: 'l' } })).toMatchObject({ kind: 'drafted', order: { number: 'PO-1', created: true } })
  })

  it('says a refusal in our words, from the path or the conflict', () => {
    const refused = (kind: 'invalid' | 'conflict' | 'forbidden', message: string, paths: string[] = []) => sendRefusal(new ApiError(kind, kind === 'invalid' ? 400 : kind === 'forbidden' ? 403 : 409, kind, message, null, paths.map((path) => ({ path, message: 'x' }))))
    expect(refused('invalid', 'x', ['body/workOrderId']).key).toBe('refused.workOrderId')
    expect(refused('conflict', 'This work order is not short of this material any more: nothing to ask.').key).toBe('refused.shortageGone')
    expect(refused('conflict', 'This shortage was asked already: its request waits for the buyer.').key).toBe('refused.shortageAsked')
    expect(refused('conflict', 'x', ['approver']).key).toBe('refused.approverSelf')
    expect(refused('forbidden', 'x').key).toBe('problem.forbidden')
  })

  it('the asker’s list: only a request still to decide may be taken back', () => {
    expect(mineSelectableWhy(asked(1))).toBeNull()
    expect(mineSelectableWhy(asked(2, { status: 'CONVERTED', cancel: { allowed: false, why: 'x' } }))?.key).toBe('mine.decided')
    expect(mineSelectableWhy(asked(3, { cancel: { allowed: false, why: 'x' } }))?.key).toBe('mine.notYours')
    expect(takeBackHeld([], false)?.key).toBe('held.selectFirst')
    expect(takeBackHeld([asked(1)], true)?.key).toBe('held.offline')
    expect(takeBackHeld([asked(1)], false)).toBeNull()
  })
})

describe('the buyer’s queue: a request asked in the office (kind ASKED)', () => {
  const t = requestWords('en')
  const row = (status: 'OPEN' | 'WAITING_APPROVAL' | 'SET_ASIDE', shortage = false) =>
    ({
      id: 'asked:x',
      kind: 'ASKED',
      refId: 'x',
      status,
      plan: null,
      reorder: null,
      hold: status === 'WAITING_APPROVAL' ? { code: 'WAITING_APPROVAL', message: 'x' } : null,
      asked: { requestedBy: { id: 'u', name: 'Anna' }, source: shortage ? 'SHORTAGE' : 'OFFICE', workOrder: shortage ? { id: 'w', number: 'WO-7' } : null, purchaseOrder: null },
    }) as never
  it('says who asked and where it stands', () => {
    expect(sayRequests(t, sourcePhrase(row('OPEN')))).toBe('Anna asked')
    expect(sayRequests(t, sourcePhrase(row('OPEN', true)))).toBe('WO-7 shortage · Anna asked')
    expect(sayRequests(t, statusPhrase(row('WAITING_APPROVAL')))).toBe('Waits for a yes')
    expect(sayRequests(t, statusPhrase(row('SET_ASIDE')))).toBe('Refused')
    expect(sayRequests(t, selectableWhy(row('WAITING_APPROVAL'))!)).toMatch(/^It waits for a yes first/)
  })
  it('refusing an asked request is the buyer’s (purchasing.manage), a plan line planning’s', () => {
    expect(rejectHeld([row('OPEN')], requestsCan(ROLES.planner), false)?.key).toBe('held.noManageReject')
    expect(rejectHeld([row('OPEN')], requestsCan(ROLES.buyer), false)).toBeNull()
  })
})

describe('the calls, as the API takes them', () => {
  const recorded: { url: string; method: string; body: unknown; key: string | null }[] = []
  const api: ApiClient = createApiClient({
    baseUrl: 'http://api.test',
    csrfToken: () => 'csrf',
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      recorded.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
      const reply = String(input).includes('/ask-to-buy?') ? { asOf: 'x', requests: [], nextCursor: null } : String(input).endsWith('/cancel') ? { requests: [] } : String(input).endsWith('/from-shortage') ? { request: asked(1), approval: null, draft: null } : { request: asked(1), approval: { asked: false, taskId: null, approverRoleId: null, approverUserId: null, dueAt: null } }
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  it('asks, asks from a shortage, lists one’s own, takes back — each write with its key', async () => {
    await askToBuy(api, askBodyOf({ ...withMaterial(newDraft(TODAY, 's1'), leather), quantity: '4', reason: 'x' }), 'k1')
    await askFromShortage(api, shortageBodyOf(shortageDraft(LINE, TODAY, 'y', false), LINE), 'k2')
    await listAsked(api, { mine: true, status: 'ALL' })
    await cancelAsked(api, { requests: [{ id: 'a', version: 1 }], reason: 'z' }, 'k3')
    expect(recorded.map((entry) => `${entry.method} ${entry.url.replace('http://api.test', '')}`)).toEqual([
      'POST /purchasing/ask-to-buy',
      'POST /purchasing/ask-to-buy/from-shortage',
      'GET /purchasing/ask-to-buy?status=ALL&mine=true&limit=100',
      'POST /purchasing/ask-to-buy/cancel',
    ])
    expect(recorded.map((entry) => entry.key)).toEqual(['k1', 'k2', null, 'k3'])
  })
})

const LEFT_KEY = /\b(?:common|band|action|options|field|shortage|then|done|held|problem|refused|status|source|mine|uom|title)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs purchasing.requests.ask"). */
const SAID = /\b(?:purchasing\.[a-z.]+)\b/g

function render(screen: DesignScreen<unknown>, value: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'purchasing-ask']) }, createElement(View, { model: value })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [askScreen, shortageScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, { timeout: 120_000 }, () => {
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

  it('draws what matters', () => {
    const html = (screen: DesignScreen<unknown>, id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    const ask = askScreen as unknown as DesignScreen<unknown>
    const short = shortageScreen as unknown as DesignScreen<unknown>
    expect(html(ask, 'filled', 'en')).toContain('Send request')
    expect(html(ask, 'filled', 'it')).toContain('Invia la richiesta')
    expect(html(ask, 'sent-waiting', 'en')).toContain('it waits for a yes first')
    // The list's rows draw in the browser only (the grid); the page's band and the take-back dialog draw here.
    expect(html(ask, 'mine', 'en')).toContain('Your requests to buy')
    expect(html(ask, 'mine-take-back-ready', 'it')).toContain('Ritira 1')
    expect(html(short, 'buyer-draft', 'en')).toContain('Draft the purchase order now')
    expect(html(short, 'planner', 'en')).not.toContain('Draft the purchase order now')
    expect(html(short, 'drafted-new', 'en')).toContain('PO-2026-0032')
    expect(html(ask, 'filled', 'en')).not.toContain('€')
  })

  it('has words for every status and unit in both languages', () => {
    for (const locale of LOCALES) {
      const t = words(locale)
      for (const status of PURCHASE_REQUEST_STATUSES) expect(t(`status.${status}`), `${locale}: ${status}`).not.toBe(`status.${status}`)
      for (const uom of UOMS) expect(t(`uom.${uom}`), `${locale}: ${uom}`).not.toBe(`uom.${uom}`)
    }
  })
})
