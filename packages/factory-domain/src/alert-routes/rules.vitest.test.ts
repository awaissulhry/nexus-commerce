import { describe, expect, it } from 'vitest'
import { routeCovers, routedTo, routeInsideRule, routeKey, type AlertPlace, type RouteLike } from './rules'

/** Alert routing by place and role (B-W2b-435; ANA-041), pure. */

const place: AlertPlace = { companyId: 'cA', siteId: 'sA1', lineId: 'lA1', partyId: 'p1' }
const route = (scope: RouteLike['scope'], scopeId: string, who: { roleId?: string; userId?: string }): RouteLike => ({ scope, scopeId, roleId: who.roleId ?? null, userId: who.userId ?? null })

describe('which routes cover an alert', () => {
  it('a company, a site, a line, a customer', () => {
    expect(routeCovers(route('COMPANY', 'cA', { roleId: 'r' }), place)).toBe(true)
    expect(routeCovers(route('COMPANY', 'cB', { roleId: 'r' }), place)).toBe(false)
    expect(routeCovers(route('SITE', 'sA1', { roleId: 'r' }), place)).toBe(true)
    expect(routeCovers(route('LINE', 'lA2', { roleId: 'r' }), place)).toBe(false)
    expect(routeCovers(route('LINE', 'lA1', { roleId: 'r' }), place)).toBe(true)
    expect(routeCovers(route('CUSTOMER', 'p1', { roleId: 'r' }), place)).toBe(true)
    expect(routeCovers(route('LINE', 'lA1', { roleId: 'r' }), { ...place, lineId: null })).toBe(false)
  })

  it('goes to the covering routes only, else to the rule’s own role', () => {
    const routes = [route('SITE', 'sA1', { roleId: 'quality' }), route('LINE', 'lA1', { userId: 'mario' }), route('CUSTOMER', 'p9', { roleId: 'sales' }), route('SITE', 'sA2', { roleId: 'planner' })]
    expect(routedTo(routes, place, 'rule-role')).toEqual({ roles: ['quality'], users: ['mario'], routed: true })
    expect(routedTo(routes, { companyId: 'cA', siteId: 'sA3', lineId: null, partyId: null }, 'rule-role')).toEqual({ roles: ['rule-role'], users: [], routed: false })
    expect(routedTo([], place, null)).toEqual({ roles: [], users: [], routed: false })
  })
})

describe('a route never widens its rule (the database holds the same)', () => {
  it('a rule of every company takes any place; a company rule its places; a site rule its site, lines and customers', () => {
    expect(routeInsideRule({ companyId: null, siteId: null }, { scope: 'COMPANY', companyId: 'cB', siteId: null })).toBe(true)
    expect(routeInsideRule({ companyId: 'cA', siteId: null }, { scope: 'SITE', companyId: 'cA', siteId: 'sA1' })).toBe(true)
    expect(routeInsideRule({ companyId: 'cA', siteId: null }, { scope: 'SITE', companyId: 'cB', siteId: 'sB1' })).toBe(false)
    expect(routeInsideRule({ companyId: 'cA', siteId: 'sA1' }, { scope: 'COMPANY', companyId: 'cA', siteId: null })).toBe(false)
    expect(routeInsideRule({ companyId: 'cA', siteId: 'sA1' }, { scope: 'LINE', companyId: 'cA', siteId: 'sA1' })).toBe(true)
    expect(routeInsideRule({ companyId: 'cA', siteId: 'sA1' }, { scope: 'LINE', companyId: 'cA', siteId: 'sA2' })).toBe(false)
    expect(routeInsideRule({ companyId: 'cA', siteId: 'sA1' }, { scope: 'CUSTOMER', companyId: null, siteId: null })).toBe(true)
    expect(routeInsideRule({ companyId: 'cA', siteId: null }, { scope: 'CUSTOMER', companyId: 'cB', siteId: null })).toBe(false)
  })

  it('keys each recipient once per rule and place', () => {
    expect(routeKey('r1', 'SITE', 's1', { roleId: 'q' })).toBe('route:r1:SITE:s1:role:q')
    expect(routeKey('r1', 'LINE', 'l1', { userId: 'u' })).toBe('route:r1:LINE:l1:user:u')
  })
})
