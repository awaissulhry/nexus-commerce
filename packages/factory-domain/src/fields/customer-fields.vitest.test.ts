import { describe, expect, it } from 'vitest'
import type { Actor, Grant } from '../core/permissions'
import { codesOf, CUSTOMER_FIELD_RECORD_KEYS, EVERY_CUSTOMER_NOTICE, fieldOnRecord, fieldPartySeenBy, optionsInUse, portalNoticeOf } from './access'

// B-TH-056 (threads plan TH-4, WALL-G08; wall T17): a field for one customer is that customer's only.
const TENANT = '0190a000-0000-7000-8000-000000000001'
const COMPANY = '0190a000-0000-7000-8000-0000000000c1'
const ALPHA = '0190a000-0000-7000-8000-0000000000a1'
const BETA = '0190a000-0000-7000-8000-0000000000b2'
const grant = (parties: 'all' | string[]): Grant => ({ permissions: ['orders.view'], companies: 'all', sites: 'all', parties })
const office = (parties: 'all' | string[]): Actor => ({ audience: 'office', tenantId: TENANT, grants: [grant(parties)] })
const partner = (partyId: string): Actor => ({ audience: 'partner', tenantId: TENANT, partyId, grants: [grant([partyId])] })
const system: Actor = { audience: 'system', tenantId: TENANT, grants: [] }
const betaField = { partyId: BETA, companyId: COMPANY }
const everyField = { partyId: null, companyId: COMPANY }

describe('a field for one customer', () => {
  it('is seen by that customer, the office people who reach it and the system; never by another customer or a sales rep limited to another', () => {
    expect(fieldPartySeenBy(partner(BETA), betaField, 'orders.view')).toBe(true)
    expect(fieldPartySeenBy(partner(ALPHA), betaField, 'orders.view')).toBe(false)
    expect(fieldPartySeenBy(office('all'), betaField, 'orders.view')).toBe(true)
    expect(fieldPartySeenBy(office([BETA]), betaField, 'orders.view')).toBe(true)
    expect(fieldPartySeenBy(office([ALPHA]), betaField, 'orders.view')).toBe(false)
    expect(fieldPartySeenBy(office('all'), betaField, 'quotes.view')).toBe(false)
    expect(fieldPartySeenBy(system, betaField, 'orders.view')).toBe(true)
    expect(fieldPartySeenBy({ audience: 'floor', tenantId: TENANT, siteId: COMPANY, grants: [grant('all')] }, betaField, 'orders.view')).toBe(false)
  })

  it('a field for every customer: everyone who sees fields', () => {
    for (const actor of [partner(ALPHA), partner(BETA), office([ALPHA]), system]) expect(fieldPartySeenBy(actor, everyField, 'orders.view')).toBe(true)
  })

  it('is on that customer’s records only, never on a record of no customer', () => {
    expect(fieldOnRecord(betaField, BETA)).toBe(true)
    expect(fieldOnRecord(betaField, ALPHA)).toBe(false)
    expect(fieldOnRecord(betaField, null)).toBe(false)
    expect(fieldOnRecord(everyField, ALPHA)).toBe(true)
    expect(fieldOnRecord(everyField, null)).toBe(true)
  })

  it('goes on customers, quotes and orders only', () => {
    expect([...CUSTOMER_FIELD_RECORD_KEYS]).toEqual(['CUSTOMER', 'QUOTE', 'ORDER'])
  })

  it('the admin preview warns only for a field of every customer shown in the portal', () => {
    expect(portalNoticeOf({ partyId: null, shownInPortal: true })).toBe('EVERY_CUSTOMER')
    expect(portalNoticeOf({ partyId: BETA, shownInPortal: true })).toBeNull()
    expect(portalNoticeOf({ partyId: null, shownInPortal: false })).toBeNull()
    expect(EVERY_CUSTOMER_NOTICE.en).toBe('Every customer will see this column name in its portal.')
    expect(EVERY_CUSTOMER_NOTICE.it.length).toBeGreaterThan(10)
  })

  it('a customer is shown only the list values its record uses', () => {
    const options = [{ code: 'RED' }, { code: 'BETA_LINING' }, { code: 'BLUE' }]
    expect(optionsInUse(options, new Set(codesOf('RED')))).toEqual([{ code: 'RED' }])
    expect(optionsInUse(options, new Set(codesOf(['BLUE', 'RED'])))).toEqual([{ code: 'RED' }, { code: 'BLUE' }])
    expect(optionsInUse(options, new Set(codesOf(null)))).toEqual([])
    expect(codesOf({ amount: 1 })).toEqual([])
  })
})
