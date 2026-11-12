import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedLabour } from '../../../../../../packages/factory-db/seed/labour'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seed as seedTime } from '../../../../../../packages/factory-db/seed/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'

/**
 * Work instructions (B-W2b-214; PRD-117 per operation with versions approved by a second person, PRD-258 the frozen spec on
 * the tablet, MES-110 a new version opens before Start, MES-119 Seen once; follow-ups WI1:01-03 of B-W2b-47/-69/-12) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations (runtime and floor logins: row-level
 * security, the grants and B-W2b-205's guards are real), on the factory-db seeds: SEED-WO-0001 (SEED-JKT-02 rev 1) with its
 * routing 10 cut, 20 sew, 30 final inspection, 40 pack; SEED-WI-0002 for sewing on every style (v2 PUBLISHED, v3 DRAFT) and
 * SEED-WI-0003 for sewing on SEED-JKT-02 rev 1 (v1 PUBLISHED); made-up bundles of its BLK 52 cell; the cutting tablet of A1.
 * Every name and value is made up.
 *
 * The rules the tests name: four eyes on a version (the author never approves); a published version never changes; one
 * Seen per worker and version, a training record (D.Lgs. 81/2008 art. 37) by name only to HR and where the site's legal gate
 * lets an office read name a worker (Statuto art. 4; Owner answers F2, H3, W1); a database refusal is never a 500.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/instructions`.
 */

let h: Harness
let app: FastifyInstance
let redis: TestRedis
let localRoot: string

const NS = 'w2b214-wi'
const idOf = (key: string) => seedUuid(NS, key)
const lastId = (key: string) => `ffffffff${idOf(key).slice(8)}`
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const operator = idOf('worker:A1:operator')
const tablet = idOf('device:A1:cutting')
const packingTablet = newId()
const ops = { cut: idOf('product:operation:CUT'), sew: idOf('product:operation:SEW'), qc: idOf('product:operation:QC'), pack: idOf('product:operation:PACK') }
const SEED = { sewing: idOf('instructions:wi:2'), revision: idOf('instructions:wi:3'), sewingV2: idOf('instructions:wi:2:v2'), revisionV1: idOf('instructions:wi:3:v1'), releasedRevision: lastId('production:revision:JKT-02:1') }
const writer = newId()
const approver = newId()
const hr = newId()
const editor = newId()

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const WRITE: Permission[] = ['production.instructions.view', 'production.instructions.manage']
const SESSIONS: Record<string, SessionContext> = {
  writer: { audience: 'office', tenantId: T, actorId: writer, grants: [grant([...WRITE, 'production.instructions.approve'])] },
  approver: { audience: 'office', tenantId: T, actorId: approver, grants: [grant(['production.instructions.view', 'production.instructions.approve'])] },
  // A second manager who holds every right of the area (B-W2b-F24).
  editor: { audience: 'office', tenantId: T, actorId: editor, grants: [grant([...WRITE, 'production.instructions.approve', 'production.instructions.people'])] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['production.instructions.view'])] },
  hr: { audience: 'office', tenantId: T, actorId: hr, grants: [grant(['production.instructions.view', 'production.instructions.people'])] },
  otherCompany: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(WRITE, [idOf('company:B')])] },
  op: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: tablet, grants: [{ permissions: ['production.scan', 'floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] },
  packer: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: packingTablet, grants: [{ permissions: ['production.scan', 'floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const cid = (name: string) => `t-${run}-${name}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && !(payload && typeof payload === 'object' && ('clientEventId' in payload || 'clientScanId' in payload)) ? { 'idempotency-key': cid('key') } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const outbox = async (type: string) => (await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])).map((row) => row.payload)

let wo: string
const wops: Record<'cut' | 'sew' | 'qc' | 'pack', string> = { cut: '', sew: '', qc: '', pack: '' }

async function bundle(quantity = 20): Promise<{ id: string; code: string }> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = 'BLK' AND s.size = '52'`, [wo]))[0]!.id
  const id = newId()
  const code = `W2B214-BN-${++serial}-${run}`.toUpperCase()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`, [id, T, siteA1, wo, cell, code, quantity])
  return { id, code }
}

/** Writes typed step lines on a routing step of the work order's released revision (the revision's guard off for this set-up only). */
async function typedLinesAt(workOrderOperationId: string, instructions: string | null): Promise<void> {
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(`UPDATE "RoutingOperation" r SET instructions = $2 FROM "WorkOrderOperation" o WHERE o.id = $1 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`, [workOrderOperationId, instructions])
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
}

const photoBytes = Buffer.from(`made-up seam photo ${run}`)
async function upload(instructionId: string, kind: 'PHOTO' | 'VIDEO' = 'PHOTO'): Promise<string> {
  const bytes = kind === 'PHOTO' ? photoBytes : Buffer.from(`made-up clip ${run}`)
  const answer = await ok('writer', 'POST', `/production/instructions/${instructionId}/files`, { kind, originalName: kind === 'PHOTO' ? 'seam.jpg' : 'seam.mp4', contentType: kind === 'PHOTO' ? 'image/jpeg' : 'video/mp4', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 201)
  const sent = await app.inject({ method: 'PUT', url: answer.upload.url, headers: answer.upload.headers, payload: bytes })
  expect(sent.statusCode, sent.body).toBeLessThan(300)
  return (await ok('writer', 'POST', `/production/instructions/${instructionId}/files/${answer.file.id}/complete`)).file.id
}

beforeAll(async () => {
  h = await startHarness('instructions')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedTime, seedLabour, seedReasons, seedSkills, seedInstructions]) await seed({ db: h.database, namespace: NS })
  for (const [userId, name] of [[writer, 'Made-up Writer'], [approver, 'Made-up Approver'], [hr, 'Made-up HR'], [editor, 'Made-up Editor']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, $4, 'ACTIVE', now())`, [userId, T, `${userId}@example.com`, name])
  }
  wo = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
  for (const row of await admin<{ id: string; seq: number }>('SELECT id, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo])) wops[({ 10: 'cut', 20: 'sew', 30: 'qc', 40: 'pack' } as const)[row.seq as 10]] = row.id
  await admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = 'FREE', "quantityGuard" = 'FREE' WHERE id = $1`, [siteA1])
  // A made-up tablet at the packing bench (a report at packing is made at a packing station).
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Packing tablet W2B214', 'TABLET', 'ACTIVE', now())`, [packingTablet, T, companyA, siteA1, idOf('site:A1:station:PACK-01')])
  // The sheet's letterhead (art. 2250 c.c.): made-up legal data.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'RM', "reaNumber" = '000000', address = '{"line1":"Via Finta 1","postalCode":"00100","city":"Roma","country":"IT"}'::jsonb WHERE id = $1`, [companyA])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [T])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T])
  }
  redis = testRedis()
  const connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-instructions-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: limits },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await h?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const step = (code: string, extra: Json = {}) => ({ code, text: { it: `Passo ${code}`, en: `Step ${code}` }, ...extra })

describe('the office: instructions per operation, versions approved by a second person (PRD-117)', () => {
  let packId = ''

  it('lists the seed’s instructions with the version in force and counts, never a name', async () => {
    const list = await ok('viewer', 'GET', '/production/instructions')
    const sewing = list.instructions.find((row: Json) => row.id === SEED.sewing)
    expect(sewing).toMatchObject({ number: 'SEED-WI-0002', status: 'ACTIVE', style: null, current: { number: 2, steps: 3, media: 2 }, draft: { number: 3 } })
    expect(sewing.current.languages).toEqual(['en', 'it', 'ro'])
    expect(sewing.current.seen).toBeGreaterThanOrEqual(1)
    expect(list.instructions.find((row: Json) => row.id === SEED.revision)).toMatchObject({ style: { code: 'SEED-JKT-02', revision: 1 }, usedIn: 1 })
    expect(JSON.stringify(list)).not.toContain(operator)
    expect((await call('otherCompany', 'GET', `/production/instructions/${SEED.sewing}`)).statusCode).toBe(404)
  })

  it('makes an instruction numbered from the company’s series with a blank first draft; one in force per operation', async () => {
    const made = await ok('writer', 'POST', '/production/instructions', { companyId: companyA, operationId: ops.pack }, 201)
    packId = made.instruction.id
    expect(made.instruction.number).toMatch(/^WI-/)
    expect(made.versions).toEqual([expect.objectContaining({ number: 1, status: 'DRAFT', author: { id: writer, name: 'Made-up Writer' }, steps: 0 })])
    expect(refusalOf(await no('writer', 'POST', '/production/instructions', { companyId: companyA, operationId: ops.pack }, 409))).toBe('refusal/ACTIVE_EXISTS')
    expect((await call('viewer', 'POST', '/production/instructions', { companyId: companyA, operationId: ops.qc })).statusCode).toBe(403)
    expect((await outbox('production.instruction_changed')).find((payload) => payload.instructionId === packId)).toMatchObject({ change: 'CREATED', versionNumber: 1 })
  })

  it('saves a draft as a whole (steps per language, critical point, safety note, icon, tick, a photo); refuses in words', async () => {
    const record = await ok('writer', 'GET', `/production/instructions/${packId}`)
    const draft = record.versions[0]
    const fileId = await upload(packId)
    const saved = await ok('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, {
      version: draft.version,
      changeNote: null,
      steps: [step('FOLD', { icon: 'layers' }), step('LABEL_CHECK', { critical: true, safety: { it: 'Attenzione alla pinza', en: 'Mind the clip' }, requiredTick: true, icon: 'check', media: [{ fileId, kind: 'PHOTO', caption: { en: 'The label inside' } }] })],
    })
    expect(saved.steps.map((row: Json) => [row.code, row.requiredTick, row.icon, row.media.length])).toEqual([['FOLD', false, 'layers', 0], ['LABEL_CHECK', true, 'check', 1]])
    expect(saved.steps[1].missingLanguages).toEqual([])
    // Refused in words: a code twice, blank words, a video file named a photo; a code the tablet cannot tick (the contract).
    const stale = saved.version.version
    expect((await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: stale, steps: [step('A'), step('A')] }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/steps/1/code'])
    expect((await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: stale, steps: [{ code: 'A', text: { it: ' ' } }] }, 400)).issues[0].path).toBe('body/steps/0/text/it')
    expect((await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: stale, steps: [step('A', { media: [{ fileId, kind: 'VIDEO' }] })] }, 400)).issues[0].path).toBe('body/steps/0/media/0/kind')
    expect((await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: stale, steps: [step('lower case')] }, 400)).code).toBe('validation_failed')
    expect((await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: stale - 1, steps: [] }, 409)).code).toBe('conflict')
  })

  it('publishes only by a second person: the author is refused, the approver publishes, the floor sees it', async () => {
    const record = await ok('writer', 'GET', `/production/instructions/${packId}`)
    const draft = record.versions[0]
    expect(record.rights.approveHeld).toMatch(/your own draft/)
    expect(refusalOf(await no('writer', 'POST', `/production/instructions/${packId}/versions/${draft.id}/publish`, { version: draft.version }, 409))).toBe('refusal/OWN_DRAFT')
    const published = await ok('approver', 'POST', `/production/instructions/${packId}/versions/${draft.id}/publish`, { version: draft.version })
    expect(published.version).toMatchObject({ number: 1, status: 'PUBLISHED', approvedBy: { id: approver, name: 'Made-up Approver' } })
    expect(published.superseded).toBeNull()
    // A published version never changes: its save is refused in words.
    expect(refusalOf(await no('writer', 'PUT', `/production/instructions/${packId}/versions/${draft.id}`, { version: published.version.version, steps: [] }, 409))).toBe('refusal/NOT_DRAFT')
    expect((await outbox('production.instruction_published')).find((payload) => payload.instructionId === packId)).toMatchObject({ versionNumber: 1, supersededVersionId: null, acknowledgementRequired: true })
  })

  it('the next draft copies the version in force; a change note is asked; publishing supersedes the old one', async () => {
    const record = await ok('writer', 'GET', `/production/instructions/${packId}`)
    const drafted = await ok('writer', 'POST', `/production/instructions/${packId}/versions`, { version: record.instruction.version }, 201)
    expect(drafted.version).toMatchObject({ number: 2, status: 'DRAFT', steps: 2, media: 1 })
    expect(drafted.comparedWith).toMatchObject({ number: 1, added: [], removed: [], changed: [] })
    const again = await ok('writer', 'GET', `/production/instructions/${packId}`)
    expect(refusalOf(await no('writer', 'POST', `/production/instructions/${packId}/versions`, { version: again.instruction.version }, 409))).toBe('refusal/DRAFT_EXISTS')
    const edited = await ok('writer', 'PUT', `/production/instructions/${packId}/versions/${drafted.version.id}`, { version: drafted.version.version, steps: [...drafted.steps.map((row: Json) => ({ code: row.code, text: row.text, critical: row.critical, safety: row.safety, icon: row.icon, requiredTick: row.requiredTick, media: row.media.map((m: Json) => ({ fileId: m.fileId, kind: m.kind, caption: m.caption })) })), step('BAG')] })
    expect(edited.comparedWith).toMatchObject({ added: ['BAG'], removed: [], changed: [] })
    expect(refusalOf(await no('approver', 'POST', `/production/instructions/${packId}/versions/${drafted.version.id}/publish`, { version: edited.version.version }, 409))).toBe('refusal/CHANGE_NOTE_MISSING')
    const noted = await ok('writer', 'PUT', `/production/instructions/${packId}/versions/${drafted.version.id}`, { version: edited.version.version, changeNote: 'Adds the bag.', acknowledgementRequired: true })
    const published = await ok('approver', 'POST', `/production/instructions/${packId}/versions/${drafted.version.id}/publish`, { version: noted.version.version })
    expect(published.superseded).toMatchObject({ number: 1 })
    const versions = (await ok('viewer', 'GET', `/production/instructions/${packId}`)).versions
    expect(versions.map((row: Json) => [row.number, row.status])).toEqual([[2, 'PUBLISHED'], [1, 'SUPERSEDED']])
    expect(versions[1].supersededAt).not.toBeNull()
  })

  it('discards a draft with why; archives and restores; a restore that would make two in force is refused', async () => {
    const before = await ok('writer', 'GET', `/production/instructions/${packId}`)
    const drafted = await ok('writer', 'POST', `/production/instructions/${packId}/versions`, { version: before.instruction.version }, 201)
    expect((await no('writer', 'POST', `/production/instructions/${packId}/versions/${drafted.version.id}/discard`, { version: drafted.version.version, reason: '' }, 400)).code).toBe('validation_failed')
    expect((await ok('writer', 'POST', `/production/instructions/${packId}/versions/${drafted.version.id}/discard`, { version: drafted.version.version, reason: 'Not needed after all.' })).version.status).toBe('DISCARDED')
    const record = await ok('writer', 'GET', `/production/instructions/${packId}`)
    const archived = await ok('writer', 'POST', `/production/instructions/${packId}/archive`, { version: record.instruction.version, reason: 'Replaced.' })
    expect(archived.instruction.status).toBe('ARCHIVED')
    const twin = await ok('writer', 'POST', '/production/instructions', { companyId: companyA, operationId: ops.pack }, 201)
    expect(refusalOf(await no('writer', 'POST', `/production/instructions/${packId}/restore`, { version: archived.instruction.version }, 409))).toBe('refusal/ACTIVE_EXISTS')
    const twinRecord = await ok('writer', 'GET', `/production/instructions/${twin.instruction.id}`)
    await ok('writer', 'POST', `/production/instructions/${twin.instruction.id}/archive`, { version: twinRecord.instruction.version })
    expect((await ok('writer', 'POST', `/production/instructions/${packId}/restore`, { version: archived.instruction.version })).instruction.status).toBe('ACTIVE')
  })

  it('prints the sheet of a version as a PDF', async () => {
    const response = await call('viewer', 'GET', `/production/instructions/${SEED.sewing}/versions/${SEED.sewingV2}/sheet?language=en`)
    expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe('the floor: the instruction of the operation in hand (MES-110, MES-120) and Seen once (MES-119)', () => {
  it('shows the revision’s own instruction at sewing, in the worker’s language, with the machine settings; Seen waits', async () => {
    const { code } = await bundle()
    const answer = await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.sew}`)
    expect(answer.instruction).toMatchObject({ id: SEED.revision, number: 'SEED-WI-0003', forRevision: true, version: { id: SEED.revisionV1, number: 1 } })
    expect(answer.instruction.steps).toEqual([expect.objectContaining({ code: 'ZIP_GUARD', words: 'Cucire la pattina del cursore prima del collo.', shownIn: 'it', icon: 'needle' })])
    expect(answer.acknowledgement).toEqual({ due: 'FIRST', seenAt: null })
    // In English when asked; a step without the language falls back and says so.
    const english = await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.sew}&language=ro`)
    expect(english.instruction.steps[0].shownIn).toBe('it')
  })

  it('records Seen once per worker and version; a resend and a second Seen answer the first; queued offline too', async () => {
    const { code } = await bundle()
    const body = { clientEventId: cid('seen'), versionId: SEED.revisionV1 }
    const first = await ok('op', 'POST', '/production/instructions/floor/seen', body, 201)
    expect((await ok('op', 'POST', '/production/instructions/floor/seen', body, 200)).acknowledgement.id).toBe(first.acknowledgement.id)
    expect((await ok('op', 'POST', '/production/instructions/floor/seen', { ...body, clientEventId: cid('seen') }, 200)).acknowledgement.id).toBe(first.acknowledgement.id)
    expect((await admin('SELECT 1 FROM "InstructionAcknowledgement" WHERE "versionId" = $1 AND "workerId" = $2', [SEED.revisionV1, operator])).length).toBe(1)
    expect((await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.sew}`)).acknowledgement).toMatchObject({ due: null, seenAt: first.acknowledgement.at })
    // The event names the version, never the worker.
    const event = (await outbox('production.instruction_acknowledged')).find((payload) => payload.versionId === SEED.revisionV1)
    expect(event).toEqual({ instructionId: SEED.revision, number: 'SEED-WI-0003', versionId: SEED.revisionV1, versionNumber: 1, siteId: siteA1, way: 'FLOOR' })
    // A draft is not the floor's: refused.
    expect((await call('op', 'POST', '/production/instructions/floor/seen', { clientEventId: cid('seen'), versionId: idOf('instructions:wi:2:v3').replace(/^.{8}/, '00000000') })).statusCode).toBe(404)
    // Queued offline: accepted once, then a duplicate.
    const sewingV2Seen = await admin('SELECT 1 FROM "InstructionAcknowledgement" WHERE "versionId" = $1 AND "workerId" = $2', [SEED.sewingV2, operator])
    const events = [{ clientEventId: cid('queued'), seq: 1, kind: 'production.instruction.ack', payload: { versionId: SEED.sewingV2, locale: 'it' } }]
    const sent = await ok('op', 'POST', '/floor/sync', { events })
    expect(sent.events[0].status).toBe(sewingV2Seen.length > 0 ? 'duplicate' : 'accepted')
    expect((await ok('op', 'POST', '/floor/sync', { events })).events[0].status).toBe('duplicate')
  })

  it('a new version that asks for Seen opens again as CHANGED; My work counts what waits', async () => {
    const record = await ok('writer', 'GET', `/production/instructions/${SEED.revision}`)
    const drafted = await ok('writer', 'POST', `/production/instructions/${SEED.revision}/versions`, { version: record.instruction.version, changeNote: 'The guard before the collar, then the zip.' }, 201)
    await ok('approver', 'POST', `/production/instructions/${SEED.revision}/versions/${drafted.version.id}/publish`, { version: drafted.version.version })
    const { code } = await bundle()
    const answer = await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.sew}`)
    expect(answer.instruction.version.number).toBe(2)
    expect(answer.acknowledgement).toEqual({ due: 'CHANGED', seenAt: null })
    const mine = await ok('op', 'GET', '/production/instructions/floor/mine')
    expect(mine.due.find((row: Json) => row.instructionId === SEED.revision)).toMatchObject({ versionNumber: 2, reason: 'CHANGED' })
    expect(mine.seen.find((row: Json) => row.versionId === SEED.revisionV1)).toMatchObject({ number: 'SEED-WI-0003', versionNumber: 1 })
    await ok('op', 'POST', '/production/instructions/floor/seen', { clientEventId: cid('seen'), versionId: drafted.version.id }, 201)
    expect((await ok('op', 'GET', '/production/instructions/floor/mine')).due.find((row: Json) => row.instructionId === SEED.revision)).toBeUndefined()
  })

  it('shows a photo of a published version through the module only', async () => {
    const instruction = (await ok('viewer', 'GET', '/production/instructions')).instructions.find((row: Json) => row.operation.id === ops.pack && row.status === 'ACTIVE')
    const version = await ok('viewer', 'GET', `/production/instructions/${instruction.id}/versions/${instruction.current.versionId}`)
    const medium = version.steps.flatMap((row: Json) => row.media)[0]
    const answer = await ok('op', 'GET', `/production/instructions/floor/media/${medium.id}/download`)
    expect(answer.download).toMatchObject({ method: 'GET' })
    const fetched = await app.inject({ method: 'GET', url: answer.download.url, headers: answer.download.headers })
    expect(fetched.rawPayload.equals(photoBytes)).toBe(true)
    expect((await call('op', 'GET', `/files/${medium.fileId}/download`)).statusCode).toBeGreaterThanOrEqual(403)
  })

  it('gives the frozen spec of the bundle’s work order for its size, never a cost (PRD-258)', async () => {
    const { code } = await bundle()
    const spec = await ok('op', 'GET', `/production/instructions/floor/spec?code=${code}`)
    expect(spec).toMatchObject({ workOrder: { id: wo, number: 'SEED-WO-0001' }, style: { code: 'SEED-JKT-02' }, revision: { revision: 1, status: 'RELEASED' }, colourway: { code: 'BLK' }, size: { code: '52' } })
    expect(spec.size.measures.length).toBeGreaterThan(0)
    expect(spec.materials.length).toBeGreaterThan(0)
    expect(spec.materials[0].perGarment).toMatch(/^\d+(\.\d+)?$/)
    expect(JSON.stringify(spec)).not.toMatch(/cost|price/i)
    expect(spec.operations.map((row: Json) => row.seq)).toEqual([10, 20, 30, 40])
  })
})

describe('the steps the tablet ticks are the published version’s (WI1:01-03)', () => {
  it('a required step of the published instruction holds Finish until ticked; its icon and critical point show', async () => {
    const { id: bundleId, code } = await bundle()
    const state = await ok('packer', 'GET', `/production/checklists/state?code=${code}&workOrderOperationId=${wops.pack}`)
    expect(state.steps.map((row: Json) => [row.code, row.required, row.icon, row.critical])).toEqual([['FOLD', false, 'layers', false], ['LABEL_CHECK', true, 'check', true], ['BAG', false, null, false]])
    expect(state.open).toBe(1)
    expect(refusalOf(await no('packer', 'POST', '/production/scans', { clientScanId: cid('pack'), bundleId, good: 20, workOrderOperationId: wops.pack }, 409))).toBe('refusal/CHECKLIST_OPEN')
    // The tick names the instruction step's code (OperationChecklistResult.stepCode).
    await ok('packer', 'POST', '/production/checklists/tick', { clientEventId: cid('tick'), bundleId, workOrderOperationId: wops.pack, stepCode: 'LABEL_CHECK' }, 201)
    expect(refusalOf(await no('packer', 'POST', '/production/checklists/tick', { clientEventId: cid('tick'), bundleId, workOrderOperationId: wops.pack, stepCode: 'TRIM_THREADS' }, 409))).toBe('refusal/CHECKLIST_STEP_UNKNOWN')
    await ok('packer', 'POST', '/production/scans', { clientScanId: cid('pack'), bundleId, good: 20, workOrderOperationId: wops.pack }, 201)
  })

  it('brings the typed lines into a first version once; they stay the steps until a second person publishes it', async () => {
    await typedLinesAt(wops.qc, 'Look at the whole jacket.\n[ ] SEAMS_OK Check every seam\n[o] LINT Brush the lint off')
    const dry = await ok('writer', 'GET', `/production/instructions/typed-steps?companyId=${companyA}`)
    const row = dry.rows.find((entry: Json) => entry.revision.id === SEED.releasedRevision && entry.step.seq === 30)
    expect(row).toMatchObject({ existing: null, steps: [{ code: 'SEAMS_OK', words: 'Check every seam', requiredTick: true }, { code: 'LINT', words: 'Brush the lint off', requiredTick: false }] })
    const brought = await ok('writer', 'POST', '/production/instructions/typed-steps', { companyId: companyA, language: 'en' })
    const made = brought.made.find((entry: Json) => entry.routingOperationId === row.routingOperationId)
    expect(made.number).toMatch(/^WI-/)
    expect((await ok('writer', 'POST', '/production/instructions/typed-steps', { companyId: companyA })).made).toEqual([])
    expect((await ok('writer', 'GET', `/production/instructions/typed-steps?companyId=${companyA}`)).rows.find((entry: Json) => entry.routingOperationId === row.routingOperationId).existing).toMatchObject({ id: made.instructionId })
    const { code } = await bundle()
    // A draft changes nothing on the floor: the typed lines stay the steps.
    expect((await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.qc}`)).instruction).toBeNull()
    expect((await ok('op', 'GET', `/production/checklists/state?code=${code}&workOrderOperationId=${wops.qc}`)).steps.map((entry: Json) => entry.code)).toEqual(['SEAMS_OK', 'LINT'])
    const version = (await ok('writer', 'GET', `/production/instructions/${made.instructionId}`)).versions[0]
    expect(refusalOf(await no('writer', 'POST', `/production/instructions/${made.instructionId}/versions/${made.versionId}/publish`, { version: version.version }, 409))).toBe('refusal/OWN_DRAFT')
    await ok('approver', 'POST', `/production/instructions/${made.instructionId}/versions/${made.versionId}/publish`, { version: version.version })
    const floor = await ok('op', 'GET', `/production/instructions/floor/operation?code=${code}&workOrderOperationId=${wops.qc}`)
    expect(floor.instruction).toMatchObject({ id: made.instructionId, forRevision: true, steps: [{ code: 'SEAMS_OK', words: 'Check every seam', shownIn: 'en', requiredTick: true }, { code: 'LINT', requiredTick: false }] })
    await typedLinesAt(wops.qc, null)
    expect((await ok('op', 'GET', `/production/checklists/state?code=${code}&workOrderOperationId=${wops.qc}`)).steps.map((entry: Json) => entry.code)).toEqual(['SEAMS_OK', 'LINT'])
  })
})

describe('acknowledgements: a training record, by name only to HR and where the gate allows (MES-119)', () => {
  it('counts per version and site for every viewer; names only for HR with the site’s gate open; a paper one once', async () => {
    const counted = await ok('viewer', 'GET', `/production/instructions/${SEED.revision}/acknowledgements`)
    expect(counted.people).toBeNull()
    expect(counted.canSeePeople).toBe(false)
    expect(counted.versions.find((row: Json) => row.number === 1).seen).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(counted)).not.toContain(operator)
    const hidden = await ok('hr', 'GET', `/production/instructions/${SEED.revision}/acknowledgements`)
    expect(hidden.people.rows.length).toBeGreaterThan(0)
    expect(hidden.people.rows.every((row: Json) => row.worker === null && row.workerHidden)).toBe(true)
    const off = await switchOnPerformance(admin, { tenantId: T, companyId: companyA, siteId: siteA1, byId: hr })
    try {
      const named = await ok('hr', 'GET', `/production/instructions/${SEED.revision}/acknowledgements`)
      expect(named.people.rows.find((row: Json) => row.worker?.id === operator)).toMatchObject({ workerHidden: false, lastSeen: { versionNumber: 2, way: 'FLOOR' } })
    } finally {
      await off()
    }
    // HR records the team leader's paper acknowledgement of the packing instruction in force; a second is refused, and a
    // paper signed before the version was published or in the future.
    const lead = idOf('worker:A1:lead')
    const pack = (await ok('viewer', 'GET', '/production/instructions')).instructions.find((row: Json) => row.operation.id === ops.pack && row.status === 'ACTIVE')
    const url = `/production/instructions/${pack.id}/versions/${pack.current.versionId}/acknowledgements`
    expect((await no('hr', 'POST', url, { workerId: lead, locale: 'it', acknowledgedAt: '2020-01-01T08:00:00.000Z' }, 400)).issues[0].path).toBe('body/acknowledgedAt')
    const paper = await ok('hr', 'POST', url, { workerId: lead, locale: 'it' }, 201)
    expect(paper.current).toMatchObject({ versionId: pack.current.versionId })
    expect(paper.versions.find((row: Json) => row.versionId === pack.current.versionId).seen).toBe(1)
    expect(refusalOf(await no('hr', 'POST', url, { workerId: lead, locale: 'it' }, 409))).toBe('refusal/SEEN_ALREADY')
    expect((await call('viewer', 'POST', url, { workerId: lead, locale: 'it' })).statusCode).toBe(403)
    expect((await outbox('production.instruction_acknowledged')).some((payload) => payload.way === 'PAPER' && payload.versionId === pack.current.versionId)).toBe(true)
  })
})

// B-W2b-F24 (Owner W2b-5 Q3: nobody approves their own work, the Owner included): the four eyes cover who changed the draft too.
describe('nobody publishes a draft they changed (B-W2b-F24)', () => {
  it('a second manager with every right who saved the draft is refused EDITED_DRAFT; a third person publishes it', async () => {
    const made = await ok('writer', 'POST', '/production/instructions', { companyId: companyA, operationId: ops.cut }, 201)
    const instructionId = made.instruction.id
    const draft = made.versions[0]
    const saved = await ok('editor', 'PUT', `/production/instructions/${instructionId}/versions/${draft.id}`, { version: draft.version, steps: [step('SPREAD')] })
    expect((await ok('editor', 'GET', `/production/instructions/${instructionId}`)).rights.approveHeld).toBe(`You changed version 1 of ${made.instruction.number}: a person who neither wrote nor changed it approves it (four eyes).`)
    const refused = await no('editor', 'POST', `/production/instructions/${instructionId}/versions/${draft.id}/publish`, { version: saved.version.version }, 409)
    expect(refusalOf(refused)).toBe('refusal/EDITED_DRAFT')
    expect(refusalOf(await no('writer', 'POST', `/production/instructions/${instructionId}/versions/${draft.id}/publish`, { version: saved.version.version }, 409))).toBe('refusal/OWN_DRAFT')
    expect((await ok('approver', 'GET', `/production/instructions/${instructionId}`)).rights.approveHeld).toBeNull()
    const published = await ok('approver', 'POST', `/production/instructions/${instructionId}/versions/${draft.id}/publish`, { version: saved.version.version })
    expect(published.version).toMatchObject({ number: 1, status: 'PUBLISHED', approvedBy: { id: approver, name: 'Made-up Approver' } })
  })
})
