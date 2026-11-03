import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedNumbering } from '../seed/numbering'
import { seed as seedPlant, type PlantSeed } from '../seed/plant'
import { seed as seedPlantCare, type PlantCareSeed } from '../seed/plantcare'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The plant care schema (W2b schema wave 14/16, B-W2b-86, …_plant_care_w2b_guards) on a database built from the migrations and
 * seeded, through the real login and the scoped client:
 *   - grants: check types, plans and results are the office's; the floor reads dies (never their cost), its plant rules and
 *     its routing, inserts status events only (through the machine's trigger), adds photos and voice notes of a job; the
 *     partner reads nothing;
 *   - check types, plans and results: fixed codes, intervals, retention of at least three years, one active plan per machine
 *     and type, results append-only for every login, a correction once;
 *   - the status history: every change of a machine's status writes one event, for the office and the floor alike;
 *   - dies: a size of the style's range, a fixed number, retired and never deleted;
 *   - the plant rules hold Owner answer H1; routing rules send to one target and escalate in order;
 *   - a request's progress (acknowledged, on the way, works again) and routing; a job's one-screen close, the lead's
 *     confirmation and the check it was made from;
 *   - what the floor may add to files; a check report's document is of its result's company and site.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-86-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let plant: PlantSeed
let seeded: PlantCareSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  site: key('site:A1'),
  companyB: key('company:B'),
  siteB: key('site:B1'),
  operator: key('worker:A1:operator'),
  lead: key('worker:A1:lead'),
  style: key('product:style:JKT-01'),
  store: key('files:account:r2'),
  e2: key('people:employee:A1:2'),
  e5: key('people:employee:A1:5'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (worker: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: worker, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const value = async (text: string, values: unknown[] = []): Promise<unknown> => Object.values((await admin(text, values))[0] ?? {})[0]
/** INSERT a copy of row `id` of `table` with `changes`, naming only the columns the scope's role may insert. */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify(changes),
    id,
  )
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const now = () => new Date().toISOString()

beforeAll(async () => {
  db = await migratedDatabase('plantcarew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  plant = await seedPlant({ db: factory, namespace: NS })
  seeded = await seedPlantCare({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the seven models of the file, none with a partner grant and none as personal data', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'plantcare.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['ClickingDie', 'MachineCheckPlan', 'MachineCheckResult', 'MachineCheckType', 'MachineStatusEvent', 'PlantSettings', 'RequestRoutingRule'])
    for (const { ownership: entry } of models) expect(Object.keys(entry.access)).not.toContain('factory_partner_runtime')
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('keeps checks from the floor, the die cost and the history from its reads, and the partner out', async () => {
    for (const table of ['MachineCheckType', 'MachineCheckPlan', 'MachineCheckResult', 'MachineStatusEvent']) {
      await expect(sql(floorAs(A.operator), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    }
    for (const table of ['ClickingDie', 'PlantSettings', 'RequestRoutingRule']) {
      expect((await sql(floorAs(A.operator), `SELECT id FROM "${table}"`)).length).toBeGreaterThan(0)
      await expect(run(floorAs(A.operator), `UPDATE "${table}" SET "updatedAt" = now() WHERE false`)).rejects.toThrow(DENIED)
    }
    await expect(sql(floorAs(A.operator), `SELECT "purchaseCost" FROM "ClickingDie"`)).rejects.toThrow(DENIED)
    for (const table of ['MachineCheckType', 'MachineCheckPlan', 'MachineCheckResult', 'MachineStatusEvent', 'ClickingDie', 'PlantSettings', 'RequestRoutingRule']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    }
    await expect(run(office(), `UPDATE "MachineCheckResult" SET remarks = 'x' WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "MachineStatusEvent" WHERE false`)).rejects.toThrow(DENIED)
  })

  it('the seed is idempotent: a second run writes nothing new', async () => {
    const counted = async () =>
      admin(
        `SELECT (SELECT count(*) FROM "MachineCheckType") t, (SELECT count(*) FROM "MachineCheckPlan") p, (SELECT count(*) FROM "MachineCheckResult") r,
                (SELECT count(*) FROM "MachineStatusEvent") e, (SELECT count(*) FROM "ClickingDie") d, (SELECT count(*) FROM "RequestRoutingRule") rr,
                (SELECT count(*) FROM "StoredFile") f, (SELECT count(*) FROM "MaintenanceJob") j`,
      )
    const before = await counted()
    await seedPlantCare({ db: factory, namespace: NS })
    expect(await counted()).toEqual(before)
  })

  it('marks the classes the seed keeps under authorisation; a new class needs none', async () => {
    expect(await value(`SELECT "authorisationRequired" FROM "MachineClass" WHERE id = $1`, [plant.classIds['POST_BED']])).toBe(true)
    expect(await value(`SELECT "authorisationRequired" FROM "MachineClass" WHERE id = $1`, [plant.classIds['CLICKING_PRESS']])).toBe(false)
    expect(await sql(floorAs(A.operator), `SELECT "authorisationRequired" FROM "MachineClass" WHERE id = $1::uuid`, plant.classIds['POST_BED'])).toEqual([{ authorisationRequired: true }])
  })
})

describe('check types, plans and results', () => {
  it('keeps a check type: fixed code and class, the law, an interval up to ten years, results kept three years at least, never deleted', async () => {
    const type = seeded.checkTypeIds.guards
    await expect(run(office(), `UPDATE "MachineCheckType" SET code = 'X' WHERE id = $1::uuid`, type)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "MachineCheckType" SET "classId" = NULL WHERE id = $1::uuid`, type)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "MachineCheckType" SET "retentionYears" = 2 WHERE id = $1::uuid`, type)).rejects.toThrow(/at least three/)
    await expect(run(office(), `UPDATE "MachineCheckType" SET "defaultInterval" = 121 WHERE id = $1::uuid`, type)).rejects.toThrow(/at most ten years/)
    await expect(run(office(), `UPDATE "MachineCheckType" SET "legalBasis" = ' ' WHERE id = $1::uuid`, type)).rejects.toThrow(/the law it rests on/)
    await expect(copyRow(office(), 'MachineCheckType', type, { id: randomUUID(), code: 'A B' })).rejects.toThrow(/code without spaces/)
    expect(await run(office(), `UPDATE "MachineCheckType" SET "defaultInterval" = 6, "labelEn" = 'Guards' WHERE id = $1::uuid`, type)).toBe(1)
    await expect(admin(`DELETE FROM "MachineCheckType" WHERE id = $1`, [type])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "MachineCheckType" CASCADE')).rejects.toThrow(/refused/)
  })

  it('one active plan per machine and type, of a machine of the type’s class, from an active type; an ended plan never changes', async () => {
    const plan = (changes: Record<string, unknown>) => copyRow(office(), 'MachineCheckPlan', seeded.planIds.guards, { id: randomUUID(), ...changes })
    await expect(plan({})).rejects.toThrow(/MachineCheckPlan_one_active|unique/)
    await expect(plan({ checkTypeId: seeded.checkTypeIds.lifting })).rejects.toThrow(/retired; it takes no new plan/)
    await expect(plan({ machineId: plant.machineIds[0] })).rejects.toThrow(/another class of machine/)
    await expect(plan({ status: 'ENDED' })).rejects.toThrow(/wrong ending/)
    await expect(plan({ status: 'ENDED', endedAt: now(), endedReason: 'x', nextDueOn: '2026-01-01' })).rejects.toThrow(/not before its first/)
    await expect(plan({ checkTypeId: seeded.checkTypeIds.pressure, intervalUnit: 'WEEK', interval: 521 })).rejects.toThrow(/at most ten years/)
    expect(await plan({ checkTypeId: seeded.checkTypeIds.pressure, outsideBodyPartyId: key('party:P2') })).toBe(1)
    await expect(run(office(), `UPDATE "MachineCheckPlan" SET "firstDueOn" = '2026-09-01' WHERE id = $1::uuid`, seeded.planIds.guards)).rejects.toThrow(/never change/)
    expect(await run(office(), `UPDATE "MachineCheckPlan" SET "nextDueOn" = '2027-03-01', "lastRemindedAt" = now() WHERE id = $1::uuid`, seeded.planIds.guards)).toBe(1)
    await expect(run(office(), `UPDATE "MachineCheckPlan" SET note = 'x' WHERE id = $1::uuid`, seeded.planIds.ended)).rejects.toThrow(/ENDED; it never changes/)
    await expect(run(office(), `UPDATE "MachineCheckPlan" SET status = 'ACTIVE', "endedAt" = NULL, "endedReason" = NULL WHERE id = $1::uuid`, seeded.planIds.ended)).rejects.toThrow(/ENDED; it never changes/)
    await expect(admin(`DELETE FROM "MachineCheckPlan" WHERE id = $1`, [seeded.planIds.ended])).rejects.toThrow(/never deleted/)
  })

  it('keeps the register append-only for every login: its plan, who did it, remarks, retention, one correction', async () => {
    const result = (changes: Record<string, unknown>) => copyRow(office(), 'MachineCheckResult', seeded.resultIds.passed, { id: randomUUID(), createdAt: now(), ...changes })
    await expect(admin(`UPDATE "MachineCheckResult" SET remarks = 'x' WHERE id = $1`, [seeded.resultIds.passed])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "MachineCheckResult" WHERE id = $1`, [seeded.resultIds.passed])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "MachineCheckResult" CASCADE')).rejects.toThrow(/append-only/)
    await expect(result({ planId: seeded.planIds.earthing })).rejects.toThrow(/of its machine and check type/)
    await expect(result({ outcome: 'FAILED' })).rejects.toThrow(/what was found unless it PASSED/)
    await expect(result({ performedBy: ' ' })).rejects.toThrow(/says who did it/)
    await expect(result({ nextDueOn: '2026-08-20' })).rejects.toThrow(/next due date after the day/)
    await expect(result({ keptUntil: '2029-08-19' })).rejects.toThrow(/at least 3 years/)
    // The pressure type keeps its results five years.
    await expect(result({ planId: null, checkTypeId: seeded.checkTypeIds.pressure, keptUntil: '2030-08-20' })).rejects.toThrow(/at least 5 years/)
    expect(await result({ planId: null, checkTypeId: seeded.checkTypeIds.pressure, keptUntil: '2031-08-20', outsideBodyPartyId: key('party:P2') })).toBe(1)
    await expect(result({ correctsId: seeded.resultIds.failed })).rejects.toThrow(/exactly with why/)
    await expect(result({ correctsId: seeded.resultIds.passed, correctionReason: 'again' })).rejects.toThrow(/MachineCheckResult_corrected_once|unique/)
    await expect(result({ checkTypeId: seeded.checkTypeIds.earthing, planId: null, correctsId: seeded.resultIds.failed, correctionReason: 'x' })).rejects.toThrow(/same machine and check type/)
    expect(await result({ outcome: 'FAILED', remarks: 'Guard missing.', nextDueOn: null, correctsId: seeded.resultIds.failed, correctionReason: 'Typed against the wrong day.' })).toBe(1)
  })
})

describe('the status history of a machine (QHS-167)', () => {
  it('writes one event per change of status, from the office and the floor alike, and none when the status stays', async () => {
    const sewing = plant.machineIds[0]
    const events = async () => admin(`SELECT "fromStatus"::text AS f, "toStatus"::text AS t, reason, "companyId"::text AS company FROM "MachineStatusEvent" WHERE "machineId" = $1 ORDER BY "createdAt", at`, [sewing])
    const before = (await events()).length
    expect(await run(floorAs(A.operator), `UPDATE "Machine" SET status = 'DOWN', "statusSince" = now(), "statusReason" = 'Thread breaks' WHERE id = $1::uuid`, sewing)).toBe(1)
    expect(await run(floorAs(A.operator), `UPDATE "Machine" SET "statusReason" = 'Thread breaks again' WHERE id = $1::uuid`, sewing)).toBe(1)
    expect(await run(office(), `UPDATE "Machine" SET status = 'RUNNING', "statusSince" = now(), "statusReason" = ' ' WHERE id = $1::uuid`, sewing)).toBe(1)
    expect((await events()).slice(before)).toEqual([
      { f: 'RUNNING', t: 'DOWN', reason: 'Thread breaks', company: A.company },
      { f: 'DOWN', t: 'RUNNING', reason: null, company: A.company },
    ])
    const [event] = await admin(`SELECT id FROM "MachineStatusEvent" WHERE "machineId" = $1 LIMIT 1`, [sewing])
    await expect(admin(`UPDATE "MachineStatusEvent" SET reason = 'x' WHERE id = $1`, [event!.id])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "MachineStatusEvent" CASCADE')).rejects.toThrow(/append-only/)
    await expect(insert(office(), 'MachineStatusEvent', { id: randomUUID(), companyId: A.company, siteId: A.site, machineId: sewing, fromStatus: 'DOWN', toStatus: 'DOWN', at: now() })).rejects.toThrow(/a change to another status/)
  })
})

describe('clicking dies (QHS-173)', () => {
  it('a size of its style’s range, a fixed number and style, retired once and then frozen, never deleted', async () => {
    const die = seeded.dieIds.front50
    await expect(copyRow(office(), 'ClickingDie', die, { id: randomUUID(), code: tag('T-D'), size: '60' })).rejects.toThrow(/not in its style's range/)
    await expect(copyRow(office(), 'ClickingDie', die, { id: randomUUID(), code: 'T D' })).rejects.toThrow(/number without spaces/)
    await expect(copyRow(office(), 'ClickingDie', die, { id: randomUUID(), code: tag('T-D'), condition: 'RETIRED' })).rejects.toThrow(/registered in use/)
    expect(await copyRow(office(), 'ClickingDie', die, { id: randomUUID(), code: tag('T-D'), size: null, purchaseCost: null })).toBe(1)
    await expect(run(office(), `UPDATE "ClickingDie" SET code = 'X-1' WHERE id = $1::uuid`, die)).rejects.toThrow(/never change/)
    expect(await run(office(), `UPDATE "ClickingDie" SET "rackLocation" = 'Rack R5', condition = 'DAMAGED' WHERE id = $1::uuid`, die)).toBe(1)
    await expect(run(office(), `UPDATE "ClickingDie" SET condition = 'GOOD' WHERE id = $1::uuid`, seeded.dieIds.retired)).rejects.toThrow(/RETIRED; only its note changes/)
    expect(await run(office(), `UPDATE "ClickingDie" SET note = 'Still cracked.' WHERE id = $1::uuid`, seeded.dieIds.retired)).toBe(1)
    await expect(admin(`DELETE FROM "ClickingDie" WHERE id = $1`, [die])).rejects.toThrow(/never deleted/)
  })
})

describe('the plant rules and the routing (QHS-179, QHS-183)', () => {
  it('holds Owner answer H1: anyone at the station locks, only a technician signs safe', async () => {
    await expect(run(office(), `UPDATE "PlantSettings" SET "lockBy" = 'LEADS_AND_TECHNICIANS' WHERE id = $1::uuid`, seeded.settingsId)).rejects.toThrow(/Owner answer H1/)
    await expect(run(office(), `UPDATE "PlantSettings" SET "signSafeBy" = 'TECHNICIANS_AND_SAFETY_OFFICER' WHERE id = $1::uuid`, seeded.settingsId)).rejects.toThrow(/Owner answer H1/)
    expect(await run(office(), `UPDATE "PlantSettings" SET "hazardReportOnLock" = false WHERE id = $1::uuid`, seeded.settingsId)).toBe(1)
    await expect(admin(`DELETE FROM "PlantSettings" WHERE id = $1`, [seeded.settingsId])).rejects.toThrow(/never go/)
  })

  it('a rule sends to exactly one of a team and a technician, escalates in order to active people; an unused rule may go', async () => {
    const rule = (changes: Record<string, unknown>) => copyRow(office(), 'RequestRoutingRule', seeded.ruleIds.lockstitch, { id: randomUUID(), ...changes })
    await expect(rule({ technicianId: A.e2 })).rejects.toThrow(/exactly one of a team and a technician/)
    await expect(rule({ escalateToId: null })).rejects.toThrow(/escalates after 1 to 1440 minutes/)
    await expect(rule({ escalateAgainAfterMinutes: 5 })).rejects.toThrow(/again \(later/)
    await expect(rule({ escalateAfterMinutes: null, escalateToId: null })).rejects.toThrow(/only after a first escalation/)
    await expect(rule({ escalateToId: A.e5 })).rejects.toThrow(/has left/)
    const id = randomUUID()
    expect(await copyRow(office(), 'RequestRoutingRule', seeded.ruleIds.lockstitch, { id, seq: 5 })).toBe(1)
    expect(await run(office(), `DELETE FROM "RequestRoutingRule" WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `DELETE FROM "RequestRoutingRule" WHERE id = $1::uuid`, seeded.ruleIds.fallback)).rejects.toThrow(/foreign key/)
  })
})

describe('a request’s progress and routing (QHS-179, QHS-180)', () => {
  /** A NEW request of the sewing machine from its station (the floor). */
  async function newRequest(changes: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID()
    await insert(floorAs(A.operator), 'MaintenanceRequest', {
      id,
      companyId: A.company,
      siteId: A.site,
      machineId: plant.machineIds[0],
      symptomId: plant.symptomIds['NOISE'],
      reportedAt: now(),
      reportedByWorkerId: A.operator,
      stationId: key('site:A1:station:SEW-01'),
      ...changes,
    })
    return id
  }
  const update = (scope: FactoryScope, id: string, set: string) => run(scope, `UPDATE "MaintenanceRequest" SET ${set} WHERE id = $1::uuid`, id)

  it('starts with nothing confirmed; the floor routes it at the report, acknowledges and is on the way as a worker, never as an office user', async () => {
    await expect(newRequest({ onTheWayAt: now(), onTheWayByWorkerId: A.lead })).rejects.toThrow(/nobody on the way/)
    await expect(newRequest({ escalationLevel: 1, escalatedAt: now() })).rejects.toThrow(/not escalated/)
    await expect(newRequest({ routingRuleId: seeded.ruleIds.lockstitch })).rejects.toThrow(/a rule only with one/)
    await expect(newRequest({ routedTeamId: key('people:team:A1:L1-A'), routedEmployeeId: A.e2 })).rejects.toThrow(/at most one of a team and a person/)
    const id = await newRequest({ routingRuleId: seeded.ruleIds.lockstitch, routedTeamId: key('people:team:A1:L1-A') })
    await expect(update(floorAs(A.lead), id, `"routedTeamId" = NULL, "routingRuleId" = NULL, "routedEmployeeId" = '${A.e2}'`)).rejects.toThrow(/the floor signs request .* nothing else/)
    await expect(update(floorAs(A.lead), id, `"escalationLevel" = 1, "escalatedAt" = now()`)).rejects.toThrow(/the floor signs request .* nothing else/)
    await expect(update(floorAs(A.lead), id, `status = 'ACKNOWLEDGED', "acknowledgedAt" = now(), "acknowledgedById" = '${a.actorId}'`)).rejects.toThrow(/the floor signs request .* nothing else/)
    await expect(update(floorAs(A.lead), id, `"onTheWayAt" = now(), "onTheWayByWorkerId" = '${A.lead}'`)).rejects.toThrow(/only while it is ACKNOWLEDGED or JOB_MADE/)
    expect(await update(office(), id, `"escalationLevel" = 1, "escalatedAt" = now()`)).toBe(1)
    await expect(update(office(), id, `"escalationLevel" = 0, "escalatedAt" = NULL`)).rejects.toThrow(/escalates only further/)
    await expect(update(office(), id, `"escalatedAt" = now()`)).rejects.toThrow(/escalates only further/)
    await expect(update(floorAs(A.lead), id, `status = 'ACKNOWLEDGED', "acknowledgedAt" = now(), "acknowledgedByWorkerId" = '${A.lead}', "acknowledgedById" = NULL`)).resolves.toBe(1)
    await expect(update(office(), id, `"acknowledgedByWorkerId" = '${A.operator}'`)).rejects.toThrow(/each written once/)
    await expect(update(floorAs(A.lead), id, `"onTheWayAt" = now()`)).rejects.toThrow(/exactly one person/)
    expect(await update(floorAs(A.lead), id, `"onTheWayAt" = now(), "onTheWayByWorkerId" = '${A.lead}'`)).toBe(1)
    await expect(update(floorAs(A.lead), id, `"onTheWayAt" = now()`)).rejects.toThrow(/each written once/)
    await expect(update(floorAs(A.operator), id, `"confirmedWorksAt" = now(), "confirmedWorksByWorkerId" = '${A.operator}'`)).rejects.toThrow(/once its job is handed back/)
  })

  it('a triaged request takes its progress, not its routing; works again only once its job is handed back, never while it locks the machine', async () => {
    const id = await newRequest()
    const job = randomUUID()
    await copyRow(office(), 'MaintenanceJob', seeded.jobIds.fromCheck, {
      id: job,
      number: tag('T-MJ'),
      machineId: plant.machineIds[0],
      source: 'REQUEST',
      checkResultId: null,
      type: 'CORRECTIVE',
      createdAt: now(),
    })
    expect(await update(office(), id, `status = 'JOB_MADE', "jobId" = '${job}'`)).toBe(1)
    await expect(update(office(), id, `"routedEmployeeId" = '${A.e2}'`)).rejects.toThrow(/only its sign-safe and its progress/)
    expect(await update(floorAs(A.lead), id, `"onTheWayAt" = now(), "onTheWayByWorkerId" = '${A.lead}'`)).toBe(1)
    await expect(update(floorAs(A.operator), id, `"confirmedWorksAt" = now(), "confirmedWorksByWorkerId" = '${A.operator}'`)).rejects.toThrow(/once its job .* is handed back/)
    expect(await run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET status = 'IN_PROGRESS', "startedAt" = now() WHERE id = $1::uuid`, job)).toBe(1)
    expect(
      await run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET status = 'HANDED_BACK', "handedBackAt" = now(), "handedBackByWorkerId" = $2::uuid, "workDone" = 'Cleaned.', "machineAfter" = 'RUNNING' WHERE id = $1::uuid`, job, A.lead),
    ).toBe(1)
    await expect(update(floorAs(A.operator), id, `"confirmedWorksAt" = now(), "confirmedWorksById" = '${a.actorId}'`)).rejects.toThrow(/the floor signs request .* nothing else/)
    await expect(update(floorAs(A.operator), id, `"confirmedWorksById" = '${a.actorId}'`)).rejects.toThrow(/the floor signs request .* nothing else/)
    // The station alone (a site that records the station): no person.
    expect(await update(floorAs(A.operator), id, `"confirmedWorksAt" = now()`)).toBe(1)
    await expect(update(office(), id, `"confirmedWorksById" = '${a.actorId}'`)).rejects.toThrow(/each written once/)
    // The press's unsafe request is never confirmed working before its sign-safe.
    await expect(update(office(), plant.requestIds[1], `"confirmedWorksAt" = now(), "confirmedWorksById" = '${a.actorId}'`)).rejects.toThrow(/nobody confirms it works before a technician signs it safe/)
  })
})

describe('a job’s one-screen close, the lead’s confirmation and the check it came from (QHS-190, QHS-205)', () => {
  const job = () => seeded.jobIds.cuttingTable
  const update = (scope: FactoryScope, id: string, set: string) => run(scope, `UPDATE "MaintenanceJob" SET ${set} WHERE id = $1::uuid`, id)

  it('the failure code and minutes go with the hand-back; the lead confirms once, on the floor or in the office, and it goes with the hand-back too', async () => {
    await expect(update(floorAs(A.lead), job(), `"failureCode" = 'loose part'`)).rejects.toThrow(/upper-case letters, digits, underscores/)
    await expect(update(floorAs(A.lead), job(), `"minutesSpent" = -1`)).rejects.toThrow(/0 to 525600/)
    await expect(update(floorAs(A.lead), job(), `"leadConfirmedAt" = now(), "leadConfirmedByWorkerId" = '${A.operator}'`)).rejects.toThrow(/confirms maintenance job .* once/)
    await expect(update(office(), job(), `"leadConfirmedById" = '${a.actorId}'`)).rejects.toThrow(/confirms maintenance job .* once|exactly one person/)
    // Back to work: the hand-back, its code, minutes and the confirmation are cleared together.
    await expect(update(floorAs(A.lead), job(), `status = 'IN_PROGRESS', "handedBackAt" = NULL, "handedBackByWorkerId" = NULL, "workDone" = NULL, "machineAfter" = NULL`)).rejects.toThrow(
      /only while HANDED_BACK or CLOSED/,
    )
    expect(
      await update(
        floorAs(A.lead),
        job(),
        `status = 'IN_PROGRESS', "handedBackAt" = NULL, "handedBackByWorkerId" = NULL, "workDone" = NULL, "machineAfter" = NULL, "failureCode" = NULL, "minutesSpent" = NULL, "leadConfirmedAt" = NULL, "leadConfirmedByWorkerId" = NULL`,
      ),
    ).toBe(1)
    await expect(update(floorAs(A.lead), job(), `"leadConfirmedAt" = now(), "leadConfirmedByWorkerId" = '${A.lead}'`)).rejects.toThrow(/while it is HANDED_BACK/)
    expect(
      await update(
        floorAs(A.lead),
        job(),
        `status = 'HANDED_BACK', "handedBackAt" = now(), "handedBackByWorkerId" = '${A.lead}', "workDone" = 'Replaced a part: new guard screws.', "machineAfter" = 'RUNNING', "failureCode" = 'WORN_PART', "minutesSpent" = 40`,
      ),
    ).toBe(1)
    await expect(update(office(), job(), `"leadConfirmedAt" = now(), "leadConfirmedById" = '${a.actorId}', "leadConfirmedByWorkerId" = '${A.lead}'`)).rejects.toThrow(/exactly one person/)
    expect(await update(office(), job(), `"leadConfirmedAt" = now(), "leadConfirmedById" = '${a.actorId}'`)).toBe(1)
    await expect(update(floorAs(A.lead), job(), `status = 'CLOSED', "closedAt" = now()`)).rejects.toThrow(/closing, cancelling and planning it are the office/)
    expect(await update(office(), job(), `status = 'CLOSED', "closedAt" = now(), "closedById" = '${a.actorId}'`)).toBe(1)
  })

  it('a job names a failed or remarked check of its own machine, on a STATUTORY_CHECK job, and keeps it', async () => {
    const make = (changes: Record<string, unknown>) => copyRow(office(), 'MaintenanceJob', seeded.jobIds.fromCheck, { id: randomUUID(), number: tag('T-MJ'), createdAt: now(), ...changes })
    await expect(make({ source: 'MANUAL' })).rejects.toThrow(/its source is STATUTORY_CHECK/)
    await expect(make({ checkResultId: seeded.resultIds.passed })).rejects.toThrow(/failed or remarked check of its own machine/)
    expect(await make({})).toBe(1)
    await expect(update(office(), seeded.jobIds.fromCheck, `"checkResultId" = NULL`)).rejects.toThrow(/that never changes/)
    await expect(update(floorAs(A.lead), plant.jobId, `"checkResultId" = '${seeded.resultIds.failed}'`)).rejects.toThrow(/the floor starts, pauses/)
  })
})

describe('what the floor adds to files (QHS-189), and a check report', () => {
  const file = (changes: Record<string, unknown>) =>
    insert(floorAs(A.lead), 'StoredFile', {
      id: randomUUID(),
      companyId: A.company,
      recordType: 'MaintenanceJob',
      recordId: plant.jobId,
      kind: 'PHOTO',
      originalName: 'after.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      sha256: 'b'.repeat(64),
      storeAccountId: A.store,
      storageKey: `t/${a.tenantId}/c/${A.company}/2026/${randomUUID()}`,
      visibility: ['OFFICE', 'FLOOR'],
      floorSiteId: A.site,
      ...changes,
    })

  it('the floor adds an announced photo or voice note of an open request or job of its site, nothing else, and confirms only those', async () => {
    await expect(file({ kind: 'DOCUMENT', contentType: 'application/pdf' })).rejects.toThrow(/only the photos and voice notes/)
    await expect(file({ recordType: 'WorkOrder', recordId: key('production:work-order:WO-0001') })).rejects.toThrow(/only the photos and voice notes/)
    await expect(file({ visibility: ['OFFICE'], floorSiteId: null })).rejects.toThrow(/row-level security/)
    await expect(file({ status: 'AVAILABLE', availableAt: now() })).rejects.toThrow(/announced first/)
    await expect(file({ createdById: a.actorId })).rejects.toThrow(/only the photos and voice notes/)
    await expect(file({ category: 'CHECK_REPORT' })).rejects.toThrow(/only the photos and voice notes/)
    await expect(file({})).resolves.toBe(1)
    await expect(file({ recordId: randomUUID() })).rejects.toThrow(/open maintenance request or job of this site/)
    await expect(file({ floorSiteId: A.siteB, companyId: A.companyB })).rejects.toThrow(/row-level security/)
    const voice = randomUUID()
    expect(await file({ id: voice, kind: 'AUDIO', contentType: 'audio/webm', recordType: 'MaintenanceRequest', recordId: seeded.requestId, category: 'AFTER_WORK' })).toBe(1)
    await expect(run(floorAs(A.lead), `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE']::"FileAudience"[], "floorSiteId" = NULL WHERE id = $1::uuid`, voice)).rejects.toThrow(
      /confirms the upload of its own photos and voice notes|row-level security/,
    )
    await expect(run(floorAs(A.lead), `UPDATE "StoredFile" SET "originalName" = 'x' WHERE id = $1::uuid`, voice)).rejects.toThrow(/confirms the upload/)
    await expect(run(floorAs(A.lead), `UPDATE "StoredFile" SET status = 'DELETED', "deletedAt" = now() WHERE id = $1::uuid`, voice)).rejects.toThrow(/confirms the upload/)
    expect(await run(floorAs(A.lead), `UPDATE "StoredFile" SET status = 'AVAILABLE', "availableAt" = now() WHERE id = $1::uuid`, voice)).toBe(1)
    // The bench photo of the site (another record type) is the office's.
    await expect(run(floorAs(A.lead), `UPDATE "StoredFile" SET "originalName" = 'x' WHERE id = $1::uuid`, key('files:floor:A1'))).rejects.toThrow(/confirms the upload/)
    // The office keeps its own rules: a document of the job.
    expect(await insert(office(), 'StoredFile', { id: randomUUID(), companyId: A.company, recordType: 'MaintenanceJob', recordId: plant.jobId, kind: 'DOCUMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1, sha256: 'c'.repeat(64), storeAccountId: A.store, storageKey: tag('k'), visibility: ['OFFICE'], status: 'AVAILABLE', availableAt: now() })).toBe(1)
    // A closed job takes no more floor files.
    await expect(file({ recordId: seeded.jobIds.cuttingTable, kind: 'PHOTO' })).rejects.toThrow(/open maintenance request or job/)
  })

  it('a check report is a document of its result’s company and site, and of a file of the result', async () => {
    const report = await value(`SELECT id FROM "StoredFile" WHERE "recordType" = 'MachineCheckResult' AND "recordId" = $1`, [seeded.resultIds.passed])
    const doc = (changes: Record<string, unknown>) =>
      insert(office(), 'GeneratedDocument', { id: randomUUID(), companyId: A.company, siteId: A.site, recordType: 'MachineCheckResult', recordId: seeded.resultIds.passed, kind: 'CHECK_REPORT', version: 1, fingerprint: 'd'.repeat(64), language: 'it', fileId: report, ...changes })
    await expect(doc({ siteId: null })).rejects.toThrow(/company and site of its MachineCheckResult/)
    await expect(doc({ kind: 'JOB_SHEET' })).rejects.toThrow(/a check report a MachineCheckResult/)
    expect(await doc({})).toBe(1)
  })
})
