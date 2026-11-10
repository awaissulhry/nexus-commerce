import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkSpecOf } from '@nexus/factory-domain/compliance/requirements/rules'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedRecall, type RecallSeed } from '../../../../../../packages/factory-db/seed/recall'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runClaimEvidenceExpiry } from './expiry'
import { CLAIM_CHECK_KEY, claimsCheck } from './gate-plug'
import { guarded, useClaimsClock } from './store'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; Dir. (EU) 2024/825) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and B-W2b-222's claim guards are real), on the recall
 * seed's claims: SEED-CL-01 a DRAFT (LWG leather, valid to 2027-06-30), SEED-CL-02 APPROVED (recycled lining of SEED-JKT-01,
 * no end) used on the style and its label (a catalogue use ended), SEED-CL-03 WITHDRAWN (PFAS-free, evidence expired),
 * SEED-CL-04 its DRAFT replacement (valid to 2027-11-30); the switch CLAIM-EVIDENCE OFF. The quality person who approves
 * signs in for real (two-factor, step-up). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/compliance/claims`.
 */

let h: Harness
let app: FastifyInstance
let seeded: RecallSeed

const NS = 'w2b264-claims'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B') }
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const KEEPER: Permission[] = ['compliance.certificates.view', 'compliance.claims.manage', 'files.read']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: T.tenant, actorId: idOf('actor'), grants: [grant(KEEPER)] },
  approver: { audience: 'office', tenantId: T.tenant, actorId: idOf('actor'), grants: [grant([...KEEPER, 'compliance.claims.approve'])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['compliance.certificates.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(KEEPER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
let keys = 0
const key = () => `cl-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const today = businessDate(new Date())

interface Person {
  readonly browser: Browser
  readonly secret: string
}
let quality: Person
async function asQuality(method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await quality.browser.send(method, url, body, { headers: { 'idempotency-key': key(), 'x-factory-company': T.companyA } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const draftBody = (over: Json = {}) => ({
  companyId: T.companyA,
  code: `CL-T-${keys + 1}`,
  kind: 'RECYCLED_CONTENT',
  wording: { it: 'Fodera in poliestere riciclato al 50 %', en: 'Lining made with 50 % recycled polyester' },
  scope: 'STYLE',
  styleId: seeded.styleId,
  scopeNote: 'The lining only (made-up).',
  evidenceFileIds: [seeded.fileIds.recycled],
  validUntil: '2027-12-31',
  ...over,
})

beforeAll(async () => {
  h = await startHarness('w2b264_claims')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  seeded = await seedRecall({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (compliance.claims.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const user = await addUser(h, TENANT, { email: 'quality.claims@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if ((answer.body as Json)?.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  quality = { browser, secret: await enrolTotp(h, browser) }
}, 1_500_000)

afterAll(async () => {
  useClaimsClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('the claims register (PRD-380)', () => {
  it('lists the current claims with what each reads as today; the tiles count from them; another company reads none', async () => {
    const list = await ok('viewer', 'GET', '/compliance/claims')
    expect(list.law.claims).toBe('Dir. (EU) 2024/825')
    // Label print does not check the claims yet: the seeded CLAIM-EVIDENCE is OFF (Owner answer 11-09, Q23 / Q5 = A).
    expect(list.labelCheck).toBe('OFF')
    const byCode = Object.fromEntries(list.claims.map((claim: Json) => [claim.code, claim]))
    expect(Object.keys(byCode).sort()).toEqual(['SEED-CL-01', 'SEED-CL-02', 'SEED-CL-04'])
    expect(byCode['SEED-CL-02']).toMatchObject({ state: 'APPROVED', scope: 'STYLE', validity: { state: 'NONE' }, uses: { live: 2, ended: 1, kinds: expect.arrayContaining(['STYLE', 'LABEL']) }, canManage: false })
    expect(byCode['SEED-CL-02'].evidence[0]).toMatchObject({ id: seeded.fileIds.recycled, status: 'AVAILABLE' })
    expect(byCode['SEED-CL-04'].supersedes).toMatchObject({ code: 'SEED-CL-03', status: 'WITHDRAWN' })
    expect((await ok('viewer', 'GET', '/compliance/claims?state=RETIRED')).claims.map((claim: Json) => claim.code)).toEqual(['SEED-CL-03'])
    expect((await ok('viewer', 'GET', '/compliance/claims?state=all&q=pfas')).claims.map((claim: Json) => claim.code)).toEqual(['SEED-CL-03', 'SEED-CL-04'])
    expect(await ok('viewer', 'GET', '/compliance/claims/counts')).toEqual({ approved: 1, blocked: 0, drafts: 2, retired: 1 })
    expect((await ok('companyB', 'GET', '/compliance/claims')).claims).toEqual([])
    expect((await call('companyB', 'GET', `/compliance/claims/${seeded.claimIds.approved}`)).statusCode).toBe(404)
    expect((await call('sales', 'GET', '/compliance/claims')).statusCode).toBe(403)
    expect(JSON.stringify(list)).not.toMatch(/cost|price|salary/i)
  })

  it('reads one claim with every use, its activity and the checker per language', async () => {
    const record = await ok('viewer', 'GET', `/compliance/claims/${seeded.claimIds.approved}`)
    expect(record.uses.map((use: Json) => [use.kind, use.endedAt === null])).toEqual(expect.arrayContaining([['STYLE', true], ['LABEL', true], ['CATALOGUE', false]]))
    expect(record.uses.find((use: Json) => use.kind === 'STYLE').record).toMatchObject({ code: expect.any(String) })
    expect(record.findings).toEqual({})
    expect((await call('viewer', 'GET', `/compliance/claims/${newId()}`)).statusCode).toBe(404)
    // The choices are the keeper's: evidence files, styles, materials, labels, the next code.
    expect((await call('viewer', 'GET', '/compliance/claims/choices')).statusCode).toBe(403)
    const choices = await ok('keeper', 'GET', '/compliance/claims/choices')
    expect(choices.files.map((file: Json) => file.id)).toEqual(expect.arrayContaining([seeded.fileIds.recycled, seeded.fileIds.lwg]))
    expect(choices.styles.map((style: Json) => style.id)).toContain(seeded.styleId)
    expect(choices.nextCode).toMatch(/^CL-\d{4}$/)
  })
})

describe('drafting and approving (Dir. (EU) 2024/825)', () => {
  let draftId = ''

  it('refuses a generic claim with the reason, a taken code and a reader; drafts a claim with its evidence', async () => {
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ wording: { en: 'Eco-friendly jacket' } }), 400)).toContain('body/wording.en')
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ wording: { it: 'Giacca a impatto zero' }, kind: 'CARBON' }), 400)).toContain('body/wording.it')
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ code: 'SEED-CL-01' }), 409)).toContain('refusal/CODE_TAKEN')
    expect((await call('viewer', 'POST', '/compliance/claims', draftBody())).statusCode).toBe(403)
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ scope: 'MATERIAL', styleId: null, itemId: seeded.styleId }), 409)).toContain('refusal/MATERIAL_NOT_ALLOWED')
    const created = await ok('keeper', 'POST', '/compliance/claims', draftBody({ code: 'CL-T-DRAFT', evidenceFileIds: [] }), 201)
    expect(created.claim).toMatchObject({ code: 'CL-T-DRAFT', status: 'DRAFT', state: 'DRAFT', createdBy: { id: idOf('actor') } })
    draftId = created.claim.id
    expect((await eventsOf('claim.changed')).at(-1)).toEqual({ claimId: draftId, code: 'CL-T-DRAFT', status: 'DRAFT', change: 'DRAFTED' })
  })

  it('refuses to approve without evidence before asking for a code; changes the draft; approves it with a fresh code', async () => {
    const version = (await ok('keeper', 'GET', `/compliance/claims/${draftId}`)).claim.version
    expect((await call('keeper', 'POST', `/compliance/claims/${draftId}/approve`, { version })).statusCode).toBe(403)
    expect(await no('approver', 'POST', `/compliance/claims/${draftId}/approve`, { version }, 409)).toContain('refusal/NO_EVIDENCE')
    const edited = await ok('keeper', 'PATCH', `/compliance/claims/${draftId}`, { version, kind: 'RECYCLED_CONTENT', wording: { it: 'Fodera riciclata al 50 %', en: 'Lining 50 % recycled polyester' }, scope: 'STYLE', styleId: seeded.styleId, evidenceFileIds: [seeded.fileIds.recycled], validUntil: '2027-12-31' })
    expect(edited.claim).toMatchObject({ status: 'DRAFT', validUntil: '2027-12-31', evidence: [{ id: seeded.fileIds.recycled }] })
    // Without a fresh code the signed-in quality inspector is asked for one; with it the claim is approved.
    h.clock.advance(6 * 60_000)
    const asked = await quality.browser.send('POST', `/compliance/claims/${draftId}/approve`, { version: edited.claim.version }, { headers: { 'idempotency-key': key(), 'x-factory-company': T.companyA } })
    expect(asked.status, JSON.stringify(asked.body)).toBe(403)
    expect(JSON.stringify(asked.body)).toContain('stepUp')
    await stepUp(h, quality.browser, quality.secret)
    const approved = await asQuality('POST', `/compliance/claims/${draftId}/approve`, { version: edited.claim.version }, 200)
    expect(approved.claim).toMatchObject({ status: 'APPROVED', state: 'APPROVED', approvedBy: { name: expect.any(String) } })
    expect(approved.replaced).toBeNull()
    // Approved: it never changes again.
    expect(await no('keeper', 'PATCH', `/compliance/claims/${draftId}`, { version: approved.claim.version, kind: 'RECYCLED_CONTENT', wording: { en: 'Lining 60 % recycled polyester' }, scope: 'COMPANY', evidenceFileIds: [seeded.fileIds.recycled] }, 409)).toContain('refusal/NOT_DRAFT')
  })
})

describe('where a claim is used', () => {
  it('records a use on an approved claim only, once per record; ends it', async () => {
    const label = (await admin<{ recordId: string }>('SELECT "recordId" FROM "ClaimUse" WHERE id = $1', [seeded.useIds.label]))[0]!.recordId
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.draft}/uses`, { kind: 'STYLE', recordId: seeded.styleId }, 409)).toContain('refusal/NOT_APPROVED')
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses`, { kind: 'STYLE', recordId: seeded.styleId }, 409)).toContain('refusal/USE_TAKEN')
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses`, { kind: 'CATALOGUE', recordId: seeded.styleId }, 400)).toContain('body/label')
    const added = await ok('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses`, { kind: 'WEB_SHOP', recordId: seeded.styleId, label: 'Product page of SEED-JKT-01 (made-up)' }, 201)
    expect(added.use).toMatchObject({ kind: 'WEB_SHOP', recordType: 'Style', recordId: seeded.styleId, endedAt: null })
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses`, { kind: 'LABEL', recordId: seeded.styleId }, 409)).toContain('refusal/USE_RECORD')
    expect(label).toBeTruthy()
    const ended = await ok('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses/${added.use.id}/end`, { version: added.use.version })
    expect(ended.use.endedAt).not.toBeNull()
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.approved}/uses/${added.use.id}/end`, { version: ended.use.version }, 409)).toContain('refusal/USE_ENDED')
    expect((await eventsOf('claim.use_changed')).slice(-2).map((event) => event.change)).toEqual(['ADDED', 'ENDED'])
    const activity = (await ok('viewer', 'GET', `/compliance/claims/${seeded.claimIds.approved}`)).activity.map((entry: Json) => entry.action)
    expect(activity.slice(0, 2)).toEqual(['compliance.claims.endUse', 'compliance.claims.addUse'])
  })
})

describe('a replacement and a withdrawal', () => {
  it('approves a replacement of an approved claim: the old one is withdrawn and its live uses move to the new one', async () => {
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ code: 'CL-T-BAD', supersedesId: seeded.claimIds.draft }), 409)).toContain('refusal/REPLACES_OTHER')
    const created = await ok('keeper', 'POST', '/compliance/claims', draftBody({ code: 'CL-T-NEW', supersedesId: seeded.claimIds.approved, wording: { it: 'Fodera in poliestere riciclato al 60 %', en: 'Lining made with 60 % recycled polyester' } }), 201)
    expect(await no('keeper', 'POST', '/compliance/claims', draftBody({ code: 'CL-T-TWICE', supersedesId: seeded.claimIds.approved }), 409)).toContain('refusal/ALREADY_REPLACED')
    await stepUp(h, quality.browser, quality.secret)
    const approved = await asQuality('POST', `/compliance/claims/${created.claim.id}/approve`, { version: created.claim.version }, 200)
    expect(approved.replaced).toEqual({ id: seeded.claimIds.approved, code: 'SEED-CL-02', usesMoved: 2 })
    const old = await ok('viewer', 'GET', `/compliance/claims/${seeded.claimIds.approved}`)
    expect(old.claim).toMatchObject({ status: 'WITHDRAWN', state: 'RETIRED', withdrawReason: 'Replaced by CL-T-NEW.', supersededBy: { code: 'CL-T-NEW' }, uses: { live: 0 } })
    const fresh = await ok('viewer', 'GET', `/compliance/claims/${created.claim.id}`)
    expect(fresh.uses.filter((use: Json) => use.endedAt === null).map((use: Json) => use.kind).sort()).toEqual(['LABEL', 'STYLE'])
    expect((await eventsOf('claim.changed')).filter((event) => event.claimId === seeded.claimIds.approved).at(-1)).toMatchObject({ status: 'WITHDRAWN', change: 'REPLACED' })
  })

  it('withdraws a draft with its reason, once', async () => {
    const version = (await ok('keeper', 'GET', `/compliance/claims/${seeded.claimIds.draft}`)).claim.version
    expect((await call('keeper', 'POST', `/compliance/claims/${seeded.claimIds.draft}/withdraw`, { version, reason: '' })).statusCode).toBe(400)
    const withdrawn = await ok('keeper', 'POST', `/compliance/claims/${seeded.claimIds.draft}/withdraw`, { version, reason: 'The tannery left the LWG programme (made-up).' })
    expect(withdrawn).toMatchObject({ claim: { status: 'WITHDRAWN', state: 'RETIRED' }, usesEnded: 0 })
    expect(await no('keeper', 'POST', `/compliance/claims/${seeded.claimIds.draft}/withdraw`, { version: withdrawn.claim.version, reason: 'Again' }, 409)).toContain('refusal/ALREADY_WITHDRAWN')
  })
})

describe('expired evidence flags the claim, its uses and the gate', () => {
  it('reads a claim past its last valid day as blocked; refuses a new use; the daily job says it once', async () => {
    const replacement = (await ok('viewer', 'GET', '/compliance/claims?q=CL-T-NEW')).claims[0]
    useClaimsClock(fixedClock('2028-01-15T09:00:00.000Z'))
    try {
      const list = await ok('viewer', 'GET', '/compliance/claims?state=BLOCKED')
      expect(list.claims.map((claim: Json) => claim.code)).toEqual(expect.arrayContaining(['CL-T-NEW']))
      expect(list.claims.find((claim: Json) => claim.code === 'CL-T-NEW').blockReasons).toEqual([{ cause: 'VALID_UNTIL', fileId: null, day: '2027-12-31' }])
      expect((await ok('viewer', 'GET', '/compliance/claims/counts')).blocked).toBeGreaterThanOrEqual(1)
      expect(await no('keeper', 'POST', `/compliance/claims/${replacement.id}/uses`, { kind: 'WEB_SHOP', recordId: seeded.styleId, label: 'Product page (made-up)' }, 409)).toContain('refusal/NOT_HOLDING')
    } finally {
      useClaimsClock(undefined)
    }
    const log = { info() {}, warn() {}, error() {} } as never
    const first = await runClaimEvidenceExpiry({ database: h.database, log, clock: fixedClock('2028-01-15T09:00:00.000Z') })
    expect(first.flagged).toBeGreaterThanOrEqual(1)
    expect(first.failed).toBe(0)
    const again = await runClaimEvidenceExpiry({ database: h.database, log, clock: fixedClock('2028-01-16T09:00:00.000Z') })
    expect(again.flagged).toBe(0)
    const flagged = (await eventsOf('claim.evidence_expired')).filter((event) => event.claimId === replacement.id)
    expect(flagged).toEqual([{ claimId: replacement.id, code: 'CL-T-NEW', since: '2028-01-01', causes: ['VALID_UNTIL'], liveUses: 2 }])
  })

  it('answers the gate by name: not needed without a use, present while every claim holds, missing once one does not', async () => {
    expect(checkSpecOf(CLAIM_CHECK_KEY)).toMatchObject({ kinds: ['CLAIM_EVIDENCE'], market: false })
    const label = (await admin<{ recordId: string }>('SELECT "recordId" FROM "ClaimUse" WHERE id = $1', [seeded.useIds.label]))[0]!.recordId
    const office = { audience: 'office' as const, tenantId: T.tenant, actorId: idOf('actor') }
    await h.database.withScope(office, async (client) => {
      expect((await claimsCheck(client, newId(), null, today)).state).toBe('NOT_NEEDED')
      expect(await claimsCheck(client, seeded.styleId, label, today)).toMatchObject({ state: 'PRESENT', facts: { claims: ['CL-T-NEW'] } })
      const late = await claimsCheck(client, seeded.styleId, label, '2028-01-15')
      expect(late).toMatchObject({ state: 'MISSING', facts: { claim: 'CL-T-NEW', state: 'BLOCKED', causes: ['VALID_UNTIL'] } })
      expect(late.message).toContain('2027-12-31')
    })
    // The switch is the Owner's: the seeded requirement stays OFF (Q23 / Q5 = A), so no gate refuses for it yet.
    expect((await admin<{ switchedOn: boolean }>('SELECT "switchedOn" FROM "ComplianceRequirement" WHERE id = $1', [seeded.claimRequirementId]))[0]!.switchedOn).toBe(false)
  })

  it('turns a refusal of the database into a 409 in words, never a 500', async () => {
    const office = { audience: 'office' as const, tenantId: T.tenant, actorId: idOf('actor') }
    // Approving without any evidence file: the guard refuses (B-W2b-222), said as a conflict.
    const refused = await guarded(() => h.database.withScope(office, (client) => client.sustainabilityClaim.update({ where: { id: seeded.claimIds.replacement }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: idOf('actor'), evidenceFileIds: [] } }))).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(DomainError)
    expect((refused as DomainError).code).toBe('conflict')
    expect((refused as DomainError).message).toMatch(/evidence/)
  })
})
