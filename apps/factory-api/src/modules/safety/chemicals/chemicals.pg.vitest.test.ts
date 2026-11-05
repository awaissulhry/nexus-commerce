import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedHealth, type HealthSeed } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * The chemical register, the safety data sheet library and the cabinet QR (B-W2b-143; QHS-277, QHS-278; D.Lgs. 81/2008 art.
 * 223; REACH art. 35) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime logins: row-level security, the floor's column grants and the …_protected_safety_w2b_guards triggers are
 * real), the factory-db seeds up to the health pages (A1's contact glue in cabinet CAB-CUT-1 with its Italian and English
 * sheets and an older one superseded, A1's edge paint, an archived solvent, B1's adhesive), the files on the harness's local
 * store (real uploads, real bytes), office and floor sessions from the test authenticator. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/safety/chemicals`.
 */

let h: Harness
let app: FastifyInstance
let health: HealthSeed
let safety: SafetySeed

const NS = 'w2b143-chemicals'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const OFFICER_ID = newId()
const OFFICER: Permission[] = ['safety.view', 'safety.chemicals.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: OFFICER_ID, grants: [grant(OFFICER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
  tabletA1: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [{ permissions: ['floor.work'], companies: [T.companyA], sites: [T.siteA1], parties: 'all' }] },
  tabletB1: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteB1, deviceId: newId(), grants: [{ permissions: ['floor.work'], companies: [T.companyB], sites: [T.siteB1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error?.issues ?? []).map((issue: Json) => String(issue.path))
}
const today = businessDate(new Date())
const eventsOf = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])

/** A made-up PDF's bytes (the store checks length and SHA-256, never the content). */
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% made-up safety data sheet ${label} ${run}\n%%EOF\n`)

/** Replace SDS's upload: announce, PUT the bytes to the presigned address, confirm. */
async function upload(session: string, chemicalId: string, label: string): Promise<{ fileId: string; bytes: Buffer }> {
  const bytes = pdf(label)
  const announced = await ok(session, 'POST', `/safety/chemicals/${chemicalId}/data-sheets/upload`, { originalName: `SDS ${label}.pdf`, contentType: 'application/pdf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 201)
  expect(announced.file).toMatchObject({ recordType: 'Chemical', recordId: chemicalId, kind: 'DOCUMENT', visibility: ['OFFICE', 'FLOOR'] })
  expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBe(200)
  expect((await ok(session, 'POST', `/safety/chemicals/${chemicalId}/data-sheets/upload/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return { fileId: announced.file.id, bytes }
}

/** The bytes behind a presigned GET of the local store. */
async function bytesOf(download: Json): Promise<Buffer> {
  const response = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(response.statusCode).toBe(200)
  return response.rawPayload
}

beforeAll(async () => {
  h = await startHarness('w2b143_chemicals')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  health = await seedHealth({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-officer@example.test', 'Made-up Officer', 'ACTIVE')`, [OFFICER_ID, T.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the chemical register (QHS-277; D.Lgs. 81/2008 art. 223)', () => {
  it('lists every product in use per site with its hazards, place, roles, PPE and current sheets; the tiles count from it', async () => {
    const list = await ok('officer', 'GET', `/safety/chemicals?siteId=${T.siteA1}`)
    expect(list.law).toEqual({ register: 'D.Lgs. 81/2008 art. 223', sds: 'REACH art. 35' })
    const names = list.chemicals.map((row: Json) => row.name)
    expect(names).toEqual(['Seed contact glue (made-up)', 'Seed edge paint (made-up)'])
    const glue = list.chemicals[0]
    expect(glue).toMatchObject({ use: 'GLUE', ghsPictograms: ['GHS02', 'GHS07'], signalWord: 'DANGER', cabinetCode: 'CAB-CUT-1', maxQuantity: '25', maxQuantityUnit: 'L', sheetState: 'OK', superseded: 1, language: 'it' })
    expect(glue.current.map((sheet: Json) => sheet.language).sort()).toEqual(['en', 'it'])
    expect(glue.roles.map((role: Json) => role.id)).toEqual([safety.roleSheetIds.cutter])
    expect(glue.ppe.map((item: Json) => item.id)).toEqual([safety.ppeItemIds.gloves])
    expect(glue.supplier.partyId).not.toBeNull()
    // The archived solvent only when asked.
    expect((await ok('officer', 'GET', `/safety/chemicals?siteId=${T.siteA1}&status=ARCHIVED`)).chemicals.map((row: Json) => row.id)).toEqual([health.chemicalIds.solvent])
    // Company B's register is its own; a role of company B never reads company A's.
    expect((await ok('companyB', 'GET', '/safety/chemicals')).chemicals.map((row: Json) => row.id)).toEqual([health.chemicalIds.b1Adhesive])
    expect((await call('companyB', 'GET', `/safety/chemicals/${health.chemicalIds.glue}`)).statusCode).toBe(404)
    // No money and no person in a row.
    expect(JSON.stringify(list)).not.toMatch(/cost|price|employee/i)
    const counts = await ok('officer', 'GET', `/safety/chemicals/counts?siteId=${T.siteA1}`)
    expect(counts).toEqual({ active: 2, withoutSds: 0, toRequest: 0, cabinets: 1 })
    // A role outside the safety pages is refused before anything is read.
    expect((await call('sales', 'GET', '/safety/chemicals')).statusCode).toBe(403)
  })

  it('adds a chemical with its statements in CLP writing; refuses a bad code, a role of another site and a reader', async () => {
    const body = {
      companyId: T.companyA,
      siteId: T.siteA1,
      name: 'Made-up primer',
      supplierName: 'Made-up Coatings',
      use: 'PRIMER',
      ghsPictograms: ['GHS02', 'GHS08'],
      signalWord: 'DANGER',
      hazardStatements: ['h225', 'H304 h336'],
      precautionStatements: ['P210', 'p301 + p310'],
      storagePlace: 'Finishing room, metal cabinet',
      cabinetCode: ' cab-fin-1 ',
      maxQuantity: '2.5',
      maxQuantityUnit: 'L',
      roleSheetIds: [safety.roleSheetIds.machinist],
      ppeItemIds: [safety.ppeItemIds.gloves],
    }
    expect(await no('officer', 'POST', '/safety/chemicals', { ...body, hazardStatements: ['H22'] }, 400)).toContain('body/hazardStatements')
    const refused = await no('officer', 'POST', '/safety/chemicals', { ...body, roleSheetIds: [safety.roleSheetIds.machinistB] }, 409)
    expect(refused).toEqual(['refusal/ROLE_OTHER_SITE', 'body/roleSheetIds'])
    expect((await call('viewer', 'POST', '/safety/chemicals', body)).statusCode).toBe(403)
    const added = (await ok('officer', 'POST', '/safety/chemicals', body, 201)).chemical
    expect(added).toMatchObject({ name: 'Made-up primer', hazardStatements: ['H225', 'H304', 'H336'], precautionStatements: ['P210', 'P301+P310'], cabinetCode: 'CAB-FIN-1', maxQuantity: '2.5', status: 'ACTIVE', sheetState: 'MISSING', current: [], version: 1, canManage: true })
    expect((await eventsOf('chemical.changed')).map((event) => event.payload)).toContainEqual({ chemicalId: added.id, siteId: T.siteA1, change: 'ADDED' })
    expect(await ok('officer', 'GET', `/safety/chemicals/counts?siteId=${T.siteA1}`)).toMatchObject({ active: 3, withoutSds: 1, cabinets: 2 })
    expect((await ok('officer', 'GET', `/safety/chemicals?siteId=${T.siteA1}&tile=withoutSds`)).chemicals.map((row: Json) => row.id)).toEqual([added.id])
    const choices = await ok('officer', 'GET', `/safety/chemicals/choices?siteId=${T.siteA1}`)
    expect(choices.roles.map((role: Json) => role.id)).toEqual(expect.arrayContaining([safety.roleSheetIds.cutter, safety.roleSheetIds.machinist]))
    expect(choices.roles.map((role: Json) => role.id)).not.toContain(safety.roleSheetIds.machinistB)
    expect(choices.cabinets).toEqual(['CAB-CUT-1', 'CAB-FIN-1'])
    expect((await call('viewer', 'GET', `/safety/chemicals/choices?siteId=${T.siteA1}`)).statusCode).toBe(403)
  })
})

describe('the data sheet library (QHS-278; REACH art. 35)', () => {
  it('takes the first sheet, then replaces it only with a newer one; the older is kept, superseded', async () => {
    const primer = (await ok('officer', 'GET', `/safety/chemicals?siteId=${T.siteA1}&q=primer`)).chemicals[0]
    // A sheet is a PDF.
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets/upload`, { originalName: 'sds.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 10, sha256: 'a'.repeat(64) }, 409)).toEqual(['refusal/FILE_NOT_PDF', 'body/contentType'])
    const first = await upload('officer', primer.id, 'v1')
    const one = await ok('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: first.fileId, versionLabel: '1.0', revisedOn: addDays(today, -400), language: 'en' }, 201)
    expect(one.superseded).toBeNull()
    expect(one.chemical).toMatchObject({ sheetState: 'OTHER_LANGUAGE' })
    expect(await ok('officer', 'GET', `/safety/chemicals/counts?siteId=${T.siteA1}`)).toMatchObject({ withoutSds: 0, toRequest: 1 })
    // The same file twice, an older revision, the same version: refused in words.
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: first.fileId, versionLabel: '1.1', revisedOn: today, language: 'en' }, 409)).toEqual(['refusal/FILE_NOT_READY', 'body/fileId'])
    const second = await upload('officer', primer.id, 'v2')
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: second.fileId, versionLabel: '0.9', revisedOn: addDays(today, -500), language: 'en' }, 409)).toEqual(['refusal/OLDER_THAN_CURRENT', 'body/revisedOn'])
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: second.fileId, versionLabel: '1.0', revisedOn: today, language: 'en' }, 409)).toEqual(['refusal/SAME_VERSION', 'body/versionLabel'])
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: second.fileId, versionLabel: '2.0', revisedOn: addDays(today, 1), language: 'en' }, 400)).toContain('body/revisedOn')
    const replaced = await ok('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: second.fileId, versionLabel: '2.0', revisedOn: today, language: 'en' }, 201)
    expect(replaced.superseded).toMatchObject({ id: one.sheet.id, status: 'SUPERSEDED', supersededBy: 'Made-up Officer' })
    expect(replaced.sheet).toMatchObject({ status: 'CURRENT', versionLabel: '2.0', addedBy: 'Made-up Officer' })
    expect((await eventsOf('sds.replaced')).map((event) => event.payload)).toContainEqual({ chemicalId: primer.id, siteId: T.siteA1, sheetId: replaced.sheet.id, supersededId: one.sheet.id, language: 'en' })
    // The Italian sheet next to it: the company's language, so nothing left to request.
    const italian = await upload('officer', primer.id, 'it')
    await ok('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets`, { fileId: italian.fileId, versionLabel: '2.0', revisedOn: today, language: 'it' }, 201)
    const record = await ok('viewer', 'GET', `/safety/chemicals/${primer.id}`)
    expect(record.chemical).toMatchObject({ sheetState: 'OK', superseded: 1, canManage: false })
    expect(record.sheets.map((sheet: Json) => `${sheet.versionLabel}/${sheet.language}/${sheet.status}`)).toEqual(['2.0/it/CURRENT', '2.0/en/CURRENT', '1.0/en/SUPERSEDED'])
    // The library: one row per current sheet with the versions it replaced.
    const library = await ok('viewer', 'GET', `/safety/chemicals/data-sheets?siteId=${T.siteA1}`)
    expect(library.missing).toEqual([])
    expect(library.sheets.find((row: Json) => row.chemicalId === primer.id && row.language === 'en').superseded.map((old: Json) => old.versionLabel)).toEqual(['1.0'])
    // A reader opens any version's PDF: the bytes are the ones uploaded.
    const download = await ok('viewer', 'GET', `/safety/chemicals/${primer.id}/data-sheets/${one.sheet.id}/download`)
    expect(download.fileName).toBe('SDS v1.pdf')
    expect((await bytesOf(download.download)).equals(first.bytes)).toBe(true)
    // A data sheet never changes, and is never deleted: the database holds it for every login.
    await expect(admin(`UPDATE "SafetyDataSheet" SET "versionLabel" = 'x' WHERE id = $1`, [replaced.sheet.id])).rejects.toThrow(/never changes/)
  })

  it('keeps an archived product and its sheets, takes no sheet for it, and puts it back in use', async () => {
    const primer = (await ok('officer', 'GET', `/safety/chemicals?siteId=${T.siteA1}&q=primer`)).chemicals[0]
    expect((await call('officer', 'PATCH', `/safety/chemicals/${primer.id}`, { version: primer.version - 1, name: 'x', use: 'PRIMER', ghsPictograms: [], hazardStatements: [], precautionStatements: [], storagePlace: 'x', roleSheetIds: [], ppeItemIds: [] })).statusCode).toBe(409)
    const edited = (await ok('officer', 'PATCH', `/safety/chemicals/${primer.id}`, { version: primer.version, name: 'Made-up primer', use: 'PRIMER', ghsPictograms: ['GHS02'], signalWord: 'WARNING', hazardStatements: ['H226'], precautionStatements: ['P210'], storagePlace: 'Finishing room, metal cabinet', cabinetCode: 'CAB-FIN-1', roleSheetIds: [], ppeItemIds: [] })).chemical
    expect(edited).toMatchObject({ hazardStatements: ['H226'], maxQuantity: null, roles: [], version: primer.version + 1 })
    const archived = (await ok('officer', 'POST', `/safety/chemicals/${primer.id}/archive`, { version: edited.version, reason: 'No longer bought' })).chemical
    expect(archived).toMatchObject({ status: 'ARCHIVED', current: [expect.anything(), expect.anything()] })
    expect(await no('officer', 'POST', `/safety/chemicals/${primer.id}/data-sheets/upload`, { originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 409)).toEqual(['refusal/ARCHIVED'])
    expect(await no('officer', 'PATCH', `/safety/chemicals/${primer.id}`, { version: archived.version, name: 'x', use: 'PRIMER', ghsPictograms: [], hazardStatements: [], precautionStatements: [], storagePlace: 'x', roleSheetIds: [], ppeItemIds: [] }, 409)).toEqual(['refusal/ARCHIVED'])
    expect((await ok('officer', 'GET', `/safety/chemicals/counts?siteId=${T.siteA1}`)).active).toBe(2)
    expect((await ok('officer', 'POST', `/safety/chemicals/${primer.id}/restore`, { version: archived.version })).chemical.status).toBe('ACTIVE')
    expect((await eventsOf('chemical.changed')).map((event) => event.payload.change)).toEqual(expect.arrayContaining(['EDITED', 'ARCHIVED', 'RESTORED']))
  })
})

describe('the cabinet QR (design plant.chemicals "SDS at the cabinet by QR, readable offline on floor devices")', () => {
  it("lists a site's cabinets and one cabinet's products for the wall sheet", async () => {
    const cabinets = (await ok('viewer', 'GET', `/safety/chemicals/cabinets?siteId=${T.siteA1}`)).cabinets
    expect(cabinets.map((cabinet: Json) => `${cabinet.code}:${cabinet.products}`)).toEqual(['CAB-CUT-1:2', 'CAB-FIN-1:1'])
    const sheet = await ok('viewer', 'GET', `/safety/chemicals/cabinets/${T.siteA1}/cab-cut-1`)
    expect(sheet).toMatchObject({ code: 'CAB-CUT-1', places: ['Glue cabinet, cutting room'] })
    expect(sheet.chemicals.map((row: Json) => row.name)).toEqual(['Seed contact glue (made-up)', 'Seed edge paint (made-up)'])
    expect(sheet.chemicals[0].ppe).toHaveLength(1)
    expect((await call('viewer', 'GET', `/safety/chemicals/cabinets/${T.siteA1}/NOPE`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/safety/chemicals/cabinets/${T.siteA1}/CAB-CUT-1`)).statusCode).toBe(404)
  })

  it("gives a tablet everything its site's cabinets hold, and the current PDFs only; never another site's", async () => {
    const pack = await ok('tabletA1', 'GET', '/safety/floor/chemicals')
    expect(pack).toMatchObject({ siteId: T.siteA1, language: 'it' })
    const glue = pack.chemicals.find((row: Json) => row.id === health.chemicalIds.glue)
    expect(glue).toMatchObject({ cabinetCode: 'CAB-CUT-1', signalWord: 'DANGER', ppe: [expect.any(String)] })
    expect(glue.current.map((sheet: Json) => sheet.language).sort()).toEqual(['en', 'it'])
    expect(glue.current[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.chemicals.map((row: Json) => row.id)).not.toContain(health.chemicalIds.solvent)
    expect(pack.chemicals.map((row: Json) => row.id)).not.toContain(health.chemicalIds.b1Adhesive)
    // The floor reads no party: the supplier's own words only.
    expect(JSON.stringify(pack)).not.toMatch(/partyId|cost|price/)
    const primer = pack.chemicals.find((row: Json) => row.name === 'Made-up primer')
    const english = primer.current.find((sheet: Json) => sheet.language === 'en')
    const download = await ok('tabletA1', 'GET', `/safety/floor/data-sheets/${english.id}/download`)
    expect(download).toMatchObject({ sha256: english.sha256, sizeBytes: english.sizeBytes })
    expect(createHash('sha256').update(await bytesOf(download.download)).digest('hex')).toBe(english.sha256)
    // A superseded sheet, another site's sheet and the office's routes: not for a tablet.
    const old = (await ok('officer', 'GET', `/safety/chemicals/${primer.id}`)).sheets.find((sheet: Json) => sheet.status === 'SUPERSEDED')
    expect((await call('tabletA1', 'GET', `/safety/floor/data-sheets/${old.id}/download`)).statusCode).toBe(404)
    expect((await call('tabletB1', 'GET', `/safety/floor/data-sheets/${english.id}/download`)).statusCode).toBe(404)
    expect((await ok('tabletB1', 'GET', '/safety/floor/chemicals')).chemicals.map((row: Json) => row.id)).toEqual([health.chemicalIds.b1Adhesive])
    expect((await call('tabletA1', 'GET', '/safety/chemicals')).statusCode).toBe(403)
    expect((await call('officer', 'GET', '/safety/floor/chemicals')).statusCode).toBe(403)
  })
})
