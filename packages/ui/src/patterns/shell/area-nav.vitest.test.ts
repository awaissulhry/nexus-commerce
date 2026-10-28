/**
 * The area-navigation manifest: who sees what (office open, floor and portal closed), the one row a path belongs to,
 * and the two DS parts it feeds — the rail's rows and the sub-sidebar's groups.
 */
import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { FileText, Handshake, Home, Receipt, ScanLine, Scissors, Settings, ShoppingCart, Users } from 'lucide-react'
import {
  AREA_NAV_VIEWS,
  areaNavForPerson,
  areaRailItems,
  areaSubNavGroups,
  findAreaNavPlace,
  type AreaNav,
  type AreaNavArea,
} from './area-nav'

const SALES: AreaNavArea = {
  id: 'sales',
  label: 'Sales',
  href: '/sales',
  icon: Handshake,
  permission: 'sales.view',
  badge: 'quotesToApprove',
  phone: 'tab',
  sections: [
    {
      id: 'top',
      label: 'Sales',
      hideLabel: true,
      items: [
        { id: 'overview', label: 'Overview', href: '/sales', icon: Home, exact: true },
        { id: 'customers', label: 'Customers', href: '/sales/customers', icon: Users, permission: 'customers.view' },
        { id: 'quotes', label: 'Quotes', href: '/sales/quotes', icon: FileText, permission: 'quotes.view', badge: 'quotesToApprove' },
        {
          id: 'orders',
          label: 'Orders',
          href: '/sales/orders',
          icon: ShoppingCart,
          permission: 'orders.view',
          childrenLabel: 'views',
          children: [
            { id: 'orders-board', label: 'Board', ariaLabel: 'Orders board', href: '/sales/orders/board' },
            { id: 'orders-changes', label: 'Changes', href: '/sales/orders/changes', permission: 'orders.change' },
          ],
        },
      ],
    },
    {
      id: 'after-sales',
      label: 'After-sales',
      collapsible: true,
      items: [{ id: 'returns', label: 'Returns', href: '/sales/returns', icon: Receipt, permission: 'returns.view', match: ['/sales/repairs'] }],
    },
  ],
}

const OFFICE: AreaNav = {
  view: 'office',
  areas: [
    { id: 'home', label: 'Home', href: '/home', icon: Home, badge: 'approvals' },
    SALES,
    {
      id: 'admin',
      label: 'Admin',
      href: '/admin',
      icon: Settings,
      permission: 'admin',
      sections: [{ id: 'access', label: 'Access', items: [{ id: 'users', label: 'Users', href: '/admin/users', permission: 'users.manage' }] }],
    },
  ],
}

const PORTAL: AreaNav = {
  view: 'portal',
  areas: [
    { id: 'p-home', label: 'Home', href: '/portal/home', icon: Home },
    { id: 'p-orders', label: 'Orders', href: '/portal/orders', icon: ShoppingCart, permission: 'portal.orders', kinds: ['customer'] },
    { id: 'p-pos', label: 'Purchase orders', href: '/portal/purchase-orders', icon: FileText, permission: 'portal.pos', kinds: ['supplier'] },
  ],
}

const FLOOR: AreaNav = {
  view: 'floor',
  areas: [
    { id: 'cutting', label: 'Cutting', href: '/floor/cutting', icon: Scissors, permission: 'floor.cut', kinds: ['cutting-table'] },
    { id: 'scan', label: 'Scan', href: '/floor/scan', icon: ScanLine, permission: 'floor.scan' },
  ],
}

const holds = (...permissions: string[]) => (permission: string) => permissions.includes(permission)
const ids = (nav: AreaNav) => nav.areas.map((area) => area.id)
const rowIds = (area: AreaNavArea | undefined) =>
  (area?.sections ?? []).map((section) => [section.id, section.items.map((item) => [item.id, ...(item.children ?? []).map((child) => child.id)])])

describe('the four views', () => {
  it('office, floor, portal and links', () => {
    expect(AREA_NAV_VIEWS).toEqual(['office', 'floor', 'portal', 'links'])
  })
})

describe('areaNavForPerson — office shows an unmapped row, floor and portal fail closed', () => {
  it('office: a row without a permission is shown; an area or row the person lacks is not', () => {
    const nav = areaNavForPerson(OFFICE, { can: holds('sales.view', 'quotes.view', 'orders.view') })
    expect(ids(nav)).toEqual(['home', 'sales'])
    expect(rowIds(nav.areas[1])).toEqual([['top', [['overview'], ['quotes'], ['orders', 'orders-board']]]])
  })

  it('drops a section left empty, and an area that had pages and kept none', () => {
    expect(ids(areaNavForPerson(OFFICE, { can: holds('admin') }))).toEqual(['home'])
    const nav = areaNavForPerson(OFFICE, { can: holds('sales.view', 'returns.view') })
    expect(rowIds(nav.areas[1])).toEqual([['top', [['overview']]], ['after-sales', [['returns']]]])
  })

  it('drops a row under a row the person may not see, and the children key when none is left', () => {
    const nav = areaNavForPerson({ view: 'portal', areas: [{ ...SALES, sections: [{ id: 's', label: 'S', items: [{ id: 'o', label: 'O', href: '/o', permission: 'o', children: [{ id: 'c', label: 'C', href: '/o/c' }] }] }] }] }, { can: () => true })
    expect(nav.areas[0].sections?.[0].items[0]).not.toHaveProperty('children')
  })

  it('portal: a row with no permission is hidden even from someone who holds everything', () => {
    expect(ids(areaNavForPerson(PORTAL, { can: () => true, kind: 'customer' }))).toEqual(['p-orders'])
    expect(ids(areaNavForPerson(PORTAL, { can: () => true, kind: 'supplier' }))).toEqual(['p-pos'])
  })

  it('a row limited to kinds is hidden when the kind is not given or not listed', () => {
    expect(ids(areaNavForPerson(PORTAL, { can: () => true }))).toEqual([])
    expect(ids(areaNavForPerson(FLOOR, { can: () => true, kind: 'sewing' }))).toEqual(['scan'])
    expect(ids(areaNavForPerson(FLOOR, { can: holds('floor.cut'), kind: 'cutting-table' }))).toEqual(['cutting'])
  })

  it('links has no navigation', () => {
    expect(areaNavForPerson({ view: 'links', areas: [] }, { can: () => true }).areas).toEqual([])
  })

  it('never changes the manifest it reads', () => {
    const before = JSON.stringify(OFFICE)
    areaNavForPerson(OFFICE, { can: () => false })
    expect(JSON.stringify(OFFICE)).toBe(before)
  })
})

describe('findAreaNavPlace — the one area and row a path belongs to', () => {
  const at = (path: string) => {
    const place = findAreaNavPlace(OFFICE, path)
    return place && { area: place.area.id, section: place.section?.id, item: place.item?.id, parent: place.parent?.id }
  }

  it('the longest address wins: a record stays on its page', () => {
    expect(at('/sales/quotes')).toEqual({ area: 'sales', section: 'top', item: 'quotes', parent: undefined })
    expect(at('/sales/quotes/Q-104')).toEqual({ area: 'sales', section: 'top', item: 'quotes', parent: undefined })
  })

  it('an exact row owns its own page only; a page under it with no row stays in the area', () => {
    expect(at('/sales')).toEqual({ area: 'sales', section: 'top', item: 'overview', parent: undefined })
    expect(at('/sales/unknown')).toEqual({ area: 'sales', section: undefined, item: undefined, parent: undefined })
  })

  it('a row under a row wins over its parent; `match` addresses count', () => {
    expect(at('/sales/orders/board')).toEqual({ area: 'sales', section: 'top', item: 'orders-board', parent: 'orders' })
    expect(at('/sales/orders/SO-9')).toEqual({ area: 'sales', section: 'top', item: 'orders', parent: undefined })
    expect(at('/sales/repairs/R-1')).toEqual({ area: 'sales', section: 'after-sales', item: 'returns', parent: undefined })
  })

  it('ignores query, hash and a trailing slash; needs a segment boundary', () => {
    expect(at('/sales/quotes/?tab=open#x')).toMatchObject({ item: 'quotes' })
    expect(at('/salesforce')).toBeNull()
    expect(at('/elsewhere')).toBeNull()
  })
})

describe('the DS parts it feeds', () => {
  it('areaRailItems: one rail row per area, its icon and its count', () => {
    const counts: Record<string, number> = { approvals: 3, quotesToApprove: 0 }
    expect(areaRailItems(OFFICE, (key) => counts[key])).toEqual([
      { label: 'Home', href: '/home', Icon: Home, badge: 3 },
      { label: 'Sales', href: '/sales', Icon: Handshake, badge: 0 },
      { label: 'Admin', href: '/admin', Icon: Settings },
    ])
    expect(areaRailItems(OFFICE)[0]).not.toHaveProperty('badge')
  })

  it('areaSubNavGroups: the sub-sidebar groups, exactly one current row, scoped links, counts and child rows', () => {
    const groups = areaSubNavGroups(SALES, {
      path: '/sales/orders/board',
      href: (address) => `/w/acme${address}`,
      count: (key) => (key === 'quotesToApprove' ? 1250 : undefined),
    })
    expect(groups.map((group) => [group.id, group.label, group.collapsible ?? false, group.hideLabel ?? false])).toEqual([
      ['top', 'Sales', false, true],
      ['after-sales', 'After-sales', true, false],
    ])
    const rows = groups.flatMap((group) => group.items.flatMap((item) => [item, ...(item.children ?? [])]))
    expect(rows.filter((row) => row.active).map((row) => row.id)).toEqual(['orders-board'])
    const quotes = rows.find((row) => row.id === 'quotes')
    expect(quotes).toMatchObject({ href: '/w/acme/sales/quotes', badge: '1,250' })
    expect(isValidElement(quotes?.icon)).toBe(true)
    const orders = rows.find((row) => row.id === 'orders')
    expect(orders).toMatchObject({ childrenLabel: 'views' })
    expect(orders?.children?.[0]).toMatchObject({ label: 'Board', ariaLabel: 'Orders board', href: '/w/acme/sales/orders/board' })
    expect(orders?.children?.[0]).not.toHaveProperty('icon')
    expect(rows.find((row) => row.id === 'customers')).not.toHaveProperty('badge')
  })

  it('an area with no sections has no sub-sidebar', () => {
    expect(areaSubNavGroups(OFFICE.areas[0], { path: '/home' })).toEqual([])
  })
})
