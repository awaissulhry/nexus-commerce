import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { SOURCE_PREFERENCES, SOURCE_STATUSES } from '@nexus/factory-domain/purchasing/sources/sources'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as materialScreen } from '../../../products/materials/record/fixtures'
import { recordTabs, SIDES } from '../../../parties/_shared/model'
import { RECORD_CAN } from '../../../parties/_shared/fixtures'
import { designScreen as supplierScreen } from '../record/fixtures'
import { archiveSource, createSource, listSources, updateSource } from './api'
import { ACTIVE_SOURCES, KANGAROO, SOURCES, withoutCost } from './demo/fixtures'
import {
  addBody,
  addHeld,
  addRefusal,
  bulkReach,
  bulkRefusal,
  cellChange,
  cellRefusal,
  leadTimeSay,
  materialSources,
  newAddDraft,
  rowHeld,
  sourcesCan,
  sourcesCsv,
  unitsFor,
  viewStatus,
} from './model'

// The DS Modal draws into a portal (nothing on the server): in place here, so the dialogs' words are checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const ROW = ACTIVE_SOURCES[0]!
const apiError = (status: number, code: string, paths: string[] = []) => new ApiError(status === 409 ? 'conflict' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'invalid', status, code, 'English for logs', null, paths.map((path) => ({ path })))

describe('approved sources: who may do what, the views', () => {
  it('reads with purchasing.view, keeps with purchasing.sources.manage, prices with the cost grain', () => {
    expect(sourcesCan(['purchasing.view'])).toEqual({ view: true, manage: false, cost: false, materials: false })
    expect(sourcesCan(['purchasing.view', 'purchasing.sources.manage', 'money.cost', 'product.materials.view'])).toEqual({ view: true, manage: true, cost: true, materials: true })
    expect([viewStatus('active'), viewStatus('archived'), viewStatus('all')]).toEqual(['ACTIVE', 'ARCHIVED', 'ALL'])
  })

  it('a row is text without the right, or archived', () => {
    expect(rowHeld(ROW, { manage: false })).toEqual({ key: 'held.noManage' })
    expect(rowHeld({ status: 'ARCHIVED' }, { manage: true })).toEqual({ key: 'held.archived' })
    expect(rowHeld(ROW, { manage: true })).toBeNull()
  })

  it('the supplier’s Items & prices tab stays in view without purchasing.view (it says what is missing)', () => {
    expect(SIDES.suppliers.tabs).toEqual(['overview', 'contacts', 'items', 'orders', 'activity'])
    expect(recordTabs(SIDES.suppliers, { ...RECORD_CAN, purchaseOrders: false })).toContain('items')
  })

  it('the lead time in words: its own days, the supplier’s usual, or unknown', () => {
    expect(leadTimeSay({ leadTimeDays: 21, supplierLeadTimeDays: 14 })).toEqual({ key: 'lead.days', params: { count: 21 } })
    expect(leadTimeSay({ leadTimeDays: null, supplierLeadTimeDays: 14 })).toEqual({ key: 'lead.usual', params: { count: 14 } })
    expect(leadTimeSay({ leadTimeDays: null, supplierLeadTimeDays: null })).toEqual({ key: 'lead.none' })
  })

  it('a material’s suppliers: active ones, primary first', () => {
    const rows = materialSources([...SOURCES].reverse())
    expect(rows.every((row) => row.status === 'ACTIVE')).toBe(true)
    expect(rows[0]!.preference).toBe('PRIMARY')
  })
})

describe('a cell sends one field (autosave per cell)', () => {
  it('nothing when unchanged; decimals with a comma; blank clears', () => {
    expect(cellChange(ROW, 'unitPrice', ' 126.000000 ')).toEqual({ nothing: true })
    expect(cellChange(ROW, 'unitPrice', '12,5')).toEqual({ fields: { unitPrice: '12.5' } })
    expect(cellChange(ROW, 'minOrderQty', '')).toEqual({ fields: { minOrderQty: null } })
    expect(cellChange(ROW, 'supplierArticleCode', ' CD-NEW ')).toEqual({ fields: { supplierArticleCode: 'CD-NEW' } })
    expect(cellChange(ROW, 'leadTimeDays', '30')).toEqual({ fields: { leadTimeDays: 30 } })
    expect(cellChange(ROW, 'preference', 'BACKUP')).toEqual({ fields: { preference: 'BACKUP' } })
    expect(cellChange(ROW, 'purchaseUom', 'FT2')).toEqual({ fields: { purchaseUom: 'FT2' } })
  })

  it('what the rules refuse says why before anything is sent', () => {
    expect(cellChange(ROW, 'unitPrice', '-1')).toEqual({ problem: { key: 'cell.badPrice' } })
    expect(cellChange(ROW, 'unitPrice', '1.1234567')).toEqual({ problem: { key: 'cell.badPrice' } })
    expect(cellChange(ROW, 'orderMultiple', '0')).toEqual({ problem: { key: 'cell.badQuantity' } })
    expect(cellChange(ROW, 'leadTimeDays', '400')).toEqual({ problem: { key: 'cell.badDays', params: { max: 366 } } })
    expect(cellChange(ROW, 'leadTimeDays', '2.5')).toEqual({ problem: { key: 'cell.badDays', params: { max: 366 } } })
    expect(cellChange(ROW, 'supplierArticleCode', 'x'.repeat(61))).toEqual({ problem: { key: 'cell.tooLong', params: { max: 60 } } })
  })

  it('the API’s refusals in our words: changed meanwhile (read again), archived, a field, the unit, no right', () => {
    expect(cellRefusal(apiError(409, 'conflict', ['version']), 'unitPrice')).toEqual({ words: { key: 'cell.changed' }, reload: true })
    expect(cellRefusal(apiError(409, 'invalid_state'), 'unitPrice')).toEqual({ words: { key: 'cell.archived' }, reload: true })
    expect(cellRefusal(apiError(400, 'validation_failed', ['body/unitPrice']), 'unitPrice')).toEqual({ words: { key: 'cell.refused.unitPrice' }, reload: false })
    expect(cellRefusal(apiError(400, 'validation_failed', ['body/purchaseUom']), 'purchaseUom')).toEqual({ words: { key: 'cell.unitNotConverted' }, reload: false })
    expect(cellRefusal(apiError(403, 'forbidden'), 'unitPrice').words).toEqual({ key: 'cell.forbidden' })
    expect(cellRefusal(new Error('x'), 'unitPrice').words).toEqual({ key: 'problem.write' })
  })
})

describe('Add a source', () => {
  const supplier = { companyId: null, companyIdOfAddress: 'c1' }
  const can = { manage: true, cost: true }

  it('is held in the order a person fills it', () => {
    const draft = newAddDraft('EUR')
    expect(addHeld(draft, { manage: false, cost: true }, supplier)).toEqual({ key: 'held.noManage' })
    expect(addHeld(draft, can, supplier)).toEqual({ key: 'add.held.material' })
    expect(addHeld({ ...draft, material: KANGAROO, scope: 'every' }, can, { companyId: 'c1', companyIdOfAddress: 'c1' })).toEqual({ key: 'add.held.oneCompany' })
    expect(addHeld({ ...draft, material: KANGAROO, purchaseUom: 'KG' }, can, supplier)).toEqual({ key: 'cell.unitNotConverted' })
    expect(addHeld({ ...draft, material: KANGAROO, unitPrice: 'abc' }, can, supplier)).toEqual({ key: 'cell.refused.unitPrice' })
    expect(addHeld({ ...draft, material: KANGAROO, unitPrice: '9' }, { manage: true, cost: false }, supplier)).toEqual({ key: 'add.held.noCost' })
    expect(addHeld({ ...draft, material: KANGAROO, currency: 'E' }, can, supplier)).toEqual({ key: 'add.held.currency' })
    expect(addHeld({ ...draft, material: KANGAROO, unitPrice: '98,50' }, can, supplier)).toBeNull()
  })

  it('offers the units the material converts', () => {
    expect(unitsFor(KANGAROO)).toEqual(expect.arrayContaining(['FT2', 'M2', 'DM2', 'HIDE']))
    expect(unitsFor(KANGAROO)).not.toContain('KG')
  })

  it('sends what was typed (blanks left to the API’s defaults); every company is null', () => {
    const draft = { ...newAddDraft('eur'), material: KANGAROO, itemColourId: 'col', unitPrice: '98,50', minOrderQty: '10', leadTimeDays: '18', supplierArticleCode: ' CD-CNG10 ', preference: 'PRIMARY' as const }
    expect(addBody(draft, 'p1', 'c1')).toEqual({ companyId: 'c1', partyId: 'p1', itemId: KANGAROO.id, itemColourId: 'col', unitPrice: '98.50', currency: 'EUR', minOrderQty: '10', leadTimeDays: 18, preference: 'PRIMARY', supplierArticleCode: 'CD-CNG10' })
    expect(addBody({ ...draft, scope: 'every' }, 'p1', 'c1').companyId).toBeNull()
  })

  it('a refusal in words: a duplicate, every company without the role, a field, archived', () => {
    expect(addRefusal(apiError(409, 'conflict'), 'company')).toEqual({ key: 'add.refused.duplicate' })
    expect(addRefusal(apiError(409, 'invalid_state'), 'company')).toEqual({ key: 'add.refused.archived' })
    expect(addRefusal(apiError(403, 'forbidden'), 'every')).toEqual({ key: 'add.refused.everyCompany' })
    expect(addRefusal(apiError(400, 'validation_failed', ['body/companyId']), 'every')).toEqual({ key: 'add.refused.company' })
    expect(addRefusal(apiError(400, 'validation_failed', ['body/leadTimeDays']), 'company')).toEqual({ key: 'cell.refused.leadTimeDays' })
  })
})

describe('bulk and export', () => {
  it('Archive reaches the approved rows, Restore the archived ones', () => {
    const reach = bulkReach(SOURCES, [SOURCES[0]!.id, SOURCES[4]!.id])
    expect(reach.archive.map((row) => row.id)).toEqual([SOURCES[0]!.id])
    expect(reach.restore.map((row) => row.id)).toEqual([SOURCES[4]!.id])
    expect(bulkRefusal(apiError(409, 'conflict'), 'restore')).toEqual({ key: 'bulk.refused.restoreDuplicate' })
    expect(bulkRefusal(apiError(409, 'invalid_state'), 'archive')).toEqual({ key: 'bulk.refused.archiveState' })
  })

  it('the CSV prints prices only with the cost grain', () => {
    const words = createTranslator('en', messagesFor('en', ['purchasing-sources'])['purchasing-sources'] ?? {})
    const withCost = sourcesCsv(ACTIVE_SOURCES, true, words)
    expect(withCost.split('\r\n')[0]).toContain('Price')
    expect(withCost).toContain('126.000000')
    const noCost = sourcesCsv(withoutCost(ACTIVE_SOURCES), false, words)
    expect(noCost.split('\r\n')[0]).not.toContain('Price')
    expect(noCost).not.toContain('126.000000')
    expect(noCost).toContain('Every company')
  })
})

describe('the calls, as the API takes them', () => {
  function fakeApi() {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const api: ApiClient = createApiClient({
      baseUrl: 'http://api.test',
      csrfToken: () => 'csrf',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
        const body = (init?.method ?? 'GET') === 'GET' ? { items: [ROW], nextCursor: null } : { item: ROW, demoted: null }
        return new Response(JSON.stringify(body), { status: init?.method === 'POST' && String(input).endsWith('/supplier-items') ? 201 : 200, headers: { 'content-type': 'application/json' } })
      },
    })
    return { api, calls }
  }

  it('lists a supplier’s or a material’s; one field per PATCH with the version; adds and archives with a key', async () => {
    const { api, calls } = fakeApi()
    await listSources(api, { partyId: 'p1', status: 'ALL', limit: 200 })
    await listSources(api, { itemId: 'i1', companyId: 'c1' })
    await updateSource(api, 's1', 3, { unitPrice: '12.5' })
    await createSource(api, { companyId: null, partyId: 'p1', itemId: 'i1' }, 'k1')
    await archiveSource(api, 's1', 4, ' gone ', 'k2')
    expect(calls[0]!.url).toBe('http://api.test/purchasing/supplier-items?partyId=p1&status=ALL&limit=200')
    expect(calls[1]!.url).toBe('http://api.test/purchasing/supplier-items?itemId=i1&companyId=c1&limit=100')
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: 'http://api.test/purchasing/supplier-items/s1', body: { version: 3, unitPrice: '12.5' } })
    expect(calls[3]).toMatchObject({ method: 'POST', url: 'http://api.test/purchasing/supplier-items', body: { companyId: null, partyId: 'p1', itemId: 'i1' }, key: 'k1' })
    expect(calls[4]).toMatchObject({ method: 'POST', url: 'http://api.test/purchasing/supplier-items/s1/archive', body: { version: 4, reason: 'gone' }, key: 'k2' })
  })
})

// ---- the design cases ------------------------------------------------------------------------------------------------------

const LEFT_KEY =
  /\b(?:title|intro|uom|unit|price|lead|preference|last|status|col|noAccess|held|list|view|add|bulk|common|readOnly|cell|field|problem|archive|restore|notice|keys|csv|prices|material|supplier|suppliers|customers|record|tab)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs purchasing.view"); example domains and addresses are not keys. */
const SAID = /\b(?:purchasing\.[a-z.]+|product\.materials\.[a-z]+|money\.cost|[\w.+-]+@[\w.-]+|[a-z-]+\.example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every new design case draws in both languages with no key left on screen', () => {
  const cases = [
    { screen: supplierScreen as unknown as DesignScreen<unknown>, prefix: 'items' },
    { screen: materialScreen as unknown as DesignScreen<unknown>, prefix: 'supplier-prices' },
    { screen: materialScreen as unknown as DesignScreen<unknown>, prefix: 'suppliers' },
  ]
  for (const { screen, prefix } of cases) {
    it(`${screen.screen} ${prefix}-*: it, en`, () => {
      const picked = screen.cases.filter((item) => item.id === prefix || item.id.startsWith(`${prefix}-`))
      expect(picked.length).toBeGreaterThan(0)
      for (const item of picked) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('has the states the design asks for', () => {
    const ids = supplierScreen.cases.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['items', 'items-saving', 'items-saved', 'items-refused', 'items-demoted', 'items-add', 'items-add-duplicate', 'items-archived', 'items-archive', 'items-empty', 'items-loading', 'items-error', 'items-read-only', 'items-no-cost', 'items-no-access']))
    expect(materialScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['supplier-prices', 'supplier-prices-no-cost', 'supplier-prices-default', 'supplier-prices-error', 'supplier-prices-loading', 'supplier-prices-no-access']))
  })

  it('draws the words that matter, and no price without the cost grain', () => {
    const html = (screen: DesignScreen<unknown>, id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    const supplier = supplierScreen as unknown as DesignScreen<unknown>
    const material = materialScreen as unknown as DesignScreen<unknown>
    expect(html(supplier, 'items', 'en')).toContain('Approved sources')
    expect(html(supplier, 'items', 'it')).toContain('Fonti approvate')
    expect(html(supplier, 'items-add-duplicate', 'en')).toContain('already has an approved source')
    expect(html(supplier, 'items-no-access', 'en')).toContain('purchasing.view')
    expect(html(supplier, 'items-read-only', 'it')).toContain('Sola lettura')
    expect(html(supplier, 'items-demoted', 'en')).toContain('is now the backup')
    expect(html(material, 'supplier-prices', 'en')).toContain('Conceria Esempio Due')
    expect(html(material, 'supplier-prices', 'en')).toMatch(/€|EUR/)
    expect(html(material, 'supplier-prices-no-cost', 'en')).not.toMatch(/€/)
    expect(html(material, 'supplier-prices-default', 'it')).toContain('Solo il fornitore predefinito')
    expect(html(material, 'supplier-prices-error', 'en')).toContain('Couldn’t load supplier prices')
    expect(html(material, 'supplier-prices-no-access', 'en')).toContain('purchasing.view')
  })

  it('has words for every unit, preference and state in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['purchasing-sources'])['purchasing-sources'] ?? {})
      for (const key of [...UOMS.map((uom) => `uom.${uom}`), ...SOURCE_PREFERENCES.map((value) => `preference.${value}`), ...SOURCE_STATUSES.map((value) => `status.${value}`)]) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
    }
  })
})
