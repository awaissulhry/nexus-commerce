import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { callerFor } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { kindOf } from '../../../platform/approvals/kinds'
import { customerWall } from '../../../platform/approvals/store'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { storeGeneratedFile } from '../../../platform/files/files'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { passGatesOfRound } from '../../planning/milestones/follow'
import { twoBrandSessions } from '../../production/testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../../production/testing/urgency-world'

/**
 * B-PR-38 — no silent office decision on a brand-owned item (production plan §3 "No silent decisions: the office can no longer
 * record a brand's PP or sample decision by itself; it must use 'Decide for the brand'"; review fixes R-06, R-36; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well.") on the local stack through the real app (the production two-brand world:
 * brand A = the seeds' P1, brand B = the threads' second brand, both portals on):
 *
 *   wall test  an office decision on brand A's PP round → 409 with words pointing to Decide for the customer (asked or not);
 *              office.p2 (limited to B) cannot reach it (404) — the same for A's fabric swatch and the hand pass of A's PP gate
 *   and        the customer's own answer still decides the round and its gate passes by its event; an internal round and a
 *              customer whose portal is off stay the office's to record (decidedVia OFFICE)
 *   kind       the internal approvals engine knows BRAND_OVERRIDE on A's request: one customer's subject (partyId), held words
 *              for a withdrawn request; a person limited to B reaches none of A's requests there (the task list's wall) nor
 *              their approval history (404)
 *
 * Every name, address and number is made up (example.com). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/sample-decisions`.
 */

let world: UrgencyWorld
const NS = 'pr3d-no-silent'
type Json = Record<string, any>
let owner: Awaited<ReturnType<UrgencyWorld['officePerson']>>
let alpha: Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let blk = ''
let lining = { itemId: '', colourId: '' }
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(world.ids.tenantId, newId()))
const pathOf = (body: Json): string => String(body.error?.issues?.at(-1)?.path ?? '')
/** A read in an office scope of the tenant (every customer), as the engine's readers run. */
const office = <T>(work: (client: any) => Promise<T>): Promise<T> => world.h.database.withScope({ audience: 'office', tenantId: world.ids.tenantId, actorId: newId() }, work)

async function as(browser: Awaited<ReturnType<UrgencyWorld['officePerson']>>['browser'], method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': `pr3d-${newId()}` } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
async function asSession(session: 'office.all' | 'office.p1' | 'office.p2', method: 'GET' | 'POST', url: string, status = 200, body?: unknown): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `pr3d-${newId()}` } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(response.statusCode, `${session} ${url}: ${response.body.slice(0, 500)}`).toBe(status)
  return response.json() as Json
}
async function photoOf(recordType: string, recordId: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType, recordId, kind: 'PHOTO', originalName: `Made-up ${recordType}.png`, contentType: 'image/png', body: PNG })).id
}
async function roundOf(kind: string, partyId: string | null): Promise<Json> {
  const { round } = await as(owner.browser, 'POST', '/sales/samples/rounds', { styleId: world.w.styleId, companyId: world.w.companyId, kind, ...(partyId ? { partyId } : {}), cells: [{ colourwayId: blk, size: '50', quantity: 1 }], instructions: `Made-up ${kind} round.` }, 201)
  return (await as(owner.browser, 'POST', `/sales/samples/rounds/${round.id}/move`, { version: round.version, to: 'UNDER_REVIEW' })).round
}
async function ask(kind: string, recordType: string, recordId: string): Promise<Json> {
  return (await as(owner.browser, 'POST', '/approvals-out', { kind, recordType, recordId, question: `Made-up: please approve this ${kind.toLowerCase()}.`, fileIds: [await photoOf(recordType, recordId)], send: false }, 201)).request
}
const decided = (subject: string) => admin(`SELECT id FROM "OutboxEvent" WHERE type = 'sample_round.decided' AND subject = $1`, [subject])

beforeAll(async () => {
  world = await urgencyWorld('pr3d_no_silent', NS)
  owner = await world.officePerson('olga.owner@pr3d-silent.example.com', 'owner')
  alpha = await world.portalPerson('paola.production@brand-alpha.example.com', world.ids.a, ['customer-production', 'partner-approve'])
  blk = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [world.w.a.salesOrderLineId])).colourwayId
  const item = await one<{ id: string }>('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [world.ids.tenantId, 'SEED-LIN-200'])
  lining = { itemId: item.id, colourId: (await one<{ id: string }>('SELECT id FROM "ItemColour" WHERE "itemId" = $1 ORDER BY code LIMIT 1', [item.id])).id }
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe("B-PR-38 no silent office decision on a customer's own round, swatch or gate", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("an office decision on brand A's PP round → 409 with words, asked or not; office.p2 cannot reach it (404)", async () => {
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const words = `Sample round ${pp.number} is the customer's to decide: ask them to approve it in their portal, or use Decide for the customer (a reason they read; a second person when their switch is on).`
    const view = await as(owner.browser, 'GET', `/sales/samples/rounds/${pp.id}/approval`)
    expect(view.actions.decide).toEqual({ allowed: false, needs: null, refusal: { code: 'CUSTOMER_DECIDES', message: words } })
    expect(view.actions.askBrand).toMatchObject({ allowed: true })
    const refused = await as(owner.browser, 'POST', `/sales/samples/rounds/${pp.id}/decision`, { version: pp.version, decision: 'APPROVED' }, 409)
    expect(pathOf(refused)).toBe('refusal/CUSTOMER_DECIDES')
    expect(refused.error.message).toBe(words)
    // Asked: still the customer's (never "withdraw the request first, then record the decision").
    await ask('SAMPLE', 'SampleRound', pp.id)
    expect(pathOf(await as(owner.browser, 'POST', `/sales/samples/rounds/${pp.id}/decision`, { version: pp.version, decision: 'APPROVED' }, 409))).toBe('refusal/CUSTOMER_DECIDES')
    expect(await one('SELECT stage::text, decision::text, "decidedVia"::text AS via FROM "SampleRound" WHERE id = $1', [pp.id])).toEqual({ stage: 'UNDER_REVIEW', decision: null, via: null })
    expect(await decided(pp.id)).toEqual([])
    // The other customer's office person never reaches it (the words stay with the round's own readers).
    const hidden = await asSession('office.p2', 'POST', `/sales/samples/rounds/${pp.id}/decision`, 404, { version: pp.version, decision: 'APPROVED' })
    expect(JSON.stringify(hidden)).not.toContain(pp.number)
    await asSession('office.p2', 'GET', `/sales/samples/rounds/${pp.id}/approval`, 404)
    expect((await asSession('office.all', 'GET', `/sales/samples/rounds/${pp.id}/approval`)).actions.decide.refusal.code).toBe('CUSTOMER_DECIDES')
  })

  it("brand A's fabric swatch: the office decision is refused in words; office.p2 gets 404", async () => {
    const sentAt = new Date(Date.now() - 3_600_000).toISOString()
    const { swatch } = await as(owner.browser, 'POST', '/sales/samples/swatches', { styleId: world.w.styleId, partyId: world.ids.a, kind: 'FABRIC', itemId: lining.itemId, itemColourId: lining.colourId, sentAt }, 201)
    expect(swatch.actions.decide).toMatchObject({ allowed: false, refusal: { code: 'CUSTOMER_DECIDES' } })
    const refused = await as(owner.browser, 'POST', `/sales/samples/swatches/${swatch.id}/decision`, { version: swatch.version, decision: 'APPROVED' }, 409)
    expect(pathOf(refused)).toBe('refusal/CUSTOMER_DECIDES')
    expect(refused.error.message).toMatch(/^This fabric swatch is the customer's to decide: /)
    expect(await one('SELECT decision::text FROM "SampleSwatch" WHERE id = $1', [swatch.id])).toEqual({ decision: null })
    await asSession('office.p2', 'POST', `/sales/samples/swatches/${swatch.id}/decision`, 404, { version: swatch.version, decision: 'APPROVED' })
  })

  it("the hand pass of a gate waiting for A's round is refused in words; the customer's answer passes it by its event; office.p2 gets 404", async () => {
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const { gate } = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: world.w.a.salesOrderId, kind: 'PP_SAMPLE', sampleRoundId: pp.id }, 201)
    expect(gate.actions.pass).toMatchObject({ allowed: false, refusal: { code: 'CUSTOMER_DECIDES' } })
    const refused = await as(owner.browser, 'POST', '/planning/milestones/gates/pass', { gates: [{ id: gate.id, version: gate.version }] }, 409)
    expect(pathOf(refused)).toBe('refusal/CUSTOMER_DECIDES')
    expect(refused.error.message).toBe(`The gate waits for the customer's answer on sample round ${pp.number}: it passes by itself when they approve it. To decide for them, use Decide for the customer on the round (a reason they read).`)
    await asSession('office.p2', 'POST', '/planning/milestones/gates/pass', 404, { gates: [{ id: gate.id, version: gate.version }] })
    // Starting before the gate stays the factory's open override (a reason the customer reads at Gates & dates).
    expect(gate.actions.startBefore.refusal?.code ?? null).not.toBe('CUSTOMER_DECIDES')

    // The customer answers in its portal: the round is decided by them, and the gate passes by the round's event.
    const request = await ask('SAMPLE', 'SampleRound', pp.id)
    await as(alpha.browser, 'POST', `/portal/approvals/${request.id}/answer`, { decision: 'APPROVED', typedName: 'Paola Production', version: request.version })
    expect(await one('SELECT decision::text, "decidedVia"::text AS via FROM "SampleRound" WHERE id = $1', [pp.id])).toEqual({ decision: 'APPROVED', via: 'PORTAL' })
    expect(await passGatesOfRound(system(), pp.id, 'APPROVED', { key: `pr3d-${newId()}` })).toEqual([gate.id])
  })

  it('an internal round and a customer whose portal is off stay the office\'s to record (decidedVia OFFICE)', async () => {
    const internal = await roundOf('PRE_PRODUCTION', null)
    expect((await as(owner.browser, 'POST', `/sales/samples/rounds/${internal.id}/decision`, { version: internal.version, decision: 'APPROVED' })).decision).toMatchObject({ decision: 'APPROVED', via: 'OFFICE' })
    const roundB = await roundOf('PRE_PRODUCTION', world.ids.b)
    await admin('UPDATE "PortalSettings" SET "portalOn" = false, version = version + 1 WHERE id = $1', [world.ids.b])
    try {
      const view = await as(owner.browser, 'GET', `/sales/samples/rounds/${roundB.id}/approval`)
      expect(view.actions.decide).toMatchObject({ allowed: true, refusal: null })
      const done = await as(owner.browser, 'POST', `/sales/samples/rounds/${roundB.id}/decision`, { version: roundB.version, decision: 'REJECTED', comments: 'Made-up: told by phone, collar too wide.' })
      expect(done.decision).toMatchObject({ decision: 'REJECTED', via: 'OFFICE' })
    } finally {
      await admin('UPDATE "PortalSettings" SET "portalOn" = true, version = version + 1 WHERE id = $1', [world.ids.b])
    }
  })
})

describe('B-PR-38 the BRAND_OVERRIDE kind of the internal approvals engine, walled per customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("reads A's request as one customer's subject; held words for a withdrawn one; office.p2 reaches neither A's requests nor their history", async () => {
    const kind = kindOf('BRAND_OVERRIDE')!
    const roundA = await roundOf('SIZE_SET', world.ids.a)
    const askA = await ask('SAMPLE', 'SampleRound', roundA.id)
    const subject = await office((client) => kind.read(client, askA.id))
    expect(subject).toMatchObject({ companyId: world.w.companyId, partyId: world.ids.a, held: null, facts: { approvalKind: 'SAMPLE', answered: false, recordType: 'SampleRound' }, changes: [{ field: 'status', from: 'OPEN', to: 'DECIDED_FOR_CUSTOMER' }] })
    expect((subject as Json).label).toContain(roundA.number)
    await as(owner.browser, 'POST', `/approvals-out/${askA.id}/withdraw`, { version: askA.version, reason: 'Made-up: asked by mistake.' })
    expect(await office((client) => kind.read(client, askA.id))).toMatchObject({ held: 'This request is withdrawn: there is nothing to decide for the customer.' })
    expect(await office((client) => kind.parent!(client, askA.id))).toEqual({ type: 'SampleRound', id: roundA.id })

    const roundB = await roundOf('SIZE_SET', world.ids.b)
    const askB = await ask('SAMPLE', 'SampleRound', roundB.id)
    // The task list's wall: a person limited to B reaches B's requests, never A's.
    const p2 = twoBrandSessions(world.ids.tenantId, world.ids.a, world.ids.b, OFFICE_PERMISSIONS)['office.p2']
    const wall = (await office((client) => customerWall(client, actorOf({ ...p2, requestId: newId() })))) as Json
    const entry = (wall.OR as Json[]).find((row) => row.recordType === 'ApprovalRequest')
    expect(entry?.recordId?.in).toContain(askB.id)
    expect(entry?.recordId?.in).not.toContain(askA.id)
    // The approval history of A's request: the production unit reads it, office.p2 gets 404.
    await asSession('office.all', 'GET', `/approvals/history/ApprovalRequest/${askA.id}`)
    await asSession('office.p2', 'GET', `/approvals/history/ApprovalRequest/${askA.id}`, 404)
  })
})
