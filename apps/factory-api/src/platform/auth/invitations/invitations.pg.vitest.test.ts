import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '../sessions/cookies'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { addTenant, addUser, Browser, codeAt, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'

/** The expiry of an invitation made now. The clock only moves forward in this file: the owner's codes must stay new. */
const inThreeDays = () => toUtcIso(new Date(h.clock.now().getTime() + 72 * 60 * 60_000))

/**
 * Invitations on the local stack: an owner (two-factor, step-up) invites an address, the link reaches only the mail
 * seam, the invited person previews and accepts it once, and is then an active user with a session. Revoking, inviting
 * again and the refusals.
 */

let h: Harness
let tenant: TestTenant
let owner: Browser
let ownerSecret: string

const tokenOf = (email: string): string => {
  const message = h.mailer.last('invitation', email)
  if (!message) throw new Error(`no invitation mailed to ${email}`)
  return decodeURIComponent(message.link.split('#token=')[1]!)
}

beforeAll(async () => {
  h = await startHarness('auth_invitations')
  tenant = await addTenant(h, 'gamma')
  const account = await addUser(h, tenant, { email: 'owner@example.com', isOwner: true })
  owner = new Browser(h.app)
  await owner.signIn('gamma', account.email, account.password)
  ownerSecret = await enrolTotp(h, owner)
}, 60_000)

afterAll(async () => {
  await h?.close()
})

describe('invite and accept', () => {
  it('needs a step-up, then invites; the link goes to the mail seam only', async () => {
    const refused = await owner.post('/auth/invitations', { email: 'new.person@example.com', displayName: 'New Person' })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])

    await stepUp(h, owner, ownerSecret)
    const expiresAt = inThreeDays()
    const invited = await owner.post('/auth/invitations', { email: ' New.Person@Example.com', displayName: 'New Person' })
    expect(invited.status).toBe(200)
    expect(invited.body).toEqual({ invitation: { id: expect.any(String), userId: expect.any(String), email: 'new.person@example.com', expiresAt } })
    expect(JSON.stringify(invited.body)).not.toMatch(/token|#/)
    const message = h.mailer.last('invitation', 'new.person@example.com')!
    expect(message).toMatchObject({ tenantId: tenant.id, userId: invited.body.invitation.userId, link: expect.stringMatching(/^http:\/\/localhost:3200\/accept-invitation#token=/) })

    const list = await owner.get('/auth/users')
    expect(list.body.users.find((user: { email: string }) => user.email === 'new.person@example.com')).toMatchObject({
      status: 'INVITED',
      invitationExpiresAt: expiresAt,
    })
  })

  it('previews and accepts once: the person is active, signed in, and can sign in again', async () => {
    const token = tokenOf('new.person@example.com')
    const guest = new Browser(h.app)
    const preview = await guest.post('/auth/invitations/preview', { token })
    expect(preview.body).toEqual({ tenant: { name: 'Test group gamma' }, email: 'new.person@example.com', displayName: 'New Person', expiresAt: expect.any(String) })

    expect((await guest.post('/auth/invitations/accept', { token, password: 'calm-meadow-river-91' })).status).toBe(403) // no CSRF token yet
    await guest.get('/auth/csrf')
    expect((await guest.post('/auth/invitations/accept', { token, password: 'short' })).status).toBe(400)
    const accepted = await guest.post('/auth/invitations/accept', { token, password: 'calm-meadow-river-91', displayName: 'New P.' })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ status: 'signed_in', user: { email: 'new.person@example.com', displayName: 'New P.' }, mfa: { required: false, satisfied: true } })
    expect(guest.cookies.has(SESSION_COOKIE)).toBe(true)
    expect((await guest.get('/auth/office/me')).body.permissions).toEqual([])

    const again = new Browser(h.app)
    await again.get('/auth/csrf')
    expect((await again.post('/auth/invitations/accept', { token, password: 'calm-meadow-river-92' })).status).toBe(404)
    expect((await again.post('/auth/invitations/preview', { token })).status).toBe(404)
    expect((await new Browser(h.app).signIn('gamma', 'new.person@example.com', 'calm-meadow-river-91')).body.status).toBe('signed_in')
  })

  it('refuses an address that is already a user, and a member without the permission', async () => {
    await stepUp(h, owner, ownerSecret)
    expect((await owner.post('/auth/invitations', { email: 'new.person@example.com', displayName: 'Again' })).status).toBe(409)
    expect((await owner.post('/auth/invitations', { email: 'not an email', displayName: 'Nobody' })).status).toBe(400)
    const member = new Browser(h.app)
    await member.signIn('gamma', 'new.person@example.com', 'calm-meadow-river-91')
    expect((await member.post('/auth/invitations', { email: 'x@example.com', displayName: 'X' })).status).toBe(403)
  })

})

describe('revoke and invite again', () => {
  it('a revoked invitation opens nothing; inviting again sends a new link to the same user', async () => {
    await stepUp(h, owner, ownerSecret)
    const first = await owner.post('/auth/invitations', { email: 'revoked@example.com', displayName: 'Revoked Person' })
    const firstToken = tokenOf('revoked@example.com')
    const revoked = await owner.post(`/auth/invitations/${first.body.invitation.id}/revoke`)
    expect(revoked.status).toBe(200)
    expect((await owner.post(`/auth/invitations/${first.body.invitation.id}/revoke`)).status).toBe(409)
    const users = (await owner.get('/auth/users')).body.users as { id: string; status: string }[]
    expect(users.find((user) => user.id === first.body.invitation.userId)?.status).toBe('DEACTIVATED')

    const guest = new Browser(h.app)
    await guest.get('/auth/csrf')
    expect((await guest.post('/auth/invitations/accept', { token: firstToken, password: 'calm-meadow-river-94' })).status).toBe(404)

    const second = await owner.post('/auth/invitations', { email: 'revoked@example.com', displayName: 'Revoked Person' })
    expect(second.status).toBe(200)
    expect(second.body.invitation.userId).toBe(first.body.invitation.userId)
    expect((await guest.post('/auth/invitations/accept', { token: tokenOf('revoked@example.com'), password: 'calm-meadow-river-94' })).status).toBe(200)
  })

  it('a resent invitation stops the earlier link', async () => {
    await stepUp(h, owner, ownerSecret)
    await owner.post('/auth/invitations', { email: 'resent@example.com', displayName: 'Resent Person' })
    const early = tokenOf('resent@example.com')
    await owner.post('/auth/invitations', { email: 'resent@example.com', displayName: 'Resent Person' })
    const late = tokenOf('resent@example.com')
    expect(late).not.toBe(early)
    const guest = new Browser(h.app)
    expect((await guest.post('/auth/invitations/preview', { token: early })).status).toBe(404)
    expect((await guest.post('/auth/invitations/preview', { token: late })).status).toBe(200)
  })

  it('the step-up expires after 5 minutes and a code works once', async () => {
    const code = codeAt(h.clock, ownerSecret)
    expect((await owner.post('/auth/office/step-up', { code })).status).toBe(200)
    expect((await owner.post('/auth/office/step-up', { code })).status).toBe(400)
    expect((await owner.post('/auth/invitations', { email: 'window@example.com', displayName: 'Window' })).status).toBe(200)
    h.clock.advance(5 * 60_000)
    expect((await owner.post('/auth/invitations', { email: 'window2@example.com', displayName: 'Window Two' })).status).toBe(403)
  })
})

// Last: it moves the clock past every session of this file.
describe('expiry', () => {
  it('an invitation expires after 72 hours', async () => {
    await stepUp(h, owner, ownerSecret)
    await owner.post('/auth/invitations', { email: 'late@example.com', displayName: 'Late Person' })
    const token = tokenOf('late@example.com')
    h.clock.advance(72 * 60 * 60_000)
    const guest = new Browser(h.app)
    await guest.get('/auth/csrf')
    expect((await guest.post('/auth/invitations/accept', { token, password: 'calm-meadow-river-93' })).status).toBe(404)
  })
})
