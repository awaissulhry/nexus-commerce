import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { LENS_RULES } from '@nexus/factory-domain/insights/flow'
import { LINK_PURPOSES, PURPOSE_RULES } from '@nexus/factory-domain/links/purposes'
import { NUMBER_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { areaSubNavGroups, findAreaNavPlace, type AreaNav, type AreaNavItem } from '@nexus/ui/patterns/shell/index'
import { NEW_VERBS } from '../../areas/home/today/model'
import { PANELS } from '../../areas/home/today/panels'
import { FLOOR_MODES, homeTiles, MAX_TILES, TILE_KEYS, TILE_RULES, type FloorMode, type TileKey } from '../../floor/model'
import { LABEL_TYPES, type ScanRead } from '../../floor/scan/scan-model'
import { TASK_ROUTES, taskForScan, taskOfTile } from '../../floor/tasks/routes'
import { LOCALES, type Locale } from '../../lib/i18n/locales'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../lib/i18n/messages'
import { attentionAddress, hasRecordPage, LIST_PAGES, listAddress, RECORD_PAGES, recordAddress } from '../../lib/records/record-links'
import { permissionCheck } from '../../lib/session/session'
import { LINK_TASK_RULES, LINK_TASKS, linkKinds, linkTaskOf } from '../../links/_nav/link-types'
import { matchPages } from '../palette/palette-model'
import { FLOOR, FRAME, LINKS, OFFICE, type TreePage } from './approved-tree'
import { FRAME_PAGES, OFFICE_NAV, OFFICE_PAGES, officeAreaDeclarations, officeNavFor, palettePages, translateNav } from './office-nav'

/**
 * B-W1-08, the W1 navigation check (SCR-003; PLT-160, PLT-036): the whole map against the approved tree (design
 * 01-navigation-tree, copied in approved-tree.ts) — the rail, every area's Pages overlay, the words in both languages,
 * the permissions, the built pages, the record links and list addresses Home uses, the floor tiles and the scan router,
 * the link-type registry and the palette. A gap, a wrong order, a wrong word or an extra row fails here.
 */

const namespaces = Object.keys(CATALOGUE.en)
const shellT = (locale: Locale) => createScopedTranslator(locale, messagesFor(locale, namespaces), 'shell')
const sample = (address: string) => address.replace(/\[companyId\]/g, 'c0').replace(/\[[^\]/]+\]/g, 'x1')
const rows = (nav: AreaNav): AreaNavItem[] => nav.areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.flatMap((item) => [item, ...(item.children ?? [])])))
const shipped = (page: TreePage) => page.href !== null && !page.deferred
const owner = officeNavFor(permissionCheck(templateOf('owner')!.permissions))

describe('the Office map is the approved tree (rail, overlays, words, order)', () => {
  it('the rail: one area per tree area that has a W0/W1 page, in the tree\'s order and with its order number; Admin at the foot', () => {
    expect(officeAreaDeclarations().map((d) => [d.order, d.area.id])).toEqual(OFFICE.map((area) => [area.order, area.id]))
    expect(OFFICE_NAV.areas[OFFICE_NAV.areas.length - 1]?.id).toBe('admin')
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

  it('no later-wave page shows: every row is a W0/W1 page of the tree (or one the Owner moved earlier), none deferred', () => {
    const allowed = new Set(OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter(shipped).map((page) => page.href))))
    expect(rows(OFFICE_NAV).map((row) => row.href).filter((href) => !allowed.has(href))).toEqual([])
    const early = OFFICE.flatMap((area) => area.groups.flatMap((group) => group.pages.filter((page) => page.early).map((page) => page.id)))
    expect(early).toEqual(['admin.overview'])
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
      '/home/approvals': 'quotes.view', // GET /sales/quote-approvals
      '/home/tasks': 'home.view', // GET /tasks (B-W2a-40)
      '/home/notifications': 'home.view', // GET /notifications (B-W2a-40)
      '/home/mail-to-sort': 'email.triage', // GET /email/inbound
      '/sales/customers': 'parties.view', // GET /parties
      '/sales/quotes': 'quotes.view', // GET /sales/quotes
      '/sales/orders': 'orders.view', // GET /sales/orders
      '/sales/price-lists': 'pricelists.view', // GET /sales/price-lists (B-W2a-49)
      '/products/styles': 'product.styles.view', // GET /product/styles
      '/products/materials': 'product.materials.view', // GET /product/materials
      '/products/operations': 'product.routing.view', // GET /product/operations
      '/products/sizes': 'product.styles.view', // GET /product/size-scales
      '/planning/mrp': 'planning.view', // GET /planning/runs/latest
      '/planning/board': 'planning.view', // GET /planning/schedule (B-W2a-45)
      '/planning/allocation': 'planning.view', // GET /planning/allocation (B-W2a-45)
      '/purchasing/suppliers': 'parties.view', // GET /parties
      '/purchasing/orders': 'purchasing.view', // GET /purchasing/orders
      '/purchasing/subcontracting': 'purchasing.view', // GET /purchasing/subcontracting/orders (B-W2a-56)
      '/warehouse/stock': 'inventory.stock.view', // GET /inventory/stock
      '/warehouse/hides': 'inventory.stock.view', // GET /inventory/hides
      '/warehouse/lots': 'inventory.stock.view', // GET /inventory/lots
      '/warehouse/moves': 'inventory.stock.view', // GET /inventory/ledger
      '/warehouse/receipts': 'inventory.stock.view', // GET /inventory/receipts
      '/warehouse/picking': 'inventory.stock.view', // GET /inventory/picking/pick-lists (B-W2a-58)
      '/warehouse/counts': 'inventory.counts.view', // GET /inventory/stock-counts
      '/warehouse/shipments': 'shipping.view', // GET /shipping/shipments
      '/warehouse/locations': 'inventory.locations.view', // GET /inventory/locations
      '/warehouse/shipping': 'shipping.settings.view', // GET /shipping/settings
      '/production/floor': 'workorders.view', // GET /production/scans/wip
      '/production/work-orders': 'workorders.view', // GET /production/work-orders
      '/production/reports': 'production.reports.view', // GET /production/reports/daily
      '/production/settings': 'production.settings.view', // GET /production/settings
      '/quality/inspections': 'quality.inspections.view', // GET /quality/inspections
      '/compliance/certificates': 'compliance.certificates.view', // GET /compliance/certificates
      '/compliance/labels': 'compliance.certificates.view', // GET /compliance/labels
      '/compliance/tests': 'quality.lots.view', // GET /quality/lots
      '/compliance/register': 'compliance.register.view', // GET /compliance/register
      '/finance/invoices': 'invoices.view', // GET /invoicing/invoices
      '/finance/payments': 'payments.view', // GET /payments
      '/finance/accounting': 'accounting.view', // GET /accounting/exports (B-W2a-51)
      '/finance/reports': 'inventory.stock.view', // GET /costing/valuation (B-W2a-51)
      '/finance/settings': 'invoices.view', // GET /invoicing/settings
      // B-W2a-53: Plant › Maintenance.
      '/plant/requests': 'plant.view', // GET /plant/requests
      '/plant/jobs': 'plant.view', // GET /plant/jobs
      '/plant/machines': 'plant.view', // GET /plant/machines
      '/admin': 'companies.view', // the checklist reads the companies
      '/admin/companies': 'companies.view',
      '/admin/devices': 'devices.view',
      '/admin/users': 'users.view',
      '/admin/roles': 'roles.view',
      '/admin/security': 'security.view', // GET /admin/security (B-W2a-36)
      '/admin/documents': 'numbering.view', // GET /numbering/series
      '/admin/languages': 'companies.view',
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
    // valuation's quantities, B-W2a-51); of Admin only Import & export (the opening stock import).
    const warehouse = officeNavFor(permissionCheck(templateOf('warehouse')!.permissions))
    expect(warehouse.areas.map((area) => area.id)).toEqual(['home', 'sales', 'products', 'purchasing', 'warehouse', 'production', 'compliance', 'finance', 'admin'])
    expect(rows(warehouse).filter((row) => row.href.startsWith('/finance/')).map((row) => row.href)).toEqual(['/finance/reports'])
    expect(rows(warehouse).filter((row) => row.href.startsWith('/warehouse/') || row.href.startsWith('/admin')).map((row) => row.href)).toEqual([
      '/warehouse/stock',
      '/warehouse/hides',
      '/warehouse/lots',
      '/warehouse/moves',
      '/warehouse/receipts',
      '/warehouse/picking',
      '/warehouse/counts',
      '/warehouse/shipments',
      '/warehouse/locations',
      '/warehouse/shipping',
      '/admin/import',
    ])
    // The sales role: all of Sales, Home's approvals and mail, no Quality, Compliance or Planning.
    const sales = officeNavFor(permissionCheck(templateOf('sales')!.permissions))
    expect(sales.areas.map((area) => area.id)).toEqual(['home', 'sales', 'products', 'purchasing', 'warehouse', 'production', 'finance', 'admin'])
    expect(rows(sales).filter((row) => row.href.startsWith('/sales/') || row.href.startsWith('/home/')).map((row) => row.href)).toEqual([
      '/home/today',
      '/home/approvals',
      '/home/tasks',
      '/home/notifications',
      '/home/mail-to-sort',
      '/sales/customers',
      '/sales/quotes',
      '/sales/orders',
      '/sales/price-lists',
    ])
    // A role's rows keep the full map's order.
    const order = rows(OFFICE_NAV).map((row) => row.href)
    for (const nav of [warehouse, sales]) {
      const mine = rows(nav).map((row) => order.indexOf(row.href))
      expect(mine).toEqual([...mine].sort((a, b) => a - b))
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
  const SECOND_PAGES = new Set(['/purchasing/suppliers/[partyId]', '/compliance/tests/[id]'])
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

  it('a site opens under its company; without its company it opens its panels', () => {
    expect(recordAddress({ type: 'Site', id: 's1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/admin/companies/c1/sites/s1')
    expect(recordAddress({ type: 'Site', id: 's1' }, OFFICE_PAGES)).toBe('/records/Site/s1')
  })

  it('a record without a page of its own opens its panels (thread, files, history)', () => {
    for (const type of ['DepositRequest', 'Ddt', 'ScanCorrectionRequest', 'FloorScanRefusal', 'StoredFile']) {
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
    expect(attentionAddress('SCAN_CORRECTION', { type: 'ScanCorrectionRequest', id: 'k1' }, OFFICE_PAGES)).toBe('/records/ScanCorrectionRequest/k1')
  })
})

describe('the floor tiles and the scan router (floor/model.ts, floor/tasks/routes.ts)', () => {
  const everything = [...new Set(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))]

  it('one tile per W1 floor task, in the tree\'s order, Scan anything last; every tile built, every task tile has its page', () => {
    const order = FLOOR.filter((page) => page.tile !== 'scan').map((page) => page.tile)
    expect(TILE_RULES.map((rule) => rule.key)).toEqual([...order, 'scan'])
    expect([...TILE_KEYS]).toEqual([...order, 'scan'])
    for (const rule of TILE_RULES) {
      expect(rule.built, rule.key).toBe(true)
      if (rule.key !== 'scan') expect(TASK_ROUTES[taskOfTile(rule.key)!], rule.key).toBe(`/floor/${rule.key}`)
    }
  })

  it('each tile in the station modes the tree gives it (Operation also at the inspection bench: the floor tasks\' decision)', () => {
    const added: Partial<Record<TileKey, readonly FloorMode[]>> = { operation: ['inspection'] }
    for (const page of FLOOR) {
      const rule = TILE_RULES.find((entry) => entry.key === page.tile)!
      const tree = page.modes.filter((mode): mode is FloorMode => (FLOOR_MODES as readonly string[]).includes(mode))
      expect(rule.modes === 'all' ? [...FLOOR_MODES] : [...rule.modes].sort(), page.id).toEqual(page.tile === 'scan' ? [...FLOOR_MODES] : [...tree, ...(added[rule.key] ?? [])].sort())
    }
  })

  it('each tile asks the permission its page\'s API needs, declared in the catalogue', () => {
    expect(Object.fromEntries(TILE_RULES.map((rule) => [rule.key, rule.permission]))).toEqual({
      operation: 'production.scan',
      cut: 'production.cut',
      bundles: 'production.bundles',
      receive: 'inventory.receive',
      pick: 'inventory.issue',
      labels: 'production.serials',
      pack: 'shipping.pack',
      final: 'quality.inspections.view',
      scan: 'floor.work',
    })
    for (const rule of TILE_RULES) expect(everything, rule.key).toContain(rule.permission)
  })

  it('a station shows its mode\'s tiles in order, at most six, each with its word in both languages', () => {
    const keys = (mode: FloorMode) => homeTiles(mode, everything, false).map((tile) => tile.key)
    expect(Object.fromEntries(FLOOR_MODES.map((mode) => [mode, keys(mode)]))).toEqual({
      cutting: ['operation', 'cut', 'bundles', 'scan'],
      sewing: ['operation', 'scan'],
      packing: ['operation', 'labels', 'pack', 'scan'],
      inspection: ['operation', 'final', 'scan'],
      warehouse: ['receive', 'pick', 'scan'],
    })
    for (const mode of FLOOR_MODES) expect(keys(mode).length).toBeLessThanOrEqual(MAX_TILES)
    for (const locale of LOCALES) {
      const floor = CATALOGUE[locale].floor ?? {}
      for (const key of TILE_KEYS) {
        expect(floor[`tile.${key}`], `${locale} tile.${key}`).toBeTruthy()
        if (key !== 'scan') expect(floor[`tile.hint.${key}`], `${locale} tile.hint.${key}`).toBeTruthy()
      }
    }
  })

  it('the scan router opens the right task for each label type at each station, and only a tile the station shows', () => {
    const label = (type: (typeof LABEL_TYPES)[number]): ScanRead => ({ kind: 'label', type, code: 'X' })
    const reads: Record<string, ScanRead> = { ...Object.fromEntries(LABEL_TYPES.map((type) => [type, label(type)])), free: { kind: 'free', code: 'WO-00001' } }
    const expected: Record<FloorMode, Partial<Record<string, TileKey>>> = {
      sewing: { bundle: 'operation' },
      cutting: { hide: 'cut', bundle: 'bundles' },
      warehouse: { workOrder: 'pick', free: 'pick' },
      packing: { bundle: 'operation', serial: 'pack', free: 'pack' },
      inspection: { bundle: 'operation', workOrder: 'final', free: 'final' },
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
})

describe('the link-type registry (links/_nav/link-types.ts)', () => {
  it('every purpose × record type a link can have opens its task page or, by name, the link frame', () => {
    const frame = linkKinds().filter((kind) => linkTaskOf({ purpose: kind.purpose, record: { type: kind.recordType } }) === null)
    expect(frame).toEqual([{ purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile' }])
    for (const rule of LINK_TASK_RULES) expect(PURPOSE_RULES[rule.purpose].recordTypes, rule.task).toContain(rule.recordType)
    expect(LINK_TASK_RULES.map((rule) => rule.task).sort()).toEqual([...LINK_TASKS].sort())
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
    expect(linkTaskOf({ purpose: 'DOCUMENT_VIEW', record: { type: 'StoredFile' } })).toBeNull()
    expect(linkTaskOf({ purpose: 'SOMETHING_NEW', record: { type: 'Quote' } })).toBeNull()
  })

  it('the frame names every purpose in both languages', () => {
    for (const locale of LOCALES) for (const purpose of LINK_PURPOSES) expect(CATALOGUE[locale].shell?.[`links.purpose.${purpose}`], `${locale} ${purpose}`).toBeTruthy()
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
      const nav = translateNav(OFFICE_NAV, t)
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
