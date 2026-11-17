import { describe, expect, it } from 'vitest'
import { EVERY_PARTY_WORDS, NO_ROWS, type Actor, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { allPartsWhere, assertEveryParty, everyPartyActor, everyPartySites, reachesWorkOrder, viaCell, viaWorkOrder, workOrderWhere } from './scope'

/*
 * B-PR-03 (production plan §2, the brand wall): which work orders an office person reaches, by customer too. Pure: the
 * where shapes and answers of ./scope. Every id is made up.
 */

const VIEW: Permission = 'workorders.view'
const T = 'tenant-1'
const C = 'company-1'
const S = 'site-1'
const P1 = 'party-1'
const P2 = 'party-2'
const grant = (parties: Grant['parties'], permissions: Permission[] = [VIEW]): Grant => ({ permissions, companies: [C], sites: 'all', parties })
const office = (...grants: Grant[]): Actor => ({ audience: 'office', tenantId: T, grants })
const all = office(grant('all'))
const onlyP2 = office(grant([P2]))
const none = office(grant('all', ['planning.view']))

describe('the work orders a person reaches (B-PR-03)', () => {
  it('lists by company, site and customer: a person of every customer has no customer clause, a limited one only its list', () => {
    expect(workOrderWhere(all, VIEW)).toEqual({ companyId: { in: [C] } })
    // B-PR-09: the customer clause is null-safe (a work order of no customer never slips through a negation such as `every`).
    expect(workOrderWhere(onlyP2, VIEW)).toEqual({ AND: [{ companyId: { in: [C] } }, { partyId: { in: [P2], not: null } }] })
    expect(workOrderWhere(none, VIEW)).toBe(NO_ROWS)
  })

  it('reaches a row of a work order, a cell, and an object of several work orders through the same wall', () => {
    expect(viaWorkOrder(onlyP2, VIEW)).toEqual({ workOrder: { is: workOrderWhere(onlyP2, VIEW) } })
    expect(viaWorkOrder(onlyP2, VIEW, 'parentWorkOrder')).toEqual({ parentWorkOrder: { is: workOrderWhere(onlyP2, VIEW) } })
    expect(viaCell(onlyP2, VIEW)).toEqual({ workOrderSize: { is: { workOrder: { is: workOrderWhere(onlyP2, VIEW) } } } })
    // A shared object (a cut order's lines): every part reached, or nothing to filter for a person of every work order.
    expect(allPartsWhere(onlyP2, VIEW, 'lines')).toEqual({ lines: { every: viaCell(onlyP2, VIEW) } })
    expect(allPartsWhere(onlyP2, VIEW, 'workOrders', (actor, permission) => workOrderWhere(actor, permission))).toEqual({ workOrders: { every: workOrderWhere(onlyP2, VIEW) } })
    expect(allPartsWhere(office(grant([P1, P2], [VIEW]), { permissions: [VIEW], companies: 'all', sites: 'all', parties: 'all' }), VIEW, 'lines')).toEqual({})
    expect(allPartsWhere(none, VIEW, 'lines')).toBe(NO_ROWS)
  })

  it('a work order of a customer reaches its customer’s people; one of no customer only people of every customer', () => {
    const of = (partyId: string | null) => ({ companyId: C, siteId: S, partyId })
    expect(reachesWorkOrder(onlyP2, VIEW, of(P2))).toBe(true)
    expect(reachesWorkOrder(onlyP2, VIEW, of(P1))).toBe(false)
    expect(reachesWorkOrder(onlyP2, VIEW, of(null))).toBe(false)
    expect(reachesWorkOrder(all, VIEW, of(P1))).toBe(true)
    expect(reachesWorkOrder(all, VIEW, of(null))).toBe(true)
    expect(reachesWorkOrder(all, VIEW, { ...of(P1), companyId: 'company-2' })).toBe(false)
    // A long list is not every customer (tomorrow's customer is not on it).
    expect(reachesWorkOrder(office(grant([P1, P2])), VIEW, of(null))).toBe(false)
  })

  it('a view that mixes customers: refused in words that name none, unless every customer is reached', () => {
    expect(() => assertEveryParty(onlyP2, VIEW)).toThrow(EVERY_PARTY_WORDS.en)
    expect(() => assertEveryParty(all, VIEW, { companyId: C, siteId: S })).not.toThrow()
    expect(() => assertEveryParty(all, VIEW, { companyId: 'company-2' })).toThrow(EVERY_PARTY_WORDS.en)
  })
})

// ── B-PR-07 ──
describe('a view that mixes customers over several sites (B-PR-07)', () => {
  const S2 = 'site-2'
  const at = (sites: Grant['sites'], parties: Grant['parties']): Grant => ({ permissions: [VIEW], companies: [C], sites, parties })
  // Every customer at site 1, one customer at site 2.
  const split = office(at([S], 'all'), at([S2], [P2]))
  const sites = [{ companyId: C, id: S }, { companyId: C, id: S2 }]

  it('keeps the sites where every customer is reached; none left of some is refused in words that name none', () => {
    expect(everyPartySites(all, VIEW, sites).map((site) => site.id)).toEqual([S, S2])
    expect(everyPartySites(split, VIEW, sites).map((site) => site.id)).toEqual([S])
    expect(() => everyPartySites(onlyP2, VIEW, sites)).toThrow(EVERY_PARTY_WORDS.en)
    expect(everyPartySites(onlyP2, VIEW, [])).toEqual([])
  })

  it('a read that names no site counts only the grants of every customer', () => {
    expect(everyPartyActor(split, VIEW).grants).toEqual([at([S], 'all')])
    expect(everyPartyActor(all, VIEW)).toEqual(all)
    expect(() => everyPartyActor(onlyP2, VIEW)).toThrow(EVERY_PARTY_WORDS.en)
  })
})
