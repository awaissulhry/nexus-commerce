import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedStylesDepth, type StylesDepthSeed } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createAbuseGuard, useAbuseGuard } from '../../../platform/abuse/guard'
import { memoryAbuseStore } from '../../../platform/abuse/store'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { forgetPublicDocPictures } from '../../compliance/public-doc/picture'
import { forgetPublicDocFiles } from '../../compliance/public-doc/public-doc'
import { uploadComplianceDocument } from '../../shipping/documents/testing/compliance'

/**
 * Sketches, the gallery and pattern files (B-W2b-236; PRD-016, PRD-218; SY3:01, SY3:02, SY3:03) on the local stack, through
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and
 * B-W2b-206's StyleImage_guard / StyleRevisionFile_guard are real), the styles-depth seed (SEED-JKT-01's front flat, its
 * black colourway's photo as the main picture and its draft revision 1's collar page with two callouts and DXF pattern;
 * SEED-JKT-02's released revision 1 with its photo and a Lectra marker), the harness's local file store, sessions from the
 * test authenticator. Every picture, pattern and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/images`.
 */

let h: Harness
let app: FastifyInstance
let seed: StylesDepthSeed

const NS = 'w2b236-images'
const tenant = seedUuid(NS, 'tenant')
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (tenantId: string, permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants: [grant(permissions)] })
const MAKER: Permission[] = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'files.read', 'files.upload', 'audit.read']
const SESSIONS: Record<string, SessionContext> = {
  maker: office(tenant, MAKER),
  viewer: office(tenant, ['product.styles.view', 'product.bom.view']),
  // Sales reads the style, not its revisions' parts: pattern files are not theirs.
  sales: office(tenant, ['product.styles.view', 'files.read']),
  nobody: office(tenant, ['shipping.view']),
  otherTenant: office(newId(), MAKER),
  quality: office(tenant, ['compliance.certificates.view', 'compliance.declarations.manage', 'files.read', 'files.upload']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)

// Made-up pictures built byte by byte (the stripper never decodes the image data): a JPEG with an EXIF block holding a
// made-up GPS text, and a tiny PNG.
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
const jpegWithGps = (): Buffer =>
  Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii('Exif\0\0'), 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...ascii('GPSLAT 45.4642 N')]),
    ...segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]),
    ...segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0x56, 0x78,
    0xff, 0xd9,
  ])
const png = (text: string): Buffer => Buffer.from(`\x89PNG\r\n\x1a\n made-up ${text}`, 'latin1')

/** A file announced, sent and confirmed through the files platform (one PUT). */
async function upload(recordType: string, recordId: string, name: string, contentType: string, body: Buffer, kind = 'PHOTO'): Promise<string> {
  const announced = await ok('maker', 'POST', '/files', { recordType, recordId, kind, originalName: name, contentType, sizeBytes: body.length, sha256: sha(body) }, 201)
  expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })).statusCode).toBe(200)
  await ok('maker', 'POST', `/files/${announced.file.id}/complete`)
  return announced.file.id
}

/** A file sent in parts (a DXF is taken only that way): start, presign the one part, PUT, complete. `of`: a new version of that file. */
async function uploadInParts(target: { recordType: string; recordId: string } | { of: string }, name: string, contentType: string, body: Buffer): Promise<string> {
  const common = { originalName: name, contentType, sizeBytes: body.length, sha256: sha(body) }
  const started = 'of' in target ? await ok('maker', 'POST', `/files/${target.of}/versions/uploads`, common, 201) : await ok('maker', 'POST', '/files/uploads', { ...target, kind: 'DOCUMENT', ...common }, 201)
  const { parts } = await ok('maker', 'POST', `/files/uploads/${started.session.id}/parts`, { parts: [{ partNumber: 1, sha256: sha(body) }] })
  expect((await app.inject({ method: 'PUT', url: parts[0].url, headers: parts[0].headers, payload: body })).statusCode).toBe(200)
  const done = await ok('maker', 'POST', `/files/uploads/${started.session.id}/complete`)
  expect(done.file.status).toBe('AVAILABLE')
  return started.file.id
}

const pictures = (styleId: string) => `/product/styles/${styleId}/pictures`
const patternFiles = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}/pattern-files`
let jkt01: string
let jkt02: string
let rev01: string
let rev02: string

beforeAll(async () => {
  h = await startHarness('w2b236_images')
  h.clock.set('2026-11-10T09:00:00.000Z')
  await seedCore({ db: h.database, namespace: NS })
  seed = await seedStylesDepth({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  jkt01 = seed.styleIds.jkt01
  jkt02 = seed.styleIds.jkt02
  rev01 = (await admin<{ id: string }>(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1`, [jkt01]))[0]!.id
  rev02 = (await admin<{ id: string }>(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1`, [jkt02]))[0]!.id
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  useAbuseGuard(createAbuseGuard({ store: memoryAbuseStore(), key: Buffer.alloc(32, 7), prefix: 'test', clock: h.clock }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    {
      database: h.database,
      clock: h.clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 600_000)

afterAll(async () => {
  useAbuseGuard(undefined)
  forgetPublicDocFiles()
  forgetPublicDocPictures()
  await app?.close()
  await h?.close()
}, 60_000)

describe('Sketches and pictures (PRD-016)', () => {
  it("reads SEED-JKT-01's pictures in order with a look each; a viewer reads, a role without the style and another tenant cannot", async () => {
    const view = (await ok('viewer', 'GET', pictures(jkt01))).pictures
    expect(view.pictures.map((picture: Json) => [picture.kind, picture.seq, picture.isMain, picture.caption, picture.colourway?.code ?? null, picture.revision?.revision ?? null, picture.callouts.length])).toEqual([
      ['SKETCH', 0, false, 'Front flat', null, null, 0],
      ['PHOTO', 1, true, null, 'BLK', null, 0],
      ['PAGE', 2, false, 'Collar detail', null, 1, 2],
    ])
    expect(view.pictures[2].callouts[0]).toEqual({ n: 1, x: '0.42', y: '0.18', text: 'Double stitch, 4 mm' })
    for (const picture of view.pictures) expect(picture.look?.url).toEqual(expect.any(String))
    expect(view.pictures.map((picture: Json) => [picture.printable, picture.frozen])).toEqual([
      [true, null],
      [true, null],
      [true, null],
    ])
    expect(view).toMatchObject({ style: { code: 'SEED-JKT-01' }, refusal: null, limits: { pictures: 60, callouts: 60, types: ['image/jpeg', 'image/png', 'image/webp'] } })
    expect(view.colourways.map((colourway: Json) => colourway.code)).toEqual(['BLK', 'RED'])
    await refused('nobody', 'GET', pictures(jkt01), undefined, 403)
    await refused('otherTenant', 'GET', pictures(jkt01), undefined, 404)
  })

  it('adds an uploaded picture at the end (not the main one), audited and said live; the same file twice, a PDF and a viewer are refused', async () => {
    const fileId = await upload('Style', jkt01, 'back flat.png', 'image/png', png('back flat'))
    const before = (await ok('maker', 'GET', pictures(jkt01))).pictures
    expect(before.unused.map((file: Json) => file.fileId)).toContain(fileId)
    const view = (await ok('maker', 'POST', pictures(jkt01), { fileId, kind: 'SKETCH', caption: 'Back flat' }, 201)).pictures
    const added = view.pictures.at(-1)
    expect(added).toMatchObject({ kind: 'SKETCH', seq: 3, isMain: false, caption: 'Back flat', file: { id: fileId, name: 'back flat.png' }, version: 1 })
    expect(view.unused.map((file: Json) => file.fileId)).not.toContain(fileId)
    expect((await eventsOf('style.pictures_changed')).at(-1)).toEqual({ styleId: jkt01, code: 'SEED-JKT-01', change: 'ADDED', pictureIds: [added.id] })
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'StyleImage' AND "recordId" = $1`, [added.id])
    expect(audit.map((row) => row.action)).toEqual(['product.pictures.add'])
    expect((await refused('maker', 'POST', pictures(jkt01), { fileId, kind: 'PHOTO' }, 409)).message).toBe('back flat.png is already a picture of style SEED-JKT-01.')
    const pdf = await upload('Style', jkt01, 'spec.pdf', 'application/pdf', Buffer.from('%PDF-1.4 made-up'), 'ATTACHMENT')
    expect((await refused('maker', 'POST', pictures(jkt01), { fileId: pdf, kind: 'PAGE' }, 400)).issues).toEqual([{ path: 'body/fileId', message: 'The file spec.pdf is a application/pdf: a picture is a JPEG, a PNG or a WebP.' }])
    await refused('viewer', 'POST', pictures(jkt01), { fileId, kind: 'PHOTO' }, 403)
    // A released revision takes no new picture (only a draft or the style itself).
    const other = await upload('Style', jkt02, 'detail.png', 'image/png', png('jkt02 detail'))
    expect((await refused('maker', 'POST', pictures(jkt02), { fileId: other, kind: 'PAGE', revisionId: rev02 }, 400)).issues[0]).toMatchObject({ path: 'body/revisionId', message: 'Revision 1 is released: a picture is added only to a draft revision or to the style itself.' })
    // Floats are not decimal strings.
    await refused('maker', 'POST', pictures(jkt02), { fileId: other, kind: 'PAGE', callouts: [{ n: 1, x: 0.5, y: '0.5', text: 'Zip' }] }, 400)
  })

  it('serves a picture’s bytes through the API, kept by the browser; only a style picture the caller may see', async () => {
    const view = (await ok('maker', 'GET', pictures(jkt01))).pictures
    const back = view.pictures.find((picture: Json) => picture.caption === 'Back flat')
    expect(back.look).toEqual({ url: `/product/pictures/${back.file.id}` })
    const shown = await call('viewer', 'GET', back.look.url)
    expect(shown.statusCode, shown.body).toBe(200)
    expect(shown.headers['content-type']).toMatch(/^image\/png/)
    expect(shown.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(shown.rawPayload.equals(png('back flat'))).toBe(true)
    await refused('nobody', 'GET', back.look.url, undefined, 403)
    await refused('otherTenant', 'GET', back.look.url, undefined, 404)
    // A file that is no style's picture is not served here (the files platform's routes serve it, with files.read).
    await refused('maker', 'GET', `/product/pictures/${newId()}`, undefined, 404)
    await refused('maker', 'GET', `/product/pictures/${seed.revisionFileIds.pattern}`, undefined, 404)
    // A seeded row has no bytes in the store: a refusal in words, never a 500.
    const seeded = view.pictures.find((picture: Json) => picture.id === seed.imageIds.front)
    expect((await call('maker', 'GET', seeded.look.url)).statusCode).toBe(503)
  })

  it('changes the page’s callouts and caption at its version; a stale version is a 409', async () => {
    const page = (await ok('maker', 'GET', pictures(jkt01))).pictures.pictures.find((picture: Json) => picture.kind === 'PAGE')
    const callouts = [...page.callouts, { n: 3, x: '0.1', y: '0.9', text: 'Hem tape 25 mm' }]
    const view = (await ok('maker', 'PATCH', `${pictures(jkt01)}/${page.id}`, { version: page.version, caption: 'Collar and hem', callouts })).pictures
    expect(view.pictures.find((picture: Json) => picture.id === page.id)).toMatchObject({ caption: 'Collar and hem', version: page.version + 1, callouts: expect.arrayContaining([{ n: 3, x: '0.1', y: '0.9', text: 'Hem tape 25 mm' }]) })
    expect((await refused('maker', 'PATCH', `${pictures(jkt01)}/${page.id}`, { version: page.version, caption: 'Old' }, 409)).message).toMatch(/version/)
    const twice = await refused('maker', 'PATCH', `${pictures(jkt01)}/${page.id}`, { version: page.version + 1, callouts: [{ n: 1, x: '0', y: '0', text: 'a' }, { n: 1, x: '1', y: '1', text: 'b' }] }, 400)
    expect(twice.issues).toEqual([{ path: 'body/callouts/1/n', message: 'Callout 1 is there twice: number each callout once.' }])
  })

  it('makes another picture the main one: the old one loses it, the list thumbnail follows (SY3:02)', async () => {
    const before = (await ok('maker', 'GET', pictures(jkt01))).pictures.pictures
    const back = before.find((picture: Json) => picture.caption === 'Back flat')
    const view = (await ok('maker', 'POST', `${pictures(jkt01)}/${back.id}/main`, { version: back.version })).pictures
    expect(view.pictures.filter((picture: Json) => picture.isMain).map((picture: Json) => picture.id)).toEqual([back.id])
    const row = (await ok('maker', 'GET', '/product/styles?status=ALL&q=SEED-JKT-01')).styles.find((item: Json) => item.code === 'SEED-JKT-01')
    expect(row.thumbnail).toEqual({ fileId: back.file.id, name: 'back flat.png', contentType: 'image/png' })
    expect((await eventsOf('style.pictures_changed')).at(-1)).toMatchObject({ change: 'MAIN', pictureIds: [back.id, seed.imageIds.colourway] })
  })

  it('orders the gallery (every picture once) and refuses an order that leaves one out', async () => {
    const before = (await ok('maker', 'GET', pictures(jkt01))).pictures.pictures.map((picture: Json) => picture.id)
    const reversed = [...before].reverse()
    const view = (await ok('maker', 'PUT', `${pictures(jkt01)}/order`, { ids: reversed })).pictures
    expect(view.pictures.map((picture: Json) => picture.id)).toEqual(reversed)
    expect((await refused('maker', 'PUT', `${pictures(jkt01)}/order`, { ids: reversed.slice(1) }, 409)).message).toMatch(/missing from the order/)
  })

  it('keeps a released revision’s picture: only its place and the main mark move', async () => {
    // A picture of SEED-JKT-02's released revision (made with the guard off: a release freezes the pictures it had).
    const fileId = await upload('Style', jkt02, 'released page.png', 'image/png', png('released page'))
    const pictureId = newId()
    await admin('ALTER TABLE "StyleImage" DISABLE TRIGGER "StyleImage_guard"')
    try {
      await admin(`INSERT INTO "StyleImage" (id, "tenantId", "styleId", "revisionId", "fileId", kind, seq) VALUES ($1, $2, $3, $4, $5, 'PAGE', 5)`, [pictureId, tenant, jkt02, rev02, fileId])
    } finally {
      await admin('ALTER TABLE "StyleImage" ENABLE TRIGGER "StyleImage_guard"')
    }
    const page = (await ok('maker', 'GET', pictures(jkt02))).pictures.pictures.find((picture: Json) => picture.id === pictureId)
    expect(page.frozen).toMatch(/revision 1, which is released/)
    expect((await refused('maker', 'PATCH', `${pictures(jkt02)}/${pictureId}`, { version: page.version, caption: 'New words' }, 409)).message).toMatch(/revision 1, which is released: it keeps what it shows/)
    expect((await refused('maker', 'DELETE', `${pictures(jkt02)}/${pictureId}?version=${page.version}`, undefined, 409)).message).toMatch(/it stays with it/)
    const main = (await ok('maker', 'POST', `${pictures(jkt02)}/${pictureId}/main`, { version: page.version })).pictures
    expect(main.pictures.find((picture: Json) => picture.id === pictureId).isMain).toBe(true)
    // The main mark back on the style's photo for the next parts.
    const photo = main.pictures.find((picture: Json) => picture.id === seed.imageIds.jkt02)
    await ok('maker', 'POST', `${pictures(jkt02)}/${photo.id}/main`, { version: photo.version })
  })

  it('removes the main picture: the next in order takes the mark; the file stays among the style’s files', async () => {
    const before = (await ok('maker', 'GET', pictures(jkt01))).pictures
    const main = before.pictures.find((picture: Json) => picture.isMain)
    const view = (await ok('maker', 'DELETE', `${pictures(jkt01)}/${main.id}?version=${main.version}`)).pictures
    expect(view.pictures.map((picture: Json) => picture.id)).not.toContain(main.id)
    expect(view.pictures.find((picture: Json) => picture.isMain).id).toBe(before.pictures.filter((picture: Json) => picture.id !== main.id)[0].id)
    expect(view.unused.map((file: Json) => file.fileId)).toContain(main.file.id)
    // Back as a picture and the main one again (the gallery and the copy below read it).
    const again = (await ok('maker', 'POST', pictures(jkt01), { fileId: main.file.id, kind: 'SKETCH', caption: 'Back flat' }, 201)).pictures.pictures.at(-1)
    await ok('maker', 'POST', `${pictures(jkt01)}/${again.id}/main`, { version: again.version })
  })
})

describe('the styles list’s Gallery view', () => {
  it('answers the main picture, the count and the colourways’ swatches of the styles asked, leaving out one unknown', async () => {
    const answer = await ok('viewer', 'POST', '/product/pictures/looks', { styleIds: [jkt01, jkt02, newId()] })
    expect(answer.looks.map((look: Json) => look.styleId)).toEqual([jkt01, jkt02])
    expect(answer.looks[0]).toMatchObject({ picture: { kind: 'SKETCH', caption: 'Back flat', look: { url: expect.any(String) } }, colourways: [{ code: 'BLK', name: 'Black', hex: '#1A1A1A' }, { code: 'RED', name: 'Red', hex: '#B3122E' }] })
    expect(answer.looks[0].pictures).toBeGreaterThanOrEqual(4)
    expect(answer.looks[1].picture).toMatchObject({ id: seed.imageIds.jkt02 })
    await refused('nobody', 'POST', '/product/pictures/looks', { styleIds: [jkt01] }, 403)
    expect((await ok('otherTenant', 'POST', '/product/pictures/looks', { styleIds: [jkt01] })).looks).toEqual([])
  })
})

describe('Pattern files per revision and size range (PRD-218)', () => {
  it('reads the draft revision’s DXF pattern and the released revision’s marker, with what each kind may do', async () => {
    const draft = (await ok('viewer', 'GET', patternFiles(jkt01, rev01))).patternFiles
    expect(draft.files.map((file: Json) => [file.kind, file.format, file.sizes, file.file.name, file.frozen])).toEqual([['PATTERN', 'DXF_AAMA', [], 'Seed JKT-01 rev 1 pattern.dxf', null]])
    expect(draft.kinds).toEqual({ PATTERN: null, MARKER: null, CAD: null, OTHER: null })
    const released = (await ok('viewer', 'GET', patternFiles(jkt02, rev02))).patternFiles
    expect(released.files.map((file: Json) => [file.kind, file.format, file.sizes, file.frozen])).toEqual([['MARKER', 'LECTRA', ['50', '52'], null]])
    expect(released.kinds.PATTERN).toMatch(/Revision 1 is released: its pattern files are its specification/)
    expect(released.kinds.MARKER).toBeNull()
    await refused('sales', 'GET', patternFiles(jkt01, rev01), undefined, 403)
    await refused('maker', 'GET', patternFiles(jkt01, rev02), undefined, 404)
  })

  it('names a DXF sent in parts as the pattern for 50–52, gives it a new version of its series, downloads both, and refuses a size outside the range', async () => {
    const fileId = await uploadInParts({ recordType: 'StyleRevision', recordId: rev01 }, 'JKT-01 r1 graded.dxf', 'application/dxf', Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'))
    expect((await refused('maker', 'POST', patternFiles(jkt01, rev01), { fileId, kind: 'PATTERN', sizes: ['60'] }, 400)).issues).toEqual([{ path: 'body/sizes', message: "Size(s) 60 are not in the style's range (50, 52, 54)." }])
    const view = (await ok('maker', 'POST', patternFiles(jkt01, rev01), { fileId, kind: 'PATTERN', format: 'DXF_AAMA', sizes: ['52', '50'], note: 'Graded 50-52' }, 201)).patternFiles
    const added = view.files.find((file: Json) => file.file.id === fileId)
    expect(added).toMatchObject({ kind: 'PATTERN', format: 'DXF_AAMA', sizes: ['50', '52'], note: 'Graded 50-52', file: { versionNo: 1 }, versions: [{ fileId, versionNo: 1, current: true }] })
    expect((await eventsOf('style.pattern_files_changed')).at(-1)).toEqual({ styleId: jkt01, code: 'SEED-JKT-01', revisionId: rev01, revision: 1, change: 'ADDED', patternFileIds: [added.id] })

    const v2 = await uploadInParts({ of: fileId }, 'JKT-01 r1 graded v2.dxf', 'application/dxf', Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n999\nv2\n'))
    const moved = (await ok('maker', 'PUT', `${patternFiles(jkt01, rev01)}/${added.id}/file`, { version: added.version, fileId: v2 })).patternFiles.files.find((file: Json) => file.id === added.id)
    expect(moved.file).toMatchObject({ id: v2, versionNo: 2 })
    expect(moved.versions.map((version: Json) => [version.versionNo, version.current])).toEqual([
      [2, true],
      [1, false],
    ])
    expect((await ok('viewer', 'GET', `${patternFiles(jkt01, rev01)}/${added.id}/download`)).download.url).toEqual(expect.any(String))
    expect((await ok('viewer', 'GET', `${patternFiles(jkt01, rev01)}/${added.id}/download?fileId=${fileId}`)).download.url).toEqual(expect.any(String))
    await refused('viewer', 'GET', `${patternFiles(jkt01, rev01)}/${added.id}/download?fileId=${seed.imageIds.front}`, undefined, 404)
    // A file of another series is not a version of it.
    const stranger = await uploadInParts({ recordType: 'StyleRevision', recordId: rev01 }, 'other.dxf', 'application/dxf', Buffer.from('0\nEOF\nother\n'))
    expect((await refused('maker', 'PUT', `${patternFiles(jkt01, rev01)}/${added.id}/file`, { version: moved.version, fileId: stranger }, 400)).issues[0].message).toMatch(/is not a version of/)
    await refused('viewer', 'PATCH', `${patternFiles(jkt01, rev01)}/${added.id}`, { version: moved.version, note: 'x' }, 403)
  })

  it('takes a marker on a released revision but no pattern; removes several rows of the draft at once', async () => {
    const marker = await uploadInParts({ recordType: 'StyleRevision', recordId: rev02 }, 'JKT-02 marker 54.plt', 'application/vnd.hp-hpgl', Buffer.from('IN;SP1;PU0,0;PD100,100;'))
    expect((await refused('maker', 'POST', patternFiles(jkt02, rev02), { fileId: marker, kind: 'PATTERN' }, 409)).message).toMatch(/Revision 1 is released: its pattern files are its specification and do not change/)
    const view = (await ok('maker', 'POST', patternFiles(jkt02, rev02), { fileId: marker, kind: 'MARKER', sizes: ['54'] }, 201)).patternFiles
    expect(view.files.map((file: Json) => file.kind)).toEqual(['MARKER', 'MARKER'])
    const draft = (await ok('maker', 'GET', patternFiles(jkt01, rev01))).patternFiles
    const removed = (await ok('maker', 'POST', `${patternFiles(jkt01, rev01)}/remove`, { items: draft.files.map((file: Json) => ({ id: file.id, version: file.version })) })).patternFiles
    expect(removed.files).toEqual([])
    expect((await eventsOf('style.pattern_files_changed')).at(-1)).toMatchObject({ change: 'REMOVED', patternFileIds: draft.files.map((file: Json) => file.id) })
  })
})

describe('Duplicate a style copies its pictures (SY3:01)', () => {
  it('offers the pictures with their count, copies each file as the copy’s own (naming its source), keeps the main one, and says what stayed behind', async () => {
    const offer = (await ok('maker', 'GET', `/product/styles/${jkt01}/duplicate`)).offer
    const part = offer.parts.find((entry: Json) => entry.part === 'PICTURES')
    expect(part).toMatchObject({ available: true, reasonCode: null })
    const source = (await ok('maker', 'GET', pictures(jkt01))).pictures.pictures
    expect(part.count).toBe(source.length)
    const key = newId()
    const copy = async () =>
      (await app.inject({ method: 'POST', url: `/product/styles/${jkt01}/duplicate`, headers: { 'x-test-session': 'maker', 'idempotency-key': key }, payload: { code: 'SEED-JKT-01-PIX', name: 'Seed jacket copy', parts: ['PICTURES'] } })).json()
    const made = await copy()
    // The seeded pictures are rows without bytes in the store: they stay behind; the uploaded ones are copied.
    const withBytes = source.filter((picture: Json) => !Object.values(seed.imageIds).includes(picture.id))
    expect(made.copied.pictures).toBe(withBytes.length)
    expect(made.noteCodes).toEqual([{ code: 'PICTURES_LEFT_OUT', sizes: [], count: source.length - withBytes.length, colourway: null }])
    const copied = (await ok('maker', 'GET', pictures(made.style.id))).pictures.pictures
    expect(copied.map((picture: Json) => [picture.kind, picture.caption, picture.isMain])).toEqual(withBytes.map((picture: Json) => [picture.kind, picture.caption, picture.isMain]))
    expect(copied.filter((picture: Json) => picture.isMain)).toHaveLength(1)
    const files = await admin<{ id: string; recordId: string; sourceFileId: string }>(`SELECT id, "recordId", "sourceFileId" FROM "StoredFile" WHERE id = ANY($1::uuid[])`, [copied.map((picture: Json) => picture.file.id)])
    expect(files.every((file) => file.recordId === made.style.id)).toBe(true)
    expect(files.map((file) => file.sourceFileId).sort()).toEqual(withBytes.map((picture: Json) => picture.file.id).sort())
    // The same Idempotency-Key answers the same copy; its pictures are not copied twice.
    const again = await copy()
    expect(again.style.id).toBe(made.style.id)
    expect((await ok('maker', 'GET', pictures(made.style.id))).pictures.pictures).toHaveLength(copied.length)
  })
})

describe('The public DoC page shows the main picture, stripped (SY3:03)', () => {
  it('names the main picture on the page and serves only its copy without camera or location data', async () => {
    await uploadComplianceDocument(app, 'quality', { styleId: jkt02, revisionId: rev02, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', body: Buffer.from('%PDF-1.4\n% made-up DoC\n%%EOF\n') })
    const fileId = await upload('Style', jkt02, 'jacket on a rider.jpg', 'image/jpeg', jpegWithGps())
    const added = (await ok('maker', 'POST', pictures(jkt02), { fileId, kind: 'PHOTO' }, 201)).pictures.pictures.at(-1)
    await ok('maker', 'POST', `${pictures(jkt02)}/${added.id}/main`, { version: added.version })
    const code = publicDocCodeOf(jkt02)
    const lookup = await app.inject({ method: 'POST', url: '/public/doc/lookup', payload: { code }, remoteAddress: '198.51.100.7' })
    expect(lookup.statusCode, lookup.body).toBe(200)
    expect(lookup.json().page.picture).toEqual({ fileId, contentType: 'image/jpeg', caption: null })
    const shown = await app.inject({ method: 'GET', url: `/public/doc/${code}/picture/${fileId}`, remoteAddress: '198.51.100.7' })
    expect(shown.statusCode, shown.body).toBe(200)
    expect(shown.headers['content-type']).toMatch(/^image\/jpeg/)
    expect(shown.rawPayload.includes(Buffer.from('GPSLAT'))).toBe(false)
    expect(shown.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    // The office's file still has it; the page never serves another file of the style.
    const office = await admin<{ thumbnailKey: string | null; storageKey: string }>(`SELECT "thumbnailKey", "storageKey" FROM "StoredFile" WHERE id = $1`, [fileId])
    expect(office[0]!.thumbnailKey).not.toBeNull()
    expect(office[0]!.thumbnailKey).not.toBe(office[0]!.storageKey)
    const other = await app.inject({ method: 'GET', url: `/public/doc/${code}/picture/${seed.imageIds.front}`, remoteAddress: '198.51.100.8' })
    expect(other.statusCode).toBe(404)
  })
})
