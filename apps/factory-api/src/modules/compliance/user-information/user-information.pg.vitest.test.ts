import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, WEB_ORIGIN, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { useDeclarationsClock } from '../declarations/common'

/**
 * The user information builder (B-W2b-258; PRD-350 to PRD-354) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and B-W2b-218's guards are real), the harness's local
 * file store behind a FAKE R2 account and its email runtime (the public DoC address), on the core, compliance-rules (which run
 * the compliance, product and production seeds) and sizes-depth seeds: SEED-JKT-01 (category II, EN 17092-3 class AA,
 * certificate SEED-CERT-0001; revision 1 DRAFT with three protector placements: shoulder SEED-PRO-300 level 2 — certified by
 * SEED-CERT-0002 —, elbow and back protectors without a certificate), SEED-JKT-02 (revision 1 released, WO-0001's batch
 * SEED-BT-0001), the markets IT DE FR ES (on) and CH UK US (off), the phrase userinfo.storage in Italian. Every code, name
 * and address is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/user-information`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b258-user-information'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')

const ALL = ['compliance.certificates.view', 'compliance.userInformation.generate', 'compliance.userInformation.check', 'compliance.declarations.generate', 'compliance.declarations.manage', 'files.read', 'files.upload'] as Permission[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const checkerId = newId()
const SESSIONS: Record<string, SessionContext> = {
  quality: office(ALL),
  translator: office(ALL),
  checker: { ...office(ALL), actorId: checkerId } as SessionContext,
  viewer: office(['compliance.certificates.view'] as Permission[]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async <Row = Json>(sql: string, values: unknown[]): Promise<Row> => (await admin<Row>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `ui-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const pdfBytes = (text: string) => Buffer.from(`%PDF-1.4\n% made-up signed leaflet: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** W1's three steps for a signed PDF: announce, put it in the store, confirm. */
async function uploadSigned(styleId: string, revisionId: string, kind: string, language: string, text: string): Promise<Json> {
  const body = pdfBytes(text)
  const announced = await ok('quality', 'POST', `/product/styles/${styleId}/compliance/documents`, { revisionId, kind, language, originalName: `${kind.toLowerCase()}-${language}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  return ok('quality', 'POST', `/product/styles/${styleId}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
}

let jkt01 = ''
let jkt01Rev = ''
let jkt02 = ''
let jkt02Rev = ''
let wo1 = ''
let original: Json = {}
let german: Json = {}

beforeAll(async () => {
  h = await startHarness('user_information')
  useDeclarationsClock(h.clock)
  await seedCore({ db: h.database, namespace: NS })
  await seedComplianceRules({ db: h.database, namespace: NS })
  await seedSizesDepth({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const style = async (code: string) => (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code])).id
  jkt01 = await style('SEED-JKT-01')
  jkt02 = await style('SEED-JKT-02')
  jkt01Rev = (await one<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jkt01])).id
  jkt02Rev = (await one<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jkt02])).id
  wo1 = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND "batchNumber" = 'SEED-BT-0001'`, [T])).id
}, 1_500_000)

afterAll(async () => {
  useDeclarationsClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('the leaflet from its records (PRD-350, PRD-353, PRD-354)', () => {
  it('previews every Annex II 1.4 section with its source, the protector positions and the certified spares, without writing', async () => {
    const { preview } = await ok('quality', 'GET', `/compliance/user-information/preview?styleId=${jkt01}&revisionId=${jkt01Rev}&language=it`)
    expect(preview.blocking).toEqual([])
    expect(preview.revision).toMatchObject({ revision: 1, status: 'DRAFT' })
    expect(preview.number).toBe('UI-SEED-JKT-01-IT-r1')
    expect(preview.certificate).toMatchObject({ number: 'SEED-CERT-0001' })
    expect(preview.sections.map((section: Json) => section.key)).toEqual(['product', 'maker', 'storage', 'use', 'cleaning', 'performance', 'protectors', 'spares', 'limits', 'obsolescence', 'markings', 'risks', 'regulation', 'notifiedBody', 'standards', 'docAddress'])
    const by = Object.fromEntries(preview.sections.map((section: Json) => [section.key, section]))
    expect(by.storage).toMatchObject({ source: { kind: 'PHRASE', recordType: 'Phrase' }, wording: { key: 'userinfo.storage', kind: 'PHRASE' } })
    expect(by.performance.text).toContain('classe AA')
    expect(by.protectors.text).toContain('spalle (EN 1621-1:2012, livello 2; taglie 50, 52)')
    expect(by.protectors.sourceWords).toBe('from the protector placement')
    expect(by.spares.text).toContain('Seed shoulder protector level 2 (EN 1621-1:2012, livello 2, certificato SEED-CERT-0002)')
    expect(by.docAddress.text).toContain(`${WEB_ORIGIN}/doc/`)
    expect(preview.protectorPositions.map((entry: Json) => [entry.zone, entry.level])).toEqual([['shoulder', '2'], ['elbow', '1'], ['back', '1']])
    expect(preview.spareProtectors).toEqual([expect.objectContaining({ code: 'SEED-PRO-300', zones: ['shoulder'], level: '2', placed: true, certificate: expect.objectContaining({ number: 'SEED-CERT-0002' }) })])
    expect(preview.warnings.filter((warning: Json) => warning.code === 'SPARE_NOT_CERTIFIED').map((warning: Json) => warning.point)).toEqual(['spares', 'spares'])
    expect(await admin(`SELECT id FROM "ComplianceDocument" WHERE "styleId" = $1 AND kind = 'USER_INFORMATION' AND origin = 'GENERATED'`, [jkt01])).toEqual([])
  })

  it('makes the Italian original, an English translation and the German pack in one command', async () => {
    const { leaflet } = await ok('quality', 'POST', '/compliance/user-information', { styleId: jkt01, revisionId: jkt01Rev, languages: ['it', 'en'], packs: ['DE'] }, 201)
    original = leaflet
    expect(leaflet).toMatchObject({ kind: 'USER_INFORMATION', language: 'it', revision: 1, status: 'DRAFT', origin: 'GENERATED', number: 'UI-SEED-JKT-01-IT-r1', draftUntilChecked: true, translationOfId: null, template: 'annex-ii-1.4.1' })
    expect(leaflet.gate).toMatchObject({ name: 'GATE-PPE-TEXTS', open: true })
    expect(leaflet.sections).toHaveLength(16)
    expect(leaflet.sections.find((section: Json) => section.key === 'spares')).toMatchObject({ law: 'Annex II 1.4(c)' })
    expect(leaflet.spareProtectors).toHaveLength(1)
    expect(leaflet.protectorPositions).toHaveLength(3)
    expect(leaflet.languages.map((entry: Json) => [entry.language, entry.translationStatus, entry.marketCode])).toEqual([
      ['de', 'IN_TRANSLATION', 'DE'],
      ['en', 'DRAFT', null],
      ['it', null, null],
    ])
    expect(leaflet.may).toMatchObject({ edit: true, refresh: true, translate: true, check: false, withdraw: true })
    expect(leaflet.stale).toMatchObject({ differences: [], lists: { positions: false, spares: false } })
    const rows = await admin<{ language: string; status: string; sections: Json; content: unknown }>(`SELECT language, status, sections, content FROM "ComplianceDocument" WHERE "styleId" = $1 AND kind = 'USER_INFORMATION' AND origin = 'GENERATED' ORDER BY language`, [jkt01])
    expect(rows.map((row) => [row.language, row.status, row.content, row.sections.template])).toEqual([
      ['de', 'DRAFT', null, 'annex-ii-1.4.1'],
      ['en', 'DRAFT', null, 'annex-ii-1.4.1'],
      ['it', 'DRAFT', null, 'annex-ii-1.4.1'],
    ])
    german = (await ok('quality', 'GET', `/compliance/user-information/${leaflet.languages.find((entry: Json) => entry.language === 'de').id}`)).leaflet
    expect(german.sectionsToType.length).toBeGreaterThan(5)
    expect(german.sections.find((section: Json) => section.key === 'maker')).toMatchObject({ source: { kind: 'UNTRANSLATED' } })
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'compliance_user_information.%' ORDER BY "occurredAt", id`, [T])
    expect(events.map((event) => event.type)).toEqual(['compliance_user_information.draft_changed', 'compliance_user_information.translation_changed', 'compliance_user_information.translation_changed'])
    // The DoC generator's grid lists the leaflets too; its own writes refuse them.
    expect((await ok('viewer', 'GET', `/compliance/declarations?styleId=${jkt01}&kind=USER_INFORMATION&origin=GENERATED`)).declarations).toHaveLength(3)
    expect((await no('quality', 'POST', `/compliance/declarations/${leaflet.id}/refresh`, { version: leaflet.version }, 409)).issues[0].path).toBe('refusal/USER_INFORMATION')
  })

  it('refuses a second original of the revision and language, a DoC on its routes, a viewer', async () => {
    expect((await no('quality', 'POST', '/compliance/user-information', { styleId: jkt01, revisionId: jkt01Rev, languages: ['it'] }, 409)).issues[0].path).toBe('refusal/EXISTS')
    const doc = await one<{ id: string }>(`SELECT id FROM "ComplianceDocument" WHERE "styleId" = $1 AND kind = 'DECLARATION_OF_CONFORMITY' LIMIT 1`, [jkt01])
    expect((await no('quality', 'GET', `/compliance/user-information/${doc.id}`, undefined, 409)).issues[0].path).toBe('refusal/DECLARATION')
    await no('viewer', 'POST', '/compliance/user-information', { styleId: jkt01, languages: ['fr'] }, 403)
    await no('viewer', 'PATCH', `/compliance/user-information/${original.id}`, { version: original.version, sections: [{ key: 'use', text: 'x' }] }, 403)
    expect((await ok('viewer', 'GET', `/compliance/user-information/${original.id}`)).leaflet.may).toMatchObject({ edit: false, translate: false })
  })

  it('takes typed words; a typed section survives a refresh; a stale version is refused', async () => {
    const edited = (await ok('quality', 'PATCH', `/compliance/user-information/${original.id}`, { version: original.version, sections: [{ key: 'cleaning', text: 'Pulizia: solo a mano, con un panno umido (scritto a mano).' }] })).leaflet
    expect(edited.sections.find((section: Json) => section.key === 'cleaning')).toMatchObject({ source: { kind: 'TYPED', recordType: 'User' }, sourceWords: 'typed' })
    expect(edited.stale.differences).toEqual([])
    await no('quality', 'PATCH', `/compliance/user-information/${original.id}`, { version: original.version, number: 'X' }, 409)
    const refreshed = (await ok('quality', 'POST', `/compliance/user-information/${original.id}/refresh`, { version: edited.version })).leaflet
    expect(refreshed.sections.find((section: Json) => section.key === 'cleaning').source.kind).toBe('TYPED')
    original = refreshed
  })

  it('paints the draft PDF with the GATE-PPE-TEXTS words', async () => {
    const response = await call('quality', 'GET', `/compliance/user-information/${original.id}/pdf`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    const text = pdfFlatText(response.rawPayload)
    expect(text).toContain('BOZZA generata dai dati')
    expect(text).toContain('Fabbricante:')
    expect(text).toContain('Ricambi: sostituire una protezione')
    expect(text).toContain('UI-SEED-JKT-01-IT-r1')
  })

  it('the spares follow the certificates: an expired protector certificate makes the list stale, and a refresh drops it', async () => {
    h.clock.set('2030-07-01T09:00:00.000Z')
    try {
      const stale = (await ok('quality', 'GET', `/compliance/user-information/${original.id}`)).leaflet
      expect(stale.stale.lists).toEqual({ positions: false, spares: true })
      expect(stale.stale.differences.map((difference: Json) => difference.key)).toContain('spares')
      expect(stale.problems.map((problem: Json) => problem.code)).toContain('SPARE_NOT_CERTIFIED')
      const refreshed = (await ok('quality', 'POST', `/compliance/user-information/${original.id}/refresh`, { version: stale.version })).leaflet
      expect(refreshed.spareProtectors).toEqual([])
      expect(refreshed.sections.find((section: Json) => section.key === 'spares').text).toContain('chiedere al fabbricante')
      original = refreshed
    } finally {
      h.clock.set('2026-10-28T09:00:00.000Z')
    }
  })
})

describe('language packs per market (PRD-351)', () => {
  it('shows each market its languages with their leaflets, starts a pack, and refuses one with nothing to add', async () => {
    const before = await ok('viewer', 'GET', `/compliance/user-information/packs?styleId=${jkt01}&revisionId=${jkt01Rev}`)
    const pack = (answer: Json, code: string) => answer.packs.find((entry: Json) => entry.market.code === code)
    expect(before.original).toMatchObject({ id: original.id, language: 'it' })
    expect(pack(before, 'IT').languages).toEqual([expect.objectContaining({ language: 'it', state: 'DRAFT' })])
    expect(pack(before, 'DE').languages).toEqual([expect.objectContaining({ language: 'de', state: 'IN_TRANSLATION' })])
    expect(pack(before, 'FR')).toMatchObject({ live: false, missing: ['fr'] })
    expect(pack(before, 'CH')).toMatchObject({ market: { switchedOn: false }, missing: ['fr'] })
    const started = (await ok('quality', 'POST', `/compliance/user-information/${original.id}/translations`, { packs: ['FR', 'CH'] }, 201)).leaflet
    expect(started.languages.find((entry: Json) => entry.language === 'fr')).toMatchObject({ translationStatus: 'IN_TRANSLATION', marketCode: null })
    expect((await no('quality', 'POST', `/compliance/user-information/${original.id}/translations`, { packs: ['CH'] }, 409)).issues[0].path).toBe('refusal/NOTHING_TO_ADD')
    expect((await no('quality', 'POST', `/compliance/user-information/${original.id}/translations`, { languages: ['fr'] }, 409)).issues[0].path).toBe('refusal/TAKEN')
    expect((await no('quality', 'POST', `/compliance/user-information/${original.id}/translations`, { languages: ['it'] }, 409)).issues[0].path).toBe('refusal/SOURCE_LANGUAGE')
    const after = await ok('viewer', 'GET', `/compliance/user-information/packs?styleId=${jkt01}&revisionId=${jkt01Rev}`)
    expect(pack(after, 'CH').missing).toEqual([])
  })

  it('a translation is checked by a second person once every section is typed; the check is undone to change words', async () => {
    expect((await no('checker', 'POST', `/compliance/user-information/${german.id}/check`, { version: german.version }, 409)).issues[0].path).toBe('refusal/WORDS_MISSING')
    const typed = (await ok('translator', 'PATCH', `/compliance/user-information/${german.id}`, { version: german.version, sections: german.sectionsToType.map((key: string) => ({ key, text: `Deutscher Text: ${key}.` })) })).leaflet
    expect(typed.sectionsToType).toEqual([])
    expect((await no('translator', 'POST', `/compliance/user-information/${german.id}/check`, { version: typed.version }, 409)).issues[0].path).toBe('refusal/OWN_WORDS')
    expect((await no('quality', 'POST', `/compliance/user-information/${german.id}/check`, { version: typed.version }, 409)).issues[0].path).toBe('refusal/OWN_TRANSLATION')
    await no('viewer', 'POST', `/compliance/user-information/${german.id}/check`, { version: typed.version }, 403)
    const checked = (await ok('checker', 'POST', `/compliance/user-information/${german.id}/check`, { version: typed.version })).leaflet
    expect(checked).toMatchObject({ translationStatus: 'CHECKED', translationCheckedBy: { id: checkerId } })
    expect(checked.may.edit).toBe(false)
    expect((await no('translator', 'PATCH', `/compliance/user-information/${german.id}`, { version: checked.version, sections: [{ key: 'use', text: 'Neu.' }] }, 409)).issues[0].path).toBe('refusal/CHECKED')
    const undone = (await ok('translator', 'POST', `/compliance/user-information/${german.id}/translation-state`, { version: checked.version, state: 'IN_TRANSLATION' })).leaflet
    expect(undone).toMatchObject({ translationStatus: 'IN_TRANSLATION', translationCheckedBy: null })
    const packs = await ok('viewer', 'GET', `/compliance/user-information/packs?styleId=${jkt01}&revisionId=${jkt01Rev}`)
    expect(packs.packs.find((entry: Json) => entry.market.code === 'DE').languages[0].state).toBe('IN_TRANSLATION')
  })

  it('withdraws a draft with its reason; the language stays taken for the revision', async () => {
    const french = (await ok('quality', 'GET', `/compliance/user-information/${original.id}`)).leaflet.languages.find((entry: Json) => entry.language === 'fr')
    const draft = (await ok('quality', 'GET', `/compliance/user-information/${french.id}`)).leaflet
    await no('quality', 'POST', `/compliance/user-information/${draft.id}/withdraw`, { version: draft.version, reason: 'x' }, 400)
    const withdrawn = (await ok('quality', 'POST', `/compliance/user-information/${draft.id}/withdraw`, { version: draft.version, reason: 'Made by mistake for the test.' })).leaflet
    expect(withdrawn.status).toBe('WITHDRAWN')
    const packs = await ok('viewer', 'GET', `/compliance/user-information/packs?styleId=${jkt01}&revisionId=${jkt01Rev}`)
    expect(packs.packs.find((entry: Json) => entry.market.code === 'FR').languages[0].state).toBe('WITHDRAWN')
  })
})

describe('the version per batch (PRD-352)', () => {
  it('names the signed leaflet a batch goes with, then the one recorded with it; never a generated draft', async () => {
    const signed = (await uploadSigned(jkt02, jkt02Rev, 'USER_INFORMATION', 'it', 'JKT-02 leaflet r1')).document
    expect(signed).toMatchObject({ status: 'ISSUED' })
    const due = await ok('viewer', 'GET', `/compliance/user-information/batches?workOrderId=${wo1}`)
    expect(due.batch).toMatchObject({ batchNumber: 'SEED-BT-0001', workOrder: { id: wo1, revision: 1 }, released: true })
    expect(due.leaflets).toEqual([expect.objectContaining({ language: 'it', documentId: signed.id, revision: 1, recorded: null })])
    await ok('quality', 'POST', '/compliance/declarations/batches', { documentId: signed.id, workOrderId: wo1 }, 201)
    const recorded = await ok('viewer', 'GET', `/compliance/user-information/batches?styleId=${jkt02}&batchNumber=SEED-BT-0001`)
    expect(recorded.leaflets).toEqual([expect.objectContaining({ documentId: signed.id, recorded: { shipments: [] } })])
    const detail = (await ok('viewer', 'GET', `/compliance/user-information/${signed.id}`)).leaflet
    expect(detail).toMatchObject({ origin: 'SIGNED', sections: [], gate: null, may: { edit: false, check: false } })
    expect(detail.batches[0]).toMatchObject({ revision: 1, batches: [expect.objectContaining({ batchNumber: 'SEED-BT-0001', workOrderId: wo1 })] })
    expect((await no('quality', 'GET', `/compliance/user-information/${signed.id}/pdf`, undefined, 409)).issues[0].path).toBe('refusal/SIGNED')
    await no('viewer', 'GET', `/compliance/user-information/batches?workOrderId=${newId()}`, undefined, 404)
    await no('viewer', 'GET', '/compliance/user-information/batches', undefined, 400)
  })
})
