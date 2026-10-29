import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { formatScanId, parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { seed as seedCore, type CoreSeed } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedFloorAuth } from '../../../../../packages/factory-db/seed/floor-auth'
import { seed as seedNumberingBlocks } from '../../../../../packages/factory-db/seed/numbering-blocks'
import { buildApp } from '../../core/app'
import { callerFor, command, type CommandTools } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { systemContext } from '../outbox/system'
import { allocateNumber } from './allocate'
import { allocateScanIds, closeBlock, reserveBlock, ScanIdsRefusedError, topUpBlocks, useScanIds, type BlockView } from './scan-ids'

/**
 * Floor numbering on the local stack (a throwaway PostgreSQL 17 database built from the migrations, the runtime login
 * through the scoped clients): the scan-id kinds' ONE tenant-wide counter (allocateScanIds, online, for the office, the
 * worker and the tablets alike), the tablets' own blocks (top-up, the office's reserve and close), the numbers a tablet
 * used (useScanIds: inside its own blocks, once each), the guard triggers for every login, and the routes.
 *
 * Seeds: _core, auth, floor-auth and numbering-blocks for two tenants. Each tenant's tablets A1 and B1 hold the seeded
 * blocks BUNDLE and HIDE 1–200 (A1) and 201–400 (B1), GARMENT_SERIAL 1–500 and 501–1000; hide tags 1 and 2 of A1's
 * block and 201 of B1's are used.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let a: CoreSeed
let b: CoreSeed
let tabletA1: string
let tabletB1: string
let workerA1: string
let siteA1: string
let siteB1: string

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const all: Grant = { permissions: ['numbering.view', 'numbering.manage'], companies: 'all', sites: 'all', parties: 'all' }
const floorWork: Grant = { permissions: ['floor.work'], companies: 'all', sites: 'all', parties: 'all' }

const office = (seed: CoreSeed = a): RequestContext => ({ audience: 'office', tenantId: seed.tenantId, actorId: seed.actorId, grants: [all], requestId: newId() })
const floor = (deviceId: string, siteId: string, seed: CoreSeed = a): RequestContext =>
  ({ audience: 'floor', tenantId: seed.tenantId, actorId: workerA1, siteId, deviceId, grants: [floorWork], requestId: newId() }) as RequestContext
const as = (context: RequestContext) => callerFor(database, context)

/** One command in the context, with a key (floor writes need one) and an audit row. */
async function run<T>(context: RequestContext, work: (tools: CommandTools) => Promise<T>): Promise<T> {
  const { result } = await command(as(context), { name: 'test.numbering', idempotencyKey: newId(), input: { at: newId() } }, async (tools) => {
    const out = await work(tools)
    tools.audit({ recordType: 'Test', recordId: newId(), after: { ok: true } })
    return out
  })
  return result
}

const code = (kind: ScanIdKind, ref: number, seed: CoreSeed = a) => formatScanId({ type: kind === 'GARMENT_SERIAL' ? 'SERIAL' : kind, tenantTag: tenantTag(seed.tenantId), ref })
const refOf = (text: string) => {
  const parsed = parseScanId(text)
  return parsed.ok ? parsed.ref : -1
}
const highest = async (kind: ScanIdKind, seed: CoreSeed = a) =>
  (await admin<{ highest: number }>('SELECT max("toRef")::int AS highest FROM "NumberBlock" WHERE "tenantId" = $1 AND kind = $2::"NumberKind"', [seed.tenantId, kind]))[0]!.highest
const usesOf = (deviceId: string) => admin<{ code: string; ref: number; siteId: string }>('SELECT code, ref, "siteId"::text AS "siteId" FROM "NumberBlockUse" WHERE "deviceId" = $1 ORDER BY ref', [deviceId])

/** A tablet of the tenant's site, ACTIVE unless said. */
async function newTablet(siteId: string, companyId: string, status = 'ACTIVE', seed: CoreSeed = a): Promise<string> {
  const id = newId()
  await admin('INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, status) VALUES ($1, $2, $3, $4, $5, $6::"DeviceStatus")', [id, seed.tenantId, companyId, siteId, `Test tablet ${id.slice(-4)}`, status])
  return id
}

/** Lets the first `count` callers through only together. */
function together(count: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return () => {
    arrived++
    if (arrived === count) release()
    return arrived <= count ? gate : Promise.resolve()
  }
}

let sessions: Record<string, SessionContext> = {}
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })

beforeAll(async () => {
  db = await migratedDatabase('numbering_floor')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  a = await seedCore({ db: database, namespace: 'fnum-a' })
  b = await seedCore({ db: database, namespace: 'fnum-b' })
  for (const namespace of ['fnum-a', 'fnum-b']) await seedAuth({ db: database, namespace })
  const floorA = await seedFloorAuth({ db: database, namespace: 'fnum-a' })
  await seedFloorAuth({ db: database, namespace: 'fnum-b' })
  for (const namespace of ['fnum-a', 'fnum-b']) await seedNumberingBlocks({ db: database, namespace })
  ;[tabletA1, tabletB1] = floorA.deviceIds as [string, string]
  workerA1 = floorA.workerIds[0]!
  siteA1 = a.sites.find((site) => site.code === 'A1')!.id
  siteB1 = a.sites.find((site) => site.code === 'B1')!.id
  sessions = {
    admin: { audience: 'office', tenantId: a.tenantId, actorId: a.actorId, grants: [all] },
    'admin-b': { audience: 'office', tenantId: b.tenantId, actorId: b.actorId, grants: [all] },
    'admin-company-b': { audience: 'office', tenantId: a.tenantId, actorId: a.actorId, grants: [{ ...all, companies: [a.companies[1]!.id] }] },
    viewer: { audience: 'office', tenantId: a.tenantId, actorId: a.actorId, grants: [{ ...all, permissions: ['numbering.view'] }] },
    'tablet-a1': { audience: 'floor', tenantId: a.tenantId, actorId: workerA1, siteId: siteA1, deviceId: tabletA1, grants: [floorWork] },
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions[String(request.headers['x-test-session'])] ?? null) },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('allocateScanIds: online numbers from the tenant-wide counter', () => {
  it('gives the office, the worker and a tablet the next numbers of the tenant; another tenant counts on its own', async () => {
    expect(await highest('HIDE')).toBe(400)
    const byOffice = await run(office(), (tools) => allocateScanIds(tools, 'HIDE', 3))
    expect(byOffice.codes.map(refOf)).toEqual([401, 402, 403])
    expect(byOffice.codes[0]).toBe(code('HIDE', 401))
    const byTablet = await run(floor(tabletA1, siteA1), (tools) => allocateScanIds(tools, 'HIDE', 2))
    expect(byTablet.codes.map(refOf)).toEqual([404, 405])
    const byWorker = await run(systemContext(a.tenantId, newId()), (tools) => allocateScanIds(tools, 'HIDE', 1))
    expect(byWorker.codes.map(refOf)).toEqual([406])
    const otherTenant = await run(office(b), (tools) => allocateScanIds(tools, 'HIDE', 1))
    expect(otherTenant.codes).toEqual([code('HIDE', 401, b)])
    // Each is one ONLINE block of the ledger, naming no tablet.
    expect(await admin('SELECT purpose, "fromRef", "toRef", "deviceId" FROM "NumberBlock" WHERE id = $1', [byTablet.blockId])).toEqual([{ purpose: 'ONLINE', fromRef: 404, toRef: 405, deviceId: null }])
  })

  it('never gives two sites, tablets or the office the same number, also all at once (30 commands)', async () => {
    const start = await highest('GARMENT_SERIAL')
    const hold = together(10)
    const contexts = [office(), floor(tabletA1, siteA1), floor(tabletB1, siteB1)]
    const batches = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        run(contexts[index % 3]!, async (tools) => {
          await hold()
          return allocateScanIds(tools, 'GARMENT_SERIAL', 1 + (index % 3))
        }),
      ),
    )
    const refs = batches.flatMap((batch) => batch.codes.map(refOf)).sort((x, y) => x - y)
    // 10 × (1 + 2 + 3) numbers, each once, without a gap.
    expect(refs).toEqual(Array.from({ length: 60 }, (_, index) => start + 1 + index))
  })

  it('takes nothing for a command that rolls back', async () => {
    const start = await highest('BUNDLE')
    await expect(
      run(floor(tabletA1, siteA1), async (tools) => {
        await allocateScanIds(tools, 'BUNDLE', 5)
        throw new Error('the printer caught fire')
      }),
    ).rejects.toThrow('the printer caught fire')
    expect((await run(office(), (tools) => allocateScanIds(tools, 'BUNDLE', 1))).codes.map(refOf)).toEqual([start + 1])
  })

  it('is the only way to a scan-id kind: allocateNumber refuses one, and no series of one can exist', async () => {
    await expect(run(office(), (tools) => allocateNumber(tools, { companyId: a.companies[0]!.id, kind: 'HIDE' }, { type: 'Hide', id: newId() }))).rejects.toThrow(ApiError)
    await expect(
      admin('INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, \'BUNDLE\', \'MAIN\', \'ALL\', \'NEVER\', \'BN-{N:6}\', false)', [newId(), a.tenantId, a.companies[0]!.id]),
    ).rejects.toThrow('scan-id kind')
    await expect(run(office(), (tools) => allocateScanIds(tools, 'LOT' as ScanIdKind, 1))).rejects.toThrow(ApiError)
    const response = await call('admin', 'POST', '/numbering/series', { companyId: a.companies[0]!.id, kind: 'HIDE', reset: 'NEVER' })
    expect(response.statusCode).toBe(400)
  })
})

describe("a tablet's blocks", () => {
  it('top-up: a new tablet gets a block of every kind, then one more only when low, never more than three live', async () => {
    const tablet = await newTablet(siteA1, a.companies[0]!.id)
    const first = await topUpBlocks(as(floor(tablet, siteA1)), undefined, newId())
    expect(first.scanTag).toBe(tenantTag(a.tenantId))
    expect(first.reserved.map((block) => [block.kind, block.size, block.used])).toEqual([
      ['BUNDLE', 200, 0],
      ['HIDE', 200, 0],
      ['GARMENT_SERIAL', 500, 0],
    ])
    for (const block of first.reserved) expect(block.fromRef).toBeGreaterThan(400)
    expect(first.blocks).toHaveLength(3)
    // Enough left: nothing reserved, the check is audited.
    const enough = await topUpBlocks(as(floor(tablet, siteA1)), [{ kind: 'HIDE' }], newId())
    expect(enough.reserved).toEqual([])
    expect(await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [tablet, 'numbering.topUpChecked'])).toHaveLength(1)
    // The tablet printed labels it has not sent: its own count says 10 left.
    const low = await topUpBlocks(as(floor(tablet, siteA1)), [{ kind: 'HIDE', remaining: 10 }], newId())
    expect(low.reserved.map((block) => [block.kind, block.size])).toEqual([['HIDE', 200]])
    expect((await topUpBlocks(as(floor(tablet, siteA1)), [{ kind: 'HIDE', remaining: 10 }], newId())).reserved).toHaveLength(1)
    // Three live HIDE blocks: no fourth.
    expect((await topUpBlocks(as(floor(tablet, siteA1)), [{ kind: 'HIDE', remaining: 0 }], newId())).reserved).toEqual([])
    expect((await admin('SELECT count(*)::int AS n FROM "NumberBlock" WHERE "deviceId" = $1 AND kind = \'HIDE\'', [tablet]))[0]).toEqual({ n: 3 })
    // Every reservation is audited on its block.
    expect(await admin('SELECT count(*)::int AS n FROM "AuditLog" WHERE action = \'numbering.reserveBlock\' AND after->>\'deviceId\' = $1', [tablet])).toEqual([{ n: 5 }])
  })

  it('the office reserves a block for an active tablet it may manage, and closes one with a reason', async () => {
    const block = await reserveBlock(as(office()), { deviceId: tabletA1, kind: 'GARMENT_SERIAL', size: 50 }, newId())
    expect(block).toMatchObject({ kind: 'GARMENT_SERIAL', deviceId: tabletA1, size: 50, used: 0, remaining: 50, status: 'ACTIVE' })
    const pending = await newTablet(siteA1, a.companies[0]!.id, 'PENDING')
    await expect(reserveBlock(as(office()), { deviceId: pending, kind: 'HIDE' }, newId())).rejects.toThrow('only an enrolled, active tablet gets numbers')
    await expect(reserveBlock(as(office(b)), { deviceId: tabletA1, kind: 'HIDE' }, newId())).rejects.toBeInstanceOf(NotFoundError)
    const closed = await closeBlock(as(office()), block.id, { reason: 'Tablet retired', version: block.version }, newId())
    expect(closed).toMatchObject({ status: 'CLOSED', closedReason: 'Tablet retired', remaining: 0 })
    await expect(closeBlock(as(office()), block.id, { reason: 'Again', version: closed.version }, newId())).rejects.toThrow('closed already')
  })
})

describe('useScanIds: the numbers a tablet printed from its own blocks', () => {
  const use = (context: RequestContext, kind: ScanIdKind, codes: readonly string[], options: { deviceId?: string } = {}) =>
    run(context, (tools) => useScanIds(tools, kind, codes.map((text) => ({ code: text, record: { type: 'Hide', id: newId() } })), options))
  const refusalsOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ScanIdsRefusedError)
    return (error as ScanIdsRefusedError).issues.map((issue) => issue.path)
  }

  it('records each number once, inside the tablet’s block, at its site', async () => {
    const used = await use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 3), code('HIDE', 4).toLowerCase()])
    expect(used.map((entry) => entry.ref)).toEqual([3, 4])
    expect(used[1]!.code).toBe(code('HIDE', 4))
    expect(await usesOf(tabletA1)).toEqual([1, 2, 3, 4].map((ref) => ({ code: code('HIDE', ref), ref, siteId: siteA1 })))
  })

  it("refuses a number outside the tablet's own blocks: another tablet's, an online one, one never handed out", async () => {
    const before = await usesOf(tabletA1)
    expect(await refusalsOf(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 210), code('HIDE', 401), code('HIDE', 99_999)]))).toEqual([
      'scanIds/0/NOT_RESERVED',
      'scanIds/1/NOT_RESERVED',
      'scanIds/2/NOT_RESERVED',
    ])
    // Nothing of the request is written, also not its good numbers.
    expect(await refusalsOf(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 5), code('HIDE', 210)]))).toEqual(['scanIds/1/NOT_RESERVED'])
    expect(await usesOf(tabletA1)).toEqual(before)
  })

  it('refuses a number used before, or twice in one request', async () => {
    expect(await refusalsOf(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 3)]))).toEqual(['scanIds/0/ALREADY_USED'])
    expect(await refusalsOf(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 6), code('HIDE', 6)]))).toEqual(['scanIds/1/USED_TWICE'])
    // The seeded uses count too.
    expect(await refusalsOf(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 1)]))).toEqual(['scanIds/0/ALREADY_USED'])
  })

  it("refuses a closed block's numbers, another factory's code, another kind's, and a typo", async () => {
    const tablet = await newTablet(siteA1, a.companies[0]!.id)
    const block = await reserveBlock(as(office()), { deviceId: tablet, kind: 'BUNDLE', size: 10 }, newId())
    expect((await use(floor(tablet, siteA1), 'BUNDLE', [code('BUNDLE', block.fromRef)])).map((entry) => entry.ref)).toEqual([block.fromRef])
    await closeBlock(as(office()), block.id, { reason: 'Tablet lost', version: block.version }, newId())
    const typo = code('BUNDLE', block.fromRef + 2).replace(/.$/, (last) => (last === '0' ? '1' : '0'))
    expect(await refusalsOf(use(floor(tablet, siteA1), 'BUNDLE', [code('BUNDLE', block.fromRef + 1), code('BUNDLE', block.fromRef + 1, b), code('HIDE', block.fromRef + 1), typo]))).toEqual([
      'scanIds/0/BLOCK_CLOSED',
      'scanIds/1/OTHER_FACTORY',
      'scanIds/2/WRONG_KIND',
      'scanIds/3/NOT_A_CODE',
    ])
  })

  it('a system command records for a tablet only when it names it', async () => {
    await expect(use(systemContext(a.tenantId, newId()), 'HIDE', [code('HIDE', 7)])).rejects.toThrow(ApiError)
    expect((await use(systemContext(a.tenantId, newId()), 'HIDE', [code('HIDE', 7)], { deviceId: tabletA1 })).map((entry) => entry.ref)).toEqual([7])
    await expect(use(floor(tabletA1, siteA1), 'HIDE', [code('HIDE', 8)], { deviceId: tabletB1 })).rejects.toThrow('own numbers')
  })
})

describe('the database holds the rules for every login', () => {
  const insertUse = (context: RequestContext, values: { blockId: string; deviceId: string; siteId: string; ref: number; kind?: ScanIdKind; code?: string }) =>
    as(context).withClient((client) =>
      client.$executeRawUnsafe(
        'INSERT INTO "NumberBlockUse" (id, "siteId", "deviceId", "blockId", kind, ref, code, "recordType", "recordId", "usedAt", "requestId") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"NumberKind", $6, $7, \'Hide\', $8::uuid, now(), \'test\')',
        newId(),
        values.siteId,
        values.deviceId,
        values.blockId,
        values.kind ?? 'HIDE',
        values.ref,
        values.code ?? code(values.kind ?? 'HIDE', values.ref),
        newId(),
      ),
    )
  const blockOf = async (deviceId: string, kind: ScanIdKind) =>
    (await admin<{ id: string; fromRef: number; toRef: number }>('SELECT id::text AS id, "fromRef", "toRef" FROM "NumberBlock" WHERE "deviceId" = $1 AND kind = $2::"NumberKind" ORDER BY "fromRef" LIMIT 1', [deviceId, kind]))[0]!

  it('a tablet cannot record a number outside its block, of another tablet, or twice', async () => {
    const own = await blockOf(tabletA1, 'HIDE')
    const other = await blockOf(tabletB1, 'HIDE')
    await expect(insertUse(floor(tabletA1, siteA1), { blockId: own.id, deviceId: tabletA1, siteId: siteA1, ref: own.toRef + 1 })).rejects.toThrow('outside block')
    await expect(insertUse(floor(tabletA1, siteA1), { blockId: other.id, deviceId: tabletA1, siteId: siteA1, ref: other.fromRef + 5 })).rejects.toThrow('is not reserved for tablet')
    await expect(insertUse(floor(tabletA1, siteA1), { blockId: own.id, deviceId: tabletA1, siteId: siteA1, ref: 1 })).rejects.toThrow(/unique|Unique/)
    // Never changed or removed, by any login.
    await expect(admin('UPDATE "NumberBlockUse" SET ref = ref WHERE "deviceId" = $1', [tabletA1])).rejects.toThrow()
    await expect(admin('DELETE FROM "NumberBlockUse" WHERE "deviceId" = $1', [tabletA1])).rejects.toThrow()
  })

  it('a block starts above every block of its kind, names an active tablet of the session, and only closes', async () => {
    // A block over numbers handed out already.
    await expect(
      as(office()).withClient((client) =>
        client.$executeRawUnsafe('INSERT INTO "NumberBlock" (id, kind, purpose, "fromRef", "toRef", "requestId") VALUES ($1::uuid, \'HIDE\', \'ONLINE\', 300, 310, \'test\')', newId()),
      ),
    ).rejects.toThrow('handed out already')
    // A tablet of another site: the floor session does not see it.
    const top = (await highest('HIDE')) + 1
    await expect(
      as(floor(tabletA1, siteA1)).withClient((client) =>
        client.$executeRawUnsafe('INSERT INTO "NumberBlock" (id, kind, purpose, "fromRef", "toRef", "deviceId", "requestId") VALUES ($1::uuid, \'HIDE\', \'DEVICE\', $2, $3, $4::uuid, \'test\')', newId(), top, top + 9, tabletB1),
      ),
    ).rejects.toThrow('not one this session may reserve numbers for')
    // A document kind never gets a block.
    await expect(
      as(office()).withClient((client) => client.$executeRawUnsafe('INSERT INTO "NumberBlock" (id, kind, purpose, "fromRef", "toRef", "requestId") VALUES ($1::uuid, \'LOT\', \'ONLINE\', 1, 2, \'test\')', newId())),
    ).rejects.toThrow('document kind')
    const own = await blockOf(tabletA1, 'BUNDLE')
    await expect(admin('UPDATE "NumberBlock" SET "toRef" = "toRef" + 1 WHERE id = $1', [own.id])).rejects.toThrow('never change')
    await expect(admin('DELETE FROM "NumberBlock" WHERE id = $1', [own.id])).rejects.toThrow('never deleted')
    await expect(admin('UPDATE "NumberBlock" SET status = \'CLOSED\' WHERE id = $1', [own.id])).rejects.toThrow('says when and why')
    // The floor reads the tenant's whole ledger but never changes it.
    await expect(as(floor(tabletA1, siteA1)).withClient((client) => client.$executeRawUnsafe('UPDATE "NumberBlock" SET "requestId" = "requestId"'))).rejects.toThrow('permission denied')
    const closedBlock = await reserveBlock(as(office()), { deviceId: tabletA1, kind: 'BUNDLE', size: 1 }, newId())
    await closeBlock(as(office()), closedBlock.id, { reason: 'Test', version: closedBlock.version }, newId())
    await expect(admin('UPDATE "NumberBlock" SET status = \'ACTIVE\', "closedAt" = NULL, "closedReason" = NULL WHERE id = $1', [closedBlock.id])).rejects.toThrow('stays closed')
  })
})

describe('routes', () => {
  it("GET /numbering/floor/blocks: the tablet's open blocks with what is used and left", async () => {
    const response = await call('tablet-a1', 'GET', '/numbering/floor/blocks')
    expect(response.statusCode).toBe(200)
    const { scanTag, blocks } = response.json() as { scanTag: string; blocks: BlockView[] }
    expect(scanTag).toBe(tenantTag(a.tenantId))
    expect(blocks.every((block) => block.deviceId === tabletA1 && block.status === 'ACTIVE')).toBe(true)
    const hide = blocks.find((block) => block.kind === 'HIDE' && block.fromRef === 1)!
    expect(hide).toMatchObject({ toRef: 200, size: 200, firstCode: code('HIDE', 1), lastCode: code('HIDE', 200) })
    expect(hide.used).toBeGreaterThanOrEqual(2)
    expect(hide.remaining).toBe(200 - hide.used)
    expect(hide.highestUsedRef).toBeGreaterThanOrEqual(2)
    expect((await call('admin', 'GET', '/numbering/floor/blocks')).statusCode).toBe(403)
  })

  it('POST /numbering/floor/blocks/top-up: one answer per key', async () => {
    const key = newId()
    const first = await call('tablet-a1', 'POST', '/numbering/floor/blocks/top-up', { kinds: [{ kind: 'HIDE', remaining: 3 }] }, key)
    expect(first.statusCode).toBe(200)
    const answer = first.json() as { reserved: BlockView[] }
    expect(answer.reserved.map((block) => block.kind)).toEqual(['HIDE'])
    const again = await call('tablet-a1', 'POST', '/numbering/floor/blocks/top-up', { kinds: [{ kind: 'HIDE', remaining: 3 }] }, key)
    expect(again.json()).toEqual(first.json())
    expect((await call('tablet-a1', 'POST', '/numbering/floor/blocks/top-up', { kinds: [{ kind: 'HIDE' }, { kind: 'HIDE' }] }, newId())).statusCode).toBe(400)
    expect((await call('tablet-a1', 'POST', '/numbering/floor/blocks/top-up', { kinds: [{ kind: 'LOT' }] }, newId())).statusCode).toBe(400)
  })

  it('the office lists, reserves and closes the blocks of the tablets its grants reach', async () => {
    const list = await call('admin', 'GET', `/numbering/blocks?deviceId=${tabletA1}&kind=GARMENT_SERIAL`)
    expect(list.statusCode).toBe(200)
    expect((list.json() as { blocks: BlockView[] }).blocks.every((block) => block.kind === 'GARMENT_SERIAL' && block.deviceId === tabletA1)).toBe(true)
    const everyTablet = (await call('admin', 'GET', '/numbering/blocks?kind=HIDE')).json() as { blocks: BlockView[] }
    expect(new Set(everyTablet.blocks.map((block) => block.deviceId))).toContain(tabletB1)
    // Company B's administrator does not see A1's tablet.
    expect((await call('admin-company-b', 'GET', `/numbering/blocks?deviceId=${tabletA1}`)).statusCode).toBe(404)
    const companyB = (await call('admin-company-b', 'GET', '/numbering/blocks')).json() as { blocks: BlockView[] }
    expect(companyB.blocks.length).toBeGreaterThan(0)
    expect(companyB.blocks.every((block) => block.deviceId === tabletB1)).toBe(true)
    expect((await call('admin-b', 'GET', `/numbering/blocks?deviceId=${tabletA1}`)).statusCode).toBe(404)

    const reserved = await call('admin', 'POST', '/numbering/blocks', { deviceId: tabletB1, kind: 'BUNDLE' })
    expect(reserved.statusCode).toBe(201)
    const block = (reserved.json() as { block: BlockView }).block
    expect(block).toMatchObject({ deviceId: tabletB1, kind: 'BUNDLE', size: 200, status: 'ACTIVE' })
    expect((await call('viewer', 'POST', '/numbering/blocks', { deviceId: tabletB1, kind: 'BUNDLE' })).statusCode).toBe(403)
    expect((await call('admin', 'POST', '/numbering/blocks', { deviceId: tabletB1, kind: 'BUNDLE', size: 1001 })).statusCode).toBe(400)
    const closed = await call('admin', 'POST', `/numbering/blocks/${block.id}/close`, { reason: 'Tablet retired', version: block.version })
    expect(closed.statusCode).toBe(200)
    expect((closed.json() as { block: BlockView }).block.status).toBe('CLOSED')
    expect((await call('admin', 'POST', `/numbering/blocks/${block.id}/close`, { reason: 'Tablet retired', version: block.version })).statusCode).toBe(409)
    expect((await call('tablet-a1', 'POST', '/numbering/blocks', { deviceId: tabletA1, kind: 'BUNDLE' }, newId())).statusCode).toBe(403)
  })
})
