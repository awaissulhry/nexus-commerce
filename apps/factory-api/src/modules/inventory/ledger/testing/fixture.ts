import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../../core/app'
import { callerFor, type CommandCaller } from '../../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'
import { systemContext } from '../../../../platform/outbox/system'

/**
 * The inventory module's PostgreSQL test fixture (imported by tests only): a throwaway database from the migrations, the
 * runtime login through the scoped clients (row-level security, the column grants and the …_supply_guards triggers are
 * real), the app's real routes, and made-up master data:
 *
 *   tenant A  company A (sites A1 and A2), company A2 (site C1); tenant B  company B (site B1)
 *   items     LEATHER (hide by hide, ft², standard cost 6.25), LINING (by lot, m, 3.10), PROTECTOR (untracked, pieces,
 *             4.00), THREAD (untracked, cones, no standard cost); tenant B: its own LINING
 *   lots      leather RELEASED (hides H1 53.2 ft², H2 51.8 ft²) and QUARANTINE (hide H3 40 ft²); lining RELEASED
 *   locations A1: STORE with BIN-01 and BIN-02 inside, CUT; A2: STORE; C1: STORE; B1: STORE (no stock anywhere yet)
 *   devices   one at A1, one at A2 (floor sessions)
 *
 * Every name and code is invented. Sessions by the `x-test-session` header: see SESSIONS.
 */

type Json = Record<string, any>

export const ALL_INVENTORY: Permission[] = [
  'inventory.locations.view',
  'inventory.locations.manage',
  'inventory.stock.view',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.scrap',
  'inventory.reverse',
]

export interface InventoryFixture {
  readonly db: MigratedDatabase
  readonly database: FactoryDatabase
  readonly app: FastifyInstance
  readonly ids: ReturnType<typeof makeIds>
  admin<T = Json>(sql: string, values?: unknown[]): Promise<T[]>
  call(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key?: string): Promise<LightMyRequestResponse>
  /** command()'s caller for a session of SESSIONS (or the system of a tenant). */
  caller(session: string): CommandCaller
  system(tenant?: 'A' | 'B'): CommandCaller
  close(): Promise<void>
}

function makeIds() {
  return {
    tenantA: newId(),
    tenantB: newId(),
    companyA: newId(),
    companyA2: newId(),
    companyB: newId(),
    siteA1: newId(),
    siteA2: newId(),
    siteC1: newId(),
    siteB1: newId(),
    user: newId(),
    worker: newId(),
    deviceA1: newId(),
    deviceA2: newId(),
    leather: newId(),
    lining: newId(),
    protector: newId(),
    thread: newId(),
    liningB: newId(),
    leatherBlack: newId(),
    liningGrey: newId(),
    leatherLot: newId(),
    quarantineLot: newId(),
    liningLot: newId(),
    hide1: newId(),
    hide2: newId(),
    hide3: newId(),
    store: newId(),
    bin1: newId(),
    bin2: newId(),
    cut: newId(),
    storeA2: newId(),
    storeC1: newId(),
    storeB: newId(),
  }
}

const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })

function sessions(ids: ReturnType<typeof makeIds>): Record<string, SessionContext> {
  const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: ids.user, grants })
  const floor = (siteId: string, deviceId: string, companyId: string): SessionContext => ({
    audience: 'floor',
    tenantId: ids.tenantA,
    actorId: ids.worker,
    siteId,
    deviceId,
    grants: [grant(['inventory.locations.view', 'inventory.transfer'], [companyId], [siteId])],
  })
  return {
    /** Every inventory permission and the cost grain. */
    manager: office(ids.tenantA, [grant([...ALL_INVENTORY, 'money.cost'])]),
    /** Every inventory permission, no cost grain (the warehouse role). */
    warehouse: office(ids.tenantA, [grant(ALL_INVENTORY)]),
    viewer: office(ids.tenantA, [grant(['inventory.locations.view', 'inventory.stock.view'])]),
    /** Company A2 only. */
    'company-two': office(ids.tenantA, [grant([...ALL_INVENTORY, 'money.cost'], [ids.companyA2])]),
    'floor-a1': floor(ids.siteA1, ids.deviceA1, ids.companyA),
    'floor-a2': floor(ids.siteA2, ids.deviceA2, ids.companyA),
    'manager-b': office(ids.tenantB, [grant([...ALL_INVENTORY, 'money.cost'])]),
  }
}

export async function startInventoryFixture(label: string): Promise<InventoryFixture> {
  const ids = makeIds()
  const SESSIONS = sessions(ids)
  const db = await migratedDatabase(label)
  const database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

  for (const [tenantId, slug, companies] of [
    [ids.tenantA, 'inv-a', [[ids.companyA, [[ids.siteA1, 'A1'], [ids.siteA2, 'A2']]], [ids.companyA2, [[ids.siteC1, 'C1']]]]],
    [ids.tenantB, 'inv-b', [[ids.companyB, [[ids.siteB1, 'B1']]]]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [companyId, sites] of companies) {
      await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, 'Pelli Inventate S.r.l.')`, [companyId, tenantId, `${slug}-${companyId.slice(-4)}`])
      for (const [siteId, code] of sites) {
        await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [siteId, tenantId, companyId, code])
      }
    }
  }
  const item = (id: string, tenantId: string, code: string, kind: string, tracking: string, uom: string, standardCost: string | null) =>
    admin(
      `INSERT INTO "Item" (id, "tenantId", code, name, kind, tracking, "baseUom", "purchaseUom", "consumptionUom", "standardCost")
       VALUES ($1, $2, $3, $3, $4::"ItemKind", $5::"ItemTracking", $6::"Uom", $6::"Uom", $6::"Uom", $7)`,
      [id, tenantId, code, kind, tracking, uom, standardCost],
    )
  await item(ids.leather, ids.tenantA, 'TEST-LEATHER', 'LEATHER', 'HIDE', 'FT2', '6.25')
  await item(ids.lining, ids.tenantA, 'TEST-LINING', 'LINING', 'LOT', 'M', '3.10')
  await item(ids.protector, ids.tenantA, 'TEST-PROTECTOR', 'PROTECTOR', 'NONE', 'PCS', '4.00')
  await item(ids.thread, ids.tenantA, 'TEST-THREAD', 'THREAD', 'NONE', 'CONE', null)
  await item(ids.liningB, ids.tenantB, 'TEST-LINING', 'LINING', 'LOT', 'M', '3.10')
  await admin(`INSERT INTO "ItemColour" (id, "tenantId", "itemId", code, name) VALUES ($1, $2, $3, 'BLK', 'Black'), ($4, $2, $5, 'GRY', 'Grey')`, [ids.leatherBlack, ids.tenantA, ids.leather, ids.liningGrey, ids.lining])

  const lot = (id: string, siteId: string, itemId: string, colourId: string, code: string, status: 'RELEASED' | 'QUARANTINE') =>
    admin(
      `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LotQualityStatus", $9)`,
      [id, ids.tenantA, ids.companyA, siteId, itemId, colourId, code, status, status === 'RELEASED' ? new Date('2026-10-01T08:00:00Z') : null],
    )
  await lot(ids.leatherLot, ids.siteA1, ids.leather, ids.leatherBlack, 'TEST-LOT-LEA-1', 'RELEASED')
  await lot(ids.quarantineLot, ids.siteA1, ids.leather, ids.leatherBlack, 'TEST-LOT-LEA-2', 'QUARANTINE')
  await lot(ids.liningLot, ids.siteA1, ids.lining, ids.liningGrey, 'TEST-LOT-LIN-1', 'RELEASED')
  for (const [id, lotId, code, area] of [
    [ids.hide1, ids.leatherLot, 'TEST-HIDE-1', '53.2'],
    [ids.hide2, ids.leatherLot, 'TEST-HIDE-2', '51.8'],
    [ids.hide3, ids.quarantineLot, 'TEST-HIDE-3', '40'],
  ] as const) {
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [id, ids.tenantA, ids.siteA1, lotId, ids.leather, code, area])
  }

  const location = (id: string, tenantId: string, companyId: string, siteId: string, code: string, kind: string, parentId: string | null = null) =>
    admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", "parentId", code, name, kind) VALUES ($1, $2, $3, $4, $5, $6, $6, $7::"LocationKind")`, [id, tenantId, companyId, siteId, parentId, code, kind])
  await location(ids.store, ids.tenantA, ids.companyA, ids.siteA1, 'A1-STORE', 'WAREHOUSE')
  await location(ids.bin1, ids.tenantA, ids.companyA, ids.siteA1, 'A1-BIN-01', 'BIN', ids.store)
  await location(ids.bin2, ids.tenantA, ids.companyA, ids.siteA1, 'A1-BIN-02', 'BIN', ids.store)
  await location(ids.cut, ids.tenantA, ids.companyA, ids.siteA1, 'A1-CUT', 'PRODUCTION')
  await location(ids.storeA2, ids.tenantA, ids.companyA, ids.siteA2, 'A2-STORE', 'WAREHOUSE')
  await location(ids.storeC1, ids.tenantA, ids.companyA2, ids.siteC1, 'C1-STORE', 'WAREHOUSE')
  await location(ids.storeB, ids.tenantB, ids.companyB, ids.siteB1, 'B1-STORE', 'WAREHOUSE')
  for (const [id, siteId] of [
    [ids.deviceA1, ids.siteA1],
    [ids.deviceA2, ids.siteA2],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name) VALUES ($1, $2, $3, $4, 'Test tablet')`, [id, ids.tenantA, ids.companyA, siteId])
  }

  const app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  return {
    db,
    database,
    app,
    ids,
    admin,
    call: (session, method, url, payload, key) =>
      app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    caller: (session) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as RequestContext),
    system: (tenant = 'A') => callerFor(database, systemContext(tenant === 'A' ? ids.tenantA : ids.tenantB, newId())),
    async close() {
      await app?.close()
      await database?.close()
      await db?.close()
    },
  }
}
