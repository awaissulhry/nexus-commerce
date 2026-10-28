import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { LINK_HEADER } from '../../links/authenticator'
import { registerLinkRecordSource } from '../../links/records'
import { DEVICE_COOKIE, FLOOR_COOKIE } from '../floor/cookies'
import { CSRF_COOKIE, SESSION_COOKIE } from '../sessions/cookies'
import type { OfficeAuth } from '../sessions/office-auth'
import { addTenant, addUser, Browser, codeAt, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * No token is ever stored where a database read could find it (plan A1 §3.10, §5.4): an invitation link, the session
 * it starts and a one-off link are minted OUTSIDE their commands, so neither an Idempotency-Key receipt (which stores a
 * command's result), nor an audit row, nor an outbox event holds the token or its secret. A repeated keyed request
 * answers from its receipt without the token: the invitation says `already_sent` (no second mail), the link `url: null`.
 * The floor's secrets likewise (an enrolment code, a device token, a badge code, a floor session token, a reset PIN):
 * minted before their commands, and every floor command keeps a receipt (a server key), so the scan reaches them.
 * And the office's own (sign-in, forced change, reset, two-factor, step-up, refresh): their routes take no key, so the
 * test gives each of their commands one, as if every request carried an Idempotency-Key; a secret in any command's
 * result would then sit in its receipt.
 */

let h: Harness
let tenant: TestTenant
let owner: Browser
let ownerSecret: string
let withdraw: () => void
const PARTY = newId()
const QUOTE = newId()

beforeAll(async () => {
  h = await startHarness('token_leaks')
  tenant = await addTenant(h, 'leak')
  withdraw = registerLinkRecordSource('Quote', {
    async read(_client, recordId) {
      return recordId === QUOTE ? { companyId: tenant.companies[0]!.id, partyId: PARTY, email: 'buyer@example.com' } : null
    },
  })
  const account = await addUser(h, tenant, { email: 'owner@example.com', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn('leak', account.email, account.password)
  ownerSecret = await enrolTotp(h, owner)
}, 60_000)

afterAll(async () => {
  withdraw?.()
  await h?.close()
})

const rows = async (sql: string, values: unknown[] = []) => (await h.db.admin.query(sql, values)).rows as Record<string, any>[]

/** Every keyless command of the office sign-in keeps a receipt until the returned function is called. */
function keepReceipts(auth: OfficeAuth, prefix: string): () => void {
  const original = auth.command
  auth.command = (context, spec, work) => original(context, { ...spec, idempotencyKey: spec.idempotencyKey ?? `${prefix}.${newId()}` }, work)
  return () => {
    auth.command = original
  }
}

describe('tokens are never stored', () => {
  it('in no receipt, audit row or event: invitation, session and link tokens, and their secrets', async () => {
    // 1. An invitation with an Idempotency-Key, sent twice: one mail, the repeat answers from its receipt.
    await stepUp(h, owner, ownerSecret)
    const inviteKey = `invite-${newId()}`
    const body = { email: 'new.person@example.com', displayName: 'New Person' }
    const first = await owner.post('/auth/invitations', body, { headers: { 'idempotency-key': inviteKey } })
    const repeat = await owner.post('/auth/invitations', body, { headers: { 'idempotency-key': inviteKey } })
    expect(first.status).toBe(200)
    expect(first.body.delivery).toBe('sent')
    expect(repeat.status).toBe(200)
    expect(repeat.body).toEqual({ invitation: first.body.invitation, delivery: 'already_sent' })
    expect(h.mailer.messages.filter((message) => message.kind === 'invitation' && message.to === body.email)).toHaveLength(1)
    const invitationToken = decodeURIComponent(h.mailer.last('invitation', body.email)!.link.split('#token=')[1]!)

    // 2. Accepting it starts a session: its cookie token and CSRF token.
    const guest = new Browser(h.app)
    await guest.get('/auth/csrf')
    const accepted = await guest.post('/auth/invitations/accept', { token: invitationToken, password: 'calm-meadow-river-91' })
    expect(accepted.status).toBe(200)
    const sessionToken = guest.cookies.get(SESSION_COOKIE)!
    const csrfToken = guest.cookies.get(CSRF_COOKIE)!
    expect(sessionToken).toBeDefined()

    // 3. A one-off link with an Idempotency-Key, made twice: the URL once; then the link is opened.
    const linkKey = `link-${newId()}`
    const made = await owner.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: QUOTE }, { headers: { 'idempotency-key': linkKey } })
    const madeAgain = await owner.post('/links', { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: QUOTE }, { headers: { 'idempotency-key': linkKey } })
    expect(made.status).toBe(201)
    expect(madeAgain.body).toEqual({ link: made.body.link, url: null })
    const linkToken = decodeURIComponent(made.body.url.split('#token=')[1]!)
    const openKey = `open-${newId()}`
    const opened = await h.app.inject({ method: 'POST', url: '/link/open', headers: { [LINK_HEADER]: linkToken, 'idempotency-key': openKey }, payload: {} })
    expect(opened.statusCode).toBe(200)

    // The receipts exist, so the scan below is not vacuous.
    const receipts = await rows('SELECT key FROM "IdempotencyReceipt" WHERE key = ANY($1)', [[inviteKey, linkKey, openKey]])
    expect(receipts.map((row) => row.key).sort()).toEqual([inviteKey, linkKey, openKey].sort())
    expect((await rows(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action IN ('users.invite', 'users.acceptInvitation', 'links.create', 'links.open')`))[0]!.n).toBeGreaterThanOrEqual(4)
    expect((await rows(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'link.used'`))[0]!.n).toBe(1)

    const secrets = {
      'invitation token': invitationToken,
      'invitation secret': invitationToken.split('.')[2]!,
      'session token': sessionToken,
      'session secret': sessionToken.split('.')[2]!,
      'csrf token': csrfToken,
      'link token': linkToken,
      'link secret': linkToken.split('.')[3]!,
    }
    for (const [label, secret] of Object.entries(secrets)) expect(secret.length, label).toBeGreaterThanOrEqual(40)
    for (const table of ['IdempotencyReceipt', 'AuditLog', 'OutboxEvent']) {
      const all = await rows(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`)
      expect(all.length, table).toBeGreaterThan(0)
      for (const [label, secret] of Object.entries(secrets)) {
        expect(all.filter((row) => (row.row as string).includes(secret)), `${label} in ${table}`).toEqual([])
      }
    }
  })

  it('in no receipt, audit row or event: a floor enrolment code, device token, badge code, floor session token and PIN', async () => {
    const companyId = tenant.companies[0]!.id
    const [siteId, centreId, stationId] = [newId(), newId(), newId()]
    await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
      await client.site.create({ data: { id: siteId, companyId, code: 'LK1', name: 'Leak plant', kind: 'PLANT' } })
      await client.workCentre.create({ data: { id: centreId, companyId, siteId, code: 'CUT', name: 'Cutting', kind: 'CUTTING' } })
      await client.station.create({ data: { id: stationId, companyId, siteId, workCentreId: centreId, code: 'CUT-01', name: 'Cutting table 1' } })
    })
    // 1. The Office enrols a device with an Idempotency-Key, twice: the code once; the tablet trades it for its token.
    const keyed = (prefix: string) => ({ headers: { 'idempotency-key': `${prefix}-${newId()}` } })
    const deviceKey = keyed('device')
    const device = await owner.post('/auth/floor/devices', { siteId, stationId, name: 'Leak tablet' }, deviceKey)
    const deviceAgain = await owner.post('/auth/floor/devices', { siteId, stationId, name: 'Leak tablet' }, deviceKey)
    expect(device.status).toBe(200)
    expect(deviceAgain.body).toMatchObject({ device: { id: device.body.device.id }, enrolment: null })
    const enrolmentCode = device.body.enrolment.code as string
    const tablet = new Browser(h.app)
    await tablet.get('/auth/csrf')
    expect((await tablet.post('/floor/device/enrol', { code: enrolmentCode })).status).toBe(200)
    const deviceToken = tablet.cookies.get(DEVICE_COOKIE)!

    // 2. A worker with a floor role, a badge and a reset PIN (step-up).
    await stepUp(h, owner, ownerSecret)
    const roleId = (await rows('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [tenant.id, 'operator']))[0]!.id
    const worker = await owner.post('/auth/floor/workers', { siteId, displayName: 'Leak Worker', roleIds: [roleId] })
    expect(worker.status).toBe(200)
    const badgeKey = keyed('badge')
    const resetKey = keyed('reset')
    const badge = await owner.post(`/auth/floor/workers/${worker.body.id}/badges`, {}, badgeKey)
    const reset = await owner.post(`/auth/floor/workers/${worker.body.id}/pin-reset`, {}, resetKey)
    expect([badge.status, reset.status]).toEqual([200, 200])
    // Repeats answer from their receipts: the first badge and reset stand, no secret is shown again.
    expect((await owner.post(`/auth/floor/workers/${worker.body.id}/badges`, {}, badgeKey)).body).toEqual({ badge: badge.body.badge, code: null, printed: null })
    expect((await owner.post(`/auth/floor/workers/${worker.body.id}/pin-reset`, {}, resetKey)).body).toEqual({ pin: null, pinMustChange: true })
    expect((await rows('SELECT count(*)::int AS n FROM "Badge" WHERE "workerId" = $1::uuid', [worker.body.id]))[0]!.n).toBe(1)

    // 3. The worker signs in with the badge and the reset PIN, then chooses a PIN.
    expect((await tablet.post('/floor/sign-in', { badgeCode: badge.body.code, pin: reset.body.pin })).status).toBe(200)
    const sessionToken = tablet.cookies.get(FLOOR_COOKIE)!
    const chosenPin = reset.body.pin === '905218' ? '730561' : '905218'
    expect((await tablet.post('/floor/pin', { currentPin: reset.body.pin, newPin: chosenPin })).status).toBe(200)

    // The floor commands kept receipts, and every step its audit row, so the scan below is not vacuous.
    const scopes = (await rows(`SELECT scope FROM "IdempotencyReceipt" WHERE scope LIKE 'floor.%' OR scope IN ('devices.enrol', 'workers.issueBadge', 'workers.resetPin')`)).map((row) => row.scope)
    expect(scopes).toEqual(expect.arrayContaining(['devices.enrol', 'workers.issueBadge', 'workers.resetPin', 'floor.enrolDevice', 'floor.signIn', 'floor.changePin']))
    const actions = (await rows(`SELECT DISTINCT action FROM "AuditLog" WHERE "tenantId" = $1::uuid`, [tenant.id])).map((row) => row.action)
    expect(actions).toEqual(expect.arrayContaining(['devices.enrol', 'floor.enrolDevice', 'workers.create', 'workers.issueBadge', 'workers.resetPin', 'floor.signIn', 'floor.changePin']))

    const secrets: Record<string, string> = {
      'enrolment code': enrolmentCode,
      'enrolment secret': enrolmentCode.split('.')[3]!,
      'device token': deviceToken,
      'device secret': deviceToken.split('.')[3]!,
      'badge code': badge.body.code,
      'badge code as printed': badge.body.printed,
      'floor session token': sessionToken,
      // A PIN is six digits: look for it as a JSON value, so a digit run inside an id or a hash is no false alarm.
      'reset PIN': `"${reset.body.pin}"`,
      'chosen PIN': `"${chosenPin}"`,
    }
    for (const table of ['IdempotencyReceipt', 'AuditLog', 'OutboxEvent']) {
      const all = await rows(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`)
      for (const [label, secret] of Object.entries(secrets)) {
        expect(all.filter((row) => (row.row as string).includes(secret)), `${label} in ${table}`).toEqual([])
      }
    }
    // And the floor rows hold only hashes.
    const stored = JSON.stringify(await rows('SELECT d."tokenHash", e."codeHash", b."codeHash" AS badge, w."pinHash" FROM "Device" d JOIN "DeviceEnrolment" e ON e."deviceId" = d.id JOIN "Worker" w ON w."siteId" = d."siteId" JOIN "Badge" b ON b."workerId" = w.id WHERE d."siteId" = $1::uuid', [siteId]))
    for (const [label, secret] of Object.entries(secrets)) expect(stored.includes(secret), label).toBe(false)
    expect(stored).toContain('$pin$')
  })

  it('in no receipt, audit row or event: office session, CSRF and reset tokens, the TOTP secret, codes and passwords', async () => {
    const prefix = `leak-office-${newId().slice(-12)}`
    const restore = keepReceipts(h.auth, prefix)
    try {
      const account = await addUser(h, tenant, { email: 'office.leak@example.com' })
      const secrets: Record<string, string> = {}
      const session = (label: string, browser: Browser) => {
        secrets[`${label} session token`] = browser.cookies.get(SESSION_COOKIE)!
        secrets[`${label} session secret`] = browser.cookies.get(SESSION_COOKIE)!.split('.')[2]!
        secrets[`${label} csrf token`] = browser.csrfToken!
      }
      // A TOTP code is six digits: look for it as a JSON value, so a digit run inside an id or a hash is no false alarm.
      const code = (label: string) => {
        const value = codeAt(h.clock, totpSecret)
        secrets[label] = `"${value}"`
        return value
      }

      // 1. A wrong password (its own command), then a password sign-in.
      expect((await new Browser(h.app).signIn('leak', account.email, 'wrong-guess-lantern-11')).status).toBe(401)
      secrets['wrong password'] = 'wrong-guess-lantern-11'
      const first = new Browser(h.app)
      expect((await first.signIn('leak', account.email, account.password)).body.status).toBe('signed_in')
      session('password sign-in', first)

      // 2. Two-factor set-up and confirm: the secret and the recovery codes, shown once.
      const setup = await first.post('/auth/office/totp/setup')
      expect(setup.status).toBe(200)
      const totpSecret = setup.body.secret as string
      secrets['TOTP secret'] = totpSecret
      const confirm = await first.post('/auth/office/totp/confirm', { code: code('confirm code') })
      expect(confirm.status).toBe(200)
      const recoveryCodes = confirm.body.recoveryCodes as string[]
      expect(recoveryCodes).toHaveLength(10)
      recoveryCodes.forEach((shown, index) => {
        secrets[`recovery code ${index + 1}`] = shown
        secrets[`recovery code ${index + 1} as stored`] = shown.replace('-', '')
      })
      h.clock.advance(30_000)

      // 3. A step-up and a refresh on that session.
      expect((await first.post('/auth/office/step-up', { code: code('step-up code') })).status).toBe(200)
      h.clock.advance(30_000)
      expect((await first.post('/auth/sessions/refresh')).status).toBe(200)

      // 4. A sign-in with a TOTP code, one with a recovery code, and a sign-out.
      const second = new Browser(h.app)
      expect((await second.signIn('leak', account.email, account.password, code('sign-in code'))).body.status).toBe('signed_in')
      session('TOTP sign-in', second)
      h.clock.advance(30_000)
      const third = new Browser(h.app)
      expect((await third.signIn('leak', account.email, account.password, recoveryCodes[0])).body.status).toBe('signed_in')
      session('recovery sign-in', third)
      expect((await third.post('/auth/office/sign-out')).status).toBe(200)

      // 5. A forced password change: the sign-in (with its code) answers a reset token instead of a session.
      await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: account.id }, (client) =>
        client.user.update({ where: { id: account.id }, data: { mustChangePassword: true } }),
      )
      const forced = await new Browser(h.app).signIn('leak', account.email, account.password, code('forced sign-in code'))
      h.clock.advance(30_000)
      expect(forced.body.status).toBe('password_change_required')
      const forcedToken = forced.body.resetToken as string
      secrets['forced reset token'] = forcedToken
      secrets['forced reset secret'] = forcedToken.split('.')[2]!
      const changed = 'amber-forest-violin-62'
      secrets['forced new password'] = changed
      expect((await new Browser(h.app).post('/auth/office/password/reset', { token: forcedToken, password: changed })).body).toEqual({ status: 'password_set' })

      // 6. A reset by email: the request and the confirm.
      const requested = await new Browser(h.app).post('/auth/office/password/reset-request', { tenant: 'leak', email: account.email })
      expect(requested.body).toEqual({ status: 'requested' })
      await h.auth.settled()
      const mailedToken = decodeURIComponent(h.mailer.last('password_reset', account.email)!.link.split('#token=')[1]!)
      secrets['mailed reset token'] = mailedToken
      secrets['mailed reset secret'] = mailedToken.split('.')[2]!
      const chosen = 'copper-island-meadow-73'
      secrets['reset new password'] = chosen
      expect((await new Browser(h.app).post('/auth/office/password/reset', { token: mailedToken, password: chosen })).body).toEqual({ status: 'password_set' })
      const last = new Browser(h.app)
      expect((await last.signIn('leak', account.email, chosen, code('last sign-in code'))).body.status).toBe('signed_in')
      h.clock.advance(30_000)
      session('after reset', last)

      // Every command kept a receipt, with its result in it, so the scan below is not vacuous.
      const receipts = await rows('SELECT scope, response FROM "IdempotencyReceipt" WHERE key LIKE $1', [`${prefix}.%`])
      expect(receipts.map((row) => row.scope)).toEqual(
        expect.arrayContaining([
          'auth.signInFailed',
          'auth.signIn',
          'auth.totpSetup',
          'auth.totpConfirm',
          'auth.stepUp',
          'auth.signOut',
          'auth.passwordChangeRequired',
          'auth.passwordReset',
          'auth.passwordResetRequest',
        ]),
      )

      for (const [label, secret] of Object.entries(secrets)) expect(secret?.length ?? 0, label).toBeGreaterThanOrEqual(8)
      for (const table of ['IdempotencyReceipt', 'AuditLog', 'OutboxEvent']) {
        const all = await rows(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`)
        for (const [label, secret] of Object.entries(secrets)) {
          expect(all.filter((row) => (row.row as string).includes(secret)), `${label} in ${table}`).toEqual([])
        }
      }
      // And the results the receipts keep are the secret-free ones: a session's or a reset's id and expiries.
      const result = (scope: string) => receipts.find((row) => row.scope === scope)!.response.result
      expect(Object.keys(result('auth.signIn')).sort()).toEqual(['absoluteExpiresAt', 'companyId', 'id', 'idleExpiresAt'])
      expect(Object.keys(result('auth.passwordChangeRequired')).sort()).toEqual(['expiresAt', 'id'])
      expect(Object.keys(result('auth.passwordResetRequest')).sort()).toEqual(['expiresAt', 'id'])
    } finally {
      restore()
    }
  })
})
