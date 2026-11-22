import { describe, expect, it } from 'vitest'
import type { Actor, Permission } from '../../core/permissions'
import { can, scopeWhere } from '../../core/permissions'
import { GRAINS, heldGrains, TWO_FACTOR_GRAINS, type Grain } from '../grains/grains'
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
  ONLY_OWNER_GIVES_PRICES,
  priceGiverProblems,
  roleProblems,
  seesPrices,
  scopeProblems,
  sessionGrants,
  templateAdds,
  uncoveredScope,
  widens,
  type AssignmentScope,
} from './roles'
import { ROLE_TEMPLATES, templateOf, templateProblems } from './templates'
import { PARTNER_ROLE_TEMPLATES, SYSTEM_ROLE_TEMPLATES } from './templates' // B-CP-016

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
    expect(FACTORY_PERMISSIONS.undeclared(['users.view', 'quotes.export', 'quotes.export'])).toEqual(['quotes.export'])
    expect([...FACTORY_PERMISSIONS.byArea().keys()]).toEqual(['users', 'roles', 'audit', 'numbering', 'files', 'links', 'devices', 'workers', 'floor', 'threads', 'imports', 'documents', 'print', 'email', 'integrations', 'compliance', 'product', 'inventory', 'shipping', 'parties', 'planning', 'purchasing', 'invoices', 'payments', 'costing', 'production', 'workorders', 'quotes', 'sales', 'companies', 'sites', 'orders', 'privacy', 'quality', 'home', 'floorsync', 'calendars', 'reasons', 'paymentterms', 'pricelists', 'tasks', 'views', 'search', 'plant', 'alerts', 'accounting', 'security', 'receivables', 'payables', 'people', 'safety',
      // B-W2b-162: partner organisations (office) and the portal's own (partner roles only).
      'partners', 'portal',
      'money',
      // B-W2b-282: one approval engine (declared after the grains).
      'approvals',
      // B-W2b-389: currencies and exchange rates.
      'currencies',
      // B-W2b-421: custom fields and picklists.
      'fields',
      // B-TH-066: projects (the office's projects.manage; the portal's projects.view is in 'portal').
      'projects'])
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
  it('are valid: declared permissions, grains apart, two-factor for price, cost and margin, an owner', () => {
    expect(templateProblems(ROLE_TEMPLATES)).toEqual([])
    expect(ROLE_TEMPLATES.map((entry) => entry.key)).toEqual([
      'owner', 'admin', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor',
      // B-W2a-35: the plant's technicians (office and floor).
      'maintenance',
      // B-W2b-120: the HR office, the safety officer and the occupational doctor.
      'hr', 'safety_officer', 'company_doctor',
      'read_only',
      // B-CP-016: the office role "Factory designer".
      'designer',
      'operator', 'cutting_operator', 'floor_inspector', 'team_leader',
      'technician',
    ])
    // The owner holds every office permission; the floor's are held only by floor roles.
    expect(templateOf('owner')?.permissions).toEqual(
      FACTORY_PERMISSIONS.assignable.filter((definition) => definition.area !== 'floor').map((definition) => definition.name).sort(),
    )
    expect(templateOf('owner')?.grains).toEqual([...GRAINS])
    expect(templateOf('read_only')?.permissions.every((name) => FACTORY_PERMISSIONS.get(name)?.risk === 'read')).toBe(true)
    expect(templateOf('admin')?.requireMfa).toBe(true)
    // B-CP-011 (the money wall, Owner O1 reverses design question S2's answer a): Sales sees no money and keeps no price
    // list; two-factor kept.
    expect(templateOf('sales')).toMatchObject({ grains: [], requireMfa: true, description: "Customers, quotes and orders; no prices: lines take the customer's price list, a price holder sets the rest." })
    expect(templateOf('sales')?.permissions).not.toContain('pricelists.manage')
    expect(templateOf('sales')?.permissions).toEqual(expect.arrayContaining(['pricelists.view', 'quotes.manage', 'orders.manage']))
  })

  it('B-CP-011: Finance keeps its grains (a price role only the Owner gives); every office role seeing price, cost or margin asks for two-factor', () => {
    expect(templateOf('finance')).toMatchObject({ grains: ['price', 'cost', 'margin', 'wages'], requireMfa: true })
    expect(templateOf('finance')?.description).toMatch(/Only the Owner gives this role/)
    expect(TWO_FACTOR_GRAINS).toEqual(['price', 'cost', 'margin'])
    for (const entry of ROLE_TEMPLATES.filter((template) => template.grains.some((grain) => TWO_FACTOR_GRAINS.includes(grain)))) expect(entry.requireMfa, entry.key).toBe(true)
    // The office roles that see our prices: the Owner and Finance only (the plan's "Who sees prices", O1-O3).
    expect(ROLE_TEMPLATES.filter((template) => template.audience === 'office' && template.grains.includes('price')).map((template) => template.key)).toEqual(['owner', 'finance'])
  })

  it('finds a template naming an unknown permission, a grain as a permission, or cost without two-factor', () => {
    const owner = templateOf('owner')!
    expect(templateProblems([{ ...owner, permissions: ['quotes.export'] }])).toEqual(['owner: quotes.export is not declared'])
    expect(templateProblems([{ ...owner, permissions: ['money.cost'] }])).toEqual(['owner: money.cost is a grain; list it in grains'])
    expect(templateProblems([{ ...owner, requireMfa: false }])).toEqual(['owner: a role that sees price, cost and margin requires two-factor'])
    // B-CP-011: prices alone ask for it too.
    expect(templateProblems([owner, { ...templateOf('planner')!, grains: ['price'] }])).toEqual(['planner: a role that sees price requires two-factor'])
    expect(templateProblems([{ ...owner, key: 'sales' }])).toEqual(['the owner template is missing'])
  })
})

describe('custom roles', () => {
  it('checks the content and the key', () => {
    // B-CP-011 (Owner O6): a role that sees prices asks for two-factor.
    expect(roleProblems({ name: 'Night lead', requireMfa: true, permissions: ['users.view'], grains: ['price'] })).toEqual([])
    expect(roleProblems({ name: 'Night lead', requireMfa: false, permissions: ['users.view'], grains: ['price'] })).toEqual([{ path: 'requireMfa', message: 'A role that sees price requires two-factor.' }])
    expect(roleProblems({ name: 'Night lead', requireMfa: false, permissions: ['users.view'], grains: ['wages'] })).toEqual([])
    expect(roleProblems({ name: 'Desk', requireMfa: false, permissions: ['users.view'], grains: ['price', 'cost', 'margin'] })).toEqual([{ path: 'requireMfa', message: 'A role that sees price, cost and margin requires two-factor.' }])
    expect(roleProblems({ name: '', requireMfa: false, permissions: ['quotes.export', 'money.price'], grains: ['salary' as never, 'cost'] })).toEqual([
      { path: 'name', message: 'Expected 1 to 100 characters.' },
      { path: 'permissions/0', message: 'Not a permission of the factory.' },
      { path: 'permissions/1', message: 'A money grain: list it in grains.' },
      { path: 'grains/0', message: 'salary is not a money grain (price, cost, margin, wages, pay).' },
      { path: 'requireMfa', message: 'A role that sees cost requires two-factor.' },
    ])
    expect(customKeyProblems('night_lead')).toEqual([])
    expect(customKeyProblems('Night lead')).toHaveLength(1)
  })

  it('refuses the permissions only a one-off link session holds (they come from the link\'s purpose)', () => {
    expect(roleProblems({ name: 'Link sender', requireMfa: false, permissions: ['links.view', 'links.manage'], grains: [] })).toEqual([])
    // B-CP-011: requireMfa true, so only the link permissions are refused (a price role asks for two-factor).
    expect(roleProblems({ name: 'Customer', requireMfa: true, permissions: ['links.open', 'links.view', 'links.accept'], grains: ['price'] })).toEqual([
      { path: 'permissions/0', message: 'Held only by a one-off link session, from its purpose; a role cannot give it.' },
      { path: 'permissions/2', message: 'Held only by a one-off link session, from its purpose; a role cannot give it.' },
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
  it('caps what grants give: floor wages and pay only (B-W2b-34), partner and link price only, platform none, system all', () => {
    const tenantId = '0195f5d0-0000-7000-8000-0000000000ff'
    expect([...heldGrains({ audience: 'floor', tenantId, siteId: SITE, grants: [everyGrain] })]).toEqual(['wages', 'pay'])
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

describe('B-CP-011: only the Owner gives a role that sees prices (Owner O3)', () => {
  it('refuses anyone else a role with the price grain, at the path given; lowering never asks', () => {
    expect(seesPrices(['price', 'cost'])).toBe(true)
    expect(seesPrices(['cost', 'margin', 'wages'])).toBe(false)
    expect(priceGiverProblems(['price'], true, 'roles/0/roleId')).toEqual([])
    expect(priceGiverProblems(['price', 'cost', 'margin', 'wages'], false, 'roles/0/roleId')).toEqual([{ path: 'roles/0/roleId/onlyOwnerGivesPrices', message: 'Only the Owner gives a role that sees prices.' }])
    // A role without the price grain (Buyer's cost, a no-money role) is given as before.
    expect(priceGiverProblems(['cost'], false, 'roleId')).toEqual([])
    expect(priceGiverProblems([], false, 'roleId')).toEqual([])
    expect(ONLY_OWNER_GIVES_PRICES).toEqual({ code: 'onlyOwnerGivesPrices', message: 'Only the Owner gives a role that sees prices.' })
  })

  it('Finance is a price role, Sales and the Administrator are not', () => {
    expect(seesPrices(templateOf('finance')!.grains)).toBe(true)
    expect(seesPrices(templateOf('sales')!.grains)).toBe(false)
    expect(seesPrices(templateOf('admin')!.grains)).toBe(false)
  })
})

// ── B-CP-016 (customer page plan C7; design customer-page 12 §5; review F7): the office role "Factory designer" ──
describe('B-CP-016: the office role "Factory designer" sees no money', () => {
  const designer = templateOf('designer')!

  it('key designer, an office role, grains [] and no two-factor', () => {
    expect(designer).toMatchObject({ key: 'designer', audience: 'office', name: 'Factory designer', description: 'Works on logos, artwork and samples with customers; sees no money.', requireMfa: false, grains: [] })
    expect(seesPrices(designer.grains)).toBe(false)
    expect(designer.grains.some((grain) => TWO_FACTOR_GRAINS.includes(grain))).toBe(false)
    expect(mfaRequiredFor({ requireMfa: false }, [{ role: designer, scope: everywhere }])).toBe(false)
    // A designer session without two-factor holds its whole role (nothing waits for a code).
    expect(sessionGrants({ requireMfa: false }, [{ role: designer, scope: everywhere }], false)).toHaveLength(1)
  })

  it('works on artwork and samples with customers: exactly the permissions of the design, all declared', () => {
    expect([...designer.permissions].sort()).toEqual(['files.read', 'files.upload', 'home.view', 'orders.view', 'parties.view', 'product.bom.view', 'product.styles.view', 'sales.inquiries.view', 'sales.samples.view', 'threads.post', 'threads.read', 'views.save'])
    for (const name of designer.permissions) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    // cp-fx6: templateProblems checks a whole set, which always holds the owner (as above: [owner, …]); the designer adds no problem.
    expect(templateProblems([templateOf('owner')!, designer])).toEqual([])
    // Never a money permission, never a write of an order, a quote or a price; never measurement sheets (body data).
    expect(designer.permissions.filter((name) => name.startsWith('money.'))).toEqual([])
    for (const name of ['orders.manage', 'quotes.view', 'quotes.manage', 'pricelists.view', 'sales.measurements.view', 'product.materials.cost', 'costing.view', 'invoices.view', 'payments.view']) expect(designer.permissions, name).not.toContain(name)
  })

  it('a designer session holds no grain: heldGrains is empty, money.price is never granted', () => {
    const actor = office([grantOf({ permissions: designer.permissions, grains: designer.grains }, everywhere)])
    expect([...heldGrains(actor)]).toEqual([])
    expect(can(actor, 'money.price' as Permission, { companyId: A })).toBe(false)
    expect(can(actor, 'orders.view' as Permission, { companyId: A })).toBe(true)
  })

  it('its key is unique among every system role, and never the portal Designer’s (customer-designer)', () => {
    const keys = SYSTEM_ROLE_TEMPLATES.map((entry) => entry.key)
    expect(keys.filter((key) => key === 'designer')).toEqual(['designer'])
    expect(new Set(keys).size).toBe(keys.length)
    const portal = PARTNER_ROLE_TEMPLATES.find((entry) => entry.key === 'customer-designer')!
    expect(portal.audience).toBe('partner')
    expect(portal.key).not.toBe(designer.key)
    // The office roles that see our prices are still the Owner and Finance only.
    expect(ROLE_TEMPLATES.filter((entry) => entry.audience === 'office' && entry.grains.includes('price')).map((entry) => entry.key)).toEqual(['owner', 'finance'])
  })
})
// ── end B-CP-016 ──

// ── B-OM-010 (order money tab D6, lead L9): the right to change an order's money plan ──
describe('B-OM-010: orders.moneyPlan — the Owner and Finance; never Sales, Production or Read-only', () => {
  it('is a declared write permission: Finance holds it, the Owner from every permission, nobody else', () => {
    expect(FACTORY_PERMISSIONS.get('orders.moneyPlan')?.risk).toBe('write')
    expect(templateOf('finance')?.permissions).toContain('orders.moneyPlan')
    expect(templateOf('owner')?.permissions).toContain('orders.moneyPlan')
    for (const key of ['sales', 'production_manager', 'planner', 'read_only', 'admin', 'designer']) expect(templateOf(key)?.permissions ?? [], key).not.toContain('orders.moneyPlan')
    expect(ROLE_TEMPLATES.filter((entry) => entry.permissions.includes('orders.moneyPlan' as Permission)).map((entry) => entry.key)).toEqual(['owner', 'finance'])
  })
})
// ── end B-OM-010 ──
