import { createHash, randomBytes } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedTechfiles } from '../../../../../../packages/factory-db/seed/techfiles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { useDeclarationsClock } from './common'

/**
 * The DoC generator (B-W2b-257; PRD-292, PRD-293, PRD-295, PRD-300) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and B-W2b-218's guards are real), the harness's local
 * file store behind a FAKE R2 account, on the seeds of the declarations and technical files (which run the shipping,
 * quality, production, compliance-rules and files seeds): SEED-JKT-02 (every company's, the brand SEED-C1 sells it under its
 * own name; certificate SEED-CERT-0003; revision 1 released; WO-0001's batch SEED-BT-0001 left on SEED-SH-0001), DEMO-OWN-1
 * (made up here: our own style of every company, no certificate), SEED-JKT-03 (a signed Italian DoC and a generated draft beside it). Every code, name and
 * address is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/declarations`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b257-declarations'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')

const ALL = ['compliance.certificates.view', 'compliance.declarations.generate', 'compliance.declarations.check', 'compliance.declarations.pack', 'compliance.declarations.manage', 'shipping.view', 'files.read', 'files.upload'] as Permission[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const checkerId = newId()
const SESSIONS: Record<string, SessionContext> = {
  quality: office(ALL),
  translator: office(ALL),
  checker: { ...office(ALL), actorId: checkerId } as SessionContext,
  viewer: office(['compliance.certificates.view'] as Permission[]),
  warehouse: office(['shipping.view', 'compliance.declarations.pack'] as Permission[]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async <Row = Json>(sql: string, values: unknown[]): Promise<Row> => (await admin<Row>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `dc-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pdfBytes = (text: string) => Buffer.from(`%PDF-1.4\n% made-up signed document: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** W1's three steps for a signed PDF: announce, put it in the store, confirm. */
async function uploadSigned(styleId: string, revisionId: string, kind: string, language: string, text: string): Promise<Json> {
  const body = pdfBytes(text)
  const announced = await ok('quality', 'POST', `/product/styles/${styleId}/compliance/documents`, { revisionId, kind, language, originalName: `${kind.toLowerCase()}-${language}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  return ok('quality', 'POST', `/product/styles/${styleId}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
}

/** The names of the entries of a zip (its central directory). */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    const size = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extra = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const data = zip.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    offset += 30 + nameLength + extra + size
  }
  return out
}

let jkt02 = ''
let jkt02Rev = ''
let jkt03 = ''
let trs01 = ''
let brand = ''
let wo1 = ''
let sh1 = ''
let sh2 = ''
let original: Json = {}
let german: Json = {}
let english: Json = {}

beforeAll(async () => {
  h = await startHarness('declarations')
  useDeclarationsClock(h.clock)
  await seedCore({ db: h.database, namespace: NS })
  await seedTechfiles({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const style = async (code: string) => (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code])).id
  jkt02 = await style('SEED-JKT-02')
  jkt03 = await style('SEED-JKT-03')
  // Our own style of every company, made up here: no brand, no certificate, no label template on its revision.
  trs01 = newId()
  await admin(
    `INSERT INTO "Style" (id, "tenantId", "companyId", code, name, "productType", "sizeScaleId", sizes, "ppeCategory", "ppeStandard", "ppeClass")
     SELECT $1, "tenantId", NULL, 'DEMO-OWN-1', 'Demo own trousers', "productType", "sizeScaleId", sizes, 'CATEGORY_II', 'EN 17092-4:2020', 'A' FROM "Style" WHERE id = $2`,
    [trs01, jkt02],
  )
  await admin('INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision) VALUES ($1, $2, $3, 1)', [newId(), T, trs01])
  jkt02Rev = (await one<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jkt02])).id
  brand = (await one<{ id: string }>('SELECT "brandPartyId" AS id FROM "Style" WHERE id = $1', [jkt02])).id
  wo1 = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND "batchNumber" = 'SEED-BT-0001'`, [T])).id
  sh1 = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T])).id
  sh2 = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0002'`, [T])).id
}, 1_500_000)

afterAll(async () => {
  useDeclarationsClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('W1 reads only the signed documents (lead note 11-10)', () => {
  it('lists and opens no generated draft on the style compliance routes', async () => {
    const generated = await one<{ id: string }>(`SELECT id FROM "ComplianceDocument" WHERE "styleId" = $1 AND origin = 'GENERATED' AND kind = 'DECLARATION_OF_CONFORMITY' AND "translationOfId" IS NULL`, [jkt03])
    const documents: Json[] = (await ok('quality', 'GET', `/product/styles/${jkt03}/compliance/documents`)).documents
    expect(documents.map((entry) => entry.id)).not.toContain(generated.id)
    expect(documents.length).toBeGreaterThan(0)
    await no('quality', 'GET', `/product/styles/${jkt03}/compliance/documents/${generated.id}`, undefined, 404)
  })
})

describe('the generated DoC (PRD-292)', () => {
  it('previews every Annex IX point of a brand style with where each value came from, without writing', async () => {
    const { preview } = await ok('quality', 'GET', `/compliance/declarations/preview?styleId=${jkt02}&language=it`)
    expect(preview.blocking).toEqual([])
    expect(preview.revision).toMatchObject({ revision: 1, status: 'RELEASED' })
    expect(preview.number).toBe('DoC-SEED-JKT-02-IT-r1')
    expect(preview.maker).toMatchObject({ name: 'Seed Customer One S.r.l.', partyId: brand })
    expect(preview.certificate).toMatchObject({ number: 'SEED-CERT-0003', bodyNumber: '0000' })
    expect(preview.standards).toEqual(['EN 17092-3:2020'])
    expect(preview.points.map((point: Json) => point.point)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    const byPoint = Object.fromEntries(preview.points.map((point: Json) => [point.point, point]))
    expect(byPoint['2'].source.kind).toBe('OPERATOR')
    expect(byPoint['3']).toMatchObject({ source: { kind: 'PHRASE', recordType: 'Phrase' }, wording: { key: 'doc.sole-responsibility', kind: 'PHRASE' } })
    expect(byPoint['5'].text).toContain('Regolamento (UE) 2016/425')
    expect(byPoint['6'].text).toContain('EN 17092-3:2020 (OJ L 77, 5.3.2021)')
    expect(byPoint['7']).toMatchObject({ source: { kind: 'CERTIFICATE', recordType: 'Certificate' }, sourceWords: 'from the certificate' })
    expect(await admin(`SELECT id FROM "ComplianceDocument" WHERE "styleId" = $1 AND origin = 'GENERATED'`, [jkt02])).toEqual([])
  })

  it('makes the original in Italian and its translations in one command: English from the built-in words, German waiting for a translator', async () => {
    const { declaration } = await ok('quality', 'POST', '/compliance/declarations', { styleId: jkt02, languages: ['it', 'en', 'de'] }, 201)
    original = declaration
    expect(declaration).toMatchObject({ kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1, status: 'DRAFT', origin: 'GENERATED', number: 'DoC-SEED-JKT-02-IT-r1', draftUntilChecked: true, translationOfId: null, template: 'annex-ix.1' })
    expect(declaration.maker).toMatchObject({ name: 'Seed Customer One S.r.l.', partyId: brand, role: 'BRAND' })
    expect(declaration.gate).toMatchObject({ name: 'GATE-PPE-TEXTS', open: true })
    expect(declaration.points).toHaveLength(9)
    expect(declaration.points.find((point: Json) => point.point === '7').values.map((value: Json) => value.sourceWords)).toContain('from certificate SEED-CERT-0003')
    expect(declaration.languages.map((entry: Json) => [entry.language, entry.translationStatus])).toEqual([
      ['de', 'IN_TRANSLATION'],
      ['en', 'DRAFT'],
      ['it', null],
    ])
    expect(declaration.may).toMatchObject({ edit: true, refresh: true, translate: true, check: false, withdraw: true })
    const rows = await admin<{ language: string; origin: string; status: string; makerPartyId: string | null; translationOfId: string | null }>(`SELECT language, origin, status, "makerPartyId", "translationOfId" FROM "ComplianceDocument" WHERE "styleId" = $1 AND origin = 'GENERATED' ORDER BY language`, [jkt02])
    expect(rows.map((row) => [row.language, row.status, row.makerPartyId === brand, row.translationOfId === declaration.id || row.translationOfId === null])).toEqual([
      ['de', 'DRAFT', true, true],
      ['en', 'DRAFT', true, true],
      ['it', 'DRAFT', true, true],
    ])
    german = (await ok('quality', 'GET', `/compliance/declarations/${declaration.languages.find((entry: Json) => entry.language === 'de').id}`)).declaration
    english = (await ok('quality', 'GET', `/compliance/declarations/${declaration.languages.find((entry: Json) => entry.language === 'en').id}`)).declaration
    expect(german.pointsToType.length).toBeGreaterThan(0)
    expect(german.points.find((point: Json) => point.point === '1')).toMatchObject({ source: { kind: 'UNTRANSLATED' } })
    expect(english.points.find((point: Json) => point.point === '1').text).toContain('PPE: ')
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'compliance_declarations.%' ORDER BY "occurredAt", id`, [T])
    expect(events.map((event) => event.type)).toEqual(['compliance_declarations.draft_changed', 'compliance_declarations.translation_changed', 'compliance_declarations.translation_changed'])
  })

  it('refuses a second original of the same revision and language, a style without a certificate or maker, and a viewer', async () => {
    expect((await no('quality', 'POST', '/compliance/declarations', { styleId: jkt02, languages: ['it'] }, 409)).issues[0].path).toBe('refusal/EXISTS')
    const noMaker = await no('quality', 'POST', '/compliance/declarations', { styleId: trs01, languages: ['it'] }, 409)
    expect(noMaker.issues.map((issue: Json) => issue.path)).toEqual(expect.arrayContaining(['refusal/NO_MAKER', 'refusal/NO_CERTIFICATE']))
    const noCertificate = await no('quality', 'POST', '/compliance/declarations', { styleId: trs01, companyId: companyA, languages: ['it'] }, 409)
    expect(noCertificate.issues.map((issue: Json) => issue.path)).toEqual(['refusal/NO_CERTIFICATE'])
    await no('viewer', 'POST', '/compliance/declarations', { styleId: jkt02, languages: ['fr'] }, 403)
    expect((await ok('viewer', 'GET', `/compliance/declarations?styleId=${jkt02}`)).declarations.length).toBeGreaterThanOrEqual(3)
  })

  it('takes typed words and the signatory; point 9 prints the signatory, typed points survive a refresh', async () => {
    const edited = (await ok('quality', 'PATCH', `/compliance/declarations/${original.id}`, { version: original.version, points: [{ point: '8', text: 'Non applicabile: DPI di categoria II (scritto a mano).' }], signedByName: 'Persona Demo', signedByFunction: 'Legale rappresentante', signedPlace: 'Seedville', signedOn: '2026-11-10' })).declaration
    const eight = edited.points.find((point: Json) => point.point === '8')
    expect(eight).toMatchObject({ text: 'Non applicabile: DPI di categoria II (scritto a mano).', source: { kind: 'TYPED', recordType: 'User' }, sourceWords: 'typed' })
    expect(edited.points.find((point: Json) => point.point === '9').text).toContain('Seedville, 10/11/2026. Persona Demo, Legale rappresentante.')
    expect(edited.stale.differences).toEqual([])
    await no('quality', 'PATCH', `/compliance/declarations/${original.id}`, { version: original.version, number: 'X' }, 409)
    const refreshed = (await ok('quality', 'POST', `/compliance/declarations/${original.id}/refresh`, { version: edited.version })).declaration
    expect(refreshed.points.find((point: Json) => point.point === '8').source.kind).toBe('TYPED')
    original = refreshed
  })

  it('paints the draft PDF with the GATE-PPE-TEXTS words; a signed document has no generated PDF', async () => {
    const response = await call('quality', 'GET', `/compliance/declarations/${original.id}/pdf`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    const text = pdfFlatText(response.rawPayload)
    expect(text).toContain('DICHIARAZIONE DI CONFORMITÀ UE')
    expect(text).toContain('BOZZA generata dai dati')
    expect(text).toContain('SEED-CERT-0003')
    const signed = await one<{ id: string }>(`SELECT id FROM "ComplianceDocument" WHERE "styleId" = $1 AND origin = 'SIGNED' AND status = 'ISSUED' LIMIT 1`, [jkt03])
    expect((await no('quality', 'GET', `/compliance/declarations/${signed.id}/pdf`, undefined, 409)).issues[0].path).toBe('refusal/SIGNED')
  })
})

describe('translations checked by a second person (PRD-293)', () => {
  it('refuses the check while words wait, by a typist, by its author; a third person checks; the check is undone to change words', async () => {
    expect((await no('checker', 'POST', `/compliance/declarations/${german.id}/check`, { version: german.version }, 409)).issues[0].path).toBe('refusal/WORDS_MISSING')
    const typed = (await ok('translator', 'PATCH', `/compliance/declarations/${german.id}`, { version: german.version, points: german.pointsToType.map((point: string) => ({ point, text: `Deutscher Text für Punkt ${point}.` })) })).declaration
    expect(typed.pointsToType).toEqual([])
    expect((await no('translator', 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version }, 409)).issues[0].path).toBe('refusal/OWN_WORDS')
    expect((await no('quality', 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version }, 409)).issues[0].path).toBe('refusal/OWN_TRANSLATION')
    const checked = (await ok('checker', 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version })).declaration
    expect(checked.translationStatus).toBe('CHECKED')
    expect(checked.translationCheckedBy.id).toBe(checkerId)
    expect(checked.may.edit).toBe(false)
    expect((await no('translator', 'PATCH', `/compliance/declarations/${german.id}`, { version: checked.version, points: [{ point: '1', text: 'Neu.' }] }, 409)).issues[0].path).toBe('refusal/CHECKED')
    const undone = (await ok('translator', 'POST', `/compliance/declarations/${german.id}/translation-state`, { version: checked.version, state: 'IN_TRANSLATION' })).declaration
    expect(undone).toMatchObject({ translationStatus: 'IN_TRANSLATION', translationCheckedBy: null })
    german = (await ok('checker', 'POST', `/compliance/declarations/${german.id}/check`, { version: (await ok('translator', 'POST', `/compliance/declarations/${german.id}/translation-state`, { version: undone.version, state: 'DRAFT' })).declaration.version })).declaration
    expect(german.translationStatus).toBe('CHECKED')
  })

  it('adds a language later from the original and refuses one it has', async () => {
    const after = (await ok('quality', 'POST', `/compliance/declarations/${original.id}/translations`, { languages: ['fr'] }, 201)).declaration
    expect(after.languages.map((entry: Json) => entry.language)).toEqual(['de', 'en', 'fr', 'it'])
    expect((await no('quality', 'POST', `/compliance/declarations/${original.id}/translations`, { languages: ['de'] }, 409)).issues[0].path).toBe('refusal/TAKEN')
    expect((await no('quality', 'POST', `/compliance/declarations/${german.id}/translations`, { languages: ['es'] }, 409)).issues[0].path).toBe('refusal/TRANSLATION')
  })

  it('shows the language coverage of the current revisions with the tiles', async () => {
    const coverage = await ok('viewer', 'GET', `/compliance/declarations/coverage?styleId=${jkt02}`)
    expect(coverage.languages).toEqual(expect.arrayContaining(['it', 'de', 'fr', 'es']))
    const doc = coverage.rows.find((row: Json) => row.kind === 'DECLARATION_OF_CONFORMITY')
    const cells = Object.fromEntries(doc.cells.map((cell: Json) => [cell.language, cell.state]))
    expect(cells).toMatchObject({ it: 'DRAFT', de: 'CHECKED', fr: 'IN_TRANSLATION', es: 'MISSING' })
    expect(coverage.tiles.drafts).toBeGreaterThanOrEqual(4)
    expect(coverage.gate.name).toBe('GATE-PPE-TEXTS')
  })
})

describe('versions by batch (PRD-295) and the shipment compliance pack (PRD-300)', () => {
  let signedDoc = ''

  it('takes the signed upload beside the generated draft (never onto it) and keeps the draft a draft', async () => {
    const done = await uploadSigned(jkt02, jkt02Rev, 'DECLARATION_OF_CONFORMITY', 'it', 'DoC it r1')
    signedDoc = done.document.id
    expect(done.document.status).toBe('ISSUED')
    expect(signedDoc).not.toBe(original.id)
    expect((await one<{ status: string }>('SELECT status FROM "ComplianceDocument" WHERE id = $1', [original.id])).status).toBe('DRAFT')
    await uploadSigned(jkt02, jkt02Rev, 'USER_INFORMATION', 'it', 'leaflet it r1')
  })

  it('lists the shipped batch without a recorded version, records what travelled once, and draws the timeline', async () => {
    const before = await ok('viewer', 'GET', '/compliance/declarations/batches/unrecorded')
    expect(before.unrecorded.map((entry: Json) => [entry.shipmentNumber, entry.batchNumber])).toContainEqual(['SEED-SH-0001', 'SEED-BT-0001'])
    const first = await ok('quality', 'POST', `/compliance/declarations/shipments/${sh1}/versions`)
    expect(first.recorded.map((record: Json) => [record.batchNumber, record.shipment.number, record.document.kind])).toEqual(
      expect.arrayContaining([
        ['SEED-BT-0001', 'SEED-SH-0001', 'DECLARATION_OF_CONFORMITY'],
        ['SEED-BT-0001', 'SEED-SH-0001', 'USER_INFORMATION'],
      ]),
    )
    expect(first.recorded[0].retainUntil >= '2036-01-01').toBe(true)
    expect((await ok('quality', 'POST', `/compliance/declarations/shipments/${sh1}/versions`)).recorded).toEqual([])
    const after = await ok('viewer', 'GET', '/compliance/declarations/batches/unrecorded')
    expect(after.unrecorded.map((entry: Json) => entry.batchNumber)).not.toContain('SEED-BT-0001')
    const { timeline } = await ok('viewer', 'GET', `/compliance/declarations/batches?styleId=${jkt02}`)
    expect(timeline[0]).toMatchObject({ revision: 1 })
    expect(timeline[0].batches[0]).toMatchObject({ batchNumber: 'SEED-BT-0001', workOrderId: wo1, shipmentIds: [sh1] })
  })

  it('records a batch as made, refuses it twice, a draft, and a shipment of another company (the database, as a 409)', async () => {
    const made = await ok('quality', 'POST', '/compliance/declarations/batches', { documentId: signedDoc, workOrderId: wo1, note: 'Recorded at release (test).' }, 201)
    expect(made.record).toMatchObject({ batchNumber: 'SEED-BT-0001', workOrder: { id: wo1 }, shipment: null, document: { id: signedDoc, revision: 1 } })
    expect((await no('quality', 'POST', '/compliance/declarations/batches', { documentId: signedDoc, workOrderId: wo1 }, 409)).issues[0].path).toBe('refusal/RECORDED')
    expect((await no('quality', 'POST', '/compliance/declarations/batches', { documentId: original.id, workOrderId: wo1 }, 409)).issues[0].path).toBe('refusal/NOT_ISSUED')
    // A typed batch of company B on company A's shipment: the API passes it on, the database refuses it — in words, never a 500.
    const refused = await no('quality', 'POST', '/compliance/declarations/batches', { documentId: signedDoc, batchNumber: 'LEGACY-B-1', companyId: companyB, shipmentId: sh1 }, 409)
    expect(refused.issues[0].path).toBe('refusal/DATABASE')
    await no('viewer', 'POST', '/compliance/declarations/batches', { documentId: signedDoc, batchNumber: 'LEGACY-2', companyId: companyA }, 403)
  })

  it('builds the pack of the shipment as a PDF and a ZIP, the same contents once, shared with the customer on request', async () => {
    const view = (await ok('warehouse', 'GET', `/compliance/declarations/shipments/${sh1}/pack`)).pack
    expect(view.refusals).toEqual([])
    expect(view.locale).toBe('it')
    expect(view.styles[0]).toMatchObject({ code: 'SEED-JKT-02', revision: 1, certificate: { number: 'SEED-CERT-0003', validOnDay: true } })
    expect(view.styles[0].batches[0]).toMatchObject({ batchNumber: 'SEED-BT-0001' })
    expect(view.contents.map((entry: Json) => entry.path)).toEqual(['documents/SEED-JKT-02-r1-DoC-it.pdf', 'documents/SEED-JKT-02-r1-user-information-it.pdf'])
    const made = (await ok('warehouse', 'POST', `/compliance/declarations/shipments/${sh1}/pack`, {}, 201)).pack
    expect(made).toMatchObject({ made: true, version: { version: 1, number: 'SEED-SH-0001/CP1', documents: 2, shared: false } })
    expect((await ok('warehouse', 'POST', `/compliance/declarations/shipments/${sh1}/pack`, {})).pack).toMatchObject({ made: false, version: { id: made.version.id } })
    const pdf = await call('warehouse', 'GET', `/compliance/declarations/shipments/${sh1}/pack/${made.version.id}/pdf`)
    expect(pdf.statusCode, pdf.body).toBe(200)
    const text = pdfFlatText(pdf.rawPayload)
    expect(text).toContain('Pacchetto di conformità della spedizione')
    expect(text).toContain('SEED-BT-0001')
    expect(text).toContain('/doc/')
    const zip = await call('warehouse', 'GET', `/compliance/declarations/shipments/${sh1}/pack/${made.version.id}/zip`)
    expect(zip.statusCode, zip.body).toBe(200)
    expect(zip.headers['content-type']).toContain('application/zip')
    const entries = zipEntries(zip.rawPayload)
    expect([...entries.keys()].sort()).toEqual(['SEED-SH-0001 pacchetto conformita v1.pdf', 'SHA256SUMS.txt', 'documents/SEED-JKT-02-r1-DoC-it.pdf', 'documents/SEED-JKT-02-r1-user-information-it.pdf'].sort())
    expect(entries.get('documents/SEED-JKT-02-r1-DoC-it.pdf')!.toString('latin1')).toContain('DoC it r1')
    expect(entries.get('SHA256SUMS.txt')!.toString('utf8').trim().split('\n')).toHaveLength(3)
    const shared = (await ok('warehouse', 'POST', `/compliance/declarations/shipments/${sh1}/pack`, { share: true }, 201)).pack
    expect(shared.version).toMatchObject({ version: 2, shared: true })
    const file = await one<{ visibility: string; partyId: string | null }>('SELECT visibility::text, "partyId" FROM "StoredFile" WHERE id = $1', [shared.version.file.id])
    expect(file.visibility).toContain('PARTNER')
    expect(file.partyId).not.toBeNull()
    const kinds = await admin<{ kind: string }>(`SELECT kind::text FROM "GeneratedDocument" WHERE "recordType" = 'Shipment' AND "recordId" = $1 ORDER BY version`, [sh1])
    expect(kinds.map((row) => row.kind)).toEqual(['COMPLIANCE_PACK', 'COMPLIANCE_PACK'])
  })

  it('refuses the pack of a shipment whose leaflet is missing, and a reader without shipping.view', async () => {
    const refused = await no('warehouse', 'POST', `/compliance/declarations/shipments/${sh2}/pack`, {}, 409)
    expect(refused.issues.map((issue: Json) => issue.path)).toContain('refusal/DOCUMENT_MISSING')
    await no('viewer', 'GET', `/compliance/declarations/shipments/${sh1}/pack`, undefined, 403)
  })
})

describe('withdrawing a generated draft', () => {
  it('withdraws the original with its draft translations, with the reason; it changes no more', async () => {
    await no('quality', 'POST', `/compliance/declarations/${original.id}/withdraw`, { version: original.version, reason: 'no' }, 400)
    const current = (await ok('quality', 'GET', `/compliance/declarations/${original.id}`)).declaration
    const withdrawn = (await ok('quality', 'POST', `/compliance/declarations/${original.id}/withdraw`, { version: current.version, reason: 'Made for the test; replaced by the next revision.' })).declaration
    expect(withdrawn.status).toBe('WITHDRAWN')
    expect(withdrawn.languages.every((entry: Json) => entry.status === 'WITHDRAWN')).toBe(true)
    expect((await no('quality', 'PATCH', `/compliance/declarations/${original.id}`, { version: withdrawn.version, number: 'X' }, 409)).issues[0].path).toBe('refusal/NOT_DRAFT')
    expect((await no('quality', 'POST', '/compliance/declarations', { styleId: jkt02, languages: ['it'] }, 409)).issues[0].path).toBe('refusal/WITHDRAWN')
  })
})
