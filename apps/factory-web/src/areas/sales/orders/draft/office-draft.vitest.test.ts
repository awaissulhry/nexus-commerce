import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { productRowsOf } from '../../../../lib/order-draft/model'
import { DRAFT_NS, draftWordsFor } from '../../../../lib/order-draft/words'
import { kindsRecord } from '../../../../portal/customer/neworder/design-data'
import { confirmAsOf, confirmBodyOf, confirmHeldOf, confirmRowsOf, sizesOf } from './confirm-model'
import { designScreen } from './fixtures'

/**
 * THE SIMPLE ORDER START (od-tw t.2) — the office's draft order: the route's three doors, a reader who may not change it, the money
 * wall in the office (no Price card and no price field without the grain), a custom-size row makes it a quote, and the Confirm
 * window's body (only what the rows left open is mapped).
 */

const td = (locale: 'it' | 'en') => draftWordsFor(createTranslator(locale, CATALOGUE[locale][DRAFT_NS] ?? {}), locale, 'office').t
const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const draw = (id: string, locale: 'it' | 'en' = 'en') => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const entry = screen.cases.find((item) => item.id === id)!
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view, { model: entry.model })))
}

describe('the route: ?party= the typed order, ?draft= the draft, nothing the start', () => {
  it('the office New order page branches on the address (the typed catalogue order unchanged)', () => {
    expect(src('./OfficeNewOrderRoute.tsx')).toContain("search?.get('party') ? <NewOrderPage /> : <OfficeDraftPage />")
    expect(src('../../../../app/(office)/w/[company]/sales/orders/new/page.tsx')).toContain('<OfficeNewOrderRoute />')
    expect(src('./OfficeDraftPage.tsx')).toContain("const draftId = search?.get('draft') ?? null")
  })
})

describe('the start and the draft, drawn (it, en)', () => {
  it('the start: the customer above the mail; every field waits for it ("Pick the customer first.")', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = draw('start', locale)
      expect(html, locale).toContain(td(locale)('start.customer'))
      expect(html, locale).toContain(td(locale)('start.customerHeld'))
      expect(html, locale).toContain(td(locale)('mail.message')) // the office's voice: "The customer's message"
      expect(html, locale).not.toContain(td(locale)('cf.title'))
    }
    expect(draw('start-customer')).toContain('/w/DEMO/sales/orders?new=1&amp;party=')
  })

  it('a reader without orders.manage reads only: Confirm and Make style draft held with why', () => {
    const html = draw('read-only')
    expect(html).toContain(td('en')('save.readonly'))
    expect(html).toContain('aria-disabled="true"')
  })

  it('the money wall in the office: no Price card and no price field without the grain; both with it', () => {
    for (const locale of ['it', 'en'] as const) {
      expect(draw('draft-owner', locale), locale).toContain(td(locale)('pm.title'))
      const sales = draw('draft-sales', locale)
      expect(sales, locale).not.toContain(td(locale)('pm.theirs'))
      expect(sales, locale).not.toMatch(/€|EUR/)
    }
    // The Confirm window (a DS Modal: drawn only once hydrated, so pinned in its source): its price fields only with the grain.
    expect(src('./view/OfficeDraftView.tsx').match(/record\.seesPrices \? \(\s*<Field label=\{[^}]*t\('cf\.unit'\)/g)).toHaveLength(2)
    expect(src('./view/OfficeDraftView.tsx')).toContain("{record.seesPrices && rows.length > 0 ? <PriceCard")
  })

  it('a custom-size row makes the draft a quote ("Confirm as a quote", said why); without one, an order', () => {
    const owner = draw('draft-owner')
    expect(owner).toContain(td('en')('cf.goQuote'))
    expect(owner).toContain(td('en')('cf.quote', { seq: 2 }))
    expect(draw('draft-order')).toContain(td('en')('cf.go'))
    expect(src('./view/OfficeDraftView.tsx')).toContain("title={t(quote ? 'cf.windowQuote' : 'cf.window', { title })}")
  })
})

describe('the Confirm window maps only what the rows left open', () => {
  it('a row with its style, colour and size run is a line as it is; any other row waits until it is typed', () => {
    const record = kindsRecord()
    const rows = productRowsOf(record.request)
    const entries = Object.fromEntries(confirmRowsOf(rows).map((entry) => [entry.rowId, entry]))
    const catalogue = rows.find((row) => row.catalogue)!
    expect(entries[catalogue.id]!.needs).toBe(false)
    expect(confirmHeldOf(rows, entries)).not.toBeNull()
    expect(confirmAsOf(rows)).toBe('QUOTE')
    expect(sizesOf('48:2 50 × 3 · 52x0 bad')).toEqual([{ size: '48', quantity: 2 }])
    const typed = Object.fromEntries(Object.values(entries).map((entry) => [entry.rowId, entry.needs ? { ...entry, styleId: 's1', colourwayId: 'c1', sizesText: '48:2' } : entry]))
    expect(confirmHeldOf(rows, typed)).toBeNull()
    const body = confirmBodyOf(rows, typed, false)
    expect(body.as).toBe('QUOTE')
    expect(body.map?.every((entry) => entry.into.length === 1 && entry.into[0]!.styleId === 's1')).toBe(true)
    expect(body.map?.some((entry) => entry.lineId === catalogue.id)).toBe(false)
    // No price key travels without the grain.
    expect(JSON.stringify(confirmBodyOf(rows, { ...typed, [catalogue.id]: { ...typed[catalogue.id]!, unitPrice: '18,50' } }, false))).not.toContain('unitPrice')
    expect(confirmBodyOf(rows, { ...typed, [catalogue.id]: { ...typed[catalogue.id]!, unitPrice: '18,50' } }, true).lines).toEqual([{ lineId: catalogue.id, unitPrice: '18.50' }])
  })
})
