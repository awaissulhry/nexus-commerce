import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * owb-of1 step 5 (order workflow, plan.md § 5o "Download all = ONE zip of what the reader may open"; settle L5): POST
 * /sales/orders/:orderId/files/zip through the app's real routes, on a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login), the gateway on the local Redis and the FAKE file store in a temporary folder, the core, auth, roles, files,
 * production and numbering seeds (SEED-SO-0002 of the production seed). The test adds on the order: a plain order sheet (its bytes
 * in the store), a PRICED file and a measurement sheet (body data). Written, not run (Owner rule). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/files-zip`.
 *
 *   ZI-1  Sales' zip holds the plain file and no priced file nor body data; `x-left-out` = the Files tab's "you cannot open" count
 *   ZI-2  a price holder who reads measurements gets all three; the body data is named on the ONE audit row
 *   ZI-3  another customer's role 404; neither orders right 403
 */

vi.setConfig({ testTimeout: 180_000 })

const ns = 'owb-of1-files-zip'
const tenant = seedUuid(ns, 'tenant')
const companyA = seedUuid(ns, 'company:A')
const orderId = seedUuid(ns, 'production:sales-order:SO-0002')
const grant = (permissions: readonly string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
const session = (...grants: Grant[]) => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: session(grant(['orders.view', 'files.read'])),
  priced: session(grant(['orders.view', 'files.read', 'sales.measurements.view', grainPermission('price')])),
  other: session(grant(['orders.view', 'files.read'], [seedUuid(ns, 'party:P4')])),
  nobody: session(grant(['home.view', 'files.read'])),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis | undefined
let localRoot = ''
const NAMES = { plain: 'Made-up order sheet.pdf', priced: 'Made-up priced offer.pdf', measure: 'Made-up measurement sheet.pdf' }
const fileIds = { plain: '', priced: '', measure: '' }
let minute = 0

/** A made-up file of the order (the database's file rules apply), its bytes in the fake store. */
async function fileOn(name: string, extra: { readonly priced?: boolean; readonly category?: 'MEASUREMENTS' } = {}): Promise<string> {
  const id = newId()
  const bytes = Buffer.from(`%PDF-1.4 made-up bytes of ${name}`, 'utf8')
  const key = `t/${tenant}/c/${companyA}/2026/${newId()}`
  const at = new Date(Date.now() - 60 * 60_000 + ++minute * 60_000)
  await database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, (client) =>
    client.storedFile.create({
      data: seedFile(tenant, {
        id,
        companyId: companyA,
        recordType: 'SalesOrder',
        recordId: orderId,
        kind: 'DOCUMENT',
        ...(extra.category ? { category: extra.category } : {}),
        ...(extra.priced ? { priced: true } : {}),
        originalName: name,
        contentType: 'application/pdf',
        sizeBytes: bytes.length,
        storeAccountId: seedUuid(ns, 'files:account:r2'),
        storageKey: key,
        status: 'AVAILABLE',
        availableAt: at,
        visibility: ['OFFICE'],
        createdAt: at,
        updatedAt: at,
      }),
      select: { id: true },
    }),
  )
  const path = join(localRoot, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('owb_of1_files_zip')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await db.admin.query(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant])
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-owb-of1-zip-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  fileIds.plain = await fileOn(NAMES.plain)
  fileIds.priced = await fileOn(NAMES.priced, { priced: true })
  fileIds.measure = await fileOn(NAMES.measure, { category: 'MEASUREMENTS' })
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const zipOf = (who: string) => app.inject({ method: 'POST', url: `/sales/orders/${orderId}/files/zip`, payload: {}, headers: { 'x-test-session': who, 'idempotency-key': `owb-zip-${newId()}` } })
/** The Files tab's "you cannot open" count for this reader (the same read the zip is made of). */
async function leftOutOf(who: string): Promise<number> {
  const read = await app.inject({ method: 'GET', url: `/sales/orders/${orderId}/files`, headers: { 'x-test-session': who } })
  expect(read.statusCode, read.body.slice(0, 300)).toBe(200)
  return (read.json().groups as { leftOut: number; measurementsLeftOut: number; pricedLeftOut?: number }[]).reduce((sum, group) => sum + group.leftOut + group.measurementsLeftOut + (group.pricedLeftOut ?? 0), 0)
}

describe('ZI-1 Sales\' zip', () => {
  it('holds the plain file, never the priced one nor the body data; the left-out count is the tab\'s', async () => {
    const answer = await zipOf('sales')
    expect(answer.statusCode, answer.body.slice(0, 300)).toBe(200)
    expect(answer.headers['content-type']).toContain('application/zip')
    const zip = answer.rawPayload.toString('latin1')
    expect(zip.startsWith('PK')).toBe(true)
    expect(zip).toContain(NAMES.plain)
    expect(zip).not.toContain(NAMES.priced)
    expect(zip).not.toContain(NAMES.measure)
    const leftOut = Number(answer.headers['x-left-out'])
    expect(leftOut).toBe(await leftOutOf('sales'))
    expect(leftOut).toBeGreaterThanOrEqual(2)
    const audit = (await db.admin.query(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.files.zip' ORDER BY at DESC LIMIT 1`, [tenant])).rows[0] as { after: { files: number; leftOut: number; fileIds: string[] } }
    expect(audit.after.fileIds).toContain(fileIds.plain)
    expect(audit.after.fileIds).not.toContain(fileIds.priced)
    expect(audit.after.leftOut).toBe(leftOut)
  })
})

describe('ZI-2 a price holder who reads measurements', () => {
  it('gets all three; the body data is named on the audit row', async () => {
    const answer = await zipOf('priced')
    expect(answer.statusCode, answer.body.slice(0, 300)).toBe(200)
    const zip = answer.rawPayload.toString('latin1')
    for (const name of Object.values(NAMES)) expect(zip).toContain(name)
    const audit = (await db.admin.query(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.files.zip' ORDER BY at DESC LIMIT 1`, [tenant])).rows[0] as { after: { bodyDataFileIds: string[] } }
    expect(audit.after.bodyDataFileIds).toEqual([fileIds.measure])
  })
})

describe('ZI-3 the walls', () => {
  it('another customer\'s role 404; neither orders right 403', async () => {
    expect((await zipOf('other')).statusCode).toBe(404)
    expect((await zipOf('nobody')).statusCode).toBe(403)
  })
})
