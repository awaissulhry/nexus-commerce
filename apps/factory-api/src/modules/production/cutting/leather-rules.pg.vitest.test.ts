import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin, pinKeyring } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLeather } from '../../../../../../packages/factory-db/seed/leather'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Leather cutting rules (B-W2b-103; MES-053 same shade, MES-063 wrong hide, MES-064 thickness, MES-055 the pieces' minimum
 * grade, MES-060 the hide's photo; design floor.hidecut "Check the hide" and the pop-up "Cut anyway?") through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime and floor logins: row-level security, the
 * grants and the triggers — CutLog_cutting_rules among them — are real), on the factory-db seeds of one tenant: plant A1 names
 * workers (its operator acknowledged the worker notice), SEED-WO-0001 IN_PROGRESS on SEED-JKT-02 rev 1 holding SEED-HIDE-0001
 * (lot SEED-LOT-LEA-01, W1 shade text "Black 01", grade A, 1.20 mm; the cowhide's spec 1.10-1.30 mm), the grades A-D and the
 * shade groups of the leather seed. Made up here: small black hides of lot SEED-LOT-LEA-01 ("Black 01"), one hide of another
 * lot, a pattern piece "Front" of the jacket's leather that asks grade B or better (written on the released revision with the
 * triggers off for this set-up only: a released revision takes no new piece), PINs for the team leader, the operator and a
 * helper whose floor role is the operator's. Every name and value is made up.
 *
 * The law and rules the tests name: Owner answer W1 / Statuto art. 4 — the lead's name only inside the one record, behind the
 * site's gate; COL-017 — photos never show faces (the screen's words); four eyes — the lead is never the cutter; the PIN never
 * reaches a stored row. Run with `node scripts/factory/run-pg-tests.mjs modules/production/cutting`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b103-leather'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const helper = newId()
const deviceA1 = idOf('device:A1:cutting')
const LEAD_PIN = '135790'
const OPERATOR_PIN = '864201'
const HELPER_PIN = '975310'

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  cutter: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: deviceA1, grants: [grant(['floor.work', 'production.cut', 'inventory.issue'], [companyA], [siteA1])] },
  manager: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view', 'production.cut', 'production.cut.correct', 'files.read'])] },
  reserver: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['inventory.reserve', 'inventory.stock.view'])] },
  // B-W2b-219: sets the site's cutting rules (Floor rules & codes › Cutting).
  rules: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['production.settings.view', 'production.settings.manage'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const cid = (name: string) => `t-${run}-${name}-${++serial}`
/** A floor write takes an Idempotency-Key: a cut's is its clientEventId ("Cut anyway" takes only that one). */
const keyOf = (payload: unknown): string => {
  const body = (payload ?? {}) as Json
  return String(body.cut?.clientEventId ?? body.clientEventId ?? cid('key'))
}
const call = (session: string, method: Method, url: string, payload?: unknown, key: string | null = null) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': key ?? keyOf(payload) } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key: string | null = null): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues as Json[]).map((issue) => String(issue.path))
const n = async (sql: string, values: unknown[]) => (await admin<{ n: number }>(sql, values))[0]!.n
const outbox = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])

let wo: { id: string; number: string }
let blkCell: string
let leatherItem: string
let leatherColour: string
let bin: string
const lots: Record<string, string> = {}
const hides: Record<string, { id: string; code: string }> = {}

/** A made-up lot of the black cowhide at A1, RELEASED with its chromium VI on the lot's report. */
async function addLot(key: string, dyeBatch: string): Promise<string> {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, T, companyA, siteA1, leatherItem, leatherColour, `T-${run}-${key}`, dyeBatch],
  )
  lots[key] = lotId
  return lotId
}

/** A made-up hide in stock at A1-STORE-01 (an opening move), with its grade text, shade text and thickness. */
async function addHide(key: string, lotId: string, facts: { grade: string; shade: string | null; thicknessMm: string; area?: string }): Promise<void> {
  const id = newId()
  const code = `T-${run}-${key}`
  const area = facts.area ?? '12.0000'
  await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, shade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7, $8, $9, $10)`, [
    id,
    T,
    siteA1,
    lotId,
    leatherItem,
    code,
    area,
    facts.grade,
    facts.shade,
    facts.thicknessMm,
  ])
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, 'FT2', $10, $11, now())`,
    [newId(), T, companyA, siteA1, leatherItem, leatherColour, lotId, id, bin, area, `leather-rules-${code}`],
  )
  hides[key] = { id, code }
}

const cutUrl = () => `/production/cutting/work-orders/${wo.id}/cuts`
/** One single part of the black cell, 2 ft² typed (the BOM's "Outer shell": its pattern piece "Front" asks grade B). */
const cutBody = (hide: string, extra: Json = {}): Json => ({ clientEventId: cid('cut'), code: hides[hide]!.code, lines: [{ workOrderSizeId: blkCell, parts: [{ part: 'Outer shell', pieces: 1 }] }], area: { area: '2' }, ...extra })
const anyway = (cut: Json, extra: Json = {}): Json => ({ cut, lead: { workerId: lead, pin: LEAD_PIN }, reasonCode: 'CHECKED_BY_EYE', warnings: ['SHADE'], ...extra })
const anywayUrl = () => `/production/cutting/work-orders/${wo.id}/cuts/anyway`
const scan = async (hide: string) => ((await ok('cutter', 'GET', `/production/cutting/hides?code=${hides[hide]!.code}&workOrderId=${wo.id}`)).workOrders as Json[]).find((row) => row.id === wo.id)!
const entryOf = async (cutLogId: string) =>
  (await admin(`SELECT overrides::text[] AS overrides, "overrideLeadWorkerId", "overrideLeadUserId", "overrideReason", "measuredThicknessMm"::text AS "measuredThicknessMm", "photoFileId", "workerId" FROM "CutLog" WHERE id = $1`, [cutLogId]))[0]!
const cutsOf = async (hide: string) => n(`SELECT count(*)::int AS n FROM "CutLog" WHERE "hideId" = $1`, [hides[hide]!.id])
const issuesOf = async (hide: string) => n(`SELECT count(*)::int AS n FROM "StockMove" WHERE "hideId" = $1 AND reason = 'ISSUE'`, [hides[hide]!.id])

beforeAll(async () => {
  h = await startHarness('leather_rules')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedLeather]) await seed({ db: h.database, namespace: NS })
  const [order] = await admin<{ id: string; number: string; styleRevisionId: string }>(`SELECT id, number, "styleRevisionId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [T])
  wo = order!
  const [leather] = await admin<{ itemId: string; itemColourId: string }>(`SELECT h."itemId", l."itemColourId" FROM "Hide" h JOIN "Lot" l ON l.id = h."lotId" WHERE h."tenantId" = $1 AND h.code = 'SEED-HIDE-0001'`, [T])
  leatherItem = leather!.itemId
  leatherColour = leather!.itemColourId
  bin = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [T]))[0]!.id
  blkCell = (await admin<{ id: string }>(
    `SELECT s.id FROM "WorkOrderSize" s JOIN "WorkOrderMaterial" m ON m."workOrderSizeId" = s.id WHERE s."workOrderId" = $1 AND m."itemId" = $2 AND m."itemColourId" = $3 ORDER BY s.size LIMIT 1`,
    [wo.id, leatherItem, leatherColour],
  ))[0]!.id

  // The pattern piece "Front" of the jacket's leather line, grade B or better (the revision is released: its guard is off for this set-up only).
  const [line] = await admin<{ id: string; styleId: string }>(`SELECT b.id, b."styleId" FROM "BomLine" b WHERE b."revisionId" = $1 AND b."itemId" = $2 ORDER BY b.seq LIMIT 1`, [order!.styleRevisionId, leatherItem])
  const gradeB = (await admin<{ id: string }>(`SELECT id FROM "LeatherGrade" WHERE "tenantId" = $1 AND code = 'B'`, [T]))[0]!.id
  await admin(`ALTER TABLE "PatternPiece" DISABLE TRIGGER "PatternPiece_revision_guard"`)
  try {
    await admin(`INSERT INTO "PatternPiece" (id, "tenantId", "styleId", "revisionId", seq, name, quantity, "bomLineId", "minGradeId") VALUES ($1, $2, $3, $4, 990, 'Front', 1, $5, $6)`, [newId(), T, line!.styleId, order!.styleRevisionId, line!.id, gradeB])
  } finally {
    await admin(`ALTER TABLE "PatternPiece" ENABLE TRIGGER "PatternPiece_revision_guard"`)
  }

  // Made-up stock: small black hides of the seeded lot (its "Black 01", as SEED-HIDE-0001), one of another lot, and a large
  // one never cut (what another work order's reservation of the lot leaves free).
  const lea01 = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LEA-01'`, [T]))[0]!.id
  await addLot('OTHER', 'DB-T-77')
  await addHide('FILL', lea01, { grade: 'A', shade: 'Black 01', thicknessMm: '1.20', area: '200.0000' })
  await addHide('OTHER-LOT', lots.OTHER!, { grade: 'A', shade: 'Black 01', thicknessMm: '1.20' })
  for (const key of ['THIN-1', 'THIN-2']) await addHide(key, lea01, { grade: 'A', shade: 'Black 01', thicknessMm: '0.95' })
  await addHide('GRADE-C', lea01, { grade: 'C', shade: 'Black 01', thicknessMm: '1.20' })
  for (const key of ['RES-1', 'RES-2']) await addHide(key, lea01, { grade: 'A', shade: 'Black 01', thicknessMm: '1.20' })

  // PINs: the team leader (production.cut.override from the team_leader template), the operator (the cutter), a helper whose
  // floor role is the operator's (no override right).
  await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", locale, "employeeCode", status) VALUES ($1, $2, $3, $4, 'Made-up Helper', 'it', $5, 'ACTIVE')`, [helper, T, companyA, siteA1, `W2B103-${run}`])
  await admin(`INSERT INTO "WorkerRole" (id, "tenantId", "siteId", "workerId", "roleId", "grantedById") SELECT $1, "tenantId", "siteId", $2, "roleId", "grantedById" FROM "WorkerRole" WHERE "workerId" = $3`, [newId(), helper, operator])
  const keyring = pinKeyring(LOCAL_PIN_PEPPER)
  for (const [person, pin] of [[lead, LEAD_PIN], [operator, OPERATOR_PIN], [helper, HELPER_PIN]] as const) {
    await admin(`UPDATE "Worker" SET "pinHash" = $2, "pinChangedAt" = now(), "pinMustChange" = false WHERE id = $1`, [person, await hashPin(pin, keyring)])
  }
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [T])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T])
  }

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, officeAuth: h.auth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the hide check before the knife (MES-053 shade, design floor.hidecut "Check the hide")', () => {
  it('shows a hide of the work order’s own shade lot with nothing standing, and one of another lot with the shade warning', async () => {
    const same = await scan('RES-2')
    expect(same.checks).toMatchObject({ warnings: [], standing: [], passed: [], shade: { rule: 'ORDER', same: true, cutFrom: [{ shadeLabel: 'Black 01' }] }, thickness: { verdict: 'OK', valueMm: '1.20', source: 'HIDE', minMm: '1.10', maxMm: '1.30' }, photo: { required: false } })
    expect(same.checks.grade).toEqual({ hide: 'A', byText: true, pieces: [{ name: 'Front', minGrade: 'B', verdict: 'OK' }] })
    const other = await scan('OTHER-LOT')
    expect(other.cuttable).toBe(true)
    expect(other.checks.standing).toEqual(['SHADE'])
    expect(other.checks.shade).toMatchObject({ same: false, hide: { lotCode: `T-${run}-OTHER`, shadeLabel: 'Black 01', outOfShade: false } })
    expect(other.checks.warnings).toEqual([expect.objectContaining({ kind: 'SHADE', code: 'SHADE_LOT', message: expect.stringContaining(`hide ${hides['OTHER-LOT']!.code} is lot T-${run}-OTHER, shade Black 01`) })])
  })

  it('stops the cut on the card: 409 CUT_WARNING with the warning named, nothing issued or logged', async () => {
    const error = await no('cutter', 'POST', cutUrl(), cutBody('OTHER-LOT'), 409)
    expect(pathsOf(error)).toEqual(['refusal/CUT_WARNING', 'warnings/SHADE/SHADE_LOT'])
    expect(error.message).toMatch(/^This hide has warnings: Work order SEED-WO-0001 is cut from lot SEED-LOT-LEA-01, shade Black 01/)
    expect(await cutsOf('OTHER-LOT')).toBe(0)
    expect(await issuesOf('OTHER-LOT')).toBe(0)
  })

  it('stops a queued cut the same way, in words with the fix (never an override from the queue)', async () => {
    const event = { clientEventId: cid('queued'), seq: 1, kind: 'production.cut.log', occurredAt: new Date().toISOString(), workerId: operator, payload: { workOrderId: wo.id, ...cutBody('OTHER-LOT', { clientEventId: undefined }) } }
    const answer = await ok('cutter', 'POST', '/floor/sync', { events: [event] }, 200, cid('sync'))
    expect(answer.events[0]).toMatchObject({ status: 'refused', refusal: { code: 'CUT_WARNING', final: true, fix: expect.stringContaining('Cut anyway') } })
    expect(await cutsOf('OTHER-LOT')).toBe(0)
  })
})

describe('"Cut anyway": a lead’s PIN and a reason tile (pop-up hidecut.override)', () => {
  it('refuses a wrong PIN, the cutter as lead, a person without the right, and "Other" without words', async () => {
    const body = cutBody('OTHER-LOT')
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(body, { lead: { workerId: lead, pin: '000000' } }), 409))[0]).toBe('refusal/LEAD_PIN_WRONG')
    expect(await n(`SELECT "failedPinAttempts" AS n FROM "Worker" WHERE id = $1`, [lead])).toBe(1)
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(body, { lead: { workerId: operator, pin: OPERATOR_PIN } }), 409))[0]).toBe('refusal/LEAD_IS_CUTTER')
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(body, { lead: { workerId: helper, pin: HELPER_PIN } }), 409))[0]).toBe('refusal/NOT_A_LEAD')
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(body, { reasonCode: 'OTHER' }), 409))[0]).toBe('refusal/LEAD_NOTE_MISSING')
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(body, { lead: { pin: LEAD_PIN } }), 400))).toEqual(['body/lead'])
    expect(await cutsOf('OTHER-LOT')).toBe(0)
  })

  it('cuts with the lead, the reason and the warnings that stood, written with the entry; the PIN is stored nowhere', async () => {
    const body = cutBody('OTHER-LOT')
    const answer = await ok('cutter', 'POST', anywayUrl(), anyway(body), 201, body.clientEventId)
    expect(answer.override).toEqual({ overrides: ['SHADE'], reasonCode: 'CHECKED_BY_EYE' })
    expect(answer.cut).toMatchObject({ overrides: ['SHADE'], overrideReason: 'Checked by eye: it is fine', photoFileId: null, measuredThicknessMm: null })
    expect(await entryOf(answer.cut.id)).toMatchObject({ overrides: ['SHADE'], overrideLeadWorkerId: lead, overrideLeadUserId: null, overrideReason: 'Checked by eye: it is fine', workerId: operator })
    expect(await issuesOf('OTHER-LOT')).toBe(1)
    const [event] = await outbox('production.cut_overridden', wo.id)
    expect(event!.payload).toEqual({ workOrderId: wo.id, number: wo.number, cutLogId: answer.cut.id, hideId: hides['OTHER-LOT']!.id, lotId: lots.OTHER, overrides: ['SHADE'], reasonCode: 'CHECKED_BY_EYE' })
    const [audit] = await admin(`SELECT after, reason FROM "AuditLog" WHERE "recordType" = 'CutLog' AND "recordId" = $1 AND action = 'production.cut'`, [answer.cut.id])
    expect(audit).toMatchObject({ reason: 'Checked by eye: it is fine', after: { overrides: ['SHADE'], overrideLeadWorkerId: lead, overrideReasonCode: 'CHECKED_BY_EYE' } })
    expect(await n(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND (after::text LIKE $2 OR before::text LIKE $2)`, [T, `%${LEAD_PIN}%`])).toBe(0)
    expect(await n(`SELECT count(*)::int AS n FROM "IdempotencyReceipt" WHERE "tenantId" = $1 AND response::text LIKE $2`, [T, `%${LEAD_PIN}%`])).toBe(0)
    // The same cut sent again answers the entry recorded first.
    expect((await ok('cutter', 'POST', anywayUrl(), anyway(body), 200)).cut.id).toBe(answer.cut.id)
  })

  it('asks no lead again for the same hide and work order; the next entry records no override', async () => {
    const next = await ok('cutter', 'POST', cutUrl(), cutBody('OTHER-LOT'), 201)
    expect(next.cut.overrides).toEqual([])
    expect(await entryOf(next.cut.id)).toMatchObject({ overrides: [], overrideLeadWorkerId: null, overrideReason: null })
    expect((await scan('OTHER-LOT')).checks).toMatchObject({ standing: [], passed: ['SHADE'] })
  })

  it('shows the office who signed only behind the site’s gate (Owner answer W1)', async () => {
    const log = await ok('manager', 'GET', `/production/cutting/work-orders/${wo.id}/cut-log`)
    const signed = (log.entries as Json[]).find((entry) => entry.overrides.length > 0)!
    expect(signed).toMatchObject({ overrides: ['SHADE'], overrideReason: 'Checked by eye: it is fine', overrideLead: null, overrideLeadHidden: true })
  })
})

describe('thickness against the spec (MES-064)', () => {
  it('warns about a hide recorded thinner than the spec; Cut anyway asks the measure at the table first', async () => {
    const card = await scan('THIN-1')
    expect(card.checks.thickness).toEqual({ verdict: 'THIN', valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' })
    expect(card.checks.standing).toEqual(['THICKNESS'])
    expect(pathsOf(await no('cutter', 'POST', cutUrl(), cutBody('THIN-1'), 409))).toEqual(['refusal/CUT_WARNING', 'warnings/THICKNESS/THIN'])
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(cutBody('THIN-1'), { warnings: ['THICKNESS'] }), 400))).toEqual(['body/cut/measuredThicknessMm'])
    // A lead who signed for another warning does not pass this one.
    expect(pathsOf(await no('cutter', 'POST', anywayUrl(), anyway(cutBody('THIN-1', { measuredThicknessMm: '0.98' })), 409))).toEqual(['refusal/CUT_WARNING', 'warnings/THICKNESS/THIN'])
    expect(await cutsOf('THIN-1')).toBe(0)
  })

  it('takes the measure at the table over the record: inside the spec it cuts, recorded with the entry', async () => {
    const answer = await ok('cutter', 'POST', cutUrl(), cutBody('THIN-1', { measuredThicknessMm: '1.15' }), 201)
    expect(answer.cut).toMatchObject({ measuredThicknessMm: '1.15', overrides: [] })
    expect(await entryOf(answer.cut.id)).toMatchObject({ measuredThicknessMm: '1.15', overrides: [] })
    expect(pathsOf(await no('cutter', 'POST', cutUrl(), cutBody('THIN-2', { measuredThicknessMm: '100' }), 400))).toEqual(['body/measuredThicknessMm'])
  })

  it('cuts anyway with the measure the lead saw', async () => {
    const body = cutBody('THIN-2', { measuredThicknessMm: '0.98' })
    const answer = await ok('cutter', 'POST', anywayUrl(), anyway(body, { warnings: ['THICKNESS'], reasonCode: 'HIDDEN_PARTS' }), 201)
    expect(answer.override).toEqual({ overrides: ['THICKNESS'], reasonCode: 'HIDDEN_PARTS' })
    expect(await entryOf(answer.cut.id)).toMatchObject({ measuredThicknessMm: '0.98', overrides: ['THICKNESS'], overrideLeadWorkerId: lead, overrideReason: 'For inner or hidden parts' })
  })
})

describe('the pieces’ minimum grade (MES-055, B-W2b-95)', () => {
  it('names the pieces a grade-C hide may not make; other pieces cut, the one asking B is stopped', async () => {
    const card = await scan('GRADE-C')
    expect(card.checks.grade).toEqual({ hide: 'C', byText: true, pieces: [{ name: 'Front', minGrade: 'B', verdict: 'BELOW' }] })
    expect(card.checks.warnings).toEqual([expect.objectContaining({ kind: 'GRADE', code: 'BELOW', grade: { hideGrade: 'C', pieces: [{ name: 'Front', minGrade: 'B' }] } })])
    // A part no pattern piece asks a grade of (a recut collar by name) is cut from it.
    const collar = await ok('cutter', 'POST', cutUrl(), cutBody('GRADE-C', { lines: [{ workOrderSizeId: blkCell, parts: [{ part: 'Collar', pieces: 1 }] }] }), 201)
    expect(collar.cut.overrides).toEqual([])
    const error = await no('cutter', 'POST', cutUrl(), cutBody('GRADE-C'), 409)
    expect(pathsOf(error)).toEqual(['refusal/CUT_WARNING', 'warnings/GRADE/BELOW'])
    expect(error.message).toContain('Front asks B or better')
  })
})

describe('the wrong hide (MES-063) and the photo of the hide (MES-060)', () => {
  const bytes = Buffer.from(`made-up hide on the table ${run}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  /** A photo of the hide taken at the table: announced, sent to the store, confirmed. */
  async function photo(hide: string): Promise<string> {
    const answer = await ok('cutter', 'POST', `/production/cutting/hides/${hides[hide]!.id}/photos`, { originalName: 'hide.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256 }, 201, cid('photo'))
    expect(answer.file).toMatchObject({ kind: 'PHOTO', recordType: 'Hide', recordId: hides[hide]!.id })
    const sent = await app.inject({ method: 'PUT', url: answer.upload.url, headers: answer.upload.headers, payload: bytes })
    expect(sent.statusCode, sent.body).toBeLessThan(300)
    return (await ok('cutter', 'POST', `/production/cutting/hides/${hides[hide]!.id}/photos/${answer.file.id}/complete`, undefined, 200, cid('complete'))).file.id
  }

  it('warns about a hide that is not the one reserved for the work order, naming the reserved one', async () => {
    await ok('reserver', 'POST', '/inventory/reservations', { siteId: siteA1, workOrderId: wo.id, lines: [{ hideId: hides['RES-1']!.id }] }, 201, cid('reserve'))
    const card = await scan('RES-2')
    expect(card.checks.reserved).toEqual({ forIt: false, hides: [hides['RES-1']!.code], lots: ['SEED-LOT-LEA-01'] })
    expect(card.checks.warnings).toEqual([
      expect.objectContaining({
        kind: 'WRONG_HIDE',
        code: 'NOT_RESERVED',
        wrongHide: { reservedHides: [{ code: hides['RES-1']!.code, lotCode: 'SEED-LOT-LEA-01', grade: 'A' }], reservedLots: ['SEED-LOT-LEA-01'], differs: [], hide: { lotCode: 'SEED-LOT-LEA-01', grade: 'A' } },
      }),
    ])
    expect(pathsOf(await no('cutter', 'POST', cutUrl(), cutBody('RES-2'), 409))).toEqual(['refusal/CUT_WARNING', 'warnings/WRONG_HIDE/NOT_RESERVED'])
    expect((await scan('RES-1')).checks).toMatchObject({ warnings: [], standing: [], reserved: { forIt: true } })
  })

  it('cuts the reserved hide with its photo, stored with the hide and named by the entry; another hide’s photo is refused', async () => {
    const own = await photo('RES-1')
    const others = await photo('RES-2')
    expect(pathsOf(await no('cutter', 'POST', cutUrl(), cutBody('RES-1', { photoFileId: others }), 400))).toEqual(['body/photoFileId'])
    const answer = await ok('cutter', 'POST', cutUrl(), cutBody('RES-1', { photoFileId: own }), 201)
    expect(answer.cut).toMatchObject({ photoFileId: own, overrides: [] })
    expect(await entryOf(answer.cut.id)).toMatchObject({ photoFileId: own })
    expect(await admin(`SELECT "recordType", "recordId", visibility::text[] AS visibility, "floorSiteId" FROM "StoredFile" WHERE id = $1`, [own])).toEqual([{ recordType: 'Hide', recordId: hides['RES-1']!.id, visibility: ['OFFICE', 'FLOOR'], floorSiteId: siteA1 }])
    // The reserved hide is issued: nothing waits any more, so the other one is no longer the wrong hide.
    expect((await scan('RES-2')).checks.standing).toEqual([])
  })
})

describe('B-W2b-219: the site\'s shade rule and the photo before cutting (Floor rules & codes › Cutting)', () => {
  /** The site's cutting rules from now on, through the office's route at the version read. */
  async function setRules(change: Json): Promise<Json> {
    const now = await ok('rules', 'GET', `/production/settings/${siteA1}/cutting-rules`)
    return ok('rules', 'POST', `/production/settings/${siteA1}/cutting-rules`, { ...change, ...(now.version === null ? {} : { version: now.version }) }, 200, cid('rules'))
  }
  async function photoOf(hide: string): Promise<string> {
    const bytes = Buffer.from(`made-up photo of ${hide} ${run}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const answer = await ok('cutter', 'POST', `/production/cutting/hides/${hides[hide]!.id}/photos`, { originalName: 'hide.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256 }, 201, cid('photo'))
    const sent = await app.inject({ method: 'PUT', url: answer.upload.url, headers: answer.upload.headers, payload: bytes })
    expect(sent.statusCode, sent.body).toBeLessThan(300)
    return (await ok('cutter', 'POST', `/production/cutting/hides/${hides[hide]!.id}/photos/${answer.file.id}/complete`, undefined, 200, cid('complete'))).file.id
  }

  it('reads the site\'s rule: OFF checks no shade lot, GARMENT none for the whole order, ORDER warns again', async () => {
    // OTHER-LOT's SHADE was passed by a lead above (it no longer stands): the warnings themselves say what the rule checks.
    const kinds = (card: Json): string[] => (card.checks.warnings as Json[]).map((warning) => warning.kind)
    expect(kinds(await scan('OTHER-LOT'))).toContain('SHADE')
    expect((await setRules({ shadeRule: 'OFF' })).rules.shadeRule).toBe('OFF')
    const off = await scan('OTHER-LOT')
    expect(off.checks.shade.rule).toBe('OFF')
    expect(kinds(off)).not.toContain('SHADE')
    await setRules({ shadeRule: 'GARMENT' })
    const garment = await scan('OTHER-LOT')
    expect(garment.checks.shade.rule).toBe('GARMENT')
    expect(kinds(garment)).not.toContain('SHADE')
    await setRules({ shadeRule: 'ORDER' })
    expect(kinds(await scan('OTHER-LOT'))).toContain('SHADE')
  })

  it('asks a photo before the first cut of a hide where the site says so: refused in words without it, then not again', async () => {
    await setRules({ hidePhotoRequired: true })
    expect((await scan('RES-2')).checks.photo).toEqual({ required: true })
    // RES-1 was cut with its photo (above): it was on the table already.
    expect((await scan('RES-1')).checks.photo).toEqual({ required: false })
    const before = await cutsOf('RES-2')
    const error = await no('cutter', 'POST', cutUrl(), cutBody('RES-2'), 409)
    expect(pathsOf(error)).toEqual(['refusal/PHOTO_REQUIRED'])
    expect(error.message).toBe(`This site asks a photo of hide ${hides['RES-2']!.code} on the table before it is cut: take the photo, then cut.`)
    expect(await cutsOf('RES-2')).toBe(before)
    const photo = await photoOf('RES-2')
    expect((await ok('cutter', 'POST', cutUrl(), cutBody('RES-2', { photoFileId: photo }), 201)).cut).toMatchObject({ photoFileId: photo })
    // Photographed once: its next entry needs none.
    expect((await scan('RES-2')).checks.photo).toEqual({ required: false })
    await ok('cutter', 'POST', cutUrl(), cutBody('RES-2'), 201)
    await setRules({ hidePhotoRequired: false })
  })
})
