import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { MONEY_NAME } from '@nexus/factory-domain/money/marked'
import { CUSTOMER_ORDER_STATUSES } from '@nexus/factory-domain/sales/portal-orders/status'
import { customerStatusTone } from '../../../lib/order-cells/model'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import type { PortalBand } from '../../shell/frame'
import type { ProductionHealth, Urgency } from '../production/api'
import { rowHref as productionRowHref } from '../production/model'
import type { OrderRecord } from './api'
import { bandChipsOf, bandHealthOf, bandProductionOf, orderBandOf, orderTabsOf, type BandProduction, type OrderBandFacts } from './band'
import { orderRecord, orderWords, PREFIX, shellOf, withoutPrices } from './design-data'
import { RECORD_TABS, tabOf } from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { keyJoinOf } from '../../shell/view/FrameDialogs' // pp-fx5 (walk W-18)
import { CustomerCase, type CustomerCaseModel } from './view/CustomerCase'

/**
 * pp-w1 (lane pp-, the customer's order page on shared parts, round 1; 10-design § 2): the order's band — ONE "Ask for a change…"
 * (the Ask dialog; O1-B1), a ⋯ of real acts only (no second ask, no promise history), the office band's chips (health Late / At risk
 * only, the customer's own urgency, "Made from your request #7 ›"), the keys window with ⌘J and ⌘↵ (O1-B9) — and wall PW-O02 part 1:
 * the band of a Viewer and a Designer holds no chip without portal.production.view, and never a price. w1.3: the tab strip under
 * the band (Overview · Lines · Shipments · Files, the old addresses kept) and the phone title rule (G10). Made-up data only.
 */

const say = (en: string, it = en) => ({ en, it })
const FACTS: OrderBandFacts = { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null }
const health = (code: ProductionHealth['code'], reason: ProductionHealth['reason'] = null): ProductionHealth => ({ code, words: say(code), reason })
const urgency = (code: Urgency['code']): Urgency => ({ code, words: say(code === 'URGENT' ? 'Urgent' : 'Regular'), urgentRank: code === 'URGENT' ? 1 : null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null })
/** A production read that would draw both chips: Late, and urgent by the customer's own mark. */
const LATE_URGENT: BandProduction = { health: health('LATE'), urgency: urgency('URGENT') }

const bandOf = (facts: Partial<OrderBandFacts> = {}, status: OrderRecord['order']['status'] = 'IN_PRODUCTION', locale: Locale = 'en') =>
  orderBandOf({ words: orderWords(locale), record: orderRecord({ status }), prefix: PREFIX, facts: { ...FACTS, ...facts } })
const drawBand = (band: PortalBand, locale: Locale) => render(createElement(CustomerCase, { model: (at: Locale): CustomerCaseModel => ({ shell: shellOf(at, band), body: { kind: 'noAccess', admins: [] } }) }), locale)
const plain = (band: PortalBand) => JSON.stringify(band, (_key, value) => (typeof value === 'function' ? undefined : value))

describe('w1.2 — ONE "Ask for a change…" in the band (O1-B1, O1-B2, O1-B7)', () => {
  it('the primary is the Ask dialog, held with its words; none on a cancelled or delivered order', () => {
    expect(bandOf().actions?.map((action) => [action.id, action.label, action.variant])).toEqual([['ask', 'Ask for a change…', 'primary']])
    // pp-fx5 (walk W-19): the customer reads voi — "Chiedete una modifica…" (the picture's one tu word loses to the voi rule).
    expect(bandOf({}, 'IN_PRODUCTION', 'it').actions?.[0]?.label).toBe('Chiedete una modifica…')
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

  // pp-fx4 (walk W-20): the gallery's Delivered order showed "Late · Material delivery late" and "Urgent" in its band.
  it('W-20: a delivered or cancelled order shows no health and no urgency chip ("Made from" stays: a fact, not a state)', () => {
    const words = orderWords('en')
    const made = { kind: 'request' as const, href: `${PREFIX}/orders/requests/r7`, label: '#7' }
    for (const status of ['DELIVERED', 'CANCELLED'] as const) {
      expect(bandChipsOf(words, { production: LATE_URGENT }, status), status).toBeNull()
      expect(bandChipsOf(words, { production: LATE_URGENT, madeFrom: made }, status), status).toMatchObject({ health: null, urgent: null, madeFrom: { label: 'Made from your request #7' } })
    }
    for (const status of ['IN_PRODUCTION', 'SHIPPED', 'PARTLY_SHIPPED'] as const) expect(bandChipsOf(words, { production: LATE_URGENT }, status), status).toMatchObject({ health: { computed: 'LATE' }, urgent: 'Urgent' })
    expect(readFileSync(new URL('./band.ts', import.meta.url), 'utf8')).toContain('const chips = bandChipsOf(input.words, facts, order.status)')
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
    return (locale: Locale) => orderBandOf({ words: orderWords(locale), record, prefix: PREFIX, facts: { ...FACTS, production: bandProductionOf(LATE_URGENT, seesProduction), pay: seesPrices ? { held: null } : null } })
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

describe('w1.3 — the tab strip: Overview · Lines · Shipments · Files, in the body under the band (D2 a, D6 a)', () => {
  const tabsOf = (over: Partial<Parameters<typeof orderTabsOf>[0]> = {}, locale: Locale = 'en') => orderTabsOf({ words: orderWords(locale), record: orderRecord(), prefix: PREFIX, toConfirm: false, files: 3, ...over })

  it('the office’s words in both languages, a link each, the old addresses landing on their new tabs', () => {
    expect(tabsOf().map((tab) => [tab.id, tab.label])).toEqual([['overview', 'Overview'], ['lines', 'Lines'], ['shipments', 'Shipments'], ['files', 'Files']])
    expect(tabsOf({}, 'it').map((tab) => tab.label)).toEqual(['Panoramica', 'Righe', 'Spedizioni', 'File'])
    expect(tabsOf().map((tab) => tab.id)).toEqual([...RECORD_TABS])
    expect(tabsOf()[3]!.href).toBe(`${PREFIX}/orders/${orderRecord().order.id}?tab=files`)
    expect([tabOf('status'), tabOf('documents'), tabOf('messages'), tabOf(null)]).toEqual(['overview', 'files', 'overview', 'overview'])
    for (const locale of ['en', 'it'] as const) for (const old of ['tabs.status', 'tabs.documents']) expect(CATALOGUE[locale]['portal-orders']![old], `${locale} ${old}`).toBeUndefined()
  })

  it('counts on Lines, Shipments and Files — 0 too, no pill while unknown; "to confirm" on Overview while a revised version waits', () => {
    const record = orderRecord()
    const tabs = tabsOf({ files: 0, toConfirm: true })
    expect(tabs.map((tab) => tab.count ?? null)).toEqual([null, record.lines.length, record.shipments.shown, 0])
    expect(tabs[0]!.badge).toBe('to confirm')
    expect(tabsOf({ files: null })[3]!.count ?? null).toBeNull()
    expect(tabsOf()[0]!.badge).toBeUndefined()
  })

  it('the page draws them in its body (after the band, inside main), the band draws none; each tab draws its part', () => {
    const entry = recordScreen.cases.find((item) => item.id === 'overview')!
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(recordScreen.view, { model: entry.model }), locale)
      expect(html, locale).not.toContain('fw-ptabs')
      expect(html, locale).toMatch(new RegExp(`<nav[^>]*aria-label="${locale === 'en' ? 'Order' : 'Ordine'}"`))
      expect(html.search(/<nav[^>]*aria-label="(Order|Ordine)"/), locale).toBeGreaterThan(html.indexOf('id="main-content"'))
      for (const tab of RECORD_TABS) expect(html, `${locale} ${tab}`).toContain(`?tab=${tab}"`)
      expect(html, locale).toContain('aria-current="page"')
    }
    // Each tab its own part: Overview its lead card; Files the order's documents (the design case holds the library; "Files of this
    // order" — the shared files body — draws only with a files read, which this case does not make).
    expect(textOf(render(createElement(recordScreen.view, { model: entry.model }), 'en'))).toContain(CATALOGUE.en['portal-orders']!['tracker.title']!)
    const files = textOf(render(createElement(recordScreen.view, { model: recordScreen.cases.find((item) => item.id === 'files')!.model }), 'en'))
    expect(files).toContain('DDT-2026-0144')
    expect(files).not.toContain(CATALOGUE.en['portal-orders']!['tracker.title']!)
  })

  it('My production opens an order on Overview (its row, its "Ask us" for an urgent order)', () => {
    expect(productionRowHref('/p/X', { id: 'o1' })).toBe('/p/X/orders/o1?tab=overview')
  })

  // pp-fx5 (walk W-13): at 375 "Files 1" sat under the › arrow, "‹ ew" at the left — the strip's own width moved after the DS revealed the
  // tab. The portal brings the tab you are on to the strip's middle whenever the strip or a tab changes size (sideways only, never the page).
  it('W-13: the tab you are on is brought whole into view, sideways only, whenever the strip or a tab changes size', () => {
    const html = render(createElement(recordScreen.view, { model: recordScreen.cases.find((item) => item.id === 'files')!.model }), 'en')
    expect(html.search(/<div class="fw-pord-tabs">[\s\S]*?<nav[^>]*aria-label="Order"/)).toBeGreaterThanOrEqual(0)
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("const tab = strip.querySelector<HTMLElement>('[aria-current=\"page\"]')")
    expect(view).toContain('strip.scrollLeft += own.left + own.width / 2 - (box.left + box.width / 2)')
    expect(view).toContain('observer.observe(strip)')
    expect(view).not.toMatch(/scrollIntoView\(/)
  })

  it('G10: on a phone the band’s row 1 holds ‹ · the title · ⋯; the reference, the pills and Pages go to row 2 (one shell rule)', () => {
    const css = readFileSync(new URL('../../shell/portal-shell.css', import.meta.url), 'utf8')
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'))
    for (const rule of ['.fw-pband .nds-detailhdr.dense .back {', '.fw-pband .nds-detailhdr.dense .fw-ppages {\n    order: 2;', 'flex-basis: calc(100% - var(--nds-control-h-sm) - var(--nds-space-12));']) expect(phone, rule).toContain(rule)
    // pp-fx2 (W-02): the pill never in row 1 — the title fills row 1 whole: alone with no back link (a list, Home), beside it when there is
    // one (only then the back link's room is taken off). Before, a list's "Updated" pill took the back link's free 44 px, under ⋯.
    expect(phone).toContain('.fw-pband .nds-detailhdr.dense .nds-detailhdr-title h1 {\n    flex-basis: 100%;\n  }')
    expect(phone).toContain('.fw-pband .nds-detailhdr.dense .nds-detailhdr-title:has(> .back) h1 {\n    flex-basis: calc(100% - var(--nds-control-h-sm) - var(--nds-space-12));')
    expect(phone).not.toMatch(/\.nds-detailhdr-title h1 \{\s*flex-basis: calc\(/)
    // pp-fx5 (walk W-07): the reference never breaks inside its number — whole, and row 2 wraps between its items (the meta takes its
    // content's width, Pages goes under it when both do not fit; before, a zero basis squeezed the ref beside Pages).
    expect(phone).toContain('.fw-pband .nds-detailhdr.dense .nds-detailhdr-meta {\n    order: 1;\n    flex: 1 1 auto;\n    min-width: 0;\n  }')
    expect(phone).toContain('.fw-pband .nds-ref-value {\n    overflow-wrap: normal;\n    white-space: nowrap;\n  }')
    expect(phone).not.toMatch(/\.nds-detailhdr-meta \{\s*order: 1;\s*flex: 1 1 0;/)
  })

  // pp-fx5 (walk W-18): the keys window said "⌘ then J", "⌘ then ↵", "← then →", "j then k" — "then" reads as a sequence.
  it('W-18: ⌘J and ⌘↵ are ONE press (two keycaps side by side), ←/→ and j/k either one ("or"), only g h one after the other', () => {
    const band = orderBandOf({ words: orderWords('en'), record: orderRecord({ status: 'IN_PRODUCTION' }), prefix: PREFIX, facts: { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null } })
    expect(band.keys?.map((entry) => [entry.keys.join(' '), keyJoinOf(entry.keys)])).toEqual([
      ['j k', 'or'],
      ['← →', 'or'],
      ['⌘ J', 'press'],
      ['⌘ ↵', 'press'],
      ['Esc', 'then'],
    ])
    expect(keyJoinOf(['g', 'h'])).toBe('then')
    expect(keyJoinOf(['Ctrl', 'Enter'])).toBe('press')
    expect([CATALOGUE.en.portal!['keys.or'], CATALOGUE.it.portal!['keys.or']]).toEqual(['or', 'o'])
    const view = readFileSync(new URL('../../shell/view/FrameDialogs.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{index > 0 && keyJoinOf(entry.keys) !== 'press' ? <span className=\"fw-pkeys-then\"> {t(keyJoinOf(entry.keys) === 'or' ? 'keys.or' : 'keys.then')} </span> : null}")
  })

  // pp-fx5 (walk W-19; the voi rule wins over the picture's one tu word): the band's buttons said "Chiedi una modifica…", "Chiedi di
  // annullare…", "Fai una domanda", "Segnala un problema" beside voi words. Every portal page that says them now says them with voi.
  it('W-19: the customer reads voi — the Ask, cancel, question and problem words on every portal page that uses them', () => {
    const voi: Record<string, Record<string, string>> = {
      'portal-orders': { 'band.change': 'Chiedete una modifica…', 'band.cancel': 'Chiedete di annullare…', 'lines.askChange': 'Chiedete una modifica su questa riga', 'production.ask': 'Fate una domanda', 'reported.report': 'Segnalate un problema' },
      portal: { 'band.ask': 'Fate una domanda' },
      'portal-customer-home': { 'start.ask': 'Fate una domanda' },
      'portal-documents': { 'pay.ask': 'Fate una domanda' },
      'portal-ordering': { 'request.ask': 'Fate una domanda' },
      'portal-production': { 'row.report': 'Segnalate un problema', 'problem.title': 'Segnalate un problema', 'bulk.report': 'Segnalate un problema' },
      'portal-jobs': { 'problem.title': 'Segnalate un problema' },
    }
    for (const [ns, words] of Object.entries(voi)) for (const [key, value] of Object.entries(words)) expect(CATALOGUE.it[ns]![key], `${ns} ${key}`).toBe(value)
    expect(CATALOGUE.it['portal-ordering']!['held.mayNotAsk']).toContain('“Fate una domanda”')
  })

  // pp-fx5 (walk W-14): at 1440 with the conversation hidden, "Messages (2 new)" pushed "Made from your request #1 ›" under the reference
  // although 196 px stood free — the DS caps a dense band's pills at half the title's room. From 1280 px they take the room they need.
  it('W-14: from 1280 px the band’s pills take the room they need (no half-room cap), down to their widest one — the band keeps one row', () => {
    const css = readFileSync(new URL('../../shell/portal-shell.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@media \(min-width: 1280px\) \{\s*\.fw-pband \.nds-detailhdr\.dense \.nds-detailhdr-meta \{\s*flex: 0 1 auto;\s*min-width: min-content;\s*max-width: none;\s*\}/)
  })

  // pp-fx5 (walk W-15; old shell code, 0 sideways at 375 is an Owner rule): a supplier order scrolled 280 px sideways at 375 — the foot, a
  // wrapping COLUMN, put "Free for suppliers…" in a second column off the screen; the band's tab row sat 6 px past the edge.
  it('W-15: at 375 the foot is one column (no wrap into a second column) and a band’s tab row scrolls inside itself', () => {
    const css = readFileSync(new URL('../../shell/portal-shell.css', import.meta.url), 'utf8')
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'))
    expect(phone).toMatch(/\.fw-pfoot \{[^}]*flex-direction: column;[^}]*flex-wrap: nowrap;/)
    expect(phone).toContain('.fw-pfoot-free {\n    flex: 0 0 auto;\n  }')
    expect(phone).toContain('.fw-ptabs {\n    min-width: 0;\n    max-width: 100%;\n    overflow-x: auto;\n  }')
  })
})

describe('L4 — the band’s status is the shared status chip (lib/order-cells StateChip: the orders list’s chip, the office’s tone)', () => {
  it('the band names the order’s status; the shell draws the shared chip with its group’s mark; another page keeps its pill', () => {
    expect(bandOf({}, 'IN_PRODUCTION').status).toMatchObject({ order: 'IN_PRODUCTION', tone: customerStatusTone('IN_PRODUCTION') })
    for (const status of CUSTOMER_ORDER_STATUSES) expect(bandOf({}, status).status?.tone, status).toBe(customerStatusTone(status))
    const html = drawBand(bandOf(), 'en')
    expect(html).toContain('fw-sheet-st')
    const other = drawBand({ ...bandOf(), status: { label: 'Open', tone: 'info' } }, 'en')
    expect(other).not.toContain('fw-sheet-st')
    expect(textOf(other)).toContain('Open')
  })
})
