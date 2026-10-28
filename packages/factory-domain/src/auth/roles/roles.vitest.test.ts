import { describe, expect, it } from 'vitest'
import type { Actor, Permission } from '../../core/permissions'
import { can, scopeWhere } from '../../core/permissions'
import { GRAINS, heldGrains, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS } from '../permissions/catalogue'
import { definePermissions, permissionRegistry } from '../permissions/registry'
import {
  contentChange,
  customKeyProblems,
  grantOf,
  isAdminAssignment,
  isLive,
  mfaRequiredFor,
  normalizeContent,
  roleProblems,
  scopeProblems,
  sessionGrants,
  templateAdds,
  uncoveredScope,
  widens,
  type AssignmentScope,
} from './roles'
import { ROLE_TEMPLATES, templateOf, templateProblems } from './templates'

const A = '0195f5d0-0000-7000-8000-00000000000a'
const B = '0195f5d0-0000-7000-8000-00000000000b'
const SITE = '0195f5d0-0000-7000-8000-0000000000c1'
const everywhere: AssignmentScope = { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }
const onlyA: AssignmentScope = { allCompanies: false, companyIds: [A], siteIds: [], partyIds: [] }
const office = (grants: Actor['grants']): Actor => ({ audience: 'office', tenantId: '0195f5d0-0000-7000-8000-0000000000ff', grants })

describe('the permission registry', () => {
  it('declares every permission once, with an area, a description and a risk', () => {
    const names = FACTORY_PERMISSIONS.all.map((definition) => definition.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(['users.invite', 'roles.assign', 'audit.read', 'numbering.manage', 'money.cost']))
    for (const definition of FACTORY_PERMISSIONS.all) {
      expect(definition.name.startsWith(`${definition.area}.`)).toBe(true)
      expect(definition.description.length).toBeGreaterThan(10)
    }
    expect(FACTORY_PERMISSIONS.get('roles.assign')?.risk).toBe('stepUp')
    expect(FACTORY_PERMISSIONS.assignable.some((definition) => definition.area === 'money')).toBe(false)
    expect(FACTORY_PERMISSIONS.undeclared(['users.view', 'quotes.send', 'quotes.send'])).toEqual(['quotes.send'])
    expect([...FACTORY_PERMISSIONS.byArea().keys()]).toEqual(['users', 'roles', 'audit', 'numbering', 'files', 'links', 'devices', 'workers', 'floor', 'threads', 'email', 'money'])
  })

  it('refuses a name declared twice, a bad area, a bad risk, an empty description', () => {
    const view = definePermissions('lots', { view: { risk: 'read', description: 'See lots.' } })
    expect(() => permissionRegistry([view, view])).toThrow(/declared twice/)
    expect(() => definePermissions('Lots', { view: { risk: 'read', description: 'x' } })).toThrow(/not an area/)
    expect(() => definePermissions('lots', { view: { risk: 'maybe' as never, description: 'x' } })).toThrow(/unknown risk/)
    expect(() => definePermissions('lots', { view: { risk: 'read', description: ' ' } })).toThrow(/description/)
  })
})

describe('role templates', () => {
  it('are valid: declared permissions, grains apart, two-factor for cost and margin, an owner', () => {
    expect(templateProblems(ROLE_TEMPLATES)).toEqual([])
    expect(ROLE_TEMPLATES.map((entry) => entry.key)).toEqual([
      'owner', 'admin', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor', 'read_only',
      'operator', 'cutting_operator', 'floor_inspector', 'team_leader',
    ])
    // The owner holds every office permission; the floor's are held only by floor roles.
    expect(templateOf('owner')?.permissions).toEqual(
      FACTORY_PERMISSIONS.assignable.filter((definition) => definition.area !== 'floor').map((definition) => definition.name).sort(),
    )
    expect(templateOf('owner')?.grains).toEqual([...GRAINS])
    expect(templateOf('read_only')?.permissions.every((name) => FACTORY_PERMISSIONS.get(name)?.risk === 'read')).toBe(true)
    expect(templateOf('admin')?.requireMfa).toBe(true)
    expect(templateOf('sales')?.grains).toEqual(['price'])
  })

  it('finds a template naming an unknown permission, a grain as a permission, or cost without two-factor', () => {
    const owner = templateOf('owner')!
    expect(templateProblems([{ ...owner, permissions: ['quotes.send'] }])).toEqual(['owner: quotes.send is not declared'])
    expect(templateProblems([{ ...owner, permissions: ['money.cost'] }])).toEqual(['owner: money.cost is a grain; list it in grains'])
    expect(templateProblems([{ ...owner, requireMfa: false }])).toEqual(['owner: a role that sees cost and margin requires two-factor'])
    expect(templateProblems([{ ...owner, key: 'sales' }])).toEqual(['the owner template is missing'])
  })
})

describe('custom roles', () => {
  it('checks the content and the key', () => {
    expect(roleProblems({ name: 'Night lead', requireMfa: false, permissions: ['users.view'], grains: ['price'] })).toEqual([])
    expect(roleProblems({ name: '', requireMfa: false, permissions: ['quotes.send', 'money.price'], grains: ['salary' as never, 'cost'] })).toEqual([
      { path: 'name', message: 'Expected 1 to 100 characters.' },
      { path: 'permissions/0', message: 'quotes.send is not a permission of the factory.' },
      { path: 'permissions/1', message: 'money.price is a money grain: list it in grains.' },
      { path: 'grains/0', message: 'salary is not a money grain (price, cost, margin, wages).' },
      { path: 'requireMfa', message: 'A role that sees cost requires two-factor.' },
    ])
    expect(customKeyProblems('night_lead')).toEqual([])
    expect(customKeyProblems('Night lead')).toHaveLength(1)
  })

  it('refuses the permissions only a one-off link session holds (they come from the link\'s purpose)', () => {
    expect(roleProblems({ name: 'Link sender', requireMfa: false, permissions: ['links.view', 'links.manage'], grains: [] })).toEqual([])
    expect(roleProblems({ name: 'Customer', requireMfa: false, permissions: ['links.open', 'links.view', 'links.accept'], grains: ['price'] })).toEqual([
      { path: 'permissions/0', message: 'links.open is held only by a one-off link session, from its purpose; a role cannot give it.' },
      { path: 'permissions/2', message: 'links.accept is held only by a one-off link session, from its purpose; a role cannot give it.' },
    ])
  })

  it('a template update never widens a copy: it only shows what the template has that the copy lacks', () => {
    const copy = normalizeContent({ basedOn: 'admin', permissions: ['users.view', 'roles.view'], grains: [] as never[] })
    expect(templateAdds(copy).permissionsAdded).toEqual(expect.arrayContaining(['roles.assign', 'users.invite']))
    expect(copy.permissions).toEqual(['roles.view', 'users.view'])
    expect(templateAdds({ basedOn: null, permissions: [], grains: [] })).toEqual({ permissionsAdded: [], grainsAdded: [] })
  })

  it('tells what an edit adds and removes, and whether it widens', () => {
    const before = { permissions: ['users.view'] as Permission[], grains: ['price'] as Grain[], requireMfa: true }
    const after = { permissions: ['roles.view'] as Permission[], grains: ['price', 'cost'] as Grain[], requireMfa: true }
    expect(contentChange(before, after)).toEqual({ permissionsAdded: ['roles.view'], permissionsRemoved: ['users.view'], grainsAdded: ['cost'], grainsRemoved: [] })
    expect(widens(before, after)).toBe(true)
    expect(widens(before, { ...before, requireMfa: false })).toBe(true)
    expect(widens(before, { ...before, permissions: [] })).toBe(false)
  })
})

describe('assignments and grants', () => {
  it('checks the scope', () => {
    expect(scopeProblems(everywhere)).toEqual([])
    expect(scopeProblems({ ...everywhere, companyIds: [A] })[0]?.path).toBe('companyIds')
    expect(scopeProblems({ ...onlyA, companyIds: [] })[0]?.message).toMatch(/at least one company/)
    expect(scopeProblems({ ...onlyA, siteIds: ['x', 'x'] }).map((issue) => issue.message)).toEqual(['Expected ids.', 'An id is listed twice.'])
  })

  it('turns an assignment into a grant: permissions plus grains, the scope as ScopeSets', () => {
    expect(grantOf({ permissions: ['audit.read'], grains: ['price'] }, everywhere)).toEqual({ permissions: ['audit.read', 'money.price'], companies: 'all', sites: 'all', parties: 'all' })
    expect(grantOf({ permissions: [], grains: [] }, { ...onlyA, siteIds: [SITE] })).toEqual({ permissions: [], companies: [A], sites: [SITE], parties: 'all' })
  })

  it('unions the grants: company A from one role does not reach company B', () => {
    const actor = office([grantOf({ permissions: ['numbering.view'], grains: ['price'] }, onlyA), grantOf({ permissions: ['audit.read'], grains: [] }, everywhere)])
    expect(can(actor, 'numbering.view', { companyId: A })).toBe(true)
    expect(can(actor, 'numbering.view', { companyId: B })).toBe(false)
    expect(can(actor, 'audit.read', { companyId: B })).toBe(true)
    expect(scopeWhere(actor, 'numbering.view', { company: 'companyId' })).toEqual({ companyId: { in: [A] } })
    expect([...heldGrains(actor)]).toEqual(['price'])
  })

  it('a role that requires two-factor gives nothing before it is proved; a person who requires it holds nothing', () => {
    const held = [
      { role: { permissions: ['users.view'], grains: [], requireMfa: false }, scope: everywhere },
      { role: { permissions: ['roles.assign'], grains: ['cost'], requireMfa: true }, scope: everywhere },
    ] as const
    expect(sessionGrants({ requireMfa: false }, held, false).flatMap((grant) => grant.permissions)).toEqual(['users.view'])
    expect(sessionGrants({ requireMfa: false }, held, true).flatMap((grant) => grant.permissions)).toEqual(['users.view', 'money.cost', 'roles.assign'])
    expect(sessionGrants({ requireMfa: true }, held, false)).toEqual([])
    expect(mfaRequiredFor({ requireMfa: false }, held)).toBe(true)
    expect(mfaRequiredFor({ requireMfa: false }, held.slice(0, 1))).toBe(false)
  })

  it('knows a live assignment and an administrator', () => {
    const now = new Date('2026-10-28T10:00:00Z')
    const live = { validFrom: new Date('2026-10-01T00:00:00Z'), validTo: null, endedAt: null }
    expect(isLive(live, now)).toBe(true)
    expect(isLive({ ...live, validFrom: new Date('2026-11-01T00:00:00Z') }, now)).toBe(false)
    expect(isLive({ ...live, validTo: now }, now)).toBe(false)
    expect(isLive({ ...live, endedAt: now }, now)).toBe(false)
    expect(isAdminAssignment(templateOf('admin')!, everywhere)).toBe(true)
    expect(isAdminAssignment(templateOf('admin')!, onlyA)).toBe(false)
    expect(isAdminAssignment(templateOf('sales')!, everywhere)).toBe(false)
  })
})

describe('money grains by audience', () => {
  const everyGrain = grantOf({ permissions: [], grains: [...GRAINS] }, everywhere)
  it('caps what grants give: floor wages only, partner and link price only, platform none, system all', () => {
    const tenantId = '0195f5d0-0000-7000-8000-0000000000ff'
    expect([...heldGrains({ audience: 'floor', tenantId, siteId: SITE, grants: [everyGrain] })]).toEqual(['wages'])
    expect([...heldGrains({ audience: 'partner', tenantId, partyId: A, grants: [everyGrain] })]).toEqual(['price'])
    expect([...heldGrains({ audience: 'link', tenantId, partyId: A, grants: [everyGrain] })]).toEqual(['price'])
    expect([...heldGrains({ audience: 'platform', grants: [everyGrain] })]).toEqual([])
    expect([...heldGrains({ audience: 'system', tenantId, grants: [] })]).toEqual([...GRAINS])
    expect([...heldGrains(null)]).toEqual([])
    expect([...heldGrains(office([]))]).toEqual([])
  })
})

describe('an assigner gives roles only within their own roles.assign scope', () => {
  const C1 = A
  const S1 = SITE
  const S2 = '0195f5d0-0000-7000-8000-0000000000c2'
  const sites = new Map([[S1, C1], [S2, B]])
  const assigner = (scope: AssignmentScope, permissions: Permission[] = ['roles.assign']) => [grantOf({ permissions, grains: [] }, scope)]
  const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path)

  it('lets a tenant-wide assigner give anything', () => {
    expect(uncoveredScope(assigner(everywhere), { ...everywhere, siteIds: [S1], partyIds: [B] }, sites)).toEqual([])
  })

  it('keeps a company-scoped assigner inside their companies and sites', () => {
    const c1 = assigner(onlyA)
    expect(uncoveredScope(c1, onlyA, sites)).toEqual([])
    expect(uncoveredScope(c1, { ...onlyA, siteIds: [S1] }, sites)).toEqual([])
    expect(paths(uncoveredScope(c1, everywhere, sites))).toEqual(['allCompanies'])
    expect(paths(uncoveredScope(c1, { ...everywhere, siteIds: [S1] }, sites))).toEqual(['siteIds'])
    expect(paths(uncoveredScope(c1, { ...onlyA, companyIds: [A, B] }, sites))).toEqual(['companyIds'])
    const siteBound = assigner({ ...onlyA, siteIds: [S1] })
    expect(paths(uncoveredScope(siteBound, onlyA, sites))).toEqual(['companyIds'])
    expect(uncoveredScope(siteBound, { ...onlyA, siteIds: [S1] }, sites)).toEqual([])
    expect(paths(uncoveredScope(siteBound, { ...onlyA, companyIds: [A, B], siteIds: [S1, S2] }, sites))).toEqual(['companyIds', 'siteIds'])
  })

  it('keeps a party limit at least as tight, and counts only roles.assign grants', () => {
    const party = assigner({ ...everywhere, partyIds: [A] })
    expect(paths(uncoveredScope(party, everywhere, sites))).toEqual(['allCompanies'])
    expect(uncoveredScope(party, { ...everywhere, partyIds: [A] }, sites)).toEqual([])
    expect(paths(uncoveredScope(party, { ...everywhere, partyIds: [A, B] }, sites))).toEqual(['allCompanies'])
    expect(paths(uncoveredScope(assigner(everywhere, ['users.view']), onlyA, sites))).toEqual(['companyIds'])
  })
})
