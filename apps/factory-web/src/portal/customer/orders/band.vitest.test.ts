import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { MONEY_NAME } from '@nexus/factory-domain/money/marked'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import type { PortalBand } from '../../shell/frame'
import type { ProductionHealth, Urgency } from '../production/api'
import type { OrderRecord } from './api'
import { bandChipsOf, bandHealthOf, bandProductionOf, orderBandOf, type BandProduction, type OrderBandFacts } from './band'
import { orderRecord, orderWords, PREFIX, shellOf, withoutPrices } from './design-data'
import { CustomerCase } from './view/CustomerCase'

/**
 * pp-w1 (lane pp-, the customer's order page on shared parts, round 1; 10-design § 2): the order's band — ONE "Ask for a change…"
 * (the Ask dialog; O1-B1), a ⋯ of real acts only (no second ask, no promise history), the office band's chips (health Late / At risk
 * only, the customer's own urgency, "Made from your request #7 ›"), the keys window with ⌘J and ⌘↵ (O1-B9) — and wall PW-O02 part 1:
 * the band of a Viewer and a Designer holds no chip without portal.production.view, and never a price. Made-up data only.
 */

const say = (en: string, it = en) => ({ en, it })
const FACTS: OrderBandFacts = { ask: { held: null }, cancelHeld: null, reconfirm: null, shipments: 1, confirmation: true, pay: null }
const health = (code: ProductionHealth['code'], reason: ProductionHealth['reason'] = null): ProductionHealth => ({ code, words: say(code), reason })
const urgency = (code: Urgency['code']): Urgency => ({ code, words: say(code === 'URGENT' ? 'Urgent' : 'Regular'), urgentRank: code === 'URGENT' ? 1 : null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null })
/** A production read that would draw both chips: Late, and urgent by the customer's own mark. */
const LATE_URGENT: BandProduction = { health: health('LATE'), urgency: urgency('URGENT') }

const bandOf = (facts: Partial<OrderBandFacts> = {}, status: OrderRecord['order']['status'] = 'IN_PRODUCTION', locale: Locale = 'en') =>
  orderBandOf({ words: orderWords(locale), record: orderRecord({ status }), tab: 'status', prefix: PREFIX, facts: { ...FACTS, ...facts } })
const drawBand = (band: PortalBand, locale: Locale) => render(createElement(CustomerCase, { model: (at: Locale) => ({ shell: shellOf(at, band), body: { kind: 'noAccess', admins: [] } }) }), locale)
const plain = (band: PortalBand) => JSON.stringify(band, (_key, value) => (typeof value === 'function' ? undefined : value))

describe('w1.2 — ONE "Ask for a change…" in the band (O1-B1, O1-B2, O1-B7)', () => {
  it('the primary is the Ask dialog, held with its words; none on a cancelled or delivered order', () => {
    expect(bandOf().actions?.map((action) => [action.id, action.label, action.variant])).toEqual([['ask', 'Ask for a change…', 'primary']])
    expect(bandOf({}, 'IN_PRODUCTION', 'it').actions?.[0]?.label).toBe('Chiedi una modifica…')
    expect(bandOf({ ask: { held: 'Asking is not part of your access.' } }).actions?.[0]?.heldReason).toBe('Asking is not part of your access.')
    expect(bandOf({}, 'CANCELLED').actions).toEqual([])
    expect(bandOf({}, 'DELIVERED').actions).toEqual([])
  })

  it('the ⋯ holds the real acts in the picture’s order, never a second "Ask for a change" or "Promise date history"', () => {
    const band = bandOf({ reconfirm: { revision: 2, held: null }, pay: { held: null }, problem: { held: null } })
    expect(band.more?.map((item) => item.id)).toEqual(['reconfirm', 'cancel', 'pay', 'confirmation', 'problem'])
    const words = textOf(plain(band))
    expect(words).not.toContain('Promise date history')
    expect(band.more?.some((item) => item.id === 'change' || item.id === 'history' || item.id === 'ask')).toBe(false)
    expect(bandOf({}, 'DELIVERED').more?.map((item) => item.id)).toEqual(['confirmation'])
    for (const locale of ['en', 'it'] as const) {
      expect(CATALOGUE[locale]['portal-orders']!['band.history'], locale).toBeUndefined()
      expect(CATALOGUE[locale]['portal-orders']!['band.ask'], locale).toBeUndefined()
    }
  })

  it('the keys window gains ⌘J (the conversation) and ⌘↵ (send), in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const keys = bandOf({}, 'IN_PRODUCTION', locale).keys ?? []
      expect(keys.map((key) => key.keys.join('+'))).toEqual(['j+k', '←+→', '⌘+J', '⌘+↵', 'Esc'])
      for (const key of keys) expect(key.words, key.keys.join('+')).not.toMatch(/^keys\./)
    }
    expect(CATALOGUE.it['portal-orders']!['keys.thread']).toBe('Mostra o nascondi la conversazione')
  })
})

describe('w1.2 — the band’s chips: health (Late / At risk, never On track), urgency, "Made from your request #7 ›"', () => {
  it('health only when it matters, with a person’s curated reason, never their note', () => {
    expect(bandHealthOf(health('LATE'))).toEqual({ computed: 'LATE', raised: null })
    expect(bandHealthOf(health('AT_RISK', { code: 'CAPACITY', words: say('Production capacity') }))).toEqual({ computed: 'AT_RISK', raised: { reason: 'CAPACITY' } })
    expect(bandHealthOf(health('ON_TRACK'))).toBeNull()
    expect(bandHealthOf(health('NO_DATE'))).toBeNull()
    expect(bandHealthOf(null)).toBeNull()
  })

  it('urgency only while the customer marked the order urgent; made from by the customer’s own number', () => {
    const words = orderWords('en')
    expect(bandChipsOf(words, { production: LATE_URGENT })).toMatchObject({ health: { computed: 'LATE' }, urgent: 'Urgent', madeFrom: null })
    expect(bandChipsOf(words, { production: { health: health('ON_TRACK'), urgency: urgency('REGULAR') } })).toBeNull()
    expect(bandChipsOf(words, { madeFrom: { kind: 'request', href: `${PREFIX}/orders/requests/r7`, label: '#7' } })).toEqual({ health: null, urgent: null, madeFrom: { href: `${PREFIX}/orders/requests/r7`, label: 'Made from your request #7' } })
    expect(bandChipsOf(orderWords('it'), { madeFrom: { kind: 'quote', href: `${PREFIX}/open/Quote/q3?view=conversation`, label: null } })?.madeFrom?.label).toBe('Nato dal vostro preventivo')
  })

  it('the shell draws them after the status pill (the shared HealthPill’s customer face); a page without chips draws as before', () => {
    const made = { kind: 'request' as const, href: `${PREFIX}/orders/requests/r7`, label: '#7' }
    const html = drawBand(bandOf({ production: LATE_URGENT, madeFrom: made }), 'en')
    const text = textOf(html)
    for (const words of ['Late', 'Urgent', 'Made from your request #7']) expect(text, words).toContain(words)
    expect(html).toContain(`href="${made.href}"`)
    expect(text.indexOf('Late')).toBeGreaterThan(text.indexOf(orderRecord().order.words.en))
    const it = textOf(drawBand(bandOf({ production: LATE_URGENT }, 'IN_PRODUCTION', 'it'), 'it'))
    for (const words of ['In ritardo', 'Urgente']) expect(it, words).toContain(words)
    const none = drawBand(bandOf(), 'en')
    expect(textOf(none)).not.toContain('Late')
    expect(plain(bandOf())).not.toContain('"chips"')
  })
})

describe('PW-O02 (part 1) — the band of a Viewer and a Designer: no chip without portal.production.view, no price', () => {
  /** A role's case as the page builds it: its production right decides the read the band gets; without the price grain the order reads no price. */
  const caseOf = (key: string, over: { production?: boolean } = {}) => {
    const template = partnerTemplateOf(key)!
    const seesProduction = over.production ?? template.permissions.includes('portal.production.view')
    const seesPrices = template.grains.includes('price')
    const record = seesPrices ? orderRecord({ status: 'IN_PRODUCTION' }) : withoutPrices(orderRecord({ status: 'IN_PRODUCTION' }))
    return (locale: Locale) => orderBandOf({ words: orderWords(locale), record, tab: 'status', prefix: PREFIX, facts: { ...FACTS, production: bandProductionOf(LATE_URGENT, seesProduction), pay: seesPrices ? { held: null } : null } })
  }

  it('the templates as the plan reads them: Viewer sees production, Designer does not; neither sees a price', () => {
    expect(partnerTemplateOf('customer-viewer')!.permissions).toContain('portal.production.view')
    expect(partnerTemplateOf('customer-designer')!.permissions).not.toContain('portal.production.view')
    for (const key of ['customer-viewer', 'customer-designer']) expect(partnerTemplateOf(key)!.grains, key).not.toContain('price')
  })

  it('the production read reaches the band only with the right, and only its health and urgency', () => {
    expect(bandProductionOf(LATE_URGENT, false)).toBeNull()
    expect(bandProductionOf(null, true)).toBeNull()
    expect(Object.keys(bandProductionOf({ ...LATE_URGENT, stage: { code: 'SEWING' } } as BandProduction, true) ?? {}).sort()).toEqual(['health', 'urgency'])
  })

  it('Designer (and a Viewer whose admin took production away): no chip at all, in both languages; Viewer: its chips, never a price', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const [name, band] of [
        ['designer', caseOf('customer-designer')(locale)],
        ['viewer without production', caseOf('customer-viewer', { production: false })(locale)],
      ] as const) {
        expect(band.chips?.health ?? null, `${name} ${locale}`).toBeNull()
        expect(band.chips?.urgent ?? null, `${name} ${locale}`).toBeNull()
        const text = textOf(drawBand(band, locale))
        for (const chip of locale === 'en' ? ['Late', 'Urgent'] : ['In ritardo', 'Urgente']) expect(text, `${name} ${locale}: ${chip}`).not.toContain(chip)
      }
      const viewer = caseOf('customer-viewer')(locale)
      expect(viewer.chips?.health?.computed).toBe('LATE')
    }
  })

  it('no role’s band holds a price: no money key, no amount, no "Pay" without the price grain', () => {
    for (const key of ['customer-viewer', 'customer-designer', 'customer-buyer', 'customer-finance']) {
      for (const locale of ['en', 'it'] as const) {
        const band = caseOf(key)(locale)
        const keys: string[] = []
        JSON.parse(plain(band), (name, value) => {
          if (name) keys.push(name)
          return value
        })
        expect(keys.filter((name) => MONEY_NAME.test(name)), `${key} ${locale}`).toEqual([])
        expect(textOf(drawBand(band, locale)), `${key} ${locale}`).not.toMatch(/€|\bEUR\b/)
        expect(plain(band), `${key} ${locale}`).not.toMatch(/\d+[.,]\d{2}\b/)
        if (!partnerTemplateOf(key)!.grains.includes('price')) expect(band.more?.some((item) => item.id === 'pay'), `${key} ${locale}`).toBe(false)
      }
    }
  })
})
