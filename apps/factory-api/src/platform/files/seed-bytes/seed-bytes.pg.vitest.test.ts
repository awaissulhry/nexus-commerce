import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedFileBytes } from '@nexus/factory-db/seed-files'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { forgetPictureBytes } from '../../../modules/product/images/bytes'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { putSeedFileBytes } from './seed-bytes'

/**
 * The seeded files with their bytes (B-W2b-F59) on the local stack: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login: row-level security and the …_files_guards trigger are real), EVERY seed file run in name order as the
 * seed CLI runs them, the harness's local file store (FAKE R2 accounts) behind the real gateway, and the real app's routes.
 * putSeedFileBytes puts each seeded file's bytes through files.put; then a colour library picture (the brand's logo), the
 * floor's data sheet and every other seeded file read back 200 with the bytes their rows name. Every name is made up. Run
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
  it('puts every seeded file and its stripped copies through files.put, under the rows’ own keys; a second run writes the same', async () => {
    const rows = await available()
    expect(rows.length).toBeGreaterThan(100)
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationCall" WHERE "tenantId" = $1 AND operation = 'files.put'`, [T.tenant]))[0]!.n
    const outcome = await putSeedFileBytes(h.files, system())
    expect(outcome).toEqual({ written: rows.length, thumbnails: rows.filter((row) => row.thumbnailKey).length, notSeeded: 0 })
    expect(outcome.thumbnails).toBe(2)
    const after = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationCall" WHERE "tenantId" = $1 AND operation = 'files.put'`, [T.tenant]))[0]!.n
    expect(after - before).toBe(outcome.written + outcome.thumbnails)
    expect(await putSeedFileBytes(h.files, system())).toEqual(outcome)
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
