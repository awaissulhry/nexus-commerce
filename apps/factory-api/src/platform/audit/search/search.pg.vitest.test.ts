import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addressHashOf } from '../security-events/address'
import { auditSearchExport } from './export-source'

/**
 * The audit viewer's search (B-W2b-399; PLT-077) and the field lines of every record's timeline (PLT-076): every filter, an
 * address through the sessions signed in from it, the lines "price 480 → 520" with money only by grain, one entry with its
 * request's other rows and the session's country, the caller's scope; the timeline's lines by name ("by Marco") with the
 * values only for audit.read; the export of a search reads the same rows.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenant = newId()
const companyOne = newId()
const companyTwo = newId()
const marco = newId()
const lucia = newId()
const signedIn = newId()
const quote = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  auditor: { audience: 'office', tenantId: tenant, actorId: lucia, grants: [grant(['audit.read', 'threads.read', 'money.price'])] },
  'no-money': { audience: 'office', tenantId: tenant, actorId: lucia, grants: [grant(['audit.read', 'threads.read'])] },
  'company-two': { audience: 'office', tenantId: tenant, actorId: lucia, grants: [grant(['audit.read'], [companyTwo])] },
  reader: { audience: 'office', tenantId: tenant, actorId: lucia, grants: [grant(['threads.read', 'money.price'])] },
}
const get = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
type Line = { field: string; from: unknown; to: unknown; hidden: string | null }
type Entry = { id: string; action: string; actorName: string | null; lines: Line[]; recordType: string; recordId: string; before: unknown; after: unknown }

async function row(at: string, action: string, extra: { actorId?: string; companyId?: string | null; recordType?: string; recordId?: string; requestId?: string; before?: object; after?: object; audience?: string } = {}): Promise<string> {
  const id = newId()
  await db.admin.query(
    `INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", before, after, "requestId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, tenant, extra.companyId === undefined ? companyOne : extra.companyId, at, extra.audience ?? 'OFFICE', extra.actorId ?? marco, action, extra.recordType ?? 'Company', extra.recordId ?? companyOne, JSON.stringify(extra.before ?? {}), JSON.stringify(extra.after ?? {}), extra.requestId ?? `req-${id}`],
  )
  return id
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('audit_search')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'as-a'])
  for (const [index, companyId] of [companyOne, companyTwo].entries()) await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenant, `as-${index}`])
  for (const [id, email, name] of [[marco, 'marco.demo@example.com', 'Marco Demo'], [lucia, 'lucia.demo@example.com', 'Lucia Demo']] as const) {
    await db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName") VALUES ($1, $2, $3, $4)`, [id, tenant, email, name])
  }
  // Marco signed in from 192.0.2.10 between 09:00 and 11:00 (the session's country known).
  await db.admin.query(
    `INSERT INTO "Session" (id, "tenantId", "userId", "tokenHash", "createdAt", "lastSeenAt", "idleExpiresAt", "absoluteExpiresAt", "ipHash", "ipCountry", "revokedAt", "revokedReason")
     VALUES ($1, $2, $3, $4, '2026-11-02T09:00:00Z', '2026-11-02T10:30:00Z', '2026-11-02T18:30:00Z', '2026-11-09T09:00:00Z', $5, 'IT', '2026-11-02T11:00:00Z', 'SIGNED_OUT')`,
    [signedIn, tenant, marco, 'f'.repeat(64), addressHashOf('192.0.2.10', 'ip')],
  )
  ids.price = await row('2026-11-02T10:42:00Z', 'quotes.changePrice', { recordType: 'Company', recordId: companyOne, requestId: 'req-price', before: { status: 'DRAFT', unitPrice: { $money: 'price', value: '480.00' }, standardCost: { $money: 'cost', value: '300.00' } }, after: { status: 'SENT', unitPrice: { $money: 'price', value: '520.00' }, standardCost: { $money: 'cost', value: '310.00' } } })
  ids.sibling = await row('2026-11-02T10:42:00Z', 'quotes.touch', { recordType: 'Company', recordId: companyOne, requestId: 'req-price', after: { touched: true } })
  ids.late = await row('2026-11-02T12:00:00Z', 'roles.assign', { recordType: 'RoleAssignment', recordId: newId(), companyId: null, after: { roleKey: 'sales' } })
  ids.other = await row('2026-11-02T10:00:00Z', 'org.editCompany', { companyId: companyTwo, recordType: 'Company', recordId: companyTwo, before: { name: 'Old' }, after: { name: 'New' } })
  ids.lucia = await row('2026-11-02T10:05:00Z', 'quotes.create', { actorId: lucia, recordType: 'Company', recordId: quote, after: { status: 'DRAFT' } })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the search', () => {
  it('every filter; the lines with money only by grain (a grain the reader lacks named as hidden); the actor by name', async () => {
    const all = await get('auditor', '/audit/search')
    expect(all.statusCode, all.body).toBe(200)
    const entries = all.json().entries as Entry[]
    // Newest first; the two rows of one request at the same time by id (the later id first).
    expect(entries.map((entry) => entry.id)).toEqual([ids.late, ids.sibling, ids.price, ids.lucia, ids.other])
    const price = entries.find((entry) => entry.id === ids.price)!
    expect(price.actorName).toBe('Marco Demo')
    expect(price.lines).toEqual([
      { field: 'standardCost', from: null, to: null, hidden: 'GRAIN' },
      { field: 'status', from: 'DRAFT', to: 'SENT', hidden: null },
      // The app's grain filter hands a held amount over as its value.
      { field: 'unitPrice', from: '480.00', to: '520.00', hidden: null },
    ])
    const noMoney = ((await get('no-money', '/audit/search?action=quotes.changePrice')).json().entries as Entry[])[0]!
    expect(noMoney.lines.map((line) => [line.field, line.hidden])).toEqual([['standardCost', 'GRAIN'], ['status', null], ['unitPrice', 'GRAIN']])

    const ids_ = async (query: string) => ((await get('auditor', `/audit/search?${query}`)).json().entries as Entry[]).map((entry) => entry.id).sort()
    expect(await ids_(`actorId=${lucia}`)).toEqual([ids.lucia])
    expect(await ids_('action=quotes.')).toEqual([ids.price, ids.sibling, ids.lucia].sort())
    expect(await ids_(`recordType=Company&recordId=${companyTwo}`)).toEqual([ids.other])
    expect(await ids_('requestId=req-price')).toEqual([ids.price, ids.sibling].sort())
    expect(await ids_('view=roles')).toEqual([ids.late])
    expect(await ids_('from=2026-11-02T10:30:00Z&to=2026-11-02T11:00:00Z')).toEqual([ids.price, ids.sibling].sort())
    expect(await ids_(`companyId=${companyTwo}`)).toEqual([ids.other])
  })

  it('an address: the rows of the people signed in from it while their session lived', async () => {
    const answer = (await get('auditor', '/audit/search?ip=192.0.2.10')).json()
    expect(answer.ipMatch).toBe('SESSIONS')
    // Marco's rows from 09:00 to 11:00 (signed out): not Lucia's, not Marco's at 12:00.
    expect((answer.entries as Entry[]).map((entry) => entry.id).sort()).toEqual([ids.price, ids.sibling, ids.other].sort())
    expect((await get('auditor', '/audit/search?ip=198.51.100.7')).json().entries).toEqual([])
    expect((await get('auditor', '/audit/search?ip=nope')).statusCode).toBe(400)
  })

  it('the caller’s scope: a role of one company sees its rows and the tenant-wide ones', async () => {
    const seen = ((await get('company-two', '/audit/search')).json().entries as Entry[]).map((entry) => entry.id).sort()
    expect(seen).toEqual([ids.other, ids.late].sort())
  })
})

describe('one entry', () => {
  it('before and after, its lines, the other rows of its request, the session’s country; another company’s is not found', async () => {
    const answer = await get('auditor', `/audit/entries/${ids.price}`)
    expect(answer.statusCode, answer.body).toBe(200)
    const body = answer.json()
    expect(body.entry).toMatchObject({ id: ids.price, recordType: 'Company', recordId: companyOne, before: { status: 'DRAFT', unitPrice: '480.00' }, actorName: 'Marco Demo' })
    // The cost the reader lacks never travels, in the values or the lines.
    expect(JSON.stringify(body.entry.before)).not.toContain('300.00')
    expect(body.context).toEqual({ ipCountry: 'IT', serverTime: '2026-11-02T10:42:00.000Z', deviceTime: null })
    expect(body.siblings.map((sibling: { id: string }) => sibling.id)).toEqual([ids.sibling])
    expect((await get('company-two', `/audit/entries/${ids.price}`)).statusCode).toBe(404)
    expect((await get('auditor', `/audit/entries/${newId()}`)).statusCode).toBe(404)
    // Lucia's row: no session of hers known, no country.
    expect((await get('auditor', `/audit/entries/${ids.lucia}`)).json().context.ipCountry).toBeNull()
  })
})

describe('the timeline shows the field lines between the comments', () => {
  it('"unitPrice 480 → 520 by Marco Demo"; values only with audit.read; a grain the reader lacks is not even named', async () => {
    const timeline = await get('auditor', `/threads/Company/${companyOne}/timeline?kinds=change`)
    expect(timeline.statusCode, timeline.body).toBe(200)
    const change = (timeline.json().entries as { id: string; actor: { name: string | null }; fields: string[]; lines: Line[] }[]).find((entry) => entry.id === ids.price)!
    expect(change.actor.name).toBe('Marco Demo')
    expect(change.lines).toEqual([
      { field: 'status', from: 'DRAFT', to: 'SENT', hidden: null },
      { field: 'unitPrice', from: '480.00', to: '520.00', hidden: null },
    ])
    expect(change.lines.map((line) => line.field)).toEqual(change.fields)
    const reader = (await get('reader', `/threads/Company/${companyOne}/timeline?kinds=change`)).json().entries.find((entry: { id: string }) => entry.id === ids.price)
    expect(reader.lines).toEqual([
      { field: 'status', from: null, to: null, hidden: 'VALUES' },
      { field: 'unitPrice', from: null, to: null, hidden: 'VALUES' },
    ])
  })
})

describe('the export of a search', () => {
  it('reads the same rows as the screen, from the page’s address', async () => {
    const query = auditSearchExport.query(new URLSearchParams('area=quotes&who=' + marco))
    expect(query).toEqual({ action: 'quotes.', actorId: marco })
    const caller = callerFor(database, { ...SESSIONS.auditor!, requestId: 'test-export' } as never)
    const page = await auditSearchExport.read(caller, query, null, 10)
    expect((page.rows as Entry[]).map((entry) => entry.id).sort()).toEqual([ids.price, ids.sibling].sort())
    const words = (code: string) => (code === 'hidden' ? 'hidden' : code)
    const price = (page.rows as Entry[]).find((entry) => entry.id === ids.price)!
    expect(auditSearchExport.columns.changed!.value(price, words)).toBe('standardCost (hidden); status: DRAFT → SENT; unitPrice: 480.00 → 520.00')
    expect(auditSearchExport.columns.who!.value(price, words)).toBe('Marco Demo')
  })
})
