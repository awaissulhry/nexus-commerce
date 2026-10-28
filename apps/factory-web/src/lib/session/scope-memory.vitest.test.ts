import { describe, expect, it } from 'vitest'
import { companySwitchHref, currentCompany, currentSite, switcherHasChoices } from '../../shell/switcher/switcher-model'
import { landingCompany, MAX_PEOPLE, readScopeMemory, recallScope, rememberScope } from './scope-memory'
import { splitOfficePath } from './session'

const anna = { tenantId: 't1', userId: 'anna' }
const bruno = { tenantId: 't1', userId: 'bruno' }
const annaElsewhere = { tenantId: 't2', userId: 'anna' }

describe('the switcher remembers the company and site per person (SCR-002)', () => {
  it('brings each person back to their own company and site on a shared computer', () => {
    let cookie = rememberScope(undefined, anna, { company: 'DEMO', site: 'north' })
    cookie = rememberScope(cookie, bruno, { company: 'ESEMPIO', site: null })
    expect(recallScope(cookie, anna, { companies: ['DEMO', 'ESEMPIO'] })).toEqual({ company: 'DEMO', site: 'north' })
    expect(recallScope(cookie, bruno, { companies: ['DEMO', 'ESEMPIO'] })).toEqual({ company: 'ESEMPIO', site: null })
  })

  it('keeps the latest choice, newest person first', () => {
    let cookie = rememberScope(undefined, anna, { company: 'DEMO', site: null })
    cookie = rememberScope(cookie, bruno, { company: 'DEMO', site: null })
    cookie = rememberScope(cookie, anna, { company: 'ESEMPIO', site: 'south' })
    expect(readScopeMemory(cookie).map(([key]) => key)).toEqual(['t1:anna', 't1:bruno'])
    expect(recallScope(cookie, anna, { companies: ['DEMO', 'ESEMPIO'] })).toEqual({ company: 'ESEMPIO', site: 'south' })
  })

  it('tells the same user id in two tenants apart', () => {
    const cookie = rememberScope(rememberScope(undefined, anna, { company: 'DEMO', site: null }), annaElsewhere, { company: 'OTHER', site: null })
    expect(recallScope(cookie, anna, { companies: ['DEMO', 'OTHER'] })?.company).toBe('DEMO')
    expect(recallScope(cookie, annaElsewhere, { companies: ['DEMO', 'OTHER'] })?.company).toBe('OTHER')
  })

  it('ignores a remembered company the person may no longer open, and a site that is gone', () => {
    const cookie = rememberScope(undefined, anna, { company: 'DEMO', site: 'north' })
    expect(recallScope(cookie, anna, { companies: ['ESEMPIO'] })).toBeNull()
    expect(recallScope(cookie, anna, { companies: ['DEMO'], sites: ['south'] })).toEqual({ company: 'DEMO', site: null })
  })

  it('keeps at most MAX_PEOPLE people and survives a broken cookie', () => {
    let cookie: string | undefined
    for (let i = 0; i < MAX_PEOPLE + 3; i++) cookie = rememberScope(cookie, { tenantId: 't1', userId: `p${i}` }, { company: 'DEMO', site: null })
    expect(readScopeMemory(cookie)).toHaveLength(MAX_PEOPLE)
    expect(recallScope(cookie, { tenantId: 't1', userId: 'p0' }, { companies: ['DEMO'] })).toBeNull()
    expect(readScopeMemory('{not json')).toEqual([])
    expect(readScopeMemory(JSON.stringify([['t1:x', { company: 3 }], 'junk']))).toEqual([])
  })

  it('an office entry point opens the remembered company, else the session\'s, else the first allowed', () => {
    const cookie = rememberScope(undefined, anna, { company: 'ESEMPIO', site: null })
    expect(landingCompany(cookie, anna, 'DEMO', ['DEMO', 'ESEMPIO'])).toBe('ESEMPIO')
    expect(landingCompany(cookie, bruno, 'DEMO', ['DEMO', 'ESEMPIO'])).toBe('DEMO')
    expect(landingCompany(undefined, bruno, null, ['ESEMPIO'])).toBe('ESEMPIO')
    expect(landingCompany(undefined, bruno, null, [])).toBeNull()
  })
})

describe('switching company is a navigation (the company is in the address, PLT-161)', () => {
  it('keeps the page, drops a record id (a record belongs to one company)', () => {
    expect(companySwitchHref('ESEMPIO', '/admin/users')).toBe('/w/ESEMPIO/admin/users')
    expect(companySwitchHref('ESEMPIO', '/admin/users/0190f0e2-3333-7000-8000-000000000001')).toBe('/w/ESEMPIO/admin/users')
    expect(companySwitchHref('A B', '/')).toBe('/w/A%20B')
  })

  it('reads the company and the page from an office address', () => {
    expect(splitOfficePath('/w/DEMO/admin/users/')).toEqual({ company: 'DEMO', path: '/admin/users' })
    expect(splitOfficePath('/w/DEMO')).toEqual({ company: 'DEMO', path: '/' })
    expect(splitOfficePath('/l')).toEqual({ company: null, path: '/l' })
  })

  it('names the current company and site, and whether there is anything to switch', () => {
    const state = { companies: [{ id: '1', code: 'DEMO', name: 'Demo' }], company: 'DEMO', sites: [{ id: 's', name: 'North' }], site: 's', path: '/' }
    expect(currentCompany(state)?.name).toBe('Demo')
    expect(currentSite(state)?.name).toBe('North')
    expect(currentSite({ ...state, site: null })).toBeNull()
    expect(switcherHasChoices(state)).toEqual({ companies: false, sites: true })
  })
})
