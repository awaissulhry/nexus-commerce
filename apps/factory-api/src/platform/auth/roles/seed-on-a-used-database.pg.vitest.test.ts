import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, seedDay, type MigratedDatabase } from '@nexus/factory-db/testing' // seedDay: the seeds' calendar (B-W2b-F53)
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { SYSTEM_ROLE_TEMPLATES, templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor, command } from '../../../core/command'
import { completeContext, type SessionContext } from '../../../core/context'
import { setDaysMany } from '../../calendars/calendars'
import { createDocumentTemplate, publishDocumentTemplate } from '../../templates/documents'
import { asSystem } from '../../outbox/system'
import { standardReasonsForNewTenants } from '../../reasons/standard'
import { indexNewTenants } from '../../search/indexing'
import { loadIndexers } from '../../search/registry'
import { addStandardCodes } from '../../../modules/people/attendance/codes'
import { addStarter as addPlantStarter } from '../../../modules/plant/lists/lists'
import { addStarter as addDefectStarter } from '../../../modules/quality/defects/defects'
import { addStandardDispositions } from '../../../modules/quality/defects/dispositions'
import { finishedItemFor } from '../../../modules/inventory/finished/post'
import { syncAllTenants } from './sync'
import { systemRoleChanges } from './system-roles'

/**
 * B-W2b-GS1: the seed runs again on a database the app has already used, as on the Owner's local test server (`npm run
 * seed` again after a code update, his records kept), through the real login and the scoped client, every seed file in
 * name order as the CLI runs them. On the Owner's database the roles seed stopped at `Role_tenantId_key_key`: the worker's
 * role-template sync had made the partner roles, with ids of their own, before a seed that writes them too.
 *
 * Tenant U — the app first: after `_core.ts` the worker's start work (the role-template sync: every system role; the
 * standard reasons of empty lists), a person's one-click lists (the defect library's starter set, the standard
 * dispositions, the plant starter classes and symptoms, the standard absence codes), a closure for plant A1 (the app
 * makes the plant's calendar) and a person's own Italian quote template, published; after the production seed, the
 * posting's finished item of SEED-JKT-02 BLK 52; before `search.ts` the worker's first index. Then the rest of the seed, and the whole seed twice: it passes, makes no second row, adopts
 * each of the app's rows (its id, its words as the app or the person left them), and the seeded records name them.
 *
 * Tenant S — the Owner's case: the whole seed, the worker's start work and a person made with a role, then the seed
 * again: it passes and the person's records are as they were.
 *
 * A fresh database seeded twice: packages/factory-db seed-complete-w2b-f59 (and `npm run seed` twice on a new database).
 * Run with `node scripts/factory/run-pg-tests.mjs platform/auth/roles/seed-on-a-used-database`.
 */

type Row = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const QUIET = { info() {}, warn() {}, error() {} }
const FILES = readdirSync(SEED_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort()

const U = 'gs1-used'
const S = 'gs1-seeded'
const ids = (namespace: string) => ({
  tenant: seedUuid(namespace, 'tenant'),
  actor: seedUuid(namespace, 'actor'),
  companyA: seedUuid(namespace, 'company:A'),
  siteA1: seedUuid(namespace, 'site:A1'),
  id: (key: string) => seedUuid(namespace, key),
})

let db: MigratedDatabase
let factory: FactoryDatabase
let requests = 0
const admin = async (text: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(text, values)).rows as Row[]

/** One seed file (with the seeds it runs first itself). */
async function seedFile(namespace: string, file: string): Promise<void> {
  const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: SeedContext) => Promise<unknown> }
  await module.seed({ db: factory, namespace })
}

/** Every seed file from `from` (inclusive) to `to` (exclusive), in name order, as the CLI runs them. */
async function seedFiles(namespace: string, from?: string, to?: string): Promise<void> {
  for (const file of FILES) {
    if ((from && file < from) || (to && file >= to)) continue
    await seedFile(namespace, file)
  }
}

/** An office caller of the tenant with the owner template's every permission (a person at a screen). */
function officeCaller(tenantId: string) {
  const owner = templateOf('owner')!
  const grants: Grant[] = [{ permissions: [...owner.permissions, ...owner.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
  const session: SessionContext = { audience: 'office', tenantId, actorId: newId(), grants }
  return callerFor(factory, completeContext(session, `gs1-${++requests}`))
}

/** What the worker does when it starts (background.ts): the role-template sync and the standard reasons of empty lists. */
async function workerStart(): Promise<void> {
  expect(await syncAllTenants({ database: factory, log: QUIET })).toMatchObject({ failed: 0 })
  expect(await standardReasonsForNewTenants({ database: factory, log: QUIET })).toMatchObject({ failed: 0 })
}

const countBy = async (table: string, tenantId: string, columns: string): Promise<Row[]> =>
  admin(`SELECT ${columns}, count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1 GROUP BY ${columns} HAVING count(*) > 1`, [tenantId])
const idsOf = async (table: string, tenantId: string, key: string): Promise<Map<string, string>> =>
  new Map((await admin(`SELECT id, ${key} AS key FROM "${table}" WHERE "tenantId" = $1`, [tenantId])).map((row) => [row.key as string, row.id as string]))

/** What the app made in tenant U before the seed wrote the same rows, by natural key. */
const appMade: Record<string, Map<string, string>> = {}
let editedReasonId = ''
let appCalendarId = ''
let appFinishedItemId = ''
let appQuoteTemplateId = ''

beforeAll(async () => {
  db = await migratedDatabase('seedagaings1')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  const u = ids(U)

  // --- tenant U: the app first ------------------------------------------------------------------------------------------
  await seedFiles(U, undefined, 'accounting.ts')
  await workerStart()
  const office = officeCaller(u.tenant)
  await addDefectStarter(office, `gs1-defects-${newId()}`)
  await addStandardDispositions(office, `gs1-dispositions-${newId()}`)
  await addPlantStarter(office, `gs1-plant-${newId()}`)
  await addStandardCodes(office, { companyId: null }, `gs1-absence-${newId()}`)
  const closure = await setDaysMany(office, { targets: [{ scope: 'SITE', ownerId: u.siteA1 }], from: seedDay('2026-12-07'), kind: 'CLOSURE', name: 'Made by the app first' }, `gs1-closure-${newId()}`)
  expect(closure.calendars[0]!.created).toBe(true)
  appCalendarId = closure.calendars[0]!.calendar.id
  // A person's own Italian quote template for company A, published (its keys and its ACTIVE version are the tenant's).
  const quote = await createDocumentTemplate(office, { companyId: u.companyA, kind: 'QUOTE', language: 'it', header: 'Our own quote words (a person)' }, `gs1-quote-${newId()}`)
  appQuoteTemplateId = quote.template.id
  const [draft] = await admin(`SELECT version FROM "DocumentTemplate" WHERE id = $1`, [appQuoteTemplateId])
  await publishDocumentTemplate(office, appQuoteTemplateId, { version: draft!.version }, `gs1-publish-${newId()}`)
  for (const [table, key] of [
    ['Role', '"key"'],
    ['ReasonCode', `"list"::text || ':' || "code"`],
    ['ScrapReason', `"kind"::text || ':' || "code"`],
    ['DefectCode', '"code"'],
    ['DispositionCode', '"code"'],
    ['MachineClass', '"code"'],
    ['MachineSymptom', '"code"'],
    ['AbsenceCode', '"code"'],
  ] as const) {
    appMade[table] = await idsOf(table, u.tenant, key)
  }
  // A person edits one of the app's standard reasons (its words are the tenant's from now on).
  editedReasonId = appMade.ReasonCode!.get('PAUSE:BREAK') ?? [...appMade.ReasonCode!.values()][0]!
  await admin(`UPDATE "ReasonCode" SET "labelEn" = 'Edited by a person' WHERE id = $1`, [editedReasonId])

  // The product and production seeds (and theirs), then finished goods posted for SEED-JKT-02 BLK 52 before any seed made its
  // item: the app makes the SKU's FINISHED item (inventory/finished).
  await seedFile(U, 'production.ts')
  const [variant] = await admin(`SELECT v.id, v.sku, v."colourwayId", v.size, s.name AS style, c.name AS colourway FROM "Variant" v JOIN "Style" s ON s.id = v."styleId" JOIN "Colourway" c ON c.id = v."colourwayId" WHERE v.id = $1`, [u.id('production:variant:JKT-02:BLK:52')])
  const { result } = await command(office, { name: 'gs1.finishedItem', input: null }, (tools) =>
    finishedItemFor(tools, { variantId: variant!.id, sku: variant!.sku, colourwayId: variant!.colourwayId, size: variant!.size, itemId: null, itemCurrency: null }, { styleName: variant!.style, colourwayName: variant!.colourway, garmentTracking: 'BATCH', companyId: u.companyA }),
  )
  appFinishedItemId = result
  await seedFiles(U, 'accounting.ts', 'search.ts')
  // The worker's first start on a tenant with no index builds it (every record's entry, ids of the indexers' own).
  expect(await indexNewTenants({ database: factory, indexers: await loadIndexers(SRC), log: QUIET })).toMatchObject({ failed: 0 })
  appMade.SearchEntry = await idsOf('SearchEntry', u.tenant, `"recordType" || ':' || "recordId"`)
  await seedFiles(U, 'search.ts')
  // And the whole seed twice more.
  await seedFiles(U)
  await seedFiles(U)

  // --- tenant S: seeded, then used ----------------------------------------------------------------------------------------
  const s = ids(S)
  await seedFiles(S)
  await workerStart()
  // A person: an office user with a role assignment, as the app writes them (the Owner's test people are made so).
  const personId = newId()
  await factory.withScope({ audience: 'office', tenantId: s.tenant, actorId: s.actor }, async (client) => {
    const sales = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: s.tenant, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: personId, email: 'gs1.person@example.com', displayName: 'A person of the Owner', createdById: s.actor }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: personId, roleId: sales.id, allCompanies: true, companyIds: [], siteIds: [], partyIds: [], validFrom: new Date(), grantedById: s.actor }, select: { id: true } })
  })
  appMade.personS = new Map([['person', personId]])
  appMade.rolesS = await idsOf('Role', s.tenant, '"key"')
  await seedFiles(S)
}, 1_200_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('tenant U: the app made the rows first, then the seed ran three times', () => {
  it('every system role is the one the sync made: one row per key, its id kept, the seeded grants and references name it', async () => {
    const { tenant } = ids(U)
    expect(await countBy('Role', tenant, '"key"')).toEqual([])
    const roles = await idsOf('Role', tenant, '"key"')
    for (const template of SYSTEM_ROLE_TEMPLATES) expect(roles.get(template.key), template.key).toBe(appMade.Role!.get(template.key))
    // The seeded office and floor grants name the sync's roles.
    const assignments = await admin(`SELECT r.key FROM "RoleAssignment" a JOIN "Role" r ON r.id = a."roleId" WHERE a.id = ANY($1::uuid[])`, [['owner', 'member:sales', 'invited:planner'].map((key) => ids(U).id(`assignment:${key}`))])
    expect(assignments.map((row) => row.key).sort()).toEqual(['owner', 'planner', 'sales'])
    for (const row of assignments) expect(roles.get(row.key)).toBe(appMade.Role!.get(row.key))
    const workerRoles = await admin(`SELECT "roleId" FROM "WorkerRole" WHERE "tenantId" = $1`, [tenant])
    expect(workerRoles.length).toBeGreaterThan(0)
    for (const row of workerRoles) expect([...appMade.Role!.values()]).toContain(row.roleId)
    // The approval rules' approvers (seeds that read the roles seed's ids) name the sync's roles too.
    const approvers = await admin(`SELECT DISTINCT "approverRoleId" FROM "ApprovalRule" WHERE "tenantId" = $1 AND "approverRoleId" IS NOT NULL`, [tenant])
    expect(approvers.length).toBeGreaterThan(0)
    for (const row of approvers) expect([...appMade.Role!.values()]).toContain(row.approverRoleId)
  })

  it('the seed writes the system roles exactly as the sync does: a sync after it finds nothing to change', async () => {
    const pending = await asSystem(factory, ids(U).tenant, `gs1-${++requests}`, (client) => systemRoleChanges(client))
    expect(pending).toEqual([])
    expect(await asSystem(factory, ids(S).tenant, `gs1-${++requests}`, (client) => systemRoleChanges(client))).toEqual([])
  })

  it('the standard and starter lists keep the app’s rows: one per code, their ids, and the words a person changed', async () => {
    const { tenant } = ids(U)
    for (const [table, key, group] of [
      ['ReasonCode', `"list"::text || ':' || "code"`, '"list", "code"'],
      ['ScrapReason', `"kind"::text || ':' || "code"`, '"kind", "code"'],
      ['DefectCode', '"code"', '"code"'],
      ['DispositionCode', '"code"', '"code"'],
      ['MachineClass', '"code"', '"code"'],
      ['MachineSymptom', '"code"', '"code"'],
      ['AbsenceCode', '"code"', '"code"'],
    ] as const) {
      expect(await countBy(table, tenant, group), table).toEqual([])
      const now = await idsOf(table, tenant, key)
      expect(appMade[table]!.size, table).toBeGreaterThan(0)
      for (const [code, rowId] of appMade[table]!) expect(now.get(code), `${table} ${code}`).toBe(rowId)
    }
    expect((await admin(`SELECT "labelEn" FROM "ReasonCode" WHERE id = $1`, [editedReasonId]))[0]!.labelEn).toBe('Edited by a person')
    // The seeded records name the tenant's codes: a machine its class, an NCR line its defect, an absence its code.
    const classes = [...(await idsOf('MachineClass', tenant, '"code"')).values()]
    const machines = await admin(`SELECT "classId" FROM "Machine" WHERE "tenantId" = $1`, [tenant])
    expect(machines.length).toBeGreaterThan(0)
    for (const machine of machines) expect(classes).toContain(machine.classId)
    // SEED-SEW-L1-01 is a lockstitch machine: the starter's LOCKSTITCH class, when the starter has one.
    const lockstitch = appMade.MachineClass!.get('LOCKSTITCH')
    if (lockstitch) expect((await admin(`SELECT "classId" FROM "Machine" WHERE id = $1`, [`00000000${ids(U).id('plant:machine:SEED-SEW-L1-01').slice(8)}`]))[0]!.classId).toBe(lockstitch)
    const absences = await admin(`SELECT DISTINCT e."codeId", c.code FROM "AbsenceEntry" e JOIN "AbsenceCode" c ON c.id = e."codeId" WHERE e."tenantId" = $1`, [tenant])
    expect(absences.length).toBeGreaterThan(0)
    for (const row of absences) if (appMade.AbsenceCode!.has(row.code)) expect(row.codeId).toBe(appMade.AbsenceCode!.get(row.code))
  })

  it('plant A1 keeps the calendar the app made for its closure: one ACTIVE calendar, no seeded day added to it', async () => {
    const { tenant, siteA1 } = ids(U)
    const calendars = await admin(`SELECT id FROM "WorkCalendar" WHERE "tenantId" = $1 AND "siteId" = $2 AND scope = 'SITE' AND status = 'ACTIVE'`, [tenant, siteA1])
    expect(calendars.map((row) => row.id)).toEqual([appCalendarId])
    const days = await admin(`SELECT name FROM "CalendarDay" WHERE "calendarId" = $1`, [appCalendarId])
    expect(days.map((row) => row.name)).toEqual(['Made by the app first'])
    // The other owners' calendars are the seed's own.
    expect((await admin(`SELECT count(*)::int AS n FROM "WorkCalendar" WHERE "tenantId" = $1 AND status = 'ACTIVE'`, [tenant]))[0]!.n).toBe(6)
  })

  it('SEED-JKT-02 BLK 52 keeps the finished item the posting made, and the seeded records name it', async () => {
    const { tenant, id } = ids(U)
    const items = await admin(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND "variantId" = $2`, [tenant, id('production:variant:JKT-02:BLK:52')])
    expect(items.map((row) => row.id)).toEqual([appFinishedItemId])
    expect((await admin(`SELECT count(*)::int AS n FROM "Item" WHERE id = $1`, [`ffffffff${id('schedule:item:SEED-JKT-02-BLK-52').slice(8)}`]))[0]!.n).toBe(0)
  })

  it('the quote template a person began is the tenant’s: no seeded version added to it, the seed’s other templates are there', async () => {
    const { tenant, companyA, id } = ids(U)
    const quotes = await admin(`SELECT id, status FROM "DocumentTemplate" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'QUOTE' AND language = 'it'`, [tenant, companyA])
    expect(quotes).toEqual([{ id: appQuoteTemplateId, status: 'ACTIVE' }])
    expect((await admin(`SELECT count(*)::int AS n FROM "DocumentTemplate" WHERE id = $1`, [id('config:doc:A:DDT:en:1')]))[0]!.n).toBe(1)
    expect((await admin(`SELECT count(*)::int AS n FROM "EmailTemplate" WHERE "tenantId" = $1`, [tenant]))[0]!.n).toBe(3)
  })

  it('every record keeps the search entry the indexer made: one per record, its id', async () => {
    const { tenant, id } = ids(U)
    expect(await countBy('SearchEntry', tenant, '"recordType", "recordId"')).toEqual([])
    const now = await idsOf('SearchEntry', tenant, `"recordType" || ':' || "recordId"`)
    for (const key of [`Party:${id('party:P1')}`, `Party:${id('party:P2')}`, `SalesOrder:${id('sales:SO1')}`]) {
      expect(appMade.SearchEntry!.get(key), key).toBeDefined()
      expect(now.get(key), key).toBe(appMade.SearchEntry!.get(key))
    }
  })
})

describe('tenant S: seeded, used, seeded again (the Owner’s case)', () => {
  it('passes, and the person and every role are as they were', async () => {
    const { tenant } = ids(S)
    const personId = appMade.personS!.get('person')!
    const person = await admin(`SELECT u.email, r.key FROM "User" u JOIN "RoleAssignment" a ON a."userId" = u.id JOIN "Role" r ON r.id = a."roleId" WHERE u.id = $1`, [personId])
    expect(person).toEqual([{ email: 'gs1.person@example.com', key: 'sales' }])
    expect(await idsOf('Role', tenant, '"key"')).toEqual(appMade.rolesS)
    expect(await countBy('Role', tenant, '"key"')).toEqual([])
  })
})
