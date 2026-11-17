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
import { PORTAL_AREAS, PORTAL_PENDING_PERMISSIONS, portalChords, portalNavFor, portalNavLabelKeys, portalNavPermissions, portalPlace, recordPageOf, RECORD_PAGES, type PortalAreaDef, type PortalKind } from './portal-nav'

const everything = () => true
const ids = (kind: PortalKind, everyPage = true) => portalNavFor({ can: everything, kinds: [kind], everyPage }).areas.map((area) => [area.id, area.label, area.href])
const roleCan = (key: string) => {
  const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
  return (permission: string) => template.permissions.includes(permission as never)
}

describe('the portal navigation (B-W2b-173; design portal.frame › rail, bottom bar)', () => {
  it('gives each partner kind its areas, in the design’s order, once every page is built', () => {
    // F-PR-10: Production after Orders (the design review draws every page).
    expect(ids('CUSTOMER').map(([id]) => id)).toEqual(['home', 'orders', 'production', 'quotes', 'documents', 'returns', 'account'])
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
      // F-PR-11: My production.
      ['production', 'nav.production', '/production'],
      // B-W2b-262: Samples & tech packs joins the Catalogue (two pages: the area keeps its name; Quotes & requests is not built, so
      // the area opens its first page).
      ['quotes', 'nav.quotesSamples', '/samples'],
      ['documents', 'nav.documents', '/documents'],
      ['returns', 'nav.returns', '/returns'],
      ['account', 'nav.account', '/account'],
    ])
  })

  it('fails closed: a role sees only the areas its permissions open (the Designer has no orders, documents or returns)', () => {
    const designer = portalNavFor({ can: roleCan('customer-designer'), kinds: ['CUSTOMER'], everyPage: true })
    // The Designer holds the catalogue and the samples (B-W2b-262; Quotes & samples keeps both) and its colleagues (Account).
    expect(designer.areas.map((area) => [area.id, area.label])).toEqual([
      ['home', 'nav.home'],
      ['quotes', 'nav.quotesSamples'],
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

  it('the phone: a customer gets four tabs and More (Quotes & samples, Returns, Account); a workshop four tabs and no More', () => {
    // F-PR-10: with Production a tab after Orders, Returns goes under More (every page drawn: the customer holds Production).
    const customer = bottomBarLayout(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }), '/')
    expect(customer.tabs.map((tab) => tab.id)).toEqual(['home', 'orders', 'production', 'documents'])
    expect(customer.more.map((entry) => entry.id)).toEqual(['quotes', 'returns', 'account'])
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

  it('keys: g h Home, g o Orders (or Jobs), g p Production, g d Documents', () => {
    // F-PR-10: g p Production (every page drawn).
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
  // B-W2b-262: a role with the samples page has Quotes & samples with its badge (approvals are answered there); Finance keeps the Catalogue.
  // F-PR-11: the roles that see production (Buyer, Admin, Quality, Viewer, Production) have My production after Orders, no badge.
  const customerFull = ['home:nav.home#home', 'orders:nav.orders#orders', 'production:nav.production', 'quotes:nav.quotesSamples#quotes', 'documents:nav.documents#documents', 'returns:nav.returns#returns', 'account:nav.account#account']
  const customerRead = ['home:nav.home#home', 'orders:nav.ordersRequests#orders', 'production:nav.production', 'quotes:nav.quotesSamples#quotes', 'documents:nav.documents#documents', 'returns:nav.returns#returns', 'account:nav.account#account']
  const customerFinance = ['home:nav.home#home', 'orders:nav.ordersRequests#orders', 'quotes:nav.catalogue', 'documents:nav.documents#documents', 'returns:nav.returns#returns', 'account:nav.account#account']
  const supplierOrders = ['home:nav.home#home', 'work:nav.purchaseOrders#orders', 'deliveries:nav.deliveries#deliveries', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const supplierPapers = ['home:nav.home#home', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']
  const workshop = ['home:nav.home#home', 'work:nav.jobs#orders', 'supplier-documents:nav.documents#documents', 'profile:nav.profile#account']

  it('every role of every kind: its areas, each with the badge of the one task list (none on a row that cannot show it)', () => {
    const rails = Object.fromEntries(PARTNER_ROLE_TEMPLATES.filter((entry) => entry.kind).map((entry) => [entry.key, asSigned(entry.key).rail]))
    expect(rails).toEqual({
      'customer-buyer': customerFull,
      'customer-finance': customerFinance,
      'customer-quality': customerRead,
      // The Designer: the catalogue, the samples (B-W2b-262) and its colleagues only.
      'customer-designer': ['home:nav.home#home', 'quotes:nav.quotesSamples#quotes', 'account:nav.account#account'],
      // B-PR-13: the Production role — its orders, the samples (no catalogue), the shared files; its Production area (F-PR-10
      // declared it, F-PR-11 built My production).
      'customer-production': ['home:nav.home#home', 'orders:nav.ordersRequests#orders', 'production:nav.production', 'quotes:nav.samples#quotes', 'documents:nav.documents#documents', 'account:nav.account#account'],
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
    // A customer's on Quotes & samples (its badge once a page that shows approvals is built; Home lists them meanwhile).
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }).areas.find((area) => area.badge === taskArea('APPROVE', 'CUSTOMER'))?.id).toBe('quotes')
  })

  it('a count leads to its requests: Quotes & samples carries its badge once a page that shows quotes or approvals is built', () => {
    // B-W2b-262: Samples & tech packs shows the approvals: the badge is there, the area opens its first built page.
    const customer = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'quotes')!
    expect([customer.label, customer.href, customer.badge]).toEqual(['nav.quotesSamples', '/samples', 'quotes'])
    const catalogueOnly = portalNavFor({ can: (permission) => permission !== 'portal.samples.view', kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'quotes')!
    expect([catalogueOnly.label, catalogueOnly.href, catalogueOnly.badge]).toEqual(['nav.catalogue', '/catalogue', undefined])
    const later = PORTAL_AREAS.map((def) => (def.id === 'quotes' ? { ...def, pages: def.pages!.map((page) => ({ ...page, built: true })) } : def))
    const withQuotes = portalNavFor({ can: everything, kinds: ['CUSTOMER'] }, later).areas.find((area) => area.id === 'quotes')!
    expect([withQuotes.label, withQuotes.badge]).toEqual(['nav.quotesSamples', 'quotes'])
    // The design review draws the frame as it will be: the badge is there.
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'], everyPage: true }).areas.find((area) => area.id === 'quotes')!.badge).toBe('quotes')
  })

  it('the phone: four tabs and More for a customer; a supplier\'s one More row (Profile) is its fifth tab (the DS bar), a workshop four tabs', () => {
    // F-PR-11: My production is a tab after Orders for the buyer, so Returns goes under More.
    expect(asSigned('customer-buyer')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'returns', 'account'] })
    expect(asSigned('customer-finance')).toMatchObject({ tabs: ['home', 'orders', 'documents', 'returns'], more: ['quotes', 'account'] })
    expect(asSigned('customer-designer')).toMatchObject({ tabs: ['home'], more: ['quotes', 'account'] })
    // Design portal.frame bottom-bar: "Supplier: Home · Orders (or Jobs) · Deliveries · Documents + More (Profile)"; the DS bar turns a
    // More of one row into a fifth tab (bottomBarModel: a sheet with one row is a wasted tap); Sign out is in the person menu.
    expect(asSigned('supplier-orders')).toMatchObject({ tabs: ['home', 'work', 'deliveries', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('supplier-invoices')).toMatchObject({ tabs: ['home', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('subcontractor-jobs')).toMatchObject({ tabs: ['home', 'work', 'supplier-documents', 'profile'], more: [] })
    expect(asSigned('guest-accountant')).toMatchObject({ tabs: ['home', 'accounting'], more: [] })
  })

  it('keys: g h, g o and g d where the person has those areas', () => {
    // F-PR-11: g p opens My production.
    expect(asSigned('customer-buyer').keys).toEqual({ h: '/', o: '/orders', p: '/production', d: '/documents' })
    expect(asSigned('customer-finance').keys).toEqual({ h: '/', o: '/orders', d: '/documents' })
    expect(asSigned('customer-designer').keys).toEqual({ h: '/' })
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

// ── F-PR-10 (production plan §5; 06-tree B.0; 09-design (d)): the customer's Production area and Home › Waiting for you ──
describe('the Production area and Waiting for you (F-PR-10)', () => {
  // The pages as built (F-PR-11 /production, F-PR-14 /waiting): kept as their own list so a later page step reads the same.
  const BUILT: readonly PortalAreaDef[] = PORTAL_AREAS.map((def) => (def.id === 'production' ? { ...def, built: true } : def.id === 'home' ? { ...def, pages: def.pages!.map((page) => ({ ...page, built: true })) } : def))
  const signedAs = (key: string, defs: readonly PortalAreaDef[] = BUILT) => {
    const template = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === key)!
    const capabilities = template.capabilities.byDefault.flatMap((capability) => PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === CAPABILITY_ROLE_KEYS[capability])!.permissions)
    const held = new Set<string>([...template.permissions, ...capabilities])
    const nav = portalNavFor({ can: (permission) => held.has(permission), kinds: [template.kind as PortalKind] }, defs)
    const phone = bottomBarLayout(nav, '/')
    const home = nav.areas.find((area) => area.id === 'home')
    return {
      nav,
      areas: nav.areas.map((area) => area.id),
      homePages: home?.sections?.flatMap((section) => section.items.map((item) => item.id)) ?? [],
      tabs: phone.tabs.map((tab) => tab.id),
      more: phone.more.map((entry) => entry.id),
      keys: portalChords(nav, defs),
    }
  }

  it('declares Production after Orders for customers with portal.production.view, key p, a phone tab, and no badge yet', () => {
    const def = PORTAL_AREAS.find((area) => area.id === 'production')!
    expect(def).toMatchObject({ label: 'nav.production', href: '/production', permission: 'portal.production.view', kinds: ['CUSTOMER'], phone: 'tab', key: 'p' })
    // No count of production items waiting on the customer exists yet (B-PR-20 / F-PR-15): never a made-up number.
    expect(def.badge).toBeUndefined()
    expect(PORTAL_AREAS.map((area) => area.id).indexOf('production')).toBe(PORTAL_AREAS.map((area) => area.id).indexOf('orders') + 1)
  })

  it('draws a door only to a page that exists: My production (F-PR-11) and Waiting for you (F-PR-14) are built', () => {
    expect(PORTAL_AREAS.find((area) => area.id === 'production')!.built).toBe(true)
    // F-PR-14: /waiting exists (app/(portal)/p/[party]/waiting/page.tsx): its door is drawn for those who see approvals.
    expect(PORTAL_AREAS.find((area) => area.id === 'home')!.pages!.find((page) => page.id === 'home.waiting')!.built).toBe(true)
    for (const key of ['customer-production', 'customer-buyer', 'customer-admin', 'customer-quality', 'customer-viewer']) {
      const today = signedAs(key, PORTAL_AREAS)
      expect(today.areas, key).toContain('production')
      expect(today.homePages, key).toEqual(['home.overview', 'home.waiting'])
      expect(today.keys.p, key).toBe('/production')
    }
    // The Designer answers sample and artwork approvals: Waiting for you, no production.
    expect(signedAs('customer-designer', PORTAL_AREAS).homePages).toEqual(['home.overview', 'home.waiting'])
    // Finance and the Designer do not see production: no door, no key.
    for (const key of ['customer-finance', 'customer-designer']) {
      const today = signedAs(key, PORTAL_AREAS)
      expect(today.areas, key).not.toContain('production')
      expect(today.keys.p, key).toBeUndefined()
    }
    // Finance sees no approvals: Home keeps its name and address with its one page.
    expect(signedAs('customer-finance', PORTAL_AREAS).homePages).toEqual([])
    const home = portalNavFor({ can: (permission) => permission !== 'portal.approvals.view', kinds: ['CUSTOMER'] }).areas.find((area) => area.id === 'home')!
    expect([home.label, home.href, home.badge, home.sections]).toEqual(['nav.home', '/', 'home', undefined])
  })

  it('PW-P01 (nav): Production shows only to a customer session that holds portal.production.view — no other partner kind, no other role', () => {
    const roles = Object.fromEntries(PARTNER_ROLE_TEMPLATES.filter((entry) => entry.kind).map((entry) => [entry.key, signedAs(entry.key).areas.includes('production')]))
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
    for (const kind of ['SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const) expect(portalNavFor({ can: everything, kinds: [kind] }, BUILT).areas.map((area) => area.id), kind).not.toContain('production')
    // A customer without the permission: no area, no key.
    const without = portalNavFor({ can: (permission) => permission !== 'portal.production.view', kinds: ['CUSTOMER'] }, BUILT)
    expect(without.areas.map((area) => area.id)).not.toContain('production')
    expect(portalChords(without, BUILT).p).toBeUndefined()
    // The manifest is data with no figure: the area carries no count of anyone's orders.
    expect(portalNavFor({ can: everything, kinds: ['CUSTOMER'] }, BUILT).areas.find((area) => area.id === 'production')).toMatchObject({ label: 'nav.production', href: '/production' })
  })

  it('the phone: Production is a tab after Orders and Returns goes under More — only for the people with Production', () => {
    expect(signedAs('customer-buyer')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'returns', 'account'] })
    expect(signedAs('customer-admin')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'returns', 'account'] })
    expect(signedAs('customer-quality')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'returns', 'account'] })
    expect(signedAs('customer-viewer')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'returns', 'account'] })
    // The Production role has no Returns: Samples and Account under More.
    expect(signedAs('customer-production')).toMatchObject({ tabs: ['home', 'orders', 'production', 'documents'], more: ['quotes', 'account'] })
    // Without Production nothing moves: Returns stays a tab.
    expect(signedAs('customer-finance')).toMatchObject({ tabs: ['home', 'orders', 'documents', 'returns'], more: ['quotes', 'account'] })
    expect(signedAs('customer-designer')).toMatchObject({ tabs: ['home'], more: ['quotes', 'account'] })
    // My production lights the Production tab.
    expect(bottomBarLayout(signedAs('customer-buyer').nav, '/production').current).toBe('production')
  })

  it('Home › Waiting for you: a second Home page for a customer who sees approvals (the Designer too), never for a supplier', () => {
    const home = PORTAL_AREAS.find((area) => area.id === 'home')!
    expect(home.pages!.map((page) => [page.id, page.label, page.href, page.permission])).toEqual([
      ['home.overview', 'nav.home', '/', 'portal.home.view'],
      ['home.waiting', 'nav.waiting', '/waiting', 'portal.approvals.view'],
    ])
    expect(home.pages!.find((page) => page.id === 'home.waiting')!.kinds).toEqual(['CUSTOMER'])
    for (const key of ['customer-production', 'customer-buyer', 'customer-admin', 'customer-quality', 'customer-viewer', 'customer-designer']) expect(signedAs(key).homePages, key).toEqual(['home.overview', 'home.waiting'])
    // Finance does not see approvals: Home stays one page, its own name and address.
    expect(signedAs('customer-finance').homePages).toEqual([])
    for (const key of ['supplier-orders', 'supplier-quality', 'subcontractor-jobs', 'guest-accountant']) {
      const signed = signedAs(key)
      expect(signed.homePages, key).toEqual([])
      expect(signed.nav.areas.find((area) => area.id === 'home'), key).toMatchObject({ label: 'nav.home', href: '/' })
    }
    // The area stays Home (name, address, its badge); the page rows carry no number until F-PR-15 brings the count.
    const area = signedAs('customer-buyer').nav.areas.find((entry) => entry.id === 'home')!
    expect([area.label, area.href, area.badge]).toEqual(['nav.home', '/', 'home'])
    expect(area.sections!.flatMap((section) => section.items).map((item) => item.badge)).toEqual([undefined, undefined])
  })

  it('Waiting for you is a place under Home: the band names the page, the phone lights Home', () => {
    const nav = signedAs('customer-buyer').nav
    expect([portalPlace(nav, '/waiting')?.area.id, portalPlace(nav, '/waiting')?.item?.id]).toEqual(['home', 'home.waiting'])
    expect([portalPlace(nav, '/')?.area.id, portalPlace(nav, '/')?.item?.id]).toEqual(['home', 'home.overview'])
    // Home's own page is never the owner of another address.
    expect(portalPlace(nav, '/orders')?.area.id).toBe('orders')
    expect(bottomBarLayout(nav, '/waiting').current).toBe('home')
  })

  it('keys: g p opens Production where the person has it', () => {
    expect(signedAs('customer-buyer').keys).toEqual({ h: '/', o: '/orders', p: '/production', d: '/documents' })
    expect(signedAs('customer-production').keys).toEqual({ h: '/', o: '/orders', p: '/production', d: '/documents' })
    expect(signedAs('customer-finance').keys).toEqual({ h: '/', o: '/orders', d: '/documents' })
    expect(signedAs('customer-designer').keys).toEqual({ h: '/' })
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
