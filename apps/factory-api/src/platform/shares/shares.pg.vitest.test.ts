import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { SHARE_FIELDS } from '@nexus/factory-domain/shares/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedPricing, type PricingSeed } from '../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../adapters/ses/fake'
import { callerFor } from '../../core/command'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { storeGeneratedFile } from '../files/files'
import { systemContext } from '../outbox/system'
import { notifyShares } from './notify'

/**
 * Inviting a partner to one record on the local stack (B-W2b-200; COL-061, COL-062): a throwaway PostgreSQL 17 database from
 * the migrations (row-level security, the partner role's grants and the …_links_depth_w2b_guards are real), the real app with
 * an office owner, a production manager (sees invitations) and a planner (none) signed in, and RECORD_INVITE links through the
 * FAKE mailbox and the FAKE file store. The factory-db seeds give the order SEED-SO-0001 of customer P1; every name and address
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/shares`.
 */

let h: Harness
let owner: Browser
let manager: Browser
let planner: Browser
let pricing: PricingSeed
const NS = 'shares'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const DESIGNER = 'dana.designer@studio-p1.example'
const AGENT = 'aldo.agent@studio-p1.example'
const LAB = 'lia.lab@studio-p1.example'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `shares-${label}-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A request of the invited partner's phone: only the link's token, no cookie. */
async function viaLink(token: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await h.app.inject({
    method,
    url,
    headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'GET' ? {} : { 'idempotency-key': key('link') }) },
    ...(method === 'GET' ? {} : { payload: (body ?? {}) as object }),
  })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

const tokenOf = (text: string): string => decodeURIComponent(/#token=(\S+)/.exec(text)![1]!)
const pathsOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json; eventId: string }>('SELECT type, payload, id AS "eventId" FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const system = () => callerFor(h.database, systemContext(tenant, newId()))
const lastMail = (template: string, to: string) => h.ses.mails.filter((mail) => mail.templateKey === template && mail.to.includes(to)).at(-1)
const mailsTo = (template: string, to: string) => h.ses.mails.filter((mail) => mail.templateKey === template && mail.to.includes(to)).length
/** Every key of an answer, at any depth (a scan for money and office people). */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, inner]) => [name, ...keysOf(inner)]) : [])

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

async function fileOf(name: string, visibility: Array<'OFFICE' | 'LINK' | 'PARTNER'>, partyId: string | null): Promise<string> {
  const made = await storeGeneratedFile(h.files, system(), { companyId: companyA, recordType: 'SalesOrder', recordId: pricing.money.sales.orderId, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', body: Buffer.from(`%PDF-1.4\n% made-up ${name}\n%%EOF\n`), visibility, partyId })
  return made.id
}

beforeAll(async () => {
  h = await startHarness('shares')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  pricing = await seedPricing({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses-sh', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  for (const kind of ['CONVERSATION', 'NOTIFICATION']) {
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
       SELECT $1, $2, $3, $4::"EmailIdentityKind", 'mail.seed-a.example.com', $5, 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $6, 'SUCCESS', 'SUCCESS', true
       WHERE NOT EXISTS (SELECT 1 FROM "EmailIdentity" WHERE "tenantId" = $2 AND "companyId" = $3 AND kind = $4::"EmailIdentityKind" AND "isDefault")`,
      [newId(), tenant, companyA, kind, kind === 'CONVERSATION' ? 'vendite@mail.seed-a.example.com' : 'avvisi@mail.seed-a.example.com', ses],
    )
  }
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  owner = await officeBrowser(seedTenant, 'olga.owner@seed-a.example.com', 'owner')
  manager = await officeBrowser(seedTenant, 'pietro.pm@seed-a.example.com', 'production_manager')
  planner = await officeBrowser(seedTenant, 'paola.planner@seed-a.example.com', 'planner')
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('a designer invited to an order: shared fields, files and the thread, comment, upload, e-mail me (COL-061, COL-062)', () => {
  let order = ''
  let shareId = ''
  let token = ''
  let shared = ''
  let officeOnly = ''

  it('the office sees the order\'s partner and nobody invited yet; a planner learns nothing of it', async () => {
    order = pricing.money.sales.orderId
    shared = await fileOf('Made-up tech pack.pdf', ['OFFICE', 'LINK'], P1)
    officeOnly = await fileOf('Made-up cost sheet.pdf', ['OFFICE'], null)
    const read = await as(owner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)
    expect(read).toMatchObject({ record: { type: 'SalesOrder', id: order }, party: { id: P1 }, held: null, may: { invite: true }, shares: [] })
    expect((await as(manager, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)).may.invite).toBe(false)
    await as(planner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`, undefined, 403)
    // A record type nobody outside can be invited to.
    expect(pathsOf(await as(owner, 'GET', `/shares?recordType=PayrollExport&recordId=${order}`, undefined, 400))).toEqual(['query/recordType'])
  })

  it('invites by e-mail: the RECORD_INVITE link and the share in one command, the link ending with the share, the mail with the link', async () => {
    const until = new Date(h.clock.now().getTime() + 20 * 86_400_000).toISOString()
    const made = await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: DESIGNER, permissions: ['COMMENT'], expiresAt: until, note: 'Please check the collar.', send: true, language: 'en' }, 201)
    expect(made).toMatchObject({ url: null, delivery: 'SENT', share: { email: DESIGNER, permissions: ['VIEW', 'COMMENT'], state: 'LIVE', notifyByEmail: true, invitedBy: expect.any(String), may: { change: true, revoke: true } } })
    shareId = made.share.id
    const row = await one('SELECT permissions::text[] AS permissions, "partyId", "linkId", "expiresAt" FROM "RecordShare" WHERE id = $1', [shareId])
    const link = await one('SELECT purpose, "recordType", "recordId", "partyId", "expiresAt", "maxUses", uses, email FROM "OneOffLink" WHERE id = $1', [row.linkId])
    expect(row).toMatchObject({ permissions: ['VIEW', 'COMMENT'], partyId: P1 })
    expect(link).toMatchObject({ purpose: 'RECORD_INVITE', recordType: 'SalesOrder', recordId: order, partyId: P1, maxUses: 1, uses: 0, email: DESIGNER })
    expect(new Date(link.expiresAt).getTime()).toBe(new Date(row.expiresAt).getTime())
    const mail = textOf(lastMail('shares.invite', DESIGNER)!.raw)
    expect(mail).toContain('Please check the collar.')
    expect(mail).toContain('read and write messages until')
    token = tokenOf(mail)
    expect((await eventsOf(shareId)).map((event) => event.type)).toEqual(['record_share.invited'])
    // REFUSED: the same address again while it lives; a person who may only see invitations; an end beyond 180 days.
    expect(pathsOf(await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: DESIGNER, permissions: [], send: false }, 409))).toEqual(['refusal/ALREADY_INVITED'])
    await as(manager, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: AGENT, permissions: [], send: false }, 403)
    const far = new Date(h.clock.now().getTime() + 181 * 86_400_000).toISOString()
    expect(pathsOf(await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: AGENT, permissions: [], expiresAt: far, send: false }, 400))).toEqual(['body/expiresAt'])
  })

  it('the link shows why, the shared fields only, the files shared with its links, and the thread; opening uses nothing', async () => {
    const page = await viaLink(token, 'GET', '/link/share?language=en')
    expect(page.share).toMatchObject({ id: shareId, permissions: ['VIEW', 'COMMENT'], notifyByEmail: true, invitedBy: expect.any(String) })
    expect(page.record.type).toBe('SalesOrder')
    expect(page.record.fields.map((field: Json) => field.key)).toEqual(SHARE_FIELDS.SalesOrder!.map(([name]) => name))
    expect(page.files.map((file: Json) => file.id)).toEqual([shared])
    expect(page.files.map((file: Json) => file.id)).not.toContain(officeOnly)
    expect(page.thread).toMatchObject({ shared: true, canPost: true, held: null })
    expect(page.upload).toMatchObject({ canUpload: false, held: 'NO_UPLOAD' })
    // Never money, cost, margin, pay or an office person's id.
    for (const name of keysOf(page)) expect(name).not.toMatch(/amount|price|cost|margin|pay|createdById|internalNote/i)
    expect(await one('SELECT uses FROM "OneOffLink" WHERE "recordId" = $1 AND purpose = \'RECORD_INVITE\' AND email = $2', [order, DESIGNER])).toEqual({ uses: 0 })
    // The generic files routes serve the shared file to the link, never the office's.
    expect((await viaLink(token, 'GET', `/files/${shared}/download`)).download.method).toBe('GET')
    await viaLink(token, 'GET', `/files/${officeOnly}/download`, undefined, 404)
  })

  it('posts on the order\'s thread as the invited person (evidence POSTED, never a use); the office reads it', async () => {
    const posted = await viaLink(token, 'POST', '/link/share/messages', { body: 'The collar looks right to me.' }, 201)
    expect(posted.message).toMatchObject({ side: 'PARTNER', author: { name: DESIGNER, mine: true }, body: 'The collar looks right to me.' })
    const row = await one('SELECT direction, audience, channel, "authorKind", "authorName", "authorId", "partyId" FROM "Message" WHERE id = $1', [posted.message.id])
    expect(row).toEqual({ direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: DESIGNER, authorId: null, partyId: P1 })
    expect(await admin('SELECT action FROM "LinkEvidence" WHERE "linkId" = (SELECT "linkId" FROM "RecordShare" WHERE id = $1) ORDER BY at', [shareId])).toEqual([{ action: 'POSTED' }])
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = (SELECT "linkId" FROM "RecordShare" WHERE id = $1)', [shareId])).toEqual({ uses: 0 })
    const thread = await as(owner, 'GET', `/threads/SalesOrder/${order}`)
    expect(JSON.stringify(thread)).toContain('The collar looks right to me.')
    const page = await viaLink(token, 'GET', '/link/share?language=en')
    expect(page.thread.messages[0]).toMatchObject({ id: posted.message.id, author: { mine: true } })
    // REFUSED: an upload the share does not allow; an empty post.
    expect(pathsOf(await viaLink(token, 'POST', '/link/share/files', { originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 403))).toEqual(['held/NO_UPLOAD'])
    expect(pathsOf(await viaLink(token, 'POST', '/link/share/messages', { body: '   ' }, 400))).toEqual(['body/body'])
    // Post, attach: a file of the order shared with its links goes with the message; the office's own file never.
    const withFile = await viaLink(token, 'POST', '/link/share/messages', { body: 'The tech pack, page 2.', attachments: [shared] }, 201)
    expect(withFile.message.attachments.map((file: Json) => file.id)).toEqual([shared])
    expect(pathsOf(await viaLink(token, 'POST', '/link/share/messages', { body: 'And this one.', attachments: [officeOnly] }, 400))).toEqual(['body/attachments/0'])
  })

  it('a share the office narrows refuses the next post; widened with UPLOAD, the person adds a file of the order, shared back with its links', async () => {
    const before = await as(owner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)
    const version = before.shares.find((share: Json) => share.id === shareId).version
    const narrowed = await as(owner, 'PUT', `/shares/${shareId}/permissions`, { permissions: ['VIEW'], version })
    expect(narrowed.share.permissions).toEqual(['VIEW'])
    expect(pathsOf(await viaLink(token, 'POST', '/link/share/messages', { body: 'One more thing.' }, 403))).toEqual(['held/NO_COMMENT'])
    expect((await viaLink(token, 'GET', '/link/share')).thread).toMatchObject({ canPost: false, held: 'NO_COMMENT' })
    // A stale version is refused in words.
    expect(pathsOf(await as(owner, 'PUT', `/shares/${shareId}/permissions`, { permissions: ['VIEW', 'UPLOAD'], version }, 409))).toEqual(['refusal/STALE'])
    await as(owner, 'PUT', `/shares/${shareId}/permissions`, { permissions: ['VIEW', 'UPLOAD'], version: narrowed.share.version })
    const bytes = Buffer.from('%PDF-1.4\n% made-up marked sketch\n%%EOF\n')
    const announced = await viaLink(token, 'POST', '/link/share/files', { originalName: 'Marked sketch.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 201)
    expect(announced.file.status).toBe('PENDING_UPLOAD')
    expect((await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBeLessThan(300)
    const completed = await viaLink(token, 'POST', `/link/share/files/${announced.file.id}/complete`)
    expect(completed.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE' })
    expect(await one('SELECT "recordType", "recordId"::text AS "recordId", kind::text AS kind, visibility::text[] AS visibility, "partyId"::text AS "partyId" FROM "StoredFile" WHERE id = $1', [announced.file.id])).toEqual({
      recordType: 'SalesOrder',
      recordId: order,
      kind: 'ATTACHMENT',
      visibility: ['OFFICE', 'LINK'],
      partyId: P1,
    })
    expect(await admin('SELECT action FROM "LinkEvidence" WHERE "linkId" = (SELECT "linkId" FROM "RecordShare" WHERE id = $1) ORDER BY action', [shareId])).toEqual([{ action: 'POSTED' }, { action: 'POSTED' }, { action: 'UPLOADED' }])
    const page = await viaLink(token, 'GET', '/link/share')
    expect(page.files.find((file: Json) => file.id === announced.file.id)).toMatchObject({ mine: true })
    expect((await as(owner, 'GET', `/files?recordType=SalesOrder&recordId=${order}`)).files.map((file: Json) => file.id)).toContain(announced.file.id)
  })

  it('"E-mail me": a post of another invited person mails the designer, never the writer; switched off, nothing', async () => {
    const second = await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: AGENT, permissions: ['COMMENT'], send: false }, 201)
    expect(second.url).toMatch(/#token=/)
    const agentToken = tokenOf(second.url)
    const before = mailsTo('shares.message', DESIGNER)
    const posted = await viaLink(agentToken, 'POST', '/link/share/messages', { body: 'Shipping the samples tomorrow.' }, 201)
    const event = (await eventsOf(order)).filter((row) => row.type === 'thread.message_posted' && row.payload.messageId === posted.message.id)[0]!
    expect(await notifyShares(system(), { eventId: event.eventId, type: event.type, payload: event.payload })).toBe(1)
    expect(mailsTo('shares.message', DESIGNER)).toBe(before + 1)
    expect(mailsTo('shares.message', AGENT)).toBe(0)
    const mail = textOf(lastMail('shares.message', DESIGNER)!.raw)
    expect(mail).toContain('Shipping the samples tomorrow.')
    expect(mail).not.toContain('#token=')
    // Replayed, nothing more goes.
    expect(await notifyShares(system(), { eventId: event.eventId, type: event.type, payload: event.payload })).toBe(0)
    // The designer switches it off: the next post mails nobody.
    expect(await viaLink(token, 'PUT', '/link/share/notify', { on: false })).toMatchObject({ notifyByEmail: false })
    expect((await as(owner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)).shares.find((share: Json) => share.id === shareId).notifyByEmail).toBe(false)
    const again = await viaLink(agentToken, 'POST', '/link/share/messages', { body: 'And the trims.' }, 201)
    const next = (await eventsOf(order)).filter((row) => row.type === 'thread.message_posted' && row.payload.messageId === again.message.id)[0]!
    expect(await notifyShares(system(), { eventId: next.eventId, type: next.type, payload: next.payload })).toBe(0)
    expect((await eventsOf(shareId)).map((row) => row.type)).toContain('record_share.changed')
  })

  it('REFUSED: a share revoked behind the link\'s back opens nothing anywhere; the office\'s revoke stops the share and its link together', async () => {
    const lab = await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: LAB, permissions: [], send: false }, 201)
    const labToken = tokenOf(lab.url)
    await viaLink(labToken, 'GET', '/link/share')
    // The share alone revoked (its link untouched): every request of the link is the one 404, the generic routes too.
    await admin('UPDATE "RecordShare" SET "revokedAt" = now(), version = version + 1 WHERE id = $1', [lab.share.id])
    await viaLink(labToken, 'GET', '/link/share', undefined, 404)
    await viaLink(labToken, 'GET', `/files/${shared}/download`, undefined, 404)
    await viaLink(labToken, 'GET', `/files?recordType=SalesOrder&recordId=${order}`, undefined, 404)
    // The office's revoke: the share and its link in one command.
    const current = (await as(owner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)).shares.find((share: Json) => share.id === shareId)
    const revoked = await as(owner, 'POST', `/shares/${shareId}/revoke`, { version: current.version })
    expect(revoked.share).toMatchObject({ state: 'REVOKED', may: { change: false, revoke: false }, revoked: { at: expect.any(String) } })
    expect(await one('SELECT "revokedAt" IS NOT NULL AS revoked FROM "OneOffLink" WHERE id = (SELECT "linkId" FROM "RecordShare" WHERE id = $1)', [shareId])).toEqual({ revoked: true })
    await viaLink(token, 'GET', '/link/share', undefined, 404)
    await viaLink(token, 'POST', '/link/share/messages', { body: 'Still here?' }, 404)
    expect((await eventsOf(shareId)).map((row) => row.type)).toContain('record_share.revoked')
    expect(pathsOf(await as(owner, 'POST', `/shares/${shareId}/revoke`, { version: revoked.share.version }, 409))).toEqual(['held/REVOKED'])
  })

  it('REFUSED: a share past its end opens nothing (the link ends with it)', async () => {
    const soon = new Date(h.clock.now().getTime() + 2 * 3_600_000).toISOString()
    const short = await as(owner, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email: 'sam.short@studio-p1.example', permissions: [], expiresAt: soon, send: false }, 201)
    const shortToken = tokenOf(short.url)
    await viaLink(shortToken, 'GET', '/link/share')
    h.clock.advance(3 * 3_600_000)
    await viaLink(shortToken, 'GET', '/link/share', undefined, 404)
    expect((await as(owner, 'GET', `/shares?recordType=SalesOrder&recordId=${order}`)).shares.find((share: Json) => share.id === short.share.id).state).toBe('EXPIRED')
  })
})
