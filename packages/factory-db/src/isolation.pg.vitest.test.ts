import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed, type CoreSeed } from '../seed/_core'
import { seed as seedAudit } from '../seed/audit'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedImports } from '../seed/imports'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedLinks } from '../seed/links'
import { seed as seedNumbering } from '../seed/numbering'
import { seed as seedOutbox } from '../seed/outbox'
import { seed as seedRoles } from '../seed/roles'
import { seed as seedThreads } from '../seed/threads'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { PLATFORM_ROLE, POLICY_KEYS, RUNTIME_LOGIN, RUNTIME_ROLES, WALL, type PolicyKeyName, type RuntimeRole } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The generated isolation tests (plan A1 §6.7): for EVERY classified table and EVERY runtime role, on a database built
 * from the migrations and seeded twice (tenant A and tenant B, two sites each, one portal party each), through the
 * real login, the audited pool and the scoped client:
 *   - a role with select sees exactly the rows inside its scope (tenant, and site or party where it is scoped by them),
 *     and rows outside it exist, so the wall is really tested;
 *   - it cannot read a hidden column, and Prisma's default select (every column) fails loudly;
 *   - a role with insert cannot insert a row outside its scope (the control insert inside it works; the copied row
 *     gets a new id, and its unique text and number columns new values);
 *   - a role with update changes no row outside its scope and cannot move a row out of it (the control works);
 *   - a role with delete deletes no row outside its scope;
 *   - every privilege the classification does not grant is refused.
 * The cases come from ownership/*.json and the schema: a new model gets its tests without a new line here.
 */

const classified = classifiedModels(loadSchema(), loadOwnership())
const DENIED = /permission denied/
const RLS = /row-level security/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
/** Tenant A's portal party: the audit seed writes its partner rows for it. */
let partyId: string

/** Tenant A's scope for each role; the floor device sits on A's first site. */
function scopeOf(role: RuntimeRole): FactoryScope {
  const base = { tenantId: a.tenantId, actorId: a.actorId }
  if (role === 'factory_runtime') return { audience: 'office', ...base }
  if (role === 'factory_floor_runtime') return { audience: 'floor', ...base, siteId: a.sites[0]!.id }
  if (role === 'factory_partner_runtime') return { audience: 'partner', ...base, partyId }
  return { audience: 'platform' }
}
const keyValue = (key: PolicyKeyName): string => ({ tenant: a.tenantId, site: a.sites[0]!.id, party: partyId })[key]

const as = <T>(role: RuntimeRole, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scopeOf(role), work)
const query = (role: RuntimeRole, sql: string, ...values: unknown[]) => as(role, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values))
const execute = (role: RuntimeRole, sql: string, ...values: unknown[]) => as(role, (client) => client.$executeRawUnsafe(sql, ...values))
const admin = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows as Record<string, unknown>[]
/**
 * Removes a row the test inserted. Append-only tables refuse DELETE for every login (their triggers), so the cleanup
 * runs with triggers off for its own transaction (session_replication_role, superuser only: the test admin).
 */
async function removeRow(table: string, pk: string, id: unknown): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`DELETE FROM ${table} WHERE ${pk} = $1::uuid`, [id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const q = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`)
  return `"${name}"`
}

beforeAll(async () => {
  db = await migratedDatabase('isolation')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seed({ db: factory, namespace: 'iso-a' })
  b = await seed({ db: factory, namespace: 'iso-b' })
  partyId = (await seedAudit({ db: factory, namespace: 'iso-a' })).partyId
  await seedAudit({ db: factory, namespace: 'iso-b' })
  await seedAuth({ db: factory, namespace: 'iso-a' })
  await seedAuth({ db: factory, namespace: 'iso-b' })
  await seedNumbering({ db: factory, namespace: 'iso-a' })
  await seedNumbering({ db: factory, namespace: 'iso-b' })
  await seedOutbox({ db: factory, namespace: 'iso-a' })
  await seedOutbox({ db: factory, namespace: 'iso-b' })
  await seedRoles({ db: factory, namespace: 'iso-a' })
  await seedRoles({ db: factory, namespace: 'iso-b' })
  await seedIntegration({ db: factory, namespace: 'iso-a' })
  await seedIntegration({ db: factory, namespace: 'iso-b' })
  await seedFiles({ db: factory, namespace: 'iso-a' })
  await seedFiles({ db: factory, namespace: 'iso-b' })
  await seedLinks({ db: factory, namespace: 'iso-a' })
  await seedLinks({ db: factory, namespace: 'iso-b' })
  await seedFloorAuth({ db: factory, namespace: 'iso-a' })
  await seedFloorAuth({ db: factory, namespace: 'iso-b' })
  await seedThreads({ db: factory, namespace: 'iso-a' })
  await seedThreads({ db: factory, namespace: 'iso-b' })
  await seedImports({ db: factory, namespace: 'iso-a' })
  await seedImports({ db: factory, namespace: 'iso-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

it('covers every classified table and every runtime role', () => {
  expect(classified.map(({ model }) => model.name).sort()).toEqual([
    'AuditLog',
    'Badge',
    'Company',
    'Device',
    'DeviceEnrolment',
    'FloorSession',
    'FloorSettings',
    'IdempotencyReceipt',
    'ImportJob',
    'ImportRow',
    'InboundWebhook',
    'IntegrationAccount',
    'IntegrationCall',
    'Invitation',
    'Line',
    'LinkEvidence',
    'Message',
    'NumberAllocation',
    'NumberSeries',
    'OneOffLink',
    'OutboxEvent',
    'PasswordReset',
    'Role',
    'RoleAssignment',
    'SecretValue',
    'Session',
    'Site',
    'Station',
    'StoredFile',
    'Tenant',
    'Thread',
    'User',
    'WorkCentre',
    'Worker',
    'WorkerRole',
  ])
  expect(RUNTIME_ROLES).toHaveLength(4)
  expect(a.tenantId).not.toBe(b.tenantId)
})

describe.each(classified)('$model.name', ({ model, ownership }) => {
  const table = q(model.table)
  const pk = model.uniques[0]?.[0] as string
  const keyColumns = ownership.keyColumns ?? {}

  describe.each([...RUNTIME_ROLES])('as %s', (role) => {
    const access = ownership.access[role]
    const privileges = new Set(access?.privileges ?? [])
    const hidden = new Set(access?.hiddenColumns ?? [])
    const visible = model.columns.filter((column) => !hidden.has(column))
    // The platform role has no tenant: its policies see every row.
    const keys: PolicyKeyName[] = role === PLATFORM_ROLE ? [] : [...WALL, ...((access?.scopedBy ?? []) as PolicyKeyName[])]
    // The values exist only once the seed ran, so they are read inside the tests.
    const filter = keys.map((key) => ({ column: keyColumns[key] as string, type: POLICY_KEYS[key].type, value: () => keyValue(key) }))
    const inside = filter.map((entry, index) => `${q(entry.column)} = $${index + 1}::${entry.type}`).join(' AND ') || 'true'
    const values = () => filter.map((entry) => entry.value())
    /** The first row matching `where`, whose `$n` parameters are the scope's values (or `params`, when given). */
    const rowOf = async (where: string, params: unknown[] = values()): Promise<Record<string, unknown>> => {
      const [row] = await admin(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where} ORDER BY ${q(pk)} LIMIT 1`, params)
      expect(row, `a ${model.name} row ${where}`).toBeDefined()
      return row!.row as Record<string, unknown>
    }
    /** A copy of a row that breaks no unique key: a new id, and every unique text column suffixed (a NULL stays NULL). */
    const copyOf = (row: Record<string, unknown>): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...row, [pk]: randomUUID() }
      for (const unique of model.uniques) {
        for (const column of unique) {
          const field = model.fields.find((entry) => entry.column === column)
          if (field?.type === 'String' && field.nativeType !== 'Uuid' && row[column] !== null) copy[column] = `${String(row[column])}-copy-${randomUUID().slice(0, 8)}`
          // A number in a unique key (a row number) moves out of the seeded range.
          if (field?.type === 'Int' && row[column] !== null) copy[column] = Number(row[column]) + 1_000_000
        }
      }
      return copy
    }
    const insert = (copy: Record<string, unknown>) =>
      execute(role, `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, JSON.stringify(copy))

    if (!access) {
      it('has no privilege at all', async () => {
        await expect(query(role, `SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
        await expect(execute(role, `INSERT INTO ${table} (${q(pk)}) VALUES (NULL)`)).rejects.toThrow(DENIED)
        await expect(execute(role, `UPDATE ${table} SET ${q(pk)} = ${q(pk)} WHERE false`)).rejects.toThrow(DENIED)
        await expect(execute(role, `DELETE FROM ${table} WHERE false`)).rejects.toThrow(DENIED)
      })
      return
    }

    if (privileges.has('select')) {
      it(`reads exactly the rows inside its scope (${keys.join(', ') || 'every row'})`, async () => {
        expect(visible).toContain(pk)
        const seen = await query(role, `SELECT ${q(pk)}::text AS id FROM ${table}`)
        const expected = await admin(`SELECT ${q(pk)}::text AS id FROM ${table} WHERE ${inside}`, values())
        expect(expected.length).toBeGreaterThan(0)
        expect(seen.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort())
        // Not vacuous: for every key of the scope, rows on the other side of it exist and stay hidden.
        for (const entry of filter) {
          const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM ${table} WHERE ${q(entry.column)} <> $1::${entry.type}`, [entry.value()])) as [{ n: number }]
          expect(n, `${model.name} rows outside ${entry.column}`).toBeGreaterThan(0)
        }
        if (filter.length === 0) expect(new Set(seen.map((row) => row.id)).size).toBe((await admin(`SELECT 1 FROM ${table}`)).length)
      })

      if (hidden.size > 0) {
        it(`cannot read its hidden columns (${[...hidden].join(', ')})`, async () => {
          for (const column of hidden) await expect(query(role, `SELECT ${q(column)} FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
          const delegate = (client: FactoryClient) =>
            (client as unknown as Record<string, { findMany: (args?: unknown) => Promise<unknown[]> }>)[model.name[0]!.toLowerCase() + model.name.slice(1)]!
          // Prisma's default select names every column, so a forgotten `select` fails loudly.
          await expect(as(role, (client) => delegate(client).findMany())).rejects.toThrow(DENIED)
          const rows = await as(role, (client) => delegate(client).findMany({ select: Object.fromEntries(visible.map((column) => [column, true])) }))
          expect(rows.length).toBeGreaterThan(0)
        })
      }
    } else {
      it('cannot select', async () => {
        await expect(query(role, `SELECT ${q(pk)} FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('insert')) {
      it('cannot insert a row outside its scope; the same insert inside it works', async () => {
        if (filter.length > 0) await expect(insert(copyOf(await rowOf(`NOT (${inside})`)))).rejects.toThrow(RLS)
        const own = copyOf(await rowOf(inside))
        expect(await insert(own)).toBe(1)
        await removeRow(table, q(pk), own[pk])
      })
    } else {
      it('cannot insert', async () => {
        await expect(execute(role, `INSERT INTO ${table} (${q(pk)}) VALUES (NULL)`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('update')) {
      it('updates no row outside its scope and cannot move a row out of it', async () => {
        const column = q(visible.find((name) => name !== pk && !Object.values(keyColumns).includes(name)) ?? pk)
        const touch = (id: unknown) => execute(role, `UPDATE ${table} SET ${column} = ${column} WHERE ${q(pk)} = $1::uuid`, id)
        const own = await rowOf(inside)
        expect(await touch(own[pk])).toBe(1)
        if (filter.length > 0) {
          const other = await rowOf(`NOT (${inside})`)
          expect(await touch(other[pk])).toBe(0)
          for (const entry of filter) {
            const away = await rowOf(`${q(entry.column)} <> $1::${entry.type}`, [entry.value()])
            await expect(
              execute(role, `UPDATE ${table} SET ${q(entry.column)} = $1::${entry.type} WHERE ${q(pk)} = $2::uuid`, away[entry.column], own[pk]),
            ).rejects.toThrow(RLS)
          }
        }
      })
    } else {
      it('cannot update', async () => {
        await expect(execute(role, `UPDATE ${table} SET ${q(pk)} = ${q(pk)} WHERE false`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('delete')) {
      it('deletes no row outside its scope', async () => {
        if (filter.length === 0) return
        const other = await rowOf(`NOT (${inside})`)
        expect(await execute(role, `DELETE FROM ${table} WHERE ${q(pk)} = $1::uuid`, other[pk])).toBe(0)
      })
    } else {
      it('cannot delete', async () => {
        await expect(execute(role, `DELETE FROM ${table} WHERE false`)).rejects.toThrow(DENIED)
      })
    }
  })
})
