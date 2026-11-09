import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { CAPABILITY_ROLE_KEYS } from '@nexus/factory-domain/auth/partners/kinds'
import { PORTAL_AREAS as TASK_AREAS } from '@nexus/factory-domain/portal/tasks/kinds'
import { bottomBarLayout } from '@nexus/ui/components/BottomBar/index'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { PORTAL_AREAS, PORTAL_PENDING_PERMISSIONS, portalChords, portalNavFor, portalNavLabelKeys, portalNavPermissions, recordPageOf, RECORD_PAGES, type PortalKind } from './portal-nav'

const everything = () => true
const ids = (kind: PortalKind, everyPage = true) => portalNavFor({ can: everything, kinds: [kind], everyPage }).areas.map((area) => [area.id, area.label, area.href])
const roleCan = (key: string) => {
  const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
  return (permission: string) => template.permissions.includes(permission as never)
}

describe('the portal navigation (B-W2b-173; design portal.frame › rail, bottom bar)', () => {
  it('gives each partner kind its areas, in the design’s order, once every page is built', () => {
    expect(ids('CUSTOMER').map(([id]) => id)).toEqual(['home', 'orders', 'quotes', 'documents', 'returns', 'account'])
    expect(ids('SUPPLIER')).toEqual([
      ['home', 'nav.home', '/'],
      ['work', 'nav.purchaseOrders', '/orders'],
      ['deliveries', 'nav.deliveries', '/deliveries'],
      ['supplier-documents', 'nav.documents', '/documents'],
      ['profile', 'nav.profile', '/profile'],
    ])
    // A workshop: "Orders & jobs" is its Jobs page.
    expect(ids('SUBCONTRACTOR')).toEqual([
      ['home', 'nav.home', '/'],
      ['work', 'nav.jobs', '/jobs'],
      ['supplier-documents', 'nav.documents', '/documents'],
      ['profile', 'nav.profile', '/profile'],
    ])
    expect(ids('GUEST').map(([id]) => id)).toEqual(['home', 'accounting', 'audit-room'])
  })

  it('never shows a door to a page not built: today only Home, which the frame draws', () => {
    // B-W2b-201: the accountant's Accounting.
    expect(ids('GUEST', false).map(([id]) => id)).toEqual(['home', 'accounting'])
    // B-W2b-181: a workshop's Jobs (the area left with one page takes its name and address).
    expect(ids('SUBCONTRACTOR', false)).toEqual([
      ['home', 'nav.home', '/'],
      ['work', 'nav.jobs', '/jobs'],
      // B-W2b-193: a workshop's Documents and Profile.
      ['supplier-documents', 'nav.documents', '/documents'],
      ['profile', 'nav.profile', '/profile'],
    ])
    // B-W2b-179: a supplier's Purchase orders (the area left with one page takes its name and address).
    expect(ids('SUPPLIER', false)).toEqual([
      ['home', 'nav.home', '/'],
      ['work', 'nav.purchaseOrders', '/orders'],
      // B-W2b-186: a supplier's Ship notices.
      ['deliveries', 'nav.deliveries', '/deliveries'],
      // B-W2b-193: a supplier's Documents and Profile.
      ['supplier-documents', 'nav.documents', '/documents'],
      ['profile', 'nav.profile', '/profile'],
    ])
    // B-W2b-196: the customer's Account.
    // B-W2b-191: the customer's Orders & tracking; B-W2b-194: New order & reorder joins Orders (two pages: the area keeps its own name), the
    // Catalogue is the one page of Quotes & samples (it takes the page's name and address); B-W2b-195: Documents; B-W2b-197: Returns & claims.
    expect(ids('CUSTOMER', false)).toEqual([
      ['home', 'nav.home', '/'],
      ['orders', 'nav.orders', '/orders'],
      ['quotes', 'nav.catalogue', '/catalogue'],
      ['documents', 'nav.documents', '/documents'],
      ['returns', 'nav.returns', '/returns'],
      ['account', 'nav.account', '/account'],
    ])
  })

  it('fails closed: a role sees only the areas its permissions open (the Designer has no orders, documents or returns)', () => {
    const designer = portalNavFor({ can: roleCan('customer-designer'), kinds: ['CUSTOMER'], everyPage: true })
    // The Designer holds the catalogue (Quotes & samples keeps that one page) and its colleagues (Account).
    expect(designer.areas.map((area) => [area.id, area.label])).toEqual([
      ['home', 'nav.home'],
      ['quotes', 'nav.catalogue'],
      ['account', 'nav.account'],
    ])
    const invoices = portalNavFor({ can: roleCan('supplier-invoices'), kinds: ['SUPPLIER'], everyPage: true })
    expect(invoices.areas.map((area) => area.id)).toEqual(['home', 'supplier-documents', 'profile'])
    expect(portalNavFor({ can: () => false, kinds: ['CUSTOMER'], everyPage: true }).areas).toEqual([])
    expect(portalNavFor({ can: everything, kinds: [], everyPage: true }).areas).toEqual([])
  })

  it('a preview of a supplier that also works as a workshop reads as both kinds, each address once', () => {
    const both = portalNavFor({ can: everything, kinds: ['SUPPLIER', 'SUBCONTRACTOR'], everyPage: true })
    expect(both.areas.map((area) => [area.id, area.href])).toEqual([
      ['home', '/'],
      ['work', '/orders'],
      ['deliveries', '/deliveries'],
      ['supplier-documents', '/documents'],
      ['profile', '/profile'],
    ])
  })

  it('the phone: a customer gets four tabs and More (Quotes & samples, Account); a workshop four tabs and no More', () => {
    const customer = bottomBarLayout(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }), '/')
    expect(customer.tabs.map((tab) => tab.id)).toEqual(['home', 'orders', 'documents', 'returns'])
    expect(customer.more.map((entry) => entry.id)).toEqual(['quotes', 'account'])
    expect(customer.current).toBe('home')
    const workshop = bottomBarLayout(portalNavFor({ can: everything, kinds: ['SUBCONTRACTOR'], everyPage: true }), '/jobs/x')
    expect(workshop.tabs.map((tab) => tab.id)).toEqual(['home', 'work', 'supplier-documents', 'profile'])
    expect(workshop.more).toEqual([])
    expect(workshop.current).toBe('work')
  })

  it('names only declared partner permissions, or pending ones a later page declares', () => {
    const declared = new Set<string>(FACTORY_PERMISSIONS.partnerAssignable.map((definition) => definition.name))
    expect(portalNavPermissions().filter((name) => !declared.has(name) && !PORTAL_PENDING_PERMISSIONS.has(name))).toEqual([])
    expect([...PORTAL_PENDING_PERMISSIONS].filter((name) => declared.has(name))).toEqual([])
  })

  it('every badge is an area of the one task list, every label is in both languages', () => {
    for (const area of PORTAL_AREAS) if (area.badge) expect(TASK_AREAS).toContain(area.badge)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].portal ?? {}
      expect(portalNavLabelKeys().filter((key) => !(key in words))).toEqual([])
    }
  })

  it('keys: g h Home, g o Orders (or Jobs), g d Documents', () => {
    expect(portalChords(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }))).toEqual({ h: '/', o: '/orders', d: '/documents' })
    expect(portalChords(portalNavFor({ can: everything, kinds: ['SUBCONTRACTOR'], everyPage: true }))).toEqual({ h: '/', o: '/jobs', d: '/documents' })
  })

  it('a record opens its own page once built, else the frame’s record page', () => {
    // B-W2b-196: our check of a delivery address opens the Account on that address.
    // B-W2b-191: a customer's sales order opens its own page; B-W2b-197: a return and a complaint too; B-W2b-195: an invoice opens Documents on it.
    expect(RECORD_PAGES.filter((page) => page.built).map((page) => page.type)).toEqual(['SalesOrder', 'PurchaseOrder', 'SubcontractOrder', 'ShipNotice', 'ReturnAuthorisation', 'Complaint', 'PartyAddress', 'Invoice'])
    expect(recordPageOf(['CUSTOMER'], 'ReturnAuthorisation', 'r1')).toBe('/returns/r1')
    expect(recordPageOf(['CUSTOMER'], 'Complaint', 'c1')).toBe('/returns/complaints/c1')
    expect(recordPageOf(['SUPPLIER'], 'ReturnAuthorisation', 'r1')).toBeNull()
    expect(recordPageOf(['CUSTOMER'], 'Invoice', 'i1')).toBe('/documents?invoice=i1')
    expect(recordPageOf(['SUPPLIER'], 'Invoice', 'i1')).toBeNull()
    // B-W2b-181: a workshop's job opens its own page.
    expect(recordPageOf(['SUBCONTRACTOR'], 'SubcontractOrder', 'j')).toBe('/jobs/j')
    // B-W2b-186: a supplier's ship notice opens its own page.
    expect(recordPageOf(['SUPPLIER'], 'ShipNotice', 'sn')).toBe('/deliveries/sn')
    expect(recordPageOf(['CUSTOMER'], 'PartyAddress', 'a1')).toBe('/account?address=a1#addresses')
    expect(recordPageOf(['SUPPLIER'], 'PartyAddress', 'a1')).toBeNull()
    expect(recordPageOf(['CUSTOMER'], 'SalesOrder', 'x')).toBe('/orders/x')
    expect(recordPageOf(['SUPPLIER'], 'SalesOrder', 'x')).toBeNull()
    // B-W2b-179: a supplier's purchase order opens its own page.
    expect(recordPageOf(['SUPPLIER'], 'PurchaseOrder', 'po')).toBe('/orders/po')
    const built = RECORD_PAGES.map((page) => ({ ...page, built: true }))
    expect(recordPageOf(['CUSTOMER'], 'SalesOrder', 'x', built)).toBe('/orders/x')
    expect(recordPageOf(['SUPPLIER'], 'SalesOrder', 'x', built)).toBeNull()
    expect(recordPageOf(['SUPPLIER', 'SUBCONTRACTOR'], 'SubcontractOrder', 'j', built)).toBe('/jobs/j')
  })
})

// B-W2b-203, the W2b-3 sweep (design check I8): every partner role as it signs in (its main role and the capabilities it
// gets by default), on built pages only — the rail, the badges, the phone bar and the keys.
describe('the portal rail per partner role (B-W2b-203)', () => {
  const asSigned = (key: string) => {
    const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
    const capabilities = template.capabilities.byDefault.flatMap((capability) => PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === CAPABILITY_ROLE_KEYS[capability])!.permissions)
    const held = new Set<string>([...template.permissions, ...capabilities])
    const nav = portalNavFor({ can: (permission) => held.has(permission), kinds: [template.kind as PortalKind] })
    const phone = bottomBarLayout(nav, '/')
    return {
      rail: nav.areas.map((area) => `${area.id}:${area.label}${area.badge ? `#${area.badge}` : ''}`),
      tabs: phone.tabs.map((tab) => tab.id),
      more: phone.more.map((entry) => entry.id),
      keys: portalChords(nav),
    }
  }
  const customerFull = ['home:nav.home#home', 'orders:nav.orders#orders', 'quotes:nav.catalogue', 'documents:nav.documents#documents', 'returns:nav.returns#returns', 'account:nav.account#account']
  const customerRead = ['home:nav.home#home', 'orders:nav.ordersTracking#orders', 'quotes:nav.catalogue', 'documents:nav.documents#documents', 'returns:nav.returns#returns', 'account:nav.account#account']
  const supplierOrders = ['home:nav.home#home', 'work:nav.purchaseOrders#orders', 'deliveries:nav.deliveries#deliveries', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const supplierPapers = ['home:nav.home#home', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const workshop = ['home:nav.home#home', 'work:nav.jobs#orders', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']

  it('every role of every kind: its areas, each with the badge of the one task list (none on a row that cannot show it)', () => {
    const rails = Object.fromEntries(PARTNER_ROLE_TEMPLATES.filter((entry) => entry.kind).map((entry) => [entry.key, asSigned(entry.key).rail]))
    expect(rails).toEqual({
      'customer-buyer': customerFull,
      'customer-finance': customerRead,
      'customer-quality': customerRead,
      // The Designer: the catalogue and its colleagues only.
      'customer-designer': ['home:nav.home#home', 'quotes:nav.catalogue', 'account:nav.account#account'],
      'customer-viewer': customerRead,
      'customer-admin': customerFull,
      'supplier-orders': supplierOrders,
      'supplier-invoices': supplierPapers,
      'supplier-quality': supplierPapers,
      'supplier-admin': supplierOrders,
      'subcontractor-jobs': workshop,
      'subcontractor-admin': workshop,
      // The accountant's room (B-W2b-201); the auditor's room is W3.
      'guest-accountant': ['home:nav.home#home', 'accounting:nav.accounting#documents'],
    })
  })

  it('a count leads to its requests: Quotes & samples carries its badge once a page that shows quotes or approvals is built', () => {
    const customer = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'quotes')!
    expect([customer.label, customer.href, customer.badge]).toEqual(['nav.catalogue', '/catalogue', undefined])
    const later = PORTAL_AREAS.map((def) => (def.id === 'quotes' ? { ...def, pages: def.pages!.map((page) => ({ ...page, built: true })) } : def))
    const withQuotes = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }, later).areas.find((area) => area.id === 'quotes')!
    expect([withQuotes.label, withQuotes.badge]).toEqual(['nav.quotesSamples', 'quotes'])
    // The design review draws the frame as it will be: the badge is there.
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }).areas.find((area) => area.id === 'quotes')!.badge).toBe('quotes')
  })

  it('the phone: four tabs and More for a customer; a supplier\'s one More row (Profile) is its fifth tab (the DS bar), a workshop four tabs', () => {
    expect(asSigned('customer-buyer')).toMatchObject({ tabs: ['home', 'orders', 'documents', 'returns'], more: ['quotes', 'account'] })
    expect(asSigned('customer-designer')).toMatchObject({ tabs: ['home'], more: ['quotes', 'account'] })
    // Design portal.frame bottom-bar: "Supplier: Home · Orders (or Jobs) · Deliveries · Documents + More (Profile)"; the DS bar turns a
    // More of one row into a fifth tab (bottomBarModel: a sheet with one row is a wasted tap); Sign out is in the person menu.
    expect(asSigned('supplier-orders')).toMatchObject({ tabs: ['home', 'work', 'deliveries', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('supplier-invoices')).toMatchObject({ tabs: ['home', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('subcontractor-jobs')).toMatchObject({ tabs: ['home', 'work', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('guest-accountant')).toMatchObject({ tabs: ['home', 'accounting'], more: [] })
  })

  it('keys: g h, g o and g d where the person has those areas', () => {
    expect(asSigned('customer-buyer').keys).toEqual({ h: '/', o: '/orders', d: '/documents' })
    expect(asSigned('customer-designer').keys).toEqual({ h: '/' })
    expect(asSigned('supplier-invoices').keys).toEqual({ h: '/', d: '/documents' })
    expect(asSigned('subcontractor-jobs').keys).toEqual({ h: '/', o: '/jobs', d: '/documents' })
    expect(asSigned('guest-accountant').keys).toEqual({ h: '/', d: '/accounting' })
  })

  it('every built area, page and record page has its route in the portal (app/(portal)/p/[party])', () => {
    const route = (href: string) => {
      const path = href.split(/[?#]/)[0]!.replace(/\/$/, '')
      return existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]', path, 'page.tsx'))
    }
    const hrefs = PORTAL_AREAS.flatMap((area) => [...(area.pages ?? []).filter((page) => page.built).map((page) => page.href), ...(area.built ? [area.href] : [])])
    expect(hrefs.filter((href) => !route(href))).toEqual([])
    expect(RECORD_PAGES.filter((page) => page.built && !route(page.href('[id]'))).map((page) => page.type)).toEqual([])
  })

  it('fails closed for a kind it does not know and for a person with no permission', () => {
    expect(portalNavFor({ can: everything, kinds: ['SOMETHING' as PortalKind] }).areas).toEqual([])
    for (const kind of ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const) expect(portalNavFor({ can: () => false, kinds: [kind] }).areas, kind).toEqual([])
  })
})
