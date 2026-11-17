import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SECOND_PERSON_WORDS } from '@nexus/factory-domain/production-brand/override'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCalendar } from '../../../../../packages/factory-db/seed/calendar'
import { callerFor } from '../../core/command'
import { passGatesOfRound } from '../../modules/planning/milestones/follow'
import { KEEPER_EVENTS } from '../../modules/production/brand/keeper'
import { urgencyWorld, type UrgencyWorld } from '../../modules/production/testing/urgency-world'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { freshGuard } from '../auth/portal/testing/portal'
import { storeGeneratedFile } from '../files/files'
import { systemContext } from '../outbox/system'

/**
 * B-PR-30a decide for a customer (production plan §3 "Decide for a brand, undo —
 * production.brand.override, step-up; a second person when the brand's switch is on", "No silent decisions … Undo is refused
 * in words when the effect cannot be undone … Not for concessions, revised orders, signatures, proofs."; 08-backend §4.6; the
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well.") on the local stack through the real app (the production
 * two-brand world: brand A = the seeds' P1, brand B = the threads' second brand, both portals on):
 *
 *   decide for  a production manager decides brand A's PP round for it (step-up; never the person who asked): the request is
 *               answered by us with the reason, the round decided OFFICE by that person, its gate passes by the round's event,
 *               the customer's task is cancelled, OUR message on the round's thread; A's portal reads "Decided by us for you:
 *               …" and never who of us. Wall: office.p2 / a manager limited to B cannot decide A's approval (404)
 *   four eyes   with A's switch on, nothing is written: ONE BRAND_OVERRIDE task waits; the person who asked for it cannot
 *               grant it; a second person's yes decides it for A as the person who asked; office.p2 reaches no such task
 *   gates       (lead decision on B-PR-38's open items) a gate waiting for A's open round is neither re-pointed nor removed
 *               (CUSTOMER_DECIDES, the hand pass's words); a gate naming no round stays ours
 *
 * Every name, address and number is made up (example.com). Run with
 * `node scripts/factory/run-pg-tests.mjs platform/approvals-out`.
 */

let world: UrgencyWorld
const NS = 'pr3h-decide-for'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
let owner: Office
let manager: Office
let managerB: Office
let manager2: Office
let adminPerson: Office
let alpha: Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let blk = ''
let today = ''
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const REASON = 'Made-up: their buyer approved it on the phone this morning.'

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(world.ids.tenantId, newId()))
const pathOf = (body: Json): string => String(body.error?.issues?.at(-1)?.path ?? '')
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [world.ids.tenantId, type])

async function as(browser: Office['browser'], method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': `pr3h-${newId()}` } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
/** An office person's write after a fresh step-up (production.brand.override asks one). */
async function stepped(person: Office, url: string, body: unknown, status = 200): Promise<Json> {
  await person.stepUp()
  return as(person.browser, 'POST', url, body, status)
}
async function session(name: 'office.all' | 'office.p1' | 'office.p2', method: 'GET' | 'POST', url: string, status = 200, body?: unknown): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': name, ...(method === 'POST' ? { 'idempotency-key': `pr3h-${newId()}` } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  expect(response.statusCode, `${name} ${method} ${url}: ${response.body.slice(0, 600)}`).toBe(status)
  return response.json() as Json
}
async function photoOf(recordType: string, recordId: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType, recordId, kind: 'PHOTO', originalName: `Made-up ${recordType}.png`, contentType: 'image/png', body: PNG })).id
}
async function roundOf(kind: string, partyId: string | null): Promise<Json> {
  const { round } = await as(owner.browser, 'POST', '/sales/samples/rounds', { styleId: world.w.styleId, companyId: world.w.companyId, kind, ...(partyId ? { partyId } : {}), cells: [{ colourwayId: blk, size: '50', quantity: 1 }], instructions: `Made-up ${kind} round.` }, 201)
  return (await as(owner.browser, 'POST', `/sales/samples/rounds/${round.id}/move`, { version: round.version, to: 'UNDER_REVIEW' })).round
}
/** The owner asks brand A (or B) to approve a record: the request (the owner is its asker). */
async function ask(kind: string, recordType: string, recordId: string): Promise<Json> {
  return (await as(owner.browser, 'POST', '/approvals-out', { kind, recordType, recordId, question: `Made-up: please approve this ${kind.toLowerCase()}.`, fileIds: [await photoOf(recordType, recordId)], send: false }, 201)).request
}
const requestRow = (id: string) =>
  one(`SELECT status::text AS status, "decidedForPartyById"::text AS "decidedBy", "decidedForPartyReason" AS reason, "answeredByUserId"::text AS "portalPerson", "answeredViaLinkId"::text AS link, "typedName", "reversedAt", "reversedById"::text AS "reversedBy", "reverseReason", version FROM "ApprovalRequest" WHERE id = $1`, [id])
const fourEyes = (on: boolean) => admin('UPDATE "PortalSettings" SET "overrideFourEyes" = $2, version = version + 1 WHERE id = $1', [world.ids.a, on])
/** The person who may grant a BRAND_OVERRIDE task: a holder of its role (the admin's or the production manager's) who asked nothing. */
async function granterOf(taskId: string): Promise<Office> {
  const { key } = await one<{ key: string }>('SELECT r.key FROM "ApprovalTask" t JOIN "Role" r ON r.id = t."approverRoleId" WHERE t.id = $1', [taskId])
  return key === 'admin' ? adminPerson : manager2
}

beforeAll(async () => {
  world = await urgencyWorld('pr3h_decide_for', NS)
  await seedCalendar({ db: world.h.database, namespace: NS })
  today = businessDate(new Date(), 'Europe/Rome')
  owner = await world.officePerson('olga.owner@pr3h-office.example.com', 'owner')
  manager = await world.officePerson('marco.manager@pr3h-office.example.com', 'production_manager')
  managerB = await world.officePerson('bruno.manager@pr3h-office.example.com', 'production_manager', [world.ids.b])
  manager2 = await world.officePerson('mara.manager@pr3h-office.example.com', 'production_manager')
  adminPerson = await world.officePerson('ada.admin@pr3h-office.example.com', 'admin')
  alpha = await world.portalPerson('paola.production@brand-alpha.example.com', world.ids.a, ['customer-production', 'partner-approve'])
  blk = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [world.w.a.salesOrderLineId])).colourwayId
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-30a decide for the customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("a production manager decides brand A's PP round for it: the round decided as ours, its gate passes, A reads why and never who", async () => {
    const order = await world.addOrder(world.ids.a, 'DF1', '2026-11-02')
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const { gate } = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order.orderId, kind: 'PP_SAMPLE', sampleRoundId: pp.id }, 201)
    const request = await ask('SAMPLE', 'SampleRound', pp.id)
    const url = `/approvals-out/${request.id}/decide-for-party`
    const body = { version: request.version, decision: 'APPROVED', typedName: 'Marco Manager', reason: REASON }
    const before = await requestRow(request.id)

    // A fresh code first: without one nothing is read or written.
    const unstepped = await as(manager.browser, 'POST', url, body, 403)
    expect(unstepped.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    // Never the person who asked it (Owner answer 11-10 Q3).
    expect(pathOf(await stepped(owner, url, body, 403))).toBe('refusal/OWN_ASK')
    // Wall: an office person limited to brand B never reaches A's approval (404, the words of an unknown id).
    const hidden = await stepped(managerB, url, body, 404)
    expect(hidden.error.message).toBe('Approval request not found.')
    expect(JSON.stringify(hidden)).not.toContain(pp.number)
    await session('office.p2', 'POST', url, 404, body)
    // The words of the decision are checked: a reason the customer reads.
    expect(pathOf(await stepped(manager, url, { ...body, reason: '  ' }, 400))).toBe('body/reason')
    expect(await requestRow(request.id)).toEqual(before)

    const done = await stepped(manager, url, body)
    expect(done.override).toEqual({ outcome: 'DONE', taskId: null, words: null })
    expect(done.request).toMatchObject({ status: 'APPROVED', decidedForParty: { byName: expect.any(String), reason: REASON }, answer: { via: 'OFFICE', typedName: 'Marco Manager' }, override: null })
    expect(done.request.may).toMatchObject({ decideForParty: false })
    expect(await requestRow(request.id)).toMatchObject({ status: 'APPROVED', decidedBy: manager.id, reason: REASON, portalPerson: null, link: null, typedName: 'Marco Manager', reversedAt: null })
    // The round: decided as the office's (by the manager), from this request; its gate passes by the round's event.
    expect(await one('SELECT stage::text, decision::text, "decidedVia"::text AS via, "decidedById"::text AS by, "approvalRequestId"::text AS request FROM "SampleRound" WHERE id = $1', [pp.id])).toEqual({ stage: 'DECIDED', decision: 'APPROVED', via: 'OFFICE', by: manager.id, request: request.id })
    expect((await outbox('sample_round.decided')).map((row) => row.payload).find((payload) => payload.sampleRoundId === pp.id)).toMatchObject({ decision: 'APPROVED', via: 'OFFICE', partyId: world.ids.a })
    expect(await passGatesOfRound(system(), pp.id, 'APPROVED', { key: `pr3h-${newId()}` })).toEqual([gate.id])
    // Told: one event of A's (ids and the decision only); the customer's task cancelled; its link revoked; OUR message on the round's thread.
    expect((await outbox('approval_request.decided_for_party')).map((row) => row.payload).filter((payload) => payload.requestId === request.id)).toEqual([
      { requestId: request.id, kind: 'SAMPLE', recordType: 'SampleRound', recordId: pp.id, partyId: world.ids.a, decision: 'APPROVED' },
    ])
    expect(await one<{ status: string }>(`SELECT status::text AS status FROM "PartnerTask" WHERE "sourceKey" = $1`, [`ApprovalRequest:${request.id}`])).toEqual({ status: 'CANCELLED' })
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1 AND "revokedAt" IS NULL`, [request.id])).toEqual({ n: 0 })
    const message = await one(`SELECT m.direction::text AS direction, m."authorKind"::text AS author, m."bodyText" AS text FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SampleRound' AND t."recordId" = $1 ORDER BY m."createdAt" DESC LIMIT 1`, [pp.id])
    expect(message).toMatchObject({ direction: 'OUTBOUND', author: 'SYSTEM' })
    expect(message.text).toMatch(/(Decided by us for you|Deciso da noi per voi): Made-up: their buyer approved it on the phone this morning/)
    expect(message.text).not.toContain('Marco')
    expect((await admin<{ action: string }>('SELECT action FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['ApprovalRequest', request.id])).map((row) => row.action)).toEqual(expect.arrayContaining(['approvalsOut.decideForParty', 'approvalsOut.settle']))
    expect(KEEPER_EVENTS).toContain('approval_request.decided_for_party')

    // Brand A's portal: the reason, never who of us (the company signs it).
    const page = await as(alpha.browser, 'GET', `/portal/approvals/${request.id}`)
    expect(page.request).toMatchObject({ status: 'APPROVED', decidedForYou: `Decided by us for you: ${REASON}` })
    expect(page.request.decided).toBe(`Approved — Decided by us for you: ${REASON.replace(/\.$/, '')}. We go ahead with what you approved.`)
    expect(page.request.answer.typedName).toBe(page.request.from.companyName)
    expect(JSON.stringify(page)).not.toMatch(/Marco|marco\.manager/)
    // Decided once: a second time is refused in words.
    expect(pathOf(await stepped(manager, url, { ...body, version: done.request.version }, 409))).toBe('refusal/ANSWERED')
  })

  it("with A's switch on a second person grants it: nothing is written before the yes; never by the one who asked; office.p2 reaches no such task", async () => {
    await fourEyes(true)
    try {
      const swatchRound = await roundOf('SIZE_SET', world.ids.a)
      const request = await ask('SAMPLE', 'SampleRound', swatchRound.id)
      const url = `/approvals-out/${request.id}/decide-for-party`
      const body = { version: request.version, decision: 'APPROVED_WITH_CHANGES', answer: 'Made-up: shorten the sleeve by 1 cm.', typedName: 'Marco Manager', reason: REASON }
      const asked = await stepped(manager, url, body)
      expect(asked.override).toEqual({ outcome: 'SECOND_PERSON', taskId: expect.any(String), words: SECOND_PERSON_WORDS })
      expect(asked.request).toMatchObject({ status: 'OPEN', decidedForParty: null, override: { taskId: asked.override.taskId, act: 'DECIDE_FOR' } })
      expect(asked.request.may).toMatchObject({ decideForParty: false })
      expect(await requestRow(request.id)).toMatchObject({ status: 'OPEN', decidedBy: null })
      // One waits at a time.
      expect(pathOf(await stepped(manager, url, body, 409))).toBe('refusal/PENDING')
      const taskId = asked.override.taskId as string
      const task = await one(`SELECT kind::text AS kind, "recordType", "recordId"::text AS "recordId", status::text AS status, "requestedById"::text AS "requestedBy", "requireStepUp" AS "stepUp" FROM "ApprovalTask" WHERE id = $1`, [taskId])
      expect(task).toEqual({ kind: 'BRAND_OVERRIDE', recordType: 'ApprovalRequest', recordId: request.id, status: 'PENDING', requestedBy: manager.id, stepUp: true })
      // The wall: a person limited to B reaches no task about A's request.
      await session('office.p2', 'GET', `/approvals/tasks/${taskId}`, 404)
      // The person who asked for it never grants it.
      const version = (await one<{ version: number }>('SELECT version FROM "ApprovalTask" WHERE id = $1', [taskId])).version
      expect(pathOf(await stepped(manager, `/approvals/tasks/${taskId}/approve`, { version, comment: null }, 403))).toBe('refusal/OWN_REQUEST')

      // A second person's yes: decided for A as the person who asked for it, the round decided as ours.
      const granter = await granterOf(taskId)
      await stepped(granter, `/approvals/tasks/${taskId}/approve`, { version, comment: 'Made-up: fine.' })
      expect(await requestRow(request.id)).toMatchObject({ status: 'APPROVED_WITH_CHANGES', decidedBy: manager.id, reason: REASON, typedName: 'Marco Manager' })
      expect(await one('SELECT decision::text, "decidedVia"::text AS via, "decidedById"::text AS by FROM "SampleRound" WHERE id = $1', [swatchRound.id])).toEqual({ decision: 'APPROVED_WITH_COMMENTS', via: 'OFFICE', by: manager.id })
      const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'approvalsOut.decideForParty' AND "recordId" = $1`, [request.id])
      expect(audit.after).toMatchObject({ decidedForPartyById: manager.id, grantedById: granter.id })
    } finally {
      await fourEyes(false)
    }
  })

  it("a gate waiting for A's open round is neither re-pointed nor removed (the hand pass's words); a gate naming no round stays ours", async () => {
    const order = await world.addOrder(world.ids.a, 'DF2', '2026-11-03')
    const pp = await roundOf('PRE_PRODUCTION', world.ids.a)
    const internal = await roundOf('PRE_PRODUCTION', null)
    const { gate } = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order.orderId, kind: 'PP_SAMPLE', sampleRoundId: pp.id }, 201)
    const words = `The gate waits for the customer's answer on sample round ${pp.number}: it passes by itself when they approve it. To decide for them, use Decide for the customer on the round (a reason they read).`
    expect(gate.actions.remove).toMatchObject({ allowed: false, refusal: { code: 'CUSTOMER_DECIDES', message: words } })
    for (const sampleRoundId of [internal.id, null]) {
      const refused = await as(owner.browser, 'PATCH', `/planning/milestones/gates/${gate.id}`, { version: gate.version, sampleRoundId }, 409)
      expect(pathOf(refused)).toBe('refusal/CUSTOMER_DECIDES')
      expect(refused.error.message).toBe(words)
    }
    const removed = await as(owner.browser, 'POST', `/planning/milestones/gates/${gate.id}/remove`, { version: gate.version }, 409)
    expect(pathOf(removed)).toBe('refusal/CUSTOMER_DECIDES')
    expect(await one('SELECT "sampleRoundId"::text AS round FROM "OrderGate" WHERE id = $1', [gate.id])).toEqual({ round: pp.id })
    // Its words and date still change; the round stays.
    const dated = await as(owner.browser, 'PATCH', `/planning/milestones/gates/${gate.id}`, { version: gate.version, targetDate: plusDays(today, 20) })
    expect(dated.gate.sampleRound.id).toBe(pp.id)
    // (a) A gate that names no round is the factory's own: removed as before.
    const { gate: own } = await as(owner.browser, 'POST', '/planning/milestones/gates', { salesOrderId: order.orderId, kind: 'SIZE_SET' }, 201)
    await as(owner.browser, 'POST', `/planning/milestones/gates/${own.id}/remove`, { version: own.version })
  })
})
