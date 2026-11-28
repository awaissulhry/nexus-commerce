import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { CAPABILITY_ROLE_KEYS } from '@nexus/factory-domain/auth/partners/kinds'
import { PORTAL_AREAS as TASK_AREAS, taskArea } from '@nexus/factory-domain/portal/tasks/kinds'
import { bottomBarLayout } from '@nexus/ui/components/BottomBar/index'
import { CATALOGUE } from '../../../lib/i18n/messages'
// B-SA-054b: the address the API hands out for a notice's record.
import { portalRecordPath } from '@nexus/factory-domain/portal/home/links'
import { BADGE_JOIN, PORTAL_AREAS, PORTAL_PENDING_PERMISSIONS, portalChordLabel, portalChords, portalNavFor, portalNavLabelKeys, portalNavPermissions, portalPlace, recordPageOf, RECORD_PAGES, type PortalKind } from './portal-nav'
import { badgeOf } from '../model' // owb-po4.4
import type { AreaNav } from '@nexus/ui/patterns/shell/index'

const everything = () => true
const ids = (kind: PortalKind, everyPage = true) => portalNavFor({ can: everything, kinds: [kind], everyPage }).areas.map((area) => [area.id, area.label, area.href])
const roleCan = (key: string) => {
  const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
  return (permission: string) => template.permissions.includes(permission as never)
}

describe('the portal navigation (B-W2b-173; design portal.frame › rail, bottom bar)', () => {
  it('gives each partner kind its areas, in the design’s order, once every page is built', () => {
    // owb-po4.1 (order workflow plan § 5): the design's menu — Home · Orders · Customers · Products · People · Documents · Account.
    expect(ids('CUSTOMER').map(([id]) => id)).toEqual(['home', 'orders', 'customers', 'products', 'people', 'documents', 'account'])
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
    // owb-po4.1: Orders holds the list, New order, Production and Returns & claims; Products the Catalogue and Samples & tech packs;
    // People is its own page (owb-po4.3); Customers waits for its session (every row unbuilt: no door).
    expect(ids('CUSTOMER', false)).toEqual([
      ['home', 'nav.home', '/'],
      ['orders', 'nav.orders', '/orders'],
      ['products', 'nav.products', '/catalogue'],
      ['people', 'nav.people', '/people'],
      ['documents', 'nav.documents', '/documents'],
      ['account', 'nav.account', '/account'],
    ])
  })

  it('fails closed: a role sees only the areas its permissions open (the Designer has no orders list, documents or returns)', () => {
    const designer = portalNavFor({ can: roleCan('customer-designer'), kinds: ['CUSTOMER'], everyPage: true })
    // The Designer holds the catalogue and the samples (Products keeps both) and its colleagues (People, Account). F-CP-152: and New
    // order (it keeps drafts, portal.orderDrafts.edit): the Orders area left with that one page takes its name.
    expect(designer.areas.map((area) => [area.id, area.label])).toEqual([
      ['home', 'nav.home'],
      ['orders', 'nav.newOrder'],
      ['products', 'nav.products'],
      ['people', 'nav.people'],
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

  it('the phone: a customer gets Home · Orders · New order · Account and More; a workshop four tabs and no More', () => {
    // owb-po4.2 (plan § 5 "phone bottom bar Home · Orders · New order · Account"): New order is a row of Orders marked a tab.
    const customer = bottomBarLayout(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }), '/')
    expect(customer.tabs.map((tab) => tab.id)).toEqual(['home', 'orders', 'orders.new', 'account'])
    expect(customer.more.map((entry) => entry.id)).toEqual(['customers', 'products', 'people', 'documents'])
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
    // owb-po4.4: a page that moved into an area brings its own count (Production, Returns).
    for (const page of PORTAL_AREAS.flatMap((area) => area.pages ?? [])) if (page.badge) expect(TASK_AREAS).toContain(page.badge)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].portal ?? {}
      expect(portalNavLabelKeys().filter((key) => !(key in words))).toEqual([])
    }
  })

  it('keys: g h Home, g o Orders (or Jobs), g p Production, g d Documents', () => {
    // F-PR-10: g p Production (every page drawn); owb-po4.1: Production is a row of Orders now and keeps its key.
    expect(portalChords(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }))).toEqual({ h: '/', o: '/orders', p: '/production', d: '/documents' })
    expect(portalChords(portalNavFor({ can: everything, kinds: ['SUBCONTRACTOR'], everyPage: true }))).toEqual({ h: '/', o: '/jobs', d: '/documents' })
  })

  it('a record opens its own page once built, else the frame’s record page', () => {
    // B-W2b-196: our check of a delivery address opens the Account on that address.
    // B-W2b-191: a customer's sales order opens its own page; B-W2b-197: a return and a complaint too; B-W2b-195: an invoice opens Documents on it.
    // B-TH-222: a customer's request opens its own page (its true state and its thread).
    // B-TH-253: a project opens its own page for every kind that has projects (customer, supplier, workshop); never a guest.
    expect(RECORD_PAGES.filter((page) => page.built).map((page) => page.type)).toEqual(['SalesOrder', 'Inquiry', 'PurchaseOrder', 'SubcontractOrder', 'ShipNotice', 'ReturnAuthorisation', 'Complaint', 'RepairOrder', 'PartyAddress', 'Invoice', 'Project'])
    expect(recordPageOf(['CUSTOMER'], 'Project', 'p1')).toBe('/projects/p1')
    expect(recordPageOf(['SUPPLIER'], 'Project', 'p1')).toBe('/projects/p1')
    expect(recordPageOf(['SUBCONTRACTOR'], 'Project', 'p1')).toBe('/projects/p1')
    expect(recordPageOf(['GUEST'], 'Project', 'p1')).toBeNull()
    expect(recordPageOf(['CUSTOMER'], 'Inquiry', 'q1')).toBe('/orders/requests/q1')
    expect(recordPageOf(['SUPPLIER'], 'Inquiry', 'q1')).toBeNull()
    // B-W2b-342: a repair opens its own page.
    expect(recordPageOf(['CUSTOMER'], 'RepairOrder', 'p1')).toBe('/returns/repairs/p1')
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
  // owb-po4 (plan § 5 F): Production and Returns are rows of Orders and bring their counts (the row counts all three: one key joined
  // by BADGE_JOIN); a role with the samples page has Products with its badge (approvals are answered there); Finance keeps the Catalogue
  // (= Products, no badge). Every customer role has its colleagues: People (no count) and Account.
  const customerFull = ['home:nav.home#home', 'orders:nav.orders#orders+production+returns', 'products:nav.products#quotes', 'people:nav.people', 'documents:nav.documents#documents', 'account:nav.account#account']
  const customerRead = customerFull
  const customerFinance = ['home:nav.home#home', 'orders:nav.orders#orders+returns', 'products:nav.products', 'people:nav.people', 'documents:nav.documents#documents', 'account:nav.account#account']
  const supplierOrders = ['home:nav.home#home', 'work:nav.purchaseOrders#orders', 'deliveries:nav.deliveries#deliveries', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const supplierPapers = ['home:nav.home#home', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const workshop = ['home:nav.home#home', 'work:nav.jobs#orders', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']

  it('every role of every kind: its areas, each with the badge of the one task list (none on a row that cannot show it)', () => {
    const rails = Object.fromEntries(PARTNER_ROLE_TEMPLATES.filter((entry) => entry.kind).map((entry) => [entry.key, asSigned(entry.key).rail]))
    expect(rails).toEqual({
      'customer-buyer': customerFull,
      'customer-finance': customerFinance,
      'customer-quality': customerRead,
      // The Designer: the catalogue, the samples (B-W2b-262) and its colleagues; F-CP-152: New order (its drafts), no count.
      'customer-designer': ['home:nav.home#home', 'orders:nav.newOrder', 'products:nav.products#quotes', 'people:nav.people', 'account:nav.account#account'],
      // B-PR-13: the Production role — its orders and My production (a row of Orders, owb-po4.1), the samples (no catalogue: Products
      // takes the page's name), the shared files.
      'customer-production': ['home:nav.home#home', 'orders:nav.orders#orders+production', 'products:nav.samples#quotes', 'people:nav.people', 'documents:nav.documents#documents', 'account:nav.account#account'],
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

  it('B-W2b-F17: an approval counts on a row the partner kind has — Home for every supplier, workshop and guest role', () => {
    for (const entry of PARTNER_ROLE_TEMPLATES.filter((template) => template.kind && template.kind !== 'CUSTOMER')) {
      expect(asSigned(entry.key).rail, entry.key).toContain(`home:nav.home#${taskArea('APPROVE', entry.kind)}`)
    }
    // A customer's on Products (Samples & tech packs shows the approvals; owb-po4.1: Quotes & samples is Products).
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }).areas.find((area) => area.badge === taskArea('APPROVE', 'CUSTOMER'))?.id).toBe('products')
  })

  it('a count leads to its requests: Products carries its badge once a page that shows quotes or approvals is built', () => {
    // B-W2b-262: Samples & tech packs shows the approvals: the badge is there; owb-po4.1: Products opens the Catalogue (its own page).
    const customer = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'products')!
    expect([customer.label, customer.href, customer.badge]).toEqual(['nav.products', '/catalogue', 'quotes'])
    const catalogueOnly = portalNavFor({ can: (permission) => permission !== 'portal.samples.view', kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'products')!
    expect([catalogueOnly.label, catalogueOnly.href, catalogueOnly.badge]).toEqual(['nav.products', '/catalogue', undefined])
    // Samples only (the Production role): the area takes the page's name and address, with its badge.
    const samplesOnly = portalNavFor({ can: (permission) => permission !== 'portal.catalogue.view', kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'products')!
    expect([samplesOnly.label, samplesOnly.href, samplesOnly.badge]).toEqual(['nav.samples', '/samples', 'quotes'])
    const later = PORTAL_AREAS.map((def) => (def.id === 'products' ? { ...def, pages: def.pages!.map((page) => ({ ...page, built: true })) } : def))
    const withQuotes = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }, later).areas.find((area) => area.id === 'products')!
    expect([withQuotes.label, withQuotes.badge]).toEqual(['nav.products', 'quotes'])
    // The design review draws the frame as it will be: the badge is there.
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }).areas.find((area) => area.id === 'products')!.badge).toBe('quotes')
  })

  it('the phone: Home · Orders · New order · Account and More for a customer; a supplier\'s one More row (Profile) is its fifth tab (the DS bar), a workshop four tabs', () => {
    // owb-po4.2: New order (a row of Orders) is a tab for who may start one; Products, People and Documents under More.
    expect(asSigned('customer-buyer')).toMatchObject({ tabs: ['home', 'orders', 'orders.new', 'account'], more: ['products', 'people', 'documents'] })
    expect(asSigned('customer-finance')).toMatchObject({ tabs: ['home', 'orders', 'account'], more: ['products', 'people', 'documents'] })
    // F-CP-152: the Designer's Orders is New order itself (one page): one tab.
    expect(asSigned('customer-designer')).toMatchObject({ tabs: ['home', 'orders', 'account'], more: ['products', 'people'] })
    // Design portal.frame bottom-bar: "Supplier: Home · Orders (or Jobs) · Deliveries · Documents + More (Profile)"; the DS bar turns a
    // More of one row into a fifth tab (bottomBarModel: a sheet with one row is a wasted tap); Sign out is in the person menu.
    expect(asSigned('supplier-orders')).toMatchObject({ tabs: ['home', 'work', 'deliveries', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('supplier-invoices')).toMatchObject({ tabs: ['home', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('subcontractor-jobs')).toMatchObject({ tabs: ['home', 'work', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('guest-accountant')).toMatchObject({ tabs: ['home', 'accounting'], more: [] })
  })

  it('keys: g h, g o and g d where the person has those areas', () => {
    // F-PR-11: g p opens My production (owb-po4.1: a row of Orders that keeps its key).
    expect(asSigned('customer-buyer').keys).toEqual({ h: '/', o: '/orders', p: '/production', d: '/documents' })
    expect(asSigned('customer-finance').keys).toEqual({ h: '/', o: '/orders', d: '/documents' })
    expect(asSigned('customer-designer').keys).toEqual({ h: '/', o: '/orders/new' }) // F-CP-152
    expect(asSigned('supplier-invoices').keys).toEqual({ h: '/', d: '/documents' })
    expect(asSigned('subcontractor-jobs').keys).toEqual({ h: '/', o: '/jobs', d: '/documents' })
    expect(asSigned('guest-accountant').keys).toEqual({ h: '/', d: '/accounting' })
  })

  it('every built area, page and record page has its route in the portal (app/(portal)/p/[party])', () => {
    const route = (href: string) => {
      // B-TH-253: a page may encode its id (Project does), so `[id]` arrives as %5Bid%5D: the route's folder is the decoded path.
      const path = decodeURIComponent(href.split(/[?#]/)[0]!).replace(/\/$/, '')
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

// ── F-PR-10 (production plan §5; 06-tree B.0; 09-design (d)): the customer's Production and Waiting for you ──
// owb-po4.1 (order workflow plan § 5 F, "nothing is lost"): Production is a row of Orders now (its id, key and count kept), and
// Waiting for you is Home's card "What waits for you" (its page stays; the menu draws no row for it).
describe('the Production row and Waiting for you (F-PR-10, moved by owb-po4.1)', () => {
  const signedAs = (key: string) => {
    const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
    const capabilities = template.capabilities.byDefault.flatMap((capability) => PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === CAPABILITY_ROLE_KEYS[capability])!.permissions)
    const held = new Set<string>([...template.permissions, ...capabilities])
    const nav = portalNavFor({ can: (permission) => held.has(permission), kinds: [template.kind as PortalKind] })
    const pagesOf = (id: string) => nav.areas.find((area) => area.id === id)?.sections?.flatMap((section) => section.items.map((item) => item.id)) ?? []
    return { nav, areas: nav.areas.map((area) => area.id), orderPages: pagesOf('orders'), homePages: pagesOf('home'), keys: portalChords(nav) }
  }

  it('declares Production as a row of Orders for customers with portal.production.view: key p, its own count, built', () => {
    const page = PORTAL_AREAS.find((area) => area.id === 'orders')!.pages!.find((entry) => entry.id === 'production')!
    expect(page).toMatchObject({ label: 'nav.production', href: '/production', permission: 'portal.production.view', key: 'p', badge: 'production', built: true })
    expect(PORTAL_AREAS.map((area) => area.id)).not.toContain('production')
  })

  it('PW-P01 (nav): Production shows only to a customer session that holds portal.production.view — no other partner kind, no other role', () => {
    const roles = Object.fromEntries(PARTNER_ROLE_TEMPLATES.filter((entry) => entry.kind).map((entry) => [entry.key, signedAs(entry.key).orderPages.includes('production')]))
    expect(roles).toEqual({
      'customer-buyer': true,
      'customer-finance': false,
      'customer-quality': true,
      'customer-designer': false,
      'customer-production': true,
      'customer-viewer': true,
      'customer-admin': true,
      'supplier-orders': false,
      'supplier-invoices': false,
      'supplier-quality': false,
      'supplier-admin': false,
      'subcontractor-jobs': false,
      'subcontractor-admin': false,
      'guest-accountant': false,
    })
    // Fails closed: a supplier, a workshop or a guest never gets it, even holding the permission.
    for (const kind of ['SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const) expect(JSON.stringify(portalNavFor({ can: everything, kinds: [kind] }))).not.toContain('/production')
    // A customer without the permission: no row, no key.
    const without = portalNavFor({ can: (permission) => permission !== 'portal.production.view', kinds: ['CUSTOMER'] })
    expect(JSON.stringify(without)).not.toContain('/production')
    expect(portalChords(without).p).toBeUndefined()
    for (const key of ['customer-finance', 'customer-designer']) expect(signedAs(key).keys.p, key).toBeUndefined()
  })

  it('My production lights Orders (the rail, the phone) and its own row of the sub-sidebar; g p opens it', () => {
    const { nav, keys } = signedAs('customer-buyer')
    expect([portalPlace(nav, '/production')?.area.id, portalPlace(nav, '/production')?.item?.id]).toEqual(['orders', 'production'])
    expect(bottomBarLayout(nav, '/production').current).toBe('orders')
    expect(keys.p).toBe('/production')
    expect(portalChordLabel(nav, '/production')).toBe('nav.production')
  })

  it('Waiting for you: no menu row any more — Home is one page again, its name, address and badge; /waiting still lights Home', () => {
    const home = PORTAL_AREAS.find((area) => area.id === 'home')!
    expect(home.pages!.find((page) => page.id === 'home.waiting')).toMatchObject({ href: '/waiting', permission: 'portal.approvals.view', kinds: ['CUSTOMER'], menu: false, built: true })
    for (const key of ['customer-production', 'customer-buyer', 'customer-admin', 'customer-quality', 'customer-viewer', 'customer-designer', 'customer-finance', 'supplier-orders', 'subcontractor-jobs', 'guest-accountant']) {
      const signed = signedAs(key)
      expect(signed.homePages, key).toEqual([])
      expect(signed.nav.areas.find((area) => area.id === 'home'), key).toMatchObject({ label: 'nav.home', href: '/', badge: 'home' })
    }
    // The page is reached from Home's card: the address is placed in Home (the rail lights Home), as a card's page.
    const nav = signedAs('customer-buyer').nav
    expect(portalPlace(nav, '/waiting')).toMatchObject({ area: { id: 'home' }, card: true })
    expect(portalPlace(nav, '/waiting')?.item).toBeUndefined()
    // A page no row and no card owns is nobody's (a record's generic page): nothing is lit.
    expect(portalPlace(nav, '/open/Ddt/x')).toBeNull()
    expect(portalPlace(nav, '/orders')?.area.id).toBe('orders')
  })

  it('names the areas in both languages, and the roles that see production say so', () => {
    for (const locale of ['it', 'en'] as const) {
      const portal = CATALOGUE[locale].portal ?? {}
      expect([portal['nav.production'], portal['nav.waiting']].every(Boolean), locale).toBe(true)
      expect(portal['role.customer-production'], locale).toBeTruthy()
      expect(portal['role.customer-quality'], locale).toBeTruthy()
      const access = CATALOGUE[locale]['portal-access'] ?? {}
      const account = CATALOGUE[locale]['portal-account'] ?? {}
      const word = locale === 'it' ? /produzione/i : /production/i
      for (const key of ['customer-production', 'customer-quality', 'customer-buyer', 'customer-viewer']) {
        expect(access[`roleLine.${key}`], `${locale} roleLine.${key}`).toMatch(word)
        expect(account[`role.sees.${key}`], `${locale} role.sees.${key}`).toMatch(word)
      }
      // Designer and Finance do not see production: their words never promise it.
      for (const key of ['customer-designer', 'customer-finance']) {
        expect(access[`roleLine.${key}`], `${locale} roleLine.${key}`).not.toMatch(word)
        expect(account[`role.sees.${key}`], `${locale} role.sees.${key}`).not.toMatch(word)
      }
    }
  })
})
// ── end F-PR-10 ──

// ── B-SA-054b (sales page plan R8; 14-change-flow §5): the workshop's notice of an order change opens its own job page ────────────
describe("B-SA-054b: a workshop's \"Order changed — check quantities\" opens its own job, walled to that workshop", () => {
  it('the notice\'s /open/SubcontractOrder/<id> takes a workshop person to Jobs › the job; no other kind has a page for it', () => {
    // The API's link (platform/portal/notifications inbox and mail): the portal's /open/ address of the notice's record.
    expect(portalRecordPath('WS-DEMO', 'SubcontractOrder', 'j1')).toBe('/p/WS-DEMO/open/SubcontractOrder/j1')
    // The open page (app/(portal)/p/[party]/open/[type]/[id]) sends the person to the record's own page of their kind.
    expect(recordPageOf(['SUBCONTRACTOR'], 'SubcontractOrder', 'j1')).toBe('/jobs/j1')
    for (const kind of ['CUSTOMER', 'SUPPLIER', 'GUEST'] as const) expect(recordPageOf([kind], 'SubcontractOrder', 'j1'), kind).toBeNull()
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]/jobs/[id]/page.tsx'))).toBe(true)
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]/open/[type]/[id]/page.tsx'))).toBe(true)
  })

  it('only a workshop role reads jobs (the notice\'s readers): every holder of portal.jobs.view is of the SUBCONTRACTOR kind', () => {
    const readers = PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes('portal.jobs.view' as never))
    expect(readers.length).toBeGreaterThan(0)
    for (const template of readers) expect(template.kind, template.key).toBe('SUBCONTRACTOR')
  })
})
// ── end B-SA-054b ──

// ── F-CP-152 (customer page plan C5, 12 §2 Doors): the Orders area is any of its pages ──────────────────────────────────────────
describe('F-CP-152 — Orders is any of its pages: a brand Designer sees New order only; the Buyer is unchanged', () => {
  const signed = (permissions: readonly string[]) => portalNavFor({ can: (permission) => permissions.includes(permission), kinds: ['CUSTOMER'] })
  const orders = (permissions: readonly string[]) => signed(['portal.home.view', ...permissions]).areas.find((area) => area.id === 'orders')

  it('the Designer (drafts, no orders): one page, New order, its address and name, no count, key g o', () => {
    const area = orders(['portal.orderDrafts.edit'])!
    expect([area.label, area.href, area.badge, area.sections]).toEqual(['nav.newOrder', '/orders/new', undefined, undefined])
    expect(portalChords(signed(['portal.home.view', 'portal.orderDrafts.edit'])).o).toBe('/orders/new')
  })

  it('the Buyer (orders, drafts, ordering): both pages, the area’s own name and address, its count', () => {
    const area = orders(['portal.salesOrders.view', 'portal.orderDrafts.edit', 'portal.orderRequests.manage'])!
    expect([area.label, area.href, area.badge]).toEqual(['nav.orders', '/orders', 'orders'])
    expect(area.sections!.flatMap((section) => section.items).map((item) => [item.id, item.href])).toEqual([
      ['orders.list', '/orders'],
      ['orders.new', '/orders/new'],
    ])
  })

  it('New order opens with either right: who keeps drafts, or who may order (the request like an e-mail); neither: no door', () => {
    expect(orders(['portal.salesOrders.view', 'portal.orderRequests.manage'])!.sections!.flatMap((section) => section.items).map((item) => item.id)).toEqual(['orders.list', 'orders.new'])
    expect(orders(['portal.orderRequests.manage'])!.href).toBe('/orders/new')
    // Orders only: the list, its name (owb-po4.1: the design's one name, "Orders"), its count.
    expect([orders(['portal.salesOrders.view'])!.label, orders(['portal.salesOrders.view'])!.badge]).toEqual(['nav.orders', 'orders'])
    // Neither orders nor drafts nor ordering: no Orders area at all (fails closed), whatever home.view says.
    expect(orders([])).toBeUndefined()
    expect(portalNavPermissions()).toEqual(expect.arrayContaining(['portal.orderDrafts.edit', 'portal.orderRequests.manage']))
  })
})
// ── end F-CP-152 ──

// ── owb-po4 (order workflow plan § 5 "Customer portal", § 5 F; the design's PORTAL_NAV) ──────────────────────────────────────────
describe('owb-po4 — the portal menu: the five doors move, nothing is lost', () => {
  const rowsOf = (nav: AreaNav) => nav.areas.flatMap((area) => [area.id, ...(area.sections ?? []).flatMap((section) => section.items.map((item) => item.id))])
  const hrefsOf = (nav: AreaNav) => nav.areas.flatMap((area) => [area.href, ...(area.sections ?? []).flatMap((section) => section.items.map((item) => item.href))])
  // Every customer door of the menu before owb-po4 (Home, Waiting for you, Orders & requests, New order, Production, Samples & tech packs,
  // Catalogue, Documents, Returns & claims, Account): each still opens, from a row or from Home's card.
  const OLD_DOORS: readonly (readonly [string, string])[] = [
    ['/', 'home'],
    ['/waiting', 'home'],
    ['/orders', 'orders'],
    ['/orders/new', 'orders'],
    ['/production', 'orders'],
    ['/returns', 'orders'],
    ['/samples', 'products'],
    ['/catalogue', 'products'],
    ['/documents', 'documents'],
    ['/account', 'account'],
  ]

  it('every old door is reachable: a row of its new area, or Home\'s card (Waiting for you); its route is still there', () => {
    const nav = portalNavFor({ can: everything, kinds: ['CUSTOMER'] })
    for (const [door, area] of OLD_DOORS) {
      const place = portalPlace(nav, door)
      expect(place?.area.id, door).toBe(area)
      expect(hrefsOf(nav).includes(door) || place?.card === true, door).toBe(true)
      expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]', door, 'page.tsx')), door).toBe(true)
    }
    // Projects, Terms, the request page and the record pages are kept (not menu doors): their routes and RECORD_PAGES lines stand.
    expect(recordPageOf(['CUSTOMER'], 'Inquiry', 'q1')).toBe('/orders/requests/q1')
    for (const route of ['projects/[id]', 'terms', 'orders/requests/[id]']) expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/(portal)/p/[party]', route, 'page.tsx')), route).toBe(true)
  })

  it('the design\'s order and words: Home · Orders · Customers · Products · People · Documents · Account (every page drawn, prices seen)', () => {
    const review = portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true, prices: true })
    expect(review.areas.map((area) => [area.id, area.label])).toEqual([
      ['home', 'nav.home'],
      ['orders', 'nav.orders'],
      ['customers', 'nav.customers'],
      ['products', 'nav.products'],
      ['people', 'nav.people'],
      ['documents', 'nav.documents'],
      ['account', 'nav.account'],
    ])
    const orders = review.areas.find((area) => area.id === 'orders')!.sections!.flatMap((section) => section.items)
    expect(orders.map((item) => [item.id, item.label])).toEqual([
      ['orders.list', 'nav.orders'],
      ['orders.prices', 'nav.prices'],
      ['orders.agreedPrices', 'nav.agreedPrices'],
      ['orders.new', 'nav.newOrder'],
      ['production', 'nav.production'],
      ['returns', 'nav.returns'],
    ])
    expect(review.areas.find((area) => area.id === 'customers')!.sections!.flatMap((section) => section.items.map((item) => item.id))).toEqual(['customers.list', 'customers.payments'])
    expect(review.areas.find((area) => area.id === 'products')!.sections!.flatMap((section) => section.items.map((item) => item.id))).toEqual(['products.catalogue', 'products.samples', 'products.quotes'])
  })

  it('built:false rows are absent: Prices, Agreed prices, Your customers, Payments (Customers has no door while all its rows are hidden)', () => {
    const buyer = portalNavFor({ can: everything, kinds: ['CUSTOMER'], prices: true })
    for (const id of ['orders.prices', 'orders.agreedPrices', 'customers', 'customers.list', 'customers.payments', 'products.quotes']) expect(rowsOf(buyer), id).not.toContain(id)
    for (const id of ['orders.prices', 'orders.agreedPrices', 'customers.list', 'customers.payments']) expect(PORTAL_AREAS.flatMap((area) => area.pages ?? []).find((page) => page.id === id)?.built, id).toBe(false)
    expect(PORTAL_PENDING_PERMISSIONS.has('portal.brandCustomers.view')).toBe(true)
  })

  it('a Designer sees no Prices row — never, not even in the design review; money fails closed while prices are unknown', () => {
    const designer = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === 'customer-designer')!
    expect(designer.grains).toEqual([])
    for (const prices of [false, undefined, true]) {
      const nav = portalNavFor({ can: roleCan('customer-designer'), kinds: ['CUSTOMER'], everyPage: true, prices })
      expect(rowsOf(nav).filter((id) => /prices|payments/i.test(id)), String(prices)).toEqual([])
    }
    // Everything held, prices not known (the frame before GET /portal/access answers): no money row.
    expect(rowsOf(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true })).filter((id) => /prices|payments/i.test(id))).toEqual([])
    // A buyer who sees prices: the rows, once drawn.
    expect(rowsOf(portalNavFor({ can: roleCan('customer-buyer'), kinds: ['CUSTOMER'], everyPage: true, prices: true }))).toEqual(expect.arrayContaining(['orders.prices', 'orders.agreedPrices']))
  })

  it('owb-po4.4: every task-list area lands on a badge of a rail row — no count is lost when a door moves', () => {
    const keysOf = (nav: AreaNav) => nav.areas.flatMap((area) => (area.badge ? area.badge.split(BADGE_JOIN) : []))
    const landed = new Set([...keysOf(portalNavFor({ can: everything, kinds: ['CUSTOMER'] })), ...keysOf(portalNavFor({ can: everything, kinds: ['SUPPLIER'] }))])
    expect(TASK_AREAS.filter((area) => !landed.has(area))).toEqual([])
    // The rows of Orders carry their own count in the sub-sidebar; the rail row adds them up (one key, joined).
    const orders = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'orders')!
    expect(orders.badge).toBe(['orders', 'production', 'returns'].join(BADGE_JOIN))
    expect(orders.sections!.flatMap((section) => section.items).filter((item) => item.badge).map((item) => [item.id, item.badge])).toEqual([
      ['production', 'production'],
      ['returns', 'returns'],
    ])
    const badges = { orders: { count: 2, words: '2 to confirm' }, returns: { count: 1, words: '1 to send back' } }
    expect(badgeOf(badges, orders.badge)).toEqual({ count: 3, words: '2 to confirm, 1 to send back' })
    expect(badgeOf(badges, 'production')).toBeNull()
    expect(badgeOf(null, orders.badge)).toBeNull()
    expect(badgeOf(badges, undefined)).toBeNull()
  })
})
// ── end owb-po4 ──
