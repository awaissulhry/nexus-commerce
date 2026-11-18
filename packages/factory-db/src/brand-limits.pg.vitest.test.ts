import { randomUUID } from 'node:crypto'
import { PRODUCTION_ASK_KINDS } from '@nexus/factory-domain/production-brand/kinds'
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { OrderChangeRequestKind } from './generated/prisma/enums'
import { readMigrations } from './policies'
import { PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { MIGRATIONS_DIR } from './tools'

/**
 * B-PR-12 (production plan, schema wave 2/5; lead picks L7, L18, L21; review fixes R-46, R-50, R-53): a customer's production
 * limits on its portal settings and its own freeze rules, on a database built from the migrations and seeded, through the
 * real login and the scoped client.
 *   - PW-15 (DB part): the partner role has no grant on PortalSettings (nor OrderFreezeRule), so a customer never reads its
 *     supervisor, backup, quota or switches;
 *   - PW-S01 (DB part): the limits hold for every login: the level alone shares production progress (B-PR-40 dropped the old
 *     switch B-PR-12 kept in step with it), from PROGRESS on only for a customer or a brand, the urgent quota 0 to 20, the
 *     supervisor with since when, the backup only beside a supervisor and never the same person, office people only; the
 *     production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND only (RUSH follows the urgency switch); the named approver
 *     a person of the customer itself (a refusal names no other customer); limits only for a customer or a brand;
 *   - freeze rules per customer: one active rule per company, customer (or none), field and stage; a customer's set and the
 *     company's are never compared; the customer is fixed;
 *   - the copy step (…_production_brand_limits_copy): progress shared → the level PROGRESS; customers listed for a second
 *     person at release → overrideFourEyes (B-PR-40: run on the schema it saw, the dropped column put back for one
 *     transaction).
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'pr12-limits'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalAuthSeed

const key = (name: string): string => seedUuid(NS, name)
/** P1 the customer and brand, P2 the supplier, P3 another customer (parties seed). */
const P = { p1: key('party:P1'), p2: key('party:P2'), p3: key('party:P3'), p4: key('party:P4') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** UPDATE row `id` of `table` with `changes` (office). */
const update = (table: string, id: string, changes: Record<string, unknown>) => {
  const sets = Object.keys(changes).map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(office(), `UPDATE "${table}" t SET ${sets} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(changes), id)
}
/** INSERT a copy of row `id` of `table` with `changes`, every trigger off (set-up only: another customer). */
async function plant(table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** The refusal's message, or null when it passed. */
const refusal = (work: Promise<unknown>): Promise<string | null> => work.then(
  () => null,
  (error: Error) => error.message,
)
const settingsOf = async (id: string) => (await admin(
  `SELECT "productionLevel"::text AS level, "productionUrgencyOn" AS "urgencyOn", "productionUrgentMax" AS "urgentMax", "productionSupervisorId"::text AS supervisor,
          "productionBackupId"::text AS backup, "productionAskKinds"::text[] AS "askKinds", "productionApproverId"::text AS approver, "overrideFourEyes"
     FROM "PortalSettings" WHERE id = $1`,
  [id],
))[0]
/** A person of the tenant (office scope): an office one by default; returns its id. */
const person = async (changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE', ...changes })
  return id
}
const partnerOf = (partyId: string, changes: Record<string, unknown> = {}) => person({ audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER', ...changes })
const SET_AT = '2026-11-17T08:00:00.000Z'

/** Office people: two active ones (supervisor, backup), a suspended one, an invited one. */
const U = { supervisor: '', backup: '', suspended: '', invited: '', p3Partner: '' }

beforeAll(async () => {
  db = await migratedDatabase('brandlimits')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedPortalAuth({ db: factory, namespace: NS })
  U.supervisor = await person()
  U.backup = await person()
  U.suspended = await person({ status: 'SUSPENDED' })
  U.invited = await person({ status: 'INVITED' })
  U.p3Partner = await partnerOf(P.p3)
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

describe('the partner role reads no limits (PW-15, DB part)', () => {
  it('has no grant on PortalSettings or OrderFreezeRule, nor on any column of the limits', async () => {
    for (const table of ['PortalSettings', 'OrderFreezeRule']) {
      const [grants] = await admin(
        `SELECT has_table_privilege($1, format('%I', $2::text), 'SELECT') AS "select", has_table_privilege($1, format('%I', $2::text), 'INSERT') AS "insert",
                has_table_privilege($1, format('%I', $2::text), 'UPDATE') AS "update", has_any_column_privilege($1, format('%I', $2::text), 'SELECT') AS "anyColumn"`,
        [PARTNER_ROLE, table],
      )
      expect(grants, table).toEqual({ select: false, insert: false, update: false, anyColumn: false })
    }
    const partner: FactoryScope = { audience: 'partner', tenantId: a.tenantId, actorId: seeded.userIds.p1Buyer, partyId: P.p1 }
    for (const column of ['productionSupervisorId', 'productionBackupId', 'productionUrgentMax', 'productionUrgencyOn', 'productionLevel', 'productionApproverId', 'overrideFourEyes']) {
      await expect(sql(partner, `SELECT "${column}" FROM "PortalSettings" WHERE "partyId" = $1::uuid`, P.p1), column).rejects.toThrow(DENIED)
    }
    await expect(sql(partner, `SELECT id FROM "OrderFreezeRule"`)).rejects.toThrow(DENIED)
  })
})

describe("a customer's production limits (PW-S01, DB part)", () => {
  it('ship with their defaults: Status only, urgency off, 3 urgent, nobody named, no production ask, no second person', async () => {
    expect(await settingsOf(seeded.settingsIds.p1)).toEqual({
      level: 'STATUS', urgencyOn: false, urgentMax: 3, supervisor: null, backup: null, askKinds: [], approver: null, overrideFourEyes: false,
    })
    // The levels in the domain's order: the database compares them in that order.
    expect((await admin(`SELECT enum_range(NULL::"ProductionShareLevel")::text[] AS levels`))[0]!.levels).toEqual([...PRODUCTION_SHARE_LEVELS])
  })

  // B-PR-40 (schema wave 5/5): the old progress switch is dropped; the level alone says what the customer sees.
  it('shares production progress by the level alone: it moves only when written, and from PROGRESS on only for a customer or a brand', async () => {
    const id = seeded.settingsIds.p1
    expect(await admin(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PortalSettings' AND column_name = 'progressShared'`)).toEqual([{ n: 0 }])
    for (const level of ['PROGRESS', 'GATES', 'STATUS', 'QUALITY', 'PROGRESS', 'STATUS'] as const) {
      expect(await update('PortalSettings', id, { productionLevel: level }), level).toBe(1)
      expect(await settingsOf(id), level).toMatchObject({ level })
    }
    // Another setting written leaves the level as it is (nothing moves it on its own any more).
    expect(await update('PortalSettings', id, { productionLevel: 'GATES' })).toBe(1)
    expect(await update('PortalSettings', id, { maxUsers: 6 })).toBe(1)
    expect(await settingsOf(id)).toMatchObject({ level: 'GATES' })
    expect(await update('PortalSettings', id, { productionLevel: 'STATUS', maxUsers: 5 })).toBe(1)
    // An insert keeps the level written (a new row of P3, then of P4: two customers).
    expect(await insert(office(), 'PortalSettings', { id: P.p3, partyId: P.p3, productionLevel: 'GATES' })).toBe(1)
    expect(await settingsOf(P.p3)).toMatchObject({ level: 'GATES' })
    expect(await insert(office(), 'PortalSettings', { id: P.p4, partyId: P.p4, productionLevel: 'PROGRESS' })).toBe(1)
    expect(await settingsOf(P.p4)).toMatchObject({ level: 'PROGRESS' })
    // Owner answer C1 through the level: a supplier sees no production — raised to PROGRESS or more refused, at insert too.
    const words = /production progress is shared only with a customer or a brand/
    for (const level of ['PROGRESS', 'GATES', 'QUALITY'] as const) {
      await expect(update('PortalSettings', seeded.settingsIds.p2, { productionLevel: level }), level).rejects.toThrow(words)
    }
    expect(await update('PortalSettings', seeded.settingsIds.p2, { productionLevel: 'STATUS' })).toBe(1)
    const supplier = randomUUID()
    await plant('Party', P.p2, { id: supplier, code: `T-${supplier.slice(0, 8)}`, legalName: 'Supplier Delta Test', tradeName: null, carrierAccountSecretId: null })
    await expect(insert(office(), 'PortalSettings', { id: supplier, partyId: supplier, productionLevel: 'PROGRESS' })).rejects.toThrow(words)
    expect(await insert(office(), 'PortalSettings', { id: supplier, partyId: supplier })).toBe(1)
    expect(await settingsOf(supplier)).toMatchObject({ level: 'STATUS' })
  })

  it('lets 0 to 20 orders be urgent at once', async () => {
    const id = seeded.settingsIds.p1
    for (const max of [-1, 21]) await expect(update('PortalSettings', id, { productionUrgentMax: max })).rejects.toThrow(/0 to 20 orders be urgent at once/)
    for (const max of [0, 20, 3]) expect(await update('PortalSettings', id, { productionUrgentMax: max })).toBe(1)
    expect(await update('PortalSettings', id, { productionUrgencyOn: true })).toBe(1)
    expect(await update('PortalSettings', id, { productionUrgencyOn: false })).toBe(1)
    // For every login: the owner too.
    await expect(admin(`UPDATE "PortalSettings" SET "productionUrgentMax" = 50 WHERE id = $1`, [id])).rejects.toThrow(/0 to 20/)
  })

  it('names the supervisor with since when, the backup only beside it and never the same person, office people only', async () => {
    const id = seeded.settingsIds.p1
    await expect(update('PortalSettings', id, { productionSupervisorId: U.supervisor })).rejects.toThrow(/production supervisor together with since when, or neither/)
    await expect(update('PortalSettings', id, { productionSupervisorSetAt: SET_AT })).rejects.toThrow(/together with since when, or neither/)
    await expect(update('PortalSettings', id, { productionBackupId: U.backup })).rejects.toThrow(/a backup only beside a production supervisor, and never the supervisor/)
    expect(await update('PortalSettings', id, { productionSupervisorId: U.supervisor, productionSupervisorSetAt: SET_AT })).toBe(1)
    await expect(update('PortalSettings', id, { productionBackupId: U.supervisor })).rejects.toThrow(/never the supervisor/)
    expect(await update('PortalSettings', id, { productionBackupId: U.backup })).toBe(1)
    // The supervisor goes only with the backup.
    await expect(update('PortalSettings', id, { productionSupervisorId: null, productionSupervisorSetAt: null })).rejects.toThrow(/a backup only beside a production supervisor/)
    // Office people, active when named: never a portal person (another customer's or its own), a suspended or an invited one.
    for (const [who, words] of [
      [seeded.userIds.p1Buyer, /is an active office person, not one that is ACTIVE \(PARTNER\)/],
      [U.p3Partner, /active office person/],
      [U.suspended, /not one that is SUSPENDED \(OFFICE\)/],
      [U.invited, /not one that is INVITED \(OFFICE\)/],
    ] as const) {
      await expect(update('PortalSettings', id, { productionSupervisorId: who }), who).rejects.toThrow(words)
      await expect(update('PortalSettings', id, { productionBackupId: who }), who).rejects.toThrow(/production backup of the portal settings .* is an active office person/)
    }
    // A person made inactive later stays named until the office changes it (B-PR-42a reads "no longer active").
    expect(await update('User', U.backup, { status: 'SUSPENDED' })).toBe(1)
    expect(await update('PortalSettings', id, { maxUsers: 6 })).toBe(1)
    expect(await settingsOf(id)).toMatchObject({ supervisor: U.supervisor, backup: U.backup })
    expect(await update('User', U.backup, { status: 'ACTIVE' })).toBe(1)
    // R-53: a customer without a portal gets its supervisor on a new row with the portal OFF.
    const p5 = randomUUID()
    await plant('Party', P.p3, { id: p5, code: `T-${p5.slice(0, 8)}`, legalName: 'Brand Gamma Test', tradeName: null, carrierAccountSecretId: null })
    expect(await insert(office(), 'PortalSettings', { id: p5, partyId: p5, portalOn: false, productionSupervisorId: U.supervisor, productionSupervisorSetAt: SET_AT })).toBe(1)
    expect(await settingsOf(p5)).toMatchObject({ supervisor: U.supervisor, level: 'STATUS' })
    // A person named here is made inactive, never deleted (Restrict, like the Inquiry assignee).
    const keys = await admin(
      `SELECT conname, confdeltype::text AS "onDelete" FROM pg_constraint WHERE conrelid = '"PortalSettings"'::regclass AND contype = 'f' AND confrelid = '"User"'::regclass ORDER BY conname`,
    )
    expect(keys).toEqual([
      { conname: 'PortalSettings_tenantId_productionApproverId_fkey', onDelete: 'r' },
      { conname: 'PortalSettings_tenantId_productionBackupId_fkey', onDelete: 'r' },
      { conname: 'PortalSettings_tenantId_productionSupervisorId_fkey', onDelete: 'r' },
    ])
    expect(await update('PortalSettings', id, { productionBackupId: null })).toBe(1)
    expect(await update('PortalSettings', id, { productionSupervisorId: null, productionSupervisorSetAt: null })).toBe(1)
  })

  it('opens HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND only, each once: RUSH follows the urgency switch', async () => {
    const id = seeded.settingsIds.p1
    expect(await update('PortalSettings', id, { productionAskKinds: [...PRODUCTION_ASK_KINDS] })).toBe(1)
    expect((await settingsOf(id))!.askKinds).toEqual([...PRODUCTION_ASK_KINDS])
    const others = Object.values(OrderChangeRequestKind).filter((kind) => !(PRODUCTION_ASK_KINDS as readonly string[]).includes(kind))
    expect(others.sort()).toEqual(['CANCEL', 'CHANGE', 'RUSH'])
    for (const kind of others) {
      await expect(update('PortalSettings', id, { productionAskKinds: ['HOLD', kind] }), kind).rejects.toThrow(/open the production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND only, each once/)
    }
    await expect(update('PortalSettings', id, { productionAskKinds: ['HOLD', 'HOLD'] })).rejects.toThrow(/each once/)
    await expect(admin(`UPDATE "PortalSettings" SET "productionAskKinds" = NULL WHERE id = $1`, [id])).rejects.toThrow(/each once/)
    expect(await update('PortalSettings', id, { productionAskKinds: [] })).toBe(1)
  })

  it("names as approver an active portal person of the customer itself; a refusal names no other customer", async () => {
    const id = seeded.settingsIds.p1
    expect(await update('PortalSettings', id, { productionApproverId: seeded.userIds.p1Buyer })).toBe(1)
    expect((await settingsOf(id))!.approver).toBe(seeded.userIds.p1Buyer)
    const words = /production approver of the portal settings .* is an active portal person of its own party/
    const other = await refusal(update('PortalSettings', id, { productionApproverId: U.p3Partner }))
    expect(other).toMatch(words)
    const [names] = await admin(`SELECT code || '|' || "legalName" || '|' || coalesce("tradeName", '') AS words FROM "Party" WHERE id = $1`, [P.p3])
    for (const word of [P.p3, U.p3Partner, ...String(names!.words).split('|').filter((entry) => entry.length > 0)]) expect(other).not.toContain(word)
    await expect(update('PortalSettings', id, { productionApproverId: seeded.userIds.p1Viewer })).rejects.toThrow(words) // INVITED
    await expect(update('PortalSettings', id, { productionApproverId: U.supervisor })).rejects.toThrow(words) // an office person
    await expect(update('PortalSettings', id, { productionApproverId: seeded.userIds.p2Orders })).rejects.toThrow(words) // the supplier's person
    expect(await update('PortalSettings', id, { productionApproverId: null })).toBe(1)
  })

  it('sets the production limits only for a customer or a brand', async () => {
    const supplier = seeded.settingsIds.p2
    const words = /production limits \(urgency, production asks, approver, supervisor, backup\) are set only for a customer or a brand/
    await expect(update('PortalSettings', supplier, { productionUrgencyOn: true })).rejects.toThrow(words)
    await expect(update('PortalSettings', supplier, { productionAskKinds: ['HOLD'] })).rejects.toThrow(words)
    await expect(update('PortalSettings', supplier, { productionSupervisorId: U.supervisor, productionSupervisorSetAt: SET_AT })).rejects.toThrow(words)
    await expect(update('PortalSettings', supplier, { productionApproverId: seeded.userIds.p2Orders })).rejects.toThrow(/approver/)
    // The quota and the second-person switch are plain settings; the supplier's other settings still change.
    expect(await update('PortalSettings', supplier, { productionUrgentMax: 5, overrideFourEyes: true, maxUsers: 4 })).toBe(1)
    expect(await update('PortalSettings', supplier, { productionUrgentMax: 3, overrideFourEyes: false, maxUsers: 3 })).toBe(1)
  })
})

describe("a customer's own freeze rules (B-PR-12)", () => {
  const company = (): string => a.companies[0]!.id
  const rule = async (changes: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'OrderFreezeRule', { id, companyId: company(), field: 'COLOURWAY', frozenFrom: 'CUT', action: 'CHANGE_REQUEST', ...changes })
    return id
  }

  it("keeps one active rule per company, customer (or none), field and stage; the customer's set and the company's are never compared", async () => {
    const companyRule = await rule({ action: 'BLOCKED' })
    // The same field and stage: another one of the company is refused, one of a customer is its own.
    await expect(rule({})).rejects.toThrow(/OrderFreezeRule_one_active|duplicate key/)
    const p1Rule = await rule({ partyId: P.p1 })
    await expect(rule({ partyId: P.p1, action: 'BLOCKED' })).rejects.toThrow(/OrderFreezeRule_one_active|duplicate key/)
    expect(await rule({ partyId: P.p3 })).toBeTruthy()
    // A later stage never loosens an earlier BLOCKED inside one set: the company's BLOCKED from CUT does not bind P1's rules,
    // and P1's own BLOCKED does.
    expect(await rule({ partyId: P.p1, frozenFrom: 'SEWING', action: 'CHANGE_REQUEST' })).toBeTruthy()
    await expect(rule({ frozenFrom: 'SEWING', action: 'CHANGE_REQUEST' })).rejects.toThrow(/would loosen what an earlier stage blocks/)
    expect(await rule({ partyId: P.p1, frozenFrom: 'RELEASED', action: 'BLOCKED', field: 'SHIP_TO' })).toBeTruthy()
    await expect(rule({ partyId: P.p1, frozenFrom: 'FINISHED', action: 'CHANGE_REQUEST', field: 'SHIP_TO' })).rejects.toThrow(/would loosen/)
    // Switched off, another may take its place (a BLOCKED there would loosen nothing but is earlier than P1's change request
    // from SEWING: refused inside P1's set).
    expect(await update('OrderFreezeRule', p1Rule, { active: false })).toBe(1)
    await expect(rule({ partyId: P.p1, action: 'BLOCKED' })).rejects.toThrow(/would loosen/)
    expect(await rule({ partyId: P.p1 })).toBeTruthy()
    expect(companyRule).toBeTruthy()
  })

  it("fixes a rule's customer, and names only a customer or a brand", async () => {
    const companyRule = await rule({ field: 'OPTION' })
    const p1Rule = await rule({ field: 'OPTION', frozenFrom: 'SEWING', partyId: P.p1 })
    await expect(update('OrderFreezeRule', companyRule, { partyId: P.p3 })).rejects.toThrow(/company, field, stage and creation of freeze rule .* never change, nor its customer/)
    await expect(update('OrderFreezeRule', p1Rule, { partyId: null })).rejects.toThrow(/nor its customer/)
    await expect(update('OrderFreezeRule', p1Rule, { partyId: P.p3 })).rejects.toThrow(/nor its customer/)
    await expect(rule({ field: 'DELIVERY_DATE', partyId: P.p2 })).rejects.toThrow(/holds the orders of a customer or a brand/)
    expect(await update('OrderFreezeRule', p1Rule, { note: 'Alpha: from cutting', version: 2 })).toBe(1)
  })
})

describe('the copy step (…_production_brand_limits_copy)', () => {
  it('shows the level PROGRESS where progress is shared, and asks a second person for overrides of the customers listed at release', async () => {
    const copy = readMigrations(MIGRATIONS_DIR).filter((migration) => migration.folder.endsWith('_production_brand_limits_copy'))
    expect(copy).toHaveLength(1)
    // As the schema step leaves them: P1 shares progress at the level STATUS (planted with the triggers off); P3 is listed
    // for a second person at release, P1 is not. B-PR-40 dropped progressShared, which the step reads: it runs on the schema
    // it saw, the column put back inside ONE transaction that is rolled back at the end (the triggers on for the step itself).
    const after = (id: string) => admin(`SELECT "progressShared", "productionLevel"::text AS level, "overrideFourEyes" FROM "PortalSettings" WHERE id = $1`, [id]).then((rows) => rows[0])
    const notices: string[] = []
    const listen = (notice: { message?: string }) => notices.push(notice.message ?? '')
    await db.admin.query('BEGIN')
    try {
      await db.admin.query(`ALTER TABLE "PortalSettings" ADD COLUMN "progressShared" boolean NOT NULL DEFAULT false`)
      await db.admin.query("SET LOCAL session_replication_role = 'replica'")
      await db.admin.query(`UPDATE "PortalSettings" SET "progressShared" = true, "productionLevel" = 'STATUS', "overrideFourEyes" = false WHERE id = ANY($1::uuid[])`, [[seeded.settingsIds.p1, P.p3]])
      await db.admin.query(`UPDATE "PortalSettings" SET "progressShared" = false, "productionLevel" = 'STATUS' WHERE id = $1`, [P.p3])
      await db.admin.query(
        `INSERT INTO "QualitySettings" (id, "tenantId", "companyId", "secondPersonPartyIds") VALUES ($1, $2, $1, ARRAY[$3::uuid])
           ON CONFLICT (id) DO UPDATE SET "secondPersonPartyIds" = EXCLUDED."secondPersonPartyIds"`,
        [a.companies[0]!.id, a.tenantId, P.p3],
      )
      await db.admin.query("SET LOCAL session_replication_role = 'origin'")
      db.admin.on('notice', listen)
      await db.admin.query(copy[0]!.sql)
      expect(notices.at(-1)).toMatch(/^portal \(B-PR-12\): 1 portal setting\(s\) that share production progress now show the level PROGRESS; 1 customer\(s\) listed for a second person at release need one for overrides too/)
      // Run again: it changes nothing (it only raises a default).
      await db.admin.query(copy[0]!.sql)
      expect(notices.at(-1)).toMatch(/: 0 portal setting\(s\) .*; 0 customer\(s\)/)
      expect(await after(seeded.settingsIds.p1)).toMatchObject({ progressShared: true, level: 'PROGRESS', overrideFourEyes: false })
      expect(await after(P.p3)).toMatchObject({ progressShared: false, level: 'STATUS', overrideFourEyes: true })
      expect(await after(seeded.settingsIds.p2)).toMatchObject({ progressShared: false, level: 'STATUS', overrideFourEyes: false })
    } finally {
      db.admin.off('notice', listen)
      await db.admin.query('ROLLBACK')
    }
    // Rolled back: the column is gone again.
    expect(await admin(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PortalSettings' AND column_name = 'progressShared'`)).toEqual([{ n: 0 }])
  })
})
