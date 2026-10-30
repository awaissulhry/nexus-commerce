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
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
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
