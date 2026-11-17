import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { inTenant, partnerWorld, type PartnerWorld } from '../../../platform/search/partner/testing/world'

/**
 * B-TH-067 — linked records both ways (threads plan TH-5, PROJ-G03, PROJ-G12; wall test T38 / W38: "linking brand B's order to brand
 * A's project is refused"), through the app's real routes on a throwaway PostgreSQL 17 database from the migrations, with every
 * factory-db seed in one namespace: brand A is the seeds' customer and brand P1 (SEED-C1, its private-label style SEED-JKT-01),
 * brand B the two-brands seed's SEED-C2B (its style SEED-JKT-B2, its order SEED-SO-B001), SEED-PO-0101 a purchase order of
 * company B, SEED-PRJ-002 the seeds' office-only project and SEED-PRJ-003 their closed one.
 *
 *   - POST /projects/:id/links links brand A's own style and an open-range style (no party) to brand A's project: one system line
 *     each in the project's thread (an internal note, "Collegato … / Linked …"), project.linked;
 *   - T38: brand B's style and order are refused in words that name no customer (LINK_PARTY), company B's record (LINK_COMPANY),
 *     brand A's record on an office-only project (LINK_OFFICE_ONLY), the same record twice (ALREADY_LINKED); a record the person may
 *     not open is 404 (like one that does not exist); the database refuses brand B's record by itself (the guard, for every login);
 *   - DELETE unlinks (system line, project.unlinked, the audit keeps it); a CLOSED project changes no link;
 *   - GET /projects/of/Style/:id: "In project" for a reader of the project; a person limited to brand B gets 404 on the record;
 *   - POST /projects/:id/links/bulk: the Styles list's "Add to project" links the rows that may join and says why the others did not.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const NS = 'th5-links'
let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let serial = 0

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), lina: newId(), nora: newId() } as const
type Who = keyof typeof PEOPLE
const SESSIONS = new Map<string, SessionContext>()

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => {
  const rows = await admin<R>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}
const call = (who: Who, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-links-${++serial}-${Date.now()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Who, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
/** A refusal: its status, its words and where they are said. */
async function refused(who: Who, method: Method, url: string, payload: unknown, status: number, words: string, path: string): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  const body = response.json() as Json
  expect(body.error.message).toBe(words)
  expect((body.error.issues ?? []).map((issue: Json) => issue.path)).toContain(path)
  return body
}

const ids = { styleA: '', styleB: '', openRange: '', openRange2: '', orderB: '', poOfCompanyB: '', officeOnly: '', closed: '', brandB: '' }
let project: Json = {}
const brandBNames: string[] = []

const lines = async (projectId: string) =>
  admin<{ bodyText: string; direction: string; authorKind: string }>(`SELECT m."bodyText", m.direction, m."authorKind" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."tenantId" = $1 AND t."recordType" = 'Project' AND t."recordId" = $2 ORDER BY m.at, m.id`, [world.tenantId, projectId])
const events = async (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [world.tenantId, type, subject])
const neverNamesBrandB = (body: unknown) => {
  const text = JSON.stringify(body)
  for (const name of brandBNames) expect(text, name).not.toContain(name)
  expect(text).not.toMatch(/another customer|altro cliente/i)
}

beforeAll(async () => {
  h = await startHarness('th5_links')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const T = world.tenantId
  ids.brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [T])).id
  const b = await one<{ legalName: string; tradeName: string | null }>('SELECT "legalName", "tradeName" FROM "Party" WHERE id = $1', [ids.brandB])
  brandBNames.push('SEED-C2B', b.legalName, ...(b.tradeName ? [b.tradeName] : []))
  ids.styleA = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01' AND "brandPartyId" = $2`, [T, world.p1])).id
  ids.styleB = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-B2' AND "brandPartyId" = $2`, [T, ids.brandB])).id
  const open = await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND "brandPartyId" IS NULL AND ("companyId" IS NULL OR "companyId" = $2) ORDER BY code LIMIT 2`, [T, world.companyA])
  expect(open.length).toBe(2)
  ids.openRange = open[0]!.id
  ids.openRange2 = open[1]!.id
  ids.orderB = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-B001'`, [T])).id
  ids.poOfCompanyB = (await one<{ id: string }>(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0101'`, [T])).id
  ids.officeOnly = (await one<{ id: string }>(`SELECT id FROM "Project" WHERE "tenantId" = $1 AND number = 'SEED-PRJ-002' AND "partyId" IS NULL`, [T])).id
  ids.closed = (await one<{ id: string }>(`SELECT id FROM "Project" WHERE "tenantId" = $1 AND number = 'SEED-PRJ-003' AND status = 'CLOSED'`, [T])).id

  // Office people with live roles (the lead and the people checks read the roles the database holds): Ada keeps projects over every
  // customer; Lina is Sales limited to brand B; Nora keeps projects but may not open styles (no product.styles.view in her session).
  const sales = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  for (const [who, userId] of Object.entries(PEOPLE) as [Who, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-links-${who}@example.test`, `Made-up ${who}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, userId, sales, who === 'lina' ? [ids.brandB] : []])
  }
  const keeper = [...permissionsOf('sales'), 'product.styles.view', 'purchasing.view', 'sales.samples.view'] as Permission[]
  SESSIONS.set('ada', { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(keeper)] })
  SESSIONS.set('lina', { audience: 'office', tenantId: T, actorId: PEOPLE.lina, grants: [grant(keeper, [ids.brandB])] })
  SESSIONS.set('nora', { audience: 'office', tenantId: T, actorId: PEOPLE.nora, grants: [grant(['threads.read', 'threads.post', 'projects.manage', 'orders.view'] as Permission[])] })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS.get(String(request.headers['x-test-session'])) ?? null) },
  )
  // Brand A's new project, made by Ada (she leads it), due in two months.
  const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
  project = (await ok('ada', 'POST', '/projects', { companyId: world.companyA, name: 'Made-up airbag line', partyId: world.p1, targetDate: due }, 201)).project
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-067: linked records both ways', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('links brand A’s own style and a record of no party; a system line each in the thread, project.linked', async () => {
    expect(project).toMatchObject({ party: { id: world.p1 }, status: 'ACTIVE', officeOnly: false })
    const before = (await lines(project.id)).length
    const first = await ok('ada', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.styleA, note: 'Made-up: the base jacket.' })
    expect(first.link).toMatchObject({ recordType: 'Style', recordId: ids.styleA })
    const second = await ok('ada', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.openRange })
    expect(second.links.count).toBe(2)
    expect(second.links.records.map((row: Json) => row.recordId).sort()).toEqual([ids.styleA, ids.openRange].sort())
    expect(second.links.records.find((row: Json) => row.recordId === ids.styleA)).toMatchObject({ group: 'STYLES', label: 'SEED-JKT-01', mayOpen: true, note: 'Made-up: the base jacket.', linkedBy: { id: PEOPLE.ada, name: 'Made-up ada' } })
    const after = await lines(project.id)
    expect(after.length).toBe(before + 2)
    expect(after.at(-2)).toMatchObject({ direction: 'INTERNAL_NOTE', authorKind: 'SYSTEM' })
    expect(after.at(-2)!.bodyText).toMatch(/^Collegato SEED-JKT-01 · da Made-up ada \/ Linked SEED-JKT-01 · by Made-up ada$/)
    expect((await events('project.linked', project.id)).map((row) => row.payload.recordId)).toEqual([ids.styleA, ids.openRange])
    // The link names its project's outside company (copied by the database, never by the app).
    expect((await one<{ partyId: string }>(`SELECT "partyId" FROM "ProjectLink" WHERE "projectId" = $1 AND "recordId" = $2`, [project.id, ids.styleA])).partyId).toBe(world.p1)
  })

  it('T38: brand B’s style and order are refused in words that name no customer; company B’s record, an office-only project and a second link too', async () => {
    const url = `/projects/${project.id}/links`
    neverNamesBrandB(await refused('ada', 'POST', url, { recordType: 'Style', recordId: ids.styleB }, 409, PROJECT_REFUSALS.LINK_PARTY.en, 'body/recordId'))
    neverNamesBrandB(await refused('ada', 'POST', url, { recordType: 'SalesOrder', recordId: ids.orderB }, 409, PROJECT_REFUSALS.LINK_PARTY.en, 'body/recordId'))
    await refused('ada', 'POST', url, { recordType: 'PurchaseOrder', recordId: ids.poOfCompanyB }, 409, PROJECT_REFUSALS.LINK_COMPANY.en, 'body/recordId')
    await refused('ada', 'POST', `/projects/${ids.officeOnly}/links`, { recordType: 'Style', recordId: ids.styleA }, 409, PROJECT_REFUSALS.LINK_OFFICE_ONLY.en, 'body/recordId')
    await refused('ada', 'POST', url, { recordType: 'Style', recordId: ids.styleA }, 409, PROJECT_REFUSALS.ALREADY_LINKED.en, 'body/recordId')
    await refused('ada', 'POST', url, { recordType: 'WorkOrder', recordId: newId() }, 409, PROJECT_REFUSALS.LINK_TYPE.en, 'body/recordType')
    // Nothing of brand B joined; nothing was written for the refusals.
    expect(await admin(`SELECT id FROM "ProjectLink" WHERE "recordId" = ANY($1::uuid[])`, [[ids.styleB, ids.orderB, ids.poOfCompanyB]])).toEqual([])
  })

  it('T38: a record the person may not open is not found, as one that does not exist', async () => {
    // Nora may not open styles at all; Lina is limited to brand B and does not even find brand A's project.
    expect((await call('nora', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.openRange2 })).statusCode).toBe(404)
    expect((await call('ada', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: newId() })).statusCode).toBe(404)
    expect((await call('lina', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.openRange2 })).statusCode).toBe(404)
  })

  it('T38: the database refuses brand B’s record in brand A’s project by itself, for every login', async () => {
    // As the database owner (the guards hold for every login, the owner included); the link's party is copied by the database.
    await expect(
      admin(`INSERT INTO "ProjectLink" (id, "tenantId", "projectId", "recordType", "recordId", key, "createdAt") VALUES ($1, $2, $3, 'Style', $4, $5, now())`, [newId(), world.tenantId, project.id, ids.styleB, `link:${project.id}:Style:${ids.styleB}`]),
    ).rejects.toThrow(/belongs to another company; it cannot join this project/)
    // Nor through the office's own scope (the app's login).
    await expect(
      inTenant(h, world, (client) =>
        client.projectLink.create({ data: { id: newId(), projectId: project.id, recordType: 'Style', recordId: ids.styleB, key: `link:${project.id}:Style:${ids.styleB}`, createdAt: new Date() }, select: { id: true } }),
      ),
    ).rejects.toThrow()
    expect(await admin(`SELECT id FROM "ProjectLink" WHERE "recordId" = $1`, [ids.styleB])).toEqual([])
  })

  it('“In project” for any record: listed to a reader of the project; a person limited to brand B gets 404 on the record', async () => {
    const seen = await ok('ada', 'GET', `/projects/of/Style/${ids.styleA}`)
    expect(seen.projects.map((row: Json) => row.id)).toContain(project.id)
    expect(seen.projects.find((row: Json) => row.id === project.id)).toMatchObject({ number: project.number, name: 'Made-up airbag line', status: 'ACTIVE' })
    expect(seen.count).toBe(seen.projects.length)
    expect((await call('lina', 'GET', `/projects/of/Style/${ids.styleA}`)).statusCode).toBe(404)
    // Brand B's own style is in no project of brand A.
    expect((await ok('lina', 'GET', `/projects/of/Style/${ids.styleB}`)).projects).toEqual([])
  })

  it('“Add to project” in bulk: the rows that may join are linked, the others said with their reason; one system line', async () => {
    const before = (await lines(project.id)).length
    const unknown = newId()
    const answer = await ok('ada', 'POST', `/projects/${project.id}/links/bulk`, { recordType: 'Style', recordIds: [ids.openRange2, ids.styleB, ids.styleA, unknown] })
    expect(answer.linked).toBe(1)
    expect(answer.skipped).toEqual(
      expect.arrayContaining([
        { recordId: ids.styleB, code: 'LINK_PARTY', words: PROJECT_REFUSALS.LINK_PARTY },
        { recordId: ids.styleA, code: 'ALREADY_LINKED', words: PROJECT_REFUSALS.ALREADY_LINKED },
        expect.objectContaining({ recordId: unknown, code: 'MISSING' }),
      ]),
    )
    neverNamesBrandB(answer.skipped)
    expect((await lines(project.id)).length).toBe(before + 1)
    expect(answer.links.records.map((row: Json) => row.recordId)).toContain(ids.openRange2)
  })

  it('unlinks: a system line, project.unlinked, the audit keeps it; a CLOSED project changes no link', async () => {
    const page = await ok('ada', 'GET', `/projects/${project.id}`)
    const link = page.links.records.find((row: Json) => row.recordId === ids.openRange)
    const before = (await lines(project.id)).length
    const answer = await ok('ada', 'DELETE', `/projects/${project.id}/links/${link.linkId}`)
    expect(answer.links.records.map((row: Json) => row.recordId)).not.toContain(ids.openRange)
    const after = await lines(project.id)
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)!.bodyText).toMatch(/^Scollegato .+ \/ Unlinked .+ · by Made-up ada$/)
    expect((await events('project.unlinked', project.id)).map((row) => row.payload.linkId)).toEqual([link.linkId])
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND action = 'projects.unlink'`, [world.tenantId, project.id])).toHaveLength(1)
    // Closed: no new link, no unlink (reopen it first).
    const kept = page.links.records.find((row: Json) => row.recordId === ids.styleA)
    const fresh = (await ok('ada', 'GET', `/projects/${project.id}`)).project
    await ok('ada', 'POST', `/projects/${project.id}/close`, { version: fresh.version, outcome: 'STOPPED', outcomeNote: 'Made-up: paused for the season.' })
    await refused('ada', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.openRange }, 409, PROJECT_REFUSALS.CLOSED.en, 'refusal/CLOSED')
    await refused('ada', 'DELETE', `/projects/${project.id}/links/${kept.linkId}`, undefined, 409, PROJECT_REFUSALS.CLOSED.en, 'refusal/CLOSED')
    await refused('ada', 'POST', `/projects/${ids.closed}/links`, { recordType: 'Style', recordId: ids.styleA }, 409, PROJECT_REFUSALS.CLOSED.en, 'refusal/CLOSED')
  })
})
