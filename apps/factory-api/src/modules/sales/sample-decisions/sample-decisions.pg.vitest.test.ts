import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSamples, type SamplesSeed } from '../../../../../../packages/factory-db/seed/samples'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { storeGeneratedFile } from '../../../platform/files/files'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Sample decisions (B-W2b-252; SAL-312, SAL-314, PRD-070, PRD-158) through the app's real routes, real sign-ins (the system
 * roles synced to their templates: sales, the production manager and the quality inspector) and real APPROVAL links, on a
 * throwaway PostgreSQL 17 database from the migrations (row-level security, the partner role's grants and B-W2b-212's
 * …_changes_samples_w2b_guards are real). Seeds: the samples (SEED-SR-0001 a FIT round of SEED-JKT-01's draft revision 1
 * for P1 with its old fit rows; SEED-SR-0003 a PRE_PRODUCTION round of SEED-JKT-02 for P1 under review with an OPEN request;
 * the leather SEED-LEA-100 and its lot SEED-LOT-LEA-01) and the sizes (SEED-JKT-01 revision 1's draft measurement spec:
 * CHEST_W, BACK_LEN, SLEEVE_LEN for 50, 52, 54; the certificate SEED-CERT-0001 covers SEED-JKT-01). Every name and number is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/sample-decisions`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
const NS = 'w2b252-decisions'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')

let h: Harness
let samples: SamplesSeed
let manager: Browser
let sales: Browser
let quality: Browser
let counter = 0
const key = (label = 'k'): string => `w2b252-${label}-${++counter}-${newId()}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const system = () => callerFor(h.database, systemContext(tenant, newId()))

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refusalOf = (body: Json): string => String(body.error?.issues?.[0]?.path ?? '')

/** A request of the brand's phone: only the link's token, no cookie. */
async function viaLink(token: string, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}
const tokenOf = (url: string): string => decodeURIComponent(/#token=(\S+)/.exec(url)![1]!)
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])

async function photoOf(recordType: string, recordId: string, name: string): Promise<string> {
  return (await storeGeneratedFile(h.files, system(), { companyId: companyA, recordType, recordId, kind: 'PHOTO', originalName: name, contentType: 'image/png', body: PNG })).id
}

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

let jacket1 = ''
let points: Record<string, string> = {}

beforeAll(async () => {
  h = await startHarness('sample_decisions')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  samples = await seedSamples({ db: h.database, namespace: NS })
  await seedSizesDepth({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  manager = await officeBrowser(seedTenant, 'pia.pm@seed-a.example.com', 'production_manager')
  sales = await officeBrowser(seedTenant, 'sandro.sales@seed-a.example.com', 'sales')
  quality = await officeBrowser(seedTenant, 'quirino.qa@seed-a.example.com', 'quality_inspector')
  jacket1 = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-JKT-01'])).id
  points = Object.fromEntries((await admin<{ id: string; code: string }>('SELECT id, code FROM "PointOfMeasure" WHERE "tenantId" = $1', [tenant])).map((row) => [row.code, row.id]))
}, 900_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the fit measured against the spec (PRD-070)', () => {
  it('shows the draft spec of the pinned revision × the round sizes, the old rows, and freezes the spec when a value is first written', async () => {
    const round = samples.roundIds.fit
    const fit = await as(manager, 'GET', `/sales/samples/rounds/${round}/fit`)
    expect(fit).toMatchObject({ spec: { status: 'DRAFT', baseSize: '52' }, sizes: ['52'], editable: true, refusal: null })
    expect(fit.points.filter((point: Json) => point.inSpec).map((point: Json) => point.code)).toEqual(['CHEST_W', 'BACK_LEN', 'SLEEVE_LEN'])
    // The seed's sleeve row (point code SLEEVE_L, before points had ids) is kept as a row of its own; back length keeps its frozen 72.
    expect(fit.points.find((point: Json) => point.code === 'SLEEVE_L')).toMatchObject({ inSpec: false, pointOfMeasureId: null })
    const back = fit.points.find((point: Json) => point.code === 'BACK_LEN').cells[0]
    expect(back).toMatchObject({ size: '52', spec: { nominal: '73' }, measurement: { nominal: '72', measured: '72.4', difference: '+0.4', pass: true } })
    const chest = fit.points.find((point: Json) => point.code === 'CHEST_W').cells[0].measurement
    expect(chest).toMatchObject({ nominal: '56', measured: null })

    const saved = await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, {
      cells: [
        { pointOfMeasureId: points.CHEST_W, size: '52', measured: '56.5', version: chest.version },
        { pointOfMeasureId: points.SLEEVE_LEN, size: '52', measured: '66', note: 'Made-up: long at the cuff.' },
      ],
    })
    const sleeve = saved.points.find((point: Json) => point.code === 'SLEEVE_LEN').cells[0].measurement
    expect(sleeve).toMatchObject({ nominal: '64', toleranceMinus: '1', tolerancePlus: '1', measured: '66', difference: '+2', pass: false, note: 'Made-up: long at the cuff.' })
    expect(saved.points.find((point: Json) => point.code === 'CHEST_W').cells[0].measurement).toMatchObject({ nominal: '56', measured: '56.5', pass: true })
    expect(saved.outside.map((row: Json) => row.words)).toContain('SLEEVE_LEN 52: 66 cm, 2 over 64 ± 1')
    const stored = await one('SELECT "pointOfMeasureId", "pomName", nominal::text, uom::text, pass FROM "SampleMeasurement" WHERE "roundId" = $1 AND "pomCode" = $2', [round, 'SLEEVE_LEN'])
    expect(stored).toEqual({ pointOfMeasureId: points.SLEEVE_LEN, pomName: 'Sleeve length', nominal: '64.00', uom: 'CM', pass: false })
    expect((await eventsOf(round)).map((event) => event.type)).toContain('sample_round.fit_changed')

    // The value changed again keeps the nominal frozen when it was first written; cleared with no note, the cell goes.
    const again = await as(quality, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.SLEEVE_LEN, size: '52', measured: '64.8', version: sleeve.version }] })
    const sleeve2 = again.points.find((point: Json) => point.code === 'SLEEVE_LEN').cells[0].measurement
    expect(sleeve2).toMatchObject({ measured: '64.8', pass: true, note: 'Made-up: long at the cuff.' })
    const cleared = await as(quality, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.SLEEVE_LEN, size: '52', measured: null, note: null, version: sleeve2.version }] })
    expect(cleared.points.find((point: Json) => point.code === 'SLEEVE_LEN').cells[0].measurement).toBeNull()
  })

  it('REFUSED in words: a size the round does not make, a point not in the spec, a value written meanwhile, 0, a role that only reads', async () => {
    const round = samples.roundIds.fit
    expect(refusalOf(await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.CHEST_W, size: '54', measured: '58' }] }, 409))).toBe('refusal/SIZE_NOT_IN_ROUND')
    const notInSpec = await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.WAIST_W, size: '52', measured: '40' }] }, 409)
    expect(notInSpec.error).toMatchObject({ message: 'The measurement spec of revision 1 has no value for WAIST_W in size 52: add it to the spec first.' })
    await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.CHEST_W, size: '52', measured: '57' }] }, 409)
    expect(refusalOf(await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.BACK_LEN, size: '52', measured: '0' }] }, 400))).toBe('body/cells/0/measured')
    await as(sales, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.BACK_LEN, size: '52', measured: '72' }] }, 403)
  })

  it('keeps fit comments per point or body area: written, resolved, removed; a point outside the spec is refused', async () => {
    const round = samples.roundIds.fit
    const { comment } = await as(quality, 'POST', `/sales/samples/rounds/${round}/comments`, { pointOfMeasureId: points.SLEEVE_LEN, text: 'Made-up: shorten 1 cm.' }, 201)
    expect(comment).toMatchObject({ pomCode: 'SLEEVE_LEN', resolved: false, createdBy: { name: 'quirino qa' }, photos: [] })
    const photo = await photoOf('SampleComment', comment.id, 'Made-up cuff.png')
    const resolved = (await as(manager, 'PATCH', `/sales/samples/comments/${comment.id}`, { version: comment.version, resolved: true })).comment
    expect(resolved).toMatchObject({ resolved: true, resolvedBy: { name: 'pia pm' }, photos: [{ id: photo }] })
    const area = (await as(manager, 'POST', `/sales/samples/rounds/${round}/comments`, { bodyArea: 'left shoulder', text: 'Made-up: pulls.' }, 201)).comment
    expect(await as(manager, 'DELETE', `/sales/samples/comments/${area.id}?version=${area.version}`)).toEqual({ id: area.id, removed: true })
    expect(refusalOf(await as(manager, 'POST', `/sales/samples/rounds/${round}/comments`, { pointOfMeasureId: points.WAIST_W, text: 'x' }, 409))).toBe('refusal/POINT_NOT_IN_SPEC')
    const fit = await as(sales, 'GET', `/sales/samples/rounds/${round}/fit`)
    expect(fit.editable).toBe(false)
    expect(fit.comments.map((row: Json) => row.id)).toContain(comment.id)
  })
})

describe('the decision recorded in the office (SAL-312)', () => {
  it('decides a made round once on its pinned revision, then the next round follows the rejection; the fit is closed', async () => {
    const round = samples.roundIds.fit
    let view = await as(sales, 'GET', `/sales/samples/rounds/${round}/approval`)
    expect(view.actions.decide).toMatchObject({ allowed: false, refusal: { code: 'NOTHING_MADE' }, needs: null })
    expect(view.actions.nextRound.refusal.code).toBe('NOT_REJECTED')
    expect(refusalOf(await as(sales, 'POST', `/sales/samples/rounds/${round}/decision`, { version: view.round.version, decision: 'APPROVED' }, 409))).toBe('refusal/NOTHING_MADE')
    // B-W2b-246's move: under review.
    await as(manager, 'POST', `/sales/samples/rounds/${round}/move`, { version: view.round.version, to: 'UNDER_REVIEW' })
    view = await as(sales, 'GET', `/sales/samples/rounds/${round}/approval`)
    expect(view.actions.decide.allowed).toBe(true)
    expect(refusalOf(await as(sales, 'POST', `/sales/samples/rounds/${round}/decision`, { version: view.round.version, decision: 'REJECTED' }, 400))).toBe('body/comments')
    await as(quality, 'POST', `/sales/samples/rounds/${round}/decision`, { version: view.round.version, decision: 'APPROVED' }, 403)
    const decided = await as(sales, 'POST', `/sales/samples/rounds/${round}/decision`, { version: view.round.version, decision: 'REJECTED', comments: 'Made-up: sleeves too long, collar loose.' })
    expect(decided).toMatchObject({ round: { stage: 'DECIDED', revision: { revision: 1 } }, decision: { decision: 'REJECTED', via: 'OFFICE', by: { name: 'sandro sales' }, signedAs: null, revision: 1, comments: 'Made-up: sleeves too long, collar loose.' } })
    expect(decided.actions.nextRound.allowed).toBe(true)
    const event = (await eventsOf(round)).find((row) => row.type === 'sample_round.decided')!
    expect(event.payload).toMatchObject({ decision: 'REJECTED', via: 'OFFICE', kind: 'FIT', partyId: P1 })
    expect(refusalOf(await as(sales, 'POST', `/sales/samples/rounds/${round}/decision`, { version: decided.round.version, decision: 'APPROVED' }, 409))).toBe('refusal/ROUND_CLOSED')
    expect(refusalOf(await as(manager, 'PUT', `/sales/samples/rounds/${round}/fit`, { cells: [{ pointOfMeasureId: points.BACK_LEN, size: '52', measured: '72' }] }, 409))).toBe('refusal/FIT_CLOSED')
    // "Make round 2 with the reason".
    const next = (await as(manager, 'POST', `/sales/samples/rounds/${round}/next-round`, { dueDate: '2026-12-15' }, 201)).round
    expect(next).toMatchObject({ kind: 'FIT', roundNo: 2, label: 'Fit · round 2', party: { id: P1 }, stage: 'REQUESTED', dueDate: '2026-12-15', instructions: expect.stringContaining('rejected: Made-up: sleeves too long') })
    expect(next.cells.map((cell: Json) => `${cell.size}×${cell.quantity}`)).toEqual(['52×1'])
  })
})

describe('the brand decides by link (SAL-312)', () => {
  it('the office waits while the brand is asked; asked again with a photo, the answer by link becomes the decision', async () => {
    const round = samples.roundIds.pp
    const view = await as(sales, 'GET', `/sales/samples/rounds/${round}/approval`)
    expect(view.actions.decide.refusal.code).toBe('BRAND_ASKED')
    expect(refusalOf(await as(sales, 'POST', `/sales/samples/rounds/${round}/decision`, { version: view.round.version, decision: 'APPROVED' }, 409))).toBe('refusal/BRAND_ASKED')
    // The seeded request is withdrawn through the approvals engine (the round's adapter), then the brand asked again.
    const seeded = (await as(sales, 'GET', `/approvals-out/${samples.approvalRequestId}`)).request
    expect(seeded.record).toMatchObject({ type: 'SampleRound', words: { en: expect.stringMatching(/^SEED-SR-\d+ · Pre-production · round 1$/), it: expect.stringContaining('Pre-produzione · giro 1') } })
    await as(sales, 'POST', `/approvals-out/${samples.approvalRequestId}/withdraw`, { version: seeded.version, reason: 'Made-up: new photos.' })
    // The quality inspector may ask partners (partners.approvals.ask) but does not decide samples.
    expect((await as(quality, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SampleRound', recordId: round, question: 'x', send: false }, 403)).error.message).toBe('Asking a partner to approve this record needs sales.samples.decide.')
    const photo = await photoOf('SampleRound', round, 'Made-up pre-production front.png')
    const asked = await as(sales, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SampleRound', recordId: round, question: 'Approve the pre-production sample.', fileIds: [photo], send: false }, 201)
    expect(asked.request).toMatchObject({ kind: 'SAMPLE', status: 'OPEN', party: { id: P1 } })
    expect(await one('SELECT "approvalRequestId" FROM "SampleRound" WHERE id = $1', [round])).toEqual({ approvalRequestId: asked.request.id })
    expect((await eventsOf(round)).map((event) => event.type)).toContain('sample_round.asked')
    await as(sales, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SampleRound', recordId: round, question: 'Again.', fileIds: [photo], send: false }, 409)
    const token = tokenOf(asked.url)
    const page = await viaLink(token, 'GET', '/link/approval?language=en')
    expect(page.content.facts.map((fact: Json) => fact.label)).toEqual(['Sample', 'Style', 'Revision', 'Sizes'])
    expect(page.may).toMatchObject({ answer: true, withChanges: true })
    const answered = await viaLink(token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED_WITH_CHANGES', answer: 'Made-up: darker thread on the collar.', typedName: 'Anna Demo' })
    expect(answered.request.decided).toMatch(/^Approved with changes — signed by Anna Demo/)
    const row = await one('SELECT stage::text, decision::text, "decisionComments", "decidedVia"::text AS via, "decidedById", "decidedAt" = (SELECT "answeredAt" FROM "ApprovalRequest" WHERE id = $2) AS "atAnswer" FROM "SampleRound" WHERE id = $1', [round, asked.request.id])
    expect(row).toEqual({ stage: 'DECIDED', decision: 'APPROVED_WITH_COMMENTS', decisionComments: 'Made-up: darker thread on the collar.', via: 'LINK', decidedById: null, atAnswer: true })
    const after = await as(sales, 'GET', `/sales/samples/rounds/${round}/approval`)
    expect(after.decision).toMatchObject({ decision: 'APPROVED_WITH_COMMENTS', via: 'LINK', by: null, signedAs: 'Anna Demo', revision: 1 })
    expect(after.request).toMatchObject({ id: asked.request.id, status: 'APPROVED_WITH_CHANGES' })
    expect((await eventsOf(round)).find((event) => event.type === 'sample_round.decided')!.payload).toMatchObject({ via: 'LINK', decision: 'APPROVED_WITH_COMMENTS', approvalRequestId: asked.request.id })
    const message = await one(`SELECT m.direction::text, m."authorName" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SampleRound' AND t."recordId" = $1 ORDER BY m."createdAt" DESC LIMIT 1`, [round])
    expect(message).toEqual({ direction: 'INBOUND', authorName: 'Anna Demo' })
  })
})

describe('leather and colour swatches (SAL-314)', () => {
  it('recorded, sent once, asked with its own kind, the brand refuses by link; a sent swatch stays', async () => {
    const leather = (await one('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-LEA-100'])).id
    const lining = (await one('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-LIN-200'])).id
    const lot = (await one('SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-LOT-LEA-01'])).id
    const round = (await as(manager, 'GET', `/sales/samples/rounds?styleId=${jacket1}&kind=FIT&stage=REQUESTED`)).rows[0].id
    expect(refusalOf(await as(sales, 'POST', '/sales/samples/swatches', { styleId: jacket1, roundId: round, kind: 'LEATHER', itemId: lining, lotId: lot }, 409))).toBe('refusal/LEATHER_ONLY')
    expect(refusalOf(await as(sales, 'POST', '/sales/samples/swatches', { styleId: jacket1, roundId: round, kind: 'LEATHER', itemId: leather }, 400))).toBe('body/itemColourId')
    const { swatch } = await as(sales, 'POST', '/sales/samples/swatches', { styleId: jacket1, roundId: round, kind: 'LEATHER', itemId: leather, lotId: lot, note: 'Made-up: lot 1, a touch darker.' }, 201)
    expect(swatch).toMatchObject({ party: { id: P1 }, kind: 'LEATHER', lot: { code: 'SEED-LOT-LEA-01' }, sentAt: null, actions: { decide: { allowed: false, refusal: { code: 'SWATCH_NOT_SENT' } }, remove: { allowed: true } } })
    expect(refusalOf(await as(sales, 'POST', `/sales/samples/swatches/${swatch.id}/decision`, { version: swatch.version, decision: 'APPROVED' }, 409))).toBe('refusal/SWATCH_NOT_SENT')
    const sent = (await as(sales, 'PATCH', `/sales/samples/swatches/${swatch.id}`, { version: swatch.version, sentAt: new Date(h.clock.now().getTime() - 3_600_000).toISOString() })).swatch
    expect(sent.actions.remove.refusal.code).toBe('SWATCH_SENT')
    expect(refusalOf(await as(sales, 'DELETE', `/sales/samples/swatches/${swatch.id}?version=${sent.version}`, undefined, 409))).toBe('refusal/SWATCH_SENT')
    const photo = await photoOf('SampleSwatch', swatch.id, 'Made-up swatch.png')
    await as(sales, 'POST', '/approvals-out', { kind: 'COLOUR', recordType: 'SampleSwatch', recordId: swatch.id, question: 'x', fileIds: [photo], send: false }, 409)
    const asked = await as(sales, 'POST', '/approvals-out', { kind: 'LEATHER', recordType: 'SampleSwatch', recordId: swatch.id, question: 'Approve the leather lot.', fileIds: [photo], send: false }, 201)
    const token = tokenOf(asked.url)
    await viaLink(token, 'POST', '/link/approval/refuse?language=en', { answer: 'Made-up: too dark for us.', typedName: 'Anna Demo' })
    const list = await as(sales, 'GET', `/sales/samples/swatches?roundId=${round}`)
    expect(list.rows.find((row: Json) => row.id === swatch.id)).toMatchObject({ decision: 'REJECTED', decidedVia: 'LINK', decidedBy: null, signedAs: 'Anna Demo', decisionComments: 'Made-up: too dark for us.', waiting: null })
    expect((await eventsOf(swatch.id)).map((event) => event.payload.change)).toEqual(['ADDED', 'SENT', 'ASKED', 'DECIDED'])
    // A swatch of the style decided in the office.
    const colour = (await one('SELECT id FROM "ItemColour" WHERE "itemId" = $1 AND code = $2', [leather, 'RED'])).id
    const red = (await as(sales, 'POST', '/sales/samples/swatches', { styleId: jacket1, partyId: P1, kind: 'COLOUR', itemId: leather, itemColourId: colour, sentAt: new Date(h.clock.now().getTime() - 60_000).toISOString() }, 201)).swatch
    const decided = (await as(sales, 'POST', `/sales/samples/swatches/${red.id}/decision`, { version: red.version, decision: 'APPROVED' })).swatch
    expect(decided).toMatchObject({ decision: 'APPROVED', decidedVia: 'OFFICE', decidedBy: { name: 'sandro sales' }, roundId: null })
  })
})

describe('a CE test sample (PRD-158)', () => {
  it('records the notified body\'s result and the certificate that covers the style, each once; whoever keeps certificates', async () => {
    const made = (await as(manager, 'POST', '/sales/samples/rounds', { styleId: jacket1, companyId: companyA, kind: 'CERTIFICATION', cells: [{ size: '52', quantity: 3 }], testZones: 'Made-up: shoulders and elbows, sizes 52.' }, 201)).round
    const view = await as(quality, 'GET', `/sales/samples/rounds/${made.id}/approval`)
    expect(view.certification).toMatchObject({ testZones: 'Made-up: shoulders and elbows, sizes 52.', testResult: null, certificate: null, sentTo: [] })
    expect(view.actions.testResult.allowed).toBe(true)
    await as(sales, 'POST', `/sales/samples/rounds/${made.id}/test-result`, { version: made.version, testResult: 'PASSED' }, 403)
    const passed = await as(quality, 'POST', `/sales/samples/rounds/${made.id}/test-result`, { version: made.version, testResult: 'PASSED' })
    expect(passed.certification.testResult).toBe('PASSED')
    const protector = (await one('SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = $2', [tenant, 'SEED-CERT-0002'])).id
    const jacketCert = (await one('SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = $2', [tenant, 'SEED-CERT-0001'])).id
    expect(refusalOf(await as(quality, 'POST', `/sales/samples/rounds/${made.id}/test-result`, { version: passed.round.version, certificateId: protector }, 409))).toBe('refusal/CERTIFICATE_NOT_COVERING')
    const linked = await as(quality, 'POST', `/sales/samples/rounds/${made.id}/test-result`, { version: passed.round.version, certificateId: jacketCert })
    expect(linked.certification.certificate).toMatchObject({ id: jacketCert, number: 'SEED-CERT-0001' })
    expect(refusalOf(await as(quality, 'POST', `/sales/samples/rounds/${made.id}/test-result`, { version: linked.round.version, testResult: 'FAILED' }, 409))).toBe('refusal/RESULT_ONCE')
    expect(refusalOf(await as(quality, 'POST', `/sales/samples/rounds/${samples.roundIds.proto}/test-result`, { version: 1, testResult: 'PASSED' }, 409))).toBe('refusal/CERTIFICATION_ONLY')
    expect((await eventsOf(made.id)).filter((event) => event.type === 'sample_round.test_recorded')).toHaveLength(2)
  })
})

describe('a swatch is sent on its Rome day, not its UTC day (B-W2b-F35)', () => {
  it('a swatch sent at 23:30 UTC on 12 November (00:30 in Rome) was sent on 13 November, as the brand’s approval page says', async () => {
    const leather = (await one('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-LEA-100'])).id
    const lot = (await one('SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-LOT-LEA-01'])).id
    // SEED-JKT-01 is every company's: a swatch is asked on a round of it.
    const round = (await as(manager, 'GET', `/sales/samples/rounds?styleId=${jacket1}&kind=FIT&stage=REQUESTED`)).rows[0].id
    const { swatch } = await as(sales, 'POST', '/sales/samples/swatches', { styleId: jacket1, roundId: round, kind: 'LEATHER', itemId: leather, lotId: lot, sentAt: '2026-11-12T23:30:00.000Z' }, 201)
    expect(swatch.sentAt).toBe('2026-11-12T23:30:00.000Z')
    const photo = await photoOf('SampleSwatch', swatch.id, 'Made-up swatch F35.png')
    const asked = await as(sales, 'POST', '/approvals-out', { kind: 'LEATHER', recordType: 'SampleSwatch', recordId: swatch.id, question: 'Approve the leather lot (made up).', fileIds: [photo], send: false }, 201)
    const page = await viaLink(tokenOf(asked.url), 'GET', '/link/approval?language=en')
    expect(page.content.facts).toContainEqual({ label: 'Sent on', value: '2026-11-13' })
  })
})
