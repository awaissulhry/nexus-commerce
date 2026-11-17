import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { designScreen as supplierScreen } from '../../purchasing/suppliers/record/fixtures'
import { designScreen as customerScreen } from '../../sales/customers/record/fixtures'
import { CUSTOMERS, RECORD_CAN, SUPPLIERS } from './fixtures'
import { MERGED_TABS, partyTabOf, recordTabs, SIDES, threadOnArrival } from './model'

/**
 * B-TH-260 — the customer and the supplier on RecordFrame (O-SAL-CUST, O-PUR-SUP; the rule of picture 38, the tabs of picture 39 /
 * 08-tabs.tsv): the band in the area row with ONE pill and "Projects (n)", ONE thread docked beside the tabs (customer 8 → 5,
 * supplier 10 → 7; the second record-panels copy gone), Activity's tools in the thread's "⋯" (R-ACT), one notice, the old addresses
 * (R-8), "Open this customer's sheet", "Start a project", and the wall: the thread replies to this party only.
 */

const draw = (screen: { view: unknown; cases: readonly { id: string; model: unknown }[] }, id: string, locale: 'it' | 'en' = 'en') => renderView(screen.view as ComponentType<{ model: unknown }>, screen.cases.find((item) => item.id === id)!.model, locale)
const customer = (id: string, locale: 'it' | 'en' = 'en') => draw(customerScreen, id, locale)
const supplier = (id: string, locale: 'it' | 'en' = 'en') => draw(supplierScreen, id, locale)
const dockOf = (html: string) => textOf(html.slice(html.indexOf('class="fw-rcf-dock"')))
const bandOf = (html: string) => html.slice(html.indexOf('fw-rcf-hdr'), html.search(/class="fw-rcf[ "]/))

describe('the tabs and the old addresses', () => {
  it('customer 8 → 5 and supplier 10 → 7, in that order', () => {
    expect(SIDES.customers.tabs).toEqual(['overview', 'addresses', 'terms', 'orders', 'portal'])
    expect(SIDES.suppliers.tabs).toEqual(['overview', 'items', 'documents', 'orders', 'quality', 'bank', 'portal'])
    const words = CATALOGUE.en.parties!
    expect(SIDES.customers.tabs.map((tab) => words[`customers.tab.${tab}`])).toEqual(['Overview', 'Addresses & contacts', 'Terms & requirements', 'Quotes & orders', 'Portal access'])
    expect(SIDES.suppliers.tabs.map((tab) => words[`suppliers.tab.${tab}`])).toEqual(['Overview & contacts', 'Items & prices', 'Documents & questionnaire', 'Orders', 'Quality & rating', 'Bank details', 'Portal access'])
  })

  it('every old ?tab= keeps working (R-8); a customer’s Documents shows the thread (its Files view holds the files)', () => {
    expect(MERGED_TABS.customers).toEqual({ tax: 'terms', requirements: 'terms', documents: 'overview', activity: 'overview' })
    expect(MERGED_TABS.suppliers).toEqual({ contacts: 'overview', questionnaire: 'documents', activity: 'overview' })
    for (const [side, merged] of Object.entries(MERGED_TABS) as [keyof typeof MERGED_TABS, Record<string, string>][]) {
      for (const [old, now] of Object.entries(merged)) expect(partyTabOf(side, old), `${side} ${old}`).toBe(now)
      for (const tab of SIDES[side].tabs) expect(partyTabOf(side, tab)).toBe(tab)
      for (const odd of ['nope', 'constructor', 'toString', null, undefined]) expect(partyTabOf(side, odd as string | null)).toBe('overview')
    }
    expect(threadOnArrival('customers', 'documents')).toBe(true)
    expect(threadOnArrival('customers', 'activity')).toBe(false)
    expect(threadOnArrival('suppliers', 'documents')).toBe(false)
  })

  it('a supplier’s Documents & questionnaire shows with the depth slot or the questionnaire; Terms & requirements is every reader’s', () => {
    expect(recordTabs(SIDES.suppliers, { ...RECORD_CAN, questionnaire: false, depth: false })).not.toContain('documents')
    expect(recordTabs(SIDES.suppliers, { ...RECORD_CAN, questionnaire: true })).toContain('documents')
    expect(recordTabs(SIDES.customers, { ...RECORD_CAN, quotes: false, orders: false })).toContain('terms')
  })
})

describe('the customer on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity or Documents tab, no record panels', () => {
    const html = customer('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).not.toContain('fw-rp-tabs')
    expect(html).not.toContain('fw-pty-record-dock')
    const body = textOf(html.slice(0, html.indexOf('class="fw-rcf-dock"')))
    expect(body).not.toMatch(/\bActivity\b/)
    for (const gone of ['tab=activity', 'tab=documents', 'tab=tax', 'tab=requirements']) expect(html, gone).not.toContain(gone)
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab', () => {
    for (const id of ['overview', 'addresses', 'tax', 'quotes-orders', 'w2b-324-req']) expect(customer(id), id).toContain('aria-label="Thread tools"')
  })

  it('the band: ONE pill (the status), the identity, roles and VIES as its details, Projects (n), the Thread button', () => {
    const band = bandOf(customer('overview'))
    expect(band.match(/class="nds-pill /g)?.length).toBe(1)
    expect(textOf(band)).toContain('Projects (2)')
    expect(band).toContain(`/products/projects?party=${CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!.id}`)
    expect(textOf(band)).toContain('Thread')
    expect(textOf(bandOf(customer('projects-none')))).not.toContain('Projects (')
  })

  it('Terms & requirements holds the tax identity and VIES, the commercial terms, the hold and PO number, then the requirements', () => {
    expect(textOf(customer('tax'))).toContain('Terms & requirements')
    const html = customer('w2b-324-req')
    expect(html).toContain('id="party-requirements"')
    expect(textOf(customer('w2b-324-tax'))).toContain('Terms & requirements')
  })

  it('Quotes & orders: "Open this customer’s sheet" opens Sales › Orders with this customer and every row (SHEET-G12)', () => {
    const id = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!.id
    const html = customer('quotes-orders')
    expect(textOf(html)).toContain('Open this customer’s sheet')
    expect(html).toContain(`/sales/orders?party=${id}&amp;rows=all`)
    expect(textOf(customer('quotes-orders', 'it'))).toContain('Apri il foglio di questo cliente')
  })

  it('one notice: the most serious shows, the rest wait behind "N more notices" (never above the thread)', () => {
    const html = customer('notices')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)
    expect(body).toContain('fw-rcf-notices-list')
    expect((body.match(/class="nds-banner /g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('the wall: the thread replies to this customer only, never another (W03, W04, W08, W20, W21, W25)', () => {
    const own = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!
    const dock = dockOf(customer('thread-docked'))
    expect(dock).toContain(own.tradeName ?? own.legalName)
    for (const other of CUSTOMERS.filter((item) => item.id !== own.id).map((item) => item.tradeName ?? item.legalName)) expect(dock, other).not.toContain(other)
    for (const brand of [BRAND_ALPHA.tradeName, BRAND_BETA.tradeName]) expect(dock).not.toContain(brand)
  })

  it('without threads.read there is no thread; the states before the read sit in the frame with no thread', () => {
    const html = customer('thread-no-right')
    expect(html).not.toContain('class="fw-rcf-dock"')
    expect(html).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
    for (const id of ['loading', 'not-found', 'error', 'no-access']) {
      const state = customer(id)
      expect(state, id).toContain('fw-rcf-hdr')
      expect(state, id).not.toContain('class="fw-rcf-dock"')
    }
  })
})

describe('the supplier on RecordFrame', () => {
  it('Overview & contacts holds the form and the contacts; ONE thread docked; R-ACT on every tab', () => {
    const html = supplier('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(textOf(html)).toContain('Overview & contacts')
    for (const id of ['contacts', 'items', 'orders', 'w2b-334-contacts']) expect(supplier(id), id).toContain('aria-label="Thread tools"')
  })

  it('the wall: the thread replies to this supplier only', () => {
    const own = SUPPLIERS.find((item) => item.code === 'CONCERIA-DEMO')!
    const dock = dockOf(supplier('thread-docked'))
    expect(dock).toContain(own.tradeName ?? own.legalName)
    for (const other of SUPPLIERS.filter((item) => item.id !== own.id).map((item) => item.tradeName ?? item.legalName)) expect(dock, other).not.toContain(other)
  })
})

describe('the containers', () => {
  it('the record mounts the party’s thread docked with the party itself (partyRole by side), with threads.read; no record panels in a tab', () => {
    const container = readFileSync(new URL('./PartyRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain("partyRole={side === 'customers' ? 'customer' : 'supplier'}")
    expect(container).toContain('party={{ id: party.id, name }}')
    expect(container).toContain('can.threads')
    expect(container).not.toContain('tab="files"')
    expect(container).not.toContain('useThreadDock')
    expect(container).toContain('projectCounts(api, partyId')
    const view = readFileSync(new URL('./view/PartyRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<RecordFrame')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).toContain('/products/projects?new=1&party=${encodeURIComponent(party.id)}')
    expect(view).toContain("t('held.projects', { right: rightRef('projects.manage') })")
    expect(view).not.toContain("event.key === '?'")
  })

  it('the depth slots read by the merged tabs: Terms & requirements loads the hold, terms and requirements; Overview & contacts the profile', () => {
    const customerDepth = readFileSync(new URL('../../sales/customers/depth/use-depth.ts', import.meta.url), 'utf8')
    expect(customerDepth).toContain("partyTabOf('customers'")
    expect(customerDepth).toContain("tab === 'terms') void Promise.all([loadHolds(), loadTerms(), loadRequirements()])")
    const supplierDepth = readFileSync(new URL('../../purchasing/suppliers/depth/use-depth.ts', import.meta.url), 'utf8')
    expect(supplierDepth).toContain("partyTabOf('suppliers'")
    expect(supplierDepth).not.toContain("tab === 'contacts'")
  })

  it('its words exist in it and en', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].parties!
      for (const key of ['record.dockLabelOf', 'record.startProject', 'record.projects', 'held.projects', 'customers.openSheet', 'customers.requirementsLabel', 'suppliers.questionnaireLabel']) expect(words[key], `${locale} ${key}`).toBeTruthy()
      for (const gone of ['record.dock', 'record.dockHint', 'keys.dock', 'customers.tab.activity', 'suppliers.tab.activity']) expect(words[gone], `${locale} ${gone}`).toBeUndefined()
    }
  })
})
