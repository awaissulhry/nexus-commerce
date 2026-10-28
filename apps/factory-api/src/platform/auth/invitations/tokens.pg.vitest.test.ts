import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { LINK_HEADER } from '../../links/authenticator'
import { registerLinkRecordSource } from '../../links/records'
import { CSRF_COOKIE, SESSION_COOKIE } from '../sessions/cookies'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * No token is ever stored where a database read could find it (plan A1 §3.10, §5.4): an invitation link, the session
 * it starts and a one-off link are minted OUTSIDE their commands, so neither an Idempotency-Key receipt (which stores a
 * command's result), nor an audit row, nor an outbox event holds the token or its secret. A repeated keyed request
 * answers from its receipt without the token: the invitation says `already_sent` (no second mail), the link `url: null`.
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
})
