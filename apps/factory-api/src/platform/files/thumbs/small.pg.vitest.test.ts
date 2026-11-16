import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createGateway, GatewayCallFailed } from '../../gateway/gateway'
import { useGateway } from '../../gateway/service'
import { systemContext } from '../../outbox/system'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { createFilesRuntime, processFiles, useFiles, type FilesRuntime } from '../service'
import { decodeJpeg } from './codec/jpeg-decode'
import { encodeJpeg } from './codec/jpeg-encode'
import type { Picture } from './codec/picture'
import { decodePng, encodePng } from './codec/png'
import { stripPicturesHandler } from './handler'
import { smallKeyOf } from './small'
import { makeStrippedCopy } from './strip-copy'

/**
 * Real small pictures (B-TH-063; threads plan TH-1a, gap G8; wall check W25) on the local stack: the job that makes the
 * stripped copy of a picture after `file.available` also makes its ~320 px preview from the copy's pixels, under the key
 * derived from the copy's, before the copy is recorded; a picture the codec does not read keeps its stripped copy there.
 * A throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the files guards are
 * real), the local file store behind the real gateway (Redis on this machine). Made-up pictures. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/files/thumbs`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const tenant = newId()
const company = newId()
const party = newId()
const otherParty = newId()
const user = newId()
const quote = newId()
const store = newId()

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['files.read', 'files.upload', 'files.manage'])] },
  partner: { audience: 'partner', tenantId: tenant, actorId: user, partyId: party, grants: [grant(['files.read'])] },
  'other-partner': { audience: 'partner', tenantId: tenant, actorId: user, partyId: otherParty, grants: [grant(['files.read'])] },
}

type Json = Record<string, any>
type Presigned = { method: string; url: string; headers: Record<string, string>; expiresAt: string }
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')
const system = () => callerFor(database, systemContext(tenant, newId()))
const rowOf = async (id: string) => (await admin<{ thumbnailKey: string | null; exifStrippedAt: Date | null }>('SELECT "thumbnailKey", "exifStrippedAt" FROM "StoredFile" WHERE id = $1', [id]))[0]!
const stored = async (key: string): Promise<Buffer | null> => processFiles().storage.read(system(), store, key, 50_000_000)
const smallFacts = async (fileId: string): Promise<Json | undefined> =>
  (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.recordStrippedCopy' ORDER BY at DESC LIMIT 1`, [fileId]))[0]?.after.smallPreview

async function uploaded(body: Uint8Array, fields: Record<string, unknown>): Promise<{ id: string }> {
  const announced = await call('admin', 'POST', '/files', { companyId: company, recordType: 'Quote', recordId: quote, kind: 'PHOTO', sizeBytes: body.length, sha256: sha256(body), ...fields })
  expect(announced.statusCode, announced.body).toBe(201)
  const { file, upload } = announced.json() as { file: { id: string }; upload: Presigned }
  expect((await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: Buffer.from(body) })).statusCode).toBe(200)
  const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return file
}
/** The worker's job after file.available, called as the worker does. */
async function runJob(fileId: string): Promise<void> {
  await stripPicturesHandler({ files: processFiles }).handle(
    { eventId: newId(), type: 'file.available', version: 1, tenantId: tenant, companyId: company, subject: fileId, correlationId: newId(), causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { fileId, recordType: 'Quote', recordId: quote, kind: 'PHOTO' } } as never,
    { caller: system(), attempt: 1 } as never,
  )
}

/** A made-up picture: gradients and a disc; with alpha, the right half clear. */
function synthetic(width: number, height: number, channels: 3 | 4 = 3): Picture {
  const data = new Uint8ClampedArray(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels
      data[at] = (x * 255) / width
      data[at + 1] = (y * 255) / height
      data[at + 2] = Math.hypot(x - width / 2, y - height / 2) < height / 4 ? 230 : 60
      if (channels === 4) data[at + 3] = x < width / 2 ? 255 : 0
    }
  }
  return { width, height, channels, data }
}
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
/** A phone photo: the picture with an EXIF block (orientation 6, turned right, and a GPS position) after its JFIF header. */
function phonePhoto(): Uint8Array {
  const jpeg = encodeJpeg(synthetic(1200, 800), 90)
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00]
  tiff.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00)
  tiff.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...ascii('GPS 45.4642N 9.1900E'))
  const body = [...ascii('Exif\0\0'), ...tiff]
  const app1 = [0xff, 0xe1, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body]
  const app0End = 4 + ((jpeg[4]! << 8) | jpeg[5]!)
  return Uint8Array.from([...jpeg.subarray(0, app0End), ...app1, ...jpeg.subarray(app0End)])
}
const hasExif = (jpeg: Uint8Array): boolean => Buffer.from(jpeg).includes(Buffer.from('Exif\0\0', 'latin1'))

beforeAll(async () => {
  db = await migratedDatabase('files_thumbs_small')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-thumbs-small-test-'))
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'thumbs-small'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'TSM', 'Piccole Immagini S.r.l.')`, [company, tenant])
  await admin(
    `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $3, NULL, 'ALPHA', 'ORGANISATION', 'Brand Alpha S.r.l.', '{CUSTOMER}'), ($2, $3, NULL, 'BETA', 'ORGANISATION', 'Brand Beta S.r.l.', '{CUSTOMER}')`,
    [party, otherParty, tenant],
  )
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [store, tenant])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useGateway(gateway)
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  useGateway(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the job that makes the stripped copy makes the small preview (B-TH-063)', () => {
  it('a phone photo: about 320 px, the right way up, no EXIF and no position, under the key derived from the copy\'s', async () => {
    const photo = phonePhoto()
    const file = await uploaded(photo, { originalName: 'sample.jpg', contentType: 'image/jpeg' })
    expect((await rowOf(file.id)).thumbnailKey).toBeNull()
    await runJob(file.id)
    const { thumbnailKey } = await rowOf(file.id)
    expect(thumbnailKey).not.toBeNull()
    const small = (await stored(smallKeyOf(thumbnailKey!)))!
    expect(small).not.toBeNull()
    expect(hasExif(small)).toBe(false)
    expect(small.toString('latin1')).not.toContain('GPS')
    // Turned right (orientation 6): the 1200 x 800 photo stands 213 x 320.
    expect(decodeJpeg(small, { scale: 8 })).toMatchObject({ width: 213, height: 320, orientation: 1 })
    // The stripped copy stays full size, with its orientation and without its position.
    const copy = (await stored(thumbnailKey!))!
    expect(decodeJpeg(copy, { scale: 8 })).toMatchObject({ width: 1200, height: 800, orientation: 6 })
    expect(copy.toString('latin1')).not.toContain('GPS')
    expect(small.length).toBeLessThan(copy.length / 3)
    expect(await smallFacts(file.id)).toEqual({ made: 'RESIZED', width: 213, height: 320, sizeBytes: small.length })
  })

  it('a large PNG keeps its transparency; a picture already small, or one the codec does not read, keeps its stripped copy', async () => {
    const logo = await uploaded(encodePng(synthetic(800, 500, 4)), { originalName: 'logo.png', contentType: 'image/png' })
    await runJob(logo.id)
    const small = decodePng((await stored(smallKeyOf((await rowOf(logo.id)).thumbnailKey!)))!)
    expect([small.width, small.height]).toEqual([320, 200])
    expect(small.data[(10 * 320 + 300) * 4 + 3]).toBe(0)
    expect(small.data[(10 * 320 + 10) * 4 + 3]).toBe(255)
    expect(await smallFacts(logo.id)).toMatchObject({ made: 'RESIZED', width: 320, height: 200 })

    const icon = await uploaded(encodeJpeg(synthetic(200, 120), 90), { originalName: 'icon.jpg', contentType: 'image/jpeg' })
    await runJob(icon.id)
    const iconKey = (await rowOf(icon.id)).thumbnailKey!
    expect((await stored(smallKeyOf(iconKey)))!.equals((await stored(iconKey))!)).toBe(true)
    expect(await smallFacts(icon.id)).toMatchObject({ made: 'COPIED', width: 200, height: 120 })

    // A WebP (its chunks made up): stripped as WebP, kept as its stripped copy, with the reason.
    const chunk = [...ascii('VP8L'), 8, 0, 0, 0, 0x2f, 1, 2, 3, 4, 5, 6, 7]
    const webp = Uint8Array.from([...ascii('RIFF'), (chunk.length + 4) & 0xff, 0, 0, 0, ...ascii('WEBP'), ...chunk])
    const sticker = await uploaded(webp, { originalName: 'sticker.webp', contentType: 'image/webp' })
    await runJob(sticker.id)
    const stickerKey = (await rowOf(sticker.id)).thumbnailKey!
    expect((await stored(smallKeyOf(stickerKey)))!.equals((await stored(stickerKey))!)).toBe(true)
    expect((await smallFacts(sticker.id))!.made).toBe('COPIED')
    expect((await smallFacts(sticker.id))!.reason).toEqual(expect.any(String))
  })

  it('made once: a second run finds the copy and makes nothing more', async () => {
    const file = await uploaded(encodeJpeg(synthetic(900, 600), 85), { originalName: 'again.jpg', contentType: 'image/jpeg' })
    await runJob(file.id)
    const first = (await rowOf(file.id)).thumbnailKey!
    expect(await makeStrippedCopy(processFiles(), system(), file.id)).toEqual({ outcome: 'exists', key: first })
    expect((await rowOf(file.id)).thumbnailKey).toBe(first)
  })

  it('the store failing while the preview is put: the copy goes too and nothing is recorded, so the job tries again whole', async () => {
    const file = await uploaded(encodeJpeg(synthetic(900, 600), 85), { originalName: 'retry.jpg', contentType: 'image/jpeg' })
    const real = processFiles()
    const keys: string[] = []
    const failing: FilesRuntime = {
      ...real,
      storage: {
        ...real.storage,
        async put(caller, accountId, target) {
          keys.push(target.key)
          if (keys.length === 2) throw new GatewayCallFailed('timeout', 'The made-up store did not answer.', true, null, 3)
          return real.storage.put(caller, accountId, target)
        },
      },
    }
    expect(await makeStrippedCopy(failing, system(), file.id)).toEqual({ outcome: 'store_unavailable', key: null })
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(smallKeyOf(keys[0]!))
    expect(await rowOf(file.id)).toEqual({ thumbnailKey: null, exifStrippedAt: null })
    expect(await stored(keys[0]!)).toBeNull()
    await runJob(file.id)
    expect((await stored(smallKeyOf((await rowOf(file.id)).thumbnailKey!)))).not.toBeNull()
  })
})

describe('the wall (W25): the preview reaches only the readers of its file', () => {
  it('a portal sees its shared picture only as the stripped copy (no route answers the small key); another customer: not found', async () => {
    const file = await uploaded(phonePhoto(), { originalName: 'shared.jpg', contentType: 'image/jpeg', visibility: ['OFFICE', 'PARTNER'], partyId: party })
    await runJob(file.id)
    const { thumbnailKey } = await rowOf(file.id)
    const preview = await call('partner', 'GET', `/files/${file.id}/preview`)
    expect(preview.statusCode, preview.body).toBe(200)
    const shown = (await app.inject({ method: 'GET', url: (preview.json().preview as Presigned).url })).rawPayload
    expect(shown.equals((await stored(thumbnailKey!))!)).toBe(true)
    expect(shown.equals((await stored(smallKeyOf(thumbnailKey!)))!)).toBe(false)
    expect((await call('other-partner', 'GET', `/files/${file.id}/preview`)).statusCode).toBe(404)
    expect((await call('other-partner', 'GET', `/files/${file.id}/download`)).statusCode).toBe(404)
  })
})
