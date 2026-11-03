import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { DEFECT_CLASSES, DISPOSITION_FOLLOW_UPS, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { STANDARD_DISPOSITIONS, STARTER_LIBRARY } from '@nexus/factory-domain/quality/defects/standard'
import { CAUSE_PROCESSES, STARTER_CAUSES } from '@nexus/factory-domain/quality/defects/causes'
import { STARTER_GRADES } from '@nexus/factory-domain/quality/defects/grades'
import { SAFETY_RULE } from '@nexus/factory-domain/quality/defects/severity'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { postDispositionInCommand } from './stock'

/**
 * The defect library and the disposition codes (B-W2a-26; QHS-001, QHS-005) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_quality_plant_w2a_guards
 * DefectCode / DispositionCode triggers are real), tenant A from EVERY seed (its starter library, its seven disposition
 * codes, the NCRs that name STITCH-SKIP and GRAIN-CRACK, the hold of SEED-HIDE-0002) and tenant B bare, as a new tenant
 * is. Made-up words only.
 *   - the library as a tree with how often each code is used; the pickers (office and floor) get the active defects of a
 *     stage; two levels; a code never changes; a used code is retired, an unused one deleted; the picture is a file of
 *     the code; the starter set on a bare tenant;
 *   - the disposition codes with their stock action in words, the approval amount only with the cost grain; a new code's
 *     move and follow-up are its outcome's; the standard codes on a bare tenant;
 *   - a disposition's stock move posts through the ledger: a quarantine TRANSFER of held stock, a SCRAP, an ISSUE refused
 *     while a hold holds the stock, no move for use-as-is.
 * B-W2b-90's defect vocabulary (QHS-002, QHS-004, QHS-006, QHS-007), on the same database (one migration for the folder):
 *   - the severity classes with the safety rule (critical locked at 0, its law);
 *   - the cause codes: the seed's eight with how often each is used, a code and its process fixed, retired when used,
 *     deleted when not, the starter set on a bare tenant;
 *   - the leather grades with the hide defects of the library's hide category; a grade retired, never deleted; A-D on a
 *     bare tenant;
 *   - the vocabulary in the person's language (the worker's on the floor, the one asked in the office), English standing
 *     in where a code has no words, and the codes each floor language still lacks.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/defects`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'defects-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `defects-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), siteA1: id('site:A1'), hideH2: id('inventory:hide:H2'), quarantine: id('inventory:location:A1-QUA'), wo1: id('production:work-order:WO-0001') }
const tenantB = newId()
const companyB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP: Permission[] = ['quality.defects.view', 'quality.defects.manage']
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, [grant(KEEP)]),
  costKeeper: office(A.tenant, [grant([...KEEP, 'money.cost'])]),
  viewer: office(A.tenant, [grant(['quality.defects.view'])]),
  // Keeps codes for company A only: the library is the whole group's, so it may read but not keep it.
  companyKeeper: office(A.tenant, [grant(KEEP, { companies: [A.companyA] })]),
  nobody: office(A.tenant, [grant(['sites.view'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: id('worker:A1:operator'), siteId: A.siteA1, deviceId: id('device:A1:cutting'), grants: [grant(['floor.work'], { companies: [A.companyA], sites: [A.siteA1] })] },
  keeperB: office(tenantB, [grant([...KEEP, 'money.cost'])]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const library = async (session = 'keeper') => ok(session, 'GET', '/quality/defects')
const defectIn = (view: Json, code: string): Json => (view.categories as Json[]).flatMap((category) => [category, ...category.defects]).find((row: Json) => row.code === code)!
const events = async (type: string, tenantId = A.tenant) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenantId, type])).map((row) => row.payload)
const enumOf = async (name: string) => (await admin<{ value: string }>(`SELECT unnest(enum_range(NULL::"${name}"))::text AS value`)).map((row) => row.value)

beforeAll(async () => {
  db = await migratedDatabase('quality_defects')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'defects-b', 'Gruppo Nuovo')`, [tenantB])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'NUOVA', 'Nuova Prova S.r.l.')`, [companyB, tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the domain lists match the database', () => {
  it('stages, classes, outcomes and follow-ups', async () => {
    expect(await enumOf('QualityStage')).toEqual([...QUALITY_STAGES])
    expect(await enumOf('DefectClass')).toEqual([...DEFECT_CLASSES])
    expect(await enumOf('DispositionOutcome')).toEqual([...DISPOSITION_OUTCOMES])
    expect(await enumOf('DispositionFollowUp')).toEqual([...DISPOSITION_FOLLOW_UPS])
  })
})

describe('the defect library (QHS-001)', () => {
  it('reads the tree with how often each code is used, the zones, the stages and nothing missing of the starter set', async () => {
    const view = await library()
    expect(view.categories.map((category: Json) => category.code)).toEqual(['SEAM', 'LEATHER', 'FITTING', 'PROTECTION', 'LABEL', 'FINISH'])
    expect(defectIn(view, 'SEAM').defects.map((row: Json) => row.code)).toEqual(['SEAM-OPEN', 'STITCH-SKIP', 'PUCKERING', 'NEEDLE-HOLES'])
    expect(defectIn(view, 'STITCH-SKIP')).toMatchObject({ severity: 'MINOR', stages: ['IN_LINE', 'FINAL'], usedCount: 1, active: true })
    expect(defectIn(view, 'GRAIN-CRACK').usedCount).toBe(1)
    expect(defectIn(view, 'SEAM')).toMatchObject({ severity: null, usedCount: 4 })
    expect(view.starterMissing).toEqual([])
    expect(view.zones.map((zone: Json) => zone.id)).toContain('SHOULDER')
    expect(view.canManage).toBe(true)
    expect((await library('viewer')).canManage).toBe(false)
    expect((await library('companyKeeper')).canManage).toBe(false)
    expect((await refused('nobody', 'GET', '/quality/defects', undefined, 403)).code).toBe('forbidden')
  })

  it('gives the pickers of the office and the floor the active defects of a stage', async () => {
    const final = (await ok('floor', 'GET', '/quality/defects/picker?stage=FINAL')).defects as Json[]
    expect(final.map((row) => row.code)).toContain('THREAD-END')
    expect(final.map((row) => row.code)).not.toContain('HIDE-SCAR')
    expect(final.find((row) => row.code === 'OTHER')).toMatchObject({ needsDetail: true, category: { code: 'FINISH' } })
    expect(final.every((row) => row.severity !== null)).toBe(true)
    const all = (await ok('nobody', 'GET', '/quality/defects/picker')).defects as Json[]
    expect(all.length).toBe(STARTER_LIBRARY.flatMap((category) => category.defects).length)
  })

  it('adds a category and a defect in it; two levels, a free code, a class for a defect', async () => {
    const { defect: category } = await ok('keeper', 'POST', '/quality/defects', { code: 'lining', labelIt: 'Fodera', labelEn: 'Lining', icon: 'shirt', colour: '#1F6FDE' }, 201)
    expect(category).toMatchObject({ code: 'LINING', parentId: null, severity: null, colour: '#1f6fde', sortOrder: 600, usedCount: 0 })
    const { defect } = await ok('keeper', 'POST', '/quality/defects', { code: 'LINING-TORN', parentId: category.id, labelIt: 'Fodera strappata', labelEn: 'Torn lining', severity: 'MAJOR', zone: 'LINING', stages: ['FINAL', 'IN_LINE'] }, 201)
    expect(defect).toMatchObject({ parentId: category.id, severity: 'MAJOR', zone: 'LINING', stages: ['IN_LINE', 'FINAL'], sortOrder: 601 })
    expect((await refused('keeper', 'POST', '/quality/defects', { code: 'LINING-TORN', parentId: category.id, labelIt: 'x', labelEn: 'y', severity: 'MINOR' }, 409)).message).toBe('Code LINING-TORN is taken.')
    expect(paths(await refused('keeper', 'POST', '/quality/defects', { code: 'DEEPER', parentId: defect.id, labelIt: 'x', labelEn: 'y', severity: 'MINOR' }, 400))).toEqual(['body/parentId'])
    expect(paths(await refused('keeper', 'POST', '/quality/defects', { code: 'NO-CLASS', parentId: category.id, labelIt: 'x', labelEn: 'y' }, 400))).toEqual(['body/severity'])
    expect(paths(await refused('keeper', 'POST', '/quality/defects', { code: 'BAD ZONE', parentId: category.id, labelIt: 'x', labelEn: 'y', severity: 'MINOR', zone: 'TAIL', icon: 'unicorn' }, 400))).toEqual(['body/code', 'body/icon', 'body/zone'])
    expect((await refused('companyKeeper', 'POST', '/quality/defects', { code: 'MINE', labelIt: 'x', labelEn: 'y' }, 403)).message).toMatch(/whole group/)
    expect((await events('quality.defects_changed')).filter((payload) => payload.change === 'CREATED').map((payload) => payload.codes)).toEqual([['LINING'], ['LINING-TORN']])
  })

  it('changes a defect at the version read; retires a used code and the pickers drop it; makes it active again', async () => {
    const before = defectIn(await library(), 'STITCH-SKIP')
    const { defect, retireWords } = await ok('keeper', 'PATCH', `/quality/defects/${before.id}`, { version: before.version, labelEn: 'Skipped stitches', labelI18n: { ro: 'Cusături sărite' }, active: false })
    expect(defect).toMatchObject({ labelEn: 'Skipped stitches', labelI18n: { ro: 'Cusături sărite' }, active: false, version: before.version + 1 })
    expect(retireWords).toBe('STITCH-SKIP is used on 1 record; it stays on them and leaves the pickers.')
    expect(((await ok('floor', 'GET', '/quality/defects/picker')).defects as Json[]).map((row) => row.code)).not.toContain('STITCH-SKIP')
    expect((await refused('keeper', 'PATCH', `/quality/defects/${before.id}`, { version: before.version, active: true }, 409)).code).toBe('conflict')
    expect(paths(await refused('keeper', 'PATCH', `/quality/defects/${before.id}`, { version: defect.version, severity: null }, 400))).toEqual(['body/severity'])
    // The code and its category are not in the body at all (the contract is strict).
    expect((await refused('keeper', 'PATCH', `/quality/defects/${before.id}`, { version: defect.version, code: 'OTHER-CODE' }, 400)).code).toBe('validation_failed')
    const again = await ok('keeper', 'PATCH', `/quality/defects/${before.id}`, { version: defect.version, active: true, labelI18n: { ro: null } })
    expect(again.defect).toMatchObject({ active: true, labelI18n: {} })
    expect((await events('quality.defects_changed')).map((payload) => payload.change)).toEqual(expect.arrayContaining(['RETIRED', 'REACTIVATED']))
  })

  it('sets the picture: a confirmed image of this code only', async () => {
    const target = defectIn(await library(), 'STAIN')
    const other = defectIn(await library(), 'PUCKERING')
    const file = async (recordId: string, contentType = 'image/png', status = 'AVAILABLE') => {
      const fileId = newId()
      const account = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' LIMIT 1`, [A.tenant]))[0]!.id
      await admin(
        `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt", "updatedAt")
         VALUES ($1, $2, NULL, 'DefectCode', $3, 'PHOTO', 'stain.png', $4, 1200, $5, $6, $7, $8::"FileStatus", CASE WHEN $8 = 'AVAILABLE' THEN now() END, now())`,
        [fileId, A.tenant, recordId, contentType, 'a'.repeat(64), account, `t/${fileId}`, status],
      )
      return fileId
    }
    const picture = await file(target.id)
    const { defect } = await ok('keeper', 'PATCH', `/quality/defects/${target.id}`, { version: target.version, pictureFileId: picture })
    expect(defect.pictureFileId).toBe(picture)
    expect(paths(await refused('keeper', 'PATCH', `/quality/defects/${target.id}`, { version: defect.version, pictureFileId: await file(other.id) }, 400))).toEqual(['body/pictureFileId'])
    expect((await refused('keeper', 'PATCH', `/quality/defects/${target.id}`, { version: defect.version, pictureFileId: await file(target.id, 'application/pdf') }, 400)).message).toBe('The picture is an image.')
    expect((await refused('keeper', 'PATCH', `/quality/defects/${target.id}`, { version: defect.version, pictureFileId: await file(target.id, 'image/png', 'PENDING_UPLOAD') }, 400)).message).toBe('The picture is not uploaded yet.')
  })

  it('deletes only a code nothing names', async () => {
    const view = await library()
    const torn = defectIn(view, 'LINING-TORN')
    const lining = defectIn(view, 'LINING')
    expect((await refused('keeper', 'DELETE', `/quality/defects/${lining.id}?version=${lining.version}`, undefined, 409)).message).toBe('Category LINING has defects: delete or move them first, or retire it.')
    const grain = defectIn(view, 'GRAIN-CRACK')
    expect((await refused('keeper', 'DELETE', `/quality/defects/${grain.id}?version=${grain.version}`, undefined, 409)).message).toMatch(/used on 1 record: retire it instead/)
    expect(await ok('keeper', 'DELETE', `/quality/defects/${torn.id}?version=${torn.version}`)).toEqual({ deleted: torn.id, code: 'LINING-TORN' })
    expect(await ok('keeper', 'DELETE', `/quality/defects/${lining.id}?version=${lining.version}`)).toMatchObject({ code: 'LINING' })
    expect(defectIn(await library(), 'LINING')).toBeUndefined()
  })

  it('gives a bare tenant the starter set, once', async () => {
    const first = await ok('keeperB', 'POST', '/quality/defects/starter', {})
    expect(first.added.slice(0, 6)).toEqual(['SEAM', 'LEATHER', 'FITTING', 'PROTECTION', 'LABEL', 'FINISH'])
    expect(first.added).toHaveLength(6 + STARTER_LIBRARY.flatMap((category) => category.defects).length)
    const view = await library('keeperB')
    expect(defectIn(view, 'ARMOUR-POCKET-MISSING')).toMatchObject({ severity: 'CRITICAL', zone: 'SHOULDER', icon: null })
    expect(defectIn(view, 'PROTECTION')).toMatchObject({ icon: 'shield', colour: '#e5484d', sortOrder: 400 })
    expect(view.starterMissing).toEqual([])
    expect((await ok('keeperB', 'POST', '/quality/defects/starter', {})).added).toEqual([])
  })
})

describe('the disposition codes (QHS-005)', () => {
  it('lists the codes with their stock action in words; the approval amount only with the cost grain', async () => {
    const plain = await ok('keeper', 'GET', '/quality/dispositions')
    expect(plain.dispositions.map((row: Json) => row.code)).toEqual(STANDARD_DISPOSITIONS.map((code) => code.code))
    const scrap = plain.dispositions[0]
    expect(scrap).toMatchObject({ outcome: 'SCRAP', stockMoveReason: 'SCRAP', followUp: null, stockAction: 'Posts a SCRAP move out of stock.', approvalSeverity: 'CRITICAL', usedCount: 1 })
    expect('approvalAmount' in scrap).toBe(false)
    expect((await ok('costKeeper', 'GET', '/quality/dispositions')).dispositions[0].approvalAmount).toBe(50_000)
    expect(plain.dispositions.find((row: Json) => row.code === 'REWORK').stockAction).toBe('Moves no stock; opens a rework order; the goods are inspected again before they are released.')
    expect(plain.outcomes.find((option: Json) => option.outcome === 'RETURN_TO_SUPPLIER')).toMatchObject({ moves: [null, 'ADJUSTMENT', 'TRANSFER'], followUps: ['SUPPLIER_CLAIM', null] })
    expect(plain.standardMissing).toEqual([])
  })

  it('adds a code whose move and follow-up are its outcome\'s; never changes them', async () => {
    const { disposition } = await ok('costKeeper', 'POST', '/quality/dispositions', { code: 'second_grade', labelIt: 'Outlet', labelEn: 'Outlet', outcome: 'REGRADE', approvalAmount: 20_000 }, 201)
    expect(disposition).toMatchObject({ code: 'SECOND_GRADE', stockMoveReason: 'TRANSFER', followUp: null, reinspection: false, approvalAmount: 20_000, sortOrder: 7 })
    expect(paths(await refused('keeper', 'POST', '/quality/dispositions', { code: 'SCRAP_MOVE', labelIt: 'x', labelEn: 'y', outcome: 'SCRAP', stockMoveReason: 'TRANSFER' }, 400))).toEqual(['body/stockMoveReason'])
    // Without the cost grain, a body that sends an amount is refused by the grain filter.
    expect((await call('keeper', 'POST', '/quality/dispositions', { code: 'CHEAP', labelIt: 'x', labelEn: 'y', outcome: 'SCRAP', approvalAmount: 1 })).statusCode).toBeGreaterThanOrEqual(400)
    expect((await refused('keeper', 'PATCH', `/quality/dispositions/${disposition.id}`, { version: disposition.version, outcome: 'SCRAP' }, 400)).code).toBe('validation_failed')
    const { disposition: edited } = await ok('keeper', 'PATCH', `/quality/dispositions/${disposition.id}`, { version: disposition.version, approvalSeverity: 'MAJOR', active: false })
    expect(edited).toMatchObject({ approvalSeverity: 'MAJOR', active: false })
    expect((await refused('companyKeeper', 'PATCH', `/quality/dispositions/${disposition.id}`, { version: edited.version, active: true }, 403)).code).toBe('forbidden')
    expect((await events('quality.dispositions_changed')).map((payload) => payload.change)).toEqual(['CREATED', 'DEACTIVATED'])
  })

  it('gives a bare tenant the standard codes, once', async () => {
    expect((await ok('keeperB', 'POST', '/quality/dispositions/standard', {})).added).toEqual(STANDARD_DISPOSITIONS.map((code) => code.code))
    expect((await ok('keeperB', 'GET', '/quality/dispositions')).dispositions.find((row: Json) => row.code === 'SCRAP')).toMatchObject({ approvalAmount: 50_000, stockMoveReason: 'SCRAP' })
    expect((await ok('keeperB', 'POST', '/quality/dispositions/standard', {})).added).toEqual([])
  })
})

describe('a disposition moves the stock through the ledger (QHS-005)', () => {
  const office = () => callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.stock.view'])], requestId: newId() })
  const codeId = async (code: string) => (await admin<{ id: string }>(`SELECT id FROM "DispositionCode" WHERE "tenantId" = $1 AND code = $2`, [A.tenant, code]))[0]!.id
  const run = (input: Omit<Parameters<typeof postDispositionInCommand>[1], 'key'>) =>
    command(office(), { name: 'quality.testDisposition', input }, async (tools) => {
      const result = await postDispositionInCommand(tools, { ...input, key: `quality.testDisposition:${newId()}` })
      tools.audit({ recordType: 'Tenant', recordId: A.tenant, after: { moves: result.moves.length } })
      return { moves: result.moves.map((move) => ({ reason: move.reason, from: move.fromLocationId, to: move.toLocationId, hideId: move.hideId, note: move.note })), followUp: result.followUp, words: result.words }
    })

  it('moves held stock to quarantine (a TRANSFER is never blocked by a hold); an ISSUE of it waits for the hold', async () => {
    const [holds] = await admin<{ held: string }>(`SELECT count(*)::text AS held FROM "QualityHold" WHERE "tenantId" = $1 AND status = 'ACTIVE' AND $2 = ANY("subjectIds")`, [A.tenant, A.hideH2])
    expect(holds?.held).toBe('1')
    const moved = await run({ dispositionCodeId: await codeId('QUARANTINE'), siteId: A.siteA1, lines: [{ hideId: A.hideH2 }], toLocationId: A.quarantine, reference: 'SEED-NCR-0002', note: 'Grain crack across the butt' })
    expect(moved.result.moves.length).toBeGreaterThan(0)
    expect(moved.result.moves.every((move) => move.reason === 'TRANSFER' && move.to === A.quarantine && move.note === 'QUARANTINE: Grain crack across the butt')).toBe(true)
    await expect(run({ dispositionCodeId: await codeId('QUARANTINE'), siteId: A.siteA1, lines: [{ hideId: A.hideH2 }], toLocationId: id('inventory:location:A1-STORE-01'), reference: 'X', note: 'y' })).rejects.toMatchObject({ message: 'A1-STORE-01 is not a quarantine place.' })
    const issueCode = (await admin<{ id: string }>(`INSERT INTO "DispositionCode" (id, "tenantId", code, "labelIt", "labelEn", outcome, "stockMoveReason") VALUES ($1, $2, 'USE_ON_WO', 'Usa', 'Use on the order', 'REGRADE', 'ISSUE') RETURNING id`, [newId(), A.tenant]))[0]!.id
    await expect(run({ dispositionCodeId: issueCode, siteId: A.siteA1, lines: [{ hideId: A.hideH2 }], workOrderId: A.wo1, reference: 'X', note: 'y' })).rejects.toMatchObject({ message: expect.stringMatching(/^Hide SEED-HIDE-0002 is on hold \(Quality check, since 21 Nov 2026\): it is not issued until quality releases the hold\.$/) })
  })

  it('scraps stock with a SCRAP move; use as is moves nothing', async () => {
    const [lot] = await admin<{ lotId: string; itemId: string; locationId: string; quantity: string }>(
      `SELECT m."lotId", m."itemId", m."toLocationId" AS "locationId", m."baseQuantity"::text AS quantity FROM "StockMove" m JOIN "Lot" l ON l.id = m."lotId"
        WHERE m."tenantId" = $1 AND m."siteId" = $2 AND m."hideId" IS NULL AND m."toLocationId" IS NOT NULL AND l."qualityStatus" = 'RELEASED' ORDER BY m.id LIMIT 1`,
      [A.tenant, A.siteA1],
    )
    expect(lot).toBeDefined()
    const scrapped = await run({ dispositionCodeId: await codeId('SCRAP'), siteId: A.siteA1, lines: [{ itemId: lot!.itemId, lotId: lot!.lotId, fromLocationId: lot!.locationId, quantity: '0.0100' }], reference: 'NCR-T', note: 'Stained' })
    expect(scrapped.result).toMatchObject({ moves: [{ reason: 'SCRAP', from: lot!.locationId, to: null, note: 'SCRAP: Stained' }], followUp: null, words: 'Posts a SCRAP move out of stock.' })
    await expect(run({ dispositionCodeId: await codeId('USE_AS_IS'), siteId: A.siteA1, lines: [{ itemId: lot!.itemId, lotId: lot!.lotId, fromLocationId: lot!.locationId, quantity: '1' }], reference: 'X', note: 'y' })).rejects.toMatchObject({ message: 'USE_AS_IS moves no stock: send no lines.' })
    const rework = await run({ dispositionCodeId: await codeId('REWORK'), siteId: A.siteA1, lines: [], reference: 'X', note: 'y' })
    expect(rework.result).toMatchObject({ moves: [], followUp: 'REWORK_ORDER' })
  })
})

// ---- B-W2b-90: the defect vocabulary ---------------------------------------------------------------------------------

const vocabularyEvents = async (list: string, tenantId = A.tenant) => (await events('quality.vocabulary_changed', tenantId)).filter((payload) => payload.list === list).map((payload) => `${payload.change} ${payload.codes.join(',')}`)
const one = async (sql: string, values: unknown[]) => Number((await admin<{ n: string }>(sql, values))[0]!.n)

describe('the severity classes with the safety rule (QHS-002)', () => {
  it('reads critical, major and minor; critical is locked at an acceptance number of 0 with its law', async () => {
    const view = await ok('viewer', 'GET', '/quality/severity')
    expect(view.classes.map((entry: Json) => entry.class)).toEqual([...DEFECT_CLASSES])
    const critical = await one(`SELECT count(*)::text AS n FROM "DefectCode" WHERE "tenantId" = $1 AND active AND "parentId" IS NOT NULL AND severity = 'CRITICAL'`, [A.tenant])
    expect(critical).toBeGreaterThan(0)
    expect(view.classes[0]).toMatchObject({ class: 'CRITICAL', rank: 0, acceptanceNumber: 0, locked: true, law: expect.stringMatching(/2016\/425/), words: { it: 'Critico', en: 'Critical' }, defects: critical })
    expect(view.classes[1]).toMatchObject({ class: 'MAJOR', acceptanceNumber: null, locked: false, law: null })
    expect(view.safetyRule).toMatchObject({ en: SAFETY_RULE.en, it: SAFETY_RULE.it, law: expect.stringMatching(/2016\/425/) })
    expect(view.editable).toBe(false)
    expect((await refused('nobody', 'GET', '/quality/severity', undefined, 403)).code).toBe('forbidden')
    expect((await call('floor', 'GET', '/quality/severity')).statusCode).toBe(403)
  })
})

describe('the cause codes (QHS-004)', () => {
  it('the processes are the database\'s', async () => {
    expect(await enumOf('CauseProcess')).toEqual([...CAUSE_PROCESSES])
  })

  it('reads the seed\'s eight in order with their process and how often inspection defects and NCRs name each', async () => {
    const view = await ok('viewer', 'GET', '/quality/causes')
    expect(view.causes.map((row: Json) => row.code)).toEqual(STARTER_CAUSES.map((cause) => cause.code))
    const used = (code: string) => one(
      `SELECT ((SELECT count(*) FROM "InspectionDefect" d JOIN "CauseCode" c ON c.id = d."causeCodeId" WHERE c."tenantId" = $1 AND c.code = $2) + (SELECT count(*) FROM "Nonconformance" n JOIN "CauseCode" c ON c.id = n."causeCodeId" WHERE c."tenantId" = $1 AND c.code = $2))::text AS n`,
      [A.tenant, code],
    )
    const mat = view.causes.find((row: Json) => row.code === 'MAT-FAULT')
    expect(mat).toMatchObject({ process: 'MATERIAL', processWords: { it: 'Materiale', en: 'Material' }, active: true, usedCount: await used('MAT-FAULT'), missingLanguages: [] })
    expect(mat.usedCount).toBeGreaterThan(0)
    expect(mat.labelI18n.ro).toBeTruthy()
    expect(view.causes.find((row: Json) => row.code === 'SEW-ERROR').usedCount).toBe(await used('SEW-ERROR'))
    expect(view.processes).toHaveLength(8)
    expect(view).toMatchObject({ languages: [], starterMissing: [], canManage: false })
    expect((await ok('keeper', 'GET', '/quality/causes')).canManage).toBe(true)
    expect((await refused('nobody', 'GET', '/quality/causes', undefined, 403)).code).toBe('forbidden')
  })

  it('adds a code with its process; a free code, a known process; only a keeper of the whole group', async () => {
    const { cause } = await ok('keeper', 'POST', '/quality/causes', { code: 'stitch-tension', process: 'SEWING', labelIt: 'Tensione del filo', labelEn: 'Thread tension' }, 201)
    expect(cause).toMatchObject({ code: 'STITCH-TENSION', process: 'SEWING', sortOrder: 80, usedCount: 0, active: true, version: 1 })
    expect((await refused('keeper', 'POST', '/quality/causes', { code: 'SEW-ERROR', process: 'SEWING', labelIt: 'x', labelEn: 'y' }, 409)).message).toBe('Cause code SEW-ERROR is taken.')
    expect(paths(await refused('keeper', 'POST', '/quality/causes', { code: 'BAD CODE', process: 'SEWING', labelIt: ' ', labelEn: 'y' }, 400))).toEqual(['body/code', 'body/labelIt'])
    expect((await refused('keeper', 'POST', '/quality/causes', { code: 'KNIT', process: 'KNITTING', labelIt: 'x', labelEn: 'y' }, 400)).code).toBe('validation_failed')
    expect((await refused('companyKeeper', 'POST', '/quality/causes', { code: 'MINE', process: 'DESIGN', labelIt: 'x', labelEn: 'y' }, 403)).message).toMatch(/whole group/)
    expect(await vocabularyEvents('CAUSES')).toEqual(['CREATED STITCH-TENSION'])
  })

  it('changes words at the version read; never the code or the process; retires a used code and makes it active again', async () => {
    const view = await ok('keeper', 'GET', '/quality/causes')
    const tension = view.causes.find((row: Json) => row.code === 'STITCH-TENSION')
    const { cause } = await ok('keeper', 'PATCH', `/quality/causes/${tension.id}`, { version: tension.version, labelI18n: { ro: 'Tensiunea firului' }, sortOrder: 85 })
    expect(cause).toMatchObject({ labelI18n: { ro: 'Tensiunea firului' }, sortOrder: 85, version: 2 })
    expect((await refused('keeper', 'PATCH', `/quality/causes/${tension.id}`, { version: 1, labelEn: 'Tension' }, 409)).code).toBe('conflict')
    expect((await refused('keeper', 'PATCH', `/quality/causes/${tension.id}`, { version: 2, process: 'CUTTING' }, 400)).code).toBe('validation_failed')
    const mat = view.causes.find((row: Json) => row.code === 'MAT-FAULT')
    const retired = await ok('keeper', 'PATCH', `/quality/causes/${mat.id}`, { version: mat.version, active: false })
    expect(retired.cause.active).toBe(false)
    expect(retired.retireWords).toBe(`Cause code MAT-FAULT is used on ${mat.usedCount} ${mat.usedCount === 1 ? 'record' : 'records'}; it stays on them and leaves the pickers.`)
    expect(((await ok('floor', 'GET', '/quality/vocabulary')).causes as Json[]).map((row) => row.code)).not.toContain('MAT-FAULT')
    expect((await ok('keeper', 'GET', '/quality/causes?active=false')).causes.map((row: Json) => row.code)).toEqual(['MAT-FAULT'])
    await ok('keeper', 'PATCH', `/quality/causes/${mat.id}`, { version: retired.cause.version, active: true })
    expect(await vocabularyEvents('CAUSES')).toEqual(['CREATED STITCH-TENSION', 'EDITED STITCH-TENSION', 'RETIRED MAT-FAULT', 'REACTIVATED MAT-FAULT'])
  })

  it('deletes only a code nothing names', async () => {
    const view = await ok('keeper', 'GET', '/quality/causes')
    const sew = view.causes.find((row: Json) => row.code === 'SEW-ERROR')
    expect((await refused('keeper', 'DELETE', `/quality/causes/${sew.id}?version=${sew.version}`, undefined, 409)).message).toMatch(/^Cause code SEW-ERROR is used on \d+ records?: retire it instead/)
    const { cause } = await ok('keeper', 'POST', '/quality/causes', { code: 'TYPO', process: 'DESIGN', labelIt: 'Refuso', labelEn: 'Typo' }, 201)
    expect((await refused('keeper', 'DELETE', `/quality/causes/${cause.id}?version=9`, undefined, 409)).code).toBe('conflict')
    expect(await ok('keeper', 'DELETE', `/quality/causes/${cause.id}?version=1`)).toEqual({ deleted: cause.id, code: 'TYPO' })
    expect((await ok('keeper', 'GET', '/quality/causes')).causes.map((row: Json) => row.code)).not.toContain('TYPO')
    expect((await vocabularyEvents('CAUSES')).slice(-1)).toEqual(['DELETED TYPO'])
  })

  it('gives a bare tenant the starter set, once', async () => {
    expect((await ok('keeperB', 'GET', '/quality/causes')).starterMissing).toEqual(STARTER_CAUSES.map((cause) => cause.code))
    expect((await ok('keeperB', 'POST', '/quality/causes/starter', {})).added).toEqual(STARTER_CAUSES.map((cause) => cause.code))
    const view = await ok('keeperB', 'GET', '/quality/causes')
    expect(view.causes.map((row: Json) => `${row.code} ${row.process} ${row.sortOrder}`).slice(0, 2)).toEqual(['MAT-FAULT MATERIAL 10', 'SUP-SPEC SUPPLIER 20'])
    expect(view.starterMissing).toEqual([])
    expect((await ok('keeperB', 'POST', '/quality/causes/starter', {})).added).toEqual([])
    expect(await vocabularyEvents('CAUSES', tenantB)).toEqual([`STARTER_ADDED ${STARTER_CAUSES.map((cause) => cause.code).join(',')}`])
  })
})

describe('the leather grades and hide defects (QHS-006)', () => {
  it('reads grades A-D with their usable share and use, and the hide defects of the library\'s hide category', async () => {
    const view = await ok('viewer', 'GET', '/quality/grades')
    expect(view.grades.map((row: Json) => `${row.code} ${row.usableShare}`)).toEqual(['A 85.00', 'B 72.00', 'C 60.00', 'D 45.00'])
    const usedB = await one(
      `SELECT ((SELECT count(*) FROM "Hide" WHERE "gradeId" = g.id) + (SELECT count(*) FROM "ItemGradeRule" WHERE "gradeId" = g.id) + (SELECT count(*) FROM "HideMark" WHERE "zoneGradeId" = g.id)
              + (SELECT count(*) FROM "Remnant" WHERE "gradeId" = g.id) + (SELECT count(*) FROM "IncomingHideResult" WHERE "gradeRecordType" = 'LeatherGrade' AND "gradeRecordId" = g.id))::text AS n
         FROM "LeatherGrade" g WHERE g."tenantId" = $1 AND g.code = 'B'`,
      [A.tenant],
    )
    expect(usedB).toBeGreaterThan(0)
    expect(view.grades[1]).toMatchObject({ code: 'B', usedCount: usedB, active: true })
    const [leather] = await admin<{ icon: string; colour: string }>(`SELECT icon, colour FROM "DefectCode" WHERE "tenantId" = $1 AND code = 'LEATHER'`, [A.tenant])
    expect(leather?.icon).toBeTruthy()
    expect(view.hideCategory).toMatchObject({ code: 'LEATHER', icon: leather!.icon, colour: leather!.colour })
    expect(view.hideDefects.map((row: Json) => row.code)).toEqual(['SHADE-DIFF', 'HIDE-SCAR', 'GRAIN-CRACK', 'LOOSE-GRAIN'])
    // A hide defect without an icon of its own shows its category's.
    expect(view.hideDefects[1]).toMatchObject({ code: 'HIDE-SCAR', icon: leather!.icon, colour: leather!.colour, severity: 'MAJOR', stages: ['INCOMING', 'CUTTING'] })
    expect(view).toMatchObject({ hideStages: ['INCOMING', 'CUTTING'], starterMissing: [], canManage: false })
  })

  it('adds a grade; a free short code and a share from 0 to 100; changes it; retires it (never deleted)', async () => {
    const { grade } = await ok('keeper', 'POST', '/quality/grades', { code: 'e', labelIt: 'Scarto', labelEn: 'Reject', usableShare: '20' }, 201)
    expect(grade).toMatchObject({ code: 'E', usableShare: '20.00', sortOrder: 5, usedCount: 0 })
    expect((await refused('keeper', 'POST', '/quality/grades', { code: 'A', labelIt: 'x', labelEn: 'y', usableShare: '1' }, 409)).message).toBe('Grade A is taken.')
    expect(paths(await refused('keeper', 'POST', '/quality/grades', { code: 'F F', labelIt: 'x', labelEn: 'y', usableShare: '120' }, 400))).toEqual(['body/code', 'body/usableShare'])
    const { grade: changed } = await ok('keeper', 'PATCH', `/quality/grades/${grade.id}`, { version: grade.version, usableShare: '30.5', labelI18n: { ro: 'Rebut' } })
    expect(changed).toMatchObject({ usableShare: '30.50', labelI18n: { ro: 'Rebut' }, version: 2 })
    expect((await refused('keeper', 'PATCH', `/quality/grades/${grade.id}`, { version: 2, code: 'F' }, 400)).code).toBe('validation_failed')
    const retired = await ok('keeper', 'PATCH', `/quality/grades/${grade.id}`, { version: 2, active: false })
    expect(retired).toMatchObject({ grade: { active: false }, retireWords: 'Grade E is not used yet: retiring it takes it out of the pickers.' })
    expect(((await ok('floor', 'GET', '/quality/vocabulary')).grades as Json[]).map((row) => row.code)).toEqual(['A', 'B', 'C', 'D'])
    expect((await refused('companyKeeper', 'PATCH', `/quality/grades/${grade.id}`, { version: 3, active: true }, 403)).code).toBe('forbidden')
    // A grade is never deleted, for every login.
    await expect(admin(`DELETE FROM "LeatherGrade" WHERE id = $1`, [grade.id])).rejects.toThrow(/retired, never deleted/)
    expect(await vocabularyEvents('GRADES')).toEqual(['CREATED E', 'EDITED E', 'RETIRED E'])
  })

  it('gives a bare tenant grades A-D, once; its hide defects come with the defects\' starter set', async () => {
    expect((await ok('keeperB', 'POST', '/quality/grades/starter', {})).added).toEqual(STARTER_GRADES.map((grade) => grade.code))
    const view = await ok('keeperB', 'GET', '/quality/grades')
    expect(view.grades.map((row: Json) => `${row.code} ${row.usableShare} ${row.sortOrder}`)).toEqual(['A 85.00 1', 'B 72.00 2', 'C 60.00 3', 'D 45.00 4'])
    // Tenant B took the defects' starter set above: its LEATHER category is the hide category.
    expect(view.hideDefects.map((row: Json) => row.code)).toEqual(['SHADE-DIFF', 'HIDE-SCAR', 'GRAIN-CRACK', 'LOOSE-GRAIN'])
    expect((await ok('keeperB', 'POST', '/quality/grades/starter', {})).added).toEqual([])
  })
})

describe('the vocabulary in the person\'s language (QHS-007)', () => {
  beforeAll(async () => {
    // Site A1's tablets read Romanian too, and its operator reads Romanian (made up for the test).
    await admin(`UPDATE "Site" SET "floorLocales" = ARRAY['it', 'en', 'ro'] WHERE id = $1`, [A.siteA1])
    await admin(`UPDATE "Worker" SET locale = 'ro' WHERE id = $1`, [id('worker:A1:operator')])
  })

  it('answers the floor in the worker\'s language, English standing in where a code has none', async () => {
    const view = await ok('floor', 'GET', '/quality/vocabulary?stage=FINAL')
    expect(view.language).toBe('ro')
    expect(view.languages).toEqual(['it', 'en', 'ro'])
    expect(view.classes[0]).toMatchObject({ class: 'CRITICAL', label: 'Critical', locked: true, missing: true })
    const label = view.defects.find((row: Json) => row.code === 'LABEL-WRONG')
    const [labels] = await admin<{ icon: string }>(`SELECT icon FROM "DefectCode" WHERE "tenantId" = $1 AND code = 'LABEL'`, [A.tenant])
    expect(label).toMatchObject({ label: 'Wrong or missing label', missing: true, severity: 'CRITICAL', classLocked: true, classes: ['CRITICAL'], category: { code: 'LABEL' }, icon: labels!.icon })
    expect(view.defects.find((row: Json) => row.code === 'STAIN')).toMatchObject({ classLocked: false, classes: ['CRITICAL', 'MAJOR', 'MINOR'] })
    expect(view.defects.map((row: Json) => row.code)).not.toContain('HIDE-SCAR')
    expect(view.hideDefects.map((row: Json) => row.code)).toEqual(['SHADE-DIFF', 'HIDE-SCAR', 'GRAIN-CRACK', 'LOOSE-GRAIN'])
    const mat = view.causes.find((row: Json) => row.code === 'MAT-FAULT')
    expect(mat).toMatchObject({ missing: false, process: 'MATERIAL', processLabel: 'Material' })
    expect(mat.label).not.toBe('Material fault')
    expect(view.causes.find((row: Json) => row.code === 'STITCH-TENSION')).toMatchObject({ label: 'Tensiunea firului', missing: false })
    expect(view.grades.find((row: Json) => row.code === 'B')).toMatchObject({ label: 'Second choice', missing: true, usableShare: '72.00' })
    expect(view.grades.find((row: Json) => row.code === 'A').missing).toBe(false)
  })

  it('answers the office in the language asked, else Italian; any office session reads it', async () => {
    const it = await ok('nobody', 'GET', '/quality/vocabulary?stage=INCOMING')
    expect(it.language).toBe('it')
    expect(it.defects.every((row: Json) => row.stages.length === 0 || row.stages.includes('INCOMING'))).toBe(true)
    expect(it.defects.find((row: Json) => row.code === 'HIDE-SCAR')).toMatchObject({ label: 'Cicatrice o marchio', missing: false })
    expect(it.grades.find((row: Json) => row.code === 'A')).toMatchObject({ label: 'Prima scelta', missing: false })
    expect(it.classes[0]).toMatchObject({ label: 'Critico', missing: false })
    const en = await ok('viewer', 'GET', '/quality/vocabulary?language=en')
    expect(en.causes.find((row: Json) => row.code === 'MAT-FAULT')).toMatchObject({ label: 'Material fault', processLabel: 'Material', missing: false })
    expect((await ok('keeperB', 'GET', '/quality/vocabulary?language=ro')).grades.every((row: Json) => row.missing)).toBe(true)
  })

  it('lists per floor language the active codes with no words in it', async () => {
    const { languages } = await ok('viewer', 'GET', '/quality/vocabulary/coverage')
    expect(languages).toHaveLength(1)
    expect(languages[0]).toMatchObject({ language: 'ro', sites: 1, complete: false })
    expect(languages[0].missing.GRADES).toEqual(['B', 'C', 'D'])
    expect(languages[0].missing.CAUSES).toEqual([])
    expect(languages[0].missing.DEFECTS).toEqual(expect.arrayContaining(['SEAM', 'THREAD-END', 'LABEL-WRONG']))
    expect((await call('floor', 'GET', '/quality/vocabulary/coverage')).statusCode).toBe(403)
    expect((await refused('nobody', 'GET', '/quality/vocabulary/coverage', undefined, 403)).code).toBe('forbidden')
  })
})
