import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedFileBytes } from '@nexus/factory-db/seed-files'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { isStrippable, stripImageMetadata } from '@nexus/factory-domain/files/thumbs/strip'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { forgetPictureBytes } from '../../../modules/product/images/bytes'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { makeSmallPreview, smallKeyOf } from '../thumbs/small'
import { putSeedFileBytes } from './seed-bytes'

/**
 * The seeded files with their bytes (B-W2b-F59) on the local stack: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login: row-level security and the …_files_guards trigger are real), EVERY seed file run in name order as the
 * seed CLI runs them, the harness's local file store (FAKE R2 accounts) behind the real gateway, and the real app's routes.
 * putSeedFileBytes puts each seeded file's bytes through files.put; then a colour library picture (the brand's logo), the
 * floor's data sheet and every other seeded file read back 200 with the bytes their rows name; fix-thumbs-1: every seeded
 * picture gets its stripped copy and small preview (B-TH-063), so an order's Picture cell serves it. Every name is made up. Run
 * with `node scripts/factory/run-pg-tests.mjs platform/files/seed-bytes`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2bf59-bytes'
const key = (name: string): string => seedUuid(NS, name)
const T = { tenant: key('tenant'), companyA: key('company:A'), siteA1: key('site:A1'), store: key('files:account:r2') }
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const grant = (permissions: Permission[], extra: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...extra })
const SESSIONS: Record<string, () => SessionContext> = {
  viewer: () => ({ audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['product.styles.view', 'files.read', 'files.upload'])] }),
  tabletA1: () => ({ audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [grant(['floor.work'], { companies: [T.companyA], sites: [T.siteA1] })] }),
  // fix-thumbs-1: a reader of Sales › Orders and of its files (the Picture cell, B-TH-017).
  orders: () => ({ audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['orders.view', 'files.read'])] }),
}
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = () => callerFor(h.database, systemContext(T.tenant, newId()))
const sha = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')

interface Row {
  readonly id: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly storageKey: string
  readonly thumbnailKey: string | null
  readonly sourceFileId: string | null
}
const available = () =>
  admin<Row>(`SELECT id, "originalName", "contentType", "sizeBytes", sha256, "storageKey", "thumbnailKey", "sourceFileId" FROM "StoredFile" WHERE "tenantId" = $1 AND status = 'AVAILABLE' ORDER BY id`, [T.tenant])
// fix-thumbs-1: the copies the job recorded (files.recordStrippedCopy audit rows) and every file's copy key.
const recordedCopies = async (): Promise<number> =>
  (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'files.recordStrippedCopy'`, [T.tenant]))[0]!.n
const copyKeys = async (): Promise<Map<string, string | null>> =>
  new Map((await admin<{ id: string; thumbnailKey: string | null }>(`SELECT id, "thumbnailKey" FROM "StoredFile" WHERE "tenantId" = $1 ORDER BY id`, [T.tenant])).map((row) => [row.id, row.thumbnailKey]))

beforeAll(async () => {
  h = await startHarness('w2bf59_seed_bytes')
  h.clock.set(new Date())
  const context: SeedContext = { db: h.database, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  // A whole seed's files in one go: the store account's default limit (60 a minute) would make the test wait.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 600_000)

afterAll(async () => {
  forgetPictureBytes()
  await app?.close()
  await h?.close()
}, 60_000)

describe('the seeded files get their bytes (B-W2b-F59)', () => {
  it('puts every seeded file, and every seeded picture’s stripped copy and small preview, through files.put; a second run writes the same and changes no row', async () => {
    const rows = await available()
    expect(rows.length).toBeGreaterThan(100)
    // fix-thumbs-1 (B-TH-063): every seeded picture gets its copy and small preview, not only the two rows that name a copy.
    const pictures = rows.filter((row) => isStrippable(row.contentType))
    const named = pictures.filter((row) => row.thumbnailKey)
    expect(named.length).toBe(2)
    expect(pictures.length).toBeGreaterThan(named.length)
    const puts = async () => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationCall" WHERE "tenantId" = $1 AND operation = 'files.put'`, [T.tenant]))[0]!.n
    const before = await puts()
    const copiesBefore = await recordedCopies()
    const outcome = await putSeedFileBytes(h.files, system())
    expect(outcome).toEqual({ written: rows.length, thumbnails: pictures.length, smallPreviews: pictures.length, made: pictures.length - named.length, noCopy: 0, notSeeded: 0 })
    expect(await puts()).toBe(before + outcome.written + outcome.thumbnails + outcome.smallPreviews)
    // The copies were made by the app's own command, one audit row each; every picture now names its copy.
    expect(await recordedCopies()).toBe(copiesBefore + outcome.made)
    expect((await available()).filter((row) => isStrippable(row.contentType) && row.thumbnailKey)).toHaveLength(pictures.length)
    const keys = await copyKeys()

    const again = await putSeedFileBytes(h.files, system())
    expect(again).toEqual({ ...outcome, made: 0 })
    expect(await puts()).toBe(before + 2 * (outcome.written + outcome.thumbnails + outcome.smallPreviews))
    expect(await recordedCopies()).toBe(copiesBefore + outcome.made)
    expect(await copyKeys()).toEqual(keys)
  })

  it('stores for every seeded file exactly the bytes its row names (size, type and SHA-256), a copy its source’s', async () => {
    for (const row of await available()) {
      const body = await h.files.storage.read(system(), T.store, row.storageKey, row.sizeBytes)
      expect(body, row.originalName).not.toBeNull()
      expect([body!.length, sha(body!)], row.originalName).toEqual([row.sizeBytes, row.sha256])
      const head = await h.files.storage.head(system(), T.store, row.storageKey)
      expect(head?.contentType, row.originalName).toBe(row.contentType)
    }
    const copy = (await available()).find((row) => row.sourceFileId)!
    const source = (await available()).find((row) => row.id === copy.sourceFileId)!
    expect(copy.sha256).toBe(source.sha256)
  })

  // fix-thumbs-1 (B-TH-063 with B-TH-017): the Owner's test server showed only placeholders in the Orders sheet's Picture column.
  it('gives every seeded picture its stripped copy and small preview, so the Orders sheet’s Picture column shows SEED-JKT-01’s and SEED-JKT-02’s', async () => {
    for (const row of (await available()).filter((file) => isStrippable(file.contentType))) {
      expect(row.thumbnailKey, row.originalName).not.toBeNull()
      const stripped = stripImageMetadata(seedFileBytes({ ...row, sizeBytes: Number(row.sizeBytes) }), row.contentType)
      expect(stripped.ok, row.originalName).toBe(true)
      const copy = await h.files.storage.read(system(), T.store, row.thumbnailKey!, 50_000_000)
      expect(copy && Buffer.from(stripped.ok ? stripped.bytes : []).equals(copy), row.originalName).toBe(true)
      const small = await h.files.storage.read(system(), T.store, smallKeyOf(row.thumbnailKey!), 50_000_000)
      expect(small && Buffer.from(makeSmallPreview(copy!, row.contentType).bytes).equals(small), row.originalName).toBe(true)
    }

    const mains = await admin<{ code: string; fileId: string }>(
      `SELECT s.code, i."fileId" FROM "StyleImage" i JOIN "Style" s ON s.id = i."styleId" WHERE s."tenantId" = $1 AND i."isMain" AND s.code IN ('SEED-JKT-01', 'SEED-JKT-02') ORDER BY s.code`,
      [T.tenant],
    )
    expect(mains.map((main) => main.code)).toEqual(['SEED-JKT-01', 'SEED-JKT-02'])
    for (const main of mains) {
      // Recorded by the job's own command: the copy and how its small preview was made (the seed's 32 × 32 JPEG, copied).
      const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.recordStrippedCopy'`, [main.fileId])
      expect(audit, main.code).toHaveLength(1)
      expect(audit[0]!.after).toMatchObject({ strippedCopy: true, smallPreview: { made: 'COPIED', width: 32, height: 32 } })
    }

    // The Picture cell of an order whose first line is one of them: a presigned address of the small preview, which serves it.
    const [order] = await admin<{ id: string; fileId: string }>(
      `SELECT o.id, i."fileId" FROM "SalesOrder" o
         JOIN LATERAL (SELECT l."styleId" FROM "SalesOrderLine" l WHERE l."orderId" = o.id ORDER BY l.seq LIMIT 1) first ON true
         JOIN "StyleImage" i ON i."styleId" = first."styleId" AND i."isMain"
       WHERE o."tenantId" = $1 AND i."fileId" = ANY($2::uuid[]) ORDER BY o.number LIMIT 1`,
      [T.tenant, mains.map((main) => main.fileId)],
    )
    expect(order).toBeDefined()
    const answer = await call('orders', 'GET', `/sales/orders/${order!.id}/picture`)
    expect(answer.statusCode, answer.body).toBe(200)
    const { picture } = answer.json() as Json
    expect(picture).toMatchObject({ fileId: order!.fileId, contentType: 'image/jpeg', small: { method: 'GET', url: expect.any(String) } })
    const fetched = await h.app.inject({ method: 'GET', url: picture.small.url })
    expect(fetched.statusCode).toBe(200)
    const [file] = await admin<{ thumbnailKey: string }>(`SELECT "thumbnailKey" FROM "StoredFile" WHERE id = $1`, [order!.fileId])
    expect(fetched.rawPayload.equals((await h.files.storage.read(system(), T.store, smallKeyOf(file!.thumbnailKey), 50_000_000))!)).toBe(true)
    expect(fetched.rawPayload.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
  })

  it('shows the colour library’s picture (the brand’s logo) to the office: 200, the PNG the row names', async () => {
    const [logo] = await available().then((rows) => rows.filter((row) => row.originalName === 'Seed brand P1 logo.png'))
    const answer = await call('viewer', 'GET', `/product/colours/pictures/${logo!.id}`)
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.headers['content-type']).toMatch(/^image\/png/)
    expect(answer.rawPayload.equals(seedFileBytes({ ...logo!, sizeBytes: Number(logo!.sizeBytes) }))).toBe(true)
    expect(answer.rawPayload.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
  })

  it('serves the floor its current data sheets: the download answers 200 with the PDF whose hash the sheet names', async () => {
    const sheets = await admin<{ id: string; fileId: string }>(`SELECT s.id, s."fileId" FROM "SafetyDataSheet" s JOIN "Chemical" c ON c.id = s."chemicalId" WHERE s."tenantId" = $1 AND s."siteId" = $2 AND s.status = 'CURRENT' AND c.status = 'ACTIVE' ORDER BY s.id`, [T.tenant, T.siteA1])
    expect(sheets.length).toBeGreaterThan(0)
    for (const sheet of sheets) {
      const answer = await call('tabletA1', 'GET', `/safety/floor/data-sheets/${sheet.id}/download`)
      expect(answer.statusCode, answer.body).toBe(200)
      const { download, sha256, sizeBytes } = answer.json() as Json
      const fetched = await h.app.inject({ method: 'GET', url: download.url })
      expect(fetched.statusCode).toBe(200)
      expect([fetched.rawPayload.length, sha(fetched.rawPayload)]).toEqual([sizeBytes, sha256])
      expect(fetched.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }
  })

  it('leaves a file someone uploaded alone', async () => {
    const body = Buffer.from('%PDF-1.4\n% made-up upload, not a seed file\n%%EOF\n', 'latin1')
    const announced = await call('viewer', 'POST', '/files', { companyId: T.companyA, recordType: 'Company', recordId: T.companyA, kind: 'DOCUMENT', originalName: 'Made-up upload.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) })
    expect(announced.statusCode, announced.body).toBe(201)
    const { upload, file } = announced.json() as Json
    expect((await h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
    expect((await call('viewer', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(200)
    const outcome = await putSeedFileBytes(h.files, system())
    expect(outcome.notSeeded).toBe(1)
    const kept = await h.files.storage.read(system(), T.store, (await admin<{ storageKey: string }>(`SELECT "storageKey" FROM "StoredFile" WHERE id = $1`, [file.id]))[0]!.storageKey, body.length)
    expect(kept!.equals(body)).toBe(true)
  })
})
