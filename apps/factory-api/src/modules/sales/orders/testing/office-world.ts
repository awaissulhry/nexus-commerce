import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../../packages/factory-db/seed/_core'
import { seed as seedPortalSales } from '../../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedProduct } from '../../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'

/**
 * owb-of1 (order workflow): ONE small world for the office orders tests (sheet, band, restrict, notices) — a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security is real), the factory-db seeds up to the customer portal
 * (SEED-SO-0001/-0002/-0003 are customer P1's; SEED-RQ-0001 a SENT request of P1, SEED-RQ-0002 the ACCEPTED one SEED-SO-0002 came
 * from, SEED-RQ-0003 a REFUSED one), the real app with test sessions of real office users. Rows a test needs are planted with the
 * database's rules off (what the reads read is tested). Every name is made up.
 */

export type Json = Record<string, any>

export const OFFICE_PEOPLE = ['sales', 'priced', 'onlyP4', 'designer', 'nobody'] as const
export type OfficeKey = (typeof OFFICE_PEOPLE)[number]

// The office role "Factory designer" as the base left it (factory-domain auth/roles/templates.ts `designer`).
export const DESIGNER_PERMISSIONS = ['home.view', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'parties.view', 'orders.view.own', 'tasks.manage'] as Permission[]

export interface OfficeWorld {
  readonly db: MigratedDatabase
  readonly database: FactoryDatabase
  readonly app: FastifyInstance
  readonly tenant: string
  readonly people: Readonly<Record<OfficeKey, string>>
  readonly ids: { readonly so1: string; readonly so2: string; readonly so3: string; readonly rq1: string; readonly rq2: string; readonly rq3: string; readonly company: string; readonly p1: string; readonly p4: string }
  get(who: OfficeKey, url: string): ReturnType<FastifyInstance['inject']>
  post(who: OfficeKey, url: string, payload?: unknown): ReturnType<FastifyInstance['inject']>
  admin<T = Json>(sql: string, values?: unknown[]): Promise<T[]>
  /** Rows written with the database's rules off (replica). */
  planted(rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void>
  close(): Promise<void>
}

export async function officeWorld(name: string): Promise<OfficeWorld> {
  const ns = `owb-of1-${name}`
  const tenant = seedUuid(ns, 'tenant')
  const db = await migratedDatabase(`owb_of1_${name.replace(/[^a-z0-9]/gi, '_')}`)
  const database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduct({ db: database, namespace: ns })
  await seedPortalSales({ db: database, namespace: ns })
  const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
  const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
  const planted = async (rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void> => {
    await db.admin.query('BEGIN')
    try {
      await db.admin.query("SET LOCAL session_replication_role = 'replica'")
      for (const row of rows) await db.admin.query(row.sql, row.values)
      await db.admin.query('COMMIT')
    } catch (error) {
      await db.admin.query('ROLLBACK')
      throw error
    }
  }
  const order = (number: string) => one<{ id: string; companyId: string; partyId: string }>(`SELECT id, "companyId", "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [tenant, number])
  const request = async (number: string) => (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = $2`, [tenant, number])).id
  const so1 = await order('SEED-SO-0001')
  const ids = {
    so1: so1.id,
    so2: (await order('SEED-SO-0002')).id,
    so3: (await order('SEED-SO-0003')).id,
    rq1: await request('SEED-RQ-0001'),
    rq2: await request('SEED-RQ-0002'),
    rq3: await request('SEED-RQ-0003'),
    company: so1.companyId,
    p1: so1.partyId,
    p4: seedUuid(ns, 'party:P4'),
  }
  const people = Object.fromEntries(OFFICE_PEOPLE.map((key) => [key, newId()])) as Record<OfficeKey, string>
  await planted(
    OFFICE_PEOPLE.map((key) => ({
      sql: `INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, 'ACTIVE', 'OFFICE')`,
      values: [people[key], tenant, `of1.${name}.${key}@example.com`, `Made-up ${key}`],
    })),
  )
  const grant = (permissions: readonly string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
  const SESSIONS: Record<OfficeKey, () => SessionContext> = {
    // The Sales template's order rights (no grain: no price).
    sales: () => ({ audience: 'office', tenantId: tenant, actorId: people.sales, grants: [grant(['orders.view', 'orders.manage', 'workorders.view', 'files.read', 'threads.read', 'threads.post', 'sales.inquiries.view'])] }),
    // Someone who sees prices and records payments (the Owner's or Finance's rights for these reads).
    priced: () => ({ audience: 'office', tenantId: tenant, actorId: people.priced, grants: [grant(['orders.view', 'orders.manage', 'payments.record', 'files.read', 'threads.read', 'money.price'])] }),
    // Sales limited to another customer (P4).
    onlyP4: () => ({ audience: 'office', tenantId: tenant, actorId: people.onlyP4, grants: [grant(['orders.view', 'orders.manage', 'files.read', 'threads.read'], [ids.p4])] }),
    designer: () => ({ audience: 'office', tenantId: tenant, actorId: people.designer, grants: [grant(DESIGNER_PERMISSIONS)] }),
    nobody: () => ({ audience: 'office', tenantId: tenant, actorId: people.nobody, grants: [grant(['home.view'])] }),
  }
  const app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as OfficeKey]?.() ?? null) },
  )
  const run = randomBytes(4).toString('hex')
  let serial = 0
  return {
    db,
    database,
    app,
    tenant,
    people,
    ids,
    get: (who, url) => app.inject({ method: 'GET', url, headers: { 'x-test-session': who } }),
    post: (who, url, payload) => app.inject({ method: 'POST', url, payload: (payload ?? {}) as object, headers: { 'x-test-session': who, 'idempotency-key': `owb-of1-${run}-${++serial}` } }),
    admin,
    planted,
    async close() {
      await app.close()
      await database.close()
      await db.close()
    },
  }
}

/** A row's keys anywhere in an answer (the money wall: no price, cost or amount key reaches a reader of the sheet). */
export function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysIn(item, out)
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) {
    out.add(key)
    keysIn(inner, out)
  }
  return out
}

export const MONEY_KEY = /price|amount|cost|margin|total/i
