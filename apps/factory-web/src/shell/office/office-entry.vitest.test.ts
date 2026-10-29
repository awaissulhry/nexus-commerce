import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { permissionCheck } from '../../lib/session/session'
import { OWNER_PERMISSIONS, SALES_PERMISSIONS } from '../design-data'
import { firstOfficePage, OFFICE_NAV, OFFICE_PAGES, officeNavFor, PROFILE_PAGE } from '../nav/office-nav'

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

  it('OFFICE_PAGES lists exactly the office pages that are not entries', () => {
    expect(pages.map(addressOf).sort()).toEqual([...OFFICE_PAGES].sort())
  })

  it('/w/<company> and every area\'s own address have an entry or a page: the rail and the brand link never 404', () => {
    const addresses = new Set(files.map(addressOf))
    expect(addresses.has('/')).toBe(true)
    for (const area of OFFICE_NAV.areas) expect(addresses.has(area.href), area.href).toBe(true)
    expect(existsSync(join(OFFICE_DIR, 'home', 'page.tsx'))).toBe(true)
  })
})
