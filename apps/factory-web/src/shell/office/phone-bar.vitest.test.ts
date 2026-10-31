import { describe, expect, it } from 'vitest'
import { bottomBarLayout } from '@nexus/ui/components/BottomBar/index'
import { permissionCheck } from '../../lib/session/session'
import { rolePermissions } from '../design-data'
import { officeNavFor } from '../nav/office-nav'
import { areaTabHref, lastPageOf, phoneNav } from './phone-bar'

const navOf = (role: Parameters<typeof rolePermissions>[0]) => officeNavFor(permissionCheck(rolePermissions(role)))
const tabsOf = (role: Parameters<typeof rolePermissions>[0]) => bottomBarLayout(phoneNav(navOf(role)), '/home/today').tabs.map((tab) => tab.id)

describe('the phone bottom bar: the person\'s 4 tabs and More (B-W2b-05, PLT-162)', () => {
  it('the Owner: Home, Sales, Warehouse, Production — every other area under More, in rail order', () => {
    expect(tabsOf('owner')).toEqual(['home', 'sales', 'warehouse', 'production'])
    const more = bottomBarLayout(phoneNav(navOf('owner')), '/home/today').more.map((entry) => entry.id)
    const rail = navOf('owner').areas.map((area) => area.id)
    expect(more).toEqual(rail.filter((id) => !['home', 'sales', 'warehouse', 'production'].includes(id)))
  })

  it('each role gets its own areas (the ones it opens the most of), drawn in rail order', () => {
    expect(tabsOf('warehouse')).toEqual(['home', 'products', 'purchasing', 'warehouse'])
    expect(tabsOf('sales')).toEqual(['home', 'sales', 'products', 'finance'])
    expect(tabsOf('floor_supervisor')).toEqual(['home', 'products', 'production', 'plant'])
    for (const role of ['owner', 'warehouse', 'sales', 'finance', 'quality_inspector'] as const) expect(tabsOf(role).length).toBeLessThanOrEqual(5)
  })

  it('no row takes a tab of its own (rows are reached through their area\'s Pages)', () => {
    const nav = phoneNav(navOf('owner'))
    expect(bottomBarLayout(nav, '/home/today').tabs.every((tab) => tab.kind === 'area')).toBe(true)
  })

  it('a tab opens the page used last in its area (its navigation row), while the person may still open it', () => {
    const nav = navOf('owner')
    expect(lastPageOf(nav, '/sales/orders/0190f0e2-3333-7000-8000-000000000002')).toEqual({ area: 'sales', page: '/sales/orders' })
    expect(lastPageOf(nav, '/nowhere')).toBeNull()
    expect(areaTabHref(nav, { sales: '/sales/orders' }, '/sales')).toBe('/sales/orders')
    // A page of another area, or one the person may no longer open, falls back to the area's own address.
    expect(areaTabHref(nav, { sales: '/warehouse/stock' }, '/sales')).toBe('/sales')
    expect(areaTabHref(officeNavFor(permissionCheck(['home.view'])), { sales: '/sales/orders' }, '/sales')).toBe('/sales')
    expect(areaTabHref(nav, {}, '/sales')).toBe('/sales')
  })
})
