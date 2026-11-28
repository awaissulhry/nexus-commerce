import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { DRAFT_FILE_WORDS, DRAFT_FILES_MAX } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { PORTAL_UPLOAD_WORDS } from '@nexus/factory-domain/threads/partner/uploads'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { useScanner } from '../../../platform/files/scan/service'
import { listOfficeRequests, officeRequestView } from './office'

/**
 * B-CP-072 (customer page plan C5, 12 §2 parts 2–4; D14 — the virus scanner's spend O7 NOT approved; walls W-CP-1, W-CP-3) on the
 * local stack, through the real app and the real portal sign-in by code, every factory-db seed: customer A = SEED-C1 (P1) with a
 * buyer who may upload, a Designer who may upload and a buyer without the upload capability; customer B = SEED-C2 (P3) with its buyer.
 *
 *   - a draft takes a logo (ARTWORK), a reference (no category) and a measurement sheet (MEASUREMENTS) on itself or on one line,
 *     shared with A only; the draft read groups them; the Designer fills it too;
 *   - the office reads them; a sheet is named only for a reader with sales.measurements.view (else a lock without a name);
 *   - removed by its version (a stale one: 409); at most DRAFT_FILES_MAX on one draft, then refused in words;
 *   - W-CP-1 / W-CP-3: B uploads to, completes, removes or reads none of A's draft files; a line of another draft is never named;
 *   - refused in words: no upload capability, a sent request; on staging without the scanner the announce answers the e-mail
 *     sentence (503) and the draft read says it before a file is dropped;
 *   - a line taken out and a discarded draft take their files with them.
 * Every name and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-ordering/draft-files`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'draft-files-cp072'
const T = seedUuid(NS, 'tenant')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const CLOSED_WORDS = 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.'

let h: Harness
const people = {
  aBuyer: 'anna.buyer.cp072@brand-alpha.example',
  aDesigner: 'dora.designer.cp072@brand-alpha.example',
  aNoUpload: 'aldo.buyer.cp072@brand-alpha.example',
  bBuyer: 'bruna.buyer.cp072@brand-beta.example',
}
type Who = keyof typeof people
const ids = {} as Record<Who, string>
const browsers = {} as Record<Who, Browser>
const ADA = newId()
const officeWith = (permissions: string[]) => callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let serial = 0
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Answer> =>
  browsers[who].send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `cp072-key-${++serial}` } })
async function ok(who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const issuesOf = (answer: Answer): Json[] => answer.body?.error?.issues ?? []
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% made-up file of the CP-072 test: ${text}\n%%EOF\n`)
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`made-up picture: ${text}`)])
const meta = (part: string, name: string, contentType: string, bytes: Buffer, lineId?: string) => ({ part, originalName: name, contentType, sizeBytes: bytes.length, sha256: sha(bytes), ...(lineId ? { lineId } : {}) })

/** Announce, PUT the bytes to the local store's presigned URL, confirm: the file as the draft reads it. */
async function upload(who: Who, requestId: string, part: string, name: string, contentType: string, bytes: Buffer, lineId?: string): Promise<Json> {
  const base = `/portal/order-requests/${requestId}/files`
  const announced = await ok(who, 'POST', base, meta(part, name, contentType, bytes, lineId), 201)
  expect(announced.file).toMatchObject({ originalName: name, status: 'PENDING_UPLOAD', lineId: lineId ?? null })
  const put = await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  const done = await ok(who, 'POST', `${base}/${announced.file.id}/complete`)
  expect(done.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE', lineId: lineId ?? null })
  return done.file
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
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

/** On staging with no scanner, for one call; FACTORY_ENV is read per call and put back. */
async function onStaging<R>(work: () => Promise<R>): Promise<R> {
  const before = process.env.FACTORY_ENV
  useScanner(null)
  process.env.FACTORY_ENV = 'staging'
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.FACTORY_ENV
    else process.env.FACTORY_ENV = before
    useScanner(undefined)
  }
}

const G = {} as Record<string, any>

/** A new draft of customer A with one line of its own label (SEED-JKT-02, BLK, size 50). */
async function draftWithLine(who: Who = 'aBuyer'): Promise<{ id: string; lineId: string; version: number }> {
  const made = await ok(who, 'POST', '/portal/order-requests', { source: 'PICKER' }, 201)
  const filled = await ok(who, 'POST', `/portal/order-requests/${made.request.id}/lines`, { version: made.request.version, lines: [{ styleId: G.style, colourwayId: G.colour, sizes: [{ size: '50', quantity: 4 }] }] })
  return { id: made.request.id, lineId: filled.request.lines[0].id, version: filled.request.version }
}

beforeAll(async () => {
  h = await startHarness('draft_files_cp072')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    for (const party of [partyA, partyB]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.office.cp072@example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
  })
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  freshGuard(h)
  ids.aBuyer = await partnerPerson(people.aBuyer, partyA, ['customer-buyer', 'partner-comment', 'partner-upload'])
  ids.aDesigner = await partnerPerson(people.aDesigner, partyA, ['customer-designer', 'partner-comment', 'partner-upload'])
  ids.aNoUpload = await partnerPerson(people.aNoUpload, partyA, ['customer-buyer', 'partner-comment'])
  ids.bBuyer = await partnerPerson(people.bBuyer, partyB, ['customer-buyer', 'partner-comment', 'partner-upload'])
  for (const who of Object.keys(people) as Who[]) browsers[who] = await signedIn(people[who])
  G.style = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T]))[0]!.id
  G.colour = (await admin<{ id: string }>(`SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = 'BLK'`, [T, G.style]))[0]!.id
  h.clock.set(new Date(Date.now() - 2_000))
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-CP-072: a draft order’s files', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('takes a logo, a reference and a measurement sheet — on the draft or one line — shared with A only; the read groups them', async () => {
    const draft = await draftWithLine()
    G.draft = draft
    expect((await ok('aBuyer', 'GET', `/portal/order-requests/${draft.id}`)).request.uploads).toEqual({ open: true, words: null })
    const logo = await upload('aBuyer', draft.id, 'LOGO', 'made-up-alpha-logo.png', 'image/png', png('alpha logo'))
    const reference = await upload('aDesigner', draft.id, 'REFERENCE', 'made-up-alpha-mood.pdf', 'application/pdf', pdf('alpha mood'))
    const sheet = await upload('aBuyer', draft.id, 'SHEET', 'made-up-alpha-sizes.pdf', 'application/pdf', pdf('alpha sizes'), draft.lineId)
    Object.assign(G, { logo, reference, sheet })
    const rows = await admin<Json>('SELECT id, "recordType", "recordId", "partyId", visibility::text[] AS visibility, category::text AS category FROM "StoredFile" WHERE id = ANY($1::uuid[]) ORDER BY "originalName"', [[logo.id, reference.id, sheet.id]])
    expect(rows).toEqual([
      { id: logo.id, recordType: 'PortalOrderRequest', recordId: draft.id, partyId: partyA, visibility: ['OFFICE', 'PARTNER'], category: 'ARTWORK' },
      { id: reference.id, recordType: 'PortalOrderRequest', recordId: draft.id, partyId: partyA, visibility: ['OFFICE', 'PARTNER'], category: null },
      { id: sheet.id, recordType: 'PortalOrderRequestLine', recordId: draft.lineId, partyId: partyA, visibility: ['OFFICE', 'PARTNER'], category: 'MEASUREMENTS' },
    ])
    const read = (await ok('aBuyer', 'GET', `/portal/order-requests/${draft.id}`)).request
    expect(read.files.logos.map((file: Json) => [file.id, file.lineId])).toEqual([[logo.id, null]])
    expect(read.files.references.map((file: Json) => [file.id, file.lineId])).toEqual([[reference.id, null]])
    expect(read.files.sheets.map((file: Json) => [file.id, file.lineId, file.originalName])).toEqual([[sheet.id, draft.lineId, 'made-up-alpha-sizes.pdf']])
    // Who of A added each: the draft's own audit rows (the person), and one draft_changed per file.
    const audits = await admin<{ actorId: string }>(`SELECT "actorId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'portalOrdering.addDraftFile' AND "recordId" = $2 ORDER BY at`, [T, draft.id])
    expect(audits.map((row) => row.actorId)).toEqual([ids.aBuyer, ids.aDesigner, ids.aBuyer])
    expect((await admin(`SELECT 1 FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'portal_order_request.draft_changed' AND subject = $2`, [T, draft.id])).length).toBeGreaterThanOrEqual(5)
  })

  it('the office reads them; a measurement sheet is named only with sales.measurements.view (else locked, no name)', async () => {
    const noSheets = officeWith(['orders.view', 'threads.read', 'files.read'])
    const listed = (await listOfficeRequests(noSheets, { status: 'DRAFT', partyId: partyA })).requests.find((row) => row.id === G.draft.id)!
    expect(listed.draft!.files.logos).toEqual([expect.objectContaining({ id: G.logo.id, originalName: 'made-up-alpha-logo.png', locked: false })])
    expect(listed.draft!.files.sheets).toEqual([expect.objectContaining({ id: G.sheet.id, lineId: G.draft.lineId, originalName: null, locked: true })])
    expect(JSON.stringify(listed)).not.toContain('made-up-alpha-sizes.pdf')
    // od-fx3: the checklist went; the logos and references are the row's own files.
    expect(listed.draft!.files.logos.length).toBeGreaterThan(0)
    expect(listed.draft!.files.references.length).toBeGreaterThan(0)
    const withSheets = officeWith(['orders.view', 'threads.read', 'files.read', 'sales.measurements.view'])
    const view = await officeRequestView(withSheets, G.draft.id)
    expect(view.request.draft!.files.sheets).toEqual([expect.objectContaining({ id: G.sheet.id, originalName: 'made-up-alpha-sizes.pdf', locked: false })])
  })

  it('removes a file by its version (a stale one: 409); the cap of DRAFT_FILES_MAX refuses the next in words', async () => {
    const stale = await call('aBuyer', 'DELETE', `/portal/order-requests/${G.draft.id}/files/${G.reference.id}?version=${G.reference.version + 5}`)
    expect(stale.status).toBe(409)
    const removed = await ok('aBuyer', 'DELETE', `/portal/order-requests/${G.draft.id}/files/${G.reference.id}?version=${G.reference.version}`)
    expect(removed.request.files.references).toEqual([])
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "StoredFile" WHERE id = $1', [G.reference.id]))[0]!.status).toBe('DELETED')
    // The cap: a new draft takes DRAFT_FILES_MAX announced files (left waiting for their bytes: they count), then one more is refused.
    const capped = await draftWithLine()
    for (let index = 0; index < DRAFT_FILES_MAX; index += 1) await ok('aBuyer', 'POST', `/portal/order-requests/${capped.id}/files`, meta('REFERENCE', `made-up-${index}.pdf`, 'application/pdf', pdf(`n${index}`)), 201)
    const full = await call('aBuyer', 'POST', `/portal/order-requests/${capped.id}/files`, meta('REFERENCE', 'made-up-one-more.pdf', 'application/pdf', pdf('one more'), capped.lineId))
    expect(full.status).toBe(409)
    expect(issuesOf(full)).toEqual([expect.objectContaining({ path: 'refusal/TOO_MANY_FILES', message: DRAFT_FILE_WORDS.TOO_MANY_FILES.en.replaceAll('{max}', String(DRAFT_FILES_MAX)) })])
  })

  it('W-CP-1 / W-CP-3: customer B uploads to, completes, removes or reads none of A’s draft files; a line of another draft is never named', async () => {
    const base = `/portal/order-requests/${G.draft.id}/files`
    const bytes = pdf('beta')
    expect((await call('bBuyer', 'POST', base, meta('LOGO', 'made-up-beta.pdf', 'application/pdf', bytes))).status).toBe(404)
    for (const file of [G.logo, G.sheet]) {
      expect((await call('bBuyer', 'POST', `${base}/${file.id}/complete`)).status).toBe(404)
      expect((await call('bBuyer', 'DELETE', `${base}/${file.id}?version=${file.version}`)).status).toBe(404)
      expect((await call('bBuyer', 'GET', `/files/${file.id}`)).status).toBe(404)
    }
    expect(JSON.stringify((await call('bBuyer', 'GET', `/files?recordType=PortalOrderRequest&recordId=${G.draft.id}`)).body)).not.toMatch(/made-up-alpha/)
    // B's own draft: A's line and A's files are not B's to name (not found, as a wrong id).
    const theirs = await ok('bBuyer', 'POST', '/portal/order-requests', {}, 201)
    expect((await call('bBuyer', 'POST', `/portal/order-requests/${theirs.request.id}/files`, meta('SHEET', 'made-up-beta.pdf', 'application/pdf', bytes, G.draft.lineId))).status).toBe(404)
    expect((await call('bBuyer', 'POST', `/portal/order-requests/${theirs.request.id}/files/${G.logo.id}/complete`)).status).toBe(404)
    // A's other draft: the first draft's line is not its line; the first draft's file is not its file.
    const other = await draftWithLine()
    const wrongLine = await call('aBuyer', 'POST', `/portal/order-requests/${other.id}/files`, meta('SHEET', 'made-up-alpha-other.pdf', 'application/pdf', pdf('other'), G.draft.lineId))
    expect(wrongLine.status).toBe(404)
    expect((await call('aBuyer', 'DELETE', `/portal/order-requests/${other.id}/files/${G.logo.id}?version=${G.logo.version}`)).status).toBe(404)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "partyId" = $2 AND "recordId" = ANY($3::uuid[])', [T, partyB, [G.draft.id, G.draft.lineId]])).toEqual([])
  })

  // od-ts t.6 (the Owner's picture: a "Logo" toggle on each attachment).
  it('od-ts t.6: the Logo toggle moves A’s own file between logos and references (the version moves); customer B moves none of A’s files (404); a measurement sheet stays one (409)', async () => {
    const read = await ok('aBuyer', 'GET', `/portal/order-requests/${G.draft.id}`)
    const base = `/portal/order-requests/${G.draft.id}/files`
    // Customer B: A's draft and A's files are not B's to name (not found, as a wrong id), not even through B's own draft.
    for (const file of [G.logo, G.sheet]) expect((await call('bBuyer', 'PATCH', `${base}/${file.id}`, { version: read.request.version, part: 'REFERENCE' })).status).toBe(404)
    const theirs = await ok('bBuyer', 'POST', '/portal/order-requests', {}, 201)
    expect((await call('bBuyer', 'PATCH', `/portal/order-requests/${theirs.request.id}/files/${G.logo.id}`, { version: theirs.request.version, part: 'REFERENCE' })).status).toBe(404)
    // Nothing of A's moved: the logo is still filed as artwork, the draft at its version.
    expect((await admin<{ category: string | null }>('SELECT category FROM "StoredFile" WHERE id = $1', [G.logo.id]))[0]!.category).toBe('ARTWORK')
    expect((await ok('aBuyer', 'GET', `/portal/order-requests/${G.draft.id}`)).request.version).toBe(read.request.version)
    // A's own: the logo becomes a reference (one version up), and a logo again.
    const moved = await ok('aBuyer', 'PATCH', `${base}/${G.logo.id}`, { version: read.request.version, part: 'REFERENCE' })
    expect(moved.request.version).toBe(read.request.version + 1)
    expect(moved.request.files.references.map((file: Json) => file.id)).toContain(G.logo.id)
    expect(moved.request.files.logos.map((file: Json) => file.id)).not.toContain(G.logo.id)
    expect((await admin<{ category: string | null }>('SELECT category FROM "StoredFile" WHERE id = $1', [G.logo.id]))[0]!.category).toBeNull()
    const back = await ok('aBuyer', 'PATCH', `${base}/${G.logo.id}`, { version: moved.request.version, part: 'LOGO' })
    expect(back.request.files.logos.map((file: Json) => file.id)).toContain(G.logo.id)
    // A measurement sheet is body data: it stays one (in words).
    const sheet = await call('aBuyer', 'PATCH', `${base}/${G.sheet.id}`, { version: back.request.version, part: 'LOGO' })
    expect(sheet.status).toBe(409)
    expect(issuesOf(sheet)).toEqual([{ path: 'refusal/SHEET_STAYS', message: DRAFT_FILE_WORDS.SHEET_STAYS.en }])
  })

  it('refused in words: no upload capability (and the read says so), a sent request; closed on staging without the scanner (the e-mail way)', async () => {
    const draft = await draftWithLine()
    const held = await call('aNoUpload', 'POST', `/portal/order-requests/${draft.id}/files`, meta('LOGO', 'made-up.png', 'image/png', png('held')))
    expect(held.status).toBe(403)
    expect(issuesOf(held)).toEqual([expect.objectContaining({ path: 'refusal/NO_UPLOAD', message: PORTAL_UPLOAD_WORDS.NO_UPLOAD.en })])
    expect((await ok('aNoUpload', 'GET', `/portal/order-requests/${draft.id}`)).request.uploads).toEqual({ open: false, words: PORTAL_UPLOAD_WORDS.NO_UPLOAD.en })
    await onStaging(async () => {
      const closed = await call('aBuyer', 'POST', `/portal/order-requests/${draft.id}/files`, meta('LOGO', 'made-up-staging.png', 'image/png', png('staging')))
      expect(closed.status).toBe(503)
      expect(closed.body.error.message).toBe(CLOSED_WORDS)
      expect((await ok('aBuyer', 'GET', `/portal/order-requests/${draft.id}`)).request.uploads).toEqual({ open: false, words: CLOSED_WORDS })
    })
    expect(await admin('SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordId" = $2', [T, draft.id])).toEqual([])
    // Sent: the request takes no more files (its thread still does).
    const read = await ok('aBuyer', 'GET', `/portal/order-requests/${draft.id}`)
    const priced = await ok('aBuyer', 'POST', `/portal/order-requests/${draft.id}/prices`, { version: read.request.version })
    await ok('aBuyer', 'POST', `/portal/order-requests/${draft.id}/send`, { version: priced.request.version })
    const late = await call('aBuyer', 'POST', `/portal/order-requests/${draft.id}/files`, meta('LOGO', 'made-up-late.png', 'image/png', png('late')))
    expect(late.status).toBe(409)
  })

  // owb- po1.3 (pin moved): "Take out" is a soft remove — the line keeps its files (hidden while it is out, back with "Put it back");
  // a discarded draft still takes all of its files, a taken-out line's too (a sheet is personal data).
  it('a line taken out keeps its files until it is put back; a discarded draft takes all of its files, a taken-out line’s too', async () => {
    const draft = await draftWithLine()
    const sheet = await upload('aBuyer', draft.id, 'SHEET', 'made-up-alpha-team.pdf', 'application/pdf', pdf('team sizes'), draft.lineId)
    const logo = await upload('aBuyer', draft.id, 'LOGO', 'made-up-alpha-badge.png', 'image/png', png('badge'))
    const read = await ok('aBuyer', 'GET', `/portal/order-requests/${draft.id}`)
    const out = await ok('aBuyer', 'DELETE', `/portal/order-requests/${draft.id}/lines/${draft.lineId}?version=${read.request.version}`)
    expect(out.request.files.sheets).toEqual([])
    expect(out.request.removedLines.map((line: Json) => line.id)).toEqual([draft.lineId])
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "StoredFile" WHERE id = $1', [sheet.id]))[0]!.status).toBe('AVAILABLE')
    const back = await ok('aBuyer', 'POST', `/portal/order-requests/${draft.id}/lines/${draft.lineId}/put-back`, { version: out.request.version })
    expect(back.request.files.sheets.map((file: Json) => file.id)).toEqual([sheet.id])
    const again = await ok('aBuyer', 'DELETE', `/portal/order-requests/${draft.id}/lines/${draft.lineId}?version=${back.request.version}`)
    expect(await ok('aBuyer', 'DELETE', `/portal/order-requests/${draft.id}?version=${again.request.version}`)).toEqual({ discarded: true, withdrawn: false })
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "StoredFile" WHERE id = $1', [sheet.id]))[0]!.status).toBe('DELETED')
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "StoredFile" WHERE id = $1', [logo.id]))[0]!.status).toBe('DELETED')
  })
})
