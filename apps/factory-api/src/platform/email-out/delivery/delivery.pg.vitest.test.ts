import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { moveLiftsAll } from './lift-catch-up'

/**
 * The mail delivery log and the blocked addresses on the local stack (B-W2a-41; PLT-149), with the app's real routes:
 * every mail of the reader's companies with its state, its record and the one-off link it carried (bounced invoices
 * and links visible), addresses masked unless the reader manages that company's mail; the tenant-wide blocked list;
 * the unblock (a reason, the version, a grant over every company), audited, with its event, the row kept and the
 * address freed (a later bounce blocks it again). Another tenant never.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyB = newId()
const user = newId()
const ses = newId()
const sesB = newId()
const identityOne = newId()
const identityTwo = newId()
const identityB = newId()
const party = newId()
const invoiceId = newId()
const shipmentId = newId()
const mail = { bounced: newId(), linked: newId(), queued: newId(), failed: newId(), digest: newId(), two: newId(), other: newId() }
const blocked = { ada: newId(), spam: newId(), other: newId() }

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['email.delivery.view', 'email.delivery.unblock', 'email.manage'])] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['email.delivery.view', 'email.delivery.unblock', 'email.manage'], [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['email.delivery.view'], [companyOne])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'])] },
}

const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
type Mail = { id: string; kind: string; state: string; status: string; to: string[]; fullAddresses: boolean; record: { type: string; id: string; label: string | null } | null; link: string | null; problem: string | null; notifications: number | null }
type Blocked = { id: string; address: string; fullAddress: boolean; reason: string; mail: { id: string } | null; unblocked: { reason: string | null; byId: string | null } | null; version: number }

async function outbound(id: string, tenantId: string, companyId: string, identityId: string, at: Date, path: readonly string[], extra: { recordType?: string; recordId?: string; templateKey?: string; to?: string; lastError?: string } = {}) {
  await db.admin.query(
    `INSERT INTO "EmailOutbound" (id, "tenantId", "companyId", "identityId", "recordType", "recordId", "templateKey", locale, "fromAddress", "fromName", "to", subject, "emailMessageId", "queuedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'it', 'noreply@mail-a.example.com', 'Esempio', $8, 'Fattura', $9, $10)`,
    [id, tenantId, companyId, identityId, extra.recordType ?? null, extra.recordId ?? null, extra.templateKey ?? 'thread.message', [extra.to ?? 'ada@cliente.example'], `<${id}@mail-a.example.com>`, at],
  )
  for (const status of path) {
    const column = { SENDING: null, SENT: 'sentAt', DELIVERED: 'deliveredAt', BOUNCED: 'bouncedAt', COMPLAINED: 'complainedAt', FAILED: 'failedAt' }[status]
    await db.admin.query(`UPDATE "EmailOutbound" SET status = $2::"EmailOutboundStatus"${column ? `, "${column}" = $3` : ''}${status === 'SENDING' ? ', attempts = attempts + 1' : ''}${extra.lastError && (status === 'BOUNCED' || status === 'FAILED') ? `, "lastError" = '${extra.lastError}'` : ''} WHERE id = $1`, column ? [id, status, new Date(at.getTime() + 60_000)] : [id, status])
  }
}

beforeAll(async () => {
  db = await migratedDatabase('email_delivery')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'dl-a', [companyOne, companyTwo]],
    [tenantB, 'dl-b', [companyB]],
  ] as const) {
    await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
  }
  for (const [id, tenantId] of [[ses, tenantA], [sesB, tenantB]] as const) {
    await db.admin.query(`INSERT INTO "IntegrationAccount" (id, "tenantId", "companyId", provider, code, label, mode) VALUES ($1, $2, NULL, 'SES', 'ses', 'ses', 'FAKE')`, [id, tenantId])
  }
  for (const [id, tenantId, companyId, accountId] of [[identityOne, tenantA, companyOne, ses], [identityTwo, tenantA, companyTwo, ses], [identityB, tenantB, companyB, sesB]] as const) {
    await db.admin.query(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "replyDomain", "accountId", "verificationStatus", "dkimStatus")
       VALUES ($1, $2, $3, 'CONVERSATION', 'mail-a.example.com', $5, 'Esempio', 'reply.mail-a.example.com', $4, 'SUCCESS', 'SUCCESS')`,
      [id, tenantId, companyId, accountId, `noreply-${id.slice(-4)}@mail-a.example.com`],
    )
  }
  await db.admin.query(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'CLI-1', 'ORGANISATION', 'Cliente Esempio', '{CUSTOMER}')`, [party, tenantA, companyOne])
  await db.admin.query(
    `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", email, "expiresAt", "maxUses", "createdById")
     VALUES ($1, $2, $3, $4, 'DOCUMENT_VIEW', 'Shipment', $5, $6, 'bea@cliente.example', now() + interval '30 days', 5, $7)`,
    [newId(), tenantA, companyOne, party, shipmentId, `hash-${newId()}`, user],
  )
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 8, minutes))
  await outbound(mail.bounced, tenantA, companyOne, identityOne, t(1), ['SENDING', 'SENT', 'BOUNCED'], { recordType: 'Invoice', recordId: invoiceId, lastError: 'Permanent/General' })
  await outbound(mail.linked, tenantA, companyOne, identityOne, t(2), ['SENDING', 'SENT', 'DELIVERED'], { recordType: 'Shipment', recordId: shipmentId, to: 'bea@cliente.example' })
  await outbound(mail.queued, tenantA, companyOne, identityOne, t(3), [], { recordType: 'Shipment', recordId: shipmentId, to: 'carla@cliente.example' })
  await outbound(mail.failed, tenantA, companyOne, identityOne, t(4), ['SENDING', 'FAILED'], { recordType: 'Party', recordId: party, to: 'dario@cliente.example', lastError: 'suppressed: 1 recipient(s) bounced or complained before' })
  await outbound(mail.digest, tenantA, companyOne, identityOne, t(5), ['SENDING', 'SENT'], { recordType: 'User', recordId: user, templateKey: 'notifications.digest', to: 'staff@mail-a.example.com' })
  await outbound(mail.two, tenantA, companyTwo, identityTwo, t(6), ['SENDING', 'SENT'], { recordType: 'Party', recordId: party, to: 'eva@altro.example' })
  await outbound(mail.other, tenantB, companyB, identityB, t(7), ['SENDING', 'SENT'], { to: 'b@other.example' })
  for (const [id, tenantId, address, reason, outboundId] of [
    [blocked.ada, tenantA, 'ada@cliente.example', 'BOUNCE', mail.bounced],
    [blocked.spam, tenantA, 'spam@altro.example', 'COMPLAINT', mail.two],
    [blocked.other, tenantB, 'b@other.example', 'BOUNCE', null],
  ] as const) {
    await db.admin.query(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at, detail, "outboundId") VALUES ($1, $2, $3, $4, $5, 'Permanent/General', $6)`, [id, tenantId, address, reason, t(10), outboundId])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('GET /email/delivery', () => {
  it('lists every mail of the companies with its state, record, link and problem; full addresses for a mail admin', async () => {
    const response = await call('admin', 'GET', '/email/delivery')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { mails: Mail[]; counts: Record<string, number>; blocked: number; nextBefore: string | null }
    expect(body.mails.map((row) => row.id)).toEqual([mail.two, mail.digest, mail.failed, mail.queued, mail.linked, mail.bounced])
    const bounced = body.mails.find((row) => row.id === mail.bounced)!
    expect(bounced).toMatchObject({ kind: 'RECORD', state: 'PROBLEM', status: 'BOUNCED', to: ['ada@cliente.example'], fullAddresses: true, record: { type: 'Invoice', id: invoiceId }, problem: 'Permanent/General', link: null })
    expect(body.mails.find((row) => row.id === mail.linked)).toMatchObject({ state: 'DELIVERED', link: 'DOCUMENT_VIEW', record: { type: 'Shipment' } })
    expect(body.mails.find((row) => row.id === mail.digest)).toMatchObject({ kind: 'DIGEST', record: { type: 'User', label: null }, notifications: 0 })
    expect(body.mails.find((row) => row.id === mail.failed)).toMatchObject({ state: 'FAILED', record: { type: 'Party', label: 'CLI-1 Cliente Esempio' } })
    expect(body.counts).toEqual({ WAITING: 1, SENT: 2, DELIVERED: 1, PROBLEM: 1, FAILED: 1 })
    expect(body.blocked).toBe(2)
    expect(JSON.stringify(body)).not.toMatch(/b@other\.example|Fattura|reply\.mail-a/)
  })

  it('masks the addresses and keeps to the companies of a reader who does not manage mail; filters by state, invoices, links', async () => {
    const body = (await call('viewer', 'GET', '/email/delivery')).json() as { mails: Mail[] }
    expect(body.mails.map((row) => row.id)).not.toContain(mail.two)
    expect(body.mails.find((row) => row.id === mail.bounced)).toMatchObject({ to: ['a•••@cliente.example'], fullAddresses: false })
    expect(((await call('viewer', 'GET', '/email/delivery?state=PROBLEM')).json() as { mails: Mail[] }).mails.map((row) => row.id)).toEqual([mail.bounced])
    expect(((await call('viewer', 'GET', '/email/delivery?about=INVOICES')).json() as { mails: Mail[] }).mails.map((row) => row.id)).toEqual([mail.bounced])
    expect(((await call('viewer', 'GET', '/email/delivery?about=LINKS')).json() as { mails: Mail[] }).mails.map((row) => row.id)).toEqual([mail.queued, mail.linked])
    expect((await call('viewer', 'GET', `/email/delivery?companyId=${companyTwo}`)).statusCode).toBe(403)
    expect((await call('nobody', 'GET', '/email/delivery')).statusCode).toBe(403)
  })

  it('pages newest first', async () => {
    const first = (await call('admin', 'GET', '/email/delivery?limit=4')).json() as { mails: Mail[]; nextBefore: string }
    expect(first.mails).toHaveLength(4)
    const next = (await call('admin', 'GET', `/email/delivery?limit=4&before=${first.nextBefore}`)).json() as { mails: Mail[]; nextBefore: string | null }
    expect(next.mails.map((row) => row.id)).toEqual([mail.linked, mail.bounced])
    expect(next.nextBefore).toBeNull()
  })
})

describe('the blocked addresses', () => {
  it('lists the tenant\'s blocked addresses with why and the mail that blocked them; masked for a reader', async () => {
    const admin = (await call('admin', 'GET', '/email/blocked')).json() as { addresses: Blocked[]; canUnblock: boolean }
    expect(admin.canUnblock).toBe(true)
    expect(admin.addresses.map((row) => [row.address, row.reason])).toEqual([
      ['spam@altro.example', 'COMPLAINT'],
      ['ada@cliente.example', 'BOUNCE'],
    ])
    expect(admin.addresses.find((row) => row.id === blocked.ada)).toMatchObject({ fullAddress: true, mail: { id: mail.bounced } })
    const viewer = (await call('viewer', 'GET', '/email/blocked')).json() as { addresses: Blocked[]; canUnblock: boolean }
    expect(viewer.canUnblock).toBe(false)
    expect(viewer.addresses.find((row) => row.id === blocked.ada)).toMatchObject({ address: 'a•••@cliente.example', fullAddress: false, mail: { id: mail.bounced } })
    // The complaint came on a mail of company two, which this reader does not see.
    expect(viewer.addresses.find((row) => row.id === blocked.spam)).toMatchObject({ mail: null })
    expect((await call('nobody', 'GET', '/email/blocked')).statusCode).toBe(403)
  })

  it('unblocks with a reason and the version: the row stays, audited, the address free again; refused without the right, stale, or twice', async () => {
    expect((await call('viewer', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 1, reason: 'Mailbox fixed' })).statusCode).toBe(403)
    expect((await call('admin-one', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 1, reason: 'Mailbox fixed' })).statusCode).toBe(403)
    expect((await call('admin', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 9, reason: 'Mailbox fixed' })).statusCode).toBe(409)
    expect((await call('admin', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 1, reason: ' ' })).statusCode).toBe(400)
    const done = await call('admin', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 1, reason: 'The customer fixed the mailbox' })
    expect(done.statusCode).toBe(200)
    expect((done.json() as { address: Blocked }).address).toMatchObject({ id: blocked.ada, address: 'ada@cliente.example', version: 2, unblocked: { reason: 'The customer fixed the mailbox', byId: user } })
    expect((await call('admin', 'POST', `/email/blocked/${blocked.ada}/unblock`, { version: 2, reason: 'Again' })).statusCode).toBe(409)

    // B-W2b-24: lifted in its columns; the row keeps its address (and never changes again).
    const [row] = (await db.admin.query(`SELECT address, reason, "liftedById", "liftReason", "liftedAt" IS NOT NULL AS lifted FROM "Suppression" WHERE id = $1`, [blocked.ada])).rows as Record<string, unknown>[]
    expect(row).toEqual({ address: 'ada@cliente.example', reason: 'BOUNCE', liftedById: user, liftReason: 'The customer fixed the mailbox', lifted: true })
    expect((await db.admin.query(`SELECT 1 FROM "Suppression" WHERE "tenantId" = $1 AND address = 'ada@cliente.example' AND "liftedAt" IS NULL`, [tenantA])).rowCount).toBe(0)
    const audits = (await db.admin.query(`SELECT action, reason, before, after FROM "AuditLog" WHERE "recordType" = 'Suppression' AND "recordId" = $1`, [blocked.ada])).rows
    expect(audits).toEqual([{ action: 'email.unblockAddress', reason: 'The customer fixed the mailbox', before: { blocked: true, reason: 'BOUNCE' }, after: { blocked: false } }])
    expect(JSON.stringify(audits)).not.toContain('ada@')
    const events = (await db.admin.query(`SELECT type, payload FROM "OutboxEvent" WHERE type = 'email.address_unblocked'`)).rows
    expect(events).toEqual([{ type: 'email.address_unblocked', payload: { suppressionId: blocked.ada, reason: 'BOUNCE' } }])

    const lists = (await call('admin', 'GET', '/email/blocked')).json() as { addresses: Blocked[] }
    expect(lists.addresses.map((item) => item.id)).toEqual([blocked.spam])
    const unblocked = (await call('admin', 'GET', '/email/blocked?state=UNBLOCKED')).json() as { addresses: Blocked[] }
    expect(unblocked.addresses).toEqual([expect.objectContaining({ id: blocked.ada, address: 'ada@cliente.example', unblocked: expect.objectContaining({ reason: 'The customer fixed the mailbox' }) })])
    expect(((await call('admin', 'GET', '/email/delivery')).json() as { blocked: number }).blocked).toBe(1)
    // A later bounce blocks the address again in a new row: the unblocked one does not stand in the way.
    const again = newId()
    await db.admin.query(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at) VALUES ($1, $2, 'ada@cliente.example', 'BOUNCE', now())`, [again, tenantA])
    expect(((await call('admin', 'GET', '/email/blocked')).json() as { addresses: Blocked[] }).addresses.map((item) => item.id).sort()).toEqual([again, blocked.spam].sort())
    // Only one block in force per address (the partial unique index).
    await expect(db.admin.query(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at) VALUES ($1, $2, 'ada@cliente.example', 'BOUNCE', now())`, [newId(), tenantA])).rejects.toThrow(/Suppression_one_block_per_address/)
  })

  it('B-W2b-24: moves a block B-W2a-41 lifted by moving its address aside back to its address, with the lift from its audit row', async () => {
    const legacy = newId()
    await db.admin.query(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at) VALUES ($1, $2, $3, 'BOUNCE', now())`, [legacy, tenantA, `~unblocked:${legacy}:bea@cliente.example`])
    await db.admin.query(`INSERT INTO "AuditLog" (id, "tenantId", at, "actorId", audience, action, "recordType", "recordId", "requestId", reason) VALUES ($1, $2, now() - interval '2 days', $3, 'OFFICE', 'email.unblockAddress', 'Suppression', $4, 'old-request', 'Typo fixed by the customer')`, [newId(), tenantA, user, legacy])
    // Before the move every reader already counts it as lifted.
    expect(((await call('admin', 'GET', '/email/blocked?state=UNBLOCKED')).json() as { addresses: Blocked[] }).addresses.find((item) => item.id === legacy)).toMatchObject({ address: 'bea@cliente.example', unblocked: { reason: 'Typo fixed by the customer', byId: user } })
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
    expect(await moveLiftsAll({ database, log })).toMatchObject({ moved: 1, failed: 0 })
    const [row] = (await db.admin.query(`SELECT address, "liftedById", "liftReason", "liftedAt" < now() - interval '1 day' AS old FROM "Suppression" WHERE id = $1`, [legacy])).rows as Record<string, unknown>[]
    expect(row).toEqual({ address: 'bea@cliente.example', liftedById: user, liftReason: 'Typo fixed by the customer', old: true })
    expect(await moveLiftsAll({ database, log })).toMatchObject({ moved: 0 })
    expect(((await call('admin', 'GET', '/email/blocked?state=UNBLOCKED')).json() as { addresses: Blocked[] }).addresses.find((item) => item.id === legacy)).toMatchObject({ address: 'bea@cliente.example', unblocked: { reason: 'Typo fixed by the customer', byId: user } })
  })

  it('never shows another tenant\'s addresses', async () => {
    const body = (await call('admin', 'GET', '/email/blocked')).json() as { addresses: Blocked[] }
    expect(body.addresses.map((row) => row.address)).not.toContain('b@other.example')
    expect((await call('admin', 'POST', `/email/blocked/${blocked.other}/unblock`, { version: 1, reason: 'Not ours' })).statusCode).toBe(404)
  })
})
