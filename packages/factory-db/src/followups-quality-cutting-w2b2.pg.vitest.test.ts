import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCutting, type CuttingSeed } from '../seed/cutting'
import { seed as seedInspectionPlans, type InspectionPlansSeed } from '../seed/inspection-plans'
import { seed as seedNumbering } from '../seed/numbering'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The W2b-2 follow-ups for quality and cutting (W2b schema wave 24/33, B-W2b-204, …_followups_quality_cutting_w2b2_guards) on
 * a database built from the migrations and seeded, through the real login and the scoped client:
 *   - the inspected count on the three inspection records, up to the sample, and the AQL profile frozen once a unit is
 *     counted; the in-process check's own sample;
 *   - the rule that opened a record: given at insert by the office (the worker), never by the floor, never changed, of an
 *     event of that kind of record and of the record's plan; a final inspection a rule opened waits for its inspector while
 *     OPEN or CANCELLED, a decided one has one; a rule that opened records is not deleted;
 *   - a rule's due hours, the in-process check's due time (the office's);
 *   - the site's cutting rules, the leather area tolerance, the tenant's severity words (CRITICAL's meaning locked);
 *   - a recut closed by its DONE ticket, a VOID ticket replaced while OPEN;
 *   - a downgrade's second-quality move, named once, of its work order, garments and item, by one downgrade only.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-204-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let plans: InspectionPlansSeed
let cutting: CuttingSeed
let rules: { receipt: string; bundle: string; operation: string; packing: string }

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id)
/** A write past the database's guards (the facts a test needs: never what it then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const NOW = "'2026-11-21T08:00:00Z'"
const SHA = 'a'.repeat(64)

beforeAll(async () => {
  db = await migratedDatabase('followupsqcw2b2')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  plans = await seedInspectionPlans({ db: factory, namespace: NS })
  cutting = await seedCutting({ db: factory, namespace: NS })
  const byEvent = Object.fromEntries(
    (await admin(`SELECT event::text AS event, id::text AS id FROM "InspectionTrigger" WHERE "tenantId" = $1`, [a.tenantId])).map((row) => [row.event, row.id]),
  ) as Record<string, string>
  const packing = randomUUID()
  // A rule at packing on the final plan (B-W2b-101 held it: a final inspection needed its inspector at insert).
  await copyRow(office(), 'InspectionTrigger', byEvent.BUNDLE_SCAN!, { id: packing, event: 'PACKING', planId: plans.planIds.final, frequency: 'EVERY_LOT', frequencyValue: null, appliesTo: [] })
  rules = { receipt: byEvent.GOODS_RECEIPT!, bundle: byEvent.BUNDLE_SCAN!, operation: byEvent.OPERATION_FINISHED!, packing }
}, 240_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('a final inspection: the inspected count and the rule that opened it', () => {
  const copy = (changes: Record<string, unknown>, scope: FactoryScope = office()) =>
    copyRow(scope, 'Inspection', plans.inspectionId, { id: randomUUID(), number: tag('T-INS'), ...changes })
  const byRule = (changes: Record<string, unknown> = {}, scope: FactoryScope = office()) =>
    copy({ inspectorWorkerId: null, inspectorUserId: null, openedByTriggerId: rules.packing, planVersionId: plans.versionIds.final, ...changes }, scope)

  it('counts the units inspected from 0 up to the sample; a counted unit freezes the AQL profile', async () => {
    await expect(copy({ inspectedCount: 3 })).rejects.toThrow(/from 0 up to its sample of 2, not 3/)
    await expect(copy({ inspectedCount: -1 })).rejects.toThrow(/from 0 up to its sample of 2/)
    const id = randomUUID()
    expect(await copy({ id, inspectedCount: 0 })).toBe(1)
    expect(await update(office(), 'Inspection', id, `"codeLetter" = 'B'`)).toBe(1)
    expect(await update(floor(), 'Inspection', id, `"inspectedCount" = 2`)).toBe(1)
    await expect(update(office(), 'Inspection', id, `"sampleSize" = 1`)).rejects.toThrow(/from 0 up to its sample of 1, not 2/)
    await expect(update(office(), 'Inspection', id, `"codeLetter" = 'C'`)).rejects.toThrow(/frozen once counting starts \(2 unit/)
    await expect(update(office(), 'Inspection', id, `"aqlProfileId" = '${plans.profileIds.customer}'`)).rejects.toThrow(/frozen once counting starts/)
    expect(await admin(`SELECT "inspectedCount" FROM "Inspection" WHERE id = $1`, [id])).toEqual([{ inspectedCount: 2 }])
  })

  it('names exactly one inspector, unless a rule opened it: then none while OPEN or CANCELLED, one once decided', async () => {
    await expect(copy({ inspectorWorkerId: null })).rejects.toThrow(/exactly one inspector/)
    await expect(copy({ inspectorUserId: a.actorId })).rejects.toThrow(/exactly one inspector/)
    const id = randomUUID()
    expect(await byRule({ id })).toBe(1)
    const decide = () =>
      update(office(), 'Inspection', id, `status = 'PASSED', "decidedAt" = now(), "signatureSha256" = '${SHA}', checklist = '[{"code":"CE_MARK","ok":true}]', "notMakerStatement" = true`)
    await expect(decide()).rejects.toThrow(/exactly one inspector/)
    // The first inspector who takes it: at the bench (a worker), or in the office.
    expect(await update(floor(), 'Inspection', id, `"inspectorWorkerId" = '${plans.inspectorId}'`)).toBe(1)
    await expect(update(office(), 'Inspection', id, `"inspectorUserId" = '${a.actorId}'`)).rejects.toThrow(/exactly one inspector/)
    expect(await update(office(), 'Inspection', id, `"inspectorWorkerId" = NULL, "inspectorUserId" = '${a.actorId}'`)).toBe(1)
    // Nobody took it: cancelled as it is.
    const idle = randomUUID()
    expect(await byRule({ id: idle })).toBe(1)
    expect(await update(office(), 'Inspection', idle, `status = 'CANCELLED'`)).toBe(1)
  })

  it('names the rule once, at insert, by the office: a rule of an event that finishes garments, on the rule\'s plan', async () => {
    await expect(byRule({}, floor())).rejects.toThrow(/a floor session never names one/)
    await expect(byRule({ openedByTriggerId: rules.receipt })).rejects.toThrow(/\(GOODS_RECEIPT\) as the one that opened it; only a rule of OPERATION_FINISHED, BUNDLE_SCAN, PACKING opens one/)
    await expect(byRule({ planVersionId: null })).rejects.toThrow(/was opened by rule .*; it runs on a version of that rule's plan/)
    await expect(byRule({ openedByTriggerId: randomUUID() })).rejects.toThrow(/foreign key/)
    const id = randomUUID()
    expect(await byRule({ id, inspectorWorkerId: plans.inspectorId })).toBe(1)
    await expect(update(office(), 'Inspection', id, `"openedByTriggerId" = NULL`)).rejects.toThrow(/given when it opens and never changes/)
    await expect(update(office(), 'Inspection', id, `"openedByTriggerId" = '${rules.bundle}'`)).rejects.toThrow(/given when it opens and never changes/)
    await expect(update(office(), 'Inspection', plans.inspectionId, `"openedByTriggerId" = '${rules.packing}'`)).rejects.toThrow(/given when it opens and never changes/)
  })

  it('keeps a rule that opened records: set inactive, not deleted', async () => {
    await expect(run(office(), `DELETE FROM "InspectionTrigger" WHERE id = $1::uuid`, rules.packing)).rejects.toThrow(/foreign key/)
    expect(await update(office(), 'InspectionTrigger', rules.packing, `active = false`)).toBe(1)
  })
})

describe('an incoming inspection: the inspected count and the rule that opened it', () => {
  const open = (changes: Record<string, unknown>, scope: FactoryScope = office()) =>
    copyRow(scope, 'IncomingInspection', plans.openIncomingId, { id: randomUUID(), number: tag('T-IIN'), ...changes })

  it('counts up to the sample; a counted unit freezes the AQL profile', async () => {
    await expect(open({ inspectedCount: 3 })).rejects.toThrow(/incoming inspection .* from 0 up to its sample of 2, not 3/)
    const id = randomUUID()
    expect(await open({ id, foundCritical: 0, foundMajor: 0, foundMinor: 0 })).toBe(1)
    expect(await update(office(), 'IncomingInspection', id, `"codeLetter" = 'B'`)).toBe(1)
    expect(await update(floor(), 'IncomingInspection', id, `"inspectedCount" = 1`)).toBe(1)
    await expect(update(office(), 'IncomingInspection', id, `"codeLetter" = 'C'`)).rejects.toThrow(/frozen once counting starts \(1 unit/)
  })

  it('names a GOODS_RECEIPT rule once, at insert, by the office, and waits for its inspector', async () => {
    const id = randomUUID()
    expect(await open({ id, openedByTriggerId: rules.receipt, inspectorWorkerId: null })).toBe(1)
    await expect(open({ openedByTriggerId: rules.receipt }, floor())).rejects.toThrow(/a floor session never names one/)
    await expect(open({ openedByTriggerId: rules.bundle })).rejects.toThrow(/\(BUNDLE_SCAN\) as the one that opened it; only a rule of GOODS_RECEIPT opens one/)
    await expect(update(office(), 'IncomingInspection', id, `"openedByTriggerId" = '${rules.packing}'`)).rejects.toThrow(/given when it opens and never changes/)
  })
})

describe('an in-process check: its sample, count, due time and the rule that opened it', () => {
  const OPEN = { status: 'OPEN', outcome: null, decidedAt: null, signatureSha256: null, pieces: 0, defectivePieces: 0, defects: 0, defectCodeId: null }
  const check = async (changes: Record<string, unknown>, scope: FactoryScope = office()): Promise<string> => {
    const id = randomUUID()
    await copyRow(scope, 'InProcessCheck', plans.rovingId, { id, ...OPEN, ...changes })
    return id
  }

  it('keeps its AQL sample from 1, counts up to it, and freezes it once counting starts', async () => {
    await expect(check({ sampleSize: 0 })).rejects.toThrow(/an AQL sample from 1, not 0/)
    await expect(check({ sampleSize: 5, inspectedCount: 6 })).rejects.toThrow(/up to its sample of 5 when it has one, not 6/)
    await expect(check({ inspectedCount: -1 })).rejects.toThrow(/counts the units inspected from 0/)
    expect(await check({ inspectedCount: 40 })).toEqual(expect.any(String))
    const id = await check({ sampleSize: 5 })
    expect(await update(office(), 'InProcessCheck', id, `"sampleSize" = 8`)).toBe(1)
    expect(await update(floor(), 'InProcessCheck', id, `"inspectedCount" = 1`)).toBe(1)
    await expect(update(office(), 'InProcessCheck', id, `"sampleSize" = 13`)).rejects.toThrow(/frozen once counting starts/)
  })

  it('is due when the office says, never the floor', async () => {
    await expect(check({ dueAt: '2026-11-21T12:00:00Z' }, floor())).rejects.toThrow(/the floor does not/)
    const id = await check({}, floor())
    await expect(update(floor(), 'InProcessCheck', id, `"dueAt" = ${NOW}`)).rejects.toThrow(/the floor does not/)
    expect(await update(office(), 'InProcessCheck', id, `"dueAt" = ${NOW}`)).toBe(1)
    expect(await update(floor(), 'InProcessCheck', id, `note = 'Seen.'`)).toBe(1)
  })

  it('names an operation or bundle rule once, at insert, by the office, on the rule\'s plan', async () => {
    const byRule = { openedByTriggerId: rules.bundle, planVersionId: plans.versionIds.inLine, inspectorWorkerId: null, inspectorUserId: null }
    const id = await check(byRule)
    await expect(check({ ...byRule, openedByTriggerId: rules.operation, planVersionId: null })).rejects.toThrow(/it runs on a version of that rule's plan/)
    await expect(check({ ...byRule, openedByTriggerId: rules.receipt })).rejects.toThrow(/\(GOODS_RECEIPT\) as the one that opened it; only a rule of OPERATION_FINISHED, BUNDLE_SCAN opens one/)
    await expect(check(byRule, floor())).rejects.toThrow(/a floor session never names one/)
    await expect(update(office(), 'InProcessCheck', id, `"openedByTriggerId" = '${rules.operation}'`)).rejects.toThrow(/given when it opens and never changes/)
  })
})

describe('a rule\'s due hours', () => {
  it('makes what it opens due 1 to 720 hours later, or never', async () => {
    const rule = (dueHours: number | null) => copyRow(office(), 'InspectionTrigger', rules.operation, { id: randomUUID(), dueHours })
    await expect(rule(0)).rejects.toThrow(/due 1 to 720 hours later/)
    await expect(rule(721)).rejects.toThrow(/due 1 to 720 hours later/)
    expect(await rule(null)).toBe(1)
    expect(await update(office(), 'InspectionTrigger', rules.operation, `"dueHours" = 48`)).toBe(1)
    await expect(update(office(), 'InspectionTrigger', rules.operation, `"dueHours" = -2`)).rejects.toThrow(/due 1 to 720 hours later/)
  })
})

describe('settings', () => {
  it('keeps the site\'s cutting rules with today\'s defaults, a remnant above 0 and at most 10 m², which the floor reads', async () => {
    expect(await sql(office(), `SELECT "shadeRule"::text AS rule, "hidePhotoRequired" AS photo, "minimumRemnantArea"::text AS area, "minimumRemnantUom"::text AS uom FROM "ProductionSettings" WHERE id = $1::uuid`, A.site))
      .toEqual([{ rule: 'ORDER', photo: false, area: '10.0000', uom: 'DM2' }])
    await expect(update(office(), 'ProductionSettings', A.site, `"minimumRemnantArea" = 0`)).rejects.toThrow(/above 0 and at most 10 m²/)
    await expect(update(office(), 'ProductionSettings', A.site, `"minimumRemnantUom" = 'PCS'`)).rejects.toThrow(/in M2, DM2 or FT2/)
    await expect(update(office(), 'ProductionSettings', A.site, `"minimumRemnantArea" = 11, "minimumRemnantUom" = 'M2'`)).rejects.toThrow(/at most 10 m²/)
    await expect(update(office(), 'ProductionSettings', A.site, `"minimumRemnantArea" = 108, "minimumRemnantUom" = 'FT2'`)).rejects.toThrow(/at most 10 m²/)
    expect(await update(office(), 'ProductionSettings', A.site, `"minimumRemnantArea" = 1000`)).toBe(1)
    expect(await update(office(), 'ProductionSettings', A.site, `"shadeRule" = 'GARMENT', "hidePhotoRequired" = true, "minimumRemnantArea" = 1.5, "minimumRemnantUom" = 'FT2'`)).toBe(1)
    expect(await sql(floor(), `SELECT "shadeRule"::text AS rule, "hidePhotoRequired" AS photo, "minimumRemnantArea"::text AS area FROM "ProductionSettings"`))
      .toEqual([{ rule: 'GARMENT', photo: true, area: '1.5000' }])
    await expect(sql(floor(), `SELECT "monitoringBasis" FROM "ProductionSettings"`)).rejects.toThrow(/permission denied/)
    await expect(update(floor(), 'ProductionSettings', A.site, `"shadeRule" = 'OFF'`)).rejects.toThrow(/permission denied/)
  })

  it('keeps a leather area tolerance of 0 to 100 percent, or none', async () => {
    await run(office(), `INSERT INTO "PurchasingSettings" (id, "companyId") VALUES ($1::uuid, $1::uuid) ON CONFLICT (id) DO NOTHING`, A.company)
    await expect(update(office(), 'PurchasingSettings', A.company, `"leatherAreaTolerancePct" = 100.5`)).rejects.toThrow(/0 to 100 percent/)
    await expect(update(office(), 'PurchasingSettings', A.company, `"leatherAreaTolerancePct" = -1`)).rejects.toThrow(/0 to 100 percent/)
    expect(await update(office(), 'PurchasingSettings', A.company, `"leatherAreaTolerancePct" = 2.5`)).toBe(1)
    expect(await update(office(), 'PurchasingSettings', A.company, `"leatherAreaTolerancePct" = NULL`)).toBe(1)
    await expect(sql(floor(), `SELECT "leatherAreaTolerancePct" FROM "PurchasingSettings"`)).rejects.toThrow(/permission denied/)
  })

  it('keeps the tenant\'s severity words on its tenant-wide row, per class and language; CRITICAL keeps its meaning', async () => {
    await run(office(), `INSERT INTO "QualitySettings" (id, "companyId") VALUES ($1::uuid, NULL) ON CONFLICT (id) DO NOTHING`, a.tenantId)
    await run(office(), `INSERT INTO "QualitySettings" (id, "companyId") VALUES ($1::uuid, $1::uuid) ON CONFLICT (id) DO NOTHING`, A.company)
    const words = (texts: unknown, id = a.tenantId) => run(office(), `UPDATE "QualitySettings" SET "severityTexts" = $1::jsonb WHERE id = $2::uuid`, JSON.stringify(texts), id)
    const good = { CRITICAL: { words: { it: 'Critico (sicurezza)', ro: 'Critic' } }, MAJOR: { words: { it: 'Grave' }, meaning: { it: 'Un difetto che fa rendere il capo.', en: 'A defect that brings the garment back.' } } }
    await expect(words(good, A.company)).rejects.toThrow(/the severity words are the tenant's/)
    await expect(words({ CRITICAL: { meaning: { it: 'Accettabile.' } } })).rejects.toThrow(/CRITICAL keeps its locked meaning/)
    await expect(words({ SEVERE: { words: { it: 'Severo' } } })).rejects.toThrow(/a class CRITICAL, MAJOR or MINOR, not SEVERE/)
    await expect(words({ MINOR: { label: { it: 'Lieve' } } })).rejects.toThrow(/words or meaning, not label/)
    await expect(words({ MINOR: { words: { ITA: 'Lieve' } } })).rejects.toThrow(/a language code of two or three letters/)
    await expect(words({ MINOR: { words: { it: ' ' } } })).rejects.toThrow(/a text of 1 to 60 characters/)
    await expect(words({ MINOR: { words: { it: 'x'.repeat(61) } } })).rejects.toThrow(/a text of 1 to 60 characters/)
    await expect(words({ MINOR: { meaning: { it: 'x'.repeat(501) } } })).rejects.toThrow(/a text of 1 to 500 characters/)
    await expect(words({ MINOR: 'Lieve' })).rejects.toThrow(/an object of words and meaning/)
    await expect(words(['MINOR'])).rejects.toThrow(/an object of severity classes/)
    expect(await words(good)).toBe(1)
    expect(await sql(floor(), `SELECT "severityTexts" #>> '{CRITICAL,words,ro}' AS ro FROM "QualitySettings" WHERE id = $1::uuid`, a.tenantId)).toEqual([{ ro: 'Critic' }])
    expect(await update(office(), 'QualitySettings', a.tenantId, `"severityTexts" = NULL`)).toBe(1)
  })
})

describe('a recut closed by its ticket (B-W2b-117)', () => {
  it('replaces a VOID ticket while OPEN, never clears it, and is DONE once its ticket is DONE', async () => {
    const replacement = cutting.replacementRequestId
    const ticket = () => {
      const id = randomUUID()
      return copyRow(office(), 'CutTicket', cutting.ticketIds.recut, { id, number: tag('T-CT'), scanCode: tag('T-CT') }).then(() => id)
    }
    await expect(update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = NULL`)).rejects.toThrow(/never changes/)
    const next = await ticket()
    await expect(update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = '${next}'`)).rejects.toThrow(/which is OPEN; its recut ticket never changes until that one is VOID/)
    await expect(update(office(), 'ReplacementRequest', replacement, `status = 'DONE', "doneAt" = ${NOW}`)).rejects.toThrow(/done by its recut ticket .*, which is OPEN/)
    expect(await update(office(), 'CutTicket', cutting.ticketIds.recut, `status = 'VOID', "voidedAt" = ${NOW}, "voidReason" = 'Cut on the wrong table.'`)).toBe(1)
    expect(await update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = '${next}'`)).toBe(1)
    await expect(update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = '${cutting.ticketIds.recut}'`)).rejects.toThrow(/not VOID|never changes until that one is VOID/)
    expect(await update(floor(), 'CutTicket', next, `status = 'STARTED', "startedAt" = ${NOW}`)).toBe(1)
    await expect(update(office(), 'ReplacementRequest', replacement, `status = 'DONE', "doneAt" = ${NOW}`)).rejects.toThrow(/which is STARTED/)
    expect(await update(floor(), 'CutTicket', next, `status = 'DONE', "doneAt" = ${NOW}`)).toBe(1)
    expect(await update(office(), 'ReplacementRequest', replacement, `status = 'DONE', "doneAt" = ${NOW}`)).toBe(1)
    await expect(update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = '${cutting.ticketIds.recut}'`)).rejects.toThrow(/only its note changes/)
    // A RECUT with neither its cut nor a ticket is not DONE (W2a's rule, kept).
    const bare = randomUUID()
    await copyRow(office(), 'ReplacementRequest', replacement, { id: bare, status: 'OPEN', doneAt: null, recutTicketId: null })
    await expect(update(office(), 'ReplacementRequest', bare, `status = 'DONE', "doneAt" = ${NOW}`)).rejects.toThrow(/DONE exactly with its cut log entry or its DONE recut ticket/)
  })
})

describe('the second-quality move of a downgrade (B-W2b-85, -126)', () => {
  /** A stock move of the downgrade's site: a copy of the seeded opening move with `changes` (a fact, written past the guards). */
  async function move(changes: Record<string, unknown>): Promise<string> {
    const id = randomUUID()
    const [{ id: opening } = {}] = await admin(`SELECT id::text AS id FROM "StockMove" WHERE "tenantId" = $1 AND "siteId" = $2 AND reason = 'OPENING' ORDER BY id LIMIT 1`, [a.tenantId, A.site])
    await force(
      `INSERT INTO "StockMove" SELECT * FROM jsonb_populate_record(NULL::"StockMove", (SELECT to_jsonb(m) || $1::jsonb FROM "StockMove" m WHERE m.id = $2::uuid))`,
      [JSON.stringify({ id, idempotencyKey: `test.downgrade:${id}`, reason: 'ADJUSTMENT', itemColourId: null, lotId: null, hideId: null, fromLocationId: null, quantity: '1', uom: 'PCS', baseQuantity: '1', workOrderId: cutting.workOrderId, reversalOfId: null, receiptLineId: null, reasonCode: null, ...changes }), opening],
    )
    return id
  }

  it('is named once (at insert or later), of its work order, garments and item, by one downgrade', async () => {
    const [{ item } = {}] = await admin(`SELECT "secondQualityItemId"::text AS item FROM "GarmentDowngrade" WHERE id = $1`, [cutting.downgradeIds.item])
    const good = await move({ itemId: item })
    const name = (downgrade: string, moveId: string | null) => update(office(), 'GarmentDowngrade', downgrade, `"moveId" = ${moveId === null ? 'NULL' : `'${moveId}'`}`)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: item, quantity: '2', baseQuantity: '2' }))).rejects.toThrow(/puts its 1 garment\(s\) of work order .* into a place/)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: item, reason: 'RECEIPT' }))).rejects.toThrow(/an ADJUSTMENT or a PRODUCTION_RECEIPT/)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: item, workOrderId: null }))).rejects.toThrow(/into a place/)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: item, reversalOfId: good }))).rejects.toThrow(/not a reversal/)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: plans.itemId }))).rejects.toThrow(/of another item than the one it keeps the garments as/)
    expect(await name(cutting.downgradeIds.item, good)).toBe(1)
    await expect(name(cutting.downgradeIds.item, await move({ itemId: item }))).rejects.toThrow(/names its second-quality move once/)
    await expect(name(cutting.downgradeIds.item, null)).rejects.toThrow(/names its second-quality move once/)
    // A SKU's garments are an item of that SKU (the seed's finished item is the SKU's), and one downgrade names a move.
    await expect(name(cutting.downgradeIds.sku, await move({ itemId: plans.itemId }))).rejects.toThrow(/of another item/)
    await expect(name(cutting.downgradeIds.sku, good)).rejects.toThrow(/the second-quality move of another downgrade/)
    await expect(copyRow(floor(), 'GarmentDowngrade', cutting.downgradeIds.item, { id: randomUUID(), moveId: good })).rejects.toThrow(/the second-quality move of another downgrade/)
    expect(await copyRow(floor(), 'GarmentDowngrade', cutting.downgradeIds.item, { id: randomUUID(), moveId: await move({ itemId: item, idempotencyKey: tag('test.downgrade') }) })).toBe(1)
    // The rest of the row still changes only by its withdrawal.
    await expect(update(office(), 'GarmentDowngrade', cutting.downgradeIds.item, `quantity = 2`)).rejects.toThrow(/never changes; withdraw it/)
    expect(await update(office(), 'GarmentDowngrade', cutting.downgradeIds.item, `"voidedAt" = ${NOW}, "voidedById" = "createdById", "voidReason" = 'Counted twice.'`)).toBe(1)
  })
})
