import { describe, expect, it } from 'vitest'
import {
  can,
  decide,
  holds,
  isPermission,
  NO_ROWS,
  scopeWhere,
  type Actor,
  type Grant,
  type ScopeColumns,
} from './permissions'

const TENANT = '0190f5c2-0000-7000-8000-000000000001'
const OTHER_TENANT = '0190f5c2-0000-7000-8000-000000000002'
const COMPANY_A = '0190f5c2-0000-7000-8000-00000000000a'
const COMPANY_B = '0190f5c2-0000-7000-8000-00000000000b'
const SITE_1 = '0190f5c2-0000-7000-8000-000000000101'
const SITE_2 = '0190f5c2-0000-7000-8000-000000000102'
const PARTY_X = '0190f5c2-0000-7000-8000-000000000201'
const PARTY_Y = '0190f5c2-0000-7000-8000-000000000202'

const grant = (permissions: Grant['permissions'], scope: Partial<Omit<Grant, 'permissions'>> = {}): Grant => ({
  permissions,
  companies: 'all',
  sites: 'all',
  parties: 'all',
  ...scope,
})
const office = (...grants: Grant[]): Actor => ({ audience: 'office', tenantId: TENANT, grants })

const QUOTES: ScopeColumns = { company: 'companyId', party: 'partyId' }
const LOTS: ScopeColumns = { company: 'companyId', site: 'siteId' }
const ITEMS: ScopeColumns = { company: { field: 'companyId', nullable: true } }

describe('permission names', () => {
  it('are <module>.<action>', () => {
    expect(isPermission('quotes.send')).toBe(true)
    expect(isPermission('workOrders.release')).toBe(true)
    expect(isPermission('platform.tenants.create')).toBe(true)
    for (const bad of ['quotes', 'Quotes.send', 'quotes.', '.send', 'quotes.*', '*', 'quotes send', '']) {
      expect(isPermission(bad)).toBe(false)
    }
  })
})

describe('can()', () => {
  it('needs the permission', () => {
    const actor = office(grant(['quotes.view']))
    expect(can(actor, 'quotes.view')).toBe(true)
    expect(decide(actor, 'quotes.send')).toEqual({ allowed: false, reason: 'no_permission' })
  })

  it('has no wildcard: a permission is named exactly', () => {
    expect(can(office(grant(['quotes.*' as never])), 'quotes.send')).toBe(false)
  })

  it('needs a grant that reaches the record company', () => {
    const actor = office(grant(['quotes.send'], { companies: [COMPANY_A] }))
    expect(can(actor, 'quotes.send', { companyId: COMPANY_A })).toBe(true)
    expect(decide(actor, 'quotes.send', { companyId: COMPANY_B })).toEqual({ allowed: false, reason: 'company' })
  })

  it('takes the permission and the scope from the same grant', () => {
    // send for A, view for B: not send for B.
    const actor = office(grant(['quotes.send'], { companies: [COMPANY_A] }), grant(['quotes.view'], { companies: [COMPANY_B] }))
    expect(can(actor, 'quotes.send', { companyId: COMPANY_B })).toBe(false)
    expect(can(actor, 'quotes.view', { companyId: COMPANY_B })).toBe(true)
  })

  it('checks site and party scopes', () => {
    const actor = office(grant(['lots.release'], { sites: [SITE_1], parties: [PARTY_X] }))
    expect(can(actor, 'lots.release', { siteId: SITE_1 })).toBe(true)
    expect(decide(actor, 'lots.release', { siteId: SITE_2 })).toEqual({ allowed: false, reason: 'site' })
    expect(decide(actor, 'lots.release', { partyId: PARTY_Y })).toEqual({ allowed: false, reason: 'party' })
  })

  it('reaches nothing with an empty scope list', () => {
    expect(can(office(grant(['quotes.send'], { companies: [] })), 'quotes.send', { companyId: COMPANY_A })).toBe(false)
  })

  it('lets tenant-wide master data (no company) through the company scope', () => {
    expect(can(office(grant(['items.view'], { companies: [COMPANY_A] })), 'items.view', { companyId: null })).toBe(true)
  })

  it('refuses a record of another tenant', () => {
    expect(decide(office(grant(['quotes.view'])), 'quotes.view', { tenantId: OTHER_TENANT })).toEqual({
      allowed: false,
      reason: 'tenant',
    })
    expect(can(office(grant(['quotes.view'])), 'quotes.view', { tenantId: TENANT })).toBe(true)
  })

  it('asks the state machine last', () => {
    const actor = office(grant(['quotes.send']))
    expect(decide(actor, 'quotes.send', {}, { stateAllows: false })).toEqual({ allowed: false, reason: 'state' })
    expect(can(actor, 'quotes.send', {}, { stateAllows: true })).toBe(true)
  })

  it('binds a floor session to its site, whatever the grant says', () => {
    const actor: Actor = { audience: 'floor', tenantId: TENANT, siteId: SITE_1, grants: [grant(['scans.record'])] }
    expect(can(actor, 'scans.record', { siteId: SITE_1 })).toBe(true)
    expect(decide(actor, 'scans.record', { siteId: SITE_2 })).toEqual({ allowed: false, reason: 'site' })
  })

  it('binds a partner or link session to its party; a record without a party is refused', () => {
    for (const audience of ['partner', 'link'] as const) {
      const actor: Actor = { audience, tenantId: TENANT, partyId: PARTY_X, grants: [grant(['quotes.view'])] }
      expect(can(actor, 'quotes.view', { partyId: PARTY_X })).toBe(true)
      expect(decide(actor, 'quotes.view', { partyId: PARTY_Y })).toEqual({ allowed: false, reason: 'party' })
      expect(decide(actor, 'quotes.view', {})).toEqual({ allowed: false, reason: 'party' })
    }
  })

  it('refuses a session that lacks what its audience needs', () => {
    const view = [grant(['quotes.view'])]
    expect(decide({ audience: 'office', grants: view }, 'quotes.view')).toEqual({ allowed: false, reason: 'audience' })
    expect(decide({ audience: 'floor', tenantId: TENANT, grants: view }, 'quotes.view').allowed).toBe(false)
    expect(decide({ audience: 'partner', tenantId: TENANT, grants: view }, 'quotes.view').allowed).toBe(false)
    expect(decide({ audience: 'nobody' as never, tenantId: TENANT, grants: view }, 'quotes.view').allowed).toBe(false)
  })

  it('keeps the platform audience off tenant records', () => {
    const actor: Actor = { audience: 'platform', grants: [grant(['platform.tenants.view'])] }
    expect(can(actor, 'platform.tenants.view')).toBe(true)
    expect(decide(actor, 'platform.tenants.view', { tenantId: TENANT })).toEqual({ allowed: false, reason: 'tenant' })
  })

  it('holds() answers "in any scope"', () => {
    expect(holds(office(grant(['quotes.send'], { companies: [] })), 'quotes.send')).toBe(true)
    expect(holds(office(grant(['quotes.view'])), 'quotes.send')).toBe(false)
  })
})

describe('scopeWhere()', () => {
  it('matches no row without the permission', () => {
    expect(scopeWhere(office(grant(['quotes.view'])), 'quotes.send', QUOTES)).toBe(NO_ROWS)
    expect(scopeWhere(office(), 'quotes.view', QUOTES)).toBe(NO_ROWS)
    expect(NO_ROWS).toEqual({ id: { in: [] } })
  })

  it('adds no filter when a grant reaches every row', () => {
    expect(scopeWhere(office(grant(['quotes.view'])), 'quotes.view', QUOTES)).toEqual({})
    expect(scopeWhere(office(grant(['quotes.view'], { companies: [COMPANY_A] }), grant(['quotes.view'])), 'quotes.view', QUOTES)).toEqual({})
  })

  it('filters by the companies a grant reaches', () => {
    expect(scopeWhere(office(grant(['quotes.view'], { companies: [COMPANY_B, COMPANY_A, COMPANY_A] })), 'quotes.view', QUOTES)).toEqual({
      companyId: { in: [COMPANY_A, COMPANY_B] },
    })
  })

  it('ORs the grants and ANDs the scopes inside one grant', () => {
    const actor = office(
      grant(['lots.view'], { companies: [COMPANY_A], sites: [SITE_1] }),
      grant(['lots.view'], { companies: [COMPANY_B] }),
    )
    expect(scopeWhere(actor, 'lots.view', LOTS)).toEqual({
      OR: [{ AND: [{ companyId: { in: [COMPANY_A] } }, { siteId: { in: [SITE_1] } }] }, { companyId: { in: [COMPANY_B] } }],
    })
  })

  it('ignores a scope the model has no column for', () => {
    expect(scopeWhere(office(grant(['quotes.view'], { sites: [SITE_1] })), 'quotes.view', QUOTES)).toEqual({})
  })

  it('skips a grant with an empty list, and matches no row when none is left', () => {
    expect(scopeWhere(office(grant(['quotes.view'], { companies: [] })), 'quotes.view', QUOTES)).toBe(NO_ROWS)
    expect(scopeWhere(office(grant(['quotes.view'], { companies: [] }), grant(['quotes.view'], { companies: [COMPANY_A] })), 'quotes.view', QUOTES)).toEqual({
      companyId: { in: [COMPANY_A] },
    })
  })

  it('keeps tenant-wide rows of a nullable column', () => {
    expect(scopeWhere(office(grant(['items.view'], { companies: [COMPANY_A] })), 'items.view', ITEMS)).toEqual({
      OR: [{ companyId: { in: [COMPANY_A] } }, { companyId: null }],
    })
    expect(scopeWhere(office(grant(['items.view'], { companies: [] })), 'items.view', ITEMS)).toEqual({ companyId: null })
  })

  it('pins a floor session to its site', () => {
    const actor: Actor = { audience: 'floor', tenantId: TENANT, siteId: SITE_1, grants: [grant(['lots.view'], { companies: [COMPANY_A] })] }
    expect(scopeWhere(actor, 'lots.view', LOTS)).toEqual({ AND: [{ siteId: SITE_1 }, { companyId: { in: [COMPANY_A] } }] })
  })

  it('pins a partner session to its party, and refuses a model without a party column', () => {
    const actor: Actor = { audience: 'partner', tenantId: TENANT, partyId: PARTY_X, grants: [grant(['quotes.view'])] }
    expect(scopeWhere(actor, 'quotes.view', QUOTES)).toEqual({ partyId: PARTY_X })
    expect(scopeWhere(actor, 'quotes.view', LOTS)).toBe(NO_ROWS)
  })

  it('agrees with can() on every record of a small grid', () => {
    const actor = office(
      grant(['lots.view'], { companies: [COMPANY_A], sites: [SITE_1] }),
      grant(['lots.view'], { companies: [COMPANY_B], sites: 'all' }),
    )
    const where = scopeWhere(actor, 'lots.view', LOTS)
    const matches = (clause: Record<string, unknown>, row: Record<string, string>): boolean =>
      Object.entries(clause).every(([key, value]) => {
        if (key === 'AND') return (value as Record<string, unknown>[]).every((part) => matches(part, row))
        if (key === 'OR') return (value as Record<string, unknown>[]).some((part) => matches(part, row))
        if (value !== null && typeof value === 'object' && 'in' in value) return (value.in as string[]).includes(row[key]!)
        return row[key] === value
      })
    for (const companyId of [COMPANY_A, COMPANY_B]) {
      for (const siteId of [SITE_1, SITE_2]) {
        expect(matches(where, { companyId, siteId })).toBe(can(actor, 'lots.view', { companyId, siteId }))
      }
    }
  })
})
