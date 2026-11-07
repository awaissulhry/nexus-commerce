import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { sampleDocument } from '@nexus/factory-domain/documents/sample'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { headerOf, textOf } from '../../adapters/ses/fake'
import { buildApp } from '../../core/app'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { companyLegalOf } from '../documents/documents'
import { renderDocumentPdf } from '../documents/pdf'
import { deliverOutbound, threadMailBuilder } from '../email-out/outbound'
import { systemContext } from '../outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { useThreadRecords, type RecordScope } from '../threads/records'
import { forgetLogos } from './logo'

/**
 * Company branding (B-W2b-161; PLT-228, SAL-064) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, the CompanyBranding guard and the files guards are real), the real
 * office sign-in with two-factor and step-up, the FAKE file store and the FAKE mail provider. Two tenants; every name,
 * colour and picture is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/branding`.
 */

type Json = Record<string, any>

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let owner: Browser
let ownerSecret: string
let sales: Browser
let planner: Browser
let ownerB: Browser
let linkApp: FastifyInstance
let companyA: string
let companyA2: string
const quote = newId()
const party = newId()
const linkId = newId()

const admin = async (sql: string, values: unknown[] = []): Promise<Json[]> => (await h.db.admin.query(sql, values)).rows as Json[]
const first = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const put = (browser: Browser, url: string, body: unknown) => browser.send('PUT' as never, url, body)
const system = (tenantId = tenant.id): CommandCaller => callerFor(h.database, systemContext(tenantId, newId()))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A made-up solid PNG (8-bit RGB) of the given size and colour. */
function png(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
const LIGHT = png(120, 40, [0x1f, 0x5f, 0xa8])
const DARK = png(120, 40, [0xdd, 0xe6, 0xf2])

/** Announces a logo, sends its bytes to the store and confirms it: the answer of …/complete. */
async function upload(browser: Browser, companyId: string, bytes: Buffer, contentType = 'image/png', name = 'logo.png') {
  const announced = await browser.post(`/branding/${companyId}/logo`, { originalName: name, contentType, sizeBytes: bytes.length, sha256: sha(bytes) })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const stored = await h.app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })
  expect(stored.statusCode, stored.body).toBe(200)
  return browser.post(`/branding/${companyId}/logo/${announced.body.file.id}/complete`)
}

const EMPTY = { logoFileId: null, logoDarkFileId: null, accentColour: null, senderDisplayName: null, portalLabel: null }

/** A FAKE SES account with its webhook secret (as email out's own test makes one). */
async function sesAccount(tenantId: string): Promise<string> {
  const id = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'branding-test-webhook-secret' })
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SES', code: `ses-${id.slice(-12)}`, label: 'Mail FAKE', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return null
  })
  return id
}

async function signedIn(target: TestTenant, email: string, role: string, mfa: boolean): Promise<{ browser: Browser; secret: string }> {
  const user = await addUser(h, target, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(target.slug, user.email, user.password)
  if (answer.status !== 200) throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { browser, secret: mfa ? await enrolTotp(h, browser) : '' }
}

beforeAll(async () => {
  h = await startHarness('branding')
  forgetLogos()
  tenant = await addTenant(h, 'brand-a', 2)
  tenantB = await addTenant(h, 'brand-b')
  companyA = tenant.companies[0]!.id
  companyA2 = tenant.companies[1]!.id
  // Company C1's legal data (made up): the documents print it.
  await admin(
    `UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'FI', "reaNumber" = '123456', "shareCapital" = 10000, "tradeName" = 'Esempio Moto',
       pec = 'brand-a@pec.example.com', address = '{"line1":"Via Esempio 1","postalCode":"50100","city":"Firenze","province":"FI","country":"IT"}'::jsonb
     WHERE id = $1`,
    [companyA],
  )
  for (const id of [tenant.id, tenantB.id]) await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), id])
  const ses = await sesAccount(tenant.id)
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'brand-a.example.com', 'noreply@brand-a.example.com', 'Identity name C1', 'PERSON_VIA_COMPANY', 'reply.brand-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant.id, companyA, ses],
  )
  useThreadRecords({
    Quote: async (client, id): Promise<RecordScope | null> =>
      id === quote && (await client.company.findUnique({ where: { id: companyA }, select: { id: true } })) ? { companyId: companyA, siteId: null, partyId: party } : null,
  })
  ;({ browser: owner, secret: ownerSecret } = await signedIn(tenant, 'owner@brand-a.example.com', 'owner', true))
  ;({ browser: sales } = await signedIn(tenant, 'sales@brand-a.example.com', 'sales', true))
  ;({ browser: planner } = await signedIn(tenant, 'planner@brand-a.example.com', 'planner', false))
  ;({ browser: ownerB } = await signedIn(tenantB, 'owner@brand-b.example.com', 'owner', true))
  // A link of company C1 for one party (made up), and an app whose test sessions are that link.
  const token = `${tenant.id}.${party}.${linkId}.${randomBytes(16).toString('hex')}`
  await admin(
    `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", "expiresAt", "maxUses", "createdById")
     VALUES ($1, $2, $3, $4, 'DOCUMENT_VIEW', 'Quote', $5, $6, now() + interval '7 days', 5, $7)`,
    [linkId, tenant.id, companyA, party, quote, createHash('sha256').update(token).digest('hex'), newId()],
  )
  const linkGrant: Grant = { permissions: ['links.open'], companies: [companyA], sites: 'all', parties: [party] }
  const sessions: Record<string, SessionContext> = {
    link: { audience: 'link', tenantId: tenant.id, linkId, partyId: party, record: { type: 'Quote', id: quote }, grants: [linkGrant] },
    office: { audience: 'office', tenantId: tenant.id, actorId: newId(), grants: [{ permissions: ['links.open'], companies: 'all', sites: 'all', parties: 'all' }] },
  }
  linkApp = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await linkApp?.close()
  await h?.close()
}, 60_000)

describe('the office reads a company\'s branding (documents.view)', () => {
  it('an unbranded company: nothing saved, every name falls back to the company\'s, the DS colours', async () => {
    const read = await owner.get(`/branding?companyId=${companyA}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.branding).toEqual({
      companyId: companyA,
      companyName: 'Esempio Moto',
      saved: false,
      logo: null,
      logoDark: null,
      accentColour: null,
      senderDisplayName: null,
      portalLabel: null,
      shown: { portal: 'Esempio Moto', sender: 'Esempio Moto' },
      version: null,
      updatedAt: null,
      mayChange: true,
    })
    expect((await sales.get(`/branding?companyId=${companyA}`)).body.branding).toMatchObject({ mayChange: false })
  })

  it('refuses whoever may not see the company\'s documents, another tenant, and a partner', async () => {
    expect((await planner.get(`/branding?companyId=${companyA}`)).status).toBe(403)
    expect((await ownerB.get(`/branding?companyId=${companyA}`)).status).toBe(404)
    expect((await owner.get('/branding?companyId=not-a-company')).status).toBe(400)
    expect((await linkApp.inject({ method: 'GET', url: `/branding?companyId=${companyA}`, headers: { 'x-test-session': 'link' } })).statusCode).toBe(403)
  })
})

describe('saving the branding (documents.branding.manage, a fresh step-up)', () => {
  it('refuses what a page or a mail header cannot carry, in words, before any code is asked', async () => {
    const answer = await put(owner, `/branding/${companyA}`, { ...EMPTY, accentColour: 'blue', senderDisplayName: 'Esempio <noreply@example.com>', logoDarkFileId: newId() })
    expect(answer.status).toBe(400)
    expect(answer.body.error.issues.map((issue: Json) => issue.path).sort()).toEqual(['body/accentColour', 'body/logoDarkFileId', 'body/senderDisplayName'])
  })

  it('asks a fresh code, then saves once: version 1, one audit row, one event naming the fields', async () => {
    h.clock.advance(6 * 60_000)
    const body = { ...EMPTY, accentColour: '#1F5FA8', senderDisplayName: '  Esempio Moto Ordini ', portalLabel: 'Portale Esempio' }
    expect((await put(owner, `/branding/${companyA}`, body)).status).toBe(403)
    expect((await put(sales, `/branding/${companyA}`, body)).status).toBe(403)
    await stepUp(h, owner, ownerSecret)
    const saved = await put(owner, `/branding/${companyA}`, body)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.changed).toEqual(['accentColour', 'senderDisplayName', 'portalLabel'])
    expect(saved.body.branding).toMatchObject({ saved: true, version: 1, accentColour: '#1f5fa8', senderDisplayName: 'Esempio Moto Ordini', portalLabel: 'Portale Esempio', shown: { portal: 'Portale Esempio', sender: 'Esempio Moto Ordini' } })
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'company_branding.changed' AND subject = $1`, [companyA])).toEqual([{ payload: { companyId: companyA, fields: ['accentColour', 'senderDisplayName', 'portalLabel'], version: 1 } }])
    const audit = await admin(`SELECT action, before, after FROM "AuditLog" WHERE "recordType" = 'CompanyBranding' AND "recordId" = $1`, [companyA])
    expect(audit).toEqual([{ action: 'documents.branding.save', before: null, after: expect.objectContaining({ accentColour: '#1f5fa8', fields: ['accentColour', 'senderDisplayName', 'portalLabel'] }) }])
  })

  it('the same branding again writes nothing; a missing or stale version is a conflict that names the current one', async () => {
    const same = await put(owner, `/branding/${companyA}`, { ...EMPTY, accentColour: '#1f5fa8', senderDisplayName: 'Esempio Moto Ordini', portalLabel: 'Portale Esempio', version: 1 })
    expect(same.status).toBe(200)
    expect(same.body).toMatchObject({ changed: [], branding: { version: 1 } })
    const noVersion = await put(owner, `/branding/${companyA}`, { ...EMPTY, portalLabel: 'Altro' })
    expect(noVersion.status).toBe(409)
    expect(noVersion.body.error.issues).toEqual([{ path: 'body/version', message: 'The current version is 1.' }])
    const stale = await put(owner, `/branding/${companyA}`, { ...EMPTY, portalLabel: 'Altro', version: 3 })
    expect(stale.status).toBe(409)
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'company_branding.changed' AND subject = $1`, [companyA])).toEqual([{ n: 1 }])
  })
})

describe('logos: PNG or JPEG of the company, only through the branding routes', () => {
  let light: string
  let dark: string

  it('refuses the generic files route, another kind of picture, a picture too large, and a file whose bytes are not a picture', async () => {
    const generic = await owner.post('/files', { companyId: companyA, recordType: 'CompanyBranding', recordId: companyA, kind: 'PHOTO', originalName: 'x.png', contentType: 'image/png', sizeBytes: LIGHT.length, sha256: sha(LIGHT) })
    expect(generic.status).toBe(409)
    const svg = await owner.post(`/branding/${companyA}/logo`, { originalName: 'logo.svg', contentType: 'image/svg+xml', sizeBytes: 10, sha256: sha(Buffer.from('x')) })
    expect(svg.status).toBe(400)
    expect(svg.body.error.issues).toEqual([{ path: 'body/contentType', message: 'A logo is a PNG or JPEG picture.' }])
    expect((await owner.post(`/branding/${companyA}/logo`, { originalName: 'big.png', contentType: 'image/png', sizeBytes: 1024 * 1024 + 1, sha256: sha(LIGHT) })).body.error.issues).toEqual([{ path: 'body/sizeBytes', message: 'A logo holds 1 byte to 1 MiB.' }])
    expect((await sales.post(`/branding/${companyA}/logo`, { originalName: 'logo.png', contentType: 'image/png', sizeBytes: LIGHT.length, sha256: sha(LIGHT) })).status).toBe(403)
    const fake = await upload(owner, companyA, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png', 'not-a-png.png')
    expect(fake.status).toBe(400)
    expect(fake.body.error.issues[0].path).toBe('params/fileId')
  })

  it('uploads a light and a dark logo; they are the company\'s only once saved', async () => {
    const one = await upload(owner, companyA, LIGHT)
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    expect(one.body.logo).toEqual({ fileId: one.body.file.id, contentType: 'image/png' })
    expect(one.body.file).toMatchObject({ recordType: 'CompanyBranding', recordId: companyA, kind: 'PHOTO', status: 'AVAILABLE', visibility: ['OFFICE'] })
    light = one.body.file.id
    dark = (await upload(owner, companyA, DARK, 'image/png', 'logo-dark.png')).body.file.id
    // Not saved yet: the public address serves nothing.
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${companyA}/logo/${light}` })).statusCode).toBe(404)

    // Another company's picture may not become this company's logo.
    const otherUpload = await upload(owner, companyA2, LIGHT)
    expect(otherUpload.status, JSON.stringify(otherUpload.body)).toBe(200)
    const other = otherUpload.body.file.id
    await stepUp(h, owner, ownerSecret)
    const wrong = await put(owner, `/branding/${companyA}`, { ...EMPTY, accentColour: '#1f5fa8', senderDisplayName: 'Esempio Moto Ordini', portalLabel: 'Portale Esempio', logoFileId: other, version: 1 })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/logoFileId'])

    const saved = await put(owner, `/branding/${companyA}`, { ...EMPTY, accentColour: '#1f5fa8', senderDisplayName: 'Esempio Moto Ordini', portalLabel: 'Portale Esempio', logoFileId: light, logoDarkFileId: dark, version: 1 })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.changed).toEqual(['logo', 'logoDark'])
    expect(saved.body.branding).toMatchObject({
      version: 2,
      logo: { fileId: light, path: `/branding/public/${companyA}/logo/${light}`, name: 'logo.png', contentType: 'image/png' },
      logoDark: { fileId: dark, path: `/branding/public/${companyA}/logo/${dark}`, name: 'logo-dark.png' },
    })
  })

  it('anyone reads the branding and the pictures before signing in; another file, company or tenant finds nothing', async () => {
    const read = await h.app.inject({ method: 'GET', url: `/branding/public/${companyA}` })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().branding).toEqual({ companyId: companyA, name: 'Portale Esempio', companyName: 'Esempio Moto', logoPath: `/branding/public/${companyA}/logo/${light}`, logoDarkPath: `/branding/public/${companyA}/logo/${dark}`, accentColour: '#1f5fa8' })
    const picture = await h.app.inject({ method: 'GET', url: `/branding/public/${companyA}/logo/${light}` })
    expect(picture.statusCode).toBe(200)
    expect(picture.headers['content-type']).toBe('image/png')
    expect(picture.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(picture.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(picture.rawPayload, LIGHT)).toBe(0)
    // An unbranded company: its name, no logo, the DS colours.
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${companyA2}` })).json().branding).toEqual({ companyId: companyA2, name: 'Test company C2', companyName: 'Test company C2', logoPath: null, logoDarkPath: null, accentColour: null })
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${newId()}` })).statusCode).toBe(404)
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${companyA2}/logo/${light}` })).statusCode).toBe(404)
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${tenantB.companies[0]!.id}/logo/${light}` })).statusCode).toBe(404)
  })

  it('a link session reads its sender\'s branding (the link page\'s head); an office session may not', async () => {
    const answer = await linkApp.inject({ method: 'GET', url: '/link/branding', headers: { 'x-test-session': 'link' } })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().branding).toMatchObject({ companyId: companyA, name: 'Portale Esempio', accentColour: '#1f5fa8', logoPath: `/branding/public/${companyA}/logo/${light}` })
    expect((await linkApp.inject({ method: 'GET', url: '/link/branding', headers: { 'x-test-session': 'office' } })).statusCode).toBe(403)
  })

  it('the documents print the logo above the company\'s name; a company without one prints its name alone', async () => {
    const legal = await companyLegalOf(system(), companyA)
    expect(legal.logo?.fileId).toBe(light)
    expect(JSON.stringify(legal)).not.toContain(light)
    const withLogo = await renderDocumentPdf(composeDocument(sampleDocument('QUOTE', 'it', legal, '2026-11-04')))
    expect(withLogo.toString('latin1')).toMatch(/\/Subtype \/Image/)
    // The same document gives the same bytes.
    expect(Buffer.compare(await renderDocumentPdf(composeDocument(sampleDocument('QUOTE', 'it', legal, '2026-11-04'))), withLogo)).toBe(0)
    // A copy of the legal data is plain data: the logo does not travel with it.
    const plain = { ...legal }
    expect(plain.logo).toBeUndefined()
    expect((await renderDocumentPdf(composeDocument(sampleDocument('QUOTE', 'it', plain, '2026-11-04')))).toString('latin1')).not.toMatch(/\/Subtype \/Image/)
    // The letterhead preview of the office reads the same.
    const sample = await owner.get(`/documents/sample?companyId=${companyA}&type=DDT&language=en`)
    expect(sample.status).toBe(200)
    expect(sample.response.rawPayload.toString('latin1')).toMatch(/\/Subtype \/Image/)
  })

  it('a replaced logo leaves the public address; clearing the branding keeps the row, with the DS colours and the names back', async () => {
    await stepUp(h, owner, ownerSecret)
    const cleared = await put(owner, `/branding/${companyA}`, { ...EMPTY, version: 2 })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(cleared.body.changed).toEqual(['logo', 'logoDark', 'accentColour', 'senderDisplayName', 'portalLabel'])
    expect(cleared.body.branding).toMatchObject({ saved: true, version: 3, logo: null, accentColour: null, shown: { portal: 'Esempio Moto', sender: 'Esempio Moto' } })
    expect((await h.app.inject({ method: 'GET', url: `/branding/public/${companyA}/logo/${light}` })).statusCode).toBe(404)
    const legal = await companyLegalOf(system(), companyA)
    expect(legal.logo).toBeUndefined()
  })
})

describe('mail to partners goes out under the branding\'s sender name', () => {
  it('the From line and the signature name the brand; without one, the identity\'s own name', async () => {
    await stepUp(h, owner, ownerSecret)
    expect((await put(owner, `/branding/${companyA}`, { ...EMPTY, senderDisplayName: 'Esempio Moto Ordini', version: 3 })).status).toBe(200)
    const sent = await owner.post(`/threads/Quote/${quote}/emails`, { to: ['buyer@example.com'], subject: 'Preventivo', body: 'Buongiorno, ecco il preventivo.' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const outboundId = sent.body.email.id
    const row = await first(`SELECT "fromName", "fromAddress" FROM "EmailOutbound" WHERE id = $1`, [outboundId])
    expect(row.fromAddress).toBe('noreply@brand-a.example.com')
    expect(row.fromName).toMatch(/ via Esempio Moto Ordini$/)
    expect(await deliverOutbound(h.email, system(), outboundId, { retry: true, build: threadMailBuilder(h.email, system()) })).toBe('sent')
    const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)!
    expect(headerOf(mail.raw, 'From')).toMatch(/via Esempio Moto Ordini" <noreply@brand-a\.example\.com>$/)
    expect(textOf(mail.raw)).toContain('Esempio Moto Ordini')
    expect(textOf(mail.raw)).not.toContain('Identity name C1')

    await stepUp(h, owner, ownerSecret)
    expect((await put(owner, `/branding/${companyA}`, { ...EMPTY, version: 4 })).status).toBe(200)
    const plain = await owner.post(`/threads/Quote/${quote}/emails`, { to: ['buyer@example.com'], body: 'Ancora noi.' })
    expect((await first(`SELECT "fromName" FROM "EmailOutbound" WHERE id = $1`, [plain.body.email.id])).fromName).toMatch(/ via Identity name C1$/)
  })
})
