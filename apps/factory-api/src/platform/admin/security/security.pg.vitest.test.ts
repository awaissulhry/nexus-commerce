import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { DRILL_TIMER_KEY } from '@nexus/factory-domain/ops/drills'
import { TWO_FACTOR_ACTION } from '@nexus/factory-domain/ops/two-factor'
import { systemRoleChanges } from '../../auth/roles/system-roles'
import { addTenant, addUser, Browser, codeAt, enrolTotp, startHarness, stepUp, START, type Harness, type TestTenant, type TestUser } from '../../auth/sessions/testing/harness'

/**
 * Security & health on the local stack (B-W2a-36; PLT-045, PLT-214), through the real app, sign-in and authenticator:
 * the page's facts; two-factor per role asked of a ready-made role and kept by the template sync, refused in words where
 * it would lower a template, a money-seeing role, a floor role or a role the person holds, and where it would leave no
 * administrator able to work; a step-up first; applied at the holders' next sign-in, never mid-session; restore drills
 * compared by this database's own fingerprint at the backup's time (PASSED only when every key matches), append-only,
 * with their evidence file and the due reminder; All settings › Needs attention by what the person may read.
 */

let h: Harness
let alpha: TestTenant
let beta: TestTenant
let owner: Browser
let ownerSecret: string
let ownerUser: TestUser

async function signedIn(slug: string, user: TestUser, code?: string): Promise<Browser> {
  const browser = new Browser(h.app)
  const answer = await browser.signIn(slug, user.email, user.password, code)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${user.email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return browser
}

const permissionsOf = async (browser: Browser): Promise<string[]> => (await browser.get('/auth/office/me')).body.permissions

type RoleView = { id: string; key: string; requireMfa: boolean; lock: string | null; version: number; holders: { userId: string; name: string | null; twoFactor: boolean }[]; heldByMe: boolean }
async function rolesOf(browser: Browser): Promise<RoleView[]> {
  const answer = await browser.get('/admin/security/two-factor')
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body.roles
}
const roleOf = async (browser: Browser, key: string) => (await rolesOf(browser)).find((role) => role.key === key)!

/** Days pass (the owner's session ends at its idle limit): the owner signs in again with a code. */
async function daysPass(days: number): Promise<void> {
  h.clock.advance(days * 86_400_000)
  owner = await signedIn('alpha', ownerUser, codeAt(h.clock, ownerSecret))
  h.clock.advance(30_000)
}

const adminRows = (sql: string, values: unknown[] = []) => h.db.admin.query(sql, values).then((result) => result.rows)

beforeAll(async () => {
  h = await startHarness('admin_security')
  // Rows the database dates itself (an assignment's createdAt) use the real clock: the harness's runs after it.
  h.clock.advance(Math.max(0, Date.now() - h.clock.now().getTime()) + 86_400_000)
  alpha = await addTenant(h, 'alpha')
  beta = await addTenant(h, 'beta')
  ownerUser = await addUser(h, alpha, { email: 'owner@example.com', role: 'owner' })
  owner = await signedIn('alpha', ownerUser)
  ownerSecret = await enrolTotp(h, owner)
  // The file store of the drills' evidence (FAKE: the local store of the harness).
  await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) =>
    client.integrationAccount.create({ data: { id: newId(), provider: 'R2', code: 'files', label: 'Files (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } }),
  )
}, 90_000)

afterAll(async () => {
  await h?.close()
})

describe('the page (SCR-166)', () => {
  it('says what it can see for itself, and never claims what it cannot', async () => {
    const answer = await owner.get('/admin/security')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const status = Object.fromEntries((answer.body.status as { part: string; state: string }[]).map((line) => [line.part, line.state]))
    expect(status).toEqual({ api: 'ok', database: 'ok', jobs: 'ok', scheduled: 'unknown', files: 'ok', backups: 'unknown', drill: 'needs' })
    expect(answer.body.signIn).toMatchObject({ password: { minLength: 12 }, lockout: { afterFailures: 5, firstLockMinutes: 1, maxLockMinutes: 60 }, sessions: { idleHours: 8, absoluteDays: 7, stepUpMinutes: 5 } })
    expect(answer.body.signIn.twoFactor.asking).toBeGreaterThan(0)
    expect(answer.body.backups).toMatchObject({ drill: { state: 'none' }, drills: [], canRecord: true })
    expect((answer.body.protection as { fact: string; state: string }[]).map((fact) => `${fact.fact}:${fact.state}`)).toEqual(['inTransit:on', 'atRest:provider', 'secrets:on', 'bank:partly', 'headers:on', 'virusScan:off'])
  })

  it('is read with security.view; recording a drill needs security.drills.record', async () => {
    const reader = await addUser(h, alpha, { email: 'reader@example.com', role: 'read_only' })
    const browser = await signedIn('alpha', reader)
    expect((await browser.get('/admin/security')).status).toBe(200)
    expect((await browser.get('/admin/security')).body.backups.canRecord).toBe(false)
    expect((await browser.get('/admin/security/fingerprint')).status).toBe(403)
    expect((await browser.post('/admin/security/drills', {})).status).toBe(403)
    const planner = await addUser(h, alpha, { email: 'no-security@example.com', role: 'planner' })
    expect((await (await signedIn('alpha', planner)).get('/admin/security')).status).toBe(403)
  })
})

describe('two-factor per role (PLT-045)', () => {
  let planner: TestUser
  let plannerBefore: Browser
  let late: TestUser
  let lateBefore: Browser

  it('lists every office role, why it cannot stop asking, and its holders with their two-factor', async () => {
    planner = await addUser(h, alpha, { email: 'planner@example.com', role: 'planner' })
    plannerBefore = await signedIn('alpha', planner)
    late = await addUser(h, alpha, { email: 'late@example.com', role: 'read_only' })
    lateBefore = await signedIn('alpha', late)
    const roles = await rolesOf(owner)
    expect(roles.some((role) => role.key === 'operator')).toBe(false)
    expect(roles.find((role) => role.key === 'owner')).toMatchObject({ requireMfa: true, lock: 'money', heldByMe: true })
    expect(roles.find((role) => role.key === 'admin')).toMatchObject({ requireMfa: true, lock: 'template', heldByMe: false })
    expect(roles.find((role) => role.key === 'finance')).toMatchObject({ requireMfa: true, lock: 'money' })
    expect(roles.find((role) => role.key === 'planner')).toMatchObject({ requireMfa: false, lock: null, heldByMe: false, holders: expect.arrayContaining([{ userId: planner.id, name: 'planner', twoFactor: false }]) })
  })

  it('shows who a change affects before saving, and refuses in words what it may not do', async () => {
    const plannerRole = await roleOf(owner, 'planner')
    const ownerRole = await roleOf(owner, 'owner')
    const finance = await roleOf(owner, 'finance')
    const preview = await owner.post('/admin/security/two-factor/preview', { changes: [{ roleId: plannerRole.id, version: plannerRole.version, requireMfa: true }] })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body).toMatchObject({ refusals: [], openSessions: 2 })
    expect(preview.body.affected.map((holder: { userId: string }) => holder.userId)).toContain(planner.id)

    const refused = await owner.post('/admin/security/two-factor/preview', {
      changes: [
        { roleId: ownerRole.id, version: ownerRole.version, requireMfa: false },
        { roleId: finance.id, version: finance.version, requireMfa: false },
        { roleId: plannerRole.id, version: plannerRole.version + 5, requireMfa: true },
      ],
    })
    expect(refused.body.refusals).toEqual([
      { path: 'changes/0', code: 'held', message: expect.stringMatching(/hold this role/) },
      { path: 'changes/1', code: 'money', message: expect.stringMatching(/costs or margins/) },
      { path: 'changes/2', code: 'stale', message: expect.stringMatching(/changed meanwhile/) },
    ])
  })

  it('asks for a fresh code, then asks two-factor of a ready-made role in one audited command', async () => {
    const plannerRole = await roleOf(owner, 'planner')
    const body = { changes: [{ roleId: plannerRole.id, version: plannerRole.version, requireMfa: true }], reason: 'Planners see every order' }
    const first = await owner.post('/admin/security/two-factor', body)
    expect(first.status).toBe(403)
    expect(JSON.stringify(first.body)).toMatch(/stepUp/)
    await stepUp(h, owner, ownerSecret)
    const done = await owner.post('/admin/security/two-factor', body)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.roles[0]).toMatchObject({ key: 'planner', requireMfa: true, version: plannerRole.version + 1 })
    const audit = await adminRows(`SELECT action, before, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action = $3`, [alpha.id, plannerRole.id, TWO_FACTOR_ACTION])
    expect(audit).toEqual([{ action: TWO_FACTOR_ACTION, before: { requireMfa: false }, after: { requireMfa: true }, reason: 'Planners see every order' }])
    expect(await adminRows(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND subject = $2`, [alpha.id, plannerRole.id])).toEqual([{ type: 'security.two_factor_changed' }])
    // The template sync keeps the raise: the ready-made role is not out of date.
    const pending = await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) => systemRoleChanges(client))
    expect(pending.filter((change) => change.key === 'planner')).toEqual([])
    expect(((await owner.get('/auth/roles')).body.roles as { key: string; outdated: boolean }[]).find((role) => role.key === 'planner')?.outdated).toBe(false)
  })

  it('applies at the next sign-in, never mid-session', async () => {
    // The session that started before the switch keeps the planner's permissions until it ends.
    expect(await permissionsOf(plannerBefore)).toContain('planning.items.manage')
    expect((await plannerBefore.get('/auth/office/me')).body.mfa).toMatchObject({ required: true, satisfied: false })
    // A role given AFTER the switch already asked for it: an open session of its new holder gets no grace for it.
    const plannerRole = await roleOf(owner, 'planner')
    await stepUp(h, owner, ownerSecret)
    const given = await owner.post(`/auth/users/${late.id}/roles`, { roleId: plannerRole.id, allCompanies: true })
    expect(given.status, JSON.stringify(given.body)).toBe(200)
    expect(await permissionsOf(lateBefore)).not.toContain('planning.items.manage')
    // A new sign-in without two-factor holds nothing of the role until two-factor is set up.
    h.clock.advance(60_000)
    const after = await signedIn('alpha', planner)
    expect(await permissionsOf(after)).not.toContain('planning.items.manage')
    await enrolTotp(h, after)
    expect(await permissionsOf(after)).toContain('planning.items.manage')
  })

  it('stops asking again with a fresh code (a raise of a ready-made role can come back down)', async () => {
    const plannerRole = await roleOf(owner, 'planner')
    await stepUp(h, owner, ownerSecret)
    const lowered = await owner.post('/admin/security/two-factor', { changes: [{ roleId: plannerRole.id, version: plannerRole.version, requireMfa: false }] })
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200)
    expect(lowered.body.roles[0]).toMatchObject({ requireMfa: false })
    const pending = await h.database.withScope({ audience: 'office', tenantId: alpha.id, actorId: ownerUser.id }, (client) => systemRoleChanges(client))
    expect(pending.filter((change) => change.key === 'planner')).toEqual([])
  })

  it('never leaves the group without an administrator who can work, and nobody changes a role they hold', async () => {
    const actor = newId()
    const [boss, helper] = [newId(), newId()]
    await h.database.withScope({ audience: 'office', tenantId: beta.id, actorId: actor }, async (client) => {
      await client.role.create({ data: { id: boss, key: 'custom.boss', name: 'Boss', permissions: ['roles.assign', 'roles.manage', 'roles.view', 'users.view'], grains: [], requireMfa: false } })
      await client.role.create({ data: { id: helper, key: 'custom.helper', name: 'Helper', permissions: ['roles.manage', 'roles.view'], grains: [], requireMfa: false } })
    })
    const bossUser = await addUser(h, beta, { email: 'boss@example.com' })
    const helperUser = await addUser(h, beta, { email: 'helper@example.com' })
    await h.database.withScope({ audience: 'office', tenantId: beta.id, actorId: actor }, async (client) => {
      await client.roleAssignment.create({ data: { id: newId(), userId: bossUser.id, roleId: boss, allCompanies: true, validFrom: new Date(START) } })
      await client.roleAssignment.create({ data: { id: newId(), userId: helperUser.id, roleId: helper, allCompanies: true, validFrom: new Date(START) } })
    })
    const helperBrowser = await signedIn('beta', helperUser)
    const helperSecret = await enrolTotp(h, helperBrowser)
    const bossRole = await roleOf(helperBrowser, 'custom.boss')
    const helperRole = await roleOf(helperBrowser, 'custom.helper')
    await stepUp(h, helperBrowser, helperSecret)
    const stranded = await helperBrowser.post('/admin/security/two-factor', { changes: [{ roleId: bossRole.id, version: bossRole.version, requireMfa: true }] })
    expect(stranded.status).toBe(409)
    expect(stranded.body.error.message).toMatch(/Nobody could manage people and roles/)
    const own = await helperBrowser.post('/admin/security/two-factor', { changes: [{ roleId: helperRole.id, version: helperRole.version, requireMfa: true }] })
    expect(own.status).toBe(409)
    expect(own.body.error.issues).toEqual([{ path: 'body/changes/0', message: expect.stringMatching(/You hold this role/) }])
    // Once the only administrator has two-factor, the same change is made.
    const bossBrowser = await signedIn('beta', bossUser)
    await enrolTotp(h, bossBrowser)
    await stepUp(h, helperBrowser, helperSecret)
    const asked = await helperBrowser.post('/admin/security/two-factor', { changes: [{ roleId: bossRole.id, version: bossRole.version, requireMfa: true }] })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    // Nothing crossed the tenant wall.
    expect((await rolesOf(owner)).some((role) => role.key === 'custom.boss')).toBe(false)
  })
})

describe('restore drills (PLT-214)', () => {
  let backupAt: string
  let line: string

  it("gives this database's fingerprint as of a time: rows made later do not change it", async () => {
    // A minute ago by the server's clock: the files runtime dates files by it (the harness's clock runs ahead of it).
    backupAt = new Date(Date.now() - 60_000).toISOString()
    const first = await owner.get(`/admin/security/fingerprint?asOf=${encodeURIComponent(backupAt)}`)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    line = first.body.line
    expect(line).toMatch(/^NXF1 orders=[0-9a-f]{16} invoices=[0-9a-f]{16} stockMoves=[0-9a-f]{16} parties=[0-9a-f]{16} files=[0-9a-f]{16}$/)
    expect((await owner.get('/admin/security/fingerprint?asOf=2999-01-01T00:00:00.000Z')).status).toBe(400)
  })

  it('records a drill that passed with its evidence file, and moves the reminder', async () => {
    h.clock.advance(60_000)
    const log = Buffer.from('%PDF-1.7 made-up restore log')
    const sha256 = (await import('node:crypto')).createHash('sha256').update(log).digest('hex')
    const announced = await owner.post('/admin/security/drills/evidence', { originalName: 'restore-log.pdf', contentType: 'application/pdf', sizeBytes: log.length, sha256 })
    expect(announced.status, JSON.stringify(announced.body)).toBe(201)
    const sent = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: log })
    expect(sent.statusCode, sent.body).toBe(200)
    const done = await owner.post(`/admin/security/drills/evidence/${announced.body.file.id}/complete`)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    // The files runtime writes on the server's clock; the harness's clock catches up past it.
    await daysPass(3)
    // The evidence is a file made after the backup: the fingerprint now differs, the one at the backup's time does not.
    expect((await owner.get('/admin/security/fingerprint')).body.line).not.toBe(line)
    expect((await owner.get(`/admin/security/fingerprint?asOf=${encodeURIComponent(backupAt)}`)).body.line).toBe(line)

    const drilledOn = h.clock.now().toISOString().slice(0, 10)
    const recorded = await owner.post('/admin/security/drills', { id: announced.body.drillId, drilledOn, environment: 'a local copy', backupAt, restored: line, durationMinutes: 18, evidenceFileId: announced.body.file.id, notes: 'Restored on a laptop.' })
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200)
    expect(recorded.body.drill).toMatchObject({ id: announced.body.drillId, result: 'PASSED', environment: 'a local copy', evidenceFileId: announced.body.file.id, performedBy: { id: ownerUser.id } })
    expect(recorded.body.drill.checks.every((check: { match: boolean }) => check.match)).toBe(true)
    expect(recorded.body.drillStatus).toMatchObject({ state: 'ok', lastOn: drilledOn, daysAgo: 0, daysLeft: 90 })
    const timers = await adminRows(`SELECT "timerKey", status, "recordType", "recordId" FROM "DueTimer" WHERE "tenantId" = $1`, [alpha.id])
    expect(timers).toEqual([{ timerKey: DRILL_TIMER_KEY, status: 'PENDING', recordType: 'Tenant', recordId: alpha.id }])
    expect(await adminRows(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND subject = $2`, [alpha.id, announced.body.drillId])).toEqual([{ type: 'security.drill_recorded' }])
  })

  it('fails a drill whose copy differs, keeps the reminder, and refuses a drill over production', async () => {
    h.clock.advance(60_000)
    const wrong = line.replace(/invoices=[0-9a-f]{16}/, 'invoices=ffffffffffffffff')
    const drilledOn = h.clock.now().toISOString().slice(0, 10)
    const failed = await owner.post('/admin/security/drills', { drilledOn, environment: 'staging', backupAt, restored: wrong })
    expect(failed.status, JSON.stringify(failed.body)).toBe(200)
    expect(failed.body.drill.result).toBe('FAILED')
    expect(failed.body.drill.checks.filter((check: { match: boolean }) => !check.match).map((check: { key: string }) => check.key)).toEqual(['invoices'])
    expect(failed.body.drillStatus.state).toBe('failed')
    expect((await adminRows(`SELECT status FROM "DueTimer" WHERE "tenantId" = $1`, [alpha.id])).map((row) => row.status)).toEqual(['PENDING'])

    const production = await owner.post('/admin/security/drills', { drilledOn, environment: 'the production server', backupAt, restored: line })
    expect(production.status).toBe(400)
    expect(production.body.error.issues).toEqual([{ path: 'body/environment', message: expect.stringMatching(/never over it/) }])
    const bad = await owner.post('/admin/security/drills', { drilledOn, environment: 'staging', backupAt, restored: 'orders=1' })
    expect(bad.body.error.issues[0]).toMatchObject({ path: 'body/restored' })
    // The evidence of another drill is refused.
    const stray = await owner.post('/admin/security/drills', { id: newId(), drilledOn, environment: 'staging', backupAt, restored: line, evidenceFileId: (await adminRows(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1`, [alpha.id]))[0]!.id })
    expect(stray.status).toBe(400)
  })

  it('keeps every drill (append-only) and a later pass moves the reminder', async () => {
    await daysPass(2)
    const drilledOn = h.clock.now().toISOString().slice(0, 10)
    const again = await owner.post('/admin/security/drills', { drilledOn, environment: 'a local copy', backupAt, restored: line })
    expect(again.body.drill.result).toBe('PASSED')
    expect((await adminRows(`SELECT status FROM "DueTimer" WHERE "tenantId" = $1 ORDER BY "createdAt"`, [alpha.id])).map((row) => row.status)).toEqual(['CANCELLED', 'PENDING'])
    const list = await owner.get('/admin/security/drills')
    expect(list.body.drills.map((drill: { result: string }) => drill.result)).toEqual(['PASSED', 'FAILED', 'PASSED'])
    await expect(h.db.admin.query(`UPDATE "RestoreDrill" SET notes = 'changed' WHERE "tenantId" = $1`, [alpha.id])).rejects.toThrow()
  })
})

describe('All settings › Needs attention', () => {
  it('lists what went wrong, only where the person may read it', async () => {
    await adminRows(`UPDATE "IntegrationAccount" SET "lastErrorAt" = now(), "lastOkAt" = now() - interval '1 hour' WHERE "tenantId" = $1 AND provider = 'SES'`, [alpha.id])
    const answer = await owner.get('/admin/security/attention')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const kinds = (answer.body.items as { kind: string }[]).map((entry) => entry.kind)
    expect(kinds).toContain('integrationFailing')
    expect(kinds).not.toContain('drill')
    expect(answer.body.unread).toEqual([])
    const nobody = await addUser(h, alpha, { email: 'nobody@example.com' })
    const plain = await signedIn('alpha', nobody)
    const none = await plain.get('/admin/security/attention')
    expect(none.status).toBe(200)
    expect(none.body.items).toEqual([])
    expect(none.body.unread).toEqual(['integrationFailing', 'mailDomain', 'tabletUnseen', 'drill', 'jobsFailed', 'twoFactorMissing'])
    // beta has no drill: its administrator is told.
    const betaOwner = await addUser(h, beta, { email: 'beta-owner@example.com', role: 'owner' })
    const betaBrowser = await signedIn('beta', betaOwner)
    await enrolTotp(h, betaBrowser)
    const betaItems = (await betaBrowser.get('/admin/security/attention')).body.items as { kind: string; state: string | null }[]
    expect(betaItems.find((entry) => entry.kind === 'drill')).toMatchObject({ state: 'none' })
  })
})
