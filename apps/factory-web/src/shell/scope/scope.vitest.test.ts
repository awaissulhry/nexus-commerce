import { describe, expect, it } from 'vitest'
import { officeMeSchema } from '../../lib/api/office'
import { recallScope, recallStart, rememberScope } from '../../lib/session/scope-memory'
import { permissionCheck, sessionFromMe } from '../../lib/session/session'
import { rolePermissions } from '../design-data'
import { officeNavFor } from '../nav/office-nav'
import { siteColumn } from './scope-context'
import { scopeChip, scopeOf, scopeQuery, siteNameOf } from './scope-model'
import { sameStart, startAddressOf, startChoiceOf, startPageFor, startPagesOf } from './start/start-page'
import { matchCompanies, needsCompanySearch } from './switcher-search'

const company = { id: 'c1', code: 'DEMO', name: 'Officina Demo' }
const NORTH = { id: 's-north', code: 'N1', name: 'North plant' }
const SOUTH = { id: 's-south', code: 'S1', name: 'South store' }

describe('the scope every Office page reads (B-W2b-05, PLT-008)', () => {
  it('a site chosen among the person\'s sites narrows the page; another id, or none, is all sites', () => {
    expect(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: 's-south' })).toMatchObject({ site: SOUTH, siteId: 's-south', allSites: false, fixed: false, limited: false })
    expect(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: 'another-company-site' })).toMatchObject({ site: null, siteId: null, allSites: true })
    expect(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: null })).toMatchObject({ site: null, allSites: true })
  })

  it('a person whose roles reach some sites chooses among those ("All my sites"); one site is fixed', () => {
    expect(scopeOf({ company, sites: [NORTH, SOUTH], everySite: false, chosen: null })).toMatchObject({ limited: true, allSites: true })
    expect(scopeOf({ company, sites: [SOUTH], everySite: false, chosen: null })).toMatchObject({ fixed: true, site: SOUTH, siteId: 's-south', allSites: false })
    // A company with one site: the page works in it, whatever was remembered.
    expect(scopeOf({ company, sites: [NORTH], everySite: true, chosen: 'gone' })).toMatchObject({ fixed: true, siteId: 's-north' })
    // No site at all: nothing to narrow, no Site column.
    expect(scopeOf({ company, sites: [], everySite: true, chosen: null })).toMatchObject({ site: null, allSites: false, fixed: false, limited: false })
  })

  it('"All sites" adds the chip and the Site column; one site says its name; a row\'s site is named from the person\'s sites', () => {
    expect(scopeChip(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: null }))).toEqual({ kind: 'all', limited: false })
    expect(scopeChip(scopeOf({ company, sites: [NORTH, SOUTH], everySite: false, chosen: null }))).toEqual({ kind: 'all', limited: true })
    expect(scopeChip(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: 's-north' }))).toEqual({ kind: 'site', name: 'North plant' })
    expect(scopeChip(scopeOf({ company, sites: [NORTH], everySite: true, chosen: null }))).toBeNull()
    expect(siteNameOf({ sites: [NORTH, SOUTH] }, 's-south')).toBe('South store')
    expect(siteNameOf({ sites: [NORTH] }, 's-other')).toBeNull()
    expect(scopeQuery({ siteId: 's-north' })).toEqual({ siteId: 's-north' })
    expect(scopeQuery({ siteId: null })).toEqual({})
  })

  it('the Site column comes with "All sites" only, and names each row\'s site', () => {
    const all = scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: null })
    const column = siteColumn<{ siteId: string }>(all, (row) => row.siteId, 'Site')!
    expect(column.headerName).toBe('Site')
    const getter = column.valueGetter as (params: { data?: { siteId: string } }) => string
    expect(getter({ data: { siteId: 's-south' } })).toBe('South store')
    expect(getter({ data: { siteId: 's-elsewhere' } })).toBe('')
    expect(siteColumn(scopeOf({ company, sites: [NORTH, SOUTH], everySite: true, chosen: 's-north' }), () => null, 'Site')).toBeNull()
  })

  it('the session takes the sites the API lists for the screen\'s company (me.sites), and whether that is every site', () => {
    const me = officeMeSchema.parse({
      user: { id: 'u1', email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'it' },
      tenant: { id: 't1', slug: 'demo', name: 'Officina Demo' },
      company,
      sites: [NORTH],
      allSites: false,
      session: { id: 's1', createdAt: '2026-10-28T08:00:00.000Z', idleExpiresAt: '2026-10-28T16:00:00.000Z', absoluteExpiresAt: '2026-11-04T08:00:00.000Z', stepUpUntil: null },
      mfa: { enabled: true, required: false, satisfied: true, recoveryCodesLeft: 10 },
      permissions: [],
    })
    expect(sessionFromMe(me)).toMatchObject({ sites: [NORTH], allSites: false })
    // An older API without the field: no site, every site.
    expect(sessionFromMe({ ...me, sites: undefined, allSites: undefined })).toMatchObject({ sites: [], allSites: false })
  })

  it('a remembered site the person no longer reaches is all sites (the switcher never offers another\'s site)', () => {
    const person = { tenantId: 't1', userId: 'u1' }
    const cookie = rememberScope(null, person, { company: 'DEMO', site: 's-gone' })
    expect(recallScope(cookie, person, { companies: ['DEMO'], sites: ['s-north'] })).toEqual({ company: 'DEMO', site: null })
  })
})

describe('the switcher\'s company search (more than 7 companies)', () => {
  const many = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Théta'].map((name) => ({ id: name, code: name.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''), name: `${name} Demo S.r.l.` }))
  it('lists up to 7 itself; past 7 it searches by name or code, any case, any accent', () => {
    expect(needsCompanySearch(many.slice(0, 7))).toBe(false)
    expect(needsCompanySearch(many)).toBe(true)
    expect(matchCompanies(many, 'theta').map((entry) => entry.code)).toEqual(['THETA'])
    expect(matchCompanies(many, 'demo GAM').map((entry) => entry.code)).toEqual(['GAMMA'])
    expect(matchCompanies(many, '')).toHaveLength(8)
    expect(matchCompanies(many, 'zzz')).toEqual([])
  })
})

describe('the start page (design shell.scope sec:defaults)', () => {
  const nav = officeNavFor(permissionCheck(rolePermissions('owner')))
  it('Today is the default; a saved view is its list\'s own link', () => {
    expect(startAddressOf({ kind: 'today' })).toBeNull()
    expect(startAddressOf({ kind: 'view', page: '/sales/orders', viewId: 'v 1' })).toBe('/sales/orders?savedView=v%201')
    expect(startChoiceOf('/sales/orders?savedView=v%201')).toEqual({ kind: 'view', page: '/sales/orders', viewId: 'v 1' })
    expect(startChoiceOf('/sales/orders')).toEqual({ kind: 'today' })
    expect(startChoiceOf(null)).toEqual({ kind: 'today' })
    expect(sameStart({ kind: 'today' }, { kind: 'today' })).toBe(true)
    expect(sameStart({ kind: 'view', page: '/a', viewId: '1' }, { kind: 'view', page: '/a', viewId: '2' })).toBe(false)
  })

  it('the entry opens it only while the person may open its page; never a window page', () => {
    expect(startPageFor('/sales/orders?savedView=v1', nav)).toBe('/sales/orders?savedView=v1')
    expect(startPageFor('/sales/orders?savedView=v1', officeNavFor(permissionCheck(['home.view'])))).toBeNull()
    expect(startPageFor('/planning/board?savedView=v1', nav)).toBeNull()
    expect(startPagesOf(nav).some((page) => page.href === '/planning/board')).toBe(false)
  })

  it('is kept per person with their company and site, and a later visit keeps it', () => {
    const anna = { tenantId: 't1', userId: 'anna' }
    const bruno = { tenantId: 't1', userId: 'bruno' }
    let cookie = rememberScope(null, anna, { company: 'DEMO', site: null, start: '/sales/orders?savedView=v1' })
    cookie = rememberScope(cookie, bruno, { company: 'DEMO', site: null })
    cookie = rememberScope(cookie, anna, { company: 'ESEMPIO', site: 's-north' })
    expect(recallStart(cookie, anna)).toBe('/sales/orders?savedView=v1')
    expect(recallStart(cookie, bruno)).toBeNull()
    cookie = rememberScope(cookie, anna, { company: 'ESEMPIO', site: null, start: null })
    expect(recallStart(cookie, anna)).toBeNull()
  })
})
