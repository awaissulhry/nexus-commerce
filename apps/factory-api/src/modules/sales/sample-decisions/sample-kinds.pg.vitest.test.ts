import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { storeGeneratedFile } from '../../../platform/files/files'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { passGatesOfRound } from '../../planning/milestones/follow'
import { urgencyWorld, type UrgencyWorld } from '../../production/testing/urgency-world'

/**
 * B-PR-29 — the new approvals (production plan §3 "Brand alone: approve … samples (PP, size set, TOP), colour, leather, fabric,
 * trims"; §C S-LIM-approver; 08-backend §4.4; review fix R-25; Appendix C "TOP gates nothing"; the Owner rule 2026-11-16: "One
 * brand must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it
 * all. And manage it all as well.") on the local stack through the real app (the production two-brand world of
 * ../../production/testing/urgency-world.ts: brand A = the seeds' P1, brand B = the threads' second brand, both portals on):
 *
 *   kinds      size set and top-of-production rounds asked as SAMPLE; fabric and trim swatches asked as FABRIC and TRIM, each
 *              of a material of its kind (a trim of a protector refused in words); a fabric asked as a colour refused
 *   gate       a SIZE_SET gate names A's size set round and passes by it (`sample_round.decided` → the gate handler); a
 *              top-of-production round names no gate (it gates nothing)
 *   approver   A names Anna its production approver: only Anna answers A's PP, size set and fabric approvals (Bruno, a
 *              Production person with the right to approve, reads "Waiting for anna.approver" and gets 403; the link is held);
 *              a top-of-production round also by A's Quality person; a fit round (a design kind) by anyone with the right;
 *              Anna made inactive → nobody named, today's rule again
 *   PW-P05     brand B's portal lists only B's requests; A's request id → 404 (read and answer); office.p2 (limited to B) gets
 *              404 on A's rounds, swatches and requests and lists none of A's swatches
 *
 * Every name, address and number is made up (example.com). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/sample-decisions`.
 */

let world: UrgencyWorld
const NS = 'pr3d-sample-kinds'
type Json = Record<string, any>
type Person = { readonly id: string; readonly browser: Awaited<ReturnType<UrgencyWorld['portalPerson']>>['browser'] }
let owner: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let salesB: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let anna: Person
let bruno: Person
let quinta: Person
let beatrice: Person
let blk = ''
let lining = { itemId: '', colourId: '' }
let protector = ''
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const ANNA = 'anna.approver'

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(world.ids.tenantId, newId()))
const pathOf = (body: Json): string => String(body.error?.issues?.at(-1)?.path ?? '')

async function as(browser: Person['browser'], method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': `pr3d-${newId()}` } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
async function read(session: 'office.all' | 'office.p1' | 'office.p2', method: 'GET' | 'POST', url: string, status = 200, body?: unknown): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `pr3d-${newId()}` } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(response.statusCode, `${session} ${url}: ${response.body.slice(0, 500)}`).toBe(status)
  return response.json() as Json
}
/** A request of the brand's phone: only the link's token, no cookie. */
async function viaLink(token: string, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await world.h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': `pr3d-link-${newId()}` } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}
const tokenOf = (url: string): string => decodeURIComponent(/#token=(\S+)/.exec(url)![1]!)

async function photoOf(recordType: string, recordId: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType, recordId, kind: 'PHOTO', originalName: `Made-up ${recordType}.png`, contentType: 'image/png', body: PNG })).id
}

/** A round of the world's own jacket for a customer, moved to UNDER_REVIEW (a made sample, ready to be asked). */
async function roundOf(kind: string, partyId: string): Promise<Json> {
  const { round } = await as(owner.browser, 'POST', '/sales/samples/rounds', { styleId: world.w.styleId, companyId: world.w.companyId, kind, partyId, cells: [{ colourwayId: blk, size: '50', quantity: 1 }], instructions: `Made-up ${kind} round.` }, 201)
  return (await as(owner.browser, 'POST', `/sales/samples/rounds/${round.id}/move`, { version: round.version, to: 'UNDER_REVIEW' })).round
}

/** The office asks the customer (the record's photo with it); the request and its link (not mailed). */
async function ask(kind: string, recordType: string, recordId: string): Promise<{ id: string; token: string }> {
  const made = await as(owner.browser, 'POST', '/approvals-out', { kind, recordType, recordId, question: `Made-up: please approve this ${kind.toLowerCase()}.`, fileIds: [await photoOf(recordType, recordId)], send: false }, 201)
  expect(made.request).toMatchObject({ kind, status: 'OPEN', record: { type: recordType, id: recordId } })
  return { id: made.request.id, token: tokenOf(made.url) }
}

const answerBody = (typedName: string) => ({ decision: 'APPROVED', typedName, version: 1 })

beforeAll(async () => {
  world = await urgencyWorld('pr3d_sample_kinds', NS)
  owner = await world.officePerson('olga.owner@pr3d-office.example.com', 'owner')
  salesB = await world.officePerson('sara.sales@pr3d-office.example.com', 'sales', [world.ids.b])
  anna = await world.portalPerson(`${ANNA}@brand-alpha.example.com`, world.ids.a, ['customer-production', 'partner-approve'])
  bruno = await world.portalPerson('bruno.production@brand-alpha.example.com', world.ids.a, ['customer-production', 'partner-approve'])
  quinta = await world.portalPerson('quinta.quality@brand-alpha.example.com', world.ids.a, ['customer-quality', 'partner-approve'])
  beatrice = await world.portalPerson('beatrice.buyer@brand-beta.example.com', world.ids.b, ['customer-buyer', 'partner-approve'])
  blk = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [world.w.a.salesOrderLineId])).colourwayId
  const item = await one<{ id: string }>('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [world.ids.tenantId, 'SEED-LIN-200'])
  lining = { itemId: item.id, colourId: (await one<{ id: string }>('SELECT id FROM "ItemColour" WHERE "itemId" = $1 ORDER BY code LIMIT 1', [item.id])).id }
  protector = (await one<{ id: string }>('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [world.ids.tenantId, 'SEED-PRO-300'])).id
  // Brand A names Anna its production approver (the limits card's field, B-PR-12/14).
  await admin('UPDATE "PortalSettings" SET "productionApproverId" = $1, version = version + 1 WHERE id = $2', [anna.id, world.ids.a])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-29 the new kinds: size set and TOP rounds, fabric and trim swatches', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a size set and a top-of-production round are asked as SAMPLE; their round words name the kind', async () => {
    for (const kind of ['SIZE_SET', 'TOP_OF_PRODUCTION']) {
      const round = await roundOf(kind, world.ids.a)
      expect(round).toMatchObject({ kind, stage: 'UNDER_REVIEW', party: { id: world.ids.a } })
      const request = await ask('SAMPLE', 'SampleRound', round.id)
      const page = await as(anna.browser, 'GET', `/portal/approvals/${request.id}`)
      expect(page.request.words.en).toContain(kind === 'SIZE_SET' ? 'Size set' : 'Top of production')
      expect(page.request.words.it).toContain(kind === 'SIZE_SET' ? 'Set di taglie' : 'Primi capi di produzione')
    }
  })

  it('a fabric swatch of a lining is asked as FABRIC (a colour ask refused in words); a trim of a protector is refused before the database', async () => {
    const sentAt = new Date(Date.now() - 3_600_000).toISOString()
    // fix-pr-9: a swatch of A's round (the world's jacket is shared by every company: a swatch of no round is never asked outside,
    // as override.pg since fix-pr-5).
    const round = await roundOf('SIZE_SET', world.ids.a)
    const { swatch } = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, roundId: round.id, partyId: world.ids.a, kind: 'FABRIC', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 201)
    expect(swatch).toMatchObject({ kind: 'FABRIC', party: { id: world.ids.a }, item: { kind: 'LINING' }, actions: { ask: { allowed: true } } })
    const asColour = await as(owner.browser, 'POST', '/approvals-out', { kind: 'COLOUR', recordType: 'SampleSwatch', recordId: swatch.id, question: 'Made-up.', fileIds: [await photoOf('SampleSwatch', swatch.id)], send: false }, 409)
    expect(asColour.error.message).toBe('This is a fabric swatch: ask with Fabric.')
    const request = await ask('FABRIC', 'SampleSwatch', swatch.id)
    const page = await as(anna.browser, 'GET', `/portal/approvals/${request.id}`)
    expect(page.request).toMatchObject({ kind: 'FABRIC' })
    expect(page.request.words.en).toContain('fabric SEED-LIN-200')
    expect(page.request.words.it).toContain('tessuto SEED-LIN-200')

    // The kind is refused before what was sent is read (a protector is no trim, whatever its colour or lot).
    const trim = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, partyId: world.ids.a, kind: 'TRIM', itemId: protector, sentAt }, 409)
    expect(pathOf(trim)).toBe('refusal/MATERIAL_KIND')
    expect(trim.error.message).toBe('SEED-PRO-300 is protector: a trim swatch is of a trim, hardware, thread or label (or make it a colour swatch).')
    const leatherOfLining = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, partyId: world.ids.a, kind: 'LEATHER', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 409)
    expect(pathOf(leatherOfLining)).toBe('refusal/LEATHER_ONLY')
    const trimOfLining = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, partyId: world.ids.a, kind: 'TRIM', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 409)
    expect(trimOfLining.error.message).toBe('SEED-LIN-200 is lining: a trim swatch is of a trim, hardware, thread or label (or make it a colour swatch).')
    expect(pathOf(trimOfLining)).toBe('refusal/MATERIAL_KIND')
  })
})

describe('B-PR-29 the size set gate passes by its round; TOP gates nothing', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("a SIZE_SET gate names A's size set round, a PP gate refuses it, a TOP round names no gate; the approver's yes passes the gate", async () => {
    const sizeSet = await roundOf('SIZE_SET', world.ids.a)
    const top = await roundOf('TOP_OF_PRODUCTION', world.ids.a)
    const order = world.w.a.salesOrderId
    const pp = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order, kind: 'PP_SAMPLE', sampleRoundId: sizeSet.id }, 409)
    expect(pathOf(pp)).toBe('refusal/ROUND_KIND')
    const topGate = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order, kind: 'SAMPLE_APPROVED', sampleRoundId: top.id }, 409)
    expect(pathOf(topGate)).toBe('refusal/ROUND_KIND')
    expect(topGate.error.message).toContain('gates nothing')
    const { gate } = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order, kind: 'SIZE_SET', sampleRoundId: sizeSet.id }, 201)
    expect(gate).toMatchObject({ kind: 'SIZE_SET', state: 'WAITING', sampleRound: { id: sizeSet.id, kind: 'SIZE_SET' } })

    const request = await ask('SAMPLE', 'SampleRound', sizeSet.id)
    await as(anna.browser, 'POST', `/portal/approvals/${request.id}/answer`, answerBody('Anna Approver'))
    expect(await one('SELECT stage::text, decision::text, "decidedVia"::text AS via, "decidedById"::text AS "by" FROM "SampleRound" WHERE id = $1', [sizeSet.id])).toEqual({ stage: 'DECIDED', decision: 'APPROVED', via: 'PORTAL', by: anna.id })
    // The worker's handler on `sample_round.decided` (follow.ts), as the outbox runs it.
    expect(await passGatesOfRound(system(), sizeSet.id, 'APPROVED', { key: `pr3d-${newId()}` })).toEqual([gate.id])
    const passed = await one('SELECT "passedAt" IS NOT NULL AS passed, "passedById"::text AS "by" FROM "OrderGate" WHERE id = $1', [gate.id])
    expect(passed.passed).toBe(true)
    // fix-pr-9: on the world's one clock the gate's ADDED and PASSED can share an instant: the later one by its id (ids are in order).
    const change = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'order_gate.changed' AND subject = $1 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [gate.id])
    expect(change[0]!.payload).toMatchObject({ kind: 'SIZE_SET', change: 'PASSED', via: 'SAMPLE', partyId: world.ids.a })
  })
})

describe("B-PR-29 the customer's named approver answers its production approvals (R-25)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a PP round: Bruno reads "Waiting for anna.approver" and is refused (403); the link is held (409); Anna answers', async () => {
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const request = await ask('SAMPLE', 'SampleRound', pp.id)
    const held = `Waiting for ${ANNA}: ${ANNA} answers your production approvals.`
    const page = await as(bruno.browser, 'GET', `/portal/approvals/${request.id}`)
    expect(page.may).toEqual({ answer: false, withChanges: false, held })
    const list = await as(bruno.browser, 'GET', '/portal/approvals?state=OPEN')
    expect((list.items as Json[]).find((item) => item.id === request.id)).toMatchObject({ waitingFor: ANNA })
    const refused = await as(bruno.browser, 'POST', `/portal/approvals/${request.id}/answer`, answerBody('Bruno Production'), 403)
    expect(refused.error.message).toBe(held)
    const link = await viaLink(request.token, 'GET', '/link/approval?language=en')
    expect(link.may).toEqual({ answer: false, withChanges: false, held: `Waiting for ${ANNA}: ${ANNA} answers it in your portal.` })
    await viaLink(request.token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED', typedName: 'Someone With The Link' }, 409)
    expect(await one('SELECT status::text FROM "ApprovalRequest" WHERE id = $1', [request.id])).toEqual({ status: 'OPEN' })

    const mine = await as(anna.browser, 'GET', `/portal/approvals/${request.id}`)
    expect(mine.may).toMatchObject({ answer: true, held: null })
    expect(((await as(anna.browser, 'GET', '/portal/approvals?state=OPEN')).items as Json[]).find((item) => item.id === request.id)).toMatchObject({ waitingFor: null })
    await as(anna.browser, 'POST', `/portal/approvals/${request.id}/answer`, answerBody('Anna Approver'))
    expect(await one('SELECT status::text, "answeredByUserId"::text AS "by" FROM "ApprovalRequest" WHERE id = $1', [request.id])).toEqual({ status: 'APPROVED', by: anna.id })
  })

  it('a fabric swatch is the approver\'s too; a top-of-production round is the approver\'s or Quality\'s; a fit round anyone\'s with the right', async () => {
    const sentAt = new Date(Date.now() - 3_600_000).toISOString()
    const round = await roundOf('SIZE_SET', world.ids.a) // fix-pr-9: a swatch of A's round (above)
    const { swatch } = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, roundId: round.id, partyId: world.ids.a, kind: 'FABRIC', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 201)
    const fabric = await ask('FABRIC', 'SampleSwatch', swatch.id)
    await as(bruno.browser, 'POST', `/portal/approvals/${fabric.id}/answer`, answerBody('Bruno Production'), 403)
    await as(quinta.browser, 'POST', `/portal/approvals/${fabric.id}/answer`, answerBody('Quinta Quality'), 403)
    await as(anna.browser, 'POST', `/portal/approvals/${fabric.id}/answer`, answerBody('Anna Approver'))
    expect(await one('SELECT decision::text, "decidedVia"::text AS via FROM "SampleSwatch" WHERE id = $1', [swatch.id])).toEqual({ decision: 'APPROVED', via: 'PORTAL' })

    const top = await roundOf('TOP_OF_PRODUCTION', world.ids.a)
    const topAsk = await ask('SAMPLE', 'SampleRound', top.id)
    const brunoReads = await as(bruno.browser, 'GET', `/portal/approvals/${topAsk.id}`)
    expect(brunoReads.may.held).toBe(`Waiting for ${ANNA}: ${ANNA} or your quality team answers this top-of-production sample.`)
    await as(bruno.browser, 'POST', `/portal/approvals/${topAsk.id}/answer`, answerBody('Bruno Production'), 403)
    expect((await as(quinta.browser, 'GET', `/portal/approvals/${topAsk.id}`)).may).toMatchObject({ answer: true, held: null })
    await as(quinta.browser, 'POST', `/portal/approvals/${topAsk.id}/answer`, answerBody('Quinta Quality'))
    expect(await one('SELECT stage::text, "decidedById"::text AS "by" FROM "SampleRound" WHERE id = $1', [top.id])).toEqual({ stage: 'DECIDED', by: quinta.id })

    // Designers keep the design kinds: a fit round is answered by anyone of the customer with the right to approve.
    const fit = await roundOf('FIT', world.ids.a)
    const fitAsk = await ask('SAMPLE', 'SampleRound', fit.id)
    expect(((await as(bruno.browser, 'GET', '/portal/approvals?state=OPEN')).items as Json[]).find((item) => item.id === fitAsk.id)).toMatchObject({ waitingFor: null })
    await as(bruno.browser, 'POST', `/portal/approvals/${fitAsk.id}/answer`, answerBody('Bruno Production'))
  })

  it('the approver made inactive counts as nobody named: the customer\'s people with the right answer again', async () => {
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const request = await ask('SAMPLE', 'SampleRound', pp.id)
    await admin(`UPDATE "User" SET status = 'SUSPENDED' WHERE id = $1`, [anna.id])
    try {
      expect((await as(bruno.browser, 'GET', `/portal/approvals/${request.id}`)).may).toMatchObject({ answer: true, held: null })
      await as(bruno.browser, 'POST', `/portal/approvals/${request.id}/answer`, answerBody('Bruno Production'))
    } finally {
      await admin(`UPDATE "User" SET status = 'ACTIVE' WHERE id = $1`, [anna.id])
    }
  })
})

describe('B-PR-29 PW-P05: Waiting for you and answers stay inside one customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("brand B lists only B's requests and gets 404 on A's; office.p2 gets 404 on A's rounds, swatches and requests", async () => {
    const roundA = await roundOf('SIZE_SET', world.ids.a)
    const askA = await ask('SAMPLE', 'SampleRound', roundA.id)
    const sentAt = new Date(Date.now() - 3_600_000).toISOString()
    const { swatch: swatchA } = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, partyId: world.ids.a, kind: 'FABRIC', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 201)
    const roundB = await roundOf('SIZE_SET', world.ids.b)
    const askB = await ask('SAMPLE', 'SampleRound', roundB.id)

    // The customer's side: B lists only B, A's request id is not found (read or answer), and nothing of A is named.
    const listed = await as(beatrice.browser, 'GET', '/portal/approvals?state=OPEN')
    const ids = (listed.items as Json[]).map((item) => item.id)
    expect(ids).toContain(askB.id)
    expect(ids).not.toContain(askA.id)
    expect(JSON.stringify(listed)).not.toContain(roundA.number)
    await as(beatrice.browser, 'GET', `/portal/approvals/${askA.id}`, undefined, 404)
    const answered = await as(beatrice.browser, 'POST', `/portal/approvals/${askA.id}/answer`, answerBody('Beatrice Buyer'), 404)
    expect(JSON.stringify(answered)).not.toContain(world.ids.a)
    expect(await one('SELECT status::text FROM "ApprovalRequest" WHERE id = $1', [askA.id])).toEqual({ status: 'OPEN' })
    // B names no approver: its Buyer answers its own size set.
    await as(beatrice.browser, 'POST', `/portal/approvals/${askB.id}/answer`, answerBody('Beatrice Buyer'))

    // The office side: a person limited to B never reaches A's round, swatch or request.
    await read('office.p2', 'GET', `/sales/samples/rounds/${roundA.id}`, 404)
    await read('office.p2', 'GET', `/sales/samples/rounds/${roundA.id}/approval`, 404)
    await read('office.p2', 'GET', `/approvals-out/${askA.id}`, 404)
    await read('office.p2', 'POST', `/sales/samples/rounds/${roundA.id}/decision`, 404, { version: roundA.version, decision: 'APPROVED' })
    await read('office.p2', 'POST', `/sales/samples/swatches/${swatchA.id}/decision`, 404, { version: swatchA.version, decision: 'APPROVED' })
    const swatches = await read('office.p2', 'GET', `/sales/samples/swatches?partyId=${world.ids.a}`)
    expect(swatches.rows).toEqual([])
    await as(salesB.browser, 'GET', `/sales/samples/rounds/${roundA.id}`, undefined, 404)
    await as(salesB.browser, 'GET', `/approvals-out/${askA.id}`, undefined, 404)
    // The production unit sees both.
    await read('office.all', 'GET', `/sales/samples/rounds/${roundA.id}`)
    await read('office.all', 'GET', `/approvals-out/${askB.id}`)
  })
})
