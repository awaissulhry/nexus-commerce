import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryClient } from '@nexus/factory-db'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant, type TestUser } from '../../sessions/testing/harness'

/**
 * Custom roles in depth on the local stack (B-W2b-404; PLT-031), through the real app: a role made from a ready-made one never
 * holds more than its maker and never the owner's every(); the review of a change says what it adds and removes and who gets
 * it; raising rights asks for a fresh code, lowering never does; archived, never deleted: archiving ends its assignments in
 * the same command, an archived role changes no more and is given to nobody until restored. Made-up people.
 */

let h: Harness
let alpha: TestTenant
let owner: Browser
let ownerSecret: string
let ownerUser: TestUser

async function signedIn(user: TestUser): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn('alpha', user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

const inTenant = <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> => h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, work)
const patch = (browser: Browser, url: string, body: Record<string, unknown>) => browser.send('PATCH' as never, url, body)

async function asOwner(url: string, body: Record<string, unknown> = {}) {
  await stepUp(h, owner, ownerSecret)
  return owner.post(url, body)
}

async function roleIdOf(key: string): Promise<string> {
  const role = ((await owner.get('/auth/roles')).body.roles as { id: string; key: string }[]).find((entry) => entry.key === key)
  if (!role) throw new Error(`no role ${key}`)
  return role.id
}

beforeAll(async () => {
  h = await startHarness('auth_custom_roles')
  alpha = await addTenant(h, 'alpha')
  ownerUser = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
  owner = await signedIn(ownerUser)
  ownerSecret = await enrolTotp(h, owner)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('a new role from a ready-made one', () => {
  it('never holds more than its maker, never the owner role; the templates say which the caller may copy', async () => {
    const desk = await asOwner('/auth/roles', { key: 'role_desk', name: 'Role desk', permissions: ['roles.view', 'roles.manage', 'users.view', 'quotes.view', 'orders.view'], grains: ['price'] })
    expect(desk.status).toBe(200)
    const keeper = await addUser(h, alpha, { email: 'keeper@example.com' })
    expect((await asOwner(`/auth/users/${keeper.id}/roles`, { roleId: desk.body.id, allCompanies: true })).status).toBe(200)
    const keeperBrowser = await signedIn(keeper)
    const keeperSecret = await enrolTotp(h, keeperBrowser)

    const templates = (await keeperBrowser.get('/auth/roles/templates')).body.templates as { key: string; copyable: boolean }[]
    expect(templates.find((template) => template.key === 'owner')?.copyable).toBe(false)
    expect(templates.find((template) => template.key === 'planner')?.copyable).toBe(false)
    expect(templates.find((template) => template.key === 'operator')?.copyable).toBe(false)
    const ownerTemplates = (await owner.get('/auth/roles/templates')).body.templates as { key: string; copyable: boolean }[]
    expect(ownerTemplates.filter((template) => template.copyable).map((template) => template.key)).toContain('planner')
    expect(ownerTemplates.find((template) => template.key === 'owner')?.copyable).toBe(false)

    await stepUp(h, keeperBrowser, keeperSecret)
    const within = await keeperBrowser.post('/auth/roles', { key: 'quote_reader', name: 'Quote reader', permissions: ['quotes.view'], grains: ['price'] })
    expect(within.status).toBe(200)
    await stepUp(h, keeperBrowser, keeperSecret)
    const beyond = await keeperBrowser.post('/auth/roles', { key: 'invoice_issuer', name: 'Invoice issuer', permissions: ['quotes.view', 'invoices.issue'], grains: ['cost'], requireMfa: true })
    expect(beyond.status).toBe(403)
    expect(beyond.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(['body/permissions/invoices.issue/beyondYou', 'body/grains/cost/beyondYou'])
    const ownerCopy = await asOwner('/auth/roles', { key: 'second_owner', name: 'Second owner', basedOn: 'owner' })
    expect(ownerCopy.status).toBe(400)
    expect(ownerCopy.body.error.issues[0].path).toBe('body/basedOn/ownerCopy')

    // An edit adds only what the editor holds; what the role already had stays theirs to keep.
    await stepUp(h, keeperBrowser, keeperSecret)
    const added = await patch(keeperBrowser, `/auth/roles/${within.body.id}`, { version: 1, permissions: ['quotes.view', 'invoices.issue'] })
    expect(added.status).toBe(403)
    expect(added.body.error.issues[0].path).toBe('body/permissions/invoices.issue/beyondYou')
  })
})

describe('the review of a change, and raising rights', () => {
  it('says what it adds and removes and who gets it; a fresh code only to raise rights or change two-factor', async () => {
    const created = await asOwner('/auth/roles', { key: 'planner_copy', name: 'Planner (copy)', basedOn: 'planner' })
    const holder = await addUser(h, alpha, { email: 'planner-copy@example.com' })
    expect((await asOwner(`/auth/users/${holder.id}/roles`, { roleId: created.body.id, allCompanies: true })).status).toBe(200)
    const permissions: string[] = created.body.permissions
    const fewer = permissions.filter((permission) => permission !== 'planning.items.manage')

    const raise = await owner.post(`/auth/roles/${created.body.id}/review`, { permissions: [...permissions, 'orders.manage'] })
    expect(raise.status).toBe(200)
    expect(raise.body).toMatchObject({ version: 1, permissionsAdded: ['orders.manage'], permissionsRemoved: [], raises: true, asksFreshCode: true, holders: 1, refusals: [] })
    const lower = await owner.post(`/auth/roles/${created.body.id}/review`, { permissions: fewer, name: 'Planner (light)' })
    expect(lower.body).toMatchObject({ permissionsAdded: [], permissionsRemoved: ['planning.items.manage'], raises: false, asksFreshCode: false, holders: 1, refusals: [] })
    const bad = await owner.post(`/auth/roles/${created.body.id}/review`, { permissions: [...permissions, 'floor.work'], grains: ['cost'], requireMfa: false })
    expect(bad.body.refusals.map((issue: { path: string }) => issue.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^body\/permissions\/\d+$/), 'body/requireMfa']))
    expect((await owner.post(`/auth/roles/${await roleIdOf('planner')}/review`, { name: 'Mine' })).body.refusals[0].path).toBe('roles/readyMade')

    // Lowering: saved without a fresh code (the step-up of the assignment above is long gone).
    h.clock.advance(6 * 60_000)
    const lowered = await patch(owner, `/auth/roles/${created.body.id}`, { version: 1, permissions: fewer, name: 'Planner (light)' })
    expect(lowered.status).toBe(200)
    expect(lowered.body).toMatchObject({ version: 2, name: 'Planner (light)' })
    const raised = await patch(owner, `/auth/roles/${created.body.id}`, { version: 2, permissions })
    expect(raised.status).toBe(403)
    expect(raised.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, owner, ownerSecret)
    expect((await patch(owner, `/auth/roles/${created.body.id}`, { version: 2, permissions })).status).toBe(200)
  })
})

describe('archived, never deleted', () => {
  it('ends its assignments in the same command, changes no more, is given to nobody, and comes back when restored', async () => {
    const created = await asOwner('/auth/roles', { key: 'old_desk', name: 'Old desk', permissions: ['quotes.view'] })
    const roleId = created.body.id as string
    const first = await addUser(h, alpha, { email: 'first-holder@example.com' })
    const second = await addUser(h, alpha, { email: 'second-holder@example.com' })
    for (const person of [first, second]) expect((await asOwner(`/auth/users/${person.id}/roles`, { roleId, allCompanies: true })).status).toBe(200)
    const firstBrowser = await signedIn(first)
    expect((await firstBrowser.get('/auth/office/me')).body.permissions).toContain('quotes.view')

    h.clock.advance(6 * 60_000)
    const asked = await owner.post(`/auth/roles/${roleId}/archive`, { version: 1, reason: 'Desk closed' })
    expect(asked.status).toBe(403)
    expect(asked.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    const archived = await asOwner(`/auth/roles/${roleId}/archive`, { version: 1, reason: 'Desk closed' })
    expect(archived.status).toBe(200)
    expect(archived.body).toMatchObject({ archivedAt: expect.any(String), holders: 0, version: 2 })
    // The holders lose it at their next request.
    expect((await firstBrowser.get('/auth/office/me')).body.permissions).not.toContain('quotes.view')
    const assignments = await inTenant((client) => client.roleAssignment.findMany({ where: { roleId }, select: { endedAt: true, endedById: true } }))
    expect(assignments).toHaveLength(2)
    expect(assignments.every((row) => row.endedAt !== null && row.endedById === ownerUser.id)).toBe(true)
    const listed = ((await owner.get('/auth/roles')).body.roles as { id: string; archivedAt: string | null }[]).find((role) => role.id === roleId)
    expect(listed?.archivedAt).toEqual(archived.body.archivedAt)
    const history = (await owner.get(`/audit/Role/${roleId}`)).body.entries
    expect(history[0]).toMatchObject({ action: 'roles.archive', reason: 'Desk closed', after: { assignmentsEnded: 2 } })
    const events = await inTenant((client) => client.securityEvent.findMany({ where: { kind: 'ROLE_CHANGED', recordType: 'Role', recordId: roleId }, select: { details: true } }))
    expect(events.map((event) => event.details)).toContainEqual({ change: 'roles.archive' })

    await stepUp(h, owner, ownerSecret)
    const edit = await patch(owner, `/auth/roles/${roleId}`, { version: 2, name: 'Reopened desk' })
    expect(edit.status).toBe(409)
    expect(edit.body.error.issues[0].path).toBe('roles/ROLE_ARCHIVED')
    const given = await asOwner(`/auth/users/${first.id}/roles`, { roleId, allCompanies: true })
    expect(given.status).toBe(409)
    expect(given.body.error.issues[0].path).toBe('roles/ROLE_ARCHIVED')
    expect((await owner.post(`/auth/roles/${roleId}/archive`, { version: 2, reason: 'Again' })).body.error.issues[0].path).toBe('roles/alreadyArchived')

    // Restoring raises nobody's rights: no fresh code.
    h.clock.advance(6 * 60_000)
    const restored = await owner.post(`/auth/roles/${roleId}/restore`, { version: 2 })
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ archivedAt: null, version: 3 })
    expect((await asOwner(`/auth/users/${first.id}/roles`, { roleId, allCompanies: true })).status).toBe(200)
    const outbox = await inTenant((client) => client.outboxEvent.findMany({ where: { type: 'security.role_archive_changed', subject: roleId }, orderBy: [{ occurredAt: 'asc' }], select: { payload: true } }))
    expect(outbox.map((event) => event.payload)).toEqual([{ roleId, archived: true }, { roleId, archived: false }])
  })

  it('refuses a ready-made role and one the person holds; an unheld role asks no fresh code', async () => {
    h.clock.advance(6 * 60_000)
    const system = await owner.post(`/auth/roles/${await roleIdOf('planner')}/archive`, { version: 1, reason: 'Not used' })
    expect(system.status).toBe(409)
    expect(system.body.error.issues[0].path).toBe('roles/system')

    const lead = await addUser(h, alpha, { email: 'lead@example.com', role: 'admin' })
    const leadBrowser = await signedIn(lead)
    await enrolTotp(h, leadBrowser)
    const theirs = await asOwner('/auth/roles', { key: 'lead_extra', name: 'Lead extra', permissions: ['users.view'] })
    await asOwner(`/auth/users/${lead.id}/roles`, { roleId: theirs.body.id, allCompanies: true })
    const held = await leadBrowser.post(`/auth/roles/${theirs.body.id}/archive`, { version: 1, reason: 'Not needed' })
    expect(held.status).toBe(403)
    expect(held.body.error.issues[0].path).toBe('roles/held')

    const unheld = await asOwner('/auth/roles', { key: 'never_given', name: 'Never given', permissions: ['quotes.view'] })
    h.clock.advance(6 * 60_000)
    const archived = await owner.post(`/auth/roles/${unheld.body.id}/archive`, { version: 1, reason: 'Made by mistake' })
    expect(archived.status).toBe(200)
    expect(archived.body.archivedAt).toEqual(expect.any(String))
    // Never deleted: no route deletes a role, and the database refuses it for every login.
    await expect(inTenant((client) => client.role.delete({ where: { id: unheld.body.id } }))).rejects.toThrow()
  })
})
