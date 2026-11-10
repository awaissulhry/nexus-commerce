import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useRulesClock } from '../register-of-rules/common'
import { recordRefusals } from './gate'
import { plugGateCheck, unplugGateCheck } from './plugs'

/**
 * Requirements and gates (B-W2b-254) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login, so row-level security and B-W2b-216's guards are real), seeded with the core and the
 * compliance rules seeds (CERT-COVERAGE locked at label, final release and shipment; DOC-LANGUAGE, USER-INFO-LANGUAGE,
 * LABEL-LANGUAGE, EU-OPERATOR on; the Owner-question rows off; markets IT, DE, FR, ES on; the seeded refusals and the
 * override of SEED-WO-0002's release). An owner signs in for real (two-factor, step-up) to override. Every name, code and
 * person is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/gates`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'gates-seed'
const key = (name: string): string => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), companyB: key('company:B') }
const TENANT: TestTenant = { id: ids.tenant, slug: NS, companies: [{ id: ids.companyA, code: 'A' }, { id: ids.companyB, code: 'B' }] }

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.requirements.manage'
const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId, grants })
const qualityId = newId()
const SESSIONS: Record<string, SessionContext> = {
  quality: office(qualityId, [grant([VIEW, MANAGE, 'compliance.gates.override'])]),
  viewer: office(newId(), [grant([VIEW])]),
  companyB: office(newId(), [grant([VIEW, MANAGE], [ids.companyB])]),
  planner: office(newId(), [grant(['workorders.view', 'workorders.manage', 'workorders.release', VIEW])]),
  // B-W2b-266: a reader of the board who also reads lots (the Cr VI tile).
  lots: office(newId(), [grant([VIEW, 'quality.lots.view'])]),
}

let h: Harness
let app: FastifyInstance
let owner: { browser: Browser; secret: string; id: string }
let serial = 0
const idem = () => `gate-${randomBytes(4).toString('hex')}-${++serial}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refused = async (response: Promise<LightMyRequestResponse>, status: number): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json().error as Json
}
const asOwner = async (url: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<{ status: number; body: Json }> => {
  // The harness's browser sends what fastify's inject sends: a PATCH too.
  const answer = await owner.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': idem() } })
  return { status: answer.status, body: answer.body as Json }
}
const events = async (where = 'TRUE', values: unknown[] = []) =>
  admin<{ id: string; gate: string; outcome: string; code: string; subjectId: string; marketCode: string | null; reason: string; explanation: Json; refusedEventId: string | null }>(
    `SELECT e.id, e.gate::text AS gate, e.outcome::text AS outcome, r.code, e."subjectId", e."marketCode", e.reason, e.explanation, e."refusedEventId" FROM "GateEvent" e JOIN "ComplianceRequirement" r ON r.id = e."requirementId" WHERE e."tenantId" = $1 AND ${where} ORDER BY e."createdAt", e.id`,
    [ids.tenant, ...values],
  )
let draftWorkOrder: string

beforeAll(async () => {
  h = await startHarness('compliance_gates')
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedComplianceRules({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: `owner-${randomBytes(3).toString('hex')}@example.test`, role: 'owner' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`owner sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser), id: user.id }
  // The commands' clock is the harness's (the step-up's): the database wants the step-up at most 15 minutes before the override.
  useRulesClock(h.clock)
  draftWorkOrder = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0002'`, [ids.tenant]))[0]!.id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  useRulesClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('requirements as data (PRD-271)', () => {
  it('lists the requirements and the gate matrix with the law\'s padlocks', async () => {
    const list = await ok(call('viewer', 'GET', '/compliance/requirements'))
    expect(list.mayManage).toBe(false)
    const codes = list.requirements.map((row: Json) => row.code)
    expect(codes).toEqual(expect.arrayContaining(['CERT-COVERAGE', 'DOC-LANGUAGE', 'USER-INFO-LANGUAGE', 'LABEL-LANGUAGE', 'EU-OPERATOR', 'TEXTILE-SHARE-IT']))
    // The seed's row is the W1 requirement: nothing built in beside it.
    expect(list.requirements.some((row: Json) => row.builtIn)).toBe(false)
    expect(list.requirements.find((row: Json) => row.code === 'DOC-LANGUAGE')).toMatchObject({ check: 'doc.languages', who: 'COMPLIANCE', fixPlace: 'declarations' })
    expect(list.requirements.find((row: Json) => row.code === 'TEXTILE-SHARE-IT')).toMatchObject({ switchedOn: false, check: 'MANUAL', marketCode: 'IT' })
    const matrix = await ok(call('quality', 'GET', '/compliance/requirements/gates'))
    const w1 = matrix.rows.find((row: Json) => row.requirement.code === 'CERT-COVERAGE')
    expect(w1.cells).toEqual([
      { gate: 'WORK_ORDER_RELEASE', blocks: true, locked: false },
      { gate: 'LABEL_PRINT', blocks: true, locked: true },
      { gate: 'FINAL_RELEASE', blocks: true, locked: true },
      { gate: 'SHIPMENT', blocks: true, locked: true },
    ])
    expect(matrix.rows.every((row: Json) => row.requirement.status === 'ACTIVE')).toBe(true)
  })

  it('adds a requirement for one market; refuses bad rows, a twin, a viewer and another company\'s manager, in words', async () => {
    const body = { code: 'DOC-IT', kind: 'DOC_LANGUAGE', name: 'The DoC is in Italian for Italy (made up)', legalReference: 'Reg. (EU) 2016/425 art. 15(2)', marketCode: 'IT', blocks: ['WORK_ORDER_RELEASE', 'SHIPMENT'], overrideRoleKeys: ['owner'], overrideMaxDays: 3, seq: 5 }
    const { requirement } = await ok(call('quality', 'POST', '/compliance/requirements', body), 201)
    expect(requirement).toMatchObject({ code: 'DOC-IT', check: 'doc.languages', switchedOn: true, version: 1, builtIn: false })
    expect((await refused(call('quality', 'POST', '/compliance/requirements', body), 409)).message).toBe('There is a requirement DOC-IT already (perhaps archived): edit or restore it.')
    const bad = await refused(call('quality', 'POST', '/compliance/requirements', { ...body, code: 'BAD', blocks: ['SHIPMENT'], lockedBlocks: ['LABEL_PRINT'], marketCode: 'XX' }), 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toContain('body/lockedBlocks')
    expect((await refused(call('quality', 'POST', '/compliance/requirements', { ...body, code: 'NO-MARKET', marketCode: 'NL' }), 400)).issues[0].message).toBe('There is no market NL: add it in Rules & markets first.')
    await refused(call('viewer', 'POST', '/compliance/requirements', { ...body, code: 'VIEWER' }), 403)
    expect((await refused(call('companyB', 'POST', '/compliance/requirements', { ...body, code: 'B-ALL' }), 403)).message).toBe('A requirement for every company is kept only by a role over every company.')
    const audit = await admin(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'ComplianceRequirement' AND "recordId" = $2`, [ids.tenant, requirement.id])
    expect(audit.map((row) => row.action)).toEqual(['compliance.requirements.create'])
  })

  it('tightening is a plain edit; loosening asks for step-up; the law\'s padlocks never open', async () => {
    const before = (await ok(call('quality', 'GET', '/compliance/requirements/DOC-IT'))).requirement
    const tightened = await ok(call('quality', 'PATCH', '/compliance/requirements/DOC-IT', { version: before.version, blocks: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'SHIPMENT'] }))
    expect(tightened).toMatchObject({ requirement: { blocks: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'SHIPMENT'] }, loosened: [] })
    // Loosening without a fresh step-up: 403 `stepUp` (the owner, signed in for real, holds requirements.manage).
    const loosen = await asOwner('/compliance/requirements/DOC-IT', { version: tightened.requirement.version, blocks: ['WORK_ORDER_RELEASE', 'SHIPMENT'] }, 'PATCH')
    expect([loosen.status, loosen.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    const w1 = (await ok(call('quality', 'GET', '/compliance/requirements/CERT-COVERAGE'))).requirement
    const locked = await refused(call('quality', 'PATCH', '/compliance/requirements/CERT-COVERAGE', { version: w1.version, lockedBlocks: ['LABEL_PRINT'] }), 409)
    expect(locked.message).toBe('The law locks it at the final release and shipment: that lock never opens.')
    expect((await refused(call('quality', 'PUT', '/compliance/requirements/CERT-COVERAGE/switch', { version: w1.version, on: false, reason: 'Trying' }), 409)).message).toBe('The law locks requirement CERT-COVERAGE at a gate: it is never switched off.')
    expect((await refused(call('quality', 'PUT', '/compliance/requirements/DOC-IT/switch', { version: tightened.requirement.version, on: false }), 400)).issues[0].path).toBe('body/reason')
  })
})

describe('the one gate (PRD-272)', () => {
  it('answers line by line without recording; a rule for every market waits until the style sells there', async () => {
    const answer = await ok(call('viewer', 'GET', `/compliance/gates/check?gate=WORK_ORDER_RELEASE&subjectType=WorkOrder&subjectId=${draftWorkOrder}`))
    expect(answer.allowed).toBe(false)
    const decision = answer.decisions[0]
    // DOC-IT comes first (seq 5); W1's certificate requirement (seq 10) is missing too: JKT-02 has no certificate.
    expect(decision.refusal).toMatchObject({ requirementCode: 'DOC-IT' })
    expect(decision.lines.find((line: Json) => line.requirement.code === 'CERT-COVERAGE')).toMatchObject({ state: 'MISSING' })
    expect(decision.refusal.words).toMatch(/^Work order SEED-WO-0002 \(\w+ \d+\) for Italy \(IT\) cannot be released: The Declaration of Conformity has no issued it version for Italy\. Who can fix it: compliance\. How: issue the Declaration of Conformity in it/)
    const userInfo = decision.lines.find((line: Json) => line.requirement.code === 'USER-INFO-LANGUAGE')
    expect(userInfo).toMatchObject({ state: 'NOT_NEEDED', blocks: true })
    expect(decision.lines.find((line: Json) => line.requirement.code === 'CERT-COVERAGE')).toMatchObject({ blocks: true, locked: false })
    expect(decision.lines.find((line: Json) => line.requirement.code === 'LABEL-LANGUAGE')).toMatchObject({ blocks: false })
    expect(await events(`e."subjectId" = $2 AND r.code = 'DOC-IT'`, [draftWorkOrder])).toEqual([])
  })

  it('a label check plugs in by name (the hook for B-W2b-253): computed by the plug, MANUAL without it', async () => {
    const seen: string[] = []
    plugGateCheck(['label.pgTestRule'], { kinds: ['LABEL'], market: false, who: 'COMPLIANCE', fix: 'labels' }, async (context) => {
      seen.push(`${context.subject?.type}:${context.targets.length}:${context.labelTemplateId ? 'label' : 'none'}`)
      return (_requirement, _key, target) => ({ state: 'MISSING', message: `The made-up rule finds ${target.label} wrong.`, fix: 'fix the label.', facts: { code: 'pg.rule' }, evidence: null })
    })
    const created = await ok(call('quality', 'POST', '/compliance/requirements', { code: 'LABEL-PG', kind: 'LABEL', checkKey: 'label.pgTestRule', name: 'A made-up label rule', legalReference: 'Made-up law 1', blocks: ['LABEL_PRINT'], seq: 1 }), 201)
    expect(created.requirement.check).toBe('label.pgTestRule')
    const answer = await ok(call('viewer', 'GET', `/compliance/gates/check?gate=LABEL_PRINT&subjectType=WorkOrder&subjectId=${draftWorkOrder}`))
    expect(answer.decisions[0].refusal).toMatchObject({ requirementCode: 'LABEL-PG' })
    expect(answer.decisions[0].refusal.words).toMatch(/cannot have its labels printed: The made-up rule finds \w+ \d+ wrong\. Who can fix it: compliance\. How: fix the label\. Requirement LABEL-PG \(Made-up law 1\)\.$/)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^WorkOrder:[1-9]\d*:/)
    unplugGateCheck('label.pgTestRule')
    // Unplugged (the spec stays declared, the computation is gone): checked by a person, never a refusal.
    const without = await ok(call('viewer', 'GET', `/compliance/gates/check?gate=LABEL_PRINT&subjectType=WorkOrder&subjectId=${draftWorkOrder}`))
    expect(without.decisions[0].lines.find((line: Json) => line.requirement.code === 'LABEL-PG')).toMatchObject({ state: 'MANUAL' })
  })

  it('B-W2b-253\'s label rules are plugged in: a label.* requirement is computed by labelRulesFor', async () => {
    // Checklist only (blocks nothing): the line says what 253's rule found on SEED-WO-0002's label for Italy.
    const created = await ok(call('quality', 'POST', '/compliance/requirements', { code: 'LABEL-CE', kind: 'LABEL', checkKey: 'label.ceMarking', name: 'The CE marking as the law asks (made up)', legalReference: 'Reg. (EU) 2016/425 art. 17', ppeCategories: ['CATEGORY_II', 'CATEGORY_III'], seq: 2 }), 201)
    expect(created.requirement.check).toBe('label.ceMarking')
    const answer = await ok(call('viewer', 'GET', `/compliance/gates/check?gate=LABEL_PRINT&subjectType=WorkOrder&subjectId=${draftWorkOrder}`))
    const lines = answer.decisions[0].lines.filter((line: Json) => line.requirement.code === 'LABEL-CE')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(['OK', 'MISSING', 'NOT_NEEDED', 'MANUAL']).toContain(line.state)
      expect(line).toMatchObject({ check: 'label.ceMarking', blocks: false, fixPlace: 'labels' })
      expect(line.message).not.toBe('The label rules do not check this here.')
      expect(line.message).not.toBe('Checked by a person: no check computes it here.')
    }
  })

  it('the work-order release refuses and the refusal is a GateEvent written after the release rolled back', async () => {
    const workOrder = (await admin<{ version: number }>(`SELECT version FROM "WorkOrder" WHERE id = $1`, [draftWorkOrder]))[0]!
    const error = await refused(call('planner', 'POST', `/production/work-orders/${draftWorkOrder}/release`, { version: workOrder.version }), 409)
    expect(error.code).toBe('invalid_state')
    const written = await events(`e."subjectId" = $2 AND r.code = 'DOC-IT'`, [draftWorkOrder])
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ gate: 'WORK_ORDER_RELEASE', outcome: 'REFUSED', marketCode: 'IT', explanation: { code: 'doc.missing', languages: ['it'], requirement: 'DOC-IT' } })
    // The release itself changed nothing.
    expect((await admin(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [draftWorkOrder]))[0]).toEqual({ status: 'DRAFT' })
    const outbox = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'compliance_gates.refused'`, [ids.tenant])
    expect(outbox.map((row) => row.payload.requirementCode)).toContain('DOC-IT')
  })

  it('writes W1\'s certificate requirement row on its first refusal when a tenant has none (recordRefusals)', async () => {
    const tenant = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "ComplianceRequirement" WHERE "tenantId" = $1 AND code = 'CERT-COVERAGE'`, [ids.tenant])
    expect(tenant[0]!.n).toBe(1)
    // On this tenant the row exists: a refusal naming the built-in requirement lands on it, once per target.
    const caller = callerFor(h.database, { audience: 'office', tenantId: ids.tenant, actorId: qualityId, grants: [], requestId: newId() })
    const pending = { gate: 'LABEL_PRINT' as const, subjectType: 'WorkOrder', subjectId: draftWorkOrder, companyId: ids.companyA, siteId: null, styleId: (await admin(`SELECT "styleId" FROM "WorkOrder" WHERE id = $1`, [draftWorkOrder]))[0]!.styleId, marketCode: null, requirementId: null, requirementCode: 'CERT-COVERAGE', words: 'Certificate SEED-CERT-0001 expired (made up).', explanation: { code: 'certificate.missing' }, createdById: null, targetKey: 'c1' }
    await recordRefusals(caller, [pending, pending])
    const written = await events(`e."subjectId" = $2 AND r.code = 'CERT-COVERAGE' AND e.gate = 'LABEL_PRINT'`, [draftWorkOrder])
    expect(written).toHaveLength(1)
  })
})

describe('overrides (cs-override)', () => {
  it('a named role overrides one refusal with a reason and step-up, until a time; the gate then lets it pass', async () => {
    const refusal = (await events(`e."subjectId" = $2 AND r.code = 'DOC-IT' AND e.outcome = 'REFUSED'`, [draftWorkOrder]))[0]!
    const until = new Date(h.clock.now().getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
    const body = { reason: 'The Italian DoC is with the signatory; cutting may start (made up).', until }
    const noStepUp = await asOwner(`/compliance/gates/events/${refusal.id}/override`, body)
    expect([noStepUp.status, noStepUp.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    await stepUp(h, owner.browser, owner.secret)
    const tooLong = await asOwner(`/compliance/gates/events/${refusal.id}/override`, { ...body, until: new Date(h.clock.now().getTime() + 4 * 24 * 60 * 60 * 1000).toISOString() })
    expect([tooLong.status, tooLong.body.error.issues[0].path]).toEqual([400, 'body/until'])
    const done = await asOwner(`/compliance/gates/events/${refusal.id}/override`, body)
    expect(done.status, JSON.stringify(done.body)).toBe(201)
    expect(done.body.override).toMatchObject({ refusedEventId: refusal.id, requirementCode: 'DOC-IT', gate: 'WORK_ORDER_RELEASE' })
    const overridden = await events(`e.outcome = 'OVERRIDDEN' AND e."refusedEventId" = $2`, [refusal.id])
    expect(overridden).toHaveLength(1)
    const again = await asOwner(`/compliance/gates/events/${refusal.id}/override`, body)
    expect([again.status, again.body.error.issues[0].path]).toEqual([409, 'refusal/IN_FORCE'])
    const answer = await ok(call('viewer', 'GET', `/compliance/gates/check?gate=WORK_ORDER_RELEASE&subjectType=WorkOrder&subjectId=${draftWorkOrder}`))
    expect(answer.decisions[0].lines.find((line: Json) => line.requirement.code === 'DOC-IT')).toMatchObject({ state: 'OVERRIDDEN', override: { eventId: overridden[0]!.id } })
    // The next refusal is W1's certificate requirement (no role may override it).
    expect(answer.decisions[0].refusal).toMatchObject({ requirementCode: 'CERT-COVERAGE' })
    // With the step-up, a loosening goes through and says what it loosened.
    const current = (await ok(call('quality', 'GET', '/compliance/requirements/DOC-IT'))).requirement
    const loosened = await asOwner('/compliance/requirements/DOC-IT', { version: current.version, blocks: ['WORK_ORDER_RELEASE', 'SHIPMENT'] }, 'PATCH')
    expect(loosened.status, JSON.stringify(loosened.body)).toBe(200)
    expect(loosened.body.loosened).toEqual([{ code: 'BLOCK_REMOVED', message: 'It no longer blocks the label print.' }])
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'compliance.requirements.edit' AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1`, [ids.tenant, current.id])
    expect(audit[0]!.after.loosened).toEqual(['BLOCK_REMOVED'])
  })

  it('the feed says still blocked, overridden, who and the role; refuses the wrong role and a locked gate in words', async () => {
    const feed = await ok(call('quality', 'GET', '/compliance/gates/events?days=90'))
    const docIt = feed.events.find((row: Json) => row.outcome === 'REFUSED' && row.requirement.code === 'DOC-IT')
    expect(docIt).toMatchObject({ state: 'OVERRIDDEN', place: 'work-order release', subject: { type: 'WorkOrder', number: 'SEED-WO-0002' }, marketCode: 'IT', by: null, mayOverride: false })
    expect(docIt.overrides[0]).toMatchObject({ inForce: true, reason: 'The Italian DoC is with the signatory; cutting may start (made up).' })
    expect(docIt.overrides[0].by.id).toBe(owner.id)
    // The seed's label refusal at A1 (LABEL-LANGUAGE): only the quality inspector may override it.
    const label = feed.events.find((row: Json) => row.outcome === 'REFUSED' && row.requirement.code === 'LABEL-LANGUAGE')
    expect(label.by).toBeNull()
    const wrongRole = await asOwner(`/compliance/gates/events/${label.id}/override`, { reason: 'Owner tries the label refusal (made up).', until: new Date(h.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString() })
    expect([wrongRole.status, wrongRole.body.error.message]).toEqual([403, 'Only quality_inspector may override requirement LABEL-LANGUAGE; your roles are owner.'])
    const certificate = (await events(`r.code = 'CERT-COVERAGE' AND e.outcome = 'REFUSED'`))[0]!
    const locked = await asOwner(`/compliance/gates/events/${certificate.id}/override`, { reason: 'Owner tries the locked label gate (made up).', until: new Date(h.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString() })
    expect([locked.status, locked.body.error.message]).toEqual([409, 'The law locks requirement CERT-COVERAGE at the label print: it is never overridden there.'])
    await refused(call('viewer', 'POST', `/compliance/gates/events/${label.id}/override`, { reason: 'A viewer tries (made up).', until: new Date(h.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString() }), 403)
  })
})

describe('the status board (PRD-277)', () => {
  it('tiles, the style × market matrix, needs action, a cell\'s checklist and what expires next', async () => {
    const board = await ok(call('viewer', 'GET', '/compliance/status/board'))
    expect(board.markets.map((market: Json) => market.code)).toEqual(['IT', 'DE', 'FR', 'ES'])
    const jacket = board.rows.find((row: Json) => row.style.code === 'SEED-JKT-01')
    expect(jacket.cells.map((cell: Json) => cell.marketCode)).toEqual(['IT', 'DE', 'FR', 'ES'])
    // SEED-JKT-01's DoC is an English draft and it has no user information: Germany is blocked (shipment, release).
    const germany = jacket.cells.find((cell: Json) => cell.marketCode === 'DE')
    expect(germany).toMatchObject({ state: 'BLOCKED', words: 'Blocked' })
    expect(germany.blockedGates).toEqual(expect.arrayContaining(['WORK_ORDER_RELEASE', 'SHIPMENT']))
    expect(board.tiles).toMatchObject({ lotsWithoutCrVi: null })
    expect(board.tiles.missingLanguages).toBeGreaterThan(0)
    expect(board.needsAction.lines.length).toBeLessThanOrEqual(5)
    expect(board.needsAction.lines[0].severity).toBe('BLOCKED')
    const cell = await ok(call('viewer', 'GET', `/compliance/status/cell?styleId=${jacket.style.id}&market=DE`))
    const states = Object.fromEntries(cell.items.map((item: Json) => [item.requirement.code, item.state]))
    expect(states).toMatchObject({ 'DOC-LANGUAGE': 'MISSING', 'USER-INFO-LANGUAGE': 'MISSING', 'CRVI-EVIDENCE': 'MANUAL', 'TEXTILE-SHARE-IT': 'NOT_NEEDED', 'GLOVE-LEVELS': 'NOT_NEEDED' })
    expect(cell.items.find((item: Json) => item.requirement.code === 'DOC-IT')).toMatchObject({ state: 'NOT_NEEDED', message: 'Only for market IT.' })
    const expiries = await ok(call('viewer', 'GET', '/compliance/status/expiries?months=24'))
    expect(expiries.months).toHaveLength(24)
    await refused(call('viewer', 'GET', `/compliance/status/cell?styleId=${jacket.style.id}&market=NL`), 404)
  })

  // B-W2b-266 (the board's screen): ?gap= narrows the cells and "Needs action" (the tiles stay whole), ?brandId= the styles, the
  // Cr VI tile for a reader of lots, the expiries with their first valid day.
  it('a gap, a brand, the Cr VI tile and the expiries the screen reads (B-W2b-266)', async () => {
    const whole = await ok(call('viewer', 'GET', '/compliance/status/board'))
    const docs = await ok(call('viewer', 'GET', '/compliance/status/board?gap=docLanguage'))
    expect(docs.tiles).toEqual(whole.tiles)
    const docCodes = (await admin<{ code: string }>(`SELECT code FROM "ComplianceRequirement" WHERE "tenantId" = $1 AND kind::text IN ('DOC_LANGUAGE', 'USER_INFO_LANGUAGE')`, [ids.tenant])).map((row) => row.code)
    expect(docs.needsAction.lines.length).toBeGreaterThan(0)
    for (const line of docs.needsAction.lines) expect(docCodes).toContain(line.requirementCode)
    // The languages tile counts the cells the gap shows.
    expect(docs.rows.flatMap((row: Json) => row.cells).filter((cell: Json) => cell.state !== 'READY')).toHaveLength(whole.tiles.missingLanguages)
    const germany = docs.rows.find((row: Json) => row.style.code === 'SEED-JKT-01').cells.find((cell: Json) => cell.marketCode === 'DE')
    expect(germany.state).toBe('BLOCKED')
    expect(['DOC-LANGUAGE', 'USER-INFO-LANGUAGE']).toContain(germany.first.code)
    const all = await ok(call('viewer', 'GET', '/compliance/status/actions?gap=docLanguage'))
    expect(all.count).toBe(docs.needsAction.count)
    const certificate = await ok(call('viewer', 'GET', '/compliance/status/board?gap=certificate'))
    for (const line of certificate.needsAction.lines) expect(line.requirementCode).toMatch(/^CERT-/)
    await refused(call('viewer', 'GET', '/compliance/status/board?gap=nothing'), 400)
    const noBrand = await ok(call('viewer', 'GET', `/compliance/status/board?brandId=${newId()}`))
    expect([noBrand.rows, noBrand.needsAction.count]).toEqual([[], 0])
    const branded = whole.rows.find((row: Json) => row.style.brand)
    if (branded) {
      const one = await ok(call('viewer', 'GET', `/compliance/status/board?brandId=${branded.style.brand.id}`))
      expect(one.rows.every((row: Json) => row.style.brand?.id === branded.style.brand.id)).toBe(true)
    }
    const lots = await ok(call('lots', 'GET', '/compliance/status/board'))
    const [held] = await admin<{ count: number }>(`SELECT count(*)::int AS count FROM "Lot" WHERE "tenantId" = $1 AND "requiresCrViTest" AND "crViStatus"::text IN ('PENDING', 'FAIL') AND "qualityStatus"::text IN ('QUARANTINE', 'BLOCKED')`, [ids.tenant])
    expect(lots.tiles.lotsWithoutCrVi).toBe(held!.count)
    const expiries = await ok(call('viewer', 'GET', '/compliance/status/expiries?months=24'))
    for (const item of expiries.months.flatMap((month: Json) => month.items)) {
      expect(Object.keys(item)).toEqual(expect.arrayContaining(['validFrom', 'status', 'detail', 'party', 'endsWithBase']))
      if (item.validFrom) expect(item.validFrom <= item.validTo).toBe(true)
    }
  })
})
