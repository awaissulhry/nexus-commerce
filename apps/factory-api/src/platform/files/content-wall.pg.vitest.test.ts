import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
// The production lane's two-customer harness (read only): a work order of each brand and one MIXED work order made before the rule.
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../modules/production/testing/two-brands'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { CONTENT_WALL_WORDS } from '../threads/threads'
import { encodeJpeg } from './thumbs/codec/jpeg-encode'

/**
 * fix-wall-1 — THE BRAND WALL ON OLD COPIES (wall W25 / T25 extended; B-TH-024, B-PR-19; the production lead's finding of 2026-11-17:
 * "The GENERIC portal file list can still show a copy of a mixed-lot photo if it was shared onto an order before B-TH-024 landed
 * (old data); our quality read hides it, the generic list does not."; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well.") on the local stack, through the real app, the real portal sign-in by code and the real files routes.
 *
 * The seeds up to shipping, the production two-brand harness (brand A = the seeds' customer P1, brand B = the threads' second
 * brand, SEED-SO-B001; a work order each; a legacy work order MIXING both), and here: a photo of the mixed work order (the office's);
 * OLD DATA written in the database as B-TH-024's copy made it before its wall — a copy of that photo on B's order shared with B
 * (portal and link), a copy of that copy on B's order, a copy of it on A's order shared with A, and a photo of the mixed work
 * order itself shared with B (before B-TH-003); B's and A's own photos on their orders (the controls); an office reply on B's order
 * carrying B's photo and the old copy (sent before the copy was known as one), pinned.
 *
 *   W1  Brand Beta's portal: the order's file list holds its own photo only (the old copy and the copy of the copy neither listed
 *       nor counted), the old copy by id, download, preview and versions "File not found." (404, as a wrong id), the mixed work
 *       order's photo neither listed nor opened; the record thread (GET /threads and GET /portal/threads), the conversation list
 *       and the pin carry and count B's photo only; Beta cannot attach the old copy to a message ("File not found.").
 *   W2  Brand Beta's link on its order: the same list, by id and thread.
 *   W3  Brand Alpha's portal (symmetric): its own photo yes, the old copy on its order and B's old copy never.
 *   W4  The office sees it all: the old copy listed with where it came from (the mixed work order's photo), opened and downloaded;
 *       a new reply carrying it to the customer is refused in the office's words; a reply with B's own photo goes.
 *   W0  Every answer Beta's portal and link got holds none of the old copies' ids or names, the mixed work order's photo or the
 *       mixed work order, and none of Brand Alpha's markers; no answer of the source line (`sourceFileId`, `origin`) left the office.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/files/content-wall`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
const NS = 'fix-wall-1-content'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const OFFICE = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)
const SESSIONS: Record<string, SessionContext> = { ...OFFICE }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Statements with the database's rules off, in one transaction: the OLD DATA the app no longer makes (B-TH-003, B-TH-024). */
async function oldData(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query('SET LOCAL session_replication_role = replica')
    for (const statement of statements) await h.db.admin.query(statement.sql, statement.values ?? [])
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

const people = { alpha: 'anna.production@fxl1-alpha.example.com', beta: 'bruno.production@fxl1-beta.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>
/** Every answer Brand Beta got (portal and link), for the scan. */
const seenByB: { url: string; body: unknown }[] = []
let aMarkers: Marker[] = []

let counter = 0
async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await officeApp.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `fxl1-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const answer = { status: response.statusCode, body: (response.headers['content-type']?.toString().includes('json') ? response.json() : response.body) as Json }
  if (session === 'link.b') seenByB.push({ url, body: answer.body })
  return answer
}
const asOffice = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => call('office.all', method, url, body)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** A real, small JPEG (the portal is shown a picture only as its stripped copy), one per seed. */
function jpeg(seed: number): Buffer {
  const width = 16
  const height = 16
  const data = new Uint8ClampedArray(width * height * 3)
  for (let at = 0; at < data.length; at++) data[at] = (at * 7 + seed * 53) % 256
  return Buffer.from(encodeJpeg({ width, height, channels: 3, data }, 90))
}
/** A photo uploaded by the office through the real routes (announce, put in the local store, confirm). */
async function photo(name: string, record: { recordType: string; recordId: string }, bytes: Buffer, visibility?: string[]): Promise<Json> {
  const announced = await asOffice('POST', '/files', { companyId: w.companyId, kind: 'PHOTO', originalName: name, contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes), ...record, ...(visibility ? { visibility } : {}) })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await officeApp.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })).statusCode).toBe(200)
  const done = await asOffice('POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}

async function partnerPerson(email: string, partyId: string): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'customer-production' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A portal read: the answer is kept for the scan (Beta's), its status checked. */
async function get(who: keyof typeof people, url: string, status = 200): Promise<Json> {
  const answer = await browsers[who].get(url)
  if (who === 'beta') seenByB.push({ url, body: answer.body })
  expect(answer.status, `${who} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(status)
  return answer.body as Json
}

const files = {} as Record<'mixedSource' | 'oldCopy' | 'copyOfCopy' | 'alphaOldCopy' | 'sharedOnMixed' | 'betaOwn' | 'alphaOwn', Json>
let replyId = ''
const listOf = (recordType: string, recordId: string) => `/files?recordType=${recordType}&recordId=${recordId}`
const idsOf = (answer: Json): string[] => (answer.files as Json[]).map((file) => file.id as string)
/** The files of this test among those listed (the seeds' own files of the order are left aside). */
const oursOf = (answer: Json): string[] => idsOf(answer).filter((fileId) => Object.values(files).some((file) => file.id === fileId))

beforeAll(async () => {
  h = await startHarness('fix_wall_1_content')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  for (const seed of [seedCore, seedFiles, seedShipping, seedProduction, seedNumbering, seedReasons]) await seed({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // The office person of `office.all` (a pin names who pinned it).
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, $5, $6)', [OFFICE['office.all'].actorId, T, 'olga.office@fxl1-office.example.com', 'Made-up Office Olga', 'ACTIVE', 'OFFICE'])
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace: NS })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  // Brand Beta's link on its own order (the token's one record; files and threads shared with its links).
  SESSIONS['link.b'] = { audience: 'link', tenantId: T, linkId: newId(), partyId: ids.b, record: { type: 'SalesOrder', id: w.b.salesOrderId }, grants: [{ permissions: ['files.read', 'threads.read'], companies: 'all', sites: 'all', parties: [ids.b] }] }

  // Both portals on; the portal people of each brand (the reply below needs a portal reader of B).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.alpha, ids.a)
  await partnerPerson(people.beta, ids.b)

  // The mixed work order's photo: the goods of BOTH brands on one table (the office's own file).
  const mixedBytes = jpeg(1)
  files.mixedSource = await photo('Made-up mixed lot cutting table.jpg', { recordType: 'WorkOrder', recordId: w.mixed.workOrderId }, mixedBytes)
  const shared = ['OFFICE', 'PARTNER', 'LINK']
  // The files that become old copies: today's routes store them with the source's bytes on each brand's order …
  files.oldCopy = await photo('Made-up old copy of the mixed lot.jpg', { recordType: 'SalesOrder', recordId: w.b.salesOrderId }, mixedBytes, shared)
  files.copyOfCopy = await photo('Made-up copy of the old copy.jpg', { recordType: 'SalesOrder', recordId: w.b.salesOrderId }, mixedBytes, shared)
  files.alphaOldCopy = await photo('Made-up old copy on the Alpha order.jpg', { recordType: 'SalesOrder', recordId: w.a.salesOrderId }, mixedBytes, ['OFFICE', 'PARTNER'])
  files.sharedOnMixed = await photo('Made-up mixed lot photo shared before the rule.jpg', { recordType: 'WorkOrder', recordId: w.mixed.workOrderId }, jpeg(2))
  // … and the controls: each brand's own photo on its own order, shared with it.
  files.betaOwn = await photo('Beta order own photo.jpg', { recordType: 'SalesOrder', recordId: w.b.salesOrderId }, jpeg(3), shared)
  files.alphaOwn = await photo('Alpha order own photo.jpg', { recordType: 'SalesOrder', recordId: w.a.salesOrderId }, jpeg(4), ['OFFICE', 'PARTNER'])

  // An office reply on B's order carrying B's photo and the file that is about to be known as an old copy (sent before), pinned.
  h.clock.advance(1_000)
  const reply = await asOffice('POST', `/threads/SalesOrder/${w.b.salesOrderId}/replies`, { body: 'Made-up reply: the photos of your order.', attachments: [files.betaOwn.id, files.oldCopy.id] })
  expect(reply.status, JSON.stringify(reply.body)).toBe(201)
  replyId = reply.body.message.id
  const pinned = await asOffice('PUT', `/threads/SalesOrder/${w.b.salesOrderId}/pins/${replyId}`)
  expect(pinned.status, JSON.stringify(pinned.body)).toBe(200)

  // THE OLD DATA, in the database as it was left before B-TH-024's wall and B-TH-003: each copy names its source …
  await oldData([
    { sql: `UPDATE "StoredFile" SET "sourceFileId" = $2 WHERE id = $1`, values: [files.oldCopy.id, files.mixedSource.id] },
    { sql: `UPDATE "StoredFile" SET "sourceFileId" = $2 WHERE id = $1`, values: [files.copyOfCopy.id, files.oldCopy.id] },
    { sql: `UPDATE "StoredFile" SET "sourceFileId" = $2 WHERE id = $1`, values: [files.alphaOldCopy.id, files.mixedSource.id] },
    // … and the mixed work order's own photo shared with B's portal and links.
    { sql: `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE', 'PARTNER', 'LINK']::"FileAudience"[], "partyId" = $2 WHERE id = $1`, values: [files.sharedOnMixed.id, ids.b] },
  ])

  for (const person of Object.keys(people) as (keyof typeof people)[]) browsers[person] = await signedIn(people[person])

  aMarkers = [
    ...(await markersOf(h.db, ids.a)),
    { label: 'mixed work order', text: w.mixed.number },
    { label: 'mixed work order', text: w.mixed.workOrderId },
    ...(['mixedSource', 'oldCopy', 'copyOfCopy', 'alphaOldCopy', 'sharedOnMixed', 'alphaOwn'] as const).flatMap((key) => [
      { label: `file ${key}`, text: files[key]!.id as string },
      { label: `file ${key}`, text: files[key]!.originalName as string },
    ]),
  ]
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await officeApp?.close()
  await h?.close()
}, 60_000)

describe('W1 — Brand Beta’s portal never sees, lists, counts or opens an old copy of a mixed lot’s photo', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the order’s file list: its own photo only (the old copy and the copy of the copy neither listed nor counted)', async () => {
    const listed = await get('beta', listOf('SalesOrder', w.b.salesOrderId))
    // Of this test's three photos on B's order, one is listed (and so counted): B's own.
    expect(oursOf(listed)).toEqual([files.betaOwn.id])
    // The source line never leaves the office.
    for (const file of listed.files as Json[]) expect(Object.keys(file)).not.toEqual(expect.arrayContaining(['sourceFileId']))
    expect(JSON.stringify(listed)).not.toContain('"origin"')
  })

  it('by id: the file, its download, preview and versions are "File not found." (404, as a wrong id); its own photo opens', async () => {
    for (const fileId of [files.oldCopy.id, files.copyOfCopy.id]) {
      for (const path of ['', '/download', '/preview', '/versions']) {
        const answer = await get('beta', `/files/${fileId}${path}`, 404)
        expect(answer.error.message).toBe('File not found.')
      }
    }
    expect((await get('beta', `/files/${files.betaOwn.id}`)).file.id).toBe(files.betaOwn.id)
    expect((await get('beta', `/files/${files.betaOwn.id}/download`)).download.url).toEqual(expect.any(String))
    expect((await get('beta', `/files/${files.betaOwn.id}/preview`)).preview.mode).toBe('inline')
  })

  it('the mixed work order’s own photo, shared with B before the rule: neither listed nor opened', async () => {
    const listed = await browsers.beta.get(listOf('WorkOrder', w.mixed.workOrderId))
    seenByB.push({ url: listOf('WorkOrder', w.mixed.workOrderId), body: listed.body })
    if (listed.status === 200) expect(idsOf(listed.body as Json)).toEqual([])
    else expect(listed.status, JSON.stringify(listed.body)).toBe(404)
    for (const path of ['', '/download', '/preview']) await get('beta', `/files/${files.sharedOnMixed.id}${path}`, 404)
  })

  it('the record thread (GET /threads and GET /portal/threads), the conversation list and the pin carry and count B’s photo only', async () => {
    const thread = await get('beta', `/threads/SalesOrder/${w.b.salesOrderId}?limit=20`)
    const message = (thread.messages as Json[]).find((row) => row.id === replyId)!
    expect(message.attachments.map((file: Json) => file.id)).toEqual([files.betaOwn.id])
    expect(message.hiddenAttachments).toBeUndefined()

    const portal = await get('beta', `/portal/threads/SalesOrder/${w.b.salesOrderId}?limit=20`)
    expect((portal.messages as Json[]).find((row) => row.id === replyId)!.attachments.map((file: Json) => file.id)).toEqual([files.betaOwn.id])

    const conversations = (await get('beta', '/portal/threads?limit=50')).conversations as Json[]
    const ours = conversations.find((row) => row.record.id === w.b.salesOrderId)!
    expect(ours.last.id).toBe(replyId)
    expect(ours.last.attachmentCount).toBe(1)

    const pins = (await get('beta', `/threads/SalesOrder/${w.b.salesOrderId}/pins`)).pins as Json[]
    expect(pins.find((pin) => pin.messageId === replyId)!.message.attachmentCount).toBe(1)
  })

  it('Beta cannot attach the old copy to its own message: "File not found." as for a wrong id', async () => {
    const posted = await browsers.beta.post(`/portal/threads/SalesOrder/${w.b.salesOrderId}/messages`, { body: 'Made-up: about this photo', attachments: [files.oldCopy.id] }, { headers: { 'idempotency-key': `fxl1-post-${newId()}` } })
    seenByB.push({ url: 'POST /portal/threads/…/messages', body: posted.body })
    expect(posted.status, JSON.stringify(posted.body)).toBe(400)
    expect(posted.body.error.issues).toEqual([{ path: 'body/attachments/0', message: 'File not found.' }])
  })
})

describe('W2 — Brand Beta’s link on its order: the same wall', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the list holds its own photo only; the old copy by id, download and preview 404; its thread carries B’s photo only', async () => {
    const listed = await call('link.b', 'GET', listOf('SalesOrder', w.b.salesOrderId))
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(oursOf(listed.body)).toEqual([files.betaOwn.id])
    for (const fileId of [files.oldCopy.id, files.copyOfCopy.id]) {
      for (const path of ['', '/download', '/preview', '/versions']) expect((await call('link.b', 'GET', `/files/${fileId}${path}`)).status).toBe(404)
    }
    expect((await call('link.b', 'GET', `/files/${files.betaOwn.id}/download`)).status).toBe(200)
    const thread = await call('link.b', 'GET', `/threads/SalesOrder/${w.b.salesOrderId}?limit=20`)
    expect(thread.status, JSON.stringify(thread.body)).toBe(200)
    const message = (thread.body.messages as Json[]).find((row) => row.id === replyId)!
    expect(message.attachments.map((file: Json) => file.id)).toEqual([files.betaOwn.id])
    expect(message.hiddenAttachments).toBeUndefined()
  })
})

describe('W3 — Brand Alpha’s portal (symmetric)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('its own photo yes; the old copy on its own order and Beta’s old copy never', async () => {
    const listed = await get('alpha', listOf('SalesOrder', w.a.salesOrderId))
    expect(oursOf(listed)).toEqual([files.alphaOwn.id])
    for (const fileId of [files.alphaOldCopy.id, files.oldCopy.id, files.sharedOnMixed.id]) {
      for (const path of ['', '/download', '/preview']) await get('alpha', `/files/${fileId}${path}`, 404)
    }
    expect((await get('alpha', `/files/${files.alphaOwn.id}/download`)).download.url).toEqual(expect.any(String))
  })
})

describe('W4 — the office sees it all, and sends none of it to a customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('B’s order lists the old copies with where they came from; the office opens and downloads them; the reply shows both photos', async () => {
    const listed = await asOffice('GET', listOf('SalesOrder', w.b.salesOrderId))
    expect(listed.status).toBe(200)
    const old = (listed.body.files as Json[]).find((file) => file.id === files.oldCopy.id)!
    expect(old.origin).toEqual({ fileId: files.mixedSource.id, recordType: 'WorkOrder', recordId: w.mixed.workOrderId, originalName: files.mixedSource.originalName, versionNo: 1 })
    expect((listed.body.files as Json[]).find((file) => file.id === files.copyOfCopy.id)!.origin.fileId).toBe(files.oldCopy.id)
    expect((await asOffice('GET', `/files/${files.oldCopy.id}`)).status).toBe(200)
    expect((await asOffice('GET', `/files/${files.oldCopy.id}/download`)).status).toBe(200)
    expect((await asOffice('GET', `/files/${files.alphaOldCopy.id}`)).status).toBe(200)
    const thread = await asOffice('GET', `/threads/SalesOrder/${w.b.salesOrderId}?limit=20`)
    expect((thread.body.messages as Json[]).find((row) => row.id === replyId)!.attachments.map((file: Json) => file.id).sort()).toEqual([files.betaOwn.id, files.oldCopy.id].sort())
  })

  it('a new reply carrying the old copy to Brand Beta is refused in the office’s words; with B’s own photo it goes', async () => {
    const refused = await asOffice('POST', `/threads/SalesOrder/${w.b.salesOrderId}/replies`, { body: 'Made-up: once more', attachments: [files.oldCopy.id] })
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/attachments/0', message: CONTENT_WALL_WORDS }])
    const sent = await asOffice('POST', `/threads/SalesOrder/${w.b.salesOrderId}/replies`, { body: 'Made-up: your own photo', attachments: [files.betaOwn.id] })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
  })
})

describe('W0 — the scan of everything Brand Beta got', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('no old copy, no mixed work order or its photo, no Brand Alpha marker, no source line', () => {
    expect(seenByB.length).toBeGreaterThan(20)
    const found = seenByB.flatMap((answer) => findMarkers(answer.body, aMarkers).map((marker) => `${answer.url}: ${marker}`))
    expect(found).toEqual([])
    for (const answer of seenByB) expect(JSON.stringify(answer.body ?? null)).not.toMatch(/"(sourceFileId|origin)"/)
  })
})
