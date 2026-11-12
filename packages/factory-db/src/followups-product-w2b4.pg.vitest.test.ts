import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedInspectionPlans, type InspectionPlansSeed } from '../seed/inspection-plans'
import { seed as seedPpeTexts, type PpeTextsSeed } from '../seed/ppe-texts'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedQualityLab } from '../seed/quality-lab'
import { seed as seedSamples, type SamplesSeed } from '../seed/samples'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../seed/sizes-depth'
import { seed as seedStylesDepth } from '../seed/styles-depth'
import { seed as seedTechfiles, type TechfilesSeed } from '../seed/techfiles'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The W2b-4 follow-ups for product, samples and compliance (W2b-5 schema wave 34/44, B-W2b-275,
 * …_followups_product_w2b4_guards) on a database built from the migrations and seeded, through the real login and the scoped
 * client:
 *   - point of measure codes unique whatever the letter case; sample measures and comments name a real point;
 *   - a style's markets by their codes, each once, of the tenant;
 *   - a SAMPLE work order's cell may name no order line (with its party: both or neither), no other kind's;
 *   - an asymmetric band on a measurement: both sides, the tolerance the larger, `pass` from the band;
 *   - the lab's cost of a lab result with its currency, hidden from the floor;
 *   - who changed product settings and a product type;
 *   - PPE text approvals: recorded in force, then only withdrawn, once; never deleted; a generated document leaves DRAFT only
 *     while a live approval of its template covers its language and company;
 *   - a SUPERSEDED document for a batch made while it was in force.
 * The refusals are check_violation (23514), restrict_violation (23001) or a key's violation; their messages are read through
 * raw SQL.
 */

const NS = 'w2b-275-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let p: ProductionSeed
let s: SamplesSeed
let z: SizesDepthSeed
let q: InspectionPlansSeed
let t: TechfilesSeed
let x: PpeTextsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1'), P1: key('party:P1'), store: key('files:account:r2') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const now = () => new Date().toISOString()

beforeAll(async () => {
  db = await migratedDatabase('followupsproductw2b4')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  p = await seedProduction({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedStylesDepth({ db: factory, namespace: NS })
  z = await seedSizesDepth({ db: factory, namespace: NS })
  s = await seedSamples({ db: factory, namespace: NS })
  q = await seedInspectionPlans({ db: factory, namespace: NS })
  await seedQualityLab({ db: factory, namespace: NS })
  t = await seedTechfiles({ db: factory, namespace: NS })
  x = await seedPpeTexts({ db: factory, namespace: NS })
  // Run twice: the new seed is idempotent.
  await seedPpeTexts({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('points of measure and the sample fit', () => {
  it('keeps a point code unique whatever the letter case', async () => {
    const copy = (code: string) => copyRow(office(), 'PointOfMeasure', z.pointIds.chestW, { id: randomUUID(), code, pictureFileId: null })
    await expect(copy('chest_w')).rejects.toThrow(/PointOfMeasure_tenantId_lower_code_key|unique/i)
    await expect(copy('Chest_W')).rejects.toThrow(/PointOfMeasure_tenantId_lower_code_key|unique/i)
    expect(await copy(tag('CHEST_W'))).toBe(1)
  })

  it('names a real point of measure on a fit measurement and a comment (Restrict)', async () => {
    const measure = (await one(`SELECT id::text AS id FROM "SampleMeasurement" WHERE "roundId" = $1 ORDER BY seq LIMIT 1`, [s.roundIds.fit])).id as string
    const comment = (await one(`SELECT id::text AS id FROM "SampleComment" WHERE "roundId" = $1 LIMIT 1`, [s.roundIds.fit])).id as string
    await expect(copyRow(office(), 'SampleMeasurement', measure, { id: randomUUID(), pomCode: tag('P'), pointOfMeasureId: randomUUID() })).rejects.toThrow(/foreign key/)
    await expect(copyRow(office(), 'SampleComment', comment, { id: randomUUID(), pomCode: 'CHEST_W', pointOfMeasureId: randomUUID() })).rejects.toThrow(/foreign key/)
    expect(await copyRow(office(), 'SampleMeasurement', measure, { id: randomUUID(), pomCode: tag('P'), pointOfMeasureId: z.pointIds.chestW })).toBe(1)
    expect(await copyRow(office(), 'SampleComment', comment, { id: randomUUID(), pomCode: 'CHEST_W', pointOfMeasureId: z.pointIds.chestW })).toBe(1)
    // Restrict: a named point is never deleted under them.
    const actions = await admin(`SELECT conname, confdeltype FROM pg_constraint WHERE conname IN ('SampleMeasurement_tenantId_pointOfMeasureId_fkey', 'SampleComment_tenantId_pointOfMeasureId_fkey') ORDER BY conname`)
    expect(actions).toEqual([
      { conname: 'SampleComment_tenantId_pointOfMeasureId_fkey', confdeltype: 'r' },
      { conname: 'SampleMeasurement_tenantId_pointOfMeasureId_fkey', confdeltype: 'r' },
    ])
  })
})

describe('the markets a style is sold in', () => {
  it('names markets of the tenant by their codes, each once; empty is every market', async () => {
    const markets = (list: string) => update(office(), 'Style', p.styleId, `"marketCodes" = ${list}`)
    expect((await one(`SELECT "marketCodes" FROM "Style" WHERE id = $1`, [p.styleId])).marketCodes).toEqual([])
    expect(await markets(`ARRAY['IT', 'DE']`)).toBe(1)
    await expect(markets(`ARRAY['IT', 'IT']`)).rejects.toThrow(/each once, at most 60/)
    await expect(markets(`ARRAY['it']`)).rejects.toThrow(/by its code \("DE", "US-CA"\); "it" is not one/)
    await expect(markets(`ARRAY['IT', 'XX']`)).rejects.toThrow(/names market XX, which is not a market of the tenant/)
    await expect(markets(`NULL`)).rejects.toThrow(/each once, at most 60 \(none: every market\)/)
    // A switched-off market (UK, Owner question Q23) may still be named; empty again is every market.
    expect(await markets(`ARRAY['IT', 'UK']`)).toBe(1)
    expect(await markets(`ARRAY[]::text[]`)).toBe(1)
    await expect(copyRow(office(), 'Style', p.styleId, { id: randomUUID(), code: tag('T-STY'), marketCodes: ['XX'] })).rejects.toThrow(/names market XX/)
  })
})

describe('a sample work order\'s cells without an order line', () => {
  it('lets only a SAMPLE work order\'s cell name no order line, and then no party either', async () => {
    const make = (changes: Record<string, unknown>) => copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id: randomUUID(), number: tag('T-WO'), ...changes })
    const sample = randomUUID()
    expect(await make({ id: sample, kind: 'SAMPLE', sampleRoundId: s.roundIds.pp })).toBe(1)
    const cell = (await one(`SELECT id::text AS id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1`, [p.draftWorkOrderId])).id as string
    const own = randomUUID()
    expect(await copyRow(office(), 'WorkOrderSize', cell, { id: own, workOrderId: sample, salesOrderLineId: null, partyId: null })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', cell, { id: randomUUID(), workOrderId: sample, size: '54', salesOrderLineId: null })).rejects.toThrow(/with that line's party, or neither/)
    await expect(update(office(), 'WorkOrderSize', own, `"partyId" = $2::uuid`, A.P1)).rejects.toThrow(/with that line's party, or neither/)
    // A size grid work order's cell makes its line.
    await expect(copyRow(office(), 'WorkOrderSize', cell, { id: randomUUID(), salesOrderLineId: null, partyId: null, size: '54' })).rejects.toThrow(/only a SAMPLE work order's cell may name none/)
    await expect(update(office(), 'WorkOrderSize', cell, `"salesOrderLineId" = NULL, "partyId" = NULL`)).rejects.toThrow(/only a SAMPLE work order's cell may name none/)
    // A shipment line never ships it: the shipping guard asks the cell's line (B-W2b-284 refuses it in words first).
    const shipmentLine = await admin(`SELECT l.id::text AS id FROM "ShipmentLine" l JOIN "Shipment" h ON h.id = l."shipmentId" WHERE h.status = 'DRAFT' AND l."siteId" = $1 ORDER BY l.id LIMIT 1`, [A.site])
    if (shipmentLine.length > 0) {
      await expect(copyRow(office(), 'ShipmentLine', shipmentLine[0]!.id as string, { id: randomUUID(), workOrderId: sample, workOrderSizeId: own })).rejects.toThrow(/foreign key|ships its work order cell|that cell's party, sales order line and size/)
    }
  })
})

describe('an asymmetric band on a measurement', () => {
  // The OPEN final inspection's CHEST measurement (its plan check has a nominal).
  const measurement = () => key('inspection-plans:measure:final:CHEST')
  const spec = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionMeasurement', measurement(), { id: randomUUID(), planCheckId: null, pointCode: tag('SPEC'), ...changes })

  it('keeps the band as it is: both sides, each from 0, the tolerance the larger side; pass within the band', async () => {
    const inside = randomUUID()
    expect(await spec({ id: inside, nominal: '61.000', tolerance: '1.500', toleranceMinus: '1.000', tolerancePlus: '1.500', measured: '62.400' })).toBe(1)
    const below = randomUUID()
    // 59.8 is within ± 1.5 of 61 but below 61 − 1: outside the band.
    expect(await spec({ id: below, nominal: '61.000', tolerance: '1.500', toleranceMinus: '1.000', tolerancePlus: '1.500', measured: '59.800' })).toBe(1)
    const rows = await admin(`SELECT id::text AS id, pass FROM "InspectionMeasurement" WHERE id = ANY($1::uuid[])`, [[inside, below]])
    expect(Object.fromEntries(rows.map((row) => [row.id, row.pass]))).toEqual({ [inside]: true, [below]: false })
    // Measured again inside the band: the database writes pass again.
    expect(await update(office(), 'InspectionMeasurement', below, `measured = 60.000`)).toBe(1)
    expect((await one(`SELECT pass FROM "InspectionMeasurement" WHERE id = $1`, [below])).pass).toBe(true)
    await expect(spec({ toleranceMinus: '1.000' })).rejects.toThrow(/both or neither, each from 0/)
    await expect(spec({ tolerance: '1.000', toleranceMinus: '-1.000', tolerancePlus: '1.000' })).rejects.toThrow(/both or neither, each from 0/)
    await expect(spec({ nominal: '61.000', tolerance: '1.000', toleranceMinus: '1.000', tolerancePlus: '1.500' })).rejects.toThrow(/has the larger side \(1.500\) as its tolerance, not 1.000/)
    // Without a band: nominal ± tolerance, as before.
    const plain = randomUUID()
    expect(await spec({ id: plain, nominal: '61.000', tolerance: '1.000', measured: '59.800' })).toBe(1)
    expect((await one(`SELECT pass FROM "InspectionMeasurement" WHERE id = $1`, [plain])).pass).toBe(false)
  })

  it('never puts a band on a check with its own nominal', async () => {
    expect((await one(`SELECT "inspectionId"::text AS id FROM "InspectionMeasurement" WHERE id = $1`, [measurement()])).id).toBe(q.inspectionId)
    await expect(copyRow(office(), 'InspectionMeasurement', measurement(), { id: randomUUID(), size: '54', toleranceMinus: '1.000', tolerancePlus: '1.000' })).rejects.toThrow(/its ± tolerance applies, not a band/)
  })
})

describe('the lab\'s cost of a lab result', () => {
  it('is typed with the result, with its currency, 0 or more, or not at all; the floor never reads it', async () => {
    // The isolation tests' row: the first of the tenant (a copy of it passes every W1 rule).
    const result = (await one(`SELECT id::text AS id FROM "LabResult" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'LabResult', result, { id: randomUUID(), ...changes })
    await expect(copy({ costAmount: 4500 })).rejects.toThrow(/with its currency \(ISO 4217, "EUR"\), or neither/)
    await expect(copy({ costCurrency: 'EUR' })).rejects.toThrow(/with its currency/)
    await expect(copy({ costAmount: -1, costCurrency: 'EUR' })).rejects.toThrow(/0 or more/)
    await expect(copy({ costAmount: 4500, costCurrency: 'eur' })).rejects.toThrow(/ISO 4217/)
    const priced = randomUUID()
    expect(await copy({ id: priced, costAmount: 4500, costCurrency: 'EUR' })).toBe(1)
    // Append-only as before: the cost is never changed.
    await expect(update(office(), 'LabResult', priced, `"costAmount" = 1`)).rejects.toThrow(/permission denied|append-only|never/i)
    await expect(sql(floor(), `SELECT "costAmount" FROM "LabResult" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT "costCurrency" FROM "LabResult" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect(Array.isArray(await sql(floor(), `SELECT id, verdict FROM "LabResult" LIMIT 1`))).toBe(true)
  })
})

describe('who changed the product settings', () => {
  it('keeps the office user who changed a settings row or a product type last', async () => {
    const settings = (await one(`SELECT id::text AS id FROM "ProductSettings" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    const type = (await one(`SELECT id::text AS id FROM "ProductTypeProfile" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    expect(await update(office(), 'ProductSettings', settings, `"updatedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await update(office(), 'ProductTypeProfile', type, `"updatedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect((await one(`SELECT "updatedById"::text AS by FROM "ProductSettings" WHERE id = $1`, [settings])).by).toBe(a.actorId)
  })
})

describe('the PPE text approvals (GATE-PPE-TEXTS)', () => {
  const record = (changes: Record<string, unknown>) =>
    copyRow(office(), 'PpeTextApproval', x.approvalIds.doc, { id: randomUUID(), recordedAt: now(), createdAt: now(), updatedAt: now(), ...changes })
  /** A stored file of the company (rows only), AVAILABLE unless said. */
  const file = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    expect(await copyRow(office(), 'StoredFile', x.fileIds.doc, { id, recordId: id, storageKey: `t/${a.tenantId}/c/${A.company}/2026/${randomUUID()}`, sha256: 'b'.repeat(64), seriesId: null, ...changes })).toBe(1)
    return id
  }

  it('is recorded in force, by a person, for a template, its languages and the consultant\'s file', async () => {
    await expect(record({ withdrawnAt: now(), withdrawnById: a.actorId, withdrawReason: 'Seed (made-up).' })).rejects.toThrow(/recorded in force; it is withdrawn later/)
    await expect(record({ templateKey: 'annex ix' })).rejects.toThrow(/1 to 80 characters without spaces, and its version from 1/)
    await expect(record({ templateVersion: 0 })).rejects.toThrow(/its version from 1/)
    await expect(record({ languages: [] })).rejects.toThrow(/ISO 639 codes \("it"\), each once, 1 to 20/)
    await expect(record({ languages: ['it', 'it'] })).rejects.toThrow(/each once, 1 to 20/)
    await expect(record({ languages: ['IT'] })).rejects.toThrow(/ISO 639 codes/)
    await expect(record({ checkedBy: '  ' })).rejects.toThrow(/names the consultant who checked the texts/)
    await expect(record({ recordedAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/recorded now, not at/)
    await expect(record({ recordedById: null })).rejects.toThrow(/null value|not-null/)
    // The consultant's file: of its company (or tenant-wide), AVAILABLE.
    await expect(record({ evidenceFileId: randomUUID() })).rejects.toThrow(/foreign key/)
    const ofA = await file({ companyId: A.company })
    await expect(record({ evidenceFileId: ofA })).rejects.toThrow(/a stored file of its company \(or a tenant-wide one\), AVAILABLE \(this one is AVAILABLE\)/)
    const pending = await file({ companyId: A.companyB, status: 'PENDING_UPLOAD', availableAt: null })
    await expect(record({ evidenceFileId: pending })).rejects.toThrow(/AVAILABLE \(this one is PENDING_UPLOAD\)/)
    // (Another template than the DoC's: the test of the gate below starts with no approval of company A in force.)
    expect(await record({ companyId: A.company, evidenceFileId: ofA, templateKey: tag('annex-ix-test') })).toBe(1)
    // A label template's warnings: a label template of the company (or tenant-wide) by its code and revision.
    await expect(record({ templateKind: 'LABEL_WARNING', templateKey: 'SEED-LBL-JKT-02', templateVersion: 9 })).rejects.toThrow(/names a label template of its company \(or a tenant-wide one\) by its code and revision/)
    expect(await record({ templateKind: 'LABEL_WARNING', templateKey: 'SEED-LBL-JKT-02', templateVersion: 1 })).toBe(1)
  })

  it('is withdrawn once, with when, by whom and why; nothing else changes; never deleted', async () => {
    const id = randomUUID()
    expect(await record({ id, templateKey: 'annex-ix-test' })).toBe(1)
    await expect(update(office(), 'PpeTextApproval', id, `languages = ARRAY['it']`)).rejects.toThrow(/stays as recorded; only its withdrawal is written/)
    await expect(update(office(), 'PpeTextApproval', id, `"checkedBy" = 'Someone else'`)).rejects.toThrow(/stays as recorded/)
    await expect(update(office(), 'PpeTextApproval', id, `"withdrawnAt" = now()`)).rejects.toThrow(/exactly with when, by whom and why/)
    await expect(update(office(), 'PpeTextApproval', id, `"withdrawnAt" = now(), "withdrawnById" = $2::uuid, "withdrawReason" = ' '`, a.actorId)).rejects.toThrow(/says why it is withdrawn/)
    await expect(update(office(), 'PpeTextApproval', id, `"withdrawnAt" = "recordedAt" - interval '1 day', "withdrawnById" = $2::uuid, "withdrawReason" = 'Wrong template (made-up).'`, a.actorId)).rejects.toThrow(/withdrawn after it was recorded/)
    expect(await update(office(), 'PpeTextApproval', id, `"withdrawnAt" = now(), "withdrawnById" = $2::uuid, "withdrawReason" = 'Wrong template (made-up).', version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'PpeTextApproval', id, `"withdrawReason" = 'Another reason (made-up).'`)).rejects.toThrow(/its withdrawal never changes/)
    await expect(update(office(), 'PpeTextApproval', id, `"withdrawnAt" = NULL, "withdrawnById" = NULL, "withdrawReason" = NULL`)).rejects.toThrow(/its withdrawal never changes/)
    await expect(run(office(), `DELETE FROM "PpeTextApproval" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "PpeTextApproval" WHERE id = $1`, [id])).rejects.toThrow(/never deleted; withdraw it with a reason/)
    await expect(admin(`TRUNCATE "PpeTextApproval"`)).rejects.toThrow(/TRUNCATE on "PpeTextApproval" is refused/)
    // Read by the office only.
    await expect(sql(floor(), `SELECT id FROM "PpeTextApproval" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('lets a generated document leave DRAFT only while a live approval of its template covers its language and company', async () => {
    // A generated Italian DoC of company A naming its template (B-W2b-257's content.template).
    const content = { ...((await one(`SELECT content FROM "ComplianceDocument" WHERE id = $1`, [t.documentIds.docIt2])).content as Record<string, unknown>), template: 'annex-ix.1' }
    let revision = 100
    const draft = async (changes: Record<string, unknown> = {}): Promise<string> => {
      const id = randomUUID()
      revision += 1
      expect(await copyRow(office(), 'ComplianceDocument', t.documentIds.docIt2, { id, companyId: A.company, revision, content, ...changes })).toBe(1)
      return id
    }
    const issue = (id: string) => update(office(), 'ComplianceDocument', id, `status = 'ISSUED', "issuedAt" = now()`)
    // Company B's approval in force (the seed) covers none of company A's documents; company A's own were withdrawn.
    const first = await draft()
    await expect(issue(first)).rejects.toThrow(/stays a DRAFT \(or is withdrawn\) until a PPE consultant has checked the generated texts \(GATE-PPE-TEXTS\): no live approval of its template annex-ix.1 covers it/)
    // Made as anything but a draft: refused, approval or not.
    await expect(draft({ status: 'ISSUED', issuedAt: now() })).rejects.toThrow(/GATE-PPE-TEXTS/)
    // Company A's approval of annex-ix version 1 in Italian.
    const approval = randomUUID()
    expect(await record({ id: approval, companyId: A.company, evidenceFileId: await file({ companyId: A.company }), languages: ['it'] })).toBe(1)
    expect(await issue(first)).toBe(1)
    // Another language, another version, no template named, or a tenant-wide document: still drafts.
    await expect(issue(await draft({ language: 'fr' }))).rejects.toThrow(/no live approval of its template annex-ix.1 covers fr/)
    await expect(issue(await draft({ content: { ...content, template: 'annex-ix.2' } }))).rejects.toThrow(/template annex-ix.2/)
    await expect(issue(await draft({ content: { ...content, template: undefined } }))).rejects.toThrow(/template \(none named\)/)
    await expect(issue(await draft({ companyId: null }))).rejects.toThrow(/no live approval/)
    // Withdrawn: no new issue; the issued one stays issued and is superseded as W1 says.
    const second = await draft()
    expect(await update(office(), 'PpeTextApproval', approval, `"withdrawnAt" = now(), "withdrawnById" = $2::uuid, "withdrawReason" = 'The consultant asked for a new check (made-up).'`, a.actorId)).toBe(1)
    await expect(issue(second)).rejects.toThrow(/no live approval/)
    expect(await update(office(), 'ComplianceDocument', first, `status = 'SUPERSEDED'`)).toBe(1)
    // A signed document is untouched by the gate (W1's live route).
    expect((await one(`SELECT status::text AS status FROM "ComplianceDocument" WHERE id = $1`, [t.documentIds.docIt1])).status).toBe('ISSUED')
  })
})

describe('a batch made while its declaration was in force', () => {
  it('goes with the SUPERSEDED document of its revision when it ships late; a new batch with the one in force', async () => {
    // A French translation-free copy of revision 1 (the work order WO-0003 made revision 1), issued, then superseded.
    const docOf = async (revision: number): Promise<string> => {
      const id = randomUUID()
      expect(await copyRow(office(), 'ComplianceDocument', t.documentIds.docIt1, { id, language: 'fr', revision, number: tag('T-DOC'), marketCode: null })).toBe(1)
      return id
    }
    const madeRevision = (await one(`SELECT r.revision FROM "WorkOrder" w JOIN "StyleRevision" r ON r.id = w."styleRevisionId" WHERE w.id = (SELECT "workOrderId" FROM "ComplianceDocumentBatch" WHERE id = $1)`, [t.batchIds.made])).revision as number
    const same = await docOf(madeRevision)
    const later = await docOf(madeRevision + 1)
    const record = (documentId: string, changes: Record<string, unknown> = {}) => copyRow(office(), 'ComplianceDocumentBatch', t.batchIds.made, { id: randomUUID(), documentId, createdAt: now(), retainUntil: '2040-01-01', ...changes })
    const legacy = (documentId: string, batchNumber: string, changes: Record<string, unknown> = {}) =>
      copyRow(office(), 'ComplianceDocumentBatch', t.batchIds.legacy, { id: randomUUID(), documentId, batchNumber, createdAt: now(), retainUntil: '2040-01-01', ...changes })
    // A typed batch recorded with the French revision while it is in force.
    const typed = tag('T-BT')
    expect(await legacy(same, typed)).toBe(1)
    for (const id of [same, later]) expect(await update(office(), 'ComplianceDocument', id, `status = 'SUPERSEDED'`)).toBe(1)
    // The work order's batch, made to that revision, ships late with it.
    expect(await record(same)).toBe(1)
    // A work order of another revision: refused.
    await expect(record(later)).rejects.toThrow(/names a SUPERSEDED document: only a batch made while it was in force ships with it/)
    // The typed batch recorded before ships late with it (on a shipment); another typed batch does not.
    expect(await legacy(same, typed, { shipmentId: (await one(`SELECT "shipmentId"::text AS id FROM "ComplianceDocumentBatch" WHERE id = $1`, [t.batchIds.shipped])).id })).toBe(1)
    await expect(legacy(same, tag('T-BT'))).rejects.toThrow(/names a SUPERSEDED document/)
    // A withdrawn document never goes with a batch (as before).
    expect(await update(office(), 'ComplianceDocument', later, `status = 'WITHDRAWN'`)).toBe(1)
    await expect(record(later)).rejects.toThrow(/names an ISSUED document \(this one is WITHDRAWN\)/)
  })
})
