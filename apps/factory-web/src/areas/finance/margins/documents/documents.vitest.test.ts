import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COST_KINDS as DOMAIN_COST_KINDS, DOCUMENT_NOTES as DOMAIN_NOTES, INVOICE_KINDS as DOMAIN_INVOICE_KINDS } from '@nexus/factory-domain/costing/profitability/documents'
import { FLOOR_BASES as DOMAIN_BASES, FLOOR_SOURCES as DOMAIN_SOURCES } from '@nexus/factory-domain/costing/profitability/floor'
import { createApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { MARGINS, ROLES, ROWS } from '../demo/fixtures'
import { designScreen } from '../fixtures'
import { DEPTH_NAMESPACE, FLOOR_BASES, FLOOR_SOURCES, flagOf, floorFilterOf, floorPhrase, floorTileOf, pointsToFloor } from '../floor/model'
import { COST_KINDS, DOCUMENT_NOTES, getOrderDocuments, INVOICE_KINDS } from './api'
import { DOCUMENTS_1043, documentsAsSeenBy } from './demo'
import { documentHref, isEmpty, methodKey, PAYMENT_METHODS, stateKey, STATES } from './model'
import { DocumentsSection } from './view/DocumentsSection'
import { FloorSummary } from '../floor/view/FloorParts'

/**
 * Margins in depth on SCR-155 (B-W2b-416; FIN-050, FIN-053): the lists equal factory-domain's; the floor flag, its words and
 * the tile that filters the orders below it; each document opens its own page; a person sees each group only with its
 * permission and each amount only with its grain; every word in both languages; the new design cases draw with no key.
 */

describe('the lists mirror factory-domain', () => {
  it('floor bases and sources, invoice and cost kinds, notes', () => {
    expect(FLOOR_BASES).toEqual(DOMAIN_BASES)
    expect(FLOOR_SOURCES).toEqual(DOMAIN_SOURCES)
    expect(INVOICE_KINDS).toEqual(DOMAIN_INVOICE_KINDS)
    expect(COST_KINDS).toEqual(DOMAIN_COST_KINDS)
    expect(DOCUMENT_NOTES).toEqual(DOMAIN_NOTES)
  })
})

describe('the floor', () => {
  it('flags below in danger, above in success, unknown as not known yet; the floor names its role or the company', () => {
    expect(flagOf(ROWS[2]!)).toEqual({ key: 'flag.below', tone: 'danger' })
    expect(flagOf(ROWS[1]!)).toEqual({ key: 'flag.above', tone: 'success' })
    expect(flagOf(ROWS[0]!)).toEqual({ key: 'flag.unknown', tone: 'neutral' })
    expect(floorPhrase(ROWS[2]!.floor!, 'en')).toEqual({ key: 'floor.role', params: { pct: '42.0 %', role: 'Sales' } })
    expect(floorPhrase(ROWS[3]!.floor!, 'it')).toEqual({ key: 'floor.company', params: { pct: '40,0 %' } })
    // SO-1043: 40.2 % estimated against 42 %: 1.8 points under; SO-1031 final 37.5 % against 40 %: 2.5 under.
    expect(pointsToFloor(ROWS[2]!)).toBe(-1.8)
    expect(pointsToFloor(ROWS[3]!)).toBe(-2.5)
    expect(pointsToFloor(ROWS[0]!)).toBeNull()
  })

  it('the tile counts the orders below (0 when none, — when unknown) and filters the list', () => {
    expect(floorTileOf(MARGINS.tiles, false)).toEqual({ value: '2', hintKey: 'tile.hint', active: false })
    expect(floorTileOf(MARGINS.tiles, true)).toEqual({ value: '2', hintKey: 'tile.active', active: true })
    expect(floorTileOf({ belowFloor: 0 }, false).hintKey).toBe('tile.none')
    expect(floorTileOf({}, false)).toEqual({ value: '—', hintKey: 'tile.unknown', active: false })
    expect(floorFilterOf('below')).toBe('below')
    expect(floorFilterOf('above')).toBeNull()
  })
})

describe('the documents', () => {
  it('each opens its own page; a work order its cost in Standard vs actual; a deposit request has no page', () => {
    expect(documentHref('/w/DEMO', { type: 'Invoice', id: 'i1' })).toBe('/w/DEMO/finance/invoices/i1')
    expect(documentHref('/w/DEMO', { type: 'Payment', id: 'p1' })).toBe('/w/DEMO/finance/payments/p1')
    expect(documentHref('/w/DEMO', { type: 'Shipment', id: 's1' })).toBe('/w/DEMO/warehouse/shipments/s1')
    expect(documentHref('/w/DEMO', { type: 'SubcontractOrder', id: 'c1' })).toBe('/w/DEMO/purchasing/subcontracting/c1')
    expect(documentHref('/w/DEMO', { type: 'SupplierInvoice', id: 'f1' })).toBe('/w/DEMO/finance/payables/f1')
    expect(documentHref('/w/DEMO', { type: 'WorkOrder', id: 'w1' })).toBe('/w/DEMO/finance/costing?open=w1')
    expect(documentHref('/w/DEMO', { type: 'DepositRequest', id: 'd1' })).toBeNull()
  })

  it('a group without its permission is held with it; an amount without its grain is not sent', () => {
    const buyer = documentsAsSeenBy(DOCUMENTS_1043, ROLES.buyer)
    expect([buyer.invoices.held, buyer.creditNotes.held, buyer.freight.held, buyer.payments.held, buyer.costs.held]).toEqual(['invoices.view', 'invoices.view', 'shipping.view', 'payments.view', null])
    expect(buyer.costs.rows[0]).toHaveProperty('amount', 316000)
    expect(buyer.totals).not.toHaveProperty('paid')
    const sales = documentsAsSeenBy(DOCUMENTS_1043, ROLES.sales)
    expect(sales.costs.rows[0]).not.toHaveProperty('amount')
    expect(sales.freight.rows[0]).not.toHaveProperty('cost')
    expect(sales.freight.rows[0]).toHaveProperty('charge', 4500)
    expect(sales.payments.rows[0]).toHaveProperty('paid', 360000)
    expect(isEmpty(documentsAsSeenBy(DOCUMENTS_1043, ROLES.finance))).toBe(false)
  })

  it('reads the documents of one order', async () => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify(DOCUMENTS_1043), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    const documents = await getOrderDocuments(api, DOCUMENTS_1043.order.id)
    expect(calls[0]).toBe(`http://api.test/costing/margins/orders/${DOCUMENTS_1043.order.id}/documents`)
    expect(documents.costs.rows).toHaveLength(5)
  })

  it('every word exists in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const kind of INVOICE_KINDS) has(`invoiceKind.${kind}`, { type: 'TD01' })
      for (const kind of COST_KINDS) has(`costKind.${kind}`)
      for (const note of DOCUMENT_NOTES) has(`note.${note}`, { count: 2 })
      for (const [type, states] of Object.entries(STATES)) for (const state of states) has(stateKey(type as keyof typeof STATES, state))
      for (const method of [...PAYMENT_METHODS, 'OTHER']) has(methodKey(method))
      for (const key of ['flag.below', 'flag.above', 'flag.unknown', 'basis.ESTIMATE', 'basis.FINAL', 'basis.unknown', 'tile.hint', 'tile.none', 'tile.unknown', 'tile.active', 'state.none', 'state.unknown']) has(key)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'internal']) has(`problem.${kind}`)
      has('group.count', { count: 1 })
      has('cost.entries', { count: 3 })
    }
  })
})

const LEFT_KEY = /\b(?:flag|floor|basis|points|tile|filter|detail|documents|group|totals|invoiceKind|invoice|costKind|cost|freight|payment|method|note|state|col|problem|common)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const SAID = /\b(?:costing\.view|orders\.view|invoices\.view|payments\.view|shipping\.view|money\.margin|money\.cost)\b/g

interface CaseModel {
  readonly page: { readonly can: { readonly price: boolean; readonly cost: boolean; readonly margin: boolean }; readonly prefix: string; readonly detail: { readonly value: unknown } | null; readonly documents?: unknown }
}

const shell = (locale: (typeof LOCALES)[number], node: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', DEPTH_NAMESPACE]) }, node))

function renderPage(model: unknown, locale: (typeof LOCALES)[number]): string {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const View = screen.view as ComponentType<{ model: unknown }>
  return shell(locale, createElement(View, { model }))
}

/** The DetailModal's own parts (a modal draws nothing on the server): the floor and the documents of the case. */
function renderParts(model: CaseModel, locale: (typeof LOCALES)[number]): string {
  const page = model.page
  const parts = [
    page.detail?.value && page.can.margin ? shell(locale, createElement(FloorSummary, { detail: page.detail.value as Parameters<typeof FloorSummary>[0]['detail'] })) : '',
    page.documents !== undefined && page.documents !== null ? shell(locale, createElement(DocumentsSection, { state: page.documents as Parameters<typeof DocumentsSection>[0]['state'], can: page.can, prefix: page.prefix })) : '',
  ]
  return parts.join('')
}

describe('the design cases of margins in depth', () => {
  const cases = (designScreen as unknown as DesignScreen<unknown>).cases.filter((entry) => entry.id.startsWith('w2b-'))

  it(`${cases.length} cases draw in both languages with no key left on screen, the DetailModal's floor and documents too`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = (renderPage(item.model, locale) + renderParts(item.model as CaseModel, locale)).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(/\{[a-zA-Z]+\}/)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('finance sees every document as a link with its amounts; sales the prices and never a cost; the buyer what it may', () => {
    const parts = (id: string) => renderParts(cases.find((entry) => entry.id === id)!.model as CaseModel, 'en')
    const finance = parts('w2b-documents')
    for (const text of ['FT-2026-0412', 'FT-2026-0488', 'NC-2026-0031', 'WO-2026-0221', 'SC-2026-0014', 'FOR-118/2026', 'SH-2026-0301', 'BON-DEMO-0057', '€5,700.00', '€38.50', 'href="/w/DEMO/finance/invoices/', 'href="/w/DEMO/finance/costing?open=']) expect(finance, text).toContain(text)
    expect(finance).toContain('Below the floor')
    expect(finance).toContain('Floor 42.0 % (Sales role)')
    const sales = parts('w2b-documents-sales')
    expect(sales).toContain('€5,700.00')
    for (const cost of ['€3,160.00', '€38.50', 'What the carrier charged']) expect(sales, cost).not.toContain(cost)
    const buyer = parts('w2b-documents-held')
    expect(buyer).toContain('Needs the right “See invoices and credit notes” to be shown here.')
    expect(buyer).toContain('WO-2026-0221')
    expect(buyer).not.toContain('Below the floor')
    expect(parts('w2b-documents-error')).toContain('Try again')
    expect(parts('w2b-documents-loading')).toContain('Reading the documents')
    expect(parts('w2b-documents-none')).toContain('No document yet')
    expect(parts('w2b-floor-final-quoted')).toContain('Its quote was approved below the floor')
    const filtered = renderPage(cases.find((entry) => entry.id === 'w2b-floor-below')!.model, 'en')
    expect(filtered).toContain('Show every order (clear Below the floor)')
    expect(filtered).toContain('aria-pressed="true"')
  })
})
