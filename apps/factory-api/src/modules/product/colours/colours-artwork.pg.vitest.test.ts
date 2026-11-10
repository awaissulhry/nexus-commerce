import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedStylesDepth, type StylesDepthSeed } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createAbuseGuard, useAbuseGuard } from '../../../platform/abuse/guard'
import { memoryAbuseStore } from '../../../platform/abuse/store'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { forgetPictureBytes } from '../images/bytes'

/**
 * Colours & artwork (B-W2b-247; PRD-041, PRD-045) on the local stack, through the app's real routes: a throwaway PostgreSQL
 * 17 database from the migrations (the runtime login: row-level security and B-W2b-206's Colour_system_check and
 * BrandingSet_check are real), the core and styles-depth seeds (SEED-BLK RAL 9005, SEED-RED Pantone 18-1662 TCX, SEED-GRY
 * our own; SEED-C1's archived 2026 set and its 2027 set in use with a logo, a PDF artwork, black + red and two packaging
 * rules), the harness's local file store, sessions from the test authenticator. Every code and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/colours`.
 */

let h: Harness
let app: FastifyInstance
let seed: StylesDepthSeed

const NS = 'w2b247-colours'
const idOf = (key: string) => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const brandP1 = idOf('party:P1')
const customerP3 = idOf('party:P3')
const supplierP2 = idOf('party:P2')

const office = (tenantId: string, permissions: Permission[], companies: ScopeSet = 'all'): SessionContext => {
  const grant: Grant = { permissions, companies, sites: 'all', parties: 'all' }
  return { audience: 'office', tenantId, actorId: newId(), grants: [grant] }
}
const MAKER: Permission[] = ['product.styles.view', 'product.colours.manage', 'product.branding.manage', 'product.materials.view', 'files.read', 'files.upload', 'audit.read']
const SESSIONS: Record<string, SessionContext> = {
  maker: office(tenant, MAKER),
  // Sales keeps the brands' sets, not the colour library; no materials right (the material colour count is unknown).
  sales: office(tenant, ['product.styles.view', 'product.branding.manage', 'files.read', 'files.upload']),
  viewer: office(tenant, ['product.styles.view']),
  // The colour library of company B only: a colour of every company is not theirs to change.
  makerB: office(tenant, ['product.styles.view', 'product.colours.manage'], [companyB]),
  nobody: office(tenant, ['shipping.view']),
  otherTenant: office(newId(), MAKER),
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
const png = (text: string): Buffer => Buffer.from(`\x89PNG\r\n\x1a\n made-up ${text}`, 'latin1')

/** A file announced, sent and confirmed through the files platform (one PUT). */
async function upload(session: string, recordType: string, recordId: string, name: string, contentType: string, body: Buffer, kind = 'PHOTO', companyId: string | null = companyA): Promise<string> {
  const announced = await ok(session, 'POST', '/files', { companyId, recordType, recordId, kind, originalName: name, contentType, sizeBytes: body.length, sha256: sha(body) }, 201)
  expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })).statusCode).toBe(200)
  await ok(session, 'POST', `/files/${announced.file.id}/complete`)
  return announced.file.id
}

const library = async (session: string, query = ''): Promise<Json> => ok(session, 'GET', `/product/colours/library${query ? `?${query}` : ''}`)
const byCode = (view: Json, code: string): Json => view.colours.find((colour: Json) => colour.code === code)
const colourId = async (code: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "Colour" WHERE "tenantId" = $1 AND code = $2`, [tenant, code]))[0]!.id

beforeAll(async () => {
  h = await startHarness('w2b247_colours')
  h.clock.set('2026-11-10T09:00:00.000Z')
  await seedCore({ db: h.database, namespace: NS })
  seed = await seedStylesDepth({ db: h.database, namespace: NS })
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
  forgetPictureBytes()
  await app?.close()
  await h?.close()
}, 60_000)

describe('the colour library (PRD-041)', () => {
  it('lists the colours with their system, reference, family and what names them; a filter it cannot apply is named, not refused', async () => {
    const view = await library('maker')
    expect(byCode(view, 'SEED-BLK')).toMatchObject({ system: 'RAL', reference: 'RAL 9005', family: 'black', status: 'ACTIVE', photo: null })
    expect(byCode(view, 'SEED-RED')).toMatchObject({ system: 'PANTONE', reference: '18-1662 TCX', family: 'red' })
    expect(byCode(view, 'SEED-GRY')).toMatchObject({ system: 'OWN', reference: null, family: 'grey' })
    const black = byCode(view, 'SEED-BLK')
    const [ways] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Colourway" WHERE "colourId" = $1 AND status = 'ACTIVE'`, [black.id])
    const [items] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "ItemColour" WHERE "colourId" = $1 AND status = 'ACTIVE'`, [black.id])
    // Black is a brand colour of SEED-C1's set in use (the archived 2026 set does not count).
    expect(black.use).toEqual({ materialColours: items!.n, colourways: ways!.n, brandingSets: 1, inUse: true })
    expect(view.count).toBe(view.colours.length)
    expect(view.families).toEqual(expect.arrayContaining(['black', 'grey', 'red']))
    expect(view.ignored).toEqual([])
    // Without product.materials.view the material colour count is not the reader's ("—" on screen).
    expect(byCode(await library('sales'), 'SEED-BLK').use.materialColours).toBeNull()

    const filtered = await library('viewer', 'system=RAL&family=black')
    expect(filtered.colours.map((colour: Json) => colour.code)).toEqual(['SEED-BLK'])
    const odd = await library('viewer', 'system=XYZ&family=plaid')
    expect(odd.ignored).toEqual(['system=XYZ', 'family=plaid'])
    expect(odd.count).toBe(view.count)
    expect((await library('viewer', 'q=9005')).colours.map((colour: Json) => colour.code)).toEqual(['SEED-BLK'])
    const first = await library('viewer', 'limit=1')
    expect(first.colours).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = await library('viewer', `limit=1&cursor=${first.nextCursor}`)
    expect(second.colours[0].code > first.colours[0].code).toBe(true)

    await refused('nobody', 'GET', '/product/colours/library', undefined, 403)
    expect((await library('otherTenant')).colours).toEqual([])
  })

  it('a new colour: reference in its system’s form, the database’s rule said first, a taken code and a colour of every company refused in words', async () => {
    const created = (await ok('maker', 'POST', '/product/colours', { companyId: null, code: 'nx-navy', name: 'Blu notte', names: { it: 'Blu notte', en: 'Night blue' }, system: 'PANTONE', reference: 'pantone 19-4052 tcx', family: 'Blue', hex: '1f2a44' }, 201)).colour
    expect(created).toMatchObject({ code: 'NX-NAVY', names: { it: 'Blu notte', en: 'Night blue' }, system: 'PANTONE', reference: '19-4052 TCX', family: 'blue', hex: '#1F2A44', version: 1, use: { inUse: false, colourways: 0, brandingSets: 0 } })
    expect((await eventsOf('colour.changed')).at(-1)).toEqual({ colourId: created.id, code: 'NX-NAVY', change: 'CREATED', fields: [] })
    const [audit] = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'Colour' AND "recordId" = $1`, [created.id])
    expect(audit).toMatchObject({ action: 'product.colours.create', after: { code: 'NX-NAVY', system: 'PANTONE', reference: '19-4052 TCX' } })

    const noReference = await refused('maker', 'POST', '/product/colours', { companyId: companyA, code: 'NX-X', name: 'X', system: 'RAL' }, 400)
    expect(noReference.issues).toEqual([{ path: 'body/reference', message: 'A RAL colour needs its RAL reference (for example RAL 9005).' }])
    const badHex = await refused('maker', 'POST', '/product/colours', { companyId: companyA, code: 'NX-X', name: 'X', hex: 'blue' }, 400)
    expect(badHex.issues.map((issue: Json) => issue.path)).toEqual(['body/hex'])
    expect((await refused('maker', 'POST', '/product/colours', { companyId: companyA, code: 'NX-NAVY', name: 'Again' }, 409)).message).toBe('The colour code NX-NAVY is taken: pick another.')
    await refused('makerB', 'POST', '/product/colours', { companyId: null, code: 'NX-B1', name: 'B' }, 403)
    await refused('sales', 'POST', '/product/colours', { companyId: companyA, code: 'NX-S1', name: 'S' }, 403)
    // Company B's colour is theirs; they cannot change a colour of every company.
    const own = (await ok('makerB', 'POST', '/product/colours', { companyId: companyB, code: 'NX-B1', name: 'B one', system: 'OWN' }, 201)).colour
    expect(own.companyId).toBe(companyB)
    await refused('makerB', 'PATCH', `/product/colours/${created.id}`, { version: 1, name: 'Mine' }, 403)
  })

  it('changes a colour at its version; a stale version, a reference without its system and an archived colour are refused', async () => {
    const navy = byCode(await library('maker', 'q=NX-NAVY'), 'NX-NAVY')
    const changed = (await ok('maker', 'PATCH', `/product/colours/${navy.id}`, { version: navy.version, hex: '#222', family: 'navy', names: { en: null } })).colour
    expect(changed).toMatchObject({ hex: '#222222', family: 'navy', names: { it: 'Blu notte' }, version: navy.version + 1 })
    expect((await eventsOf('colour.changed')).at(-1)).toEqual({ colourId: navy.id, code: 'NX-NAVY', change: 'UPDATED', fields: ['names', 'family', 'hex'] })
    await refused('maker', 'PATCH', `/product/colours/${navy.id}`, { version: navy.version, name: 'Old' }, 409)
    // The system cleared takes its reference with it; a reference alone is refused.
    const cleared = (await ok('maker', 'PATCH', `/product/colours/${navy.id}`, { version: changed.version, system: null })).colour
    expect(cleared).toMatchObject({ system: null, reference: null })
    const alone = await refused('maker', 'PATCH', `/product/colours/${navy.id}`, { version: cleared.version, reference: 'X-1' }, 400)
    expect(alone.issues).toEqual([{ path: 'body/reference', message: 'Say which colour system the reference is in.' }])

    // Unused: a colour nothing names; archived it leaves the view, a change of it is refused, restore brings it back.
    expect((await library('viewer', 'view=unused')).colours.map((colour: Json) => colour.code)).toContain('NX-NAVY')
    const archived = (await ok('maker', 'POST', `/product/colours/${navy.id}/archive`, { version: cleared.version, reason: 'Not used this season' })).colour
    expect(archived.status).toBe('ARCHIVED')
    expect((await library('viewer', 'view=unused')).colours.map((colour: Json) => colour.code)).not.toContain('NX-NAVY')
    expect((await library('viewer', 'view=archived')).colours.map((colour: Json) => colour.code)).toContain('NX-NAVY')
    expect((await refused('maker', 'PATCH', `/product/colours/${navy.id}`, { version: archived.version, name: 'X' }, 409)).message).toBe('Colour NX-NAVY is archived: restore it before changing it.')
    await refused('maker', 'POST', `/product/colours/${navy.id}/archive`, { version: archived.version }, 409)
    const restored = (await ok('maker', 'POST', `/product/colours/${navy.id}/restore`, { version: archived.version })).colour
    expect(restored.status).toBe('ACTIVE')
    expect((await eventsOf('colour.changed')).slice(-2).map((event: Json) => event.change)).toEqual(['ARCHIVED', 'RESTORED'])
  })

  it('edits cells through the list’s bulk target: one row saved, an archived row held', async () => {
    const navy = byCode(await library('maker', 'q=NX-NAVY'), 'NX-NAVY')
    const own = byCode(await library('maker', 'q=NX-B1'), 'NX-B1')
    await ok('maker', 'POST', `/product/colours/${own.id}/archive`, { version: own.version })
    const preview = (await ok('maker', 'POST', '/views/bulk/preview', { listKey: 'products.colours', ids: [navy.id, own.id], changes: { family: 'midnight' } })).rows
    expect(preview.map((row: Json) => [row.label, row.refusal?.code ?? null])).toEqual([
      ['NX-NAVY', null],
      ['NX-B1', 'held'],
    ])
    const applied = (await ok('maker', 'POST', '/views/bulk/apply', { listKey: 'products.colours', rows: [{ id: navy.id, version: navy.version, changes: { family: 'midnight', reference: 'NX-MID' } }] })).results
    expect(applied[0]).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    const fixed = (await ok('maker', 'POST', '/views/bulk/apply', { listKey: 'products.colours', rows: [{ id: navy.id, version: navy.version, changes: { system: 'OWN', reference: 'NX-MID', family: 'midnight' } }] })).results
    expect(fixed[0]).toMatchObject({ ok: true, after: { system: 'OWN', reference: 'NX-MID', family: 'midnight' }, version: navy.version + 1 })
    await refused('viewer', 'POST', '/views/bulk/apply', { listKey: 'products.colours', rows: [{ id: navy.id, version: navy.version + 1, changes: { family: 'x' } }] }, 403)
  })

  it("serves a colour's photo through the API (the newest picture of the colour), cached; nothing else of the file store", async () => {
    const navy = byCode(await library('maker', 'q=NX-NAVY'), 'NX-NAVY')
    const fileId = await upload('maker', 'Colour', navy.id, 'navy swatch.png', 'image/png', png('navy'), 'PHOTO', null)
    const row = byCode(await library('viewer', 'q=NX-NAVY'), 'NX-NAVY')
    expect(row.photo).toEqual({ fileId, name: 'navy swatch.png', url: `/product/colours/pictures/${fileId}` })
    const bytes = await call('viewer', 'GET', row.photo.url)
    expect(bytes.statusCode).toBe(200)
    expect(bytes.headers['content-type']).toBe('image/png')
    expect(bytes.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(bytes.rawPayload.equals(png('navy'))).toBe(true)
    // A style's picture is B-W2b-236's route, not this one; another tenant finds nothing.
    const [stylePicture] = await admin<{ fileId: string }>(`SELECT "fileId" FROM "StyleImage" WHERE id = $1`, [seed.imageIds.front])
    await refused('viewer', 'GET', `/product/colours/pictures/${stylePicture!.fileId}`, undefined, 404)
    await refused('otherTenant', 'GET', row.photo.url, undefined, 404)
  })

  it('counts the tiles and the facts the notices say', async () => {
    const counts = await ok('viewer', 'GET', '/product/colours/counts')
    const [unused] = await admin<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Colour" c WHERE c."tenantId" = $1 AND c.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM "Colourway" w WHERE w."colourId" = c.id AND w.status = 'ACTIVE')
         AND NOT EXISTS (SELECT 1 FROM "ItemColour" i WHERE i."colourId" = c.id AND i.status = 'ACTIVE')
         AND NOT EXISTS (SELECT 1 FROM "BrandingSet" s WHERE s.status = 'ACTIVE' AND c.id = ANY (s."brandColourIds"))`,
      [tenant],
    )
    const [noHex] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Colour" WHERE "tenantId" = $1 AND status = 'ACTIVE' AND hex IS NULL`, [tenant])
    expect(counts.tiles).toEqual({ unused: unused!.n, brandingSets: 1 })
    expect(counts.noHex).toBe(noHex!.n)
    // SEED-C1 has its 2027 set in use in company A: none of its styles there lacks one.
    expect(counts.brandsWithoutSet.brands.map((brand: Json) => brand.partyId)).not.toContain(brandP1)
    await admin(`UPDATE "Style" SET "brandPartyId" = $1 WHERE "tenantId" = $2 AND code = 'SEED-JKT-02'`, [customerP3, tenant])
    const after = await ok('viewer', 'GET', '/product/colours/counts')
    expect(after.brandsWithoutSet.brands).toContainEqual(expect.objectContaining({ partyId: customerP3, code: 'SEED-C2', styles: 1 }))
    expect(after.brandsWithoutSet.count).toBe(counts.brandsWithoutSet.count + 1)
  })
})

describe('the branding sets of private-label customers (PRD-045)', () => {
  it("lists the brand's sets: the one in use with its logo, colours, rules and the styles that read it; the archived one", async () => {
    const { sets } = await ok('viewer', 'GET', '/product/branding-sets')
    expect(sets.map((set: Json) => [set.code, set.status, set.party.code])).toEqual([
      ['SEED-BS-P1-2027', 'ACTIVE', 'SEED-C1'],
      ['SEED-BS-P1-2026', 'ARCHIVED', 'SEED-C1'],
    ])
    const [active, old] = sets
    expect(active).toMatchObject({ logos: 1, artwork: 1, rules: 2, colours: [{ code: 'SEED-BLK' }, { code: 'SEED-RED' }] })
    expect(active.logo).toMatchObject({ role: 'LOGO', name: 'Seed brand P1 logo.png', picture: true, available: true, url: `/product/colours/pictures/${active.logo.fileId}` })
    const [linked] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Style" WHERE "tenantId" = $1 AND "brandPartyId" = $2 AND status <> 'ARCHIVED' AND ("companyId" = $3 OR "companyId" IS NULL)`, [tenant, brandP1, companyA])
    expect(active.stylesLinked).toBe(linked!.n)
    expect(old.stylesLinked).toBeNull()
    const detail = (await ok('viewer', 'GET', `/product/branding-sets/${active.id}`)).set
    expect(detail.files.map((file: Json) => [file.role, file.name, file.picture])).toEqual([
      ['LOGO', 'Seed brand P1 logo.png', true],
      ['ARTWORK', 'Seed brand P1 main label.pdf', false],
    ])
    expect(detail.packagingRules).toEqual([
      { key: 'polybag', text: 'One garment per polybag with the brand sticker (made-up).', item: expect.objectContaining({ id: seed.packagingItemId }), quantity: '1', per: 'GARMENT' },
      { key: 'hang-tag', text: 'Brand hang tag on the left sleeve zip puller (made-up).', item: null, quantity: null, per: null },
    ])
    expect(detail.styles.length).toBe(linked!.n)
    expect((await ok('viewer', 'GET', `/product/branding-sets/${old.id}`)).set.activeOther).toMatchObject({ code: 'SEED-BS-P1-2027' })
    await refused('otherTenant', 'GET', `/product/branding-sets/${active.id}`, undefined, 404)
    expect((await ok('viewer', 'GET', '/product/branding-sets?q=SEED-C1&status=ACTIVE')).sets).toHaveLength(1)
  })

  it('sales starts a set for another customer, sends a logo and artwork as files of the set, then names them', async () => {
    const brands = (await ok('sales', 'GET', '/product/branding-sets/brands?q=SEED-C')).brands
    expect(brands.map((brand: Json) => brand.code)).toEqual(expect.arrayContaining(['SEED-C1', 'SEED-C2']))
    expect(brands.find((brand: Json) => brand.code === 'SEED-C1').active.map((set: Json) => set.code)).toEqual(['SEED-BS-P1-2027'])
    const red = await colourId('SEED-RED')
    const created = (
      await ok('sales', 'POST', '/product/branding-sets', { companyId: companyA, partyId: customerP3, code: 'bs-c2-2027', name: 'Seed C2 2027', brandColourIds: [red], packagingRules: [{ key: 'Hang Tag', text: 'C2 hang tag on the collar' }, { key: 'polybag', text: 'One per polybag', itemId: seed.packagingItemId, quantity: '1', per: 'GARMENT' }] }, 201)
    ).set
    expect(created).toMatchObject({ code: 'BS-C2-2027', status: 'ACTIVE', version: 1, party: { code: 'SEED-C2' }, colours: [{ code: 'SEED-RED' }], logos: 0, artwork: 0 })
    expect(created.packagingRules.map((rule: Json) => rule.key)).toEqual(['hang-tag', 'polybag'])
    expect((await eventsOf('branding_set.changed')).at(-1)).toEqual({ brandingSetId: created.id, partyId: customerP3, code: 'BS-C2-2027', change: 'CREATED', fields: [] })

    const logo = await upload('sales', 'BrandingSet', created.id, 'C2 logo.png', 'image/png', png('c2 logo'))
    const withLogo = (await ok('sales', 'POST', `/product/branding-sets/${created.id}/files`, { version: 1, fileId: logo, role: 'LOGO' })).set
    expect(withLogo.logo).toMatchObject({ fileId: logo, url: `/product/colours/pictures/${logo}` })
    const pdf = await upload('sales', 'BrandingSet', created.id, 'C2 main label.pdf', 'application/pdf', Buffer.from('%PDF-1.4 made-up'), 'DOCUMENT')
    // A PDF is no logo; it is label artwork.
    const notLogo = await refused('sales', 'POST', `/product/branding-sets/${created.id}/files`, { version: withLogo.version, fileId: pdf, role: 'LOGO' }, 400)
    expect(notLogo.issues).toEqual([{ path: 'body/fileId', message: 'A logo is a picture: JPEG, PNG or WebP.' }])
    const both = (await ok('sales', 'POST', `/product/branding-sets/${created.id}/files`, { version: withLogo.version, fileId: pdf, role: 'ARTWORK' })).set
    expect(both.files.map((file: Json) => [file.role, file.name])).toEqual([
      ['LOGO', 'C2 logo.png'],
      ['ARTWORK', 'C2 main label.pdf'],
    ])
    expect((await refused('sales', 'POST', `/product/branding-sets/${created.id}/files`, { version: both.version, fileId: pdf, role: 'ARTWORK' }, 409)).message).toBe('C2 main label.pdf is in the set already.')
    // A file of another record is not the set's.
    const stranger = await upload('sales', 'Style', seed.styleIds.jkt01, 'not ours.png', 'image/png', png('stranger'))
    await refused('sales', 'POST', `/product/branding-sets/${created.id}/files`, { version: both.version, fileId: stranger, role: 'LOGO' }, 400)
    // The logo picture is served to a reader of the set; the bytes are the file's.
    const bytes = await call('viewer', 'GET', `/product/colours/pictures/${logo}`)
    expect(bytes.statusCode).toBe(200)
    expect(bytes.rawPayload.equals(png('c2 logo'))).toBe(true)
    // The styles of the brand in the set's company (SEED-JKT-02, moved to SEED-C2 above) read it.
    const [linked] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Style" WHERE "tenantId" = $1 AND "brandPartyId" = $2 AND status <> 'ARCHIVED' AND ("companyId" = $3 OR "companyId" IS NULL)`, [tenant, customerP3, companyA])
    expect(linked!.n).toBeGreaterThan(0)
    expect(both.stylesLinked).toBe(linked!.n)
  })

  it('changes a set at its version: rules and colours in words first, files only reordered or removed; replace archives the brand’s old set in one command', async () => {
    const { sets } = await ok('maker', 'GET', '/product/branding-sets?status=ACTIVE&q=SEED-C2')
    const set = (await ok('maker', 'GET', `/product/branding-sets/${sets[0].id}`)).set
    const bad = await refused('maker', 'PATCH', `/product/branding-sets/${set.id}`, { version: set.version, packagingRules: [{ key: 'box', text: 'Box of 10', itemId: seed.packagingItemId }] }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/packagingRules/0/quantity'])
    const archivedColour = (await ok('maker', 'POST', '/product/colours', { companyId: companyA, code: 'NX-OLD', name: 'Old' }, 201)).colour
    await ok('maker', 'POST', `/product/colours/${archivedColour.id}/archive`, { version: 1 })
    const colourRefused = await refused('maker', 'PATCH', `/product/branding-sets/${set.id}`, { version: set.version, brandColourIds: [archivedColour.id] }, 400)
    expect(colourRefused.issues).toEqual([{ path: 'body/brandColourIds/0', message: 'Colour NX-OLD is archived: restore it first.' }])
    const unknown = await refused('maker', 'PATCH', `/product/branding-sets/${set.id}`, { version: set.version, logoFileIds: [newId()] }, 400)
    expect(unknown.issues[0].path).toBe('body/logoFileIds')
    const changed = (await ok('maker', 'PATCH', `/product/branding-sets/${set.id}`, { version: set.version, name: 'Seed C2, 2027', note: 'Artwork each season (made-up).', logoFileIds: [], packagingRules: [] })).set
    expect(changed).toMatchObject({ name: 'Seed C2, 2027', logos: 0, rules: 0, packagingRules: [], note: 'Artwork each season (made-up).' })
    expect((await eventsOf('branding_set.changed')).at(-1)).toMatchObject({ change: 'UPDATED', fields: ['name', 'note', 'logoFileIds', 'packagingRules'] })
    await refused('viewer', 'PATCH', `/product/branding-sets/${set.id}`, { version: changed.version, name: 'X' }, 403)

    // A second set for the brand: refused in words, unless it replaces the one in use.
    const second = { companyId: companyA, partyId: customerP3, code: 'BS-C2-2028', name: 'Seed C2 2028' }
    expect((await refused('sales', 'POST', '/product/branding-sets', second, 409)).message).toBe('SEED-C2 has branding set BS-C2-2027 in use in this company: archive it, or start the new set to replace it.')
    const replaced = (await ok('sales', 'POST', '/product/branding-sets', { ...second, replace: true }, 201)).set
    expect(replaced.status).toBe('ACTIVE')
    const old = (await ok('viewer', 'GET', `/product/branding-sets/${set.id}`)).set
    expect(old).toMatchObject({ status: 'ARCHIVED', activeOther: { code: 'BS-C2-2028' } })
    expect((await eventsOf('branding_set.changed')).slice(-2).map((event: Json) => [event.code, event.change])).toEqual([
      ['BS-C2-2027', 'ARCHIVED'],
      ['BS-C2-2028', 'CREATED'],
    ])
    // Restoring the old one while the new one is in use: refused, naming it; an archived set is not changed.
    expect((await refused('sales', 'POST', `/product/branding-sets/${set.id}/restore`, { version: old.version }, 409)).message).toBe('Branding set BS-C2-2027 cannot be in use beside BS-C2-2028: a brand has one set in use per company. Archive BS-C2-2028 first.')
    expect((await refused('sales', 'PATCH', `/product/branding-sets/${set.id}`, { version: old.version, name: 'X' }, 409)).message).toBe('Branding set BS-C2-2027 is archived: restore it before changing it.')
    const archivedNew = (await ok('sales', 'POST', `/product/branding-sets/${replaced.id}/archive`, { version: replaced.version, reason: 'Back to the 2027 set' })).set
    expect(archivedNew.status).toBe('ARCHIVED')
    expect((await ok('sales', 'POST', `/product/branding-sets/${set.id}/restore`, { version: old.version })).set.status).toBe('ACTIVE')
  })

  it('refuses a set for a party that is no customer or brand, a taken code, and the colour library to sales', async () => {
    const supplier = await refused('sales', 'POST', '/product/branding-sets', { companyId: companyA, partyId: supplierP2, code: 'BS-S1', name: 'Supplier' }, 400)
    expect(supplier.issues[0].path).toBe('body/partyId')
    expect((await refused('sales', 'POST', '/product/branding-sets', { companyId: companyB, partyId: brandP1, code: 'SEED-BS-P1-2027', name: 'Again' }, 409)).message).toBe('The branding set code SEED-BS-P1-2027 is taken: pick another.')
    await refused('viewer', 'POST', '/product/branding-sets', { companyId: companyB, partyId: brandP1, code: 'BS-X', name: 'X' }, 403)
    // The same brand in company B: a set of its own there (one in use per company).
    const inB = (await ok('sales', 'POST', '/product/branding-sets', { companyId: companyB, partyId: brandP1, code: 'BS-P1-B', name: 'P1 in B' }, 201)).set
    expect(inB.companyId).toBe(companyB)
  })
})
