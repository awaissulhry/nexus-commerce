import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { linkTaskOf } from '../_nav/link-types'
import { trackingPageSchema } from './api'
import { designScreen } from './fixtures'
import { carrierPageOf, claimOfError, headerCarrierPage, keepsPolling, loadOfError, orderLabel, placeLine, searchAddress, searchFieldProblems, searchRefusal, trackerSteps } from './model'
import { sharedWith } from './model' // F-OP-133
import { typedTrackingOf } from './model' // op-24
import { hasLeadingZeroBits, solveChallenge } from './pow'

const page = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model.page!
/** A message key left on screen: one of this catalogue's top-level groups followed by a dotted name. */
const KEY = /\b(?:state|ask|pill|now|problem|step|event|by|fact|where|parcels|events|delivery|paper|papers|claim|foot|search|loading|typed /* op-24 */)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-194 Track an order — the link page (B-W2b-170)', () => {
  it('a SHIPMENT_TRACK link of a shipment opens this page (link-type registry)', () => {
    expect(linkTaskOf({ purpose: 'SHIPMENT_TRACK', record: { type: 'Shipment' } })).toBe('track-order')
  })

  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.page) expect(() => trackingPageSchema.parse(entry.model.page), entry.id).not.toThrow()
  })

  it('heads with the customer\'s own reference first; draws the furthest step reached as now', () => {
    expect(orderLabel(page('in-transit'))).toBe('4500-1234')
    // fix-portal-numbers-1 (B-TH-303): without their PO, the customer's own order number (the API's "#42"), never the office's SO-….
    expect(orderLabel({ ...page('in-transit'), order: { customerRef: null, number: '#42', otherPieces: 0 } })).toBe('#42')
    const steps = trackerSteps(page('in-transit'), (code) => code, (iso) => iso.slice(0, 10))
    expect(steps.map((step) => [step.id, step.state, step.current ?? false])).toEqual([
      ['PACKED', 'done', false],
      ['COLLECTED', 'done', false],
      ['IN_TRANSIT', 'done', true],
      ['OUT_FOR_DELIVERY', 'todo', false],
      ['DELIVERED', 'todo', false],
    ])
    expect(trackerSteps(page('delivered'), (code) => code, (iso) => iso).at(-1)).toMatchObject({ state: 'done', current: true })
  })

  it('opens the carrier\'s page only when it is https; one page for every parcel goes in the head', () => {
    expect(carrierPageOf('http://carrier.invalid/x')).toBeNull()
    expect(carrierPageOf('javascript:alert(1)')).toBeNull()
    expect(carrierPageOf('https://carrier.invalid/x')).toBe('https://carrier.invalid/x')
    expect(headerCarrierPage(page('one-parcel'))).toMatch(/^https:/)
    expect(headerCarrierPage(page('own-van'))).toBeNull()
  })

  it('says the town and postcode only', () => {
    expect(placeLine(page('in-transit').delivery)).toBe('40100 Bologna · IT')
    expect(placeLine({ city: null, postcode: null, country: null })).toBeNull()
  })

  it('reads again while packed or on the way, never once delivered', () => {
    expect(keepsPolling(page('in-transit'))).toBe(true)
    expect(keepsPolling(page('packed'))).toBe(true)
    expect(keepsPolling(page('delivered'))).toBe(false)
  })

  it('a dead link is the one 404; too many claim forms a 409; anything else: try again', () => {
    expect(loadOfError(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('dead')
    expect(loadOfError(new ApiError('unavailable', 503, 'not_ready', 'x'))).toBe('error')
    expect(claimOfError(new ApiError('conflict', 409, 'invalid_state', 'x'))).toBe('too-many')
    expect(claimOfError(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('dead')
    expect(claimOfError(new Error('offline'))).toBe('failed')
  })
})

describe('SCR-194 Find your order — the public search (/t)', () => {
  it('reads whose search it is from the address', () => {
    expect(searchAddress('Seed-Tenant', 'SCA')).toEqual({ tenant: 'seed-tenant', company: 'SCA' })
    expect(searchAddress('seed-tenant', null)).toEqual({ tenant: 'seed-tenant', company: null })
    expect(searchAddress(null, 'SCA')).toBeNull()
    expect(searchAddress('../x', 'SCA')).toBeNull()
  })

  it('says what is missing per field before sending, as the API would', () => {
    expect(searchFieldProblems('', '  ')).toEqual({ reference: 'EMPTY', postcode: 'EMPTY' })
    expect(searchFieldProblems('4500-1234', '40/100')).toEqual({ postcode: 'FORMAT' })
    expect(searchFieldProblems('x'.repeat(61), '40100')).toEqual({ reference: 'LONG' })
    expect(searchFieldProblems(' 4500-1234 ', '40 100')).toEqual({})
  })

  it('a 429 says the wait in minutes, or asks for the proof of work once', () => {
    expect(searchRefusal(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'retryAfter', message: '230' }]))).toEqual({ kind: 'wait', minutes: 4 })
    expect(searchRefusal(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'challenge', message: 'x' }]))).toEqual({ kind: 'challenge' })
    expect(searchRefusal(new ApiError('unavailable', 503, 'not_ready', 'x'))).toEqual({ kind: 'error' })
  })

  it('solves a proof-of-work challenge as the API checks it (leading zero bits of SHA-256)', async () => {
    expect(hasLeadingZeroBits(new Uint8Array([0, 0x0f]), 12)).toBe(true)
    expect(hasLeadingZeroBits(new Uint8Array([0, 0x1f]), 12)).toBe(false)
    const nonce = await solveChallenge('made-up-challenge', 8)
    expect(nonce).not.toBeNull()
  })
})

describe('SCR-194 every case', () => {
  it('draws in Italian and English with no raw key, no full address and no price', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(html, entry.id).not.toMatch(/€|EUR\b/)
      }
    }
  })

  it('a link found by the search shows no papers and holds the claim with why', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'ds-words']) }, createElement(designScreen.view, { model: designScreen.cases.find((entry) => entry.id === 'search-found')!.model })))
    expect(html).toContain('The papers come with the link in our e-mail')
    expect(html).not.toContain('Packing list SH-26-0042/2')
    expect(html).toContain('To report a problem, open the link in our e-mail, or write to us.')
  })
})

// ---- F-OP-133 (order page N6, R-5 + R-18): a passed-on link shows one order of one customer ------------------------------------
describe('F-OP-133 — a shared shipment on the link page: the order it is for, and only how many pieces of other orders', () => {
  const draw = (id: string, locale: 'it' | 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))

  it('the answer carries the count of other pieces; an older answer without it is none', () => {
    const answer = trackingPageSchema.parse({ ...page('in-transit'), order: { customerRef: '4500-1234', number: '#42', otherPieces: 3 } })
    expect(sharedWith(answer)).toEqual({ order: '4500-1234', count: 3 })
    const older = trackingPageSchema.parse({ ...page('in-transit'), order: { customerRef: '4500-1234', number: '#42' } })
    expect(older.order.otherPieces).toBe(0)
    expect(sharedWith(older)).toBeNull()
    // Without their PO: their own order number, never the office's SO-….
    expect(sharedWith(page('shared-one'))).toEqual({ order: '#42', count: 1 })
  })

  it('names this order and "and N pieces of other orders" in both languages (voi), nothing for a shipment of one order', () => {
    expect(draw('shared', 'en')).toContain('This shipment carries your order 4500-1234 and 3 pieces of other orders.')
    expect(draw('shared', 'it')).toContain('Questa spedizione porta il vostro ordine 4500-1234 e 3 pezzi di altri ordini.')
    expect(draw('shared-one', 'en')).toContain('and 1 piece of other orders.')
    expect(draw('in-transit', 'en')).not.toContain('pieces of other orders')
    expect(draw('in-transit', 'it')).not.toContain('altri ordini')
  })

  it('never another order: the page knows no other order number or PO to show (the answer has none)', () => {
    expect(Object.keys(trackingPageSchema.shape.order.shape).sort()).toEqual(['customerRef', 'number', 'otherPieces'])
    const html = draw('shared', 'en')
    expect(html).not.toMatch(/SO-\d/)
  })
})
// ---- end F-OP-133

// ---- op-24 (order page N5; B-OP-031, B-OP-034): a carrier booked by hand on the link page --------------------------------------
describe('op-24 — the number typed for a carrier booked by hand, "No live tracking", and its link (Track ›, https only)', () => {
  const draw = (id: string, locale: 'it' | 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))
  const typed = (number: string | null | undefined, url: string | null | undefined) => trackingPageSchema.parse({ ...page('in-transit'), shipment: { ...page('in-transit').shipment, typedTrackingNumber: number, typedTrackingUrl: url } })

  it('the answer carries the typed number and link; an older answer without them shows none', () => {
    expect(typedTrackingOf(typed(' T-DEMO-0001 ', 'https://track.example.com/T-DEMO-0001'))).toEqual({ number: 'T-DEMO-0001', link: 'https://track.example.com/T-DEMO-0001' })
    expect(typedTrackingOf(typed('T-DEMO-0001', null))).toEqual({ number: 'T-DEMO-0001', link: null })
    expect(typedTrackingOf(page('in-transit'))).toBeNull()
    expect(typedTrackingOf(typed('   ', 'https://track.example.com/T-1'))).toBeNull()
    expect(typedTrackingOf(typed(null, 'https://track.example.com/T-1'))).toBeNull()
  })

  it('a link that is not https is never drawn', () => {
    for (const bad of ['http://track.example.com/T-1', 'javascript:alert(1)', 'ftp://track.example.com/T-1', '']) expect(typedTrackingOf(typed('T-1', bad))?.link, bad).toBeNull()
  })

  it('draws the number, "No live tracking", Copy and Track › in both languages (voi); no link, no Track ›', () => {
    const en = draw('typed', 'en')
    expect(en).toContain('T-DEMO-0001')
    expect(en).toContain('No live tracking')
    expect(en).toContain('Track ›')
    expect(en).toContain('href="https://track.demo-corriere.invalid/T-DEMO-0001"')
    expect(en).toContain('Track shipment SH-26-0042 on the carrier&#x27;s site (opens a new tab)')
    const it_ = draw('typed', 'it')
    expect(it_).toContain('Nessun tracciamento in tempo reale')
    expect(it_).toContain('Segui ›')
    const bare = draw('typed-no-link', 'en')
    expect(bare).toContain('T-DEMO-0002')
    expect(bare).toContain('No live tracking')
    expect(bare).not.toContain('Track ›')
    // A shipment with carrier labels says nothing of a typed number.
    expect(draw('in-transit', 'en')).not.toContain('No live tracking')
  })

  it('R-18 holds: a shared shipment with a typed number still names one order and only how many pieces of others', () => {
    const shared = trackingPageSchema.parse({ ...page('shared'), shipment: { ...page('shared').shipment, typedTrackingNumber: 'T-DEMO-0003', typedTrackingUrl: null } })
    expect(sharedWith(shared)).toEqual({ order: '4500-1234', count: 3 })
    expect(Object.keys(trackingPageSchema.shape.order.shape).sort()).toEqual(['customerRef', 'number', 'otherPieces'])
  })
})
// ---- end op-24
