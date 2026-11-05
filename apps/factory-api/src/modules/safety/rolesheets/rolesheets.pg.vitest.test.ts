import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedHealth } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Role risk sheets (B-W2b-128; QHS-236, QHS-253) on the local stack: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login: row-level security and the safety and health guards are real: a kit line names an ACTIVE item of the
 * sheet's company, a plan is one per role and asks 1 to 60 months only when needed, a person's sheet is of their site), the
 * real app. Tenant A from the factory-db seeds up to the health pages: A1's Cutter (E1; plan 12 months), Machinist (E2, E3;
 * plan 24 months), B1's Machinist (EB1; not needed); the courses, PPE items, records and issues. Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/safety/rolesheets`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let people: PeopleSeed

const NS = 'w2b128-rolesheets'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const OFFICER: Permission[] = ['safety.view', 'safety.rolesheets.manage', 'safety.organisation.manage']
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER)] },
  // HR keeps the register and is a health reader (the hr template holds safety.organisation.manage).
  hr: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view', 'people.employees.manage', 'safety.view', 'safety.organisation.manage'])] },
  // An administrator keeps the register but reads no health need.
  admin: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view', 'people.employees.manage'])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view', 'people.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `rolesheets-${++keys}-${newId()}`
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
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)

/** The whole content of a sheet as the screen sends it back (what GET says, made editable). */
const contentOf = (sheet: Json) => ({
  items: sheet.items.map((item: Json) => ({ kind: item.kind, title: item.title, note: item.note })),
  kit: sheet.kit.map((line: Json) => ({ ppeItemId: line.ppeItemId, quantity: line.quantity, whenToWear: line.whenToWear, note: line.note })),
  requirements: sheet.requirements.map((line: Json) => ({ courseId: line.courseId, withinDays: line.withinDays, note: line.note })),
})

beforeAll(async () => {
  h = await startHarness('w2b128_rolesheets')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedHealth({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the role sheets (QHS-236; design plant.risk "Role sheets")', () => {
  it('lists the roles with their people, risks, PPE items, courses and surveillance; a role of another company stays out', async () => {
    const list = await ok('officer', 'GET', '/safety/rolesheets')
    expect(list).toMatchObject({ canAdd: true, complete: true, law: { roleSheet: 'D.Lgs. 81/2008 art. 28' }, today })
    const byCode = Object.fromEntries(list.roleSheets.map((row: Json) => [`${row.site.code}:${row.code}`, row]))
    expect(byCode['A1:CUT']).toMatchObject({ people: 1, risks: 2, surveillanceNeeds: 1, ppeItems: 3, courses: 2, surveillance: { needed: true, frequencyMonths: 12 }, canManage: true })
    expect(byCode['A1:SEW']).toMatchObject({ people: 2, risks: 1, surveillanceNeeds: 1, ppeItems: 1, courses: 2, surveillance: { needed: true, frequencyMonths: 24 } })
    expect(byCode['B1:SEW-B']).toMatchObject({ people: 1, ppeItems: 1, courses: 1, surveillance: { needed: false, frequencyMonths: null } })
    expect((await ok('viewer', 'GET', '/safety/rolesheets')).canAdd).toBe(false)
    expect((await ok('companyB', 'GET', '/safety/rolesheets')).roleSheets.map((row: Json) => row.code)).toEqual(['SEW-B'])
    expect((await call('sales', 'GET', '/safety/rolesheets')).statusCode).toBe(403)
  })

  it('opens a sheet: risks and needs, the kit with when to wear it, the courses, the plan and the people (no cost, no supplier)', async () => {
    const answer = await call('viewer', 'GET', `/safety/rolesheets/${safety.roleSheetIds.cutter}`)
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.body).not.toMatch(/unitCost|supplier/)
    const sheet = answer.json().roleSheet
    expect(sheet.items.map((item: Json) => [item.seq, item.kind])).toEqual([
      [1, 'RISK'],
      [2, 'RISK'],
      [3, 'SURVEILLANCE'],
    ])
    expect(sheet.kit.map((line: Json) => [line.item.code, line.quantity, line.whenToWear])).toEqual([
      ['SEED-PPE-GLOVES-CUT', 2, 'At the cutting table'],
      ['SEED-PPE-EAR-DEF', 1, 'At the clicking press'],
      ['SEED-PPE-SHOES', 1, 'Always on the floor'],
    ])
    expect(sheet.requirements.map((line: Json) => [line.course.code, line.withinDays, line.course.hours])).toEqual([
      ['SEED-SC-GEN', null, '4'],
      ['SEED-SC-SPEC-HIGH', 60, '12'],
    ])
    expect(sheet.plan).toMatchObject({ needed: true, frequencyMonths: 12 })
    expect(sheet.peopleInRole).toEqual([{ employeeId: people.employeeIds.e1, name: 'Seed Employee One' }])
    expect((await call('companyB', 'GET', `/safety/rolesheets/${safety.roleSheetIds.cutter}`)).statusCode).toBe(404)
  })

  it('offers the company’s ACTIVE PPE items and the courses to choose from, to those who keep the sheets', async () => {
    const answer = await call('officer', 'GET', `/safety/rolesheets/catalogue?companyId=${T.companyA}`)
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.body).not.toMatch(/unitCost|supplier/)
    expect(answer.json().ppeItems.map((item: Json) => item.code)).toEqual(['SEED-PPE-EAR-DEF', 'SEED-PPE-GLOVES-CUT', 'SEED-PPE-SHOES'])
    expect(answer.json().courses).toHaveLength(6)
    expect((await call('viewer', 'GET', `/safety/rolesheets/catalogue?companyId=${T.companyA}`)).statusCode).toBe(403)
  })

  it('adds a role with its content and its plan in one command; refuses a taken code, another company’s site or item', async () => {
    const base = { companyId: T.companyA, siteId: T.siteA1, name: 'Finisher', nameI18n: { it: 'Rifinitore', en: 'Finisher' } }
    const content = {
      items: [
        { kind: 'RISK', title: 'Glues and solvents' },
        { kind: 'SURVEILLANCE', title: 'Solvent exposure' },
      ],
      kit: [{ ppeItemId: safety.ppeItemIds.gloves, quantity: 1, whenToWear: 'At the finishing bench' }],
      requirements: [{ courseId: safety.courseIds.general, withinDays: null }],
    }
    expect(await no('officer', 'POST', '/safety/rolesheets', { ...base, code: 'cut', content }, 409)).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect(await no('officer', 'POST', '/safety/rolesheets', { ...base, siteId: T.siteB1, code: 'FIN' }, 409)).toEqual(['refusal/SITE_OTHER_COMPANY', 'body/siteId'])
    expect(await no('officer', 'POST', '/safety/rolesheets', { ...base, code: 'FIN', content: { ...content, kit: [{ ppeItemId: safety.ppeItemIds.apron, quantity: 1, whenToWear: 'Always' }] } }, 409)).toEqual([
      'refusal/PPE_ITEM_NOT_AVAILABLE',
      'body/content/kit/0/ppeItemId',
    ])
    expect(await no('officer', 'POST', '/safety/rolesheets', { ...base, code: 'FIN', content: { ...content, items: [content.items[0]] }, surveillance: { needed: true } }, 400)).toEqual(['body/surveillance/needed'])
    expect((await call('viewer', 'POST', '/safety/rolesheets', { ...base, code: 'FIN' })).statusCode).toBe(403)
    const made = (await ok('officer', 'POST', '/safety/rolesheets', { ...base, code: 'fin', content, surveillance: { needed: true } }, 201)).roleSheet
    expect(made).toMatchObject({ code: 'FIN', name: 'Finisher', nameI18n: { it: 'Rifinitore', en: 'Finisher' }, status: 'ACTIVE', people: 0, risks: 1, ppeItems: 1, courses: 1, plan: { needed: true, frequencyMonths: 12, setOn: today } })
    expect(await admin(`SELECT key, needed, "frequencyMonths" FROM "HealthPlan" WHERE "roleSheetId" = $1`, [made.id])).toEqual([{ key: `plan:${made.id}`, needed: true, frequencyMonths: 12 }])
    expect(await eventsOf('role_sheet.changed')).toContainEqual({ roleSheetId: made.id, change: 'ADDED', people: 0, coursesAdded: [safety.courseIds.general], coursesRemoved: [], kitAdded: [safety.ppeItemIds.gloves], kitRemoved: [], surveillance: 'NEEDED' })
  })
})

describe('"What this changes", then Apply (the design: Apply first shows who now needs which course, which kit items, which visits)', () => {
  it('says who now needs a course and an item; Apply writes the sheet, its kit and its courses in one command', async () => {
    const sheet = (await ok('officer', 'GET', `/safety/rolesheets/${safety.roleSheetIds.machinist}`)).roleSheet
    const draft = contentOf(sheet)
    draft.kit.push({ ppeItemId: safety.ppeItemIds.earDefenders, quantity: 1, whenToWear: 'Near the clicking press', note: null })
    draft.requirements.push({ courseId: safety.courseIds.specificHigh, withinDays: 60, note: null })
    draft.requirements = draft.requirements.map((line: Json) => (line.courseId === safety.courseIds.specificMedium ? { ...line, withinDays: 30 } : line))
    const preview = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinist}/preview`, { content: draft })
    expect(preview.people).toBe(2)
    expect(preview.changes).toMatchObject({ kit: { added: [safety.ppeItemIds.earDefenders], removed: [] }, courses: { added: [safety.courseIds.specificHigh] }, surveillance: null, nothing: false })
    const lines = Object.fromEntries(preview.impact.map((line: Json) => [line.kind, line]))
    expect(lines.COURSE_NEEDED).toMatchObject({ courseId: safety.courseIds.specificHigh, people: 2, already: 0, withinDays: { from: null, to: 60 } })
    expect(lines.COURSE_NEEDED.names.map((person: Json) => person.employeeId).sort()).toEqual([people.employeeIds.e2, people.employeeIds.e3].sort())
    // E3's medium-risk course FAILED: the new deadline concerns both.
    expect(lines.COURSE_DEADLINE).toMatchObject({ courseId: safety.courseIds.specificMedium, people: 2, withinDays: { from: 60, to: 30 } })
    expect(lines.KIT_TO_ISSUE).toMatchObject({ ppeItemId: safety.ppeItemIds.earDefenders, people: 2, already: 0, quantity: 1 })
    expect(preview.refs.courses.map((course: Json) => course.code)).toEqual(['SEED-SC-SPEC-MED', 'SEED-SC-SPEC-HIGH'])
    expect(preview.refs.ppeItems.map((item: Json) => item.code)).toEqual(['SEED-PPE-EAR-DEF'])

    expect((await call('viewer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinist}/preview`, { content: draft })).statusCode).toBe(403)
    expect((await call('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinist}/apply`, { version: sheet.version + 1, content: draft, impactFingerprint: preview.fingerprint })).statusCode).toBe(409)
    const applied = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinist}/apply`, { version: sheet.version, content: draft, impactFingerprint: preview.fingerprint })
    expect(applied).toMatchObject({ applied: true, fingerprint: preview.fingerprint, roleSheet: { version: sheet.version + 1, ppeItems: 2, courses: 3 } })
    expect(applied.roleSheet.kit.map((line: Json) => [line.seq, line.item.code])).toEqual([
      [1, 'SEED-PPE-SHOES'],
      [2, 'SEED-PPE-EAR-DEF'],
    ])
    expect(await eventsOf('role_sheet.changed')).toContainEqual({ roleSheetId: safety.roleSheetIds.machinist, change: 'APPLIED', people: 2, coursesAdded: [safety.courseIds.specificHigh], coursesRemoved: [], kitAdded: [safety.ppeItemIds.earDefenders], kitRemoved: [], surveillance: null })
    const audit = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.applyRoleSheet'`, [safety.roleSheetIds.machinist])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ people: 2, surveillanceNeeded: true })

    // The same draft again changes nothing: no new version, no event.
    const again = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinist}/apply`, { version: applied.roleSheet.version, content: draft })
    expect(again).toMatchObject({ applied: false, roleSheet: { version: applied.roleSheet.version }, changes: { nothing: true }, impact: [] })
  })

  it('refuses an Apply whose "What this changes" is no longer what was read (a person joined the role meanwhile)', async () => {
    const sheet = (await ok('officer', 'GET', `/safety/rolesheets/${safety.roleSheetIds.cutter}`)).roleSheet
    const draft = contentOf(sheet)
    draft.kit = draft.kit.map((line: Json) => (line.ppeItemId === safety.ppeItemIds.gloves ? { ...line, quantity: 3 } : line))
    const preview = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.cutter}/preview`, { content: draft })
    expect(preview.impact).toEqual([expect.objectContaining({ kind: 'KIT_TO_ISSUE', ppeItemId: safety.ppeItemIds.gloves, people: 1, quantity: 3 })])
    await admin(`UPDATE "Employee" SET "roleSheetId" = $1 WHERE id = $2`, [safety.roleSheetIds.cutter, people.employeeIds.e4])
    expect(await no('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.cutter}/apply`, { version: sheet.version, content: draft, impactFingerprint: preview.fingerprint }, 409)).toEqual(['refusal/IMPACT_CHANGED'])
    await admin(`UPDATE "Employee" SET "roleSheetId" = NULL WHERE id = $1`, [people.employeeIds.e4])
  })

  it('makes a role need visits (counts only: "1 person gets a yearly visit") and archives a role nobody is in', async () => {
    const sheet = (await ok('officer', 'GET', `/safety/rolesheets/${safety.roleSheetIds.machinistB}`)).roleSheet
    const draft = contentOf(sheet)
    draft.items.push({ kind: 'SURVEILLANCE', title: 'Upper limbs (repetitive movements)', note: null })
    const preview = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinistB}/preview`, { content: draft, surveillance: { needed: true } })
    expect(preview.impact).toEqual([expect.objectContaining({ kind: 'VISITS_NEEDED', people: 1, names: null, frequencyMonths: 12 })])
    expect(preview.changes.surveillanceNeeds.added).toEqual(['Upper limbs (repetitive movements)'])
    const applied = await ok('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinistB}/apply`, { version: sheet.version, content: draft, surveillance: { needed: true }, impactFingerprint: preview.fingerprint })
    expect(applied.roleSheet.plan).toMatchObject({ needed: true, frequencyMonths: 12, setOn: today })
    expect(await admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'HealthPlan' AND action = 'safety.setRoleVisitNeed' AND after->>'roleSheetId' = $1`, [safety.roleSheetIds.machinistB])).toHaveLength(1)

    // Archive: refused while a person is in the role; the finisher (nobody in it) archives and restores.
    expect(await no('officer', 'POST', `/safety/rolesheets/${safety.roleSheetIds.machinistB}/archive`, { version: applied.roleSheet.version }, 409)).toEqual(['refusal/PEOPLE_IN_ROLE'])
    const finisher = (await ok('officer', 'GET', '/safety/rolesheets')).roleSheets.find((row: Json) => row.code === 'FIN')
    const archived = (await ok('officer', 'POST', `/safety/rolesheets/${finisher.id}/archive`, { version: finisher.version })).roleSheet
    expect(archived.status).toBe('ARCHIVED')
    expect(await no('officer', 'POST', `/safety/rolesheets/${finisher.id}/preview`, { content: { items: [], kit: [], requirements: [] } }, 409)).toEqual(['refusal/ARCHIVED'])
    expect((await ok('officer', 'POST', `/safety/rolesheets/${finisher.id}/restore`, { version: archived.version })).roleSheet.status).toBe('ACTIVE')
  })
})

describe('a person’s role (people.employees: "Changing Role opens What this changes before Apply")', () => {
  it('reads the person’s sheet and what it asks; the visit and its reasons only for the health readers', async () => {
    const mine = await ok('hr', 'GET', `/people/employees/${people.employeeIds.e1}/role-sheet`)
    expect(mine).toMatchObject({ roleSheet: { id: safety.roleSheetIds.cutter, code: 'CUT' }, canChange: true, today })
    expect(mine.since).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(mine.asks.courses.map((line: Json) => [line.course.code, line.held])).toEqual([
      ['SEED-SC-GEN', true],
      ['SEED-SC-SPEC-HIGH', false],
    ])
    expect(mine.asks.visits).toEqual({ shown: true, needed: true, frequencyMonths: 12, needs: ['Noise exposure'] })
    expect(mine.choices.map((choice: Json) => choice.code)).toEqual(['CUT', 'FIN', 'SEW'])
    const adminView = await ok('admin', 'GET', `/people/employees/${people.employeeIds.e1}/role-sheet`)
    expect(adminView.asks.visits).toEqual({ shown: false, needed: null, frequencyMonths: null, needs: [] })
    expect((await call('sales', 'GET', `/people/employees/${people.employeeIds.e1}/role-sheet`)).statusCode).toBe(403)
  })

  it('previews a role change, refuses the wrong ones, and applies it with its fingerprint', async () => {
    const url = `/people/employees/${people.employeeIds.e2}/role-sheet`
    const preview = await ok('hr', 'POST', `${url}/preview`, { roleSheetId: safety.roleSheetIds.cutter })
    expect(preview).toMatchObject({ change: 'CHANGE', from: { code: 'SEW' }, to: { code: 'CUT' }, visit: { shown: true, consequence: 'CHANGE_OF_TASK', frequencyMonths: 12 } })
    // The machinist's sheet asks the high-risk course now too (applied above): nothing new there; the medium one goes.
    expect(preview.courses.needed).toEqual([])
    expect(preview.courses.noLonger.map((line: Json) => line.course.code)).toEqual(['SEED-SC-SPEC-MED'])
    expect(preview.kit.toIssue.map((line: Json) => [line.item.code, line.quantity, line.short])).toEqual([['SEED-PPE-GLOVES-CUT', 2, 2]])
    const hidden = await ok('admin', 'POST', `${url}/preview`, { roleSheetId: safety.roleSheetIds.cutter })
    expect(hidden.visit).toEqual({ shown: false, consequence: null, frequencyMonths: null })
    expect(hidden.fingerprint).not.toBe(preview.fingerprint)

    expect(await no('hr', 'POST', `${url}/preview`, { roleSheetId: safety.roleSheetIds.machinistB }, 409)).toEqual(['refusal/ROLE_SHEET_OTHER_SITE', 'body/roleSheetId'])
    expect(await no('hr', 'POST', `/people/employees/${people.employeeIds.e5}/role-sheet/preview`, { roleSheetId: safety.roleSheetIds.cutter }, 409)).toEqual(['refusal/LEFT'])
    expect((await call('viewer', 'POST', `${url}/preview`, { roleSheetId: safety.roleSheetIds.cutter })).statusCode).toBe(403)

    const version = (await ok('hr', 'GET', url)).employee.version
    // What the administrator read (no visit) is not what HR would apply: refused, not applied unseen.
    expect(await no('hr', 'PUT', url, { version, roleSheetId: safety.roleSheetIds.cutter, impactFingerprint: hidden.fingerprint }, 409)).toEqual(['refusal/IMPACT_CHANGED'])
    const set = await ok('hr', 'PUT', url, { version, roleSheetId: safety.roleSheetIds.cutter, impactFingerprint: preview.fingerprint, reason: 'Moved to the cutting room (made-up).' })
    expect(set).toMatchObject({ changed: true, employee: { version: version + 1, roleSheet: { code: 'CUT' } } })
    expect(await admin(`SELECT "roleSheetId" FROM "Employee" WHERE id = $1`, [people.employeeIds.e2])).toEqual([{ roleSheetId: safety.roleSheetIds.cutter }])
    expect(await eventsOf('employee.role_changed')).toContainEqual({ employeeId: people.employeeIds.e2, fromRoleSheetId: safety.roleSheetIds.machinist, toRoleSheetId: safety.roleSheetIds.cutter, by: 'OFFICE' })
    expect(await eventsOf('employee.updated')).toContainEqual({ employeeId: people.employeeIds.e2, change: 'EDITED', fields: ['roleSheetId'], workerId: null, by: 'OFFICE' })
    expect((await ok('hr', 'GET', url)).since).toBe(today)
    // The same sheet again: nothing changes.
    expect(await ok('hr', 'PUT', url, { version: version + 1, roleSheetId: safety.roleSheetIds.cutter })).toMatchObject({ changed: false, employee: { version: version + 1 } })
  })

  it('a move to another site clears the person’s sheet in the same update (a sheet is of one site)', async () => {
    const siteA2 = newId()
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'A2', 'Made-up plant A2', 'PLANT')`, [siteA2, T.tenant, T.companyA])
    const before = (await ok('hr', 'GET', `/people/employees/${people.employeeIds.e3}`)).employee
    const moved = (await ok('hr', 'PATCH', `/people/employees/${people.employeeIds.e3}`, { version: before.version, siteId: siteA2 })).employee
    expect(moved.site.id).toBe(siteA2)
    expect(await admin(`SELECT "roleSheetId" FROM "Employee" WHERE id = $1`, [people.employeeIds.e3])).toEqual([{ roleSheetId: null }])
    expect(await eventsOf('employee.role_changed')).toContainEqual({ employeeId: people.employeeIds.e3, fromRoleSheetId: safety.roleSheetIds.machinist, toRoleSheetId: null, by: 'SITE_MOVE' })
    expect((await eventsOf('employee.updated')).filter((event) => event.employeeId === people.employeeIds.e3).at(-1)).toMatchObject({ change: 'MOVED_SITE', fields: expect.arrayContaining(['siteId', 'roleSheetId']) })
    expect((await ok('hr', 'GET', `/people/employees/${people.employeeIds.e3}/role-sheet`)).roleSheet).toBeNull()
  })
})
