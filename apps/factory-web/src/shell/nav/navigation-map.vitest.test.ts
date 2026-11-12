import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { FLOOR_SYNC_KINDS } from '@nexus/factory-domain/floor-sync/kinds'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { LENS_RULES } from '@nexus/factory-domain/insights/flow'
import { LINK_PURPOSES, PURPOSE_RULES } from '@nexus/factory-domain/links/purposes'
import { NUMBER_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { areaSubNavGroups, findAreaNavPlace, type AreaNav, type AreaNavItem } from '@nexus/ui/patterns/shell/index'
import { NEW_VERBS } from '../../areas/home/today/model'
import { PANELS } from '../../areas/home/today/panels'
import { SEARCH_TYPES } from '../../areas/search/model'
import { FLOOR_MODES, homeTiles, MAX_TILES, TILE_KEYS, tilePage, TILE_RULES, type FloorMode, type TileKey } from '../../floor/model'
import { whatKeyOf } from '../../floor/queue/actions'
import { LABEL_TYPES, type ScanRead } from '../../floor/scan/scan-model'
import { TASK_ROUTES, taskForScan, taskOfTile } from '../../floor/tasks/routes'
import { LOCALES, type Locale } from '../../lib/i18n/locales'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../lib/i18n/messages'
import { attentionAddress, hasRecordPage, LIST_PAGES, listAddress, RECORD_PAGES, recordAddress } from '../../lib/records/record-links'
import { permissionCheck } from '../../lib/session/session'
import { LINK_TASK_RULES, LINK_TASKS, linkKinds, linkTaskOf } from '../../links/_nav/link-types'
import { matchPages } from '../palette/palette-model'
import { FLOOR, FLOOR_NO_TILE, FRAME, LINKS, LINKS_NO_TOKEN, OFFICE, type TreePage } from './approved-tree'
import { FRAME_PAGES, OFFICE_NAV, OFFICE_PAGES, officeAreaDeclarations, officeNavFor, palettePages, translateNav } from './office-nav'

/**
 * B-W1-08, the W1 navigation check, and B-W2a-83, the W2a one (SCR-003; PLT-160, PLT-036; design check I2): the whole map
 * against the approved tree (design 01-navigation-tree, W0–W2a, copied in approved-tree.ts) — the rail (Plant before
 * Admin), every area's Pages overlay with its groups, the words in both languages, the permissions, the built pages
 * (OFFICE_PAGES), the record links (RECORD_PAGES) and list addresses Home and the search use, the floor tiles per mode and
 * permission and the scan router, the link-type registry and the palette. A gap, a wrong order, a wrong word or an extra
 * row fails here.
 */

const namespaces = Object.keys(CATALOGUE.en)
const shellT = (locale: Locale) => createScopedTranslator(locale, messagesFor(locale, namespaces), 'shell')
const sample = (address: string) => address.replace(/\[companyId\]/g, 'c0').replace(/\[[^\]/]+\]/g, 'x1')
const rows = (nav: AreaNav): AreaNavItem[] => nav.areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.flatMap((item) => [item, ...(item.children ?? [])])))
const shipped = (page: TreePage) => page.href !== null && !page.deferred
const owner = officeNavFor(permissionCheck(templateOf('owner')!.permissions))

describe('the Office map is the approved tree (rail, overlays, words, order)', () => {
  it('the rail: one area per tree area that has a W0–W2a page, in the tree\'s order and with its order number; Plant right above Admin at the foot', () => {
    expect(officeAreaDeclarations().map((d) => [d.order, d.area.id])).toEqual(OFFICE.map((area) => [area.order, area.id]))
    expect(OFFICE_NAV.areas.slice(-2).map((area) => area.id)).toEqual(['plant', 'admin'])
    // People (the tree's 11) is W2b: B-W2b-55 ships its first page (Employees); its other rows show once their pages are built.
    expect(OFFICE_NAV.areas.map((area) => area.id).slice(-3)).toEqual(['people', 'plant', 'admin'])
  })

  for (const locale of LOCALES) {
    const nav = translateNav(OFFICE_NAV, shellT(locale))
    const title = (page: { title: string; titleIt: string }) => (locale === 'it' ? page.titleIt : page.title)

    it(`${locale}: every area's name, its groups and its pages in the tree's order and words`, () => {
      for (const tree of OFFICE) {
        const area = nav.areas.find((entry) => entry.id === tree.id)!
        expect(area.label, tree.id).toBe(title(tree))
        const groups = tree.groups.map((group) => ({ ...group, pages: group.pages.filter(shipped) })).filter((group) => group.pages.length > 0)
        expect(
          (area.sections ?? []).map((section) => ({ label: section.label, hidden: !!section.hideLabel, rows: section.items.map((item) => [item.href, item.label]) })),
          tree.id,
        ).toEqual(groups.map((group) => ({ label: locale === 'it' ? group.labelIt : group.label, hidden: group.hideLabel, rows: group.pages.map((page) => [page.href, title(page)]) })))
      }
    })
  }

  it('no later-wave page shows: every row is a W0–W2a page of the tree (or one moved earlier, named), none deferred', () => {
    const allowed = new Set(OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter(shipped).map((page) => page.href))))
    // Every tree page is of a built wave, or says why it ships early.
    // W2b pages join the tree as their screen steps ship (B-W2b-55 People › Employees, B-W2b-58 Production › Help calls, …).
    expect(OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter((page) => !['W0', 'W1', 'W2a', 'W2b'].includes(page.wave) && !page.early).map((page) => page.id)))).toEqual([])
    expect(rows(OFFICE_NAV).map((row) => row.href).filter((href) => !allowed.has(href))).toEqual([])
    const early = OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter((page) => page.early).map((page) => page.id)))
    expect(early).toEqual(['plant.settings', 'admin.overview'])
    const deferred = OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter((page) => page.deferred).map((page) => page.id)))
    expect(deferred).toEqual(['sales.mtm'])
  })

  it('every row\'s page is built and opens (OFFICE_PAGES); every built page has its one place in the map', () => {
    for (const row of rows(OFFICE_NAV)) expect(OFFICE_PAGES.has(row.href), row.href).toBe(true)
    // Built pages that are no row and sit under none: the frame's own page, the record panel route (any record without
    // a page of its own), and the evidence trail (a section of the tree's Technical files page, W2b, opened in a new tab).
    const outside = new Set(['/me', '/records/[type]/[id]', '/compliance/evidence/[kind]/[subject]'])
    // B-W2a-32: All results of the global search, a frame page the palette opens ("See all results").
    outside.add('/search')
    for (const address of OFFICE_PAGES) {
      const place = findAreaNavPlace(OFFICE_NAV, sample(address))
      if (outside.has(address)) {
        expect(place?.item, address).toBeUndefined()
        continue
      }
      expect(place?.item, address).toBeDefined()
      // Exactly one row of the area's overlay is current (aria-current).
      const groups = areaSubNavGroups(place!.area, { path: sample(address) })
      expect(groups.flatMap((group) => group.items).filter((item) => item.active).map((item) => item.id), address).toEqual([place!.item!.id])
    }
  })

  it('every row asks the permission its page\'s API needs (the route the page reads first)', () => {
    // href → [the API route, the permission its manifest names] (apps/factory-api … manifest.ts).
    const PAGE_PERMISSION: Record<string, string> = {
      '/home/today': 'home.view', // GET /home/today
      '/home/approvals': 'home.view', // GET /home/today?category=APPROVAL (B-W2b-307: every kind; quotes and the engine's requests read with their own rights)
      '/home/tasks': 'home.view', // GET /tasks (B-W2a-40)
      '/home/notifications': 'home.view', // GET /notifications (B-W2a-40)
      '/home/mail-to-sort': 'email.triage', // GET /email/inbound
      '/home/reports': 'home.reports.view', // GET /reports (B-W2a-79)
      '/home/alerts': 'alerts.view', // GET /alerts (B-W2a-78)
      '/sales/customers': 'parties.view', // GET /parties
      '/sales/inquiries': 'sales.inquiries.view', // GET /sales/inquiries (B-W2b-322)
      '/sales/quotes': 'quotes.view', // GET /sales/quotes
      '/sales/orders': 'orders.view', // GET /sales/orders
      '/sales/price-lists': 'pricelists.view', // GET /sales/price-lists (B-W2a-49)
      '/sales/returns': 'sales.returns.view', // GET /sales/returns (+ GET /sales/repairs with sales.repairs.view) (B-W2a-77)
      '/sales/settings': 'quotes.view', // GET /sales/settings (B-W2a-77)
      '/products/styles': 'product.styles.view', // GET /product/styles
      '/products/materials': 'product.materials.view', // GET /product/materials
      '/products/operations': 'product.routing.view', // GET /product/operations
      '/products/sizes': 'product.styles.view', // GET /product/size-scales
      '/products/samples': 'sales.samples.view', // GET /sales/samples/rounds (B-W2b-261)
      '/products/changes': 'product.changes.view', // GET /product/change-requests (B-W2b-244)
      '/products/colours': 'product.styles.view', // GET /product/colours/library (B-W2b-247)
      '/products/options': 'product.styles.view', // GET /product/option-groups (B-W2b-242)
      '/products/settings': 'product.styles.view', // GET /product/settings (B-W2b-239)
      '/planning/mrp': 'planning.view', // GET /planning/runs/latest
      '/planning/leather': 'planning.view', // GET /planning/leather/need (B-W2b-132)
      '/planning/board': 'planning.view', // GET /planning/schedule (B-W2a-45)
      '/planning/allocation': 'planning.view', // GET /planning/allocation (B-W2a-45)
      '/planning/capacity': 'planning.view', // GET /planning/capacity (B-W2a-70)
      '/planning/exceptions': 'planning.view', // GET /planning/exceptions (B-W2a-70)
      '/planning/settings': 'planning.view', // GET /planning/settings (B-W2a-59)
      '/planning/milestones': 'planning.view', // GET /planning/milestones (B-W2b-263)
      '/planning/demand': 'planning.view', // GET /planning/demand (B-W2b-339)
      '/planning/mps': 'planning.view', // GET /planning/strategy (B-W2b-339)
      '/planning/reports': 'planning.reports.view', // GET /planning/reports/adherence (B-W2b-349)
      '/purchasing/suppliers': 'parties.view', // GET /parties
      '/purchasing/orders': 'purchasing.view', // GET /purchasing/orders
      '/purchasing/requests': 'purchasing.view', // GET /purchasing/requests (B-W2a-69)
      '/purchasing/subcontracting': 'purchasing.view', // GET /purchasing/subcontracting/orders (B-W2a-56)
      '/purchasing/claims': 'purchasing.view', // GET /purchasing/claims (B-W2a-63)
      '/purchasing/sourcing': 'purchasing.view', // GET /purchasing/sample-orders (B-W2b-347)
      '/purchasing/reports': 'purchasing.reports.view', // GET /purchasing/reports/spend (B-W2b-350)
      '/purchasing/settings': 'purchasing.view', // GET /purchasing/tolerances (B-W2b-354)
      '/warehouse/stock': 'inventory.stock.view', // GET /inventory/stock
      '/warehouse/hides': 'inventory.stock.view', // GET /inventory/hides
      '/warehouse/lots': 'inventory.stock.view', // GET /inventory/lots
      '/warehouse/moves': 'inventory.stock.view', // GET /inventory/ledger
      '/warehouse/receipts': 'inventory.stock.view', // GET /inventory/receipts
      '/warehouse/picking': 'inventory.stock.view', // GET /inventory/picking/pick-lists (B-W2a-58)
      '/warehouse/counts': 'inventory.counts.view', // GET /inventory/stock-counts
      '/warehouse/transfers': 'inventory.stock.view', // GET /inventory/transfer-orders (B-W2b-326)
      '/warehouse/shipments': 'shipping.view', // GET /shipping/shipments
      '/warehouse/locations': 'inventory.locations.view', // GET /inventory/locations
      '/warehouse/shipping': 'shipping.settings.view', // GET /shipping/settings
      '/warehouse/reports': 'inventory.reports.view', // GET /inventory/reports/ageing (B-W2b-356)
      '/production/floor': 'workorders.view', // GET /production/scans/wip
      '/production/work-orders': 'workorders.view', // GET /production/work-orders
      '/production/reports': 'production.reports.view', // GET /production/reports/daily
      '/production/cutting': 'production.cutting.view', // GET /production/cutting/cuts (B-W2a-60)
      '/production/scrap': 'production.scrap.view', // GET /production/scrap (B-W2a-60)
      '/production/calls': 'production.calls.view', // GET /production/calls (B-W2b-58)
      '/production/instructions': 'production.instructions.view', // GET /production/instructions (B-W2b-234)
      '/production/labour': 'production.labour.view', // GET /production/labour/inbox (B-W2b-57)
      '/production/bundles': 'production.bundles.view', // GET /production/bundles (B-W2b-59)
      '/production/dispatch': 'production.dispatch.view', // GET /production/dispatch/board (B-W2b-56)
      '/production/settings': 'production.settings.view', // GET /production/settings
      '/quality/inspections': 'quality.inspections.view', // GET /quality/inspections
      '/quality/holds': 'quality.holds.view', // GET /quality/holds (B-W2a-67)
      '/quality/defects': 'quality.defects.view', // GET /quality/defects (B-W2a-67)
      '/quality/settings': 'quality.rules.view', // GET /quality/rules (B-W2b-118)
      '/quality/plans': 'quality.plans.view', // GET /quality/plans (B-W2b-104)
      '/quality/ncr': 'quality.ncr.view', // GET /quality/ncr (B-W2a-68)
      '/quality/capa': 'quality.capa.view', // GET /quality/capa (B-W2b-119)
      '/quality/complaints': 'quality.complaints.view', // GET /quality/complaints (B-W2a-65)
      '/quality/reports': 'quality.reports.view', // GET /quality/reports/kpis (B-W2b-138)
      '/compliance/certificates': 'compliance.certificates.view', // GET /compliance/certificates
      '/compliance/labels': 'compliance.certificates.view', // GET /compliance/labels
      '/compliance/tests': 'quality.lots.view', // GET /quality/lots
      '/compliance/register': 'compliance.register.view', // GET /compliance/register
      '/compliance/reports': 'compliance.reports.view', // GET /compliance/reports/kpis (B-W2b-272)
      '/compliance/status': 'compliance.certificates.view', // GET /compliance/status/board (B-W2b-266)
      '/compliance/sourcing': 'compliance.certificates.view', // GET /compliance/claims (B-W2b-264)
      '/compliance/settings': 'compliance.certificates.view', // GET /compliance/requirements/gates and /compliance/rules/* (B-W2b-265)
      '/compliance/declarations': 'compliance.certificates.view', // GET /compliance/declarations (B-W2b-268)
      '/compliance/techfiles': 'compliance.certificates.view', // GET /compliance/techfiles (B-W2b-269)
      '/finance/invoices': 'invoices.view', // GET /invoicing/invoices
      '/finance/payments': 'payments.view', // GET /payments
      '/finance/receivables': 'receivables.view', // GET /receivables/ageing (B-W2a-81)
      '/finance/payables': 'payables.view', // GET /payables/invoices (B-W2a-81)
      '/finance/costing': 'costing.view', // GET /costing/work-orders (B-W2a-72)
      '/finance/margins': 'costing.view', // GET /costing/margins (B-W2a-72)
      '/finance/accounting': 'accounting.view', // GET /accounting/exports (B-W2a-51)
      '/finance/reports': 'inventory.stock.view', // GET /costing/valuation (B-W2a-51)
      '/finance/settings': 'invoices.view', // GET /invoicing/settings
      // B-W2a-53: Plant › Maintenance.
      '/plant/requests': 'plant.view', // GET /plant/requests
      '/plant/jobs': 'plant.view', // GET /plant/jobs
      '/plant/machines': 'plant.view', // GET /plant/machines
      '/plant/settings': 'plant.view', // GET /plant/symptoms (B-W2a-73)
      '/plant/calendar': 'safety.view', // GET /safety/calendar (B-W2b-120)
      '/plant/preventive': 'plant.view', // GET /plant/checks/plans (B-W2b-142)
      '/plant/chemicals': 'safety.view', // GET /safety/chemicals (B-W2b-143)
      '/plant/incidents': 'safety.incidents.view', // GET /safety/incidents (B-W2b-149)
      '/plant/risk': 'safety.view', // GET /safety/risk/assessments (B-W2b-144)
      '/plant/ppe': 'safety.view', // GET /safety/ppe/gaps (B-W2b-147)
      '/plant/health': 'safety.health.view', // GET /safety/health (B-W2b-148)
      // B-W2b-55: People › Employees.
      '/people/employees': 'people.view', // GET /people/employees
      // B-W2b-60: People › Shifts.
      '/people/shifts': 'people.shifts.view', // GET /people/shifts/roster
      // B-W2b-62: People › Piece rates.
      '/people/piecerates': 'people.piecerates.view', // GET /people/piece-rates
      // B-W2b-65: People › Skills & training and People settings.
      '/people/skills': 'people.skills.view', // GET /people/skills/matrix
      '/people/payroll': 'people.payroll.view', // GET /people/payroll/month
      '/people/settings': 'people.privacy.view', // GET /people/privacy
      // B-W2b-61: People › Attendance.
      '/people/attendance': 'people.attendance.view', // GET /people/attendance/days
      // B-W2b-64: People › Efficiency and People reports.
      '/people/efficiency': 'people.efficiency.view', // GET /people/efficiency
      '/people/reports': 'people.attendance.view', // GET /people/reports/attendance
      '/admin': 'companies.view', // the checklist reads the companies
      '/admin/companies': 'companies.view',
      '/admin/devices': 'devices.view',
      '/admin/users': 'users.view',
      '/admin/roles': 'roles.view',
      '/admin/security': 'security.view', // GET /admin/security (B-W2a-36)
      '/admin/documents': 'numbering.view', // GET /numbering/series
      '/admin/languages': 'companies.view',
      '/admin/automation': 'alerts.rules.manage', // GET /alerts/rules/:id/timers, the rules kept (B-W2a-78)
      '/admin/connections': 'integrations.view', // GET /integrations/accounts
      '/admin/import': 'imports.view', // GET /imports
      '/admin/audit': 'audit.read', // GET /audit
      '/admin/privacy': 'privacy.view', // GET /privacy/overview
    }
    expect(Object.fromEntries(rows(OFFICE_NAV).map((row) => [row.href, row.permission]))).toEqual(PAGE_PERMISSION)
    const declared = new Set<string>(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))
    for (const permission of Object.values(PAGE_PERMISSION)) expect(declared.has(permission), permission).toBe(true)
  })

  it('the Owner sees every row; the warehouse and sales roles see only theirs, in the same order', () => {
    expect(rows(owner).map((row) => row.id)).toEqual(rows(OFFICE_NAV).map((row) => row.id))
    // The warehouse role: all of Warehouse, what it receives and ships against; of Finance only Finance reports (the stock
    // valuation's quantities, B-W2a-51); of Admin only Import & export (the opening stock import); of Quality only Holds
    // (B-W2a-67: warehouse reads what is on hold).
    const warehouse = officeNavFor(permissionCheck(templateOf('warehouse')!.permissions))
    // B-W2a-67 + B-W2a-68: of Quality, Holds (quality.holds.view) and Nonconformances (the warehouse raises NCRs from lots,
    // hides and receipts).
    expect(warehouse.areas.map((area) => area.id)).toEqual(['home', 'sales', 'products', 'purchasing', 'warehouse', 'production', 'quality', 'compliance', 'finance', 'admin'])
    expect(rows(warehouse).filter((row) => row.href.startsWith('/quality/')).map((row) => row.href)).toEqual(['/quality/holds', '/quality/ncr'])
    expect(rows(warehouse).filter((row) => row.href.startsWith('/finance/')).map((row) => row.href)).toEqual(['/finance/reports'])
    expect(rows(warehouse).filter((row) => row.href.startsWith('/warehouse/') || row.href.startsWith('/admin')).map((row) => row.href)).toEqual([
      '/warehouse/stock',
      '/warehouse/hides',
      '/warehouse/lots',
      '/warehouse/moves',
      '/warehouse/receipts',
      '/warehouse/picking',
      '/warehouse/counts',
      '/warehouse/transfers',
      '/warehouse/shipments',
      '/warehouse/reports',
      '/warehouse/locations',
      '/warehouse/shipping',
      '/admin/import',
    ])
    // The sales role: all of Sales, Home's approvals and mail; of Quality only Nonconformances (B-W2a-68: sales raise NCRs
    // from what a customer reports), Corrective actions (B-W2b-119: sales read the 8Ds of their customers) and Complaints
    // (B-W2a-65: sales logs them); no Compliance or Planning.
    const sales = officeNavFor(permissionCheck(templateOf('sales')!.permissions))
    expect(sales.areas.map((area) => area.id)).toEqual(['home', 'sales', 'products', 'purchasing', 'warehouse', 'production', 'quality', 'finance', 'admin'])
    expect(rows(sales).filter((row) => row.href.startsWith('/quality/')).map((row) => row.href)).toEqual(['/quality/ncr', '/quality/capa', '/quality/complaints'])
    expect(rows(sales).filter((row) => row.href.startsWith('/sales/') || row.href.startsWith('/home/')).map((row) => row.href)).toEqual([
      '/home/today',
      '/home/approvals',
      '/home/tasks',
      '/home/notifications',
      '/home/mail-to-sort',
      // B-W2a-79 + B-W2a-78: Home › Insights › Reports, Alerts.
      '/home/reports',
      '/home/alerts',
      '/sales/customers',
      // B-W2b-322: Sales › Inquiries.
      '/sales/inquiries',
      '/sales/quotes',
      '/sales/orders',
      '/sales/returns',
      '/sales/price-lists',
      '/sales/settings',
    ])
    // A role's rows keep the full map's order.
    const order = rows(OFFICE_NAV).map((row) => row.href)
    for (const nav of [warehouse, sales]) {
      const mine = rows(nav).map((row) => order.indexOf(row.href))
      expect(mine).toEqual([...mine].sort((a, b) => a - b))
    }
  })

  // B-W2b-274 (the W2b-4 sweep): Products and Compliance per role template, Production › Work instructions and Planning ›
  // Time & action, each row behind its page's own read (the role templates as they stand; a change there changes this table).
  it('the W2b-4 rows per role: Products, Compliance, Work instructions, Time & action', () => {
    const P = (...pages: string[]) => pages.map((page) => `/products/${page}`)
    const C = (...pages: string[]) => pages.map((page) => `/compliance/${page}`)
    const allProducts = P('styles', 'materials', 'samples', 'changes', 'operations', 'sizes', 'colours', 'options', 'settings')
    const allCompliance = C('status', 'certificates', 'declarations', 'techfiles', 'labels', 'tests', 'register', 'sourcing', 'reports', 'settings')
    const expected: Record<string, { products: string[]; compliance: string[]; instructions: boolean; milestones: boolean }> = {
      owner: { products: allProducts, compliance: allCompliance, instructions: true, milestones: true },
      production_manager: { products: allProducts, compliance: C('status', 'certificates', 'declarations', 'techfiles', 'labels', 'register', 'sourcing', 'reports', 'settings'), instructions: true, milestones: true },
      quality_inspector: { products: allProducts, compliance: allCompliance, instructions: true, milestones: false },
      planner: { products: allProducts, compliance: C('status', 'certificates', 'declarations', 'techfiles', 'labels', 'sourcing', 'settings'), instructions: false, milestones: true },
      sales: { products: P('styles', 'materials', 'samples', 'changes', 'sizes', 'colours', 'options', 'settings'), compliance: [], instructions: false, milestones: false },
      buyer: { products: P('styles', 'materials', 'changes', 'sizes', 'colours', 'options', 'settings'), compliance: C('tests'), instructions: false, milestones: true },
      warehouse: { products: P('styles', 'materials', 'sizes', 'colours', 'options', 'settings'), compliance: C('tests'), instructions: false, milestones: false },
      floor_supervisor: { products: P('styles', 'materials', 'changes', 'operations', 'sizes', 'colours', 'options', 'settings'), compliance: [], instructions: true, milestones: false },
      finance: { products: P('styles', 'materials', 'operations', 'sizes', 'colours', 'options', 'settings'), compliance: [], instructions: false, milestones: false },
      read_only: { products: allProducts, compliance: allCompliance, instructions: true, milestones: true },
    }
    for (const [role, want] of Object.entries(expected)) {
      const hrefs = rows(officeNavFor(permissionCheck(templateOf(role)!.permissions))).map((row) => row.href)
      expect(hrefs.filter((href) => href.startsWith('/products/')), role).toEqual(want.products)
      expect(hrefs.filter((href) => href.startsWith('/compliance/')), role).toEqual(want.compliance)
      expect(hrefs.includes('/production/instructions'), role).toBe(want.instructions)
      expect(hrefs.includes('/planning/milestones'), role).toBe(want.milestones)
    }
  })
})

describe('the palette finds every page by its name, in Italian and English', () => {
  for (const locale of LOCALES) {
    it(`${locale}: each of the Owner's pages and My profile comes first for its own name`, () => {
      const t = shellT(locale)
      const pages = palettePages(owner).map((page) => ({ ...page, label: t(page.label), area: t(page.area) }))
      expect(pages).toHaveLength(rows(OFFICE_NAV).length + FRAME_PAGES.length)
      for (const page of pages) {
        expect(page.label, page.id).not.toMatch(/^(shell:|nav\.|topbar\.)/)
        const found = matchPages(pages, page.label)
        expect(found[0]?.label, `${locale} "${page.label}"`).toBe(page.label)
        expect(found.map((entry) => entry.id), page.id).toContain(page.id)
      }
      expect(pages.find((page) => page.href === '/me')?.label).toBe(locale === 'it' ? FRAME[0]!.titleIt : FRAME[0]!.title)
    })
  }
})

describe('record links and list addresses (lib/records/record-links.ts)', () => {
  // Built record pages that are a record type's SECOND page: the supplier side of a party (its first is the customer
  // record) and a lot's tests & release (its first is Warehouse › Lots & traceability, which links it).
  // B-W2a-60: a cut (/production/cutting/[id]) is a work order's cutting, a second page of the WorkOrder (no record type of its own in W2a).
  const SECOND_PAGES = new Set(['/purchasing/suppliers/[partyId]', '/compliance/tests/[id]', '/production/cutting/[id]'])
  const shape = (address: string) => address.split('?')[0]!.replace(/\[[^\]/]+\]/g, '[id]')

  it('every record type with a built page is in RECORD_PAGES, and every RECORD_PAGES line is a built page in the map', () => {
    const recordShapes = new Set(Object.values(RECORD_PAGES).map(shape))
    const recordPages = [...OFFICE_PAGES].filter((address) => /\[[^\]]+\]$/.test(address) && address !== '/records/[type]/[id]' && !address.startsWith('/compliance/evidence/'))
    expect(recordPages.filter((address) => !SECOND_PAGES.has(address) && !recordShapes.has(shape(address)))).toEqual([])
    for (const [type, page] of Object.entries(RECORD_PAGES)) {
      expect(hasRecordPage(type, OFFICE_PAGES), type).toBe(true)
      const address = recordAddress({ type, id: 'x1', companyId: 'c0' }, OFFICE_PAGES)
      expect(address, type).toBe(sample(page))
      expect(findAreaNavPlace(OFFICE_NAV, address)?.item, `${type} → ${address}`).toBeDefined()
    }
  })

  it('every record type the search finds opens its own page (B-W2a-83: returns, repairs, complaints and supplier claims too)', () => {
    // B-W2b-23: a DDT has no page of its own (design 00 §2.3): the search opens its record panels, as every opener does.
    // B-W2b-247: a library colour is edited in its list row; its panels hold its photo, history and thread.
    const PANELS_ONLY = new Set(['Ddt', 'Colour'])
    for (const type of SEARCH_TYPES) {
      if (PANELS_ONLY.has(type)) {
        expect(RECORD_PAGES[type], type).toBeUndefined()
        expect(recordAddress({ type, id: 'x1', companyId: 'c0' }, OFFICE_PAGES), type).toBe(`/records/${type}/x1?company=c0`)
        continue
      }
      expect(RECORD_PAGES[type], type).toBeDefined()
      expect(findAreaNavPlace(OFFICE_NAV, recordAddress({ type, id: 'x1', companyId: 'c0' }, OFFICE_PAGES))?.item, type).toBeDefined()
    }
  })

  it('a site opens under its company; without its company it opens its panels', () => {
    expect(recordAddress({ type: 'Site', id: 's1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/admin/companies/c1/sites/s1')
    expect(recordAddress({ type: 'Site', id: 's1' }, OFFICE_PAGES)).toBe('/records/Site/s1')
  })

  it('a record without a page of its own opens its panels (thread, files, history)', () => {
    for (const type of ['DepositRequest', 'Ddt', 'FloorScanRefusal', 'StoredFile']) {
      expect(RECORD_PAGES[type], type).toBeUndefined()
      expect(recordAddress({ type, id: 'r1', label: 'R-1', companyId: 'c1' }, OFFICE_PAGES)).toBe(`/records/${type}/r1?label=R-1&company=c1`)
    }
  })

  it('every list page an API list maps to is built and in the map', () => {
    for (const [api, page] of Object.entries(LIST_PAGES)) {
      expect(OFFICE_PAGES.has(page), `${api} → ${page}`).toBe(true)
      expect(findAreaNavPlace(OFFICE_NAV, page)?.item?.href, api).toBe(page)
    }
  })

  it('Home › Today: every panel\'s list, every flow lens\'s list and every New verb lands on a built page', () => {
    // Labour & corrections (production.labour) is the tree's W2b page: the scan corrections panel has no "See all" yet.
    const unlisted = new Set(['/production/scans/corrections'])
    for (const panel of PANELS) {
      const address = listAddress(panel.path, panel.query, OFFICE_PAGES)
      if (unlisted.has(panel.path)) expect(address, panel.id).toBeNull()
      else expect(address && OFFICE_PAGES.has(address.split('?')[0]!), `${panel.id} ${panel.path}`).toBe(true)
    }
    for (const lens of Object.values(LENS_RULES)) {
      if (lens.list === null) continue
      expect(listAddress(lens.list, null, OFFICE_PAGES), lens.lens).toBe(LIST_PAGES[lens.list])
    }
    for (const verb of NEW_VERBS) {
      expect(OFFICE_PAGES.has(verb.page), `${verb.id} ${verb.page}`).toBe(true)
      expect(findAreaNavPlace(OFFICE_NAV, verb.page)?.item?.href, verb.id).toBe(verb.page)
    }
  })

  it('a Today row opens its kind\'s page when it has one, else its record', () => {
    expect(attentionAddress('PRIVACY_DUTY', { type: 'Company', id: 'c1' }, OFFICE_PAGES)).toBe('/admin/privacy?company=c1')
    expect(attentionAddress('INVOICE_SDI', { type: 'Invoice', id: 'i1' }, OFFICE_PAGES)).toBe('/finance/invoices/i1')
    // B-W2b-57: a correction request is decided on Labour & corrections.
    expect(attentionAddress('SCAN_CORRECTION', { type: 'ScanCorrectionRequest', id: 'k1' }, OFFICE_PAGES)).toBe('/production/labour?open=CORRECTION:k1')
  })
})

describe('the floor tiles and the scan router (floor/model.ts, floor/tasks/routes.ts)', () => {
  const everything = [...new Set(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))]

  it('one tile per W0–W2a floor task, in the tree\'s order, Scan anything last; every tile built, every task tile has its page', () => {
    const order = FLOOR.filter((page) => page.tile !== 'scan').map((page) => page.tile)
    expect(TILE_RULES.map((rule) => rule.key)).toEqual([...order, 'scan'])
    expect([...TILE_KEYS]).toEqual([...order, 'scan'])
    for (const rule of TILE_RULES) {
      expect(rule.built, rule.key).toBe(true)
      if (rule.key !== 'scan') expect(TASK_ROUTES[taskOfTile(rule.key)!], rule.key).toBe(`/floor/${rule.key}`)
    }
  })

  it('each tile in the station modes the tree gives it, the build\'s two named differences apart', () => {
    // Operation also at the inspection bench (the floor tasks' decision: a routing's scanned INSPECTION operation). My
    // work (B-W2a-74): at the packing bench too (the dispatch list is per station). B-W2b-308: at the warehouse it is the task
    // inbox (SCM-274), as the tree gives it.
    const added: Partial<Record<TileKey, readonly FloorMode[]>> = { operation: ['inspection'], mywork: ['packing'] }
    const removed: Partial<Record<TileKey, readonly FloorMode[]>> = {}
    for (const page of FLOOR) {
      const rule = TILE_RULES.find((entry) => entry.key === page.tile)!
      const tree = page.modes.filter((mode): mode is FloorMode => (FLOOR_MODES as readonly string[]).includes(mode) && !(removed[rule.key] ?? []).includes(mode as FloorMode))
      expect(rule.modes === 'all' ? [...FLOOR_MODES] : [...rule.modes].sort(), page.id).toEqual(page.tile === 'scan' ? [...FLOOR_MODES] : [...tree, ...(added[rule.key] ?? [])].sort())
    }
  })

  it('each tile asks the permission its page\'s API needs, declared in the catalogue', () => {
    expect(Object.fromEntries(TILE_RULES.map((rule) => [rule.key, rule.permission]))).toEqual({
      mywork: 'floor.work', // GET /production/dispatch/station (B-W2a-74)
      operation: 'production.scan',
      cut: 'production.cut',
      fabriccut: 'production.cut', // GET /production/cut-tickets/waiting, /production/lays/:id (B-W2b-121 on B-W2b-112, -116)
      bundles: 'production.bundles',
      receive: 'inventory.receive',
      move: 'inventory.transfer', // GET /inventory/putaway/scan, POST /inventory/putaway | /inventory/bin-moves (B-W2b-308 on B-W2b-292)
      pick: 'inventory.issue',
      count: 'inventory.counts.scan', // GET /inventory/stock-counts/to-count, POST …/:countId/scans (B-W2b-310 on B-W2b-299)
      returnsin: 'sales.returns.receive', // GET /sales/returns/dock (B-W2a-76)
      kits: 'purchasing.subcontract.kit', // GET /purchasing/subcontracting/kits (B-W2a-76)
      labels: 'production.serials',
      pack: 'shipping.pack',
      incoming: 'quality.incoming.record', // PUT /quality/incoming/:id/hides/:hideId (B-W2b-115 on B-W2b-98, -111)
      final: 'quality.inspections.view',
      inline: 'quality.inprocess.record', // POST /quality/inprocess/checks (B-W2b-105 on B-W2b-99)
      machine: 'plant.report', // GET /plant/floor/machines (B-W2a-73)
      clock: 'floor.work', // GET /people/clock/floor (B-W2b-67)
      myday: 'floor.work', // GET /people/myday (B-W2b-68)
      training: 'floor.work', // GET /safety/floor/training/sessions, /safety/floor/ppe/items (B-W2b-145)
      instructions: 'production.scan', // GET /production/instructions/floor/operation (B-W2b-232 on B-W2b-214)
      help: 'floor.work', // GET /production/calls/station (B-W2b-70)
      incident: 'floor.work', // GET /safety/floor/incidents/start (B-W2b-137)
      lineview: 'floor.lead', // the team leader's Line view (B-W2b-70)
      scan: 'floor.work',
    })
    for (const rule of TILE_RULES) expect(everything, rule.key).toContain(rule.permission)
  })

  it('a station shows its mode\'s tiles in order, at most six a page, each with its word in both languages', () => {
    const keys = (mode: FloorMode) => homeTiles(mode, everything, false).map((tile) => tile.key)
    expect(Object.fromEntries(FLOOR_MODES.map((mode) => [mode, keys(mode)]))).toEqual({
      // B-W2b-70: the Line view and Scan anything stay on the first page; B-W2b-73: the rest of a full home on the More tile's page.
      // B-W2b-137: Report an incident stays on the first page too, before the Line view (it must never fall off a full Home).
      // B-W2b-145: Training & PPE sign-off at every station mode (tile family Me, after My day).
      // B-W2b-105: In-line inspection at the inspection bench (tile family Quality, after Final inspection).
      // B-W2b-121: Fabric cutting at the cutting table, after Cut a hide (tile family Cutting).
      // B-W2b-232: Spec & instructions at every station mode but the warehouse (tile family Work, before Call for help).
      cutting: ['mywork', 'operation', 'cut', 'fabriccut', 'bundles', 'machine', 'clock', 'training', 'instructions', 'help', 'incident', 'lineview', 'scan'],
      sewing: ['mywork', 'operation', 'machine', 'clock', 'myday', 'training', 'instructions', 'help', 'incident', 'lineview', 'scan'],
      packing: ['mywork', 'operation', 'labels', 'pack', 'machine', 'clock', 'training', 'instructions', 'help', 'incident', 'lineview', 'scan'],
      // B-W2b-115: Incoming inspection at the inspection bench (tile family Quality, before Final inspection).
      // B-W2b-203: at the bench Operation after the inspection tiles (Owner answer 2026-11-09 to B-W2b-151's question 1).
      inspection: ['mywork', 'incoming', 'final', 'inline', 'operation', 'machine', 'clock', 'training', 'instructions', 'help', 'incident', 'lineview', 'scan'],
      // B-W2b-308: My work (the task inbox) at the warehouse, Move & put away after Receive. B-W2b-310: Count after Pick & issue.
      warehouse: ['mywork', 'receive', 'move', 'pick', 'count', 'returnsin', 'kits', 'machine', 'clock', 'training', 'help', 'incident', 'lineview', 'scan'],
    })
    for (const mode of FLOOR_MODES) {
      const first = tilePage(homeTiles(mode, everything, false), 0)
      expect(first.tiles.length + (first.pages > 1 ? 1 : 0)).toBeLessThanOrEqual(MAX_TILES)
      expect(first.tiles.map((tile) => tile.key).slice(-3)).toEqual(['incident', 'lineview', 'scan'])
    }
    // Devices with no station's mode (design Modes: phone, supervisor). The build's differences from the tree, named: Clock on a
    // line tablet (the lead's own, B-W2b-67); the Line view on a lead's phone (wherever they sign in, B-W2b-70); no My work on
    // a phone (its rows open jobs that need a station). A subcontract station: Scan only.
    const onDevice = (device: string) => homeTiles(null, everything, false, device).map((tile) => tile.key)
    // B-W2b-105: In-line inspection on a team leader's line tablet (design floor.inline Modes: supervisor).
    expect(onDevice('LINE')).toEqual(['inline', 'clock', 'training', 'incident', 'lineview', 'scan'])
    expect(onDevice('PHONE')).toEqual(['clock', 'myday', 'incident', 'lineview', 'scan'])
    expect(onDevice('STATION')).toEqual(['scan'])
    for (const locale of LOCALES) {
      const floor = CATALOGUE[locale].floor ?? {}
      for (const key of TILE_KEYS) {
        expect(floor[`tile.${key}`], `${locale} tile.${key}`).toBeTruthy()
        if (key !== 'scan') expect(floor[`tile.hint.${key}`], `${locale} tile.hint.${key}`).toBeTruthy()
      }
      for (const key of ['tile.more', 'tile.back', 'tile.hint.back', 'tile.hint.more_one', 'tile.hint.more_other']) expect(floor[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('a floor page with no tile has its page, and is opened by its device, never by a tile', () => {
    for (const page of FLOOR_NO_TILE) {
      expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/(floor)', page.href, 'page.tsx')), page.id).toBe(true)
      expect(TILE_RULES.map((rule) => `/floor/${rule.key}`)).not.toContain(page.href)
    }
  })

  it('the scan router opens the right task for each label type at each station, and only a tile the station shows', () => {
    const label = (type: (typeof LABEL_TYPES)[number]): ScanRead => ({ kind: 'label', type, code: 'X' })
    const reads: Record<string, ScanRead> = { ...Object.fromEntries(LABEL_TYPES.map((type) => [type, label(type)])), free: { kind: 'free', code: 'WO-00001' } }
    const expected: Record<FloorMode, Partial<Record<string, TileKey>>> = {
      sewing: { bundle: 'operation' },
      cutting: { hide: 'cut', bundle: 'bundles' },
      warehouse: { workOrder: 'pick', free: 'pick', /* B-W2b-308 */ lot: 'move', hide: 'move', roll: 'move', remnant: 'move' },
      packing: { bundle: 'operation', serial: 'pack', free: 'pack' },
      inspection: { bundle: 'operation', workOrder: 'final', free: 'final', /* B-W2b-115 */ lot: 'incoming', hide: 'incoming' },
    }
    for (const mode of FLOOR_MODES) {
      const tiles = homeTiles(mode, everything, false)
      for (const [name, read] of Object.entries(reads)) {
        const task = taskForScan(mode, read, tiles)
        expect(task, `${mode} × ${name}`).toBe(expected[mode][name] ?? null)
        if (task) expect(tiles.map((tile) => tile.key), `${mode} × ${name}`).toContain(task)
      }
      // A tile held by the worker notice never opens from a scan.
      for (const read of Object.values(reads)) expect(taskForScan(mode, read, homeTiles(mode, everything, true))).toBeNull()
    }
    // A subcontract station (no floor mode): Scan anything shows every card.
    for (const read of Object.values(reads)) expect(taskForScan(null, read, homeTiles(null, everything, false))).toBeNull()
  })

  it('Waiting to send says every queued kind in its own words, never the bare "Action" (B-W2b-151: the W2b-2 kinds)', () => {
    // Each key's words in both languages: floor/screens.vitest.test.ts.
    expect(FLOOR_SYNC_KINDS.filter((kind) => whatKeyOf(kind) === 'other')).toEqual([])
  })
})

describe('the link-type registry (links/_nav/link-types.ts)', () => {
  it('every purpose × record type a link can have opens its task page or, by name, the link frame', () => {
    const frame = linkKinds().filter((kind) => linkTaskOf({ purpose: kind.purpose, record: { type: kind.recordType } }) === null)
    // B-W2b-169: DOCUMENT_VIEW of files and of a payroll export, and SECURE_FILE, have their page (links/file).
    // B-W2b-163: W2b-3's purposes show the frame until their pages (B-W2b-169 and the purpose steps) add their rows.
    // B-W2b-188: APPROVAL has its page (links/approve).
    // B-W2b-181: JOB_ACCEPT has its page (links/job); B-W2b-198: CLAIM (links/claim); B-W2b-170: SHIPMENT_TRACK (links/tracking);
    // B-W2b-199: PAYMENT (links/pay); B-W2b-171: MEASUREMENTS (links/measure); B-W2b-172: SUPPLIER_ONBOARD (links/onboard);
    // B-W2b-200: RECORD_INVITE (links/invite). Every W2b-3 purpose has its page now: none shows the frame.
    expect(frame).toEqual([])
    for (const rule of LINK_TASK_RULES) expect(PURPOSE_RULES[rule.purpose].recordTypes, rule.task).toContain(rule.recordType)
    // B-W2b-198 / B-W2b-199: one task may serve several record types (CLAIM × Shipment and × SalesOrder; PAYMENT × Invoice and × DepositRequest): every task has a rule.
    expect([...new Set(LINK_TASK_RULES.map((rule) => rule.task))].sort()).toEqual([...LINK_TASKS].sort())
  })

  it('the tree\'s W1 link pages each have their task, plus the deposit page (SCR-199, the order screens)', () => {
    for (const page of LINKS) expect(LINK_TASKS, page.id).toContain(page.task)
    expect(LINK_TASKS.filter((task) => !LINKS.some((page) => page.task === task))).toEqual(['deposit-pay'])
  })

  it('QUOTE_ACCEPT, DEPOSIT_INFO, PO_CONFIRM and a shipment\'s DOCUMENT_VIEW route to their pages; anything else shows the frame', () => {
    expect(linkTaskOf({ purpose: 'QUOTE_ACCEPT', record: { type: 'Quote' } })).toBe('quote-accept')
    expect(linkTaskOf({ purpose: 'DEPOSIT_INFO', record: { type: 'DepositRequest' } })).toBe('deposit-pay')
    expect(linkTaskOf({ purpose: 'PO_CONFIRM', record: { type: 'PurchaseOrder' } })).toBe('po-confirm')
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'Shipment' } })).toBe('shipment-documents')
    // B-W2b-169
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'StoredFile' } })).toBe('files')
    expect(linkTaskOf({ purpose: 'SECURE_FILE', record: { type: 'StoredFile' } })).toBe('files')
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'PayrollExport' } })).toBe('payroll-file')
    // B-W2b-199: a PAYMENT link of an invoice or a deposit request opens Pay online.
    expect([linkTaskOf({ purpose: 'PAYMENT', record: { type: 'Invoice' } }), linkTaskOf({ purpose: 'PAYMENT', record: { type: 'DepositRequest' } })]).toEqual(['pay', 'pay'])
    expect(linkTaskOf({ purpose: 'SOMETHING_NEW', record: { type: 'Quote' } })).toBeNull()
  })

  it('the frame names every purpose in both languages', () => {
    for (const locale of LOCALES) for (const purpose of LINK_PURPOSES) expect(CATALOGUE[locale].shell?.[`links.purpose.${purpose}`], `${locale} ${purpose}`).toBeTruthy()
  })

  // B-W2b-203: the link pages a QR or a typed code opens (no token, no task), and every route of the Links view.
  it('every route of the Links view is a page of the tree: the landing, a page with no token, or a named part of one', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../app/(links)')
    const routes: string[] = []
    const walk = (dir: string, address: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${address}/${entry.name}`)
        else if (entry.name === 'page.tsx') routes.push(address || '/')
      }
    }
    walk(root, '')
    const noToken = LINKS_NO_TOKEN.flatMap((page) => page.hrefs)
    for (const href of noToken) expect(routes, href).toContain(href)
    // The landing of every token (/l), and parts of a tree page: an office approval from its e-mail (links.approve, B-W2b-188),
    // the sender's privacy notice (links.frame's foot), Find your order (links.tracking's public search, B-W2b-170).
    const parts = ['/l', '/l/approve', '/privacy/[company]', '/t']
    expect(routes.filter((route) => !noToken.includes(route) && !parts.includes(route)).sort()).toEqual([])
    expect(LINKS_NO_TOKEN.map((page) => page.id).filter((id) => LINKS.some((page) => page.id === id))).toEqual([])
  })

  it('every dead link offers "Ask for a new link": the registry holds no exception any more (B-W2b-F17)', async () => {
    // A purpose with no renewer tells the person who made the link (the API's fallback), RECORD_INVITE included.
    const registry = (await import('../../links/_nav/link-types')) as Record<string, unknown>
    expect(['NO_NEW_LINK', 'offersNewLink'].filter((name) => name in registry)).toEqual([])
  })
})

describe('the two naming fixes', () => {
  it('Admin is "Sistema" and Finance "Amministrazione" in Italian (the design\'s words); English stays Admin and Finance', () => {
    const itT = shellT('it')
    const en = shellT('en')
    expect([itT('shell:nav.admin.area'), itT('shell:nav.finance.area')]).toEqual(['Sistema', 'Amministrazione'])
    expect([en('shell:nav.admin.area'), en('shell:nav.finance.area')]).toEqual(['Admin', 'Finance'])
  })

  for (const locale of LOCALES) {
    it(`${locale}: every "Area › Page" a text points to names a page or group of that area`, () => {
      const t = shellT(locale)
      // B-W2b-55: a page an area declares and a later step builds (People's) is a page of that area too.
      const nav = translateNav({ view: 'office', areas: officeAreaDeclarations().map((declaration) => declaration.area) }, t)
      const places = new Map(nav.areas.map((area) => [area.label, [...(area.sections ?? []).map((section) => section.label), ...rows({ ...nav, areas: [area] }).map((row) => row.label)]]))
      const wrong: string[] = []
      for (const [namespace, dictionary] of Object.entries(CATALOGUE[locale])) {
        for (const [key, text] of Object.entries(dictionary)) {
          for (const match of text.matchAll(/(?:^|[\s(«“"])([A-ZÀ-Ý][^\s›(]*) › ([^›]+)/g)) {
            const names = places.get(match[1]!)
            if (!names) continue
            const rest = match[2]!
            if (!names.some((name) => rest === name || rest.startsWith(`${name} `) || /^[.,;:)»”"]/.test(rest.slice(name.length)) && rest.startsWith(name))) wrong.push(`${namespace}:${key}: ${match[1]} › ${rest}`)
          }
        }
      }
      expect(wrong).toEqual([])
    })
  }

  it('the new-series list names every number kind in both languages (no raw docs.kind.* key)', () => {
    for (const locale of LOCALES) {
      const docs = CATALOGUE[locale]['admin-documents'] ?? {}
      for (const kind of NUMBER_KINDS) expect(docs[`docs.kind.${kind}`], `${locale} ${kind}`).toBeTruthy()
    }
  })
})
