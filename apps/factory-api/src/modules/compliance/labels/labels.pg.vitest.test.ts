import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { pdfPageCount } from '../../../platform/documents/testing/pdf-text'
import { renderLabel } from '@nexus/factory-domain/compliance/labels/render'
import { garmentLabelFor } from './preview'
import { useLabelsClock } from './store'

/**
 * The PPE garment label builder (B-W1-19) on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login, so row-level security and the …_product_guards triggers are real),
 * seeded with the core, parties, product and compliance seeds (the seed jacket SEED-JKT-01: EN 17092-3:2020 class AA,
 * certificate SEED-CERT-0001, label SEED-LBL-JKT-01 r1 ACTIVE). Every style, party, certificate and notified body number
 * is made up ("9998", "9999" and "0000" are no notified bodies). Run with `node scripts/factory/run-pg-tests.mjs compliance/labels`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'labels-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA = seedId('site:A1')
const jacket = seedId('product:style:JKT-01')
const jacketRev1 = seedId('product:revision:JKT-01:1')
const BLK = seedId('product:colourway:JKT-01:BLK')
const scale = seedId('product:size-scale:EU-JKT')
const brand = seedId('party:P1')
const seedLabel = seedId('compliance:label:JKT-01:1')
const otherTenant = newId()
const user = newId()

// Made-up styles beside the seed's: an airbag vest of category III, rider gloves with no level, a company-B jacket.
const vest = newId()
const vestRev = newId()
const vestBlack = newId()
const gloves = newId()
const glovesRev = newId()
const jacketRev2 = newId()
const zplPrinter = newId()
const smallPrinter = newId()

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.labels.manage'
const clock: Clock = { now: () => new Date('2026-10-29T09:00:00.000Z') }
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(tenant, [grant([VIEW, MANAGE, 'print.view', 'print.labels', 'workorders.view'])]),
  viewer: office(tenant, [grant([VIEW])]),
  companyB: office(tenant, [grant([VIEW, MANAGE], [companyB])]),
  companyA: office(tenant, [grant([VIEW], [companyA])]),
  noPrint: office(tenant, [grant([VIEW, MANAGE, 'print.view'])]),
  otherTenant: office(otherTenant, [grant([VIEW, MANAGE])]),
  nobody: office(tenant, [grant(['product.styles.view'])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [grant(['floor.work', VIEW, MANAGE, 'print.labels'], [companyA])] },
  partner: { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: brand, grants: [grant([VIEW, MANAGE])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
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
const paths = (issues: { path: string }[] | undefined) => (issues ?? []).map((issue) => issue.path)
const blockOf = (label: Json, field: string): Json => label.blocks.find((block: Json) => block.field === field)
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => [event.type, event.payload])
const auditOf = (recordId: string) => admin<{ action: string; before: Json; after: Json }>('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [recordId])

/** A valid jacket label body: what the builder sends. */
const jacketBody = (extra: Json = {}): Json => ({
  styleId: jacket,
  code: `LBL-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  languages: ['it', 'en'],
  composition: [
    { part: 'shell', fibres: [{ fibre: 'leather (not a textile)', percent: '100' }] },
    { part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] },
  ],
  animalOriginPhrase: true,
  care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
  layout: { fields: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'] },
  ...extra,
})

beforeAll(async () => {
  db = await migratedDatabase('labels')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'labels-other'])
  useLabelsClock(clock)

  const style = `INSERT INTO "Style" (id, "tenantId", code, name, "productType", "sizeScaleId", sizes, "baseSize", "ppeCategory", "ppeStandard", "ppeClass", status)
    VALUES ($1, $2, $3, $4, $5, $6, ARRAY['52'], '52', $7, $8, $9, 'DRAFT')`
  await admin(style, [vest, tenant, 'TEST-VEST-03', 'Test airbag vest', 'VEST', scale, 'CATEGORY_III', 'EN 1621-4:2013', null])
  await admin(style, [gloves, tenant, 'TEST-GLV-02', 'Test rider gloves', 'GLOVES', scale, 'CATEGORY_II', 'EN 13594:2015', null])
  await admin(`INSERT INTO "Colourway" (id, "tenantId", "styleId", code, name) VALUES ($1, $2, $3, 'BLK', 'Black')`, [vestBlack, tenant, vest])
  const revision = `INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "releasedAt") VALUES ($1, $2, $3, $4, $5, $6)`
  await admin(revision, [vestRev, tenant, vest, 1, 'DRAFT', null])
  await admin(revision, [glovesRev, tenant, gloves, 1, 'DRAFT', null])
  await admin(revision, [jacketRev2, tenant, jacket, 2, 'RELEASED', '2026-10-20T08:00:00.000Z'])
  const printer = `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm")
    VALUES ($1, $2, $3, $4, $5, $5, 'LABEL_ZPL', 'FAKE', 'fake://labels', 203, $6, $7)`
  await admin(printer, [zplPrinter, tenant, companyA, siteA, 'GARMENT-1', 100, 100])
  await admin(printer, [smallPrinter, tenant, companyA, siteA, 'CARTON-1', 76, 48])

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

describe('a preview of the seed jacket (PRD-331)', () => {
  it('shows class AA from the certificate, the standard part, the size with its body measures and the batch placeholder, each with its source', async () => {
    const { label, cell, zpl } = await ok('viewer', 'GET', `/compliance/labels/${seedLabel}/preview?styleRevisionId=${jacketRev1}&colourwayId=${BLK}&size=52`)
    expect(cell).toMatchObject({ styleId: jacket, styleCode: 'SEED-JKT-01', styleRevisionId: jacketRev1, revision: 1, colourwayId: BLK, size: '52', date: '2026-10-29', certificate: { outcome: 'covered', number: 'SEED-CERT-0001' } })
    expect(label).toMatchObject({ template: { code: 'SEED-LBL-JKT-01', revision: 1, status: 'ACTIVE' }, sample: true, banner: ['SAMPLE - NOT FOR GARMENTS', 'CAMPIONE - NON PER CAPI'], problems: [], printable: true })
    expect(blockOf(label, 'pictogram')).toMatchObject({
      value: 'AA',
      graphic: { kind: 'PICTOGRAM', pictogram: 'MOTORCYCLIST', standardCode: 'EN 17092', ppeClass: 'AA' },
      source: { kind: 'CERTIFICATE', words: 'From certificate SEED-CERT-0001: class AA, valid until 2031-01-14.', recordType: 'Certificate', recordId: seedId('compliance:certificate:JKT-01') },
    })
    expect(blockOf(label, 'standard')).toMatchObject({ value: 'EN 17092-3:2020', source: { kind: 'STYLE', words: 'From style SEED-JKT-01: EN 17092 part 3, edition 2020.', recordId: jacket } })
    expect(blockOf(label, 'size')).toMatchObject({ value: '52', source: { kind: 'SIZE_SCALE', words: 'From size scale SEED-EU-JKT: size 52.', recordType: 'SizeScale', recordId: scale } })
    expect(blockOf(label, 'bodyMeasures')).toMatchObject({ value: 'chest 100-104 cm, height 176-182 cm', source: { kind: 'SIZE_SCALE' } })
    expect(blockOf(label, 'batchOrSerial')).toMatchObject({ value: null, placeholder: true, lines: [{ text: 'LOT ________' }], source: { kind: 'SAMPLE' } })
    expect(blockOf(label, 'maker')).toMatchObject({ value: 'Seed Customer One S.r.l.', source: { kind: 'TEMPLATE', recordType: 'Party', recordId: brand } })
    expect(blockOf(label, 'animalOrigin').lines.map((line: Json) => line.language)).toEqual(['it', 'en'])
    expect(blockOf(label, 'ceMark')).toMatchObject({ value: 'CE', source: { kind: 'RULE' } })
    expect(zpl.dpi).toBe(203)
    expect(zpl.text).toMatch(/^\^XA\n\^CI28\n\^PW400\n\^LL639\n/)
    expect(zpl.text).toContain('^FDAA^FS')
  })

  it("echoes the cell's values, so a browser renders a draft as it is typed with the same blocks (renderLabel)", async () => {
    const { label, values } = await ok('viewer', 'GET', `/compliance/labels/${seedLabel}/preview?colourwayId=${BLK}&size=52&languages=de,it`)
    expect(values).toMatchObject({
      style: { id: jacket, code: 'SEED-JKT-01', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA', brandPartyId: brand },
      colourway: { id: BLK },
      size: { code: '52', scaleId: scale, bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' } } },
      certificate: { outcome: 'covered', certificate: { number: 'SEED-CERT-0001', ppeClass: 'AA', validTo: '2031-01-14' }, date: '2026-10-29' },
      identification: { kind: 'BATCH' },
      date: '2026-10-29',
      marketLanguages: ['de', 'it'],
    })
    const { template } = await ok('viewer', 'GET', `/compliance/labels/${seedLabel}`)
    const facts = { ...template, storedProblems: [] } as Parameters<typeof renderLabel>[0]
    const again = renderLabel(facts, {
      ...values,
      identification: { kind: values.identification.kind, value: null, recordType: null, recordId: null, reference: null },
      manufactured: null,
      sample: true,
    })
    expect(again.blocks).toEqual(label.blocks)
    expect(again.problems).toEqual(label.problems)
    expect(again.fit).toEqual(label.fit)
  })

  it("names the buyer's missing language, a size outside the range, and a cell no certificate covers that day", async () => {
    const german = await ok('viewer', 'GET', `/compliance/labels/${seedLabel}/preview?colourwayId=${BLK}&size=50&languages=de,it`)
    expect(german.label.problems).toEqual([{ path: 'languages', message: "The buyer's market needs de; the label prints it, en: add it (Reg. (EU) 1007/2011 art. 16(3); Reg. (EU) 2016/425 art. 8(7))." }])
    const outside = await refused('viewer', 'GET', `/compliance/labels/${seedLabel}/preview?size=56`, undefined, 400)
    expect(outside.issues).toEqual([{ path: 'querystring/size', message: 'Size 56 is not in the size range of style SEED-JKT-01 (50, 52, 54).' }])
    // The seed certificate's last valid day is 2031-01-14.
    const late = await ok('viewer', 'GET', `/compliance/labels/${seedLabel}/preview?date=2031-02-01`)
    expect(late.cell.certificate.outcome).toBe('refused')
    expect(late.label.printable).toBe(false)
    expect(paths(late.label.problems)).toEqual(['certificate'])
    expect(blockOf(late.label, 'pictogram').source).toMatchObject({ kind: 'STYLE', words: 'From style SEED-JKT-01: class AA; no valid certificate covers BLK 52 on 2031-02-01.' })
  })

  it('answers the PDF of the label at its size, stored nowhere', async () => {
    const response = await call('viewer', 'GET', `/compliance/labels/${seedLabel}/preview/pdf?colourwayId=${BLK}&size=54`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toContain('SEED-LBL-JKT-01-r1-sample.pdf')
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdfPageCount(response.rawPayload)).toBe(1)
    // 50 × 80 mm in points.
    expect(response.rawPayload.toString('latin1')).toMatch(/\/MediaBox \[0 0 141\.73\d* 226\.77\d*\]/)
  })
})

describe('building, activating and revising a label', () => {
  it('a valid template is created as a draft with the brand as maker, activates, and is frozen from then on', async () => {
    const created = (await ok('manager', 'POST', '/compliance/labels', jacketBody({ code: 'LBL-T-JKT' }), 201)).template
    expect(created).toMatchObject({
      code: 'LBL-T-JKT',
      revision: 1,
      status: 'DRAFT',
      styleId: jacket,
      companyId: null,
      name: 'Seed leather jacket garment label',
      makerPartyId: brand,
      makerName: 'Seed Customer One S.r.l.',
      makerAddress: 'Via Esempio 10, 00000 Seedville (MI), IT',
      widthMm: '50.00',
      heightMm: '80.00',
      layout: { preset: 'STANDARD', notifiedBodyNumber: null, manufactureDate: 'QUARTER' },
      problems: [],
      activatable: true,
      nextStatuses: ['ACTIVE', 'RETIRED'],
      revisions: [{ revision: 1, status: 'DRAFT' }],
    })
    const active = (await ok('manager', 'POST', `/compliance/labels/${created.id}/activate`, { version: created.version })).template
    expect(active).toMatchObject({ status: 'ACTIVE', version: created.version + 1, nextStatuses: ['RETIRED'] })
    expect(await eventsOf(created.id)).toEqual([
      ['compliance.label_template_saved', { templateId: created.id, code: 'LBL-T-JKT', revision: 1, styleId: jacket, change: 'CREATED', problems: 0 }],
      ['compliance.label_template_activated', { templateId: created.id, code: 'LBL-T-JKT', revision: 1, styleId: jacket }],
    ])
    expect((await auditOf(created.id)).map((row) => row.action)).toEqual(['compliance.labels.create', 'compliance.labels.activate'])

    // An ACTIVE template is never edited, by the API or by the database.
    const frozen = await refused('manager', 'PATCH', `/compliance/labels/${created.id}`, { version: active.version, name: 'Changed' }, 409)
    expect(frozen).toMatchObject({ code: 'invalid_state', message: 'Label LBL-T-JKT r1 is active: active labels are never edited, a change is a new revision. Work orders keep the revision they were released with.' })
    await expect(admin(`UPDATE "LabelTemplate" SET name = 'Changed' WHERE id = $1`, [created.id])).rejects.toThrow(/only its status changes/)
    expect((await admin<{ name: string }>('SELECT name FROM "LabelTemplate" WHERE id = $1', [created.id]))[0]!.name).toBe('Seed leather jacket garment label')
    await refused('manager', 'POST', `/compliance/labels/${created.id}/activate`, { version: active.version }, 409)
    // The code is taken.
    expect((await refused('manager', 'POST', '/compliance/labels', jacketBody({ code: 'LBL-T-JKT' }), 409)).message).toContain('exists already (revision 1)')

    // A change is a new revision: a draft with the same content; one draft per code.
    const r2 = (await ok('manager', 'POST', `/compliance/labels/${created.id}/revisions`, {}, 201)).template
    expect(r2).toMatchObject({ code: 'LBL-T-JKT', revision: 2, status: 'DRAFT', makerName: 'Seed Customer One S.r.l.', composition: created.composition, revisions: [{ revision: 1, status: 'ACTIVE' }, { revision: 2, status: 'DRAFT' }] })
    expect((await refused('manager', 'POST', `/compliance/labels/${created.id}/revisions`, {}, 409)).message).toBe('Label LBL-T-JKT has a draft already: revision 2. Edit it, or retire it first.')
    const edited = (await ok('manager', 'PATCH', `/compliance/labels/${r2.id}`, { version: r2.version, heightMm: '90', care: [{ symbol: 'wash-30', text: { it: 'Lavare a 30 °C', en: 'Wash at 30 °C' } }] })).template
    expect(edited).toMatchObject({ heightMm: '90.00', problems: [], care: [{ symbol: 'wash-30' }] })
    await ok('manager', 'POST', `/compliance/labels/${r2.id}/activate`, { version: edited.version })
    // Revision 1 stays active until retired: work orders and style revisions keep the revision they name.
    const retired = (await ok('manager', 'POST', `/compliance/labels/${created.id}/retire`, { version: active.version, reason: 'Replaced by revision 2.' })).template
    expect(retired).toMatchObject({ status: 'RETIRED', nextStatuses: [] })
    expect((await eventsOf(created.id)).at(-1)).toEqual(['compliance.label_template_retired', { templateId: created.id, code: 'LBL-T-JKT', revision: 1, styleId: jacket, previousStatus: 'ACTIVE', releasedRevisions: 0 }])
    expect((await refused('manager', 'PATCH', `/compliance/labels/${created.id}`, { version: retired.version, name: 'x' }, 409)).message).toContain('is retired')
  })

  it('an invalid template is saved as a draft and refused activation with each problem', async () => {
    const draft = (
      await ok(
        'manager',
        'POST',
        '/compliance/labels',
        jacketBody({
          languages: ['it', 'nl'],
          composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '60' }, { fibre: 'polyamide', percent: '30' }] }],
          care: [{ symbol: 'wash-30' }, { symbol: 'wash-not' }],
          layout: { notifiedBodyNumber: '9998' },
          makerAddress: 'Somewhere in Italy',
        }),
        201,
      )
    ).template
    expect(draft.status).toBe('DRAFT')
    expect(draft.activatable).toBe(false)
    const expected = ['makerAddress', 'composition/0/fibres', 'layout/texts/animalOrigin/nl', 'care/1/symbol', 'layout/notifiedBodyNumber']
    expect(paths(draft.problems)).toEqual(expected)
    const error = await refused('manager', 'POST', `/compliance/labels/${draft.id}/activate`, { version: draft.version }, 409)
    expect(error.message).toBe(`Label ${draft.code} r1 cannot be activated yet: 5 problem(s) to fix first.`)
    expect(paths(error.issues)).toEqual(expected)
    expect(error.issues.find((issue: Json) => issue.path === 'layout/notifiedBodyNumber').message).toContain('No notified-body number after the CE mark: style SEED-JKT-01 is category II PPE')
    expect((await admin<{ status: string }>('SELECT status FROM "LabelTemplate" WHERE id = $1', [draft.id]))[0]!.status).toBe('DRAFT')

    // Text too long for the layout.
    const tiny = (await ok('manager', 'POST', '/compliance/labels', jacketBody({ widthMm: '30', heightMm: '30' }), 201)).template
    expect(paths((await refused('manager', 'POST', `/compliance/labels/${tiny.id}/activate`, { version: tiny.version }, 409)).issues)).toEqual(['heightMm'])
    // Malformed bodies are refused before anything is saved.
    expect(paths((await refused('manager', 'POST', '/compliance/labels', jacketBody({ code: 'lbl bad' }), 400)).issues)).toEqual(['body/code'])
    expect((await refused('manager', 'POST', '/compliance/labels', jacketBody({ widthMm: '50mm' }), 400)).code).toBe('validation_failed')
  })

  it('a category III style needs the notified body after CE: refused without it, at activation and when named on a revision', async () => {
    const draft = (await ok('manager', 'POST', '/compliance/labels', { styleId: vest, makerName: 'Test Airbag S.r.l.', makerAddress: 'Via Prova 3, 00000 Testville, IT' }, 201)).template
    expect(draft).toMatchObject({ code: 'LBL-TEST-VEST-03', makerPartyId: null })
    expect(paths(draft.problems)).toEqual(['layout/notifiedBodyNumber'])
    const error = await refused('manager', 'POST', `/compliance/labels/${draft.id}/activate`, { version: draft.version }, 409)
    expect(error.issues).toEqual([
      { path: 'layout/notifiedBodyNumber', message: 'Style TEST-VEST-03 is category III PPE: the CE marking is followed by the identification number of the notified body that checks production (Reg. (EU) 2016/425 art. 17(2)). Type it in the label.' },
    ])
    const assign = await refused('manager', 'PUT', `/product/styles/${vest}/revisions/${vestRev}/label`, { labelTemplateId: draft.id, version: 1 }, 409)
    expect(assign.message).toBe(`Label LBL-TEST-VEST-03 r1 cannot mark style TEST-VEST-03: 1 problem(s) to fix first.`)
    expect(paths(assign.issues)).toEqual(['layout/notifiedBodyNumber'])

    const fixed = (await ok('manager', 'PATCH', `/compliance/labels/${draft.id}`, { version: draft.version, layout: { notifiedBodyNumber: '9999' } })).template
    expect(fixed.problems).toEqual([])
    const active = (await ok('manager', 'POST', `/compliance/labels/${draft.id}/activate`, { version: fixed.version })).template
    expect(active.status).toBe('ACTIVE')
    const named = await ok('manager', 'PUT', `/product/styles/${vest}/revisions/${vestRev}/label`, { labelTemplateId: draft.id, version: 1 })
    expect(named).toMatchObject({ revision: { id: vestRev, revision: 1, status: 'DRAFT', labelTemplateId: draft.id, version: 2 }, template: { id: draft.id, status: 'ACTIVE' }, warnings: [] })
    expect(await eventsOf(vestRev)).toEqual([['compliance.label_assigned', { styleId: vest, styleRevisionId: vestRev, revision: 1, labelTemplateId: draft.id, previousLabelTemplateId: null }]])
    const preview = await ok('viewer', 'GET', `/compliance/labels/${draft.id}/preview`)
    expect(blockOf(preview.label, 'ceMark')).toMatchObject({ value: 'CE 9999', graphic: { kind: 'CE', notifiedBodyNumber: '9999' } })
    // No certificate covers the vest: a garment label would be refused, the preview says so.
    expect(paths(preview.label.problems)).toEqual(['certificate'])
  })

  it('a PPE style without its class cannot carry an active label', async () => {
    const draft = (await ok('manager', 'POST', '/compliance/labels', { styleId: gloves, makerName: 'Test Gloves S.r.l.', makerAddress: 'Via Prova 4, 00000 Testville, IT' }, 201)).template
    const error = await refused('manager', 'POST', `/compliance/labels/${draft.id}/activate`, { version: draft.version }, 409)
    expect(error.issues).toEqual([{ path: 'style/ppeClass', message: 'Style TEST-GLV-02 is made to EN 13594:2015 but names no class: the pictogram prints the class (1, 2, 1KP, 2KP).' }])
  })
})

describe('naming a label on a style revision', () => {
  it('only on a draft revision, only an unretired label of the style or shared, version-guarded', async () => {
    const own = (await ok('manager', 'POST', '/compliance/labels', jacketBody({ code: 'LBL-T-ASSIGN' }), 201)).template
    const named = await ok('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: own.id, version: 1 })
    // A draft label may be named; the release waits for it to be active.
    expect(named).toMatchObject({ revision: { labelTemplateId: own.id, version: 2 }, warnings: [{ path: 'body/labelTemplateId', message: 'Label LBL-T-ASSIGN r1 is draft: the revision is released only once it is active.' }] })
    expect((await auditOf(jacketRev1)).at(-1)).toMatchObject({ action: 'compliance.labels.assign', before: { labelTemplateId: seedLabel }, after: { labelTemplateId: own.id } })
    await refused('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: seedLabel, version: 1 }, 409)
    expect((await refused('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev2}/label`, { labelTemplateId: own.id, version: 1 }, 409)).message).toBe(
      'Revision 2 of style SEED-JKT-01 is released: its label is frozen with it. Start a new revision to name another label.',
    )
    const vestLabel = (await ok('manager', 'GET', `/compliance/labels?styleId=${vest}`)).templates[0]
    expect(paths((await refused('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: vestLabel.id, version: 2 }, 400)).issues)).toEqual(['body/labelTemplateId'])
    const retired = (await ok('manager', 'POST', `/compliance/labels/${own.id}/retire`, { version: own.version })).template
    expect(retired.status).toBe('RETIRED')
    expect((await refused('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: own.id, version: 2 }, 409)).message).toContain('is retired')
    // Back to the seed's active label, then none.
    await ok('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: seedLabel, version: 2 })
    expect((await admin<{ labelTemplateId: string }>('SELECT "labelTemplateId" FROM "StyleRevision" WHERE id = $1', [jacketRev1]))[0]!.labelTemplateId).toBe(seedLabel)
    const detail = (await ok('viewer', 'GET', `/compliance/labels/${seedLabel}`)).template
    expect(detail.usage.styleRevisions).toEqual([{ id: jacketRev1, styleId: jacket, styleCode: 'SEED-JKT-01', revision: 1, status: 'DRAFT' }])
  })
})

describe('test labels and the garment label at the final operation', () => {
  it('prints a SAMPLE test label through the print service on a label printer whose stock holds it', async () => {
    const { job, label } = await ok('manager', 'POST', `/compliance/labels/${seedLabel}/test-print`, { printerId: zplPrinter, copies: 2, colourwayId: BLK, size: '52' }, 201)
    expect(job).toMatchObject({ printerId: zplPrinter, recordType: 'LabelTemplate', recordId: seedLabel, payloadKind: 'ZPL', labelKind: 'GARMENT', scanId: 'SAMPLE', copies: 2, status: 'QUEUED' })
    expect(label.sample).toBe(true)
    const [stored] = await admin<{ zpl: string }>('SELECT zpl FROM "PrintJob" WHERE id = $1', [job.id])
    expect(stored!.zpl).toContain('^FDSAMPLE - NOT FOR GARMENTS^FS')
    expect(stored!.zpl).toContain('^PQ2\n^XZ')
    expect((await refused('manager', 'POST', `/compliance/labels/${seedLabel}/test-print`, { printerId: smallPrinter }, 400)).issues).toEqual([
      { path: 'body/printerId', message: 'This printer holds 76 × 48 mm labels; label SEED-LBL-JKT-01 is 50.00 × 80.00 mm.' },
    ])
    // print.labels is the print service's own check on the printer.
    await refused('noPrint', 'POST', `/compliance/labels/${seedLabel}/test-print`, { printerId: zplPrinter }, 403)
  })

  it('renders the real label of a cell with the batch, and refuses it when the certificate no longer covers it (B-W1-44)', async () => {
    const caller = callerFor(database, { audience: 'office', tenantId: tenant, actorId: user, grants: [], requestId: newId() })
    const question = {
      labelTemplateId: seedLabel,
      styleId: jacket,
      styleRevisionId: jacketRev1,
      colourwayId: BLK,
      size: '52',
      identification: { kind: 'BATCH' as const, value: 'BA-00042', recordType: 'WorkOrder', recordId: newId(), reference: 'WO-00042' },
      manufactured: { date: '2026-11-03', recordType: 'WorkOrder', recordId: newId(), reference: 'WO-00042' },
      date: '2026-11-03',
      marketLanguages: ['it'],
    }
    const label = await caller.withClient((client) => garmentLabelFor(client, question))
    expect(label).toMatchObject({ sample: false, banner: [], printable: true, problems: [] })
    expect(label.blocks.find((block) => block.field === 'batchOrSerial')).toMatchObject({ value: 'BA-00042', placeholder: false, source: { kind: 'WORK_ORDER' } })
    const late = await caller.withClient((client) => garmentLabelFor(client, { ...question, date: '2031-01-15' }))
    expect(late.printable).toBe(false)
    expect(late.problems.map((problem) => problem.path)).toEqual(['certificate'])
  })
})

describe('walls: tenant, company, audience', () => {
  it('another tenant sees nothing; a company sees its own and the tenant-wide labels, and writes only its own', async () => {
    await refused('otherTenant', 'GET', `/compliance/labels/${seedLabel}`, undefined, 404)
    expect((await ok('otherTenant', 'GET', '/compliance/labels')).templates).toEqual([])
    await refused('otherTenant', 'GET', `/compliance/labels/${seedLabel}/preview`, undefined, 404)

    // Company B reads the tenant-wide seed label, but writes a tenant-wide one only with a grant over every company.
    await ok('companyB', 'GET', `/compliance/labels/${seedLabel}`)
    expect((await refused('companyB', 'POST', `/compliance/labels/${seedLabel}/revisions`, {}, 403)).message).toBe('A label for every company is changed only by a role over every company.')
    const own = (await ok('companyB', 'POST', '/compliance/labels', { code: 'LBL-B-SHARED', name: 'Company B shared label', companyId: companyB, makerName: 'Seed Company B', makerAddress: 'Via Esempio 2, 00000 Seedville, IT' }, 201)).template
    expect(own).toMatchObject({ companyId: companyB, styleId: null, status: 'DRAFT' })
    // A style's own label belongs to the style's company (the seed jacket: every company).
    expect((await refused('companyB', 'POST', '/compliance/labels', jacketBody({ companyId: companyB }), 400)).issues).toEqual([
      { path: 'body/companyId', message: 'Style SEED-JKT-01 belongs to every company: its own label belongs to the same.' },
    ])
    // A shared label is previewed on a style named for it.
    expect(paths((await refused('companyB', 'GET', `/compliance/labels/${own.id}/preview`, undefined, 400)).issues)).toEqual(['querystring/styleId'])
    // Company A does not see company B's label.
    await refused('companyA', 'GET', `/compliance/labels/${own.id}`, undefined, 404)
    expect((await ok('companyA', 'GET', '/compliance/labels?code=LBL-B-SHARED')).templates).toEqual([])
    // A tenant-wide style's revision cannot carry a company-B label.
    expect(paths((await refused('manager', 'PUT', `/product/styles/${jacket}/revisions/${jacketRev1}/label`, { labelTemplateId: own.id, version: 3 }, 400)).issues)).toEqual(['body/labelTemplateId'])
  })

  it('reading needs the certificate view, writing compliance.labels.manage; the floor, partners and links have no label route', async () => {
    await refused('nobody', 'GET', '/compliance/labels', undefined, 403)
    await refused('viewer', 'POST', '/compliance/labels', jacketBody(), 403)
    await refused('viewer', 'POST', `/compliance/labels/${seedLabel}/revisions`, {}, 403)
    for (const session of ['floor', 'partner']) {
      await refused(session, 'GET', '/compliance/labels', undefined, 403)
      await refused(session, 'GET', `/compliance/labels/${seedLabel}/preview`, undefined, 403)
      await refused(session, 'POST', '/compliance/labels', jacketBody(), 403)
    }
  })
})
