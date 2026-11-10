import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { garmentLabelZpl } from '@nexus/factory-domain/compliance/labels/zpl'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { processEmail } from '../../../platform/email-out/service'
import { garmentLabelFor } from '../labels/preview'
import { useLabelsClock } from '../labels/store'
import { labelRulesFor } from './gate'

/**
 * What a PPE label must say (B-W2b-253) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login, so row-level security and B-W2b-218's label guards are real), seeded with the core
 * and the compliance-rules seeds (which run the compliance and production seeds: SEED-JKT-01 with its ACTIVE label
 * SEED-LBL-JKT-01 on draft revision 1; SEED-JKT-02, the brand P1's jacket, and its released WO-0001 with batch SEED-BT-0001;
 * markets IT, DE, FR, ES on and UK, CH, US off; company A's and the brand's MANUFACTURER rows; notified body 0000 in the
 * directory). Made up beside them: a casual jacket that is not PPE, rider gloves, a category III vest, a protector in a pocket
 * of SEED-JKT-01 and the removable protectors' warning in the phrase library. Every name, number and address is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/label-rules`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'label-rules-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA = seedId('site:A1')
const actor = seedId('actor')
const translator = seedId('compliance-rules:user:translator')
const jacket = seedId('product:style:JKT-01')
const jacketRev1 = seedId('product:revision:JKT-01:1')
const seedLabel = seedId('compliance:label:JKT-01:1')
const protector = seedId('product:item:protector')
const scale = seedId('product:size-scale:EU-JKT')
const brandJacket = seedId('production:style:JKT-02')
const workOrder = seedId('production:work-order:WO-0001')
const otherTenant = newId()
const user = newId()

const casual = newId()
const gloves = newId()
const vest = newId()

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.labels.manage'
const clock: Clock = { now: () => new Date('2026-11-26T09:00:00.000Z') }
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(tenant, [grant([VIEW, MANAGE, 'workorders.view'])]),
  viewer: office(tenant, [grant([VIEW])]),
  otherTenant: office(otherTenant, [grant([VIEW, MANAGE])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [grant(['floor.work', VIEW, MANAGE], [companyA])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const checksOf = (entry: Json): Json => Object.fromEntries(entry.checks.map((check: Json) => [check.key, check]))
const outcomes = (entry: Json) => Object.fromEntries(entry.checks.map((check: Json) => [check.key, check.outcome]))
const marketOf = (checks: Json, code: string): Json => checks.markets.find((entry: Json) => entry.market?.code === code)
const blockOf = (label: Json, field: string): Json => label.blocks.find((block: Json) => block.field === field)
const rules = (templateId: string, query = '') => ok('manager', 'GET', `/compliance/label-rules/templates/${templateId}${query}`).then((body) => body.checks as Json)

/** A draft label made through W1's own route. */
async function draftLabel(extra: Json): Promise<Json> {
  const body = {
    code: `LBL-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Test label',
    languages: ['it', 'en'],
    makerName: 'Seed Company A S.r.l.',
    makerAddress: 'Via Seed 1, 00000 Seedtown (XX), Italy',
    layout: { fields: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'] },
    heightMm: '150',
    ...extra,
  }
  return (await ok('manager', 'POST', '/compliance/labels', body, 201)).template
}
const setMarking = (template: Json, body: Json, session = 'manager', status = 200) =>
  status === 200 ? ok(session, 'PUT', `/compliance/label-rules/templates/${template.id}/marking`, { version: template.version, ...body }).then((answer) => answer.template as Json) : refused(session, 'PUT', `/compliance/label-rules/templates/${template.id}/marking`, { version: template.version, ...body }, status)

beforeAll(async () => {
  db = await migratedDatabase('label_rules')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'label-rules-other'])
  useLabelsClock(clock)

  const style = `INSERT INTO "Style" (id, "tenantId", "companyId", code, name, "productType", "sizeScaleId", sizes, "baseSize", "ppeCategory", "ppeStandard", "ppeClass", status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['52'], '52', $8, $9, $10, 'DRAFT')`
  await admin(style, [casual, tenant, companyA, 'TEST-CAS-01', 'Test casual jacket', 'JACKET', scale, 'NOT_PPE', null, null])
  await admin(style, [gloves, tenant, companyA, 'TEST-GLV-01', 'Test rider gloves', 'GLOVES', scale, 'CATEGORY_II', 'EN 13594:2015', '2KP'])
  await admin(style, [vest, tenant, companyA, 'TEST-VST-01', 'Test airbag vest', 'VEST', scale, 'CATEGORY_III', 'EN 1621-4:2013', null])
  for (const id of [casual, gloves, vest]) {
    await admin(`INSERT INTO "Colourway" (id, "tenantId", "styleId", code, name) VALUES ($1, $2, $3, 'BLK', 'Black')`, [newId(), tenant, id])
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status) VALUES ($1, $2, $3, 1, 'DRAFT')`, [newId(), tenant, id])
  }

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useLabelsClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("the seed jacket's label, per switched-on market (PRD-333, PRD-335)", () => {
  it('passes the CE marking of a category II jacket in every switched-on market, and has nothing else to ask', async () => {
    const checks = await rules(seedLabel)
    expect(checks.label).toMatchObject({ code: 'SEED-LBL-JKT-01', status: 'ACTIVE', kind: 'PPE_GARMENT', qrTarget: 'NONE' })
    expect(checks.markets.map((entry: Json) => entry.market.code).sort()).toEqual(['DE', 'ES', 'FR', 'IT'])
    const it = marketOf(checks, 'IT')
    expect(outcomes(it)).toEqual({ ceMarking: 'PASS', classWarnings: 'NOT_APPLICABLE', gloveMarking: 'NOT_APPLICABLE', gpsr: 'NOT_APPLICABLE', qrCode: 'NOT_APPLICABLE' })
    expect(checksOf(it).ceMarking).toMatchObject({ gateKey: 'label.ceMarking', blocks: false, words: expect.stringContaining('no notified-body number after it') })
    expect(checksOf(it).gpsr.words).toContain('Q37')
    expect(it.blocks).toBe(false)
    // UK is off (Q23); asked by name, its UKCA marking is one the label does not print.
    const uk = await rules(seedLabel, '?marketCode=UK')
    expect(checksOf(uk.markets[0]).ceMarking).toMatchObject({ outcome: 'FAIL', findings: [{ path: 'markets/UK/markings/UKCA' }] })
  })

  it('asks the removable protectors’ warning once a protector sits in a pocket, in every language, then waits for the PPE consultant', async () => {
    await admin(
      `INSERT INTO "ProtectorPlacement" (id, "tenantId", "styleId", "revisionId", seq, pocket, "protectorItemId", standard, level) VALUES ($1, $2, $3, $4, 1, 'SHOULDER', $5, 'EN 1621-1:2012', '2')`,
      [newId(), tenant, jacket, jacketRev1, protector],
    )
    const missing = checksOf((await rules(seedLabel, '?marketCode=IT')).markets[0]).classWarnings
    expect(missing).toMatchObject({ outcome: 'FAIL', blocks: true, gateKey: 'label.classWarnings', findings: [{ path: 'phrases/warning.protectors-removable' }] })

    const phrase = newId()
    const english = newId()
    await admin(`INSERT INTO "Phrase" (id, "tenantId", key, kind, "sourceText", "createdById") VALUES ($1, $2, 'warning.protectors-removable', 'WARNING', $3, $4)`, [phrase, tenant, 'Protezioni rimovibili: la classe vale solo con le protezioni inserite (testo di prova).', actor])
    await admin(`INSERT INTO "PhraseTranslation" (id, "tenantId", "phraseId", language, revision, text, "sourceRevision", "translatedById", "createdById") VALUES ($1, $2, $3, 'en', 1, $4, 1, $5, $5)`, [english, tenant, phrase, 'Removable protectors: the class holds only with them in place (test text).', translator])
    await admin(`UPDATE "PhraseTranslation" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2 WHERE id = $1`, [english, actor])

    const italy = await rules(seedLabel, '?marketCode=IT')
    expect(checksOf(italy.markets[0]).classWarnings).toMatchObject({ outcome: 'WAITING', blocks: true, findings: [{ path: 'gate/GATE-PPE-TEXTS', severity: 'WAITING' }] })
    expect(italy.marking.warnings).toEqual([
      {
        reason: 'REMOVABLE_PROTECTORS',
        key: 'warning.protectors-removable',
        draft: true,
        texts: [
          { language: 'it', text: expect.stringContaining('Protezioni rimovibili') },
          { language: 'en', text: expect.stringContaining('Removable protectors') },
        ],
      },
    ])
    const germany = await rules(seedLabel, '?marketCode=DE')
    expect(checksOf(germany.markets[0]).classWarnings.findings).toEqual([expect.objectContaining({ path: 'phrases/warning.protectors-removable/de', severity: 'FAIL' })])
  })
})

describe("a consumer line's GPSR contact, set on a draft label (PRD-346)", () => {
  it('asks for the contact of our company, refuses a QR on a product that is not PPE, and passes once the contact is complete', async () => {
    let template = await draftLabel({ styleId: casual })
    expect(template).toMatchObject({ kind: 'PPE_GARMENT', qrTarget: 'NONE', gpsrContact: null })
    let checks = await rules(template.id, '?marketCode=IT')
    const gpsr = checksOf(checks.markets[0]).gpsr
    expect(gpsr).toMatchObject({ outcome: 'FAIL', gateKey: 'gpsr.contact', findings: [{ path: 'gpsrContact' }] })
    expect(checks.markets[0].sender).toMatchObject({ who: 'COMPANY', name: 'Seed Company A S.r.l.', contact: 'compliance.a@example.com' })
    expect(checks.marking.gpsr.suggested).toBe('Seed Company A S.r.l.\nVia Seed 1, 00000 Seedtown (XX), Italy\ncompliance.a@example.com')

    template = await setMarking(template, { qrTarget: 'BATCH_DOC', gpsrContact: 'Seed Company A S.r.l.\nVia Seed 1, 00000 Seedtown (XX), Italy' })
    expect(template).toMatchObject({ qrTarget: 'BATCH_DOC', gpsrContact: 'Seed Company A S.r.l.\nVia Seed 1, 00000 Seedtown (XX), Italy', status: 'DRAFT' })
    checks = await rules(template.id, '?marketCode=IT')
    expect(checksOf(checks.markets[0]).qrCode).toMatchObject({ outcome: 'FAIL', findings: [{ path: 'qrTarget' }] })
    expect(checksOf(checks.markets[0]).gpsr.findings.map((entry: Json) => entry.message)).toEqual([expect.stringContaining('no electronic address')])

    template = await setMarking(template, { qrTarget: 'NONE', gpsrContact: 'Seed Company A S.r.l.\nVia Seed 1, 00000 Seedtown (XX), Italy\ncompliance.a@example.com' })
    checks = await rules(template.id, '?marketCode=IT')
    expect(outcomes(checks.markets[0])).toMatchObject({ gpsr: 'PASS', qrCode: 'NOT_APPLICABLE', ceMarking: 'NOT_APPLICABLE' })
    // The audit rows say what changed; W1's event says the label was saved.
    const audits = await admin<{ action: string; before: Json; after: Json }>(`SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'compliance.labels.marking' ORDER BY at, id`, [template.id])
    expect(audits.map((row) => [row.before.qrTarget, row.after.qrTarget])).toEqual([
      ['NONE', 'BATCH_DOC'],
      ['BATCH_DOC', 'NONE'],
    ])
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [template.id])
    expect(events.at(-1)).toMatchObject({ type: 'compliance.label_template_saved', payload: { change: 'UPDATED', templateId: template.id } })
    // The garment label prints the contact, line by line.
    const { label } = await ok('manager', 'GET', `/compliance/labels/${template.id}/preview`)
    expect(blockOf(label, 'gpsrContact').lines.map((line: Json) => line.text)).toEqual(['Seed Company A S.r.l.', 'Via Seed 1, 00000 Seedtown (XX), Italy', 'compliance.a@example.com'])
    expect(blockOf(label, 'ceMark')).toBeUndefined()
  })
})

describe("the QR to the batch's public DoC page (PRD-349)", () => {
  it("leads to WO-0001's page, is printed on its garment label (ZPL), and a label started from it keeps it", async () => {
    const origin = processEmail().webOrigin
    let template = await draftLabel({ styleId: brandJacket, makerName: 'Seed Customer One S.r.l.', makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy' })
    template = await setMarking(template, { qrTarget: 'BATCH_DOC' })
    const checks = await rules(template.id, `?marketCode=IT&workOrderId=${workOrder}`)
    expect(checks.workOrder).toMatchObject({ id: workOrder, batchNumber: 'SEED-BT-0001', released: true })
    expect(checks.marking.qr).toMatchObject({ target: 'BATCH_DOC', kind: 'BATCH', address: `${origin}/doc/${publicDocCodeOf(workOrder)}`, live: true, recordType: 'WorkOrder', recordId: workOrder })
    const qr = checksOf(checks.markets[0]).qrCode
    // The local web origin is plain http: a warning, never a refusal.
    expect(qr).toMatchObject({ outcome: 'WARN', blocks: false, gateKey: 'label.qrCode', findings: [{ path: 'qr/origin' }] })
    // The brand sells SEED-JKT-02 under its own name: the GPSR sender is the brand (Owner 11-09), were the contact asked.
    expect(checks.markets[0].sender).toMatchObject({ who: 'BRAND', name: 'Seed Customer One S.r.l.' })

    // A preview has no batch: a placeholder box. The garment label at the final operation carries the address.
    const preview = await ok('manager', 'GET', `/compliance/labels/${template.id}/preview`)
    expect(blockOf(preview.label, 'qr')).toMatchObject({ value: null, placeholder: true, graphic: null })
    const label = await database.withScope({ audience: 'office', tenantId: tenant, actorId: user }, (client) =>
      garmentLabelFor(client, {
        labelTemplateId: template.id,
        styleId: brandJacket,
        styleRevisionId: null,
        colourwayId: seedId('production:colourway:JKT-02:BLK'),
        size: '52',
        identification: { kind: 'BATCH', value: 'SEED-BT-0001', recordType: 'WorkOrder', recordId: workOrder, reference: 'WO-0001' },
        manufactured: { date: '2026-11-02', recordType: 'WorkOrder', recordId: workOrder, reference: 'WO-0001' },
        date: '2026-11-26',
        marketLanguages: [],
      }),
    )
    expect(label.blocks.find((block) => block.field === 'qr')).toMatchObject({ value: `${origin}/doc/${publicDocCodeOf(workOrder)}`, placeholder: false, source: { kind: 'WORK_ORDER', recordId: workOrder } })
    expect(garmentLabelZpl(label, 203)).toContain(`^FH^FDMA,${origin}/doc/${publicDocCodeOf(workOrder)}^FS`)

    // The style's page instead: known in a preview, drawn in the PDF; on a garment a warning (the batch's page is the one).
    template = await setMarking(template, { qrTarget: 'STYLE_DOC' })
    const styled = await ok('manager', 'GET', `/compliance/labels/${template.id}/preview`)
    expect(blockOf(styled.label, 'qr')).toMatchObject({ value: `${origin}/doc/${publicDocCodeOf(brandJacket)}`, placeholder: false })
    const pdf = await call('manager', 'GET', `/compliance/labels/${template.id}/preview/pdf`)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(checksOf((await rules(template.id, '?marketCode=IT')).markets[0]).qrCode.findings.map((entry: Json) => entry.path)).toEqual(expect.arrayContaining(['qrTarget', 'qr/origin']))
    const copy = await draftLabel({ styleId: brandJacket, fromTemplateId: template.id })
    expect(copy).toMatchObject({ qrTarget: 'STYLE_DOC', kind: 'PPE_GARMENT' })
  })

  it("answers B-W2b-254's gate on the floor, by the requirement's checkKey, without reading what the floor may not", async () => {
    const template = await draftLabel({ styleId: brandJacket, makerName: 'Seed Customer One S.r.l.', makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy' })
    await setMarking(template, { qrTarget: 'BATCH_DOC' })
    const answer = await database.withScope({ audience: 'floor', tenantId: tenant, siteId: siteA, actorId: 'floor-test' }, (client) =>
      labelRulesFor(client, { labelTemplateId: template.id, styleId: brandJacket, styleRevisionId: null, workOrderId: workOrder, marketCode: 'IT', day: '2026-11-26', office: false }),
    )
    expect([...answer.byCheckKey.keys()]).toEqual(['label.ceMarking', 'label.classWarnings', 'label.gloveMarking', 'gpsr.contact', 'label.qrCode'])
    expect(answer.byCheckKey.get('label.qrCode')).toMatchObject({ outcome: 'WARN', blocks: false })
    expect(answer.byCheckKey.get('gpsr.contact')!.outcome).toBe('NOT_APPLICABLE')
    expect(answer.byCheckKey.get('label.ceMarking')!.outcome).toBe('PASS')
  })
})

describe('glove marking and the notified body after the CE mark (PRD-336, PRD-333)', () => {
  it('asks a glove for a glove marking with its level, and a new revision keeps the kind', async () => {
    let template = await draftLabel({ styleId: gloves })
    expect(checksOf((await rules(template.id, '?marketCode=IT')).markets[0]).gloveMarking).toMatchObject({ outcome: 'WARN', findings: [{ path: 'kind' }] })
    template = await setMarking(template, { kind: 'GLOVE_MARKING' })
    const glove = await rules(template.id, '?marketCode=IT')
    expect(checksOf(glove.markets[0]).gloveMarking).toMatchObject({ outcome: 'PASS', gateKey: 'label.gloveMarking', words: expect.stringContaining('level 2 KP') })
    expect(glove.marking.glove).toEqual({ level: { level: '2', knuckle: true }, text: '2 KP', granted: null })
    const retired = await ok('manager', 'POST', `/compliance/labels/${template.id}/retire`, { version: template.version })
    const revised = await ok('manager', 'POST', `/compliance/labels/${retired.template.id}/revisions`, {}, 201)
    expect(revised.template).toMatchObject({ revision: 2, status: 'DRAFT', kind: 'GLOVE_MARKING' })
  })

  it("names a category III vest's notified body from the directory, and warns a number the directory lacks", async () => {
    const template = await draftLabel({ styleId: vest, layout: { fields: [], notifiedBodyNumber: '0000' } })
    expect(checksOf((await rules(template.id, '?marketCode=IT')).markets[0]).ceMarking).toMatchObject({ outcome: 'PASS', words: expect.stringContaining('followed by 0000, Seed Notified Body') })
    const changed = await ok('manager', 'PATCH', `/compliance/labels/${template.id}`, { version: template.version, layout: { fields: [], notifiedBodyNumber: '0001' } })
    expect(changed.template.layout.notifiedBodyNumber).toBe('0001')
    expect(checksOf((await rules(template.id, '?marketCode=IT')).markets[0]).ceMarking).toMatchObject({ outcome: 'WARN', findings: [{ path: 'layout/notifiedBodyNumber', severity: 'WARN' }] })
  })
})

describe('refusals', () => {
  it('refuses a person without the label permission, a frozen label, a stale version, nothing to change and an over-long contact', async () => {
    const template = await draftLabel({ styleId: casual })
    expect((await setMarking(template, { qrTarget: 'BATCH_DOC' }, 'viewer', 403)).code).toBe('forbidden')
    const frozen = await refused('manager', 'PUT', `/compliance/label-rules/templates/${seedLabel}/marking`, { version: 1, kind: 'GLOVE_MARKING' }, 409)
    expect(frozen.message).toContain('only while it is a draft')
    await setMarking(template, { qrTarget: 'BATCH_DOC' })
    await setMarking(template, { qrTarget: 'NONE' }, 'manager', 409)
    expect((await refused('manager', 'PUT', `/compliance/label-rules/templates/${template.id}/marking`, { version: template.version + 1 }, 400)).message).toBe('Nothing to change.')
    await refused('manager', 'PUT', `/compliance/label-rules/templates/${template.id}/marking`, { version: template.version + 1, gpsrContact: 'x'.repeat(501) }, 400)
  })

  it('answers a database refusal in words (409, never 500)', async () => {
    const template = await draftLabel({ styleId: casual })
    const error = await refused('manager', 'PUT', `/compliance/label-rules/templates/${template.id}/marking`, { version: template.version, gpsrContact: 'Seed Company A\u0007 S.r.l.' }, 409)
    expect(error.message).toContain('GPSR contact')
  })

  it('reads nothing across walls: an unknown market, a shared label without a style, another tenant, the floor', async () => {
    await refused('manager', 'GET', `/compliance/label-rules/templates/${seedLabel}?marketCode=XX`, undefined, 404)
    const shared = await draftLabel({})
    expect((await refused('manager', 'GET', `/compliance/label-rules/templates/${shared.id}`, undefined, 400)).issues[0].path).toBe('querystring/styleId')
    await refused('otherTenant', 'GET', `/compliance/label-rules/templates/${seedLabel}`, undefined, 404)
    await refused('floor', 'GET', `/compliance/label-rules/templates/${seedLabel}`, undefined, 403)
    await refused('manager', 'GET', `/compliance/label-rules/templates/${seedLabel}?workOrderId=${newId()}`, undefined, 404)
  })
})
