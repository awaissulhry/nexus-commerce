import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { bottomBarLayout } from '@nexus/ui/components/BottomBar/index'
import { createScopedTranslator, messagesFor } from '../../lib/i18n/messages'
import { permissionCheck } from '../../lib/session/session'
import { OWNER_PERMISSIONS, SALES_PERMISSIONS } from '../design-data'
import { navPages, navPermissions, OFFICE_NAV, officeAreaDeclarations, officeCrumbs, officeNavFor, PENDING_PERMISSIONS, translateNav } from './office-nav'

const ids = (nav: typeof OFFICE_NAV) => nav.areas.map((area) => [area.id, (area.sections ?? []).flatMap((s) => s.items.map((i) => i.id))])
const en = createScopedTranslator('en', messagesFor('en', ['shell']), 'shell')

describe('the Office navigation (PLT-160: one declaration per area)', () => {
  it('finds every areas/<area>/nav.ts by itself and orders them as the main sidebar (Home first, Admin last)', () => {
    expect(officeAreaDeclarations().map((d) => [d.order, d.area.id])).toEqual([
      [1, 'home'],
      [2, 'sales'],
      [3, 'products'],
      [5, 'planning'],
      [6, 'purchasing'],
      [7, 'warehouse'],
      [8, 'production'],
      [9, 'quality'],
      [10, 'compliance'],
      [14, 'admin'],
    ])
    expect(OFFICE_NAV.view).toBe('office')
  })

  it('names only declared permissions, or the two a later W0 step declares (a typo fails here)', () => {
    const declared = new Set<string>(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))
    const unknown = navPermissions().filter((name) => !declared.has(name) && !PENDING_PERMISSIONS.has(name))
    expect(unknown).toEqual([])
    // A pending name that gets declared must leave the pending list.
    expect([...PENDING_PERMISSIONS].filter((name) => declared.has(name))).toEqual([])
  })
})

describe('navigation filtered by permission (areaNavForPerson, fail closed per row)', () => {
  it('the owner sees every W0 area and page, Today, and the W1 pages built so far', () => {
    expect(ids(officeNavFor(permissionCheck(OWNER_PERMISSIONS)))).toEqual([
      ['home', ['home-today', 'home-mail-to-sort']],
      ['sales', ['sales-customers']],
      ['purchasing', ['purchasing-suppliers']],
      [
        'admin',
        ['admin-overview', 'admin-companies', 'admin-devices', 'admin-users', 'admin-roles', 'admin-documents', 'admin-languages', 'admin-connections', 'admin-import', 'admin-audit'],
      ],
    ])
  })

  it('a sales person sees Home › Today and Mail to sort, and no Admin at all', () => {
    expect(ids(officeNavFor(permissionCheck(SALES_PERMISSIONS)))).toEqual([['home', ['home-today', 'home-mail-to-sort']]])
  })

  it('the administrator template today: every Admin row (B-W0-28 declared integrations.view)', () => {
    const admin = ['companies.view', 'sites.view', 'users.view', 'roles.view', 'audit.read', 'numbering.view', 'devices.view', 'imports.view', 'email.manage', 'email.triage', 'integrations.view']
    expect(ids(officeNavFor(permissionCheck(admin)))).toEqual([
      ['home', ['home-mail-to-sort']],
      ['admin', ['admin-overview', 'admin-companies', 'admin-devices', 'admin-users', 'admin-roles', 'admin-documents', 'admin-languages', 'admin-connections', 'admin-import', 'admin-audit']],
    ])
  })

  it('workorders.view opens Production › Floor now and Work orders (B-W1-38 part 2), nothing of Admin', () => {
    expect(ids(officeNavFor(permissionCheck(['home.view', 'workorders.view', 'workorders.manage', 'workorders.release'])))).toEqual([
      ['home', ['home-today']],
      ['production', ['production-floor', 'production-work-orders']],
    ])
  })

  it('a quality inspector sees Quality › Inspections and Compliance › Tests & substances and the PPE register', () => {
    const inspector = ['home.view', 'quality.inspections.view', 'quality.lots.view', 'compliance.register.view']
    expect(ids(officeNavFor(permissionCheck(inspector)))).toEqual([
      ['home', ['home-today']],
      ['quality', ['quality-inspections']],
      ['compliance', ['compliance-tests', 'compliance-register']],
    ])
    // A production manager sees inspections only; the lots and the register need their own permissions.
    expect(ids(officeNavFor(permissionCheck(['quality.inspections.view'])))).toEqual([['quality', ['quality-inspections']]])
  })

  it('the buying office: What to buy & make (planning.view), Purchase orders (purchasing.view), Receipts (inventory.stock.view)', () => {
    expect(ids(officeNavFor(permissionCheck(['planning.view', 'purchasing.view', 'inventory.stock.view'])))).toEqual([
      ['planning', ['planning-mrp']],
      ['purchasing', ['purchasing-orders']],
      ['warehouse', ['warehouse-receipts']],
    ])
    // The warehouse role reads the orders it receives against (and the parties: Customers and Suppliers), not the plan.
    expect(ids(officeNavFor(permissionCheck(['purchasing.view', 'inventory.stock.view', 'parties.view'])))).toEqual([
      ['sales', ['sales-customers']],
      ['purchasing', ['purchasing-suppliers', 'purchasing-orders']],
      ['warehouse', ['warehouse-receipts']],
    ])
  })

  it('a person with no permission sees no area: no door that leads nowhere', () => {
    expect(officeNavFor(permissionCheck([])).areas).toEqual([])
  })

  it('one permission opens one row and its area, nothing else', () => {
    expect(ids(officeNavFor(permissionCheck(['audit.read'])))).toEqual([['admin', ['admin-audit']]])
  })
})

describe('labels, crumbs, palette pages and the phone bar come from the same manifest', () => {
  const nav = translateNav(officeNavFor(permissionCheck(OWNER_PERMISSIONS)), en)

  it('draws every label in the language (keys never reach the screen)', () => {
    expect(nav.areas.map((area) => area.label)).toEqual(['Home', 'Sales', 'Purchasing', 'Admin'])
    expect(nav.areas[3]?.sections?.map((s) => s.label)).toEqual(['Admin', 'Organisation', 'Access', 'Platform', 'Data'])
    const it = translateNav(OFFICE_NAV, createScopedTranslator('it', messagesFor('it', ['shell']), 'shell'))
    expect(it.areas.map((area) => area.label)).toEqual(['Home', 'Vendite', 'Prodotti', 'Pianificazione', 'Acquisti', 'Magazzino', 'Produzione', 'Qualità', 'Conformità', 'Amministrazione'])
    expect(JSON.stringify(nav)).not.toContain('shell:')
  })

  it('crumbs: area › page; the section is not a crumb; the current page has no link', () => {
    expect(officeCrumbs(nav, '/admin/users')).toEqual([
      { id: 'admin', name: 'Admin', href: '/admin' },
      { id: 'admin-users', name: 'Users' },
    ])
  })

  it('a record under a page keeps the page as a link (deep links, PLT-161)', () => {
    expect(officeCrumbs(nav, '/admin/users/0190f0e2-3333-7000-8000-000000000001')).toEqual([
      { id: 'admin', name: 'Admin', href: '/admin' },
      { id: 'admin-users', name: 'Users', href: '/admin/users' },
    ])
    expect(officeCrumbs(nav, '/me')).toEqual([])
  })

  it('the palette jumps to every page the person may open', () => {
    expect(navPages(officeNavFor(permissionCheck(SALES_PERMISSIONS))).map((page) => page.href)).toEqual(['/home/today', '/home/mail-to-sort'])
    expect(navPages(nav)).toHaveLength(14)
  })

  it('on a phone: Home and Sales as tabs, Purchasing and Admin under More (then More is current), Sales current on its records', () => {
    const layout = bottomBarLayout(nav, '/admin/users')
    expect(layout.tabs.map((tab) => tab.id)).toEqual(['home', 'sales'])
    expect(layout.more.map((entry) => entry.id)).toEqual(['purchasing', 'admin'])
    // An area under More marks More as the current tab.
    expect(layout.current).toBe('more')
    expect(bottomBarLayout(nav, '/sales/customers/0190f0e2-6666-7000-8000-000000000001').current).toBe('sales')
  })
})
