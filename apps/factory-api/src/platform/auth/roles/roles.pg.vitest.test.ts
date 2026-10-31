import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { newId } from '@nexus/factory-domain/core/ids'
import { SYSTEM_ACTOR_ID, type OfficeContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { rolesSyncCron, syncAllTenants } from './sync'
import { fillTwoFactorSinceAll } from './two-factor-since'
import { addRole, addTenant, addUser, Browser, enrolTotp, START, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from '../sessions/testing/harness'

/**
 * Roles, scopes and money grains on the local stack (features PLT-029, PLT-030, PLT-032, PLT-034), through the real
 * app, sign-in and authenticator: the grants of a session are the union of its live assignments; a role that requires
 * two-factor gives nothing before it is proved; company scope limits lists and single reads; custom roles are edited
 * through command() with audit rows, never system roles, never by someone who holds them; a template update reaches a
 * system role through an audited sync and never a custom copy; assignments need a step-up and keep an administrator;
 * invitations carry roles; audit rows are shaped by money grain; the tenant wall holds. The clock only moves forward.
 */

let h: Harness
let alpha: TestTenant
let beta: TestTenant
let owner: Browser
let ownerSecret: string
let ownerUser: TestUser

interface Person {
  user: TestUser
  browser: Browser
  secret?: string
}

async function signedIn(slug: string, user: TestUser): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn(slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

/** A person of a tenant with two-factor set up (so they can step up). */
async function person(tenant: TestTenant, email: string, roleKey?: string): Promise<Required<Person>> {
  const user = await addUser(h, tenant, { email })
  if (roleKey) await addRole(h, tenant, user.id, roleKey)
  const browser = await signedIn(tenant.slug, user)
  const secret = await enrolTotp(h, browser)
  return { user, browser, secret }
}

const permissionsOf = async (browser: Browser): Promise<string[]> => (await browser.get('/auth/office/me')).body.permissions

async function roleIdOf(browser: Browser, key: string): Promise<string> {
  const role = ((await browser.get('/auth/roles')).body.roles as { id: string; key: string }[]).find((entry) => entry.key === key)
  if (!role) throw new Error(`no role ${key}`)
  return role.id
}

async function asOwner(method: 'post' | 'patch', url: string, body: Record<string, unknown> = {}) {
  await stepUp(h, owner, ownerSecret)
  if (method === 'patch') return owner.send('PATCH' as never, url, body)
  return owner.post(url, body)
}

const assign = (userId: string, body: Record<string, unknown>) => asOwner('post', `/auth/users/${userId}/roles`, body)

beforeAll(async () => {
  h = await startHarness('auth_roles')
  alpha = await addTenant(h, 'alpha', 2)
  beta = await addTenant(h, 'beta')
  ownerUser = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
  owner = await signedIn('alpha', ownerUser)
  ownerSecret = await enrolTotp(h, owner)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('templates and the registry', () => {
  it('lists the templates with every assignable permission and the grains; every tenant has its system roles', async () => {
    const answer = await owner.get('/auth/roles/templates')
    expect(answer.status).toBe(200)
    expect(answer.body.templates.map((template: { key: string }) => template.key)).toContain('quality_inspector')
    expect(answer.body.permissions.find((entry: { name: string }) => entry.name === 'roles.assign')).toMatchObject({ area: 'roles', risk: 'stepUp' })
    expect(answer.body.grains.map((entry: { grain: string }) => entry.grain)).toEqual(['price', 'cost', 'margin', 'wages'])
    const roles = (await owner.get('/auth/roles')).body.roles as { key: string; system: boolean; holders: number; outdated: boolean }[]
    expect(roles.filter((role) => role.system).map((role) => role.key).sort()).toEqual(answer.body.templates.map((template: { key: string }) => template.key).sort())
    expect(roles.find((role) => role.key === 'owner')).toMatchObject({ holders: 1, outdated: false })
  })
})

describe('the grants of a session', () => {
  it('a role that requires two-factor gives nothing until two-factor is proved on the session; the others give theirs', async () => {
    const user = await addUser(h, alpha, { email: 'admin.person@example.com' })
    await addRole(h, alpha, user.id, 'admin')
    // Sales sees margins (design question S2, answer a), so it too waits for two-factor; warehouse does not.
    await addRole(h, alpha, user.id, 'sales')
    await addRole(h, alpha, user.id, 'warehouse')
    const browser = new Browser(h.app)
    const answer = await browser.signIn('alpha', user.email, user.password)
    expect(answer.body.mfa).toEqual({ enabled: false, required: true, satisfied: false })
    expect(await permissionsOf(browser)).toEqual(['alerts.handle', 'alerts.view', 'files.read', 'files.upload', 'floorsync.discard', 'floorsync.view', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'inventory.adjust', 'inventory.counts.approve', 'inventory.counts.manage', 'inventory.counts.view', 'inventory.discrepancies.manage', 'inventory.discrepancies.report', 'inventory.issue', 'inventory.issue.over', 'inventory.locations.manage', 'inventory.locations.view', 'inventory.opening.import', 'inventory.receipts.documents.request', 'inventory.receive', 'inventory.reserve', 'inventory.reverse', 'inventory.scrap', 'inventory.stock.view', 'inventory.transfer', 'orders.view', 'parties.view', 'people.team.view', 'print.documents', 'print.labels', 'print.view', 'product.materials.view', 'product.styles.view', 'production.finish', 'purchasing.claims.manage', 'purchasing.claims.return', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'purchasing.view', 'quality.holds.view', 'quality.lots.view', 'quality.ncr.raise', 'quality.ncr.view', 'sales.repairs.receive', 'sales.repairs.ship', 'sales.repairs.view', 'sales.returns.inspect', 'sales.returns.receive', 'sales.returns.view', 'shipping.ddt.cancel', 'shipping.ddt.issue', 'shipping.evidence.manage', 'shipping.labels.buy', 'shipping.labels.void', 'shipping.manage', 'shipping.pack', 'shipping.settings.manage', 'shipping.settings.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'])
    expect((await browser.get('/auth/users')).status).toBe(403)

    await enrolTotp(h, browser)
    const after = await permissionsOf(browser)
    expect(after).toEqual(expect.arrayContaining(['users.view', 'roles.assign', 'audit.read', 'quotes.manage', 'money.price', 'money.margin', 'inventory.stock.view']))
    expect(after).not.toContain('money.cost')
    expect((await browser.get('/auth/users')).status).toBe(200)
    expect((await browser.get('/auth/office/me')).body).toMatchObject({ mfa: { required: true, satisfied: true } })
  })

  it('is the union of the live assignments; one that starts later gives nothing yet', async () => {
    const reader = await person(alpha, 'reader@example.com', 'read_only')
    await assign(reader.user.id, { roleId: await roleIdOf(owner, 'sales'), companyIds: [alpha.companies[0]!.id] })
    const later = new Date(h.clock.now().getTime() + 24 * 3_600_000).toISOString()
    await assign(reader.user.id, { roleId: await roleIdOf(owner, 'planner'), allCompanies: true, validFrom: later })
    expect(await permissionsOf(reader.browser)).toEqual([
      'accounting.view', 'alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'companies.bank.view', 'companies.view', 'compliance.certificates.view', 'compliance.register.view', 'costing.view', 'devices.view', 'documents.view', 'email.delivery.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'floorsync.view', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'integrations.view', 'inventory.counts.view', 'inventory.locations.view', 'inventory.stock.view', 'invoices.view', 'links.view', 'money.margin', 'money.price', 'numbering.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payables.view', 'payments.view', 'paymentterms.view', 'people.privacy.view', 'people.shifts.view', 'people.team.view', 'people.view', 'planning.view', 'plant.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'privacy.view', 'product.bom.view', 'product.materials.view', 'product.routing.view', 'product.styles.view', 'production.cutting.view', 'production.offstandard.view', 'production.reports.view', 'production.scrap.view', 'production.settings.view', 'purchasing.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.defects.view', 'quality.holds.view', 'quality.inspections.view', 'quality.lots.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'reasons.view', 'receivables.view', 'roles.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'security.view', 'shipping.settings.view', 'shipping.view', 'sites.view', 'tasks.manage', 'threads.post', 'threads.read', 'users.view', 'views.export', 'views.save', 'workers.view', 'workorders.view',
    ])
    const listed = (await reader.browser.get(`/auth/users/${reader.user.id}/roles`)).body.assignments as { roleKey: string; live: boolean }[]
    expect(listed.map((entry) => [entry.roleKey, entry.live])).toEqual(expect.arrayContaining([['planner', false], ['sales', true], ['read_only', true]]))
  })
})

describe('scope: company A from a role does not reach company B', () => {
  it('limits the list and refuses a single read or write of the other company', async () => {
    const [c1, c2] = alpha.companies
    const s1 = (await owner.post('/numbering/series', { companyId: c1!.id, kind: 'QUOTE' })).body.series
    const s2 = (await owner.post('/numbering/series', { companyId: c2!.id, kind: 'QUOTE' })).body.series
    expect(s1.companyId).toBe(c1!.id)

    const created = await asOwner('post', '/auth/roles', { key: 'series_clerk', name: 'Series clerk', permissions: ['numbering.view', 'numbering.manage', 'audit.read'] })
    expect(created.status).toBe(200)
    const clerk = await person(alpha, 'clerk@example.com')
    expect((await assign(clerk.user.id, { roleId: created.body.id, companyIds: [c1!.id] })).status).toBe(200)

    const listed = (await clerk.browser.get('/numbering/series')).body.series as { id: string }[]
    expect(listed.map((series) => series.id)).toEqual([s1.id])
    const advance = (series: { id: string; version: number }) =>
      clerk.browser.post(`/numbering/series/${series.id}/advance`, { pastValue: 10, reason: 'paper booklet used', version: series.version })
    expect((await advance(s2)).status).toBe(403)
    expect((await advance(s1)).status).toBe(200)
    expect((await clerk.browser.get(`/audit/NumberSeries/${s2.id}`)).body.entries).toEqual([])
    expect((await clerk.browser.get(`/audit/NumberSeries/${s1.id}`)).body.entries.length).toBeGreaterThan(0)
    expect((await owner.get(`/audit/NumberSeries/${s2.id}`)).body.entries.length).toBeGreaterThan(0)
  })
})

describe('custom roles', () => {
  it('are created from a template and edited through command(), with an audit row that says what changed', async () => {
    const created = await asOwner('post', '/auth/roles', { key: 'quoting', name: 'Quoting', basedOn: 'sales' })
    expect(created.body).toMatchObject({ key: 'custom.quoting', system: false, basedOn: 'sales', permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'], grains: ['price', 'margin'], version: 1, holders: 0 })
    expect((await asOwner('post', '/auth/roles', { key: 'quoting', name: 'Again' })).status).toBe(409)

    const edited = await asOwner('patch', `/auth/roles/${created.body.id}`, { version: 1, permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'numbering.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'], reason: 'Quotes need the series' })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'numbering.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'], version: 2 })
    const history = (await owner.get(`/audit/Role/${created.body.id}`)).body.entries
    expect(history[0]).toMatchObject({
      action: 'roles.edit',
      actorId: ownerUser.id,
      reason: 'Quotes need the series',
      before: { permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'] },
      after: { permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'numbering.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'], permissionsAdded: ['numbering.view'], permissionsRemoved: [] },
    })
    expect(history[1]).toMatchObject({ action: 'roles.create' })

    const stale = await asOwner('patch', `/auth/roles/${created.body.id}`, { version: 1, name: 'Old' })
    expect(stale.status).toBe(409)
    // The copy of sales requires two-factor (it sees margins); taking that off while it would see costs is refused.
    const unknown = await asOwner('patch', `/auth/roles/${created.body.id}`, { version: 2, permissions: ['quotes.export'], grains: ['cost'], requireMfa: false })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['permissions/0', 'requireMfa'])
  })

  it('refuses to edit a system role, or a role the editor holds', async () => {
    const system = await asOwner('patch', `/auth/roles/${await roleIdOf(owner, 'planner')}`, { version: 1, name: 'Mine' })
    expect(system.status).toBe(409)
    expect(system.body.error.code).toBe('invalid_state')

    const lead = await person(alpha, 'lead@example.com', 'admin')
    const own = await asOwner('post', '/auth/roles', { key: 'lead_extra', name: 'Lead extra', permissions: ['users.view'] })
    await assign(lead.user.id, { roleId: own.body.id, allCompanies: true })
    await stepUp(h, lead.browser, lead.secret)
    const refused = await lead.browser.send('PATCH' as never, `/auth/roles/${own.body.id}`, { version: 1, grains: ['price'] })
    expect(refused.status).toBe(403)
  })

  it('a template update reaches the system role through an audited sync, never a custom copy', async () => {
    const copy = await asOwner('post', '/auth/roles', { key: 'lean_admin', name: 'Lean admin', basedOn: 'admin', permissions: ['users.view'] })
    expect(copy.body.templateAdds.permissionsAdded).toEqual(expect.arrayContaining(['roles.assign', 'users.invite']))

    // As if the sales template had gained its permissions after the tenant's sales role was synced.
    const salesId = await roleIdOf(owner, 'sales')
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) =>
      client.role.update({ where: { id: salesId }, data: { permissions: [] } }),
    )
    expect(((await owner.get('/auth/roles')).body.roles as { id: string; outdated: boolean }[]).find((role) => role.id === salesId)?.outdated).toBe(true)

    expect((await asOwner('post', '/auth/roles/sync-templates')).body).toEqual({ created: 0, updated: 1 })
    const roles = (await owner.get('/auth/roles')).body.roles as { id: string; outdated: boolean; permissions: string[] }[]
    expect(roles.find((role) => role.id === salesId)).toMatchObject({ outdated: false, permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'] })
    expect(roles.find((role) => role.id === copy.body.id)?.permissions).toEqual(['users.view'])
    expect((await owner.get(`/audit/Role/${salesId}`)).body.entries[0]).toMatchObject({ action: 'roles.syncTemplates', before: { permissions: [] }, after: { permissions: ['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'] } })
    expect((await asOwner('post', '/auth/roles/sync-templates')).body).toEqual({ created: 0, updated: 0 })
  })
})

describe('assignments', () => {
  it('need a step-up, are never given to oneself, are checked, audited and ended', async () => {
    const rep = await addUser(h, alpha, { email: 'rep@example.com' })
    const salesId = await roleIdOf(owner, 'sales')
    h.clock.advance(5 * 60_000)
    const noStepUp = await owner.post(`/auth/users/${rep.id}/roles`, { roleId: salesId, allCompanies: true })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect((await assign(ownerUser.id, { roleId: salesId, allCompanies: true })).status).toBe(403)

    const bad = await assign(rep.id, { roleId: salesId, companyIds: [beta.companies[0]!.id], siteIds: [newId()] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['companyIds', 'siteIds'])
    expect((await assign(rep.id, { roleId: salesId })).body.error.issues[0].path).toBe('companyIds')

    const given = await assign(rep.id, { roleId: salesId, companyIds: [alpha.companies[1]!.id], reason: 'Covers company 2' })
    expect(given.body).toMatchObject({ roleKey: 'sales', allCompanies: false, companyIds: [alpha.companies[1]!.id], live: true, version: 1 })
    expect((await owner.get(`/audit/RoleAssignment/${given.body.id}`)).body.entries[0]).toMatchObject({ action: 'roles.assign', reason: 'Covers company 2', after: { userId: rep.id, role: 'sales' } })
    const listed = ((await owner.get('/auth/users')).body.users as { email: string; roles: { roleKey: string }[] }[]).find((user) => user.email === 'rep@example.com')
    expect(listed?.roles.map((role) => role.roleKey)).toEqual(['sales'])

    const ended = await asOwner('post', `/auth/role-assignments/${given.body.id}/end`, { version: 1 })
    expect(ended.body).toMatchObject({ live: false, version: 2, endedAt: expect.any(String) })
    expect((await asOwner('post', `/auth/role-assignments/${given.body.id}/end`, { version: 2 })).status).toBe(409)
    expect((await owner.get(`/audit/RoleAssignment/${given.body.id}`)).body.entries[0]).toMatchObject({ action: 'roles.unassign' })
  })

  it('keep an administrator: the last one is not suspended, and a narrower desk cannot unassign them', async () => {
    const gamma = await addTenant(h, 'gamma')
    const boss = await addUser(h, gamma, { email: 'boss@example.com', role: 'owner' })
    const delegate = await person(gamma, 'delegate@example.com')
    const bossBrowser = await signedIn('gamma', boss)
    const bossSecret = await enrolTotp(h, bossBrowser)
    await stepUp(h, bossBrowser, bossSecret)
    const role = await bossBrowser.post('/auth/roles', { key: 'access_desk', name: 'Access desk', permissions: ['roles.view', 'roles.assign', 'users.view', 'users.suspend'] })
    await stepUp(h, bossBrowser, bossSecret)
    // Over one company only: the delegate gives roles but is not an administrator of the whole tenant.
    expect((await bossBrowser.post(`/auth/users/${delegate.user.id}/roles`, { roleId: role.body.id, companyIds: [gamma.companies[0]!.id] })).status).toBe(200)

    const bossAssignments = (await delegate.browser.get(`/auth/users/${boss.id}/roles`)).body.assignments as { id: string; version: number }[]
    await stepUp(h, delegate.browser, delegate.secret)
    // Only someone whose roles.assign reaches every company could end it, and that person is an administrator too.
    const unassign = await delegate.browser.post(`/auth/role-assignments/${bossAssignments[0]!.id}/end`, { version: bossAssignments[0]!.version })
    expect(unassign.status).toBe(403)
    expect(unassign.body.error.issues[0].path).toBe('allCompanies')
    const bossRow = ((await delegate.browser.get('/auth/users')).body.users as { id: string; version: number }[]).find((user) => user.id === boss.id)!
    await stepUp(h, delegate.browser, delegate.secret)
    const suspend = await delegate.browser.post(`/auth/users/${boss.id}/suspend`, { version: bossRow.version })
    expect(suspend.status).toBe(409)
    expect(suspend.body.error.message).toMatch(/another active administrator/)
  })
})

describe('an assigner gives roles only within their own roles.assign scope', () => {
  it('refuses an assignment or an invitation wider than the companies and sites the assigner reaches (403)', async () => {
    const [c1, c2] = alpha.companies
    const siteId = newId()
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) =>
      client.site.create({ data: { id: siteId, companyId: c1!.id, code: 'P1', name: 'Plant 1', kind: 'PLANT' } }),
    )
    const desk = await asOwner('post', '/auth/roles', { key: 'access_c1', name: 'Access desk C1', permissions: ['roles.view', 'roles.assign', 'users.invite'] })
    const companyDesk = await person(alpha, 'desk.company@example.com')
    const siteDesk = await person(alpha, 'desk.site@example.com')
    await assign(companyDesk.user.id, { roleId: desk.body.id, companyIds: [c1!.id] })
    await assign(siteDesk.user.id, { roleId: desk.body.id, companyIds: [c1!.id], siteIds: [siteId] })
    const salesId = await roleIdOf(owner, 'sales')
    const target = await addUser(h, alpha, { email: 'scoped.target@example.com' })
    const give = async (desker: Required<Person>, scope: Record<string, unknown>) => {
      await stepUp(h, desker.browser, desker.secret)
      return desker.browser.post(`/auth/users/${target.id}/roles`, { roleId: salesId, ...scope })
    }

    const everyCompany = await give(companyDesk, { allCompanies: true })
    expect(everyCompany.status).toBe(403)
    expect(everyCompany.body.error.issues).toEqual([{ path: 'allCompanies', message: 'Outside your own roles.assign scope: every company and site.' }])
    expect((await give(companyDesk, { companyIds: [c2!.id] })).body.error.issues[0].path).toBe('companyIds')
    const insideCompany = await give(companyDesk, { companyIds: [c1!.id] })
    expect(insideCompany.status).toBe(200)
    expect((await give(companyDesk, { companyIds: [c1!.id], siteIds: [siteId] })).status).toBe(200)

    expect((await give(siteDesk, { companyIds: [c1!.id] })).status).toBe(403)
    const insideSite = await give(siteDesk, { companyIds: [c1!.id], siteIds: [siteId] })
    expect(insideSite.status).toBe(200)

    // Ending follows the same rule: the desk's scope must cover the WHOLE scope of the assignment it ends.
    const tenantWide = await assign(target.id, { roleId: salesId, allCompanies: true })
    const end = async (desker: Required<Person>, assignment: { id: string; version: number }) => {
      await stepUp(h, desker.browser, desker.secret)
      return desker.browser.post(`/auth/role-assignments/${assignment.id}/end`, { version: assignment.version })
    }
    const wideEnd = await end(companyDesk, tenantWide.body)
    expect(wideEnd.status).toBe(403)
    expect(wideEnd.body.error.issues).toEqual([{ path: 'allCompanies', message: 'Outside your own roles.assign scope: every company and site.' }])
    expect((await end(siteDesk, insideCompany.body)).body.error.issues).toEqual([{ path: 'companyIds', message: `Outside your own roles.assign scope: company ${c1!.id}.` }])
    expect((await end(siteDesk, insideSite.body)).body).toMatchObject({ live: false, endedAt: expect.any(String) })
    expect((await end(companyDesk, insideCompany.body)).body).toMatchObject({ live: false, endedAt: expect.any(String) })
    expect(((await owner.get(`/auth/users/${target.id}/roles`)).body.assignments as { id: string; live: boolean }[]).find((entry) => entry.id === tenantWide.body.id)?.live).toBe(true)

    await stepUp(h, companyDesk.browser, companyDesk.secret)
    const wideInvite = await companyDesk.browser.post('/auth/invitations', { email: 'wide@example.com', displayName: 'Wide', roles: [{ roleId: salesId, allCompanies: true }] })
    expect(wideInvite.status).toBe(403)
    expect(wideInvite.body.error.issues).toEqual([{ path: 'roles/0/allCompanies', message: 'Outside your own roles.assign scope: every company and site.' }])
    await stepUp(h, companyDesk.browser, companyDesk.secret)
    expect((await companyDesk.browser.post('/auth/invitations', { email: 'narrow@example.com', displayName: 'Narrow', roles: [{ roleId: salesId, companyIds: [c1!.id] }] })).status).toBe(200)
  })
})

describe('invitations carry roles', () => {
  it('gives the invited person their roles, live once they accept', async () => {
    const salesId = await roleIdOf(owner, 'sales')
    const invited = await asOwner('post', '/auth/invitations', {
      email: 'new.rep@example.com',
      displayName: 'New Rep',
      roles: [{ roleId: salesId, companyIds: [alpha.companies[0]!.id] }],
    })
    expect(invited.status).toBe(200)
    expect(invited.body.invitation.roleIds).toEqual([salesId])
    const message = h.mailer.last('invitation', 'new.rep@example.com')!
    const guest = new Browser(h.app)
    await guest.get('/auth/csrf')
    const accepted = await guest.post('/auth/invitations/accept', { token: decodeURIComponent(message.link.split('#token=')[1]!), password: 'calm-meadow-river-91' })
    // Sales sees margins, so its permissions wait for two-factor on the session.
    expect(accepted.body).toMatchObject({ status: 'signed_in', mfa: { required: true, satisfied: false } })
    expect(await permissionsOf(guest)).toEqual([])
    await enrolTotp(h, guest)
    expect(await permissionsOf(guest)).toEqual(['alerts.handle', 'alerts.view', 'audit.read', 'calendars.view', 'costing.view', 'documents.view', 'email.send', 'email.triage', 'files.read', 'files.upload', 'home.reports.view', 'home.view', 'imports.apply', 'imports.run', 'imports.view', 'invoices.view', 'money.margin', 'money.price', 'orders.manage', 'orders.view', 'parties.manage', 'parties.vies', 'parties.view', 'payments.view', 'paymentterms.view', 'pricelists.manage', 'pricelists.view', 'print.documents', 'print.view', 'product.materials.view', 'product.styles.view', 'quality.complaints.log', 'quality.complaints.view', 'quality.ncr.raise', 'quality.ncr.view', 'quotes.manage', 'quotes.send', 'quotes.view', 'receivables.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.view', 'sales.returns.decide', 'sales.returns.manage', 'sales.returns.view', 'shipping.view', 'tasks.manage', 'threads.post', 'threads.read', 'views.export', 'views.save', 'workorders.view'])
  })

  it('needs roles.assign to give roles with an invitation', async () => {
    const inviter = await person(alpha, 'inviter@example.com')
    const role = await asOwner('post', '/auth/roles', { key: 'inviter', name: 'Inviter', permissions: ['users.invite'] })
    await assign(inviter.user.id, { roleId: role.body.id, allCompanies: true })
    await stepUp(h, inviter.browser, inviter.secret)
    const refused = await inviter.browser.post('/auth/invitations', { email: 'x@example.com', displayName: 'X', roles: [{ roleId: role.body.id, allCompanies: true }] })
    expect(refused.status).toBe(403)
    await stepUp(h, inviter.browser, inviter.secret)
    expect((await inviter.browser.post('/auth/invitations', { email: 'x@example.com', displayName: 'X' })).status).toBe(200)
  })
})

describe('money grains on audit rows', () => {
  it('shows a marked value only to whoever holds its grain; an unmarked money-looking key only to whoever holds all', async () => {
    const recordId = newId()
    const context: OfficeContext = { audience: 'office', tenantId: alpha.id, actorId: ownerUser.id, grants: [], requestId: 'test-money' }
    await h.auth.command(context, { name: 'probe.costChange', input: null }, async ({ audit }) => {
      audit({ recordType: 'Probe', recordId, before: { unitCost: markMoney('cost', '75.000000') }, after: { unitCost: markMoney('cost', '80.000000'), unitPrice: markMoney('price', '120.000000'), totalAmount: 5, note: 'kept' } })
      return null
    })
    const entryAs = async (browser: Browser) => (await browser.get(`/audit/Probe/${recordId}`)).body.entries[0]
    expect(await entryAs(owner)).toMatchObject({ before: { unitCost: '75.000000' }, after: { unitCost: '80.000000', unitPrice: '120.000000', totalAmount: 5, note: 'kept' } })

    const priced = await person(alpha, 'priced@example.com', 'sales')
    const seen = await entryAs(priced.browser)
    expect(seen.before).toEqual({})
    expect(seen.after).toEqual({ unitPrice: '120.000000', note: 'kept' })
    const blind = await person(alpha, 'blind@example.com', 'read_only')
    expect((await entryAs(blind.browser)).after).toEqual({ note: 'kept' })
  })
})

describe('the system roles follow their templates by themselves', () => {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = []
  const log: Log = {
    info: (fields, message) => void lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => void lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => void lines.push({ level: 'error', fields, message }),
  }
  const admin = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, unknown>[]

  it('syncs every ACTIVE tenant (worker start and the daily cron), audited as the system; a suspended tenant waits', async () => {
    const delta = await addTenant(h, 'delta')
    const omega = await addTenant(h, 'omega')
    // As if a deploy had changed the sales template and added the warehouse one after these tenants were synced.
    await admin(`UPDATE "Role" SET permissions = '{}' WHERE "tenantId" IN ($1::uuid, $2::uuid) AND key = 'sales'`, [delta.id, omega.id])
    await admin(`DELETE FROM "Role" WHERE "tenantId" IN ($1::uuid, $2::uuid) AND key = 'warehouse'`, [delta.id, omega.id])
    await h.database.withScope({ audience: 'platform' }, (client) => client.tenant.update({ where: { id: omega.id }, data: { status: 'SUSPENDED' } }))

    const first = await syncAllTenants({ database: h.database, log, clock: h.clock })
    expect(first).toMatchObject({ changed: 1, created: 1, updated: 1, failed: 0 })
    const audited = await admin(
      `SELECT a.action, a.audience::text, a."actorId"::text AS actor, r.key FROM "AuditLog" a JOIN "Role" r ON r.id = a."recordId" WHERE a."tenantId" = $1::uuid AND a.action = 'roles.syncTemplates' ORDER BY r.key`,
      [delta.id],
    )
    expect(audited).toEqual([
      { action: 'roles.syncTemplates', audience: 'SYSTEM', actor: SYSTEM_ACTOR_ID, key: 'sales' },
      { action: 'roles.syncTemplates', audience: 'SYSTEM', actor: SYSTEM_ACTOR_ID, key: 'warehouse' },
    ])
    expect((await admin(`SELECT permissions FROM "Role" WHERE "tenantId" = $1::uuid AND key = 'sales'`, [omega.id]))[0]).toEqual({ permissions: [] })
    expect(await syncAllTenants({ database: h.database, log, clock: h.clock })).toMatchObject({ changed: 0, created: 0, updated: 0 })

    const cron = rolesSyncCron({ database: h.database, log, clock: h.clock })
    expect(cron).toMatchObject({ name: 'roles.syncTemplates', schedule: '15 3 * * *', timezone: 'Europe/Rome' })
    await admin(`UPDATE "Role" SET grains = '{}' WHERE "tenantId" = $1::uuid AND key = 'owner'`, [delta.id])
    await cron.run({ name: cron.name, scheduledAt: h.clock.now() })
    expect((await admin(`SELECT grains FROM "Role" WHERE "tenantId" = $1::uuid AND key = 'owner'`, [delta.id]))[0]).toEqual({ grains: ['price', 'cost', 'margin', 'wages'] })
    expect(lines.filter((line) => line.level === 'error')).toEqual([])
  })
})

describe('B-W2b-24: two-factor since, and the Security rules on PATCH /auth/roles', () => {
  const admin = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, unknown>[]
  const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined }

  it('keeps "since" on every write path; PATCH asks it from the next sign-in, never mid-session, with its event', async () => {
    const made = await asOwner('post', '/auth/roles', { key: 'mfa_probe', name: 'Two-factor probe', permissions: ['users.view'] })
    expect(made.body).toMatchObject({ requireMfa: false, requireMfaSince: null })
    const holder = await addUser(h, alpha, { email: 'mfa-holder@example.com' })
    // Given on the test's clock (the database would date it by the real one, which runs days after the harness's).
    await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) =>
      client.roleAssignment.create({ data: { id: newId(), userId: holder.id, roleId: made.body.id, allCompanies: true, validFrom: new Date(START), createdAt: h.clock.now() } }),
    )
    const before = await signedIn('alpha', holder)
    expect(await permissionsOf(before)).toContain('users.view')
    h.clock.advance(60_000)

    const raised = await asOwner('patch', `/auth/roles/${made.body.id}`, { version: 1, requireMfa: true, reason: 'Sees every person' })
    expect(raised.status, JSON.stringify(raised.body)).toBe(200)
    expect(raised.body.requireMfaSince).not.toBeNull()
    const [row] = await admin(`SELECT r."requireMfaSince" = a.at AS same FROM "Role" r JOIN "AuditLog" a ON a."recordId" = r.id AND a.action = 'roles.edit' WHERE r.id = $1 ORDER BY a.at DESC LIMIT 1`, [made.body.id])
    expect(row).toEqual({ same: true })
    expect(await admin(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'security.two_factor_changed'`, [made.body.id])).toEqual([{ type: 'security.two_factor_changed', payload: { roleId: made.body.id, requireMfa: true } }])
    // The open session keeps the role until it ends (the column, no audit lookup); a new sign-in holds nothing of it yet.
    expect(await permissionsOf(before)).toContain('users.view')
    h.clock.advance(60_000)
    expect(await permissionsOf(await signedIn('alpha', holder))).not.toContain('users.view')
    // Two-factor list says since when too.
    const listed = ((await owner.get('/admin/security/two-factor')).body.roles as { id: string; requireMfaSince: string | null }[]).find((role) => role.id === made.body.id)
    expect(listed?.requireMfaSince).toBe(raised.body.requireMfaSince)
    // Stopped: since cleared.
    const lowered = await asOwner('patch', `/auth/roles/${made.body.id}`, { version: 2, requireMfa: false })
    expect(lowered.body).toMatchObject({ requireMfa: false, requireMfaSince: null })
  })

  it('refuses a raise on PATCH that would leave nobody able to manage people and roles (lockOut), in words', async () => {
    const gamma = await addTenant(h, 'w2b24-lock')
    const actor = newId()
    const [boss, helper] = [newId(), newId()]
    await h.database.withScope({ audience: 'office', tenantId: gamma.id, actorId: actor }, async (client) => {
      await client.role.create({ data: { id: boss, key: 'custom.boss', name: 'Boss', permissions: ['roles.assign', 'roles.manage', 'roles.view', 'users.view'], grains: [], requireMfa: false } })
      await client.role.create({ data: { id: helper, key: 'custom.helper', name: 'Helper', permissions: ['roles.manage', 'roles.view'], grains: [], requireMfa: false } })
    })
    const bossUser = await addUser(h, gamma, { email: 'boss@example.com' })
    await addRole(h, gamma, bossUser.id, 'custom.boss')
    const helperPerson = await person(gamma, 'helper@example.com', 'custom.helper')
    await stepUp(h, helperPerson.browser, helperPerson.secret)
    const refused = await helperPerson.browser.send('PATCH' as never, `/auth/roles/${boss}`, { version: 1, requireMfa: true })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues).toEqual([{ path: 'body/requireMfa/lockOut', message: expect.stringMatching(/Nobody could manage people and roles/) }])
    expect((await admin(`SELECT "requireMfa" FROM "Role" WHERE id = $1`, [boss]))[0]).toEqual({ requireMfa: false })
  })

  it('fills "since" once from the audit log for a role that asked before the time was kept (worker start, daily cron)', async () => {
    const made = await asOwner('post', '/auth/roles', { key: 'old_asker', name: 'Asked before W2b', permissions: ['users.view'], requireMfa: true })
    expect(made.body.requireMfaSince).not.toBeNull()
    // As a role made before B-W2b-03 kept the time: no time (past the trigger, the admin session only).
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "Role" SET "requireMfaSince" = NULL WHERE id = $1`, [made.body.id])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const [created] = await admin(`SELECT at FROM "AuditLog" WHERE "recordId" = $1 AND action = 'roles.create'`, [made.body.id])
    expect(await fillTwoFactorSinceAll({ database: h.database, log, clock: h.clock })).toMatchObject({ failed: 0 })
    const [row] = await admin(`SELECT "requireMfaSince" FROM "Role" WHERE id = $1`, [made.body.id])
    expect((row!.requireMfaSince as Date).toISOString()).toBe((created!.at as Date).toISOString())
    expect(await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'roles.twoFactorSince'`, [made.body.id])).toEqual([{ action: 'roles.twoFactorSince', after: { requireMfaSince: (created!.at as Date).toISOString(), from: 'audit' } }])
    expect((await fillTwoFactorSinceAll({ database: h.database, log, clock: h.clock })).filled).toBe(0)
  })
})

describe('the tenant wall', () => {
  it("never shows or touches another tenant's roles and assignments", async () => {
    const betaOwnerUser = await addUser(h, beta, { email: 'owner@example.com', role: 'owner', password: 'other-tenant-lantern-31' })
    const betaOwner = await signedIn('beta', betaOwnerUser)
    const betaSecret = await enrolTotp(h, betaOwner)
    const alphaRoles = ((await owner.get('/auth/roles')).body.roles as { id: string }[]).map((role) => role.id)
    const betaRoles = ((await betaOwner.get('/auth/roles')).body.roles as { id: string; key: string }[])
    expect(betaRoles.some((role) => alphaRoles.includes(role.id))).toBe(false)
    expect(betaRoles.some((role) => role.key.startsWith('custom.'))).toBe(false)

    const betaMember = await addUser(h, beta, { email: 'member@example.com' })
    await stepUp(h, betaOwner, betaSecret)
    const foreignRole = await betaOwner.post(`/auth/users/${betaMember.id}/roles`, { roleId: alphaRoles[0], allCompanies: true })
    expect(foreignRole.status).toBe(400)
    expect(foreignRole.body.error.issues).toEqual([{ path: 'roleId', message: 'No role of the tenant has this id.' }])
    const alphaAssignment = ((await owner.get(`/auth/users/${ownerUser.id}/roles`)).body.assignments as { id: string }[])[0]!
    await stepUp(h, betaOwner, betaSecret)
    expect((await betaOwner.post(`/auth/role-assignments/${alphaAssignment.id}/end`, { version: 1 })).status).toBe(404)
    expect((await betaOwner.get(`/auth/users/${ownerUser.id}/roles`)).status).toBe(404)
    await stepUp(h, betaOwner, betaSecret)
    expect((await betaOwner.post(`/auth/users/${ownerUser.id}/roles`, { roleId: betaRoles[0]!.id, allCompanies: true })).status).toBe(404)
  })

  it('answers 401 on every roles route without a session', async () => {
    const guest = new Browser(h.app)
    expect((await guest.get('/auth/roles')).status).toBe(401)
    expect((await guest.get('/auth/roles/templates')).status).toBe(401)
    expect((await guest.post('/auth/roles/sync-templates')).status).toBe(401)
  })
})
