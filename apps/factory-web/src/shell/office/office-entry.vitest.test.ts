import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { permissionCheck } from '../../lib/session/session'
import { OWNER_PERMISSIONS, SALES_PERMISSIONS } from '../design-data'
import { firstOfficePage, isWindowPage, OFFICE_NAV, OFFICE_PAGES, officeNavFor, PROFILE_PAGE, WINDOW_PAGES } from '../nav/office-nav'
import { DECLARED_PAGES } from '../nav/office-nav' // owb- (base settle 7)
import { rolePermissions } from '../design-data'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates' // F-SA-210

/**
 * No dead landing: an office entry (`/w/<company>`, an area's own address, the brand link, a new session) opens the
 * first page the person may open among the BUILT pages, else My profile — and the list of built pages is the page
 * files themselves.
 */

const owner = officeNavFor(permissionCheck(OWNER_PERMISSIONS))
const sales = officeNavFor(permissionCheck(SALES_PERMISSIONS))

describe('the first page a person may open (shell/office/office-entry.ts)', () => {
  it('Home › Today is the entry for whoever holds home.view (every office role); Admin opens All settings; Mail to sort for one who only sorts mail; else My profile', () => {
    expect(firstOfficePage(owner)).toBe('/home/today')
    expect(firstOfficePage(owner, { areaId: 'home' })).toBe('/home/today')
    // Admin's own address is its first page, All settings (B-W0-27).
    expect(firstOfficePage(owner, { areaId: 'admin' })).toBe('/admin')
    // Without companies.view All settings is not theirs: Admin opens their first other built Admin page.
    expect(firstOfficePage(officeNavFor(permissionCheck(['users.view'])), { areaId: 'admin' })).toBe('/admin/users')
    expect(firstOfficePage(officeNavFor(permissionCheck(['email.triage'])))).toBe('/home/mail-to-sort')
    // B-W0-28 built the Audit log: a person who only reads it lands there.
    expect(firstOfficePage(officeNavFor(permissionCheck(['audit.read'])))).toBe('/admin/audit')
    expect(firstOfficePage(officeNavFor(permissionCheck([])))).toBe(PROFILE_PAGE)
  })

  it('once pages are built: the first in navigation order the person may open, inside the area first', () => {
    const built = new Set(['/me', '/home/today', '/home/mail-to-sort', '/admin/users', '/admin/audit'])
    expect(firstOfficePage(owner, { built })).toBe('/home/today')
    expect(firstOfficePage(owner, { areaId: 'admin', built })).toBe('/admin/users')
    // A sales person has no Admin: its address opens their own first page.
    expect(firstOfficePage(sales, { areaId: 'admin', built })).toBe('/home/today')
    // A row the person may not open is never chosen.
    expect(firstOfficePage(officeNavFor(permissionCheck(['audit.read'])), { built })).toBe('/admin/audit')
  })
})

// ── F-SA-210 (sales plan N1, pick P1; 12-lists-board §1.2): Sales opens on Orders, for every role that may read orders ──
describe('Sales opens on Orders (F-SA-210): the Sales address lands on the first Sales row each role template may open', () => {
  const salesEntry = (role: string) => firstOfficePage(officeNavFor(permissionCheck(templateOf(role)!.permissions)), { areaId: 'sales' })
  it.each(['owner', 'sales', 'production_manager', 'read_only', 'finance', 'warehouse', 'planner'])('%s → Sales › Orders', (role) => {
    expect(salesEntry(role)).toBe('/sales/orders')
  })
  it.each(['buyer', 'quality_inspector'])('%s (no orders.view) → Sales › Customers, their first allowed row', (role) => {
    expect(salesEntry(role)).toBe('/sales/customers')
  })
  it('the administrator lands on its own first allowed Sales row (or its first page when it has no Sales row)', () => {
    const nav = officeNavFor(permissionCheck(templateOf('admin')!.permissions))
    const sales = nav.areas.find((area) => area.id === 'sales')
    const first = sales?.sections?.flatMap((section) => section.items).find((item) => OFFICE_PAGES.has(item.href) && !isWindowPage(item.href))?.href
    expect(firstOfficePage(nav, { areaId: 'sales' })).toBe(first ?? firstOfficePage(nav))
  })
})
// ── end F-SA-210 ──

const OFFICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../app/(office)/w/[company]')
const pageFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? pageFiles(path) : entry.name === 'page.tsx' ? [path] : []
  })
const addressOf = (file: string) => `/${relative(OFFICE_DIR, dirname(file)).split(sep).join('/')}`.replace(/\/$/, '') || '/'

describe('the built pages are the page files (a page added without its address, or the other way, fails here)', () => {
  const files = pageFiles(OFFICE_DIR)
  const entries = files.filter((file) => readFileSync(file, 'utf8').includes('openOfficeEntry('))
  const pages = files.filter((file) => !entries.includes(file))
  // owb- (base settle 7): a declared page has its route stub but is not built yet (DECLARED_PAGES, not OFFICE_PAGES).
  const declared = pages.filter((file) => DECLARED_PAGES.has(addressOf(file)))

  it('OFFICE_PAGES lists exactly the office pages that are not entries (nor declared stubs)', () => {
    expect(pages.filter((file) => !declared.includes(file)).map(addressOf).sort()).toEqual([...OFFICE_PAGES].sort())
  })

  it('owb-: every declared page is a stub file showing NotBuiltYet, never built, never an entry; a built page is never declared', () => {
    expect(declared.map(addressOf).sort()).toEqual([...DECLARED_PAGES].sort())
    for (const file of declared) expect(readFileSync(file, 'utf8'), addressOf(file)).toContain('<NotBuiltYet />')
    for (const address of DECLARED_PAGES) expect(OFFICE_PAGES.has(address), address).toBe(false)
    // No entry ever lands on one: the owner's first page of each area stays a built page.
    for (const area of OFFICE_NAV.areas) expect(DECLARED_PAGES.has(firstOfficePage(owner, { areaId: area.id })), area.id).toBe(false)
  })

  it('/w/<company> and every area\'s own address have an entry or a page: the rail and the brand link never 404', () => {
    const addresses = new Set(files.map(addressOf))
    expect(addresses.has('/')).toBe(true)
    for (const area of OFFICE_NAV.areas) expect(addresses.has(area.href), area.href).toBe(true)
    expect(existsSync(join(OFFICE_DIR, 'home', 'page.tsx'))).toBe(true)
  })
})

describe('window pages (B-W2b-05: a page in its own window, opened from its row in a new tab)', () => {
  it('are built office pages, and an office entry never lands on one (it has no rail to go on from)', () => {
    for (const page of WINDOW_PAGES) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(isWindowPage('/planning/board?site=x')).toBe(true)
    expect(isWindowPage('/planning/board/')).toBe(true)
    expect(isWindowPage('/planning/mrp')).toBe(false)
    const planner = officeNavFor(permissionCheck(rolePermissions('planner')))
    expect(isWindowPage(firstOfficePage(planner, { areaId: 'planning' }))).toBe(false)
    // Someone whose only Planning page is the board lands outside it.
    expect(firstOfficePage(planner, { areaId: 'planning', built: new Set(['/planning/board', '/home/today']) })).toBe('/home/today')
  })
})
