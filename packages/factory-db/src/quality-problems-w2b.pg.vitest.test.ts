import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCapa, type CapaSeed } from '../seed/capa'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedQuality, type QualitySeed } from '../seed/quality'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The quality problems schema (W2b schema wave 11/16, B-W2b-79, …_quality_problems_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - grants: the office only, but the floor reads the cause codes; the partner reads nothing here;
 *   - CAPA and 8D: stages by type, a close that needs its actions done, frozen once ended; the team's shape;
 *   - sources: what they may be, of the company, kept while an NCR names the CAPA; actions: evidence, reminders, escalation;
 *   - cause codes on defects and NCRs; an NCR's CAPA, given once after DECIDED, even on a CLOSED NCR;
 *   - a defect charged to an operation of its own work order;
 *   - NCR cost lines and concessions; hold groups and a hold's group; a hold's lane on the board, the office's only;
 *   - the result and four-eyes settings, and the release that reads them; alert rules;
 *   - the complaint's investigation and letter; generated documents of the new kinds, some with no site;
 *   - CAPA is a number kind with a seeded series.
 * The refusals are check_violation (SQLSTATE 23514), but the number's; their messages are read through raw SQL.
 */

const NS = 'w2b-79-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let capa: CapaSeed
let quality: QualitySeed
let production: ProductionSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1'), customer: key('party:P1'), supplier: key('party:P2') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: capa.inspectorId, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: A.customer })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const SHA = 'a'.repeat(64)

/** A fresh CAPA at PLAN, or an 8D at D1, with no source or action. */
async function newCapa(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'Capa', capa.capaId, { id, number: `T-CAPA-${id.slice(0, 8)}`, ...changes })
  return id
}
async function newAction(capaId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'CapaAction', capa.actionIds[0], { id, capaId, seq: Math.floor(Math.random() * 1_000_000) + 10, ...changes })
  return id
}
const setCapa = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "Capa" SET ${set} WHERE id = $1::uuid`, id, ...values)
const setAction = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "CapaAction" SET ${set} WHERE id = $1::uuid`, id, ...values)
const closeWords = (actor: string) => `"closedAt" = now(), "closedById" = '${actor}'::uuid, "closeNote" = 'Done.'`
const finishAction = (id: string) => setAction(id, `status = 'DONE', "doneAt" = now(), "doneById" = '${a.actorId}'::uuid, "evidenceNote" = 'Checked.'`)

/** A fresh OPEN NCR, a copy of SEED-NCR-0001 with no CAPA. */
async function newNcr(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'Nonconformance', capa.openNcrId, { id, number: `T-NCR-${id.slice(0, 8)}`, ...changes })
  return id
}
const setNcr = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "Nonconformance" SET ${set} WHERE id = $1::uuid`, id, ...values)
const addSource = async (capaId: string, recordId: string, recordType = 'Nonconformance'): Promise<string> => {
  const id = randomUUID()
  await copyRow(office(), 'CapaSource', capa.sourceId, { id, capaId, recordType, recordId })
  return id
}
const stageNcr = (id: string, stage: string) =>
  force(
    `UPDATE "Nonconformance" SET stage = $2::"NcrStage", "containedAt" = now(), "decidedAt" = CASE WHEN $2 IN ('DECIDED', 'CLOSED') THEN now() END,
       "closedAt" = CASE WHEN $2 = 'CLOSED' THEN now() END, "closedById" = CASE WHEN $2 = 'CLOSED' THEN $3::uuid END, "closeSignatureSha256" = CASE WHEN $2 = 'CLOSED' THEN $4 END,
       "cancelledAt" = CASE WHEN $2 = 'CANCELLED' THEN now() END, "cancelReason" = CASE WHEN $2 = 'CANCELLED' THEN 'By mistake' END
     WHERE id = $1`,
    [id, stage, a.actorId, SHA],
  )

/** A row of StoredFile of a record (no object in any store). */
async function fileOf(recordType: string, recordId: string): Promise<string> {
  const id = randomUUID()
  const [row] = await admin(`SELECT "fileId"::text AS id FROM "GeneratedDocument" WHERE id = $1`, [capa.reportDocumentId])
  await copyRow(office(), 'StoredFile', String(row?.id), { id, recordType, recordId, storageKey: `t/${a.tenantId}/c/${A.company}/2026/${id}` })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('qualityproblemsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  capa = await seedCapa({ db: factory, namespace: NS })
  quality = await seedQuality({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  // It waits its turn at the migrations' server-wide lock, then runs nearly every seed: minutes when other runs share the server.
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

const NEW_MODELS = ['Capa', 'CapaAction', 'CapaSource', 'CauseCode', 'NcrConcession', 'NcrCostLine', 'QualityAlertRule', 'QualityHoldGroup']

describe('grants', () => {
  it('classifies the eight models, none with a partner grant, none holding personal data', () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => NEW_MODELS.includes(model.name))
    expect(models.map(({ model }) => model.name).sort()).toEqual(NEW_MODELS)
    for (const { ownership } of models) expect(Object.keys(ownership.access)).not.toContain('factory_partner_runtime')
    expect(personalDataOf(loadSchema(), loadOwnership()).filter((entry) => NEW_MODELS.includes(entry.table))).toEqual([])
  })

  it('the floor reads the cause codes and its settings, never writes them, and sees nothing else of it', async () => {
    expect((await sql(floor(), 'SELECT id FROM "CauseCode"')).length).toBe(8)
    await expect(run(floor(), `UPDATE "CauseCode" SET "labelEn" = 'x'`)).rejects.toThrow(/permission denied/)
    expect(await sql(floor(), `SELECT "stopAtRejectNumber", "benchUndoSeconds" FROM "QualitySettings" WHERE id = $1::uuid`, a.tenantId)).toEqual([{ stopAtRejectNumber: false, benchUndoSeconds: 10 }])
    for (const table of NEW_MODELS.filter((name) => name !== 'CauseCode')) await expect(sql(floor(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
  })

  it('portal and link sessions read nothing here', async () => {
    for (const table of NEW_MODELS) await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
  })

  it('the cost line is at the cost grain', () => {
    const line = loadSchema().find((model) => model.name === 'NcrCostLine')
    expect(line?.fields.find((field) => field.column === 'amount')?.tags).toContain('@grain cost')
  })

  it('refuses TRUNCATE on every new table', async () => {
    for (const table of NEW_MODELS) await expect(admin(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/refused/)
  })
})

describe('CAPA and 8D (QHS-093)', () => {
  it('the seed tells its story', async () => {
    expect(await admin(`SELECT number, type::text AS type, status::text AS status FROM "Capa" WHERE "tenantId" = $1 ORDER BY 1`, [a.tenantId])).toEqual([
      { number: 'SEED-8D-0001', type: 'EIGHT_D', status: 'D3' },
      { number: 'SEED-CAPA-0001', type: 'CAPA', status: 'PLAN' },
    ])
    expect(await admin(`SELECT "capaId"::text AS capa, "causeCodeId" IS NOT NULL AS cause FROM "Nonconformance" WHERE id = $1`, [capa.ncrId])).toEqual([{ capa: capa.capaId, cause: true }])
  })

  it('starts at the first stage of its type, numbered, and its number, type and company never change', async () => {
    await expect(newCapa({ status: 'ACT' })).rejects.toThrow(/starts at PLAN/)
    await expect(newCapa({ type: 'EIGHT_D' })).rejects.toThrow(/starts at D1/)
    await expect(newCapa({ number: ' ' })).rejects.toThrow(/has its number/)
    const id = await newCapa()
    await expect(setCapa(id, `number = 'X'`)).rejects.toThrow(/never changes/)
    await expect(setCapa(id, `"companyId" = $2::uuid`, A.companyB)).rejects.toThrow(/never change/)
    await expect(setCapa(id, `type = 'EIGHT_D', status = 'D1'`)).rejects.toThrow(/never change/)
  })

  it('moves inside its own stages, either way, and closes only from the last with its actions done', async () => {
    const id = await newCapa()
    await expect(setCapa(id, `status = 'D2'`)).rejects.toThrow(/cannot move from PLAN to D2/)
    await expect(setCapa(id, `status = 'CLOSED', ${closeWords(a.actorId)}`)).rejects.toThrow(/cannot move from PLAN to CLOSED/)
    expect(await setCapa(id, `status = 'ACT'`)).toBe(1)
    expect(await setCapa(id, `status = 'PLAN'`)).toBe(1)
    expect(await setCapa(id, `status = 'CHECK'`)).toBe(1)
    await expect(setCapa(id, `status = 'CLOSED', ${closeWords(a.actorId)}`)).rejects.toThrow(/closes once its actions are done \(0 action/)
    const open = await newAction(id)
    await expect(setCapa(id, `status = 'CLOSED', ${closeWords(a.actorId)}`)).rejects.toThrow(/1 open, 0 done/)
    await finishAction(open)
    await expect(setCapa(id, `status = 'CLOSED'`)).rejects.toThrow(/wrong ending/)
    expect(await setCapa(id, `status = 'CLOSED', ${closeWords(a.actorId)}`)).toBe(1)
    await expect(setCapa(id, `title = 'x'`)).rejects.toThrow(/it never changes/)
    await expect(setCapa(id, `status = 'CHECK'`)).rejects.toThrow(/it never changes/)
    await expect(newAction(id)).rejects.toThrow(/CAPA .* is CLOSED; its actions never change/)
    await expect(addSource(id, capa.openNcrId)).rejects.toThrow(/is CLOSED; its sources never change/)
  })

  it('an 8D closes from D8; a cancelled action does not count as done; cancelled from any stage, with why', async () => {
    const id = await newCapa({ type: 'EIGHT_D', status: 'D1' })
    await expect(setCapa(id, `status = 'PLAN'`)).rejects.toThrow(/cannot move from D1 to PLAN/)
    await setCapa(id, `status = 'D8'`)
    const action = await newAction(id)
    await setAction(action, `status = 'CANCELLED', "cancelReason" = 'Not needed'`)
    await expect(setCapa(id, `status = 'CLOSED', ${closeWords(a.actorId)}`)).rejects.toThrow(/0 open, 0 done/)
    await expect(setCapa(id, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/wrong ending/)
    expect(await setCapa(id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'By mistake'`)).toBe(1)
    await expect(setCapa(id, `"cancelReason" = 'Other'`)).rejects.toThrow(/it never changes/)
  })

  it('checks the team, the words and the customer, and is never deleted', async () => {
    const id = await newCapa()
    const person = randomUUID()
    expect(await setCapa(id, `team = $2::jsonb`, JSON.stringify([{ userId: person, role: 'Lead' }]))).toBe(1)
    for (const team of [{}, [{ userId: person }], [{ userId: 'x', role: 'Lead' }], [{ userId: person, role: 'A' }, { userId: person, role: 'B' }]]) {
      await expect(setCapa(id, `team = $2::jsonb`, JSON.stringify(team))).rejects.toThrow(/list of \{ "userId", "role" \}, each person once/)
    }
    await expect(setCapa(id, `"problemWhat" = ' '`)).rejects.toThrow(/not blank when given/)
    await expect(setCapa(id, `title = ' '`)).rejects.toThrow(/has a title/)
    await expect(setCapa(id, `"customerId" = $2::uuid`, A.supplier)).rejects.toThrow(/no customer or brand/)
    expect(await setCapa(id, `"customerId" = $2::uuid`, A.customer)).toBe(1)
    await expect(admin(`DELETE FROM "Capa" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })
})

describe('sources (QHS-087)', () => {
  it('are an NCR, a complaint or an audit, of the company', async () => {
    const id = await newCapa()
    await expect(addSource(id, randomUUID(), 'WorkOrder')).rejects.toThrow(/is an NCR \(Nonconformance\), a Complaint or an Audit/)
    expect(await addSource(id, capa.complaintId, 'Complaint')).toBeTruthy()
    expect(await addSource(id, randomUUID(), 'Audit')).toBeTruthy()
    await expect(addSource(id, randomUUID())).rejects.toThrow(/of the CAPA's company/)
    const other = await newCapa({ companyId: A.companyB })
    await expect(addSource(other, capa.openNcrId)).rejects.toThrow(/of the CAPA's company/)
    await expect(addSource(other, capa.complaintId, 'Complaint')).rejects.toThrow(/of the CAPA's company/)
  })

  it('are never changed, and stay while the NCR names the CAPA', async () => {
    const id = await newCapa()
    const ncr = await newNcr()
    const source = await addSource(id, ncr)
    await expect(admin(`UPDATE "CapaSource" SET note = 'x' WHERE id = $1`, [source])).rejects.toThrow(/never changed/)
    await setNcr(ncr, `"capaId" = $2::uuid`, id)
    await expect(run(office(), `DELETE FROM "CapaSource" WHERE id = $1::uuid`, source)).rejects.toThrow(/still names CAPA/)
    await setNcr(ncr, `"capaId" = NULL`)
    expect(await run(office(), `DELETE FROM "CapaSource" WHERE id = $1::uuid`, source)).toBe(1)
  })
})

describe('actions (QHS-096)', () => {
  it('start OPEN and say what to do; only the status moves on, once', async () => {
    const id = await newCapa()
    await expect(newAction(id, { status: 'DONE' })).rejects.toThrow(/starts OPEN/)
    await expect(newAction(id, { remindersSent: 1 })).rejects.toThrow(/starts OPEN/)
    await expect(newAction(id, { description: ' ' })).rejects.toThrow(/says what to do/)
    const action = await newAction(id)
    await expect(setAction(action, `seq = 999999999`)).rejects.toThrow(/never moves/)
    await expect(setAction(action, `"capaId" = $2::uuid`, capa.eightDId)).rejects.toThrow(/never moves/)
    await setAction(action, `status = 'CANCELLED', "cancelReason" = 'Not needed'`)
    await expect(setAction(action, `description = 'x'`)).rejects.toThrow(/it never changes/)
    await expect(admin(`DELETE FROM "CapaAction" WHERE id = $1`, [action])).rejects.toThrow(/never deleted/)
  })

  it('are done with evidence: a note or a file of the action', async () => {
    const action = await newAction(await newCapa())
    const done = `status = 'DONE', "doneAt" = now(), "doneById" = '${a.actorId}'::uuid`
    await expect(setAction(action, done)).rejects.toThrow(/with its evidence/)
    await expect(setAction(action, `status = 'DONE', "evidenceNote" = 'x'`)).rejects.toThrow(/wrong ending/)
    await fileOf('CapaAction', action)
    expect(await setAction(action, done)).toBe(1)
  })

  it('count their reminders up and escalate once', async () => {
    const action = await newAction(await newCapa())
    await expect(setAction(action, `"remindersSent" = 1`)).rejects.toThrow(/each with a later time/)
    expect(await setAction(action, `"remindersSent" = 1, "lastRemindedAt" = now()`)).toBe(1)
    await expect(setAction(action, `"remindersSent" = 0, "lastRemindedAt" = NULL`)).rejects.toThrow(/only count up/)
    await expect(setAction(action, `"remindersSent" = 2, "lastRemindedAt" = now() - interval '1 day'`)).rejects.toThrow(/only count up/)
    expect(await setAction(action, `"remindersSent" = 2, "lastRemindedAt" = now() + interval '1 day'`)).toBe(1)
    expect(await setAction(action, `"escalatedAt" = now()`)).toBe(1)
    await expect(setAction(action, `"escalatedAt" = now() + interval '1 day'`)).rejects.toThrow(/escalated once/)
  })
})

describe('cause codes (QHS-004)', () => {
  it('keep their code and process, words in every floor language', async () => {
    const [cause] = Object.values(capa.causeCodeIds) as [string]
    await expect(run(office(), `UPDATE "CauseCode" SET code = 'X' WHERE id = $1::uuid`, cause)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "CauseCode" SET process = 'DESIGN' WHERE id = $1::uuid`, capa.causeCodeIds['SUP-SPEC'])).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "CauseCode" SET "labelI18n" = '{"ro": " "}' WHERE id = $1::uuid`, cause)).rejects.toThrow(/other languages/)
    await expect(copyRow(office(), 'CauseCode', cause, { id: randomUUID(), code: 'WITH SPACE' })).rejects.toThrow(/without spaces/)
  })

  it('are retired, leave what names them, and only a code nothing names is deleted', async () => {
    const id = randomUUID()
    await copyRow(office(), 'CauseCode', capa.causeCodeIds['MAT-FAULT'] as string, { id, code: `T-${id.slice(0, 8)}`, process: 'HANDLING' })
    await run(office(), `UPDATE "CauseCode" SET active = false WHERE id = $1::uuid`, id)
    await expect(run(office(), `UPDATE "InspectionDefect" SET "causeCodeId" = $2::uuid WHERE id = $1::uuid`, capa.openDefectId, id)).rejects.toThrow(/retired cause code/)
    await expect(setNcr(capa.openNcrId, `"causeCodeId" = $2::uuid`, id)).rejects.toThrow(/retired cause code/)
    await expect(run(office(), `DELETE FROM "CauseCode" WHERE id = $1::uuid`, capa.causeCodeIds['MAT-FAULT'])).rejects.toThrow(/foreign key/i)
    expect(await run(office(), `DELETE FROM "CauseCode" WHERE id = $1::uuid`, id)).toBe(1)
    // A code retired after it was named stays on the record, which still changes.
    await run(office(), `UPDATE "CauseCode" SET active = false WHERE id = $1::uuid`, capa.causeCodeIds['SEW-ERROR'])
    expect(await run(office(), `UPDATE "InspectionDefect" SET note = 'Seen again' WHERE id = $1::uuid`, capa.openDefectId)).toBe(1)
    await run(office(), `UPDATE "CauseCode" SET active = true WHERE id = $1::uuid`, capa.causeCodeIds['SEW-ERROR'])
  })

  it('a cause is part of the problem: read-only once the NCR is DECIDED', async () => {
    const ncr = await newNcr()
    expect(await setNcr(ncr, `"causeCodeId" = $2::uuid`, capa.causeCodeIds['DESIGN'])).toBe(1)
    await stageNcr(ncr, 'DECIDED')
    await expect(setNcr(ncr, `"causeCodeId" = $2::uuid`, capa.causeCodeIds['MEASURE'])).rejects.toThrow(/read-only now/)
  })
})

describe("an NCR's CAPA (QHS-087)", () => {
  it('needs the source first and a CAPA of the company', async () => {
    const id = await newCapa()
    const ncr = await newNcr()
    await expect(setNcr(ncr, `"capaId" = $2::uuid`, id)).rejects.toThrow(/does not list it as a source/)
    await addSource(id, ncr)
    expect(await setNcr(ncr, `"capaId" = $2::uuid`, id)).toBe(1)
    const other = await newCapa({ companyId: A.companyB })
    await expect(setNcr(ncr, `"capaId" = $2::uuid`, other)).rejects.toThrow(/does not list it|foreign key/i)
    await force(`INSERT INTO "CapaSource" (id, "tenantId", "capaId", "recordType", "recordId") VALUES ($1, $2, $3, 'Nonconformance', $4)`, [randomUUID(), a.tenantId, other, ncr])
    await expect(setNcr(ncr, `"capaId" = $2::uuid`, other)).rejects.toThrow(/foreign key/i)
  })

  it('once DECIDED it is given once and stays', async () => {
    const [first, second] = [await newCapa(), await newCapa()]
    const ncr = await newNcr()
    await addSource(first, ncr)
    await addSource(second, ncr)
    await stageNcr(ncr, 'DECIDED')
    expect(await setNcr(ncr, `"capaId" = $2::uuid`, first)).toBe(1)
    await expect(setNcr(ncr, `"capaId" = $2::uuid`, second)).rejects.toThrow(/DECIDED; the CAPA it was escalated to stays/)
    await expect(setNcr(ncr, `"capaId" = NULL`)).rejects.toThrow(/stays/)
  })

  it('a CLOSED NCR takes its CAPA once, with its version, and nothing else; a CANCELLED one none', async () => {
    const id = await newCapa()
    const ncr = await newNcr()
    await addSource(id, ncr)
    await stageNcr(ncr, 'CLOSED')
    await expect(setNcr(ncr, `version = version + 1`)).rejects.toThrow(/it never changes/)
    await expect(setNcr(ncr, `"capaId" = $2::uuid, title = 'x'`, id)).rejects.toThrow(/it never changes/)
    expect(await setNcr(ncr, `"capaId" = $2::uuid, version = version + 1, "updatedAt" = now()`, id)).toBe(1)
    await expect(setNcr(ncr, `"capaId" = NULL`)).rejects.toThrow(/it never changes/)

    const cancelled = await newNcr()
    await addSource(id, cancelled)
    await stageNcr(cancelled, 'CANCELLED')
    await expect(setNcr(cancelled, `"capaId" = $2::uuid`, id)).rejects.toThrow(/it never changes/)
  })
})

describe('a defect charged to its operation (MES-127)', () => {
  const line = async (changes: Record<string, unknown>) => {
    const [row] = await admin(`SELECT id::text AS id FROM "OperationScanDefect" WHERE "tenantId" = $1 AND "scanId" IS NOT NULL ORDER BY id LIMIT 1`, [a.tenantId])
    return copyRow(floor(), 'OperationScanDefect', String(row?.id), { id: randomUUID(), ...changes })
  }
  const elsewhere = async (): Promise<string> => {
    const [row] = await admin(`SELECT id::text AS id FROM "WorkOrderOperation" WHERE "tenantId" = $1 AND "siteId" = $2 AND "workOrderId" <> $3 ORDER BY id LIMIT 1`, [a.tenantId, A.site, production.workOrderId])
    expect(row, 'an operation of another work order of the site').toBeDefined()
    return String(row?.id)
  }

  it('names an operation of the same work order, from the floor; nothing is required', async () => {
    expect(await line({ causedAtOperationId: production.operationIds.cut })).toBe(1)
    expect(await line({})).toBe(1)
    await expect(line({ causedAtOperationId: await elsewhere() })).rejects.toThrow(/operation of another work order/)
  })

  it('a correction request charges within its own work order too', async () => {
    const [row] = await admin(`SELECT id::text AS id FROM "OperationScanDefect" WHERE "correctionRequestId" = $1 LIMIT 1`, [production.correctionRequestId])
    await expect(copyRow(floor(), 'OperationScanDefect', String(row?.id), { id: randomUUID(), causedAtOperationId: await elsewhere() })).rejects.toThrow(/another work order/)
    expect(await copyRow(floor(), 'OperationScanDefect', String(row?.id), { id: randomUUID(), causedAtOperationId: production.operationIds.cut })).toBe(1)
  })

  it('stays append-only', async () => {
    await expect(admin(`UPDATE "OperationScanDefect" SET "causedAtOperationId" = NULL WHERE "tenantId" = $1`, [a.tenantId])).rejects.toThrow(/append-only/)
  })
})

describe('NCR cost lines (QHS-086)', () => {
  const add = (ncrId: string, changes: Record<string, unknown>) => copyRow(office(), 'NcrCostLine', capa.costLineId, { id: randomUUID(), ncrId, seq: Math.floor(Math.random() * 1_000_000) + 10, ...changes })

  it('an amount from 0, words for OTHER, a record exactly on a computed line', async () => {
    const ncr = await newNcr()
    await expect(add(ncr, { amount: -1 })).rejects.toThrow(/amount from 0/)
    await expect(add(ncr, { kind: 'OTHER', description: null })).rejects.toThrow(/says what it is/)
    await expect(add(ncr, { description: ' ' })).rejects.toThrow(/not blank/)
    await expect(add(ncr, { source: 'COMPUTED' })).rejects.toThrow(/a computed line names its record/)
    await expect(add(ncr, { recordType: 'StockMove', recordId: randomUUID() })).rejects.toThrow(/a typed line none/)
    await expect(add(ncr, { source: 'COMPUTED', recordType: 'Stock Move', recordId: randomUUID() })).rejects.toThrow(/without spaces/)
    expect(await add(ncr, { amount: 0 })).toBe(1)
    expect(await add(ncr, { source: 'COMPUTED', recordType: 'StockMove', recordId: randomUUID() })).toBe(1)
  })

  it('keep their NCR, number and source, and change until the NCR is CLOSED or CANCELLED', async () => {
    const ncr = await newNcr()
    const id = randomUUID()
    await add(ncr, { id })
    const set = (text: string, ...values: unknown[]) => run(office(), `UPDATE "NcrCostLine" SET ${text} WHERE id = $1::uuid`, id, ...values)
    await expect(set(`seq = 999999999`)).rejects.toThrow(/never moves/)
    await expect(set(`source = 'COMPUTED', "recordType" = 'StockMove', "recordId" = $2::uuid`, randomUUID())).rejects.toThrow(/never moves/)
    expect(await set(`amount = 7`)).toBe(1)
    await stageNcr(ncr, 'CLOSED')
    await expect(set(`amount = 8`)).rejects.toThrow(/its cost lines never change/)
    await expect(add(ncr, {})).rejects.toThrow(/its cost lines never change/)
    await expect(run(office(), `DELETE FROM "NcrCostLine" WHERE id = $1::uuid`, id)).rejects.toThrow(/its cost lines never change/)
  })

  it('are removed while the NCR is open', async () => {
    const ncr = await newNcr()
    const id = randomUUID()
    await add(ncr, { id })
    expect(await run(office(), `DELETE FROM "NcrCostLine" WHERE id = $1::uuid`, id)).toBe(1)
  })
})

describe('concessions (QHS-085)', () => {
  const ask = async (ncrId: string, changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    await copyRow(office(), 'NcrConcession', capa.concessionId, { id, ncrId, seq: Math.floor(Math.random() * 1_000_000) + 10, ...changes })
    return id
  }
  const set = (id: string, text: string, ...values: unknown[]) => run(office(), `UPDATE "NcrConcession" SET ${text} WHERE id = $1::uuid`, id, ...values)
  const answered = `"answeredAt" = now(), "answeredBy" = 'Seed Buyer'`

  it('start ASKED, of a customer or a brand, in words, while the NCR is open', async () => {
    const ncr = await newNcr()
    await expect(ask(ncr, { status: 'ACCEPTED' })).rejects.toThrow(/starts ASKED/)
    await expect(ask(ncr, { ask: ' ' })).rejects.toThrow(/in words/)
    await expect(ask(ncr, { partyId: A.supplier })).rejects.toThrow(/no customer or brand/)
    await stageNcr(ncr, 'CLOSED')
    await expect(ask(ncr)).rejects.toThrow(/no concession is asked any more/)
  })

  it('are answered once: when, by whom, why when refused; and the answer may come after the NCR closed', async () => {
    const ncr = await newNcr()
    const id = await ask(ncr)
    await expect(set(id, `"answer" = 'Maybe'`)).rejects.toThrow(/wrong answer/)
    await expect(set(id, `status = 'ACCEPTED'`)).rejects.toThrow(/wrong answer/)
    await expect(set(id, `status = 'REFUSED', ${answered}`)).rejects.toThrow(/wrong answer/)
    await stageNcr(ncr, 'CLOSED')
    expect(await set(id, `status = 'REFUSED', answer = 'No, send it back', ${answered}, "recordedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(set(id, `status = 'ACCEPTED'`)).rejects.toThrow(/an answered concession never changes/)
    await expect(set(id, `proposal = 'x'`)).rejects.toThrow(/an answered concession never changes/)
    await expect(admin(`DELETE FROM "NcrConcession" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })

  it('keep their customer and asking, and the written answer is a file of the row', async () => {
    const id = await ask(await newNcr())
    await expect(set(id, `"partyId" = $2::uuid`, key('party:P3'))).rejects.toThrow(/never change/)
    await expect(set(id, `"askedAt" = now()`)).rejects.toThrow(/never change/)
    expect(await set(id, `proposal = 'A better offer'`)).toBe(1)
    const wrong = await fileOf('Nonconformance', capa.ncrId)
    await expect(set(id, `status = 'ACCEPTED', ${answered}, "answerFileId" = $2::uuid`, wrong)).rejects.toThrow(/a file of the concession/)
    expect(await set(id, `status = 'ACCEPTED', ${answered}, "answerFileId" = $2::uuid`, await fileOf('NcrConcession', id))).toBe(1)
  })
})

describe('hold groups (QHS-075)', () => {
  const setGroup = (text: string, ...values: unknown[]) => run(office(), `UPDATE "QualityHoldGroup" SET ${text} WHERE id = $1::uuid`, capa.holdGroupId, ...values)
  const newHold = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    await copyRow(office(), 'QualityHold', capa.holdId, { id, number: `T-HLD-${id.slice(0, 8)}`, groupId: null, ncrId: null, placedByWorkerId: null, placedById: a.actorId, ...changes })
    return id
  }

  it('only the counts change, whole numbers from 0', async () => {
    expect(await setGroup(`counts = '{"WorkOrder": 4, "garments": 126}', version = version + 1, "updatedAt" = now()`)).toBe(1)
    for (const counts of ['[]', '{"garments": -1}', '{"garments": 1.5}', '{"garments": "many"}']) await expect(setGroup(`counts = $2::jsonb`, counts)).rejects.toThrow(/whole number from 0/)
    await expect(setGroup(`"reasonNote" = 'x'`)).rejects.toThrow(/only the counts change/)
    await expect(setGroup(`"sourceId" = $2::uuid`, randomUUID())).rejects.toThrow(/only the counts change/)
    await expect(admin(`DELETE FROM "QualityHoldGroup" WHERE id = $1`, [capa.holdGroupId])).rejects.toThrow(/never deleted/)
    const id = randomUUID()
    await expect(copyRow(office(), 'QualityHoldGroup', capa.holdGroupId, { id, reasonCode: 'WITH SPACE' })).rejects.toThrow(/without spaces/)
  })

  it('a hold takes its group once, of its company; a released hold takes none; the floor changes none', async () => {
    const id = randomUUID()
    await copyRow(office(), 'QualityHoldGroup', capa.holdGroupId, { id })
    const hold = await newHold({ groupId: capa.holdGroupId })
    expect(await admin(`SELECT "groupId"::text AS g FROM "QualityHold" WHERE id = $1`, [hold])).toEqual([{ g: capa.holdGroupId }])
    const set = (target: string, value: string | null) => run(office(), `UPDATE "QualityHold" SET "groupId" = $2::uuid WHERE id = $1::uuid`, target, value)
    await expect(set(hold, id)).rejects.toThrow(/its group is given once/)
    await expect(set(hold, null)).rejects.toThrow(/its group is given once/)
    const later = await newHold()
    await expect(run(floor(), `UPDATE "QualityHold" SET "groupId" = $2::uuid WHERE id = $1::uuid`, later, id)).rejects.toThrow(/the floor confirms the quarantine move/)
    expect(await set(later, id)).toBe(1)
    const other = randomUUID()
    await copyRow(office(), 'QualityHoldGroup', capa.holdGroupId, { id: other, companyId: A.companyB })
    await expect(set(await newHold(), other)).rejects.toThrow(/foreign key/i)
    const released = await newHold()
    await run(office(), `UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid, "releaseSignatureSha256" = $3, "notMakerStatement" = true WHERE id = $1::uuid`, released, a.actorId, SHA)
    await expect(set(released, id)).rejects.toThrow(/a released or closed hold never changes/)
  })
})

describe("a hold's lane on the hold board (QHS-077)", () => {
  const newHold = async (): Promise<string> => {
    const id = randomUUID()
    await copyRow(office(), 'QualityHold', capa.holdId, { id, number: `T-HLD-${id.slice(0, 8)}`, groupId: null, ncrId: null, placedByWorkerId: null, placedById: a.actorId, nextStep: 'NEW' })
    return id
  }

  it('starts NEW, the seeded hold too, and is hidden from the floor and the partner', async () => {
    expect(await admin(`SELECT "nextStep"::text AS lane FROM "QualityHold" WHERE id = $1`, [capa.holdId])).toEqual([{ lane: 'NEW' }])
    const holds = classifiedModels(loadSchema(), loadOwnership()).find(({ model }) => model.name === 'QualityHold')
    expect(holds?.ownership.access['factory_floor_runtime']?.hiddenColumns).toEqual(['nextStep'])
    expect(holds?.ownership.access['factory_partner_runtime']).toBeUndefined()
  })

  it('the office moves it while the hold is ACTIVE; a released hold keeps its lane', async () => {
    const id = await newHold()
    const set = (lane: string) => run(office(), `UPDATE "QualityHold" SET "nextStep" = $2::"HoldNextStep", version = version + 1 WHERE id = $1::uuid`, id, lane)
    for (const lane of ['INVESTIGATING', 'WAITING_DECISION', 'READY_TO_RELEASE', 'NEW']) expect(await set(lane)).toBe(1)
    await expect(set('ACTIVE')).rejects.toThrow(/invalid input value for enum/)
    await set('READY_TO_RELEASE')
    await run(office(), `UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid, "releaseSignatureSha256" = $3, "notMakerStatement" = true WHERE id = $1::uuid`, id, a.actorId, SHA)
    await expect(set('INVESTIGATING')).rejects.toThrow(/a released or closed hold never changes/)
  })

  it('the floor neither reads nor writes it, and still places, reads and moves its holds', async () => {
    await expect(sql(floor(), `SELECT "nextStep" FROM "QualityHold"`)).rejects.toThrow(/permission denied/)
    await expect(run(floor(), `UPDATE "QualityHold" SET "nextStep" = 'INVESTIGATING' WHERE id = $1::uuid`, capa.holdId)).rejects.toThrow(/permission denied/)
    await expect(as(floor(), (client) => client.qualityHold.findMany())).rejects.toThrow(/permission denied/)
    expect((await sql(floor(), `SELECT id FROM "QualityHold"`)).length).toBeGreaterThan(0)
    // A hold placed at the bench names no lane and starts NEW.
    const id = randomUUID()
    const columns = '"id", "number", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "placedAt", "placedByWorkerId"'
    const [seeded] = await admin(`SELECT "subjectIds"::text[] AS subjects, "placedByWorkerId"::text AS worker FROM "QualityHold" WHERE id = $1`, [capa.holdId])
    expect(
      await run(
        { audience: 'floor', tenantId: a.tenantId, actorId: String(seeded?.worker), siteId: A.site },
        `INSERT INTO "QualityHold" (${columns}) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'Hide', $5::uuid[], 'QUALITY_CHECK', now(), $6::uuid)`,
        id,
        `T-HLD-${id.slice(0, 8)}`,
        A.company,
        A.site,
        seeded?.subjects,
        seeded?.worker,
      ),
    ).toBe(1)
    expect(await admin(`SELECT "nextStep"::text AS lane FROM "QualityHold" WHERE id = $1`, [id])).toEqual([{ lane: 'NEW' }])
  })
})

describe('the settings (QHS-023, QHS-300)', () => {
  const set = (text: string, ...values: unknown[]) => run(office(), `UPDATE "QualitySettings" SET ${text} WHERE id = $1::uuid`, a.tenantId, ...values)

  it('the undo window is 0 to 300 seconds; the list names OVERRIDE and CUSTOMER at most once, never ALWAYS', async () => {
    for (const seconds of [-1, 301]) await expect(set(`"benchUndoSeconds" = $2::int`, seconds)).rejects.toThrow(/0 to 300 seconds/)
    expect(await set(`"benchUndoSeconds" = 0`)).toBe(1)
    expect(await set(`"benchUndoSeconds" = 10`)).toBe(1)
    await expect(set(`"fourEyesConditions" = '{ALWAYS}'`)).rejects.toThrow(/at most once each/)
    await expect(set(`"fourEyesConditions" = '{OVERRIDE,OVERRIDE}'`)).rejects.toThrow(/at most once each/)
    await expect(set(`"fourEyesConditions" = NULL`)).rejects.toThrow(/at most once each/)
    await expect(set(`"fourEyesConditions" = '{OVERRIDE,NULL}'`)).rejects.toThrow(/at most once each/)
    expect(await admin(`SELECT "fourEyesConditions"::text AS list FROM "QualitySettings" WHERE id = $1`, [a.tenantId])).toEqual([{ list: '{OVERRIDE,CUSTOMER}' }])
  })

  it('a release reads the list: both by default, a company adds to the tenant-wide list, and an empty list asks no second person', async () => {
    const cell = quality.production.cellIds['BLK-54']
    const row = () => ({
      id: randomUUID(),
      number: `T-REL-${randomUUID()}`,
      companyId: A.company,
      siteId: A.site,
      workOrderId: production.workOrderId,
      workOrderSizeId: cell,
      inspectionId: capa.passedInspectionId,
      quantity: 1,
      certificateIds: [quality.certificateId],
      releasedByWorkerId: capa.inspectorId,
      releasedAt: new Date().toISOString(),
      signatureSha256: SHA,
    })
    const release = (values: Record<string, unknown>) => {
      const columns = Object.keys(values).map((column) => `"${column}"`).join(', ')
      return run(floor(), `INSERT INTO "QualityRelease" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"QualityRelease", $1::jsonb)`, JSON.stringify(values))
    }
    await force(`UPDATE "Inspection" SET "overrideReason" = 'Accepted by counts' WHERE id = $1`, [capa.passedInspectionId])
    // By default an inspector does not release their own overridden result.
    await expect(release(row())).rejects.toThrow(/needs a second person \(OVERRIDE\)/)
    // The tenant-wide list without it, a company's list with it: it adds.
    await set(`"fourEyesConditions" = '{CUSTOMER}'`)
    await copyRow(office(), 'QualitySettings', a.tenantId, { id: A.company, companyId: A.company, fourEyesConditions: ['OVERRIDE'] })
    await expect(release(row())).rejects.toThrow(/needs a second person \(OVERRIDE\)/)
    await run(office(), `UPDATE "QualitySettings" SET "fourEyesConditions" = '{}' WHERE id = $1::uuid`, A.company)
    // A listed customer, while the list names CUSTOMER.
    await force(`UPDATE "WorkOrderSize" SET "partyId" = $2 WHERE id = $1`, [cell, A.customer])
    await set(`"secondPersonPartyIds" = ARRAY[$2::uuid]`, A.customer)
    await expect(release(row())).rejects.toThrow(/needs a second person \(CUSTOMER\)/)
    // Neither named: the inspector releases alone, and the release says no reason.
    await set(`"fourEyesConditions" = '{}'`)
    const alone = row()
    expect(await release(alone)).toBe(1)
    expect(await admin(`SELECT "secondPersonReasons"::text AS reasons FROM "QualityRelease" WHERE id = $1`, [alone.id])).toEqual([{ reasons: '{}' }])
  })
})

describe('alert rules (QHS-154)', () => {
  const add = (changes: Record<string, unknown>) => {
    const id = randomUUID()
    return admin(`SELECT id::text AS id FROM "QualityAlertRule" WHERE "tenantId" = $1 AND event = 'HOLD_PLACED' LIMIT 1`, [a.tenantId]).then(([row]) => copyRow(office(), 'QualityAlertRule', String(row?.id), { id, ...changes }))
  }

  it('the seed holds the rules of the design', async () => {
    expect(await admin(`SELECT event::text AS event, audience::text AS audience, "withinMinutes", "daysBefore" FROM "QualityAlertRule" WHERE "tenantId" = $1 ORDER BY 1`, [a.tenantId])).toEqual([
      { event: 'CAPA_ACTION_OVERDUE', audience: 'OWNER_AND_ROLE', withinMinutes: 1440, daysBefore: [] },
      { event: 'CERTIFICATE_EXPIRING', audience: 'ROLE', withinMinutes: 0, daysBefore: [180, 90, 30] },
      { event: 'CRITICAL_NCR', audience: 'ROLE', withinMinutes: 0, daysBefore: [] },
      { event: 'HOLD_PLACED', audience: 'OWNER', withinMinutes: 0, daysBefore: [] },
      { event: 'INSPECTION_WAITING', audience: 'ROLE', withinMinutes: 240, daysBefore: [] },
      { event: 'RELEASE_WAITING_SECOND_PERSON', audience: 'ROLE', withinMinutes: 60, daysBefore: [] },
      { event: 'SAFETY_COMPLAINT', audience: 'OWNER_AND_ROLE', withinMinutes: 0, daysBefore: [] },
    ])
  })

  it('a role exactly when it tells one; a wait; the days of an expiry only; a channel', async () => {
    await expect(add({ audience: 'ROLE' })).rejects.toThrow(/a role exactly for ROLE/)
    await expect(add({ audience: 'OWNER', roleId: capa.roleId })).rejects.toThrow(/a role exactly for ROLE/)
    await expect(add({ withinMinutes: -1 })).rejects.toThrow(/waits 0 to 43200/)
    await expect(add({ withinMinutes: 43_201 })).rejects.toThrow(/waits 0 to 43200/)
    await expect(add({ daysBefore: [30] })).rejects.toThrow(/days before an expiry/)
    await expect(add({ event: 'CERTIFICATE_EXPIRING' })).rejects.toThrow(/days before an expiry/)
    await expect(add({ event: 'CERTIFICATE_EXPIRING', daysBefore: [30, 90] })).rejects.toThrow(/highest first/)
    await expect(add({ event: 'CERTIFICATE_EXPIRING', daysBefore: [90, 90] })).rejects.toThrow(/highest first/)
    await expect(add({ event: 'CERTIFICATE_EXPIRING', daysBefore: [731] })).rejects.toThrow(/highest first/)
    await expect(add({ event: 'CERTIFICATE_EXPIRING', daysBefore: [30], withinMinutes: 5 })).rejects.toThrow(/highest first/)
    await expect(add({ channels: [] })).rejects.toThrow(/at least one channel/)
    await expect(add({ channels: ['EMAIL', 'EMAIL'] })).rejects.toThrow(/at least one channel/)
    expect(await add({ event: 'CERTIFICATE_EXPIRING', daysBefore: [60], companyId: A.company })).toBe(1)
  })

  it('keep their company and event, and are removed by the office', async () => {
    const [row] = await admin(`SELECT id::text AS id FROM "QualityAlertRule" WHERE "tenantId" = $1 AND event = 'INSPECTION_WAITING'`, [a.tenantId])
    const id = String(row?.id)
    await expect(run(office(), `UPDATE "QualityAlertRule" SET event = 'CRITICAL_NCR' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "QualityAlertRule" SET "companyId" = $2::uuid WHERE id = $1::uuid`, id, A.company)).rejects.toThrow(/never change/)
    expect(await run(office(), `UPDATE "QualityAlertRule" SET enabled = false, "withinMinutes" = 480 WHERE id = $1::uuid`, id)).toBe(1)
    const copy = randomUUID()
    await copyRow(office(), 'QualityAlertRule', id, { id: copy })
    expect(await run(office(), `DELETE FROM "QualityAlertRule" WHERE id = $1::uuid`, copy)).toBe(1)
  })
})

describe("the complaint's investigation and answer letter (QHS-116)", () => {
  const newComplaint = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    await copyRow(office(), 'Complaint', capa.complaintId, { id, number: `T-CMP-${id.slice(0, 8)}`, answerFileIds: [], findings: null, rootCause: null, answerTemplate: null, answerLanguage: null, answerText: null, ...changes })
    return id
  }
  const set = (id: string, text: string, ...values: unknown[]) => run(office(), `UPDATE "Complaint" SET ${text} WHERE id = $1::uuid`, id, ...values)
  /** Version `version` of the complaint's letter. */
  const letter = async (complaintId: string, changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    const fileId = await fileOf('Complaint', complaintId)
    await copyRow(office(), 'GeneratedDocument', capa.reportDocumentId, { id, recordType: 'Complaint', recordId: complaintId, kind: 'COMPLAINT_ANSWER', fileId, language: 'it', version: 1, number: null, ...changes })
    return id
  }
  const sent = (documentId: string) => `status = 'ANSWERED', "answeredAt" = now(), "answerLanguage" = 'it', "answerDocumentId" = '${documentId}'::uuid, "answeredById" = '${a.actorId}'::uuid, "answeredVia" = 'EMAIL'`

  it('the seed has its findings and a letter being written, nothing sent', async () => {
    expect(await admin(`SELECT findings IS NOT NULL AS found, "rootCause" IS NOT NULL AS cause, "answerLanguage" AS language, "answerDocumentId" AS document, "answeredAt" AS at FROM "Complaint" WHERE id = $1`, [capa.complaintId])).toEqual([
      { found: true, cause: true, language: 'it', document: null, at: null },
    ])
  })

  it('is investigated once triaged, in words, and a letter has a language', async () => {
    const id = await newComplaint()
    await expect(newComplaint({ status: 'NEW', findings: 'x' })).rejects.toThrow(/investigated once it is triaged/)
    await expect(set(id, `findings = ' '`)).rejects.toThrow(/not blank when given/)
    await expect(set(id, `"answerLanguage" = 'ITA'`)).rejects.toThrow(/two-letter language/)
    await expect(set(id, `"answerFileIds" = ARRAY[$2::uuid, $2::uuid]`, capa.ncrId)).rejects.toThrow(/each of its files once/)
    expect(await set(id, `findings = 'Found', "rootCause" = 'Why', "answerTemplate" = 'complaint-answer', "answerLanguage" = 'de', "answerText" = 'Guten Tag'`)).toBe(1)
  })

  it('a letter sent names its version, who and how, and needs its answer time', async () => {
    const id = await newComplaint()
    const document = await letter(id)
    await expect(set(id, `"answerDocumentId" = $2::uuid`, document)).rejects.toThrow(/all three/)
    await expect(set(id, `"answerDocumentId" = $2::uuid, "answeredById" = $3::uuid, "answeredVia" = 'EMAIL'`, document, a.actorId)).rejects.toThrow(/all three/)
    const other = await newComplaint()
    await expect(set(id, sent(await letter(other)))).rejects.toThrow(/a COMPLAINT_ANSWER of this complaint/)
    await expect(set(id, `${sent(document)}, "answerLanguage" = 'de'`.replace(`"answerLanguage" = 'it', `, ''))).rejects.toThrow(/in the letter's language/)
    expect(await set(id, sent(document))).toBe(1)
    await expect(set(id, `"answerText" = 'Changed'`)).rejects.toThrow(/its letter changes once it goes back to INVESTIGATING/)
    // Back to INVESTIGATING: it opens again, the version stays.
    await expect(set(id, `status = 'INVESTIGATING', "answeredAt" = NULL`)).rejects.toThrow(/all three/)
    expect(await set(id, `status = 'INVESTIGATING', "answeredAt" = NULL, "answerDocumentId" = NULL, "answeredById" = NULL, "answeredVia" = NULL`)).toBe(1)
    expect(await set(id, `"answerText" = 'Changed'`)).toBe(1)
    expect(await admin(`SELECT count(*)::int AS n FROM "GeneratedDocument" WHERE "recordId" = $1`, [id])).toEqual([{ n: 1 }])
    // A complaint answered by phone has no letter, as in W2a.
    const phone = await newComplaint()
    expect(await set(phone, `status = 'ANSWERED', "answeredAt" = now()`)).toBe(1)
  })
})

describe('generated documents of the new kinds (QHS-059, QHS-094, QHS-116, QHS-145)', () => {
  const add = (changes: Record<string, unknown>) => {
    const id = randomUUID()
    return copyRow(office(), 'GeneratedDocument', capa.reportDocumentId, { id, version: Math.floor(Math.random() * 1_000_000) + 10, ...changes })
  }

  it('an 8D and a complaint answer have no site, and the floor reads neither', async () => {
    await expect(add({ siteId: A.site })).rejects.toThrow(/is of the company and site of its Capa/)
    await expect(add({ companyId: A.companyB })).rejects.toThrow(/is of the company and site of its Capa|file of its own record/)
    expect(await add({ fileId: await fileOf('Capa', capa.eightDId) })).toBe(1)
    expect(await sql(floor(), `SELECT id FROM "GeneratedDocument" WHERE id = $1::uuid`, capa.reportDocumentId)).toEqual([])
    expect(await sql(office(), `SELECT id::text AS id FROM "GeneratedDocument" WHERE id = $1::uuid`, capa.reportDocumentId)).toEqual([{ id: capa.reportDocumentId }])
  })

  it('a site record keeps its site: an NCR report, an inspection report, a certificate of conformity', async () => {
    const ncr = (changes: Record<string, unknown>) => ({ kind: 'NCR_REPORT', recordType: 'Nonconformance', recordId: capa.ncrId, ...changes })
    await expect(add(ncr({ fileId: await fileOf('Nonconformance', capa.ncrId) }))).rejects.toThrow(/is of the company and site of its Nonconformance/)
    expect(await add(ncr({ siteId: A.site, fileId: await fileOf('Nonconformance', capa.ncrId) }))).toBe(1)
    const inspection = await fileOf('Inspection', capa.passedInspectionId)
    expect(await add({ kind: 'INSPECTION_REPORT', recordType: 'Inspection', recordId: capa.passedInspectionId, siteId: A.site, fileId: inspection })).toBe(1)
    const [shipment] = await admin(`SELECT id::text AS id, "siteId"::text AS site, "companyId"::text AS company FROM "Shipment" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])
    expect(shipment).toBeDefined()
    const file = await fileOf('Shipment', String(shipment?.id))
    await run(office(), `UPDATE "StoredFile" SET "companyId" = $2::uuid WHERE id = $1::uuid AND "companyId" <> $2::uuid`, file, shipment?.company)
    expect(await add({ kind: 'CERTIFICATE_OF_CONFORMITY', recordType: 'Shipment', recordId: shipment?.id, siteId: shipment?.site, companyId: shipment?.company, fileId: file })).toBe(1)
  })

  it('every kind belongs to its record, and the kinds of later waves wait for their record by name', async () => {
    await expect(add({ kind: 'EIGHT_D', recordType: 'Complaint', recordId: capa.complaintId })).rejects.toThrow(/an 8D a Capa's/)
    await expect(add({ kind: 'COMPLAINT_ANSWER' })).rejects.toThrow(/an answer letter a Complaint's/)
    await expect(add({ kind: 'CHECK_REPORT' })).rejects.toThrow(/a check report a MachineCheckResult's/)
    await expect(add({ kind: 'DVR_FROZEN' })).rejects.toThrow(/a frozen risk assessment a RiskAssessmentVersion's/)
    await expect(add({ kind: 'PPE_RECEIPT' })).rejects.toThrow(/a PPE receipt a PpeIssue's/)
    await expect(add({ kind: 'INSPECTION_REPORT', recordType: 'Nonconformance', recordId: capa.ncrId })).rejects.toThrow(/an inspection report an Inspection's/)
    const record = randomUUID()
    await expect(add({ kind: 'CHECK_REPORT', recordType: 'MachineCheckResult', recordId: record })).rejects.toThrow(/a file of its own record/)
    expect(await add({ kind: 'CHECK_REPORT', recordType: 'MachineCheckResult', recordId: record, siteId: A.site, fileId: await fileOf('MachineCheckResult', record) })).toBe(1)
  })

  it('the older kinds keep their rule, and the whole table stays append-only', async () => {
    await expect(add({ kind: 'PACKING_LIST', recordType: 'Capa' })).rejects.toThrow(/a packing list is a Shipment's/)
    await expect(admin(`UPDATE "GeneratedDocument" SET language = 'de' WHERE id = $1`, [capa.reportDocumentId])).rejects.toThrow(/append-only/)
  })
})

describe('numbering', () => {
  it('CAPA is a kind with a seeded series', async () => {
    expect(await admin(`SELECT pattern, reset::text AS reset, fiscal FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'CAPA'`, [a.tenantId, A.company])).toEqual([{ pattern: 'CAPA-{YYYY}-{N:4}', reset: 'YEARLY', fiscal: false }])
  })
})
