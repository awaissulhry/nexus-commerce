import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { ORDER_CHIPS as DOMAIN_CHIPS, SUPPLIER_STATES as DOMAIN_STATES } from '@nexus/factory-domain/purchasing/portal-orders/views'
import { PORTAL_DECLINE_REASONS as DOMAIN_DECLINES, PORTAL_DECLINE_WORDS, PORTAL_LINE_ANSWERS as DOMAIN_ANSWERS } from '@nexus/factory-domain/purchasing/portal-orders/answer'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as homeScreen } from '../home/fixtures'
import { ORDER_CHIPS, PORTAL_DECLINE_REASONS, PORTAL_LINE_ANSWERS, SUPPLIER_STATES } from './api'
import { confirmedPage, LINES, orderPage, proposedPage, revisedPage, ROWS } from './design-data'
import { designScreen as listScreen } from './fixtures'
import { kindsOf, lineBodyOf, lineRequestOf, lineTitle, openLines } from '../../../lib/po-answer/lines'
import {
  bulkConfirmHeld,
  changeItems,
  confirmableOf,
  confirmAllBody,
  confirmBodyOf,
  declineHeld,
  declineReasonOf,
  deliveryOf,
  draftOfProposal,
  historySteps,
  lineDeliveryOf,
  listQuery,
  NS,
  ordersCsv,
  outcomeOf,
  problemOf,
  recordHref,
  requestsAbout,
  sendHeld,
  stateTone,
  tabOf,
  wasOf,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * SCR-189 (B-W2b-179): the supplier's orders, pure — the answer the API takes from the DS part's drafts, what it comes to,
 * why Send waits, a stored proposal read back, "Answers so far", the list's CSV (never a price) — the words in both
 * languages for every code the API can send, and every design case drawn in Italian and English with no key and no money.
 */

const TODAY = '2026-11-08'
const t = createTranslator('en', CATALOGUE.en[NS] ?? {})
const words = { t, locale: 'en' as const, day: (iso: string) => iso }
const facts = { canAnswer: true, mayAnswer: true, preview: false, offline: false, busy: false }

describe('the web keeps the API’s codes', () => {
  it('chips, states, line answers and decline reasons are the domain’s', () => {
    expect(ORDER_CHIPS).toEqual(DOMAIN_CHIPS)
    expect(SUPPLIER_STATES).toEqual(DOMAIN_STATES)
    expect(PORTAL_LINE_ANSWERS).toEqual(DOMAIN_ANSWERS)
    expect(PORTAL_DECLINE_REASONS).toEqual(DOMAIN_DECLINES)
  })
})

describe('a line answered with the DS part', () => {
  it('maps the part’s kinds to the API’s (CANNOT ↔ CANNOT_DELIVER) and leaves out unknown ones', () => {
    expect(kindsOf(['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER', 'SUBSTITUTE', 'CHANGE', 'SOMETHING'])).toEqual(['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT', 'SUBSTITUTE', 'CHANGE'])
  })

  it('writes each answer as the API takes it, quantities from the page’s language', () => {
    expect(lineBodyOf('l', null, 'it')).toEqual({ lineId: 'l', answer: 'AS_ASKED' })
    expect(lineBodyOf('l', { kind: 'OTHER', quantity: '1.200,5', date: '', reason: ' later ' }, 'it')).toEqual({ lineId: 'l', answer: 'OTHER', quantity: '1200.5', date: null, reason: 'later' })
    expect(lineBodyOf('l', { kind: 'SPLIT', deliveries: [{ quantity: '700', date: '2026-11-14' }, { quantity: '500', date: '2026-11-28' }], reason: 'x' }, 'en').deliveries).toEqual([
      { quantity: '700', date: '2026-11-14' },
      { quantity: '500', date: '2026-11-28' },
    ])
    expect(lineBodyOf('l', { kind: 'SUBSTITUTE', quantity: '', date: '', substituteId: '', substitute: 'Our nappa 1.3 mm', reason: '' }, 'en')).toEqual({ lineId: 'l', answer: 'SUBSTITUTE', quantity: null, date: null, substituteItemId: null, substituteNote: 'Our nappa 1.3 mm', reason: null })
    expect(lineBodyOf('l', { kind: 'CHANGE', reason: 'Two dye batches' }, 'en')).toEqual({ lineId: 'l', answer: 'CHANGE', reason: 'Two dye batches' })
  })

  it('asks a line in the supplier’s terms: their code first, the facts, the Cr VI report, the articles offered, a confirmed line locked', () => {
    const leather = lineRequestOf(LINES[0]!, words, [{ itemId: 'i2', code: 'ALT', name: 'Other' }])
    expect(leather).toMatchObject({ title: 'VACH-NAPPA-12 · Vacchetta nappa demo', asked: { plain: '1200.0000', date: LINES[0]!.needDate }, tags: [{ tone: 'warning' }], substitutes: [{ id: 'i2', label: 'ALT · Other' }] })
    expect(leather.details!.join(' · ')).toContain('one dye batch')
    expect(lineRequestOf({ ...LINES[1]!, locked: true, confirmedQuantity: '350.0000', confirmedDate: '2026-11-20' }, words).locked).toMatch(/^Confirmed: 350 m by 2026-11-20$/)
    expect(lineTitle({ code: null, name: null, description: 'Spare part' })).toBe('Spare part')
  })
})

describe('the answer', () => {
  const page = orderPage()
  const requests = page.lines.map((line) => lineRequestOf(line, words))

  it('every line as asked confirms all as asked; anything else goes line by line, the open lines only', () => {
    expect(confirmBodyOf(page, { answers: {}, supplierRef: ' CP-1 ', note: '' }, 'en')).toEqual({ version: 4, mode: 'ALL_AS_ASKED', supplierRef: 'CP-1', note: null })
    const locked = { ...page, lines: [{ ...page.lines[0]!, locked: true }, ...page.lines.slice(1)] }
    const body = confirmBodyOf(locked, { answers: { [LINES[1]!.id]: { kind: 'CANNOT', reason: 'No stock' } }, supplierRef: '', note: '' }, 'en')
    expect(body.mode).toBe('BY_LINE')
    expect(body.lines!.map((line) => line.lineId)).toEqual(openLines(locked.lines).map((line) => line.id))
    expect(confirmAllBody(7)).toEqual({ version: 7, mode: 'ALL_AS_ASKED', supplierRef: null, note: null })
  })

  it('comes to what the API says: a decline only when no line was confirmed before', () => {
    const cannot = Object.fromEntries(requests.map((line) => [line.id, { kind: 'CANNOT' as const, reason: 'x' }]))
    expect(outcomeOf(requests, {})).toBe('CONFIRMED')
    expect(outcomeOf(requests, cannot)).toBe('DECLINED')
    expect(outcomeOf([{ ...requests[0]!, locked: true }, ...requests.slice(1)], cannot)).toBe('PROPOSED')
  })

  it('Send waits with its reason, in order: preview, answered, no approve, offline, busy, an incomplete line, too long', () => {
    const draft = { answers: {}, supplierRef: '', note: '' }
    expect(sendHeld(requests, draft, facts, TODAY, 'en')).toBeNull()
    expect(sendHeld(requests, draft, { ...facts, preview: true, mayAnswer: false }, TODAY, 'en')).toBe('held.preview')
    expect(sendHeld(requests, draft, { ...facts, canAnswer: false }, TODAY, 'en')).toBe('held.answered')
    expect(sendHeld(requests, draft, { ...facts, mayAnswer: false }, TODAY, 'en')).toBe('held.mayAnswer')
    expect(sendHeld(requests, draft, { ...facts, offline: true }, TODAY, 'en')).toBe('held.offline')
    expect(sendHeld(requests, draft, { ...facts, busy: true }, TODAY, 'en')).toBe('held.busy')
    expect(sendHeld(requests, { ...draft, answers: { [requests[0]!.id]: { kind: 'OTHER', quantity: '', date: '', reason: '' } } }, facts, TODAY, 'en')).toBe('held.incomplete')
    expect(sendHeld(requests, { ...draft, supplierRef: 'x'.repeat(61) }, facts, TODAY, 'en')).toBe('held.ref')
  })

  it('reads a stored proposal back as the part’s answers (shown read-only)', () => {
    const proposed = proposedPage()
    expect(draftOfProposal(proposed.lines[0]!, 'it')).toBeNull()
    expect(draftOfProposal(proposed.lines[1]!, 'it')).toMatchObject({ kind: 'OTHER', quantity: '350', reason: expect.any(String) })
    expect(draftOfProposal(proposed.lines[2]!, 'it')).toMatchObject({ kind: 'SUBSTITUTE', substituteId: expect.any(String) })
  })

  it('a decline for another reason says why; the stored reason is said again in the page’s words', () => {
    const decline = { reason: 'OTHER' as const, note: '', tried: true }
    expect(declineHeld(decline, facts)).toBe('decline.held.note')
    expect(declineHeld({ ...decline, note: 'Closed in August' }, facts)).toBeNull()
    expect(declineHeld({ ...decline, reason: 'PRICE' }, { ...facts, mayAnswer: false })).toBe('held.mayAnswer')
    for (const reason of PORTAL_DECLINE_REASONS) {
      expect(declineReasonOf(`${PORTAL_DECLINE_WORDS[reason]}.`)).toEqual({ reason, note: null })
      expect(declineReasonOf(`${PORTAL_DECLINE_WORDS[reason]}: busy`)).toEqual({ reason, note: 'busy' })
    }
    expect(declineReasonOf('Something else')).toEqual({ reason: null, note: 'Something else' })
  })

  it('a refusal in the page’s words', () => {
    expect(problemOf('conflict')).toBe('changed')
    expect(problemOf('forbidden')).toBe('forbidden')
    expect(problemOf(null)).toBe('internal')
  })
})

describe('the record', () => {
  it('opens a tab by its address; a revision marks what changed; delivery by what was received', () => {
    expect(tabOf('confirm')).toBe('confirm')
    expect(tabOf('nonsense')).toBe('lines')
    expect(recordHref('/p/X', 'po', 'lines', 'l1')).toBe('/p/X/orders/po?tab=lines&line=l1')
    const revised = revisedPage()
    expect(wasOf(revised, LINES[0]!.id)).toEqual({ quantity: '1200.0000', needDate: null, added: false })
    expect(changeItems(revised.changes!).map((item) => item.seq)).toEqual([10, 20])
    const confirmed = confirmedPage()
    expect(confirmed.lines.map(lineDeliveryOf)).toEqual(['partly', 'open', 'open'])
    expect(lineDeliveryOf({ ended: 'CANCELLED', receivedBase: '0', baseQuantity: '1' })).toBe('cancelled')
    expect(lineDeliveryOf({ ended: null, receivedBase: '5', baseQuantity: '5' })).toBe('delivered')
  })

  it('“Answers so far”: each version as sent, the answer and our decision', () => {
    const steps = historySteps(revisedPage().history)
    expect(steps.map((step) => step.words.key)).toEqual(['history.sent', 'history.confirmedBy', 'history.sent', 'history.waiting'])
    const refused = historySteps(proposedPage('REFUSED').history)
    expect(refused.map((step) => step.words.key)).toEqual(['history.sent', 'history.proposedBy', 'history.decision.REFUSED'])
  })

  it('Documents lists our requests about this order, never its confirmation request', () => {
    const rows = [
      { kind: 'CONFIRM_PO', href: '/p/X/open/PurchaseOrder/po1#task:a' },
      { kind: 'UPLOAD_DOCUMENT', href: '/p/X/open/PurchaseOrder/po1#task:b' },
      { kind: 'UPLOAD_DOCUMENT', href: '/p/X/open/PurchaseOrder/po2#task:c' },
    ]
    expect(requestsAbout(rows, 'po1')).toEqual([rows[1]])
  })
})

describe('the list', () => {
  it('chips in the address, tones and delivery words, what the bulk confirm reaches', () => {
    expect(listQuery(null, '')).toBe('')
    expect(listQuery('ALL', ' CP-1 ')).toBe('?chip=ALL&q=CP-1')
    expect(stateTone('TO_CONFIRM')).toBe('warning')
    expect(deliveryOf(ROWS[2]!)).toMatchObject({ key: 'delivery.late', tone: 'danger' })
    expect(confirmableOf(ROWS, [ROWS[0]!.id, ROWS[2]!.id]).map((row) => row.id)).toEqual([ROWS[0]!.id])
    expect(bulkConfirmHeld(0, { mayAnswer: true, preview: false, offline: false, busy: false })).toBe('held.noneToConfirm')
    expect(bulkConfirmHeld(2, { mayAnswer: false, preview: false, offline: false, busy: false })).toBe('held.mayAnswer')
  })

  it('exports a view as CSV in the person’s words, never a price', () => {
    const csv = ordersCsv(ROWS, t, 'en')
    expect(csv.split('\r\n')).toHaveLength(ROWS.length + 1)
    expect(csv.split('\r\n')[0]).toBe('Our PO,Your confirmation no.,Sent on,Version,Lines,Earliest date needed,Status,Delivery')
    expect(csv).not.toMatch(/€|price|prezzo|amount/i)
  })
})

describe('words', () => {
  const has = (locale: 'it' | 'en', key: string) => key in (CATALOGUE[locale][NS] ?? {}) || `${key}_other` in (CATALOGUE[locale][NS] ?? {})
  it('every code the pages word has its words in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const keys = [
        ...SUPPLIER_STATES.flatMap((state) => [`answered.${state}.title`, `answered.${state}.body`]),
        ...ORDER_CHIPS.map((chip) => `list.noneIn.${chip}`),
        ...PORTAL_DECLINE_REASONS.map((reason) => `decline.reasons.${reason}`),
        ...['changed', 'invalid', 'forbidden', 'missing', 'rateLimited', 'unavailable', 'internal'].map((problem) => `problem.${problem}`),
        ...['CONFIRMED', 'PROPOSED', 'DECLINED'].flatMap((outcome) => [`answer.outcome.${outcome}`, `done.${outcome}.title`, `done.${outcome}.body`, `done.${outcome}.next`]),
        ...['ADDED', 'REMOVED', 'CANCELLED', 'CHANGED'].map((kind) => `changes.kind.${kind}`),
        ...['open', 'partly', 'delivered', 'cancelled', 'closedShort'].map((state) => `lines.delivery.${state}`),
        ...UOMS.map((uom) => `uom.${uom}`),
      ]
      expect(keys.filter((key) => !has(locale, key)), locale).toEqual([])
    }
  })
})

const KEY = /\b(?:list|row|bulk|held|confirmAll|decline|changes|record|tabs|order|lines|answer|answered|proposal|done|problem|history|asn|docs|messages|unsaved|noAccess|home|tiles|band|keys|chips|col|delivery|state|ref|uom|tasks|nav|notice|thread)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
// C2: no amount, currency or price field on a supplier page (the words “price” in a sentence about price talk are allowed).
const MONEY = /€|\bEUR\b|unitPrice|netAmount|\bamount\b/i

describe('SCR-189 design cases', () => {
  for (const screen of [homeScreen, listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: every case draws in Italian and English with no raw key and no money`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${screen.screen}/${entry.id} (${locale})`).toContain('main-content')
          expect(html.match(KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${entry.id} (${locale}): money on a supplier page`).not.toMatch(MONEY)
          expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        }
      }
    })
  }
})
