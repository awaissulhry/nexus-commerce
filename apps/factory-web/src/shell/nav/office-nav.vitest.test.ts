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
      [8, 'quality'],
      [9, 'compliance'],
      [14, 'admin'],
    ])
    expect(OFFICE_NAV.view).toBe('office')
  })

  it('names only declared permissions, or the four a later W0 step declares (a typo fails here)', () => {
    const declared = new Set<string>(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))
    const unknown = navPermissions().filter((name) => !declared.has(name) && !PENDING_PERMISSIONS.has(name))
    expect(unknown).toEqual([])
    // A pending name that gets declared must leave the pending list.
    expect([...PENDING_PERMISSIONS].filter((name) => declared.has(name))).toEqual([])
  })
})

describe('navigation filtered by permission (areaNavForPerson, fail closed per row)', () => {
  it('the owner sees every W0 area and page, and Today', () => {
    expect(ids(officeNavFor(permissionCheck(OWNER_PERMISSIONS)))).toEqual([
      ['home', ['home-today', 'home-mail-to-sort']],
      [
        'admin',
        ['admin-companies', 'admin-sites', 'admin-devices', 'admin-users', 'admin-roles', 'admin-numbering', 'admin-email', 'admin-languages', 'admin-imports', 'admin-audit', 'admin-connections'],
      ],
    ])
  })

  it('a sales person sees Home › Today and Mail to sort, and no Admin at all', () => {
    expect(ids(officeNavFor(permissionCheck(SALES_PERMISSIONS)))).toEqual([['home', ['home-today', 'home-mail-to-sort']]])
  })

  it('the administrator template today: the rows whose permission exists, never a pending one', () => {
    const admin = ['users.view', 'roles.view', 'audit.read', 'numbering.view', 'devices.view', 'imports.view', 'email.manage', 'email.triage']
    expect(ids(officeNavFor(permissionCheck(admin)))).toEqual([
      ['home', ['home-mail-to-sort']],
      ['admin', ['admin-devices', 'admin-users', 'admin-roles', 'admin-numbering', 'admin-email', 'admin-imports', 'admin-audit']],
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
    expect(nav.areas.map((area) => area.label)).toEqual(['Home', 'Admin'])
    expect(nav.areas[1]?.sections?.map((s) => s.label)).toEqual(['Organisation', 'Access', 'Platform'])
    const it = translateNav(OFFICE_NAV, createScopedTranslator('it', messagesFor('it', ['shell']), 'shell'))
    expect(it.areas.find((area) => area.id === 'admin')?.label).toBe('Amministrazione')
    expect(it.areas.find((area) => area.id === 'compliance')?.label).toBe('Conformità')
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
    expect(navPages(nav)).toHaveLength(13)
  })

  it('on a phone: Home and Admin as tabs (one entry under More becomes a tab), Admin current on its pages', () => {
    const layout = bottomBarLayout(nav, '/admin/users')
    expect(layout.tabs.map((tab) => tab.id)).toEqual(['home', 'admin'])
    expect(layout.more).toEqual([])
    expect(layout.current).toBe('admin')
  })
})
