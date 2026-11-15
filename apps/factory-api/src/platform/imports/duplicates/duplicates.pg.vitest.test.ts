import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedParties } from '../../../../../../packages/factory-db/seed/parties'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../files/service'
import { createGateway } from '../../gateway/gateway'
import { systemContext } from '../../outbox/system'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { useImporters } from '../registry'
import { applyPlan, planImport } from '../worker'

/**
 * B-W2b-427 — likely duplicates through the real routes: the check on create (parties and materials), the list of
 * possible duplicates, an import's check before and after its apply, and the merge (preview, refusals in words, the
 * command: parts moved, the duplicate archived, audit rows and events). A throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, grants and triggers are real), the seeds' parties (SEED-C1 a
 * tenant-wide customer with a VAT number and contacts at example.com and many records pointing to it; SEED-S1 company A's
 * supplier), made-up parties and materials made through their own routes. Every name, code and number is made up. Run
 * with `node scripts/factory/run-pg-tests.mjs platform/imports/duplicates`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'duplicates-w2b427'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyB = seedId('company:B')
const C1 = seedId('party:P1')
const S1 = seedId('party:P2')

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read', 'audit.read']
const RECORDS: Permission[] = ['parties.view', 'parties.manage', 'product.materials.view', 'product.materials.manage']

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  manager: { permissions: [...IMPORTS, ...RECORDS, 'imports.duplicates.merge'], companies: 'all' },
  noMerge: { permissions: [...IMPORTS, ...RECORDS], companies: 'all' },
  viewer: { permissions: ['parties.view', 'product.materials.view', 'imports.duplicates.merge'], companies: 'all' },
  companyB: { permissions: ['parties.view', 'product.materials.view'], companies: [companyB] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
async function upload(session: string, importerKey: string, body: Buffer): Promise<Json> {
  const started = await call(session, 'POST', '/imports', { importerKey, file: { originalName: 'sheet.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) } })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return (await call(session, 'GET', `/imports/${job.id}`)).json().job
}
const codes = (candidates: readonly Json[]): string[] => candidates.map((candidate) => candidate.code)
const reasonsOf = (candidates: readonly Json[], code: string): string[] => (candidates.find((candidate) => candidate.code === code)?.reasons ?? []).map((reason: Json) => reason.code)

async function createParty(body: Json): Promise<Json> {
  const response = await call('manager', 'POST', '/parties', body)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().party
}
async function createMaterial(body: Json): Promise<Json> {
  const response = await call('manager', 'POST', '/product/materials', { kind: 'TRIM', baseUom: 'PCS', animalOrigin: false, ...body })
  expect(response.statusCode, response.body).toBe(201)
  return response.json().material
}
const partyOf = async (id: string) => (await admin<{ status: string; version: number }>(`SELECT status::text, version FROM "Party" WHERE id = $1`, [id]))[0]!

beforeAll(async () => {
  db = await migratedDatabase('duplicates_w2b427')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-duplicates-w2b427-'))
  await seedCore({ db: database, namespace: NS })
  await seedParties({ db: database, namespace: NS })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, tenant, `custom.${key.toLowerCase()}`, key, person.permissions, []])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`,
      [newId(), tenant, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters(undefined)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the warning on create', () => {
  it('names the customer with the same VAT number and name before a second one is made', async () => {
    const response = await call('manager', 'POST', '/duplicates/parties/check', { legalName: 'SEED CUSTOMER ONE SRL', vatNumber: '00000001016', country: 'IT' })
    expect(response.statusCode, response.body).toBe(200)
    const { candidates } = response.json()
    expect(candidates[0]).toMatchObject({ recordType: 'PARTY', id: C1, code: 'SEED-C1', name: 'Seed Racing', likelihood: 'HIGH', roles: ['CUSTOMER', 'BRAND'] })
    expect(reasonsOf(candidates, 'SEED-C1')).toEqual(['SAME_VAT_NUMBER', 'SAME_NAME'])
    expect(candidates[0]).not.toHaveProperty('createdAt')
  })

  it('names a shared company e-mail domain, never a public mailbox, and nothing for a new business', async () => {
    const domain = (await call('manager', 'POST', '/duplicates/parties/check', { legalName: 'Completely Different Test', emails: ['someone@example.com'] })).json().candidates
    expect(reasonsOf(domain, 'SEED-C1')).toEqual(['SAME_EMAIL_DOMAIN'])
    expect(domain.find((candidate: Json) => candidate.code === 'SEED-C1').reasons[0].detail).toBe('example.com')
    const none = (await call('manager', 'POST', '/duplicates/parties/check', { legalName: 'Nobody Like Us Test', emails: ['someone@libero.it'] })).json().candidates
    expect(none).toEqual([])
  })

  it('names only parties the caller may see', async () => {
    const all = (await call('manager', 'POST', '/duplicates/parties/check', { legalName: 'Seed Leather Supplier' })).json().candidates
    expect(codes(all)).toContain('SEED-S1')
    const fenced = await call('companyB', 'POST', '/duplicates/parties/check', { legalName: 'Seed Leather Supplier' })
    expect(fenced.statusCode).toBe(200)
    expect(codes(fenced.json().candidates)).not.toContain('SEED-S1')
    expect((await call('companyB', 'POST', '/duplicates/parties/check', { legalName: 'Seed Leather Supplier', exceptId: S1 })).statusCode).toBe(200)
  })
})

describe('parties: the list and the merge', () => {
  let dup: Json
  it('lists the second customer made anyway as a possible duplicate of the first', async () => {
    dup = await createParty({
      code: 'DUP-C1',
      legalName: 'Seed Customer One Srl',
      roles: ['CUSTOMER'],
      contacts: [
        { name: 'Anna Test', email: 'anna@seed-one.example' },
        { name: 'Second Buyer', email: 'buyer.p1@example.com' },
      ],
      addresses: [{ kinds: ['BILL_TO'], line1: 'Via Prova 1', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' }],
    })
    const scan = await call('manager', 'GET', '/duplicates/parties')
    expect(scan.statusCode, scan.body).toBe(200)
    const pair = scan.json().pairs.find((entry: Json) => entry.b.id === dup.id)
    expect(pair).toMatchObject({ a: { code: 'SEED-C1' }, b: { code: 'DUP-C1' }, likelihood: 'HIGH' })
    expect(pair.reasons.map((reason: Json) => reason.code)).toEqual(['SAME_NAME', 'SAME_EMAIL_DOMAIN'])
  })

  it('previews what moves and what stays, and refuses the other way round in words', async () => {
    // Anyone who sees both may look; the viewer may not change parties, so the merge is refused for them in words.
    expect((await call('viewer', 'GET', `/duplicates/PARTY/merge?keptId=${C1}&droppedId=${dup.id}`)).json().refusals).toEqual(['NO_RIGHT'])
    const preview = await call('manager', 'GET', `/duplicates/PARTY/merge?keptId=${C1}&droppedId=${dup.id}`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      refusals: [],
      uses: [],
      moves: { contacts: 1, addresses: 1, taxIdentities: 0, colours: 0 },
      stays: { contacts: 1, addresses: 0, taxIdentities: 0 },
      reverseWorks: false,
    })
    // The seed customer has quotes, orders, documents …: it is never the one archived.
    const reverse = (await call('manager', 'GET', `/duplicates/PARTY/merge?keptId=${dup.id}&droppedId=${C1}`)).json()
    expect(reverse.refusals).toEqual(['IN_USE'])
    expect(reverse.reverseWorks).toBe(true)
    expect(reverse.uses.length).toBeGreaterThan(0)
    expect(reverse.uses.every((use: Json) => use.count > 0)).toBe(true)
  })

  it('refuses a person without imports.duplicates.merge, a stale version, and a reason too short', async () => {
    const body = { keptId: C1, droppedId: dup.id, keptVersion: (await partyOf(C1)).version, droppedVersion: dup.version, reason: 'Same customer typed twice (test)' }
    expect((await call('noMerge', 'POST', '/duplicates/PARTY/merge', body)).statusCode).toBe(403)
    // The viewer holds the merge permission but may not change parties: forbidden in words.
    const viewer = await call('viewer', 'POST', '/duplicates/PARTY/merge', body)
    expect(viewer.statusCode).toBe(403)
    expect(viewer.json().error.message).toContain('right to change both records')
    const stale = await call('manager', 'POST', '/duplicates/PARTY/merge', { ...body, keptVersion: body.keptVersion + 5 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.message).toContain('The record that stays changed')
    expect((await call('manager', 'POST', '/duplicates/PARTY/merge', { ...body, reason: 'no' })).statusCode).toBe(400)
    expect((await partyOf(dup.id)).status).toBe('ACTIVE')
  })

  it('merges: the free contact and the address move, the duplicate is archived, both keep the reason', async () => {
    const keptVersion = (await partyOf(C1)).version
    const response = await call('manager', 'POST', '/duplicates/PARTY/merge', { keptId: C1, droppedId: dup.id, keptVersion, droppedVersion: dup.version, reason: 'Same customer typed twice (test)' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ recordType: 'PARTY', kept: { code: 'SEED-C1', version: keptVersion + 1 }, dropped: { code: 'DUP-C1', status: 'ARCHIVED' }, moved: { contacts: 1, addresses: 1, taxIdentities: 0 } })
    expect(await partyOf(dup.id)).toMatchObject({ status: 'ARCHIVED' })
    const contacts = await admin<{ email: string; partyId: string }>(`SELECT email, "partyId"::text FROM "PartyContact" WHERE email IN ('anna@seed-one.example', 'buyer.p1@example.com') ORDER BY email, "partyId"`)
    expect(contacts).toEqual(expect.arrayContaining([{ email: 'anna@seed-one.example', partyId: C1 }, { email: 'buyer.p1@example.com', partyId: dup.id }]))
    const address = await admin<{ partyId: string; isDefaultBillTo: boolean }>(`SELECT "partyId"::text, "isDefaultBillTo" FROM "PartyAddress" WHERE line1 = 'Via Prova 1'`)
    expect(address).toEqual([{ partyId: C1, isDefaultBillTo: false }])
    const audit = await admin<{ recordId: string; reason: string | null; after: Json }>(`SELECT "recordId"::text, reason, after FROM "AuditLog" WHERE action = 'imports.duplicates.merge' AND "recordType" = 'Party' ORDER BY "recordId" = $1`, [C1])
    expect(audit.map((row) => [row.recordId, row.reason])).toEqual([
      [dup.id, 'Same customer typed twice (test)'],
      [C1, 'Same customer typed twice (test)'],
    ])
    expect(audit[0]!.after).toMatchObject({ status: 'ARCHIVED', mergedInto: C1 })
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE type IN ('duplicate.merged', 'party.status_changed', 'party.contacts_changed', 'party.addresses_changed') AND (subject = $1 OR subject = $2) ORDER BY type`, [C1, dup.id])
    expect(events.map((row) => row.type)).toEqual(['duplicate.merged', 'party.addresses_changed', 'party.contacts_changed', 'party.status_changed'])
    const again = await call('manager', 'POST', '/duplicates/PARTY/merge', { keptId: C1, droppedId: dup.id, keptVersion: keptVersion + 1, droppedVersion: dup.version + 1, reason: 'Again (test)' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toBe('DUP-C1 is archived already.')
  })
})

describe('materials: the warning, the merge and its refusals', () => {
  it('names materials with the same code and supplier code, then merges the colour the other lacks', async () => {
    const kept = await createMaterial({ code: 'TST-NAP-01', name: 'Cerniera test nera sessanta', supplierArticleCode: 'VN-100', colours: [{ code: 'NER', name: 'Nero' }] })
    const dup = await createMaterial({ code: 'TSTNAP01', name: 'Cerniera Test Nera Sessanta', supplierArticleCode: 'vn 100', colours: [{ code: 'NER', name: 'Nero' }, { code: 'TAN', name: 'Tan' }] })
    const trim = await createMaterial({ code: 'TST-NAP-01T', kind: 'HARDWARE', name: 'Cerniera test nera sessanta' })
    const check = (await call('manager', 'POST', '/duplicates/materials/check', { code: 'tst nap 01', name: 'sessanta cerniera test nera' })).json().candidates
    expect(codes(check).slice(0, 2).sort()).toEqual(['TST-NAP-01', 'TSTNAP01'])
    expect(reasonsOf(check, 'TST-NAP-01')).toEqual(['SAME_CODE', 'SAME_NAME'])
    expect((await call('manager', 'POST', '/duplicates/materials/check', { code: 'TST-NAP-01', exceptId: kept.id })).json().candidates.map((candidate: Json) => candidate.id)).not.toContain(kept.id)

    const kinds = (await call('manager', 'GET', `/duplicates/MATERIAL/merge?keptId=${kept.id}&droppedId=${trim.id}`)).json()
    expect(kinds.refusals).toEqual(['KIND_DIFFERS'])
    const refused = await call('manager', 'POST', '/duplicates/MATERIAL/merge', { keptId: kept.id, droppedId: trim.id, keptVersion: kept.version, droppedVersion: trim.version, reason: 'Not the same (test)' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toBe('TST-NAP-01T and TST-NAP-01 are different kinds of material.')

    const preview = (await call('manager', 'GET', `/duplicates/MATERIAL/merge?keptId=${kept.id}&droppedId=${dup.id}`)).json()
    expect(preview).toMatchObject({ refusals: [], moves: { colours: 1 }, stays: { colours: 1 } })
    const merged = await call('manager', 'POST', '/duplicates/MATERIAL/merge', { keptId: kept.id, droppedId: dup.id, keptVersion: kept.version, droppedVersion: dup.version, reason: 'Same leather typed twice (test)' })
    expect(merged.statusCode, merged.body).toBe(200)
    expect(merged.json()).toMatchObject({ dropped: { status: 'ARCHIVED' }, moved: { colours: 1 } })
    const colours = await admin<{ code: string; itemId: string }>(`SELECT code, "itemId"::text FROM "ItemColour" WHERE "itemId" IN ($1, $2) ORDER BY code, "itemId"`, [kept.id, dup.id])
    expect(colours).toEqual(expect.arrayContaining([{ code: 'TAN', itemId: kept.id }, { code: 'NER', itemId: dup.id }, { code: 'NER', itemId: kept.id }]))
    expect((await admin<{ status: string }>(`SELECT status::text FROM "Item" WHERE id = $1`, [dup.id]))[0]!.status).toBe('ARCHIVED')
    // The archived duplicate is no longer listed as a possible duplicate.
    const scan = (await call('manager', 'GET', '/duplicates/materials')).json()
    expect(scan.pairs.some((pair: Json) => pair.a.id === dup.id || pair.b.id === dup.id)).toBe(false)
  })
})

describe("an import's check", () => {
  it('shows possible duplicates in the dry run and, after the apply, the records the rows made', async () => {
    const job = await upload(
      'manager',
      'parties.parties',
      csv(['Code;Legal name;Roles;Contact;Contact email', 'NEW-D1;Seed Customer One s.r.l.;cliente;;', 'NEW-D2;Nuovo Cliente Prova;cliente;Ordini Prova;ordini@nuovo-prova.example', 'NEW-D3;Nuovo Cliente Prova S.r.l.;cliente;Amministrazione Prova;amministrazione@nuovo-prova.example']),
    )
    const refused = (await call('manager', 'GET', `/imports/${job.id}/rows?action=ERROR`)).json().rows
    expect(refused, JSON.stringify(refused)).toEqual([])
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 3 })
    const planned = await call('manager', 'GET', `/imports/${job.id}/duplicates`)
    expect(planned.statusCode, planned.body).toBe(200)
    const answer = planned.json()
    expect(answer).toMatchObject({ supported: true, recordType: 'PARTY', checked: 3, more: false })
    const row2 = answer.rows.find((row: Json) => row.rowNumber === 2)
    expect(codes(row2.candidates)).toEqual(expect.arrayContaining(['SEED-C1', 'DUP-C1']))
    expect(row2.recordId).toBeNull()
    const row4 = answer.rows.find((row: Json) => row.rowNumber === 4)
    expect(row4.sameSheet).toEqual([expect.objectContaining({ rowNumber: 3, key: 'NEW-D2', recordId: null, likelihood: 'HIGH' })])
    expect(row4.sameSheet[0].reasons.map((reason: Json) => reason.code)).toEqual(['SAME_NAME', 'SAME_EMAIL_DOMAIN'])
    expect(answer.rows.some((row: Json) => row.rowNumber === 3)).toBe(false)

    expect((await call('manager', 'POST', `/imports/${job.id}/apply`, { version: job.version })).statusCode).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    const after = (await call('manager', 'GET', `/imports/${job.id}/duplicates`)).json()
    const made = after.rows.find((row: Json) => row.rowNumber === 4)
    expect(made.recordId).not.toBeNull()
    expect(made.sameSheet[0].recordId).not.toBeNull()
    // The import's own records are compared as rows, never offered as records already there.
    expect(made.candidates.map((candidate: Json) => candidate.code)).not.toContain('NEW-D2')

    // Merged from the result (row 4's record into row 3's): row 4 is no longer offered.
    const ask = (await call('manager', 'GET', `/duplicates/PARTY/merge?keptId=${made.sameSheet[0].recordId}&droppedId=${made.recordId}`)).json()
    expect(ask.refusals).toEqual([])
    const merged = await call('manager', 'POST', '/duplicates/PARTY/merge', { keptId: ask.kept.id, droppedId: ask.dropped.id, keptVersion: ask.kept.version, droppedVersion: ask.dropped.version, reason: 'Two rows are one customer (test)' })
    expect(merged.statusCode, merged.body).toBe(200)
    expect(merged.json().moved).toMatchObject({ contacts: 1 })
    expect((await call('manager', 'GET', `/imports/${job.id}/duplicates`)).json().rows.some((row: Json) => row.rowNumber === 4)).toBe(false)

    // Without the importer's view permission the job is not found.
    expect((await call('companyB', 'GET', `/imports/${job.id}/duplicates`)).statusCode).toBe(403)
  })
})
