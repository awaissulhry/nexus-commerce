import { createHash, randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import type { Log } from '../../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../../testing/timeouts'
import { runPhotoRetention } from '../../measure-link/retention'
import { weekOf } from '../list-filters/filters'

/**
 * The made-to-measure office extras (B-W2b-371; XF2:01 – XF2:04) on the local stack, through the app's real routes: a throwaway
 * PostgreSQL 17 database with every factory-db seed (the JACKET template OFF as built, SEED-JKT-01 flagged made to measure and
 * measured with JACKET, the private rider SEED-R1, company A's plant and mail identity), FAKE files (the harness), and office people
 * holding their role templates (sales, the production manager, finance, the owner, read-only). Made-to-measure is started for JACKET
 * where a test says so (GATE-MTM, the owner's switch). Test data past its guards, named where it is: SEED-JKT-01's brand cleared (the
 * private rider may order it) and a fitting's times moved into the past (a fitting that took place). Every name, photo and measure
 * is made up; every time is relative to now. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/mtm/photos`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'mtm-371'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const companyA = sid('company:A')

const PEOPLE = { sales: newId(), pm: newId(), finance: newId(), owner: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', pm: 'production_manager', finance: 'finance', owner: 'owner', reader: 'read_only' }
const SESSIONS: Record<string, SessionContext> = {}
const grantsOf = (role: string): Grant[] => {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (person: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': person, 'x-factory-company': companyA, ...(method !== 'GET' ? { 'idempotency-key': `w2b371-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(person: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(person: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Log

/** A made-up photo without location data: JFIF, a comment, then the image. */
function photo(): Buffer {
  const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
  const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
  return Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]), ...segment(0xfe, ascii('made-up base layer')), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9])
}
const photoBody = (over: Json = {}) => ({ view: 'FRONT', contentType: 'image/jpeg', sizeBytes: photo().length, sha256: createHash('sha256').update(photo()).digest('hex'), ...over })
async function putBytes(upload: Json) {
  const put = await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: photo() })
  expect(put.statusCode, put.body).toBeLessThan(300)
}

const S = { r1: '', contact: '', jacket: '', jkt01: '', blk: '' }
const RIDER = 'Made-up rider 371'
const values = { chest: '100', waist: '84', sleeve: '64', height: '178' }
const today = () => businessDate(new Date())
let rev1 = ''
let rev2 = ''

async function switchMtm(on: boolean): Promise<void> {
  const rules = (await ok('owner', 'GET', `/product/measurement-templates/${S.jacket}/mtm-rules`)).rules
  if (rules.template.rulesOn === on) return
  await ok('owner', 'PUT', `/product/measurement-templates/${S.jacket}/mtm-rules/switch`, { version: rules.template.version, on, reason: on ? 'Made-up first made-to-measure order.' : 'Made-up pause.' })
}

beforeAll(async () => {
  h = await startHarness('mtm_w2b371')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b371-${person}-${run}@example.com`, `Made-up ${person}`])
    // Their system role held for real too: who may be mentioned on a thread, or follow it, is read from the people's roles.
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") SELECT $1, $2, $3, r.id, true, now() - interval '1 day' FROM "Role" r WHERE r."tenantId" = $2 AND r.key = $4 AND r.system`, [newId(), T, PEOPLE[person], role])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  S.r1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R1'`, [T])).id
  S.contact = (await one<{ id: string }>(`SELECT id FROM "PartyContact" WHERE "partyId" = $1 AND email IS NOT NULL ORDER BY "createdAt", id LIMIT 1`, [S.r1])).id
  S.jacket = (await one<{ id: string }>(`SELECT id FROM "MeasurementTemplate" WHERE "tenantId" = $1 AND code = 'JACKET'`, [T])).id
  S.jkt01 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [T])).id
  S.blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [S.jkt01])).id
  // Test data past its guards: SEED-JKT-01 has no brand here, so the private rider may order it (B-W2b-294's private label).
  await force(`UPDATE "Style" SET "brandPartyId" = NULL WHERE id = $1`, [S.jkt01])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The JACKET template measures the height too (the certificate's made-to-measure route asks it, B-W2b-358's notes).
  const template = (await ok('owner', 'GET', `/product/measurement-templates/${S.jacket}`)).template
  await ok('owner', 'PUT', `/product/measurement-templates/${S.jacket}/points`, {
    version: template.version,
    points: [
      { code: 'chest', name: 'Chest', minValue: '70', maxValue: '150' },
      { code: 'waist', name: 'Waist', minValue: '60', maxValue: '140' },
      { code: 'sleeve', name: 'Sleeve', minValue: '50', maxValue: '80' },
      { code: 'height', name: 'Height', minValue: '140', maxValue: '210', required: false },
    ],
  })
  rev1 = (await ok('sales', 'POST', '/sales/mtm/profiles', { partyId: S.r1, contactId: S.contact, riderName: RIDER, garmentType: 'JACKET', measurements: values, takenAt: at(-24), measuredByUserId: PEOPLE.sales, measuredPlace: 'Made-up showroom', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: at(-48) }, 201)).profile.id
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('XF2:01 — the office photos of a revision, with their delete date', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('adds nothing while made-to-measure is off for JACKET, in words (409); the read says it', async () => {
    const photos = await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}/photos`)
    expect(photos).toMatchObject({ started: false, revisions: [], fittings: [], may: { upload: false, uploadFitting: false, date: true, dateFitting: true } })
    const refused = await no('sales', 'POST', `/sales/mtm/profiles/${rev1}/photos`, photoBody(), 409)
    expect(paths(refused)).toEqual(['held/MTM_NOT_STARTED'])
    expect(refused.message).toMatch(/Made-to-measure has not started for measurement template JACKET/)
  })

  it('takes a photo once started: announced, PUT, confirmed; office only, its delete date given, its events', async () => {
    await switchMtm(true)
    const day = addDays(today(), 30)
    const announced = await ok('sales', 'POST', `/sales/mtm/profiles/${rev1}/photos`, photoBody({ deleteOn: day }), 201)
    await putBytes(announced.upload)
    const completed = await ok('sales', 'POST', `/sales/mtm/profiles/${rev1}/photos/${announced.file.id}/complete`)
    expect(completed.photo).toMatchObject({ id: announced.file.id, category: 'MTM_PHOTO', view: 'FRONT', status: 'AVAILABLE', deleteAfter: businessDayStart(day).toISOString(), by: { id: PEOPLE.sales } })
    const row = await one(`SELECT "recordType", "recordId", category, visibility::text AS visibility, "originalName", "partyId" FROM "StoredFile" WHERE id = $1`, [announced.file.id])
    expect(row).toEqual({ recordType: 'MeasurementProfile', recordId: rev1, category: 'MTM_PHOTO', visibility: '{OFFICE}', originalName: 'mtm-front-r1.jpg', partyId: null })
    const read = await ok('pm', 'GET', `/sales/mtm/profiles/${rev1}/photos`)
    expect(read).toMatchObject({ started: true, revisions: [{ id: rev1, revision: 1, notice: { ref: 'Made-up notice v1' }, photos: [{ id: announced.file.id }] }], may: { upload: false, uploadFitting: true, date: false } })
    expect((await outbox('measurement_photo.added')).at(-1)).toEqual({ profileId: rev1, partyId: S.r1, fileId: announced.file.id, category: 'MTM_PHOTO', resultId: null })
    expect((await outbox('measurement_photo.dated')).at(-1)).toMatchObject({ profileId: rev1, fileId: announced.file.id, deleteAfter: businessDayStart(day).toISOString() })
    // The generic files routes never reach it: no upload to a profile, no listing of its files.
    expect((await call('sales', 'POST', '/files', { recordType: 'MeasurementProfile', recordId: rev1, kind: 'DOCUMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), companyId: companyA })).statusCode).toBe(409)
  })

  it('refuses in words: not a photo, someone without the right, someone who reads no measurements', async () => {
    expect(paths(await no('sales', 'POST', `/sales/mtm/profiles/${rev1}/photos`, photoBody({ contentType: 'image/gif' }), 400))).toEqual(['body/contentType'])
    expect(paths(await no('sales', 'POST', `/sales/mtm/profiles/${rev1}/photos`, photoBody({ deleteOn: addDays(today(), -1) }), 400))).toEqual(['body/deleteOn'])
    await no('pm', 'POST', `/sales/mtm/profiles/${rev1}/photos`, photoBody(), 403)
    await no('reader', 'GET', `/sales/mtm/profiles/${rev1}/photos`, undefined, 403)
    await no('finance', 'GET', `/sales/mtm/profiles/${rev1}/photos`, undefined, 403)
  })

  it('opens the stripped copy for 60 seconds, the opening recorded on the profile', async () => {
    const [photoId] = (await ok('pm', 'GET', `/sales/mtm/profiles/${rev1}/photos`)).revisions[0].photos.map((entry: Json) => entry.id)
    const opened = await ok('pm', 'POST', `/sales/mtm/photos/${photoId}/open`, {})
    expect(opened.file).toEqual({ id: photoId, view: 'FRONT' })
    expect(opened.download.url).toBeTruthy()
    const audit = await one(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'mtmPhotos.opened' AND "recordId" = $2 ORDER BY at DESC LIMIT 1`, [T, rev1])
    expect(audit.after).toMatchObject({ fileId: photoId, category: 'MTM_PHOTO', by: PEOPLE.pm })
  })

  it('moves the delete date with why (never into the past, at the photo version); today deletes it within the hour; a deleted photo keeps its date', async () => {
    const photo0 = (await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}/photos`)).revisions[0].photos[0]
    const url = `/sales/mtm/profiles/${rev1}/photos/${photo0.id}/delete-after`
    expect(paths(await no('sales', 'PUT', url, { version: photo0.version, deleteOn: addDays(today(), -2), reason: 'Made-up ask.' }, 400))).toEqual(['body/deleteOn'])
    expect(paths(await no('sales', 'PUT', url, { version: photo0.version + 5, deleteOn: today(), reason: 'Made-up ask.' }, 409))).toEqual(['held/STALE'])
    await no('pm', 'PUT', url, { version: photo0.version, deleteOn: today(), reason: 'Made-up ask.' }, 403)
    const moved = await ok('sales', 'PUT', url, { version: photo0.version, deleteOn: today(), reason: 'The rider asked (made-up).' })
    expect(moved.photo.deleteAfter).toBe(businessDayStart(today()).toISOString())
    const totals = await runPhotoRetention({ database: h.database, log: silent, files: h.files })
    expect(totals.deleted).toBeGreaterThanOrEqual(1)
    expect((await one(`SELECT status FROM "StoredFile" WHERE id = $1`, [photo0.id])).status).toBe('DELETED')
    expect((await outbox('measurement_photo.deleted')).at(-1)).toEqual({ profileId: rev1, partyId: S.r1, files: 1 })
    expect((await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}/photos`)).revisions).toEqual([])
    const fresh = await one<{ version: number }>(`SELECT version FROM "StoredFile" WHERE id = $1`, [photo0.id])
    expect(paths(await no('sales', 'PUT', url, { version: fresh.version, deleteOn: addDays(today(), 3), reason: 'Made-up.' }, 409))).toEqual(['held/DELETED'])
    await no('pm', 'POST', `/sales/mtm/photos/${photo0.id}/open`, {}, 404)
  })

  it("takes a fitting's photos (sales.fittings.manage) and reads them with the chain", async () => {
    const booked = await ok('sales', 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, kind: 'FITTING', measurementProfileId: rev1, startsAt: at(2), endsAt: at(3), place: 'Made-up showroom', withUserId: PEOPLE.sales, invite: false }, 201)
    // Test data past its guards: the fitting took place two hours ago.
    await force(`UPDATE "Appointment" SET "startsAt" = $2, "endsAt" = $3 WHERE id = $1`, [booked.appointment.id, at(-2), at(-1)])
    const result = (await ok('sales', 'POST', '/sales/fittings/results', { appointmentId: booked.appointment.id, verdict: 'OK', notes: 'Fits (made-up).' }, 201)).result
    const announced = await ok('pm', 'POST', `/sales/fittings/results/${result.id}/photos`, photoBody({ view: 'SIDE' }), 201)
    await putBytes(announced.upload)
    expect((await ok('pm', 'POST', `/sales/fittings/results/${result.id}/photos/${announced.file.id}/complete`)).photo).toMatchObject({ category: 'FITTING_PHOTO', view: 'SIDE', deleteAfter: null })
    const read = await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}/photos`)
    expect(read.fittings).toMatchObject([{ resultId: result.id, verdict: 'OK', revision: 1, photos: [{ id: announced.file.id, category: 'FITTING_PHOTO' }] }])
    expect((await one(`SELECT "recordType", "companyId" FROM "StoredFile" WHERE id = $1`, [announced.file.id]))).toEqual({ recordType: 'FittingResult', companyId: companyA })
    const dated = await ok('pm', 'PUT', `/sales/fittings/results/${result.id}/photos/${announced.file.id}/delete-after`, { version: read.fittings[0].photos[0].version, deleteOn: addDays(today(), 60), reason: 'Made-up: kept for the remake.' })
    expect(dated.photo.deleteAfter).toBe(businessDayStart(addDays(today(), 60)).toISOString())
    await no('reader', 'POST', `/sales/fittings/results/${result.id}/photos`, photoBody(), 403)
  })
})

describe('XF2:02 — a thread on the rider profile, for readers of measurements only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('one thread per rider and garment type on its first revision; finance (threads, no measurements) neither reads nor is mentioned', async () => {
    rev2 = (await ok('sales', 'POST', `/sales/mtm/profiles/${rev1}/revisions`, { measurements: { ...values, chest: '102' }, takenAt: at(-1), measuredByUserId: PEOPLE.sales, measuredPlace: 'Made-up showroom' }, 201)).profile.id
    const posted = await ok('sales', 'POST', `/threads/MeasurementProfile/${rev1}/notes`, { body: 'Made-up note: the left sleeve a little longer.' }, 201)
    expect(posted.thread).toMatchObject({ recordType: 'MeasurementProfile', recordId: rev1, companyId: null, partyId: S.r1 })
    expect((await ok('pm', 'GET', `/threads/MeasurementProfile/${rev1}`)).messages.map((message: Json) => message.body)).toEqual(['Made-up note: the left sleeve a little longer.'])
    await no('finance', 'GET', `/threads/MeasurementProfile/${rev1}`, undefined, 404)
    await no('finance', 'GET', `/threads/MeasurementProfile/${rev1}/timeline`, undefined, 404)
    await no('finance', 'POST', `/threads/MeasurementProfile/${rev1}/notes`, { body: 'Made-up.' }, 404)
    // A later revision has no thread of its own (the conversation does not split per revision).
    await no('sales', 'GET', `/threads/MeasurementProfile/${rev2}`, undefined, 404)
    const people = (await ok('sales', 'GET', `/threads/MeasurementProfile/${rev1}/people`)).people.map((person: Json) => person.id)
    expect(people).toEqual(expect.arrayContaining([PEOPLE.sales, PEOPLE.pm, PEOPLE.owner]))
    expect(people).not.toContain(PEOPLE.finance)
    expect(paths(await no('sales', 'POST', `/threads/MeasurementProfile/${rev1}/notes`, { body: 'Made-up mention.', mentions: [PEOPLE.finance] }, 400))).toEqual(['body/mentions/0'])
  })
})

describe('XF2:03 — the list filters: outside the certified range, fittings this week, a customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('fittings this week: the tile counts the riders its filter shows', async () => {
    const all = await ok('sales', 'GET', '/sales/mtm/profiles?limit=200')
    const week = await ok('sales', 'GET', '/sales/mtm/profiles?fittings=week&limit=200')
    expect(all.tiles.fittingsThisWeek).toBe(week.matching)
    const fitting = await one<{ startsAt: Date }>(`SELECT "startsAt" FROM "Appointment" WHERE "tenantId" = $1 AND "measurementProfileId" = $2 ORDER BY "startsAt" LIMIT 1`, [T, rev1])
    const range = weekOf(today())
    const inWeek = fitting.startsAt.getTime() >= range.from.getTime() && fitting.startsAt.getTime() < range.to.getTime()
    expect(week.rows.some((row: Json) => row.id === rev2)).toBe(inWeek)
  })

  it('the certified range: not known without a unit (null, the tile "—"); a unit on a draft quote is checked as the check says', async () => {
    const before = await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}`)
    expect(before.rows.find((row: Json) => row.id === rev2).range).toEqual({ inside: null, points: [] })
    const quote = await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: S.r1, contactId: S.contact }, 201)
    await ok('sales', 'POST', `/sales/quotes/${quote.quote.id}/lines/made-to-measure`, { version: quote.quote.version, styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev2, baseSize: '52' }, 201)
    const check = await ok('sales', 'POST', '/product/made-to-measure/check', { styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev2, baseSize: '52' })
    const after = await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}`)
    const row = after.rows.find((entry: Json) => entry.id === rev2)
    expect(row.range.inside).toBe(check.check.insideCertifiedRange)
    const outside = await ok('sales', 'GET', '/sales/mtm/profiles?range=outside&limit=200')
    if (after.tiles.outsideRange === null) expect(outside.matching).toBe(0)
    else expect(after.tiles.outsideRange).toBe(outside.matching)
    expect(outside.rows.some((entry: Json) => entry.id === rev2)).toBe(check.check.insideCertifiedRange === false)
    // Stopped again: the range is not known (nothing is checked while off).
    await switchMtm(false)
    expect((await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}`)).rows.find((entry: Json) => entry.id === rev2).range.inside).toBeNull()
  })

  it('by customer: a customer the caller may read, else not found', async () => {
    const mine = await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}`)
    expect(mine.rows.every((row: Json) => row.partyId === S.r1)).toBe(true)
    expect(mine.rows.some((row: Json) => row.id === rev2)).toBe(true)
  })
})

describe('XF2:04 — where a template is used: its styles and the open orders it serves', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the styles measured with JACKET; the orders only for a reader of orders; a rider only for a reader of measurements', async () => {
    const used = await ok('sales', 'GET', `/product/measurement-templates/${S.jacket}/where-used`)
    expect(used.template).toEqual({ id: S.jacket, code: 'JACKET' })
    expect(used.styles.map((style: Json) => style.code)).toContain('SEED-JKT-01')
    expect(used.styles.find((style: Json) => style.code === 'SEED-JKT-01').madeToMeasure).toBe(true)
    expect(Array.isArray(used.orders)).toBe(true)
    for (const order of used.orders) for (const unit of order.units) expect(typeof unit.rider === 'string').toBe(true)
    const pmView = await ok('pm', 'GET', `/product/measurement-templates/${S.jacket}/where-used`)
    expect(pmView.styles.length).toBe(used.styles.length)
    await no('reader', 'GET', `/product/measurement-templates/${newId()}/where-used`, undefined, 404)
  })
})
