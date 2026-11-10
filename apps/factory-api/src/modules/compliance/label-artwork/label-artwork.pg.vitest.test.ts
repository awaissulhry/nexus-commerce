import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryClient, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seed as seedTechfiles } from '../../../../../../packages/factory-db/seed/techfiles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { workOrderGate, type GatedWorkOrder } from '../gates/at-steps'

/**
 * Label artwork, label lines in the BOM and the label reconciliation (B-W2b-259; PRD-347, PRD-088, MES-140) on the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level
 * security and B-W2b-218's artwork and spoiled-label guards are real), seeded with the core, compliance-rules, techfiles
 * (SEED-LBL-JKT-02's artwork v1 retired, v2 approved, v3 a draft; WO-0003's print of three serial labels with one spoiled and
 * one returned), styles-depth (the brand P1's 2027 set: a polybag per garment and a hang tag in words) and options seeds
 * (SEED-JKT-05, a tenant-wide category II jacket of brand P1, draft revision 1 with the brand's woven label line
 * "branding:brand-label"). Made up beside them: a leaflet and a ribbon material, two requirement rows naming this step's
 * checks. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/label-artwork`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'DELETE'

const NS = 'label-artwork-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA = seedId('site:A1')
const author = newId()
// Plant A1 names workers: its seeded operator acknowledged the worker notice (the privacy seed; the floor is ready).
const operatorA1 = seedId('worker:A1:operator')
const second = newId()
const otherTenant = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const KEEPER = ['compliance.certificates.view', 'compliance.labels.manage', 'compliance.artwork.approve', 'product.bom.view', 'product.bom.manage', 'product.styles.view', 'workorders.view', 'production.serials', 'files.read'] as const
const SESSIONS: Record<string, SessionContext> = {
  author: office(tenant, author, [grant([...KEEPER])]),
  second: office(tenant, second, [grant(['compliance.certificates.view', 'compliance.artwork.approve', 'workorders.view'])]),
  viewer: office(tenant, newId(), [grant(['compliance.certificates.view', 'product.bom.view'])]),
  otherTenant: office(otherTenant, newId(), [grant([...KEEPER])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: operatorA1, siteId: siteA, deviceId: newId(), grants: [grant(['floor.work', 'production.serials'], [companyA])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}

let label02: string
let jacket05: { id: string; revisionId: string }
let wo3: GatedWorkOrder & { cellId: string }
let wo1: GatedWorkOrder
let leaflet: string
let ribbon: string

const requirement = (code: string, checkKey: string, gate: string) =>
  admin(`INSERT INTO "ComplianceRequirement" (id, "tenantId", code, name, kind, "checkKey", blocks, "legalReference", seq) VALUES ($1, $2, $3, $4, 'LABEL', $5, ARRAY[$6]::"ComplianceGate"[], 'Test reference', 500)`, [newId(), tenant, code, `Test ${checkKey}`, checkKey, gate])
const asOffice = <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> => database.withScope({ audience: 'office', tenantId: tenant, actorId: author }, work)

beforeAll(async () => {
  db = await migratedDatabase('label_artwork')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  await seedTechfiles({ db: database, namespace: NS })
  await seedStylesDepth({ db: database, namespace: NS })
  await seedOptions({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'label-artwork-other'])

  label02 = (await admin<{ id: string }>(`SELECT id FROM "LabelTemplate" WHERE "tenantId" = $1 AND code = 'SEED-LBL-JKT-02' AND revision = 1`, [tenant]))[0]!.id
  const style = (await admin<{ id: string; rev: string }>(`SELECT s.id, r.id AS rev FROM "Style" s JOIN "StyleRevision" r ON r."styleId" = s.id WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-05' AND r.revision = 1`, [tenant]))[0]!
  jacket05 = { id: style.id, revisionId: style.rev }
  const order = async (number: string) =>
    (await admin<Json>(`SELECT id, number, "companyId", "siteId", "styleId", "labelTemplateId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2`, [tenant, number]))[0]! as GatedWorkOrder
  wo1 = await order('SEED-WO-0001')
  const three = await order('SEED-WO-0003')
  wo3 = { ...three, cellId: (await admin<{ id: string }>(`SELECT "workOrderSizeId" AS id FROM "GarmentLabelPrint" WHERE "workOrderId" = $1`, [three.id]))[0]!.id }

  const item = `INSERT INTO "Item" (id, "tenantId", code, name, kind, "baseUom", "purchaseUom", "consumptionUom") VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`
  leaflet = newId()
  ribbon = newId()
  await admin(item, [leaflet, tenant, 'TEST-LEAF-01', 'Test user information leaflet', 'PACKAGING', 'PCS'])
  await admin(item, [ribbon, tenant, 'TEST-RIB-01', 'Test label ribbon', 'LABEL', 'M'])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const artwork = (session = 'author') => ok(session, 'GET', `/compliance/label-artwork/templates/${label02}`).then((body) => body.artwork as Json)
const versionOf = (view: Json, versionNo: number): Json => view.versions.find((entry: Json) => entry.versionNo === versionNo)

describe('label artwork versions (PRD-347)', () => {
  it('adds a draft proof, refuses its author as approver, and a second person approves it: the one approved before retires', async () => {
    const before = await artwork()
    expect(before.versions.map((entry: Json) => [entry.versionNo, entry.status])).toEqual([
      [3, 'DRAFT'],
      [2, 'APPROVED'],
      [1, 'RETIRED'],
    ])
    expect(before.approvedId).toBe(versionOf(before, 2).id)
    // WO-0001 was released with this label; it has printed nothing, so no version is pinned to it yet.
    expect(before.workOrders).toEqual([expect.objectContaining({ number: 'SEED-WO-0001', firstPrintAt: null, artwork: null })])
    const proof = versionOf(before, 3).file.id

    const added = (await ok('author', 'POST', `/compliance/label-artwork/templates/${label02}/versions`, { fileId: proof, note: 'New address on the label (made up).' }, 201)).artwork
    const v4 = versionOf(added, 4)
    expect(v4).toMatchObject({ status: 'DRAFT', byYou: true, approveHeld: expect.stringContaining('second person'), note: 'New address on the label (made up).' })

    const mine = await refused('author', 'POST', `/compliance/label-artwork/versions/${v4.id}/approve`, { version: v4.version }, 409)
    expect(mine.message).toContain('second person')

    const approved = (await ok('second', 'POST', `/compliance/label-artwork/versions/${v4.id}/approve`, { version: v4.version })).artwork
    expect(approved.approvedId).toBe(v4.id)
    expect(versionOf(approved, 4)).toMatchObject({ status: 'APPROVED', approvedBy: { id: second } })
    expect(versionOf(approved, 2)).toMatchObject({ status: 'RETIRED' })
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'label_artwork.changed' ORDER BY "occurredAt"`, [tenant])
    expect(events.map((event) => event.payload.change)).toEqual(['ADDED', 'APPROVED'])
    expect(events[1]!.payload.replacedId).toBe(versionOf(before, 2).id)
  })

  it('retires a version and removes only a draft; a stale version, a proof of another record and a person without the right are refused', async () => {
    const view = await artwork()
    const proof = versionOf(view, 3).file.id
    const v5 = versionOf((await ok('author', 'POST', `/compliance/label-artwork/templates/${label02}/versions`, { fileId: proof }, 201)).artwork, 5)
    const gone = (await ok('author', 'DELETE', `/compliance/label-artwork/versions/${v5.id}?version=${v5.version}`)).artwork
    expect(versionOf(gone, 5)).toBeUndefined()

    const v4 = versionOf(gone, 4)
    expect((await refused('author', 'DELETE', `/compliance/label-artwork/versions/${v4.id}?version=${v4.version}`, undefined, 409)).message).toContain('never removed')
    expect(await refused('author', 'POST', `/compliance/label-artwork/versions/${versionOf(gone, 3).id}/retire`, { version: 99 }, 409)).toBeTruthy()
    const retired = (await ok('author', 'POST', `/compliance/label-artwork/versions/${versionOf(gone, 3).id}/retire`, { version: versionOf(gone, 3).version, reason: 'Superseded by v4.' })).artwork
    expect(versionOf(retired, 3).status).toBe('RETIRED')

    // A file of another record is no proof of this label.
    const other = (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" <> 'LabelTemplate' AND status = 'AVAILABLE' LIMIT 1`, [tenant]))[0]!.id
    expect((await refused('author', 'POST', `/compliance/label-artwork/templates/${label02}/versions`, { fileId: other }, 400)).message).toContain('not a file of this label')
    await refused('viewer', 'POST', `/compliance/label-artwork/templates/${label02}/versions`, { fileId: proof }, 403)
    await refused('viewer', 'POST', `/compliance/label-artwork/versions/${v4.id}/approve`, { version: v4.version }, 403)
    await refused('otherTenant', 'GET', `/compliance/label-artwork/templates/${label02}`, undefined, 404)
    // The floor reads approved artwork only (row-level security) and has no route here.
    await refused('floor', 'GET', `/compliance/label-artwork/templates/${label02}`, undefined, 403)
  })

  it("plugs `label.artwork` into the one gate: WO-0001's labels print only with approved artwork, where a requirement asks", async () => {
    // No requirement names the check: the gate asks nothing of the artwork.
    const free = await asOffice((client) => workOrderGate(client, 'LABEL_PRINT', wo1, new Date()))
    expect(free.decision.lines.some((line) => line.check === 'label.artwork')).toBe(false)
    await requirement('TEST-LABEL-ARTWORK', 'label.artwork', 'LABEL_PRINT')
    const asked = await asOffice((client) => workOrderGate(client, 'LABEL_PRINT', wo1, new Date()))
    const line = asked.decision.lines.find((entry) => entry.check === 'label.artwork')!
    expect(line).toMatchObject({ state: 'OK', facts: { code: 'artwork.approved', versionNo: 4, pinned: false } })
    // Retire the approved version: nothing is approved, the label print is refused per size in words.
    const v4 = versionOf(await artwork(), 4)
    await ok('author', 'POST', `/compliance/label-artwork/versions/${v4.id}/retire`, { version: v4.version })
    const held = await asOffice((client) => workOrderGate(client, 'LABEL_PRINT', wo1, new Date()))
    expect(held.decision.allowed).toBe(false)
    expect(held.decision.refusal!.words).toContain('no approved artwork')
    await admin(`UPDATE "ComplianceRequirement" SET "switchedOn" = false, "offReason" = 'Test: off again.', "switchedAt" = now() WHERE "tenantId" = $1 AND code = 'TEST-LABEL-ARTWORK'`, [tenant])
  })
})

const lines = () => ok('author', 'GET', `/product/styles/${jacket05.id}/revisions/${jacket05.revisionId}/bom/label-lines`).then((body) => body.lines as Json)
const entry = (view: Json, sourceKey: string): Json => view.plan.find((row: Json) => row.sourceKey === sourceKey)

describe('label and packaging lines from the rules (PRD-088)', () => {
  it("plans SEED-JKT-05's lines: the brand's polybag to add, its old woven label line to remove, the leaflet's material to pick", async () => {
    const view = await lines()
    expect(view.style).toMatchObject({ code: 'SEED-JKT-05', ppe: true, brand: expect.objectContaining({ id: expect.any(String) }) })
    expect(view.brandingSet).toMatchObject({ code: 'SEED-BS-P1-2027' })
    expect(entry(view, 'branding:polybag')).toMatchObject({ action: 'ADD', source: 'BRANDING', section: 'PACKAGING', next: { qty: '1', uom: 'PCS' }, held: null })
    expect(entry(view, 'branding:brand-label')).toMatchObject({ action: 'REMOVE', why: 'RULE_GONE', line: { section: 'LABELS' } })
    expect(entry(view, 'compliance:user-information')).toMatchObject({ action: 'NEEDS_MATERIAL', source: 'COMPLIANCE' })
    expect(view.inWords).toEqual([expect.objectContaining({ sourceKey: 'branding:hang-tag', why: 'NO_MATERIAL' })])
    expect(view.candidates.map((row: Json) => row.code)).toEqual(expect.arrayContaining(['TEST-LEAF-01']))
    expect(view.candidates.map((row: Json) => row.code)).not.toContain('TEST-RIB-01')
    expect(view.changes).toBe(2)
  })

  it('refreshes the draft in one command with the leaflet picked; a second refresh has nothing to do; a changed rule is one refresh away', async () => {
    const view = await lines()
    const answer = await ok('author', 'POST', `/product/styles/${jacket05.id}/revisions/${jacket05.revisionId}/bom/label-lines/refresh`, { version: view.revision.version, materials: { 'compliance:user-information': leaflet } })
    expect(answer.applied.map((row: Json) => [row.action, row.sourceKey]).sort()).toEqual([
      ['ADD', 'branding:polybag'],
      ['ADD', 'compliance:user-information'],
      ['REMOVE', 'branding:brand-label'],
    ])
    expect(answer.lines.changes).toBe(0)
    expect(answer.lines.plan.every((row: Json) => row.action === 'KEEP')).toBe(true)
    const stored = await admin<Json>(`SELECT "sourceKey", section, qty::text AS qty FROM "BomLine" WHERE "revisionId" = $1 AND "sourceKey" IS NOT NULL ORDER BY seq`, [jacket05.revisionId])
    expect(stored).toEqual([
      { sourceKey: 'compliance:user-information', section: 'PACKAGING', qty: '1.0000' },
      { sourceKey: 'branding:polybag', section: 'PACKAGING', qty: '1.0000' },
    ])
    const changed = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'style.bom_changed' ORDER BY "occurredAt" DESC LIMIT 1`, [tenant])
    expect(changed[0]!.payload.lineIds).toHaveLength(3)

    // The brand now packs two garments' worth of bags per garment (a made-up change): the line is out of date.
    await admin(`UPDATE "BrandingSet" SET "packagingRules" = jsonb_set("packagingRules", '{0,quantity}', '"2"') WHERE "tenantId" = $1 AND code = 'SEED-BS-P1-2027'`, [tenant])
    const stale = await lines()
    expect(entry(stale, 'branding:polybag')).toMatchObject({ action: 'UPDATE', changes: ['qty'], next: { qty: '2' } })
    const again = await ok('author', 'POST', `/product/styles/${jacket05.id}/revisions/${jacket05.revisionId}/bom/label-lines/refresh`, { version: stale.revision.version })
    expect(again.applied).toEqual([expect.objectContaining({ action: 'UPDATE', sourceKey: 'branding:polybag' })])
    expect(again.lines.changes).toBe(0)
  })

  it('refuses a material for a brand rule, a ribbon counted in metres, a stale version, a person without bom.manage and a released revision', async () => {
    const view = await lines()
    const base = `/product/styles/${jacket05.id}/revisions/${jacket05.revisionId}/bom/label-lines/refresh`
    expect((await refused('author', 'POST', base, { version: view.revision.version, materials: { 'branding:polybag': leaflet } }, 400)).issues[0].message).toContain('branding set')
    expect((await refused('author', 'POST', base, { version: view.revision.version, materials: { 'compliance:user-information': ribbon } }, 400)).issues[0].message).toContain('counted in M')
    await refused('author', 'POST', base, { version: view.revision.version + 5 }, 409)
    await refused('viewer', 'POST', base, { version: view.revision.version }, 403)
    const released = (await admin<{ s: string; r: string }>(`SELECT s.id AS s, r.id AS r FROM "Style" s JOIN "StyleRevision" r ON r."styleId" = s.id WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-02' AND r.status = 'RELEASED' LIMIT 1`, [tenant]))[0]!
    const frozen = (await ok('author', 'GET', `/product/styles/${released.s}/revisions/${released.r}/bom/label-lines`)).lines
    expect(frozen.revision.editable).toBe(false)
    expect(frozen.changes).toBe(0)
    await refused('author', 'POST', `/product/styles/${released.s}/revisions/${released.r}/bom/label-lines/refresh`, { version: frozen.revision.version }, 409)
    await refused('otherTenant', 'GET', `/product/styles/${jacket05.id}/revisions/${jacket05.revisionId}/bom/label-lines`, undefined, 404)
  })
})

const reconciliation = (session = 'author') => ok(session, 'GET', `/production/serials/work-orders/${wo3.id}/reconciliation`).then((body) => body.reconciliation as Json)

describe('the label reconciliation (MES-140)', () => {
  it("counts WO-0003's size: printed = used + spoiled + returned, with the seed's spoiled and returned label", async () => {
    const view = await reconciliation()
    const cell = view.cells.find((row: Json) => row.workOrderSizeId === wo3.cellId)
    expect(cell).toMatchObject({ printed: 3, spoiled: 1, returned: 1 })
    expect(cell.difference).toBe(cell.printed - cell.used - cell.spoiled - cell.returned)
    expect(cell.balanced).toBe(cell.difference === 0)
    expect(view.entries.map((row: Json) => row.kind).sort()).toEqual(['RETURNED', 'SPOILED'])
    expect(view.holdsRelease).toBe(false)
    // The floor of the work order's site reads it too (no artwork there).
    const floor = await reconciliation('floor')
    expect(floor.cells).toEqual(view.cells)
    expect(floor.artwork).toBeNull()
  })

  it("logs spoiled labels on the floor within what the print gave; more is refused in words; the gate holds the final release on a difference", async () => {
    const before = (await reconciliation()).cells.find((row: Json) => row.workOrderSizeId === wo3.cellId)
    const url = `/production/serials/work-orders/${wo3.id}/spoiled`
    // The print gave 3 and 2 are logged: 2 more cannot be.
    expect((await refused('floor', 'POST', url, { workOrderSizeId: wo3.cellId, kind: 'SPOILED', quantity: 2, reason: 'Printer jammed' }, 409)).message).toContain('only 1 are not logged')
    expect((await refused('floor', 'POST', url, { workOrderSizeId: wo3.cellId, kind: 'SPOILED', quantity: 1 }, 400)).issues[0].path).toBe('body/reason')
    const logged = await ok('floor', 'POST', url, { workOrderSizeId: wo3.cellId, kind: 'SPOILED', quantity: 1, reason: 'Printer jammed' }, 201)
    const after = logged.reconciliation.cells.find((row: Json) => row.workOrderSizeId === wo3.cellId)
    expect(after).toMatchObject({ spoiled: before.spoiled + 1, difference: before.difference - 1 })
    const event = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'label_reconciliation.logged'`, [tenant])
    expect(event[0]!.payload).toMatchObject({ kind: 'SPOILED', quantity: 1, postedBy: 'FLOOR', difference: after.difference })

    // A requirement holds the final release on a difference (the Owner's row, B-W2b-265).
    await requirement('TEST-LABEL-RECON', 'label.reconciliation', 'FINAL_RELEASE')
    expect((await reconciliation()).holdsRelease).toBe(true)
    const gate = await asOffice((client) => workOrderGate(client, 'FINAL_RELEASE', wo3, new Date(), [wo3.cellId]))
    const line = gate.decision.lines.find((row) => row.check === 'label.reconciliation')!
    expect(line).toMatchObject({ state: after.difference === 0 ? 'OK' : 'MISSING', facts: { printed: after.printed, used: after.used, spoiled: after.spoiled, returned: after.returned, difference: after.difference } })
    if (after.difference !== 0) {
      expect(gate.decision.allowed).toBe(false)
      expect(gate.decision.refusedTargets.map((row) => row.line.requirement.code)).toContain('TEST-LABEL-RECON')
    }
    await refused('viewer', 'POST', url, { workOrderSizeId: wo3.cellId, kind: 'RETURNED', quantity: 1 }, 403)
    await refused('otherTenant', 'GET', `/production/serials/work-orders/${wo3.id}/reconciliation`, undefined, 404)
  })

  it("keeps a print's spoiled and returned labels at most its quantity in the database too (a racing second request)", async () => {
    const print = (await admin<{ id: string }>(`SELECT id FROM "GarmentLabelPrint" WHERE "workOrderId" = $1`, [wo3.id]))[0]!.id
    // The database's own rule, through the runtime login (as a racing second request would meet it).
    const error = await database
      .withScope({ audience: 'office', tenantId: tenant, actorId: author }, (client) =>
        client.garmentLabelSpoil.create({ data: { id: newId(), companyId: wo3.companyId, siteId: wo3.siteId, workOrderId: wo3.id, printId: print, kind: 'RETURNED', quantity: 5, createdAt: new Date() }, select: { id: true } }),
      )
      .catch((caught: unknown) => caught)
    expect(String((error as Error).message)).toContain('at most that')
  })
})
