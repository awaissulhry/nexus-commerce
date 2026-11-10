import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { readDocSender } from '../public-doc/sender'
import { useRulesClock } from './common'

/**
 * Rules & markets (B-W2b-249) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login, so row-level security and B-W2b-216's guards are real), seeded with the core and the
 * compliance rules seeds (the register with EN 17092-3:2020 cited by SEED-CERT-0001, -2161 and -2162 and an OPEN amendment
 * of it; markets IT, DE, FR, ES on, UK, CH, US off with Owner question Q23; operators: companies A and B, the brand P1 as
 * manufacturer of its styles, P3 distributing SEED-JKT-01 in CH; six phrases with translations). Every name, code and
 * person is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/register-of-rules`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const NS = 'rules-library-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteB = seedId('site:B1')
const jacket = seedId('product:style:JKT-01')
const partyP1 = seedId('party:P1')
const partyP3 = seedId('party:P3')
const certJacket = seedId('compliance:certificate:JKT-01')
const certProtector = seedId('compliance:certificate:PRO-300')
const manager = newId()
const approver = newId()

const VIEW = 'compliance.certificates.view'
const RULES = 'compliance.rules.manage'
const PHRASES = 'compliance.phrases.manage'
const APPROVE = 'compliance.phrases.approve'
const clock: Clock = { now: () => new Date('2026-11-10T09:00:00.000Z') }
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(manager, [grant([VIEW, RULES, PHRASES, APPROVE, 'tasks.manage'])]),
  approver: office(approver, [grant([VIEW, PHRASES, APPROVE])]),
  viewer: office(newId(), [grant([VIEW])]),
  companyB: office(newId(), [grant([VIEW, RULES, PHRASES], [companyB])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteB, deviceId: newId(), grants: [grant(['floor.work', VIEW, RULES], [companyB])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const entryOf = (entries: Json[], label: string): Json => entries.find((entry) => entry.label === label)!

beforeAll(async () => {
  db = await migratedDatabase('rules_library')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  useRulesClock(clock)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  useRulesClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the register of laws and standards (PRD-273)', () => {
  it('lists the entries with their citation, status, the certificates that cite them and the open changes', async () => {
    const { entries, mayManage } = await ok('viewer', 'GET', '/compliance/rules/standards')
    expect(mayManage).toBe(false)
    expect(entryOf(entries, 'EN 17092-3:2020')).toMatchObject({ code: 'EN 17092-3', edition: '2020', kind: 'HARMONISED_STANDARD', status: 'IN_FORCE', ojReference: 'OJ L 77, 5.3.2021', ojDate: '2021-03-05', usedBy: 3, openChanges: 1 })
    expect(entryOf(entries, 'EN 1621-1:2012')).toMatchObject({ kind: 'STANDARD', usedBy: 1 })
    expect(entryOf(entries, 'EN 13595-1:2002')).toMatchObject({ status: 'WITHDRAWN', usedBy: 0, openChanges: 0 })
    const one = await ok('viewer', 'GET', `/compliance/rules/standards/${entryOf(entries, 'EN 17092-3:2020').id}`)
    expect(one.certificates.map((certificate: Json) => certificate.number)).toEqual(['SEED-CERT-0001', 'SEED-CERT-2161', 'SEED-CERT-2162'])
    expect(one.certificates[0]).toMatchObject({ status: 'VALID', styles: 1 })
    // Its own amendment, and the withdrawal of EN 13595-1:2002 that names it as the edition taking over.
    expect(one.changes.map((change: Json) => [change.kind, change.status, change.standard.label])).toEqual([['AMENDMENT', 'OPEN', 'EN 17092-3:2020'], ['WITHDRAWAL', 'CLOSED', 'EN 13595-1:2002']])
    expect(one.supersedes).toEqual([])
  })

  it('adds an edition; refuses a twin, a code with its edition in it, a viewer and a manager of one company, in words', async () => {
    const { entry } = await ok('manager', 'POST', '/compliance/rules/standards', { code: 'EN 17092-3', edition: '2026', title: 'Protective garments for motorcycle riders - Part 3 (made-up new edition)', kind: 'HARMONISED_STANDARD', ojReference: 'OJ L 1, 1.1.2027' })
    expect(entry).toMatchObject({ label: 'EN 17092-3:2026', status: 'IN_FORCE', usedBy: 0, version: 1 })
    expect((await refused('manager', 'POST', '/compliance/rules/standards', { code: 'EN 17092-3', edition: '2026', title: 'Twin', kind: 'HARMONISED_STANDARD' }, 409)).message).toBe(
      'The register already has EN 17092-3:2026: edit that entry, or give this one another edition.',
    )
    expect((await refused('manager', 'POST', '/compliance/rules/standards', { code: 'EN 17092-3:2026', title: 'x', kind: 'HARMONISED_STANDARD' }, 400)).issues).toEqual([{ path: 'body/code', message: 'Write the edition apart: code "EN 17092-4", edition "2020".' }])
    await refused('viewer', 'POST', '/compliance/rules/standards', { code: 'EN 9', title: 'x', kind: 'STANDARD' }, 403)
    expect((await refused('companyB', 'POST', '/compliance/rules/standards', { code: 'EN 9', title: 'x', kind: 'STANDARD' }, 403)).message).toBe('The register of laws and standards for every company is kept only by a role over every company.')
    await refused('floor', 'GET', '/compliance/rules/standards', undefined, 403)
  })

  it('raises a change when an entry is withdrawn, naming the certificates that cite it; asks for the words first', async () => {
    const { entries } = await ok('manager', 'GET', '/compliance/rules/standards')
    const protector = entryOf(entries, 'EN 1621-1:2012')
    expect((await refused('manager', 'PATCH', `/compliance/rules/standards/${protector.id}`, { version: protector.version, status: 'WITHDRAWN' }, 400)).issues[0].path).toBe('body/reason')
    const { entry, raised } = await ok('manager', 'PATCH', `/compliance/rules/standards/${protector.id}`, { version: protector.version, status: 'WITHDRAWN', reason: 'Made up: the standard is withdrawn by its body.', transitionEndsOn: '2026-12-01' })
    expect(entry).toMatchObject({ status: 'WITHDRAWN', version: protector.version + 1, openChanges: 1 })
    expect(raised).toMatchObject({ kind: 'WITHDRAWAL', status: 'OPEN', whatChanged: 'Made up: the standard is withdrawn by its body.', transitionEndsOn: '2026-12-01', transition: 'ENDS_SOON', certificates: [{ id: certProtector, number: 'SEED-CERT-0002' }] })
    // A stale version is refused, never a 500.
    await refused('manager', 'PATCH', `/compliance/rules/standards/${protector.id}`, { version: protector.version, note: 'Late' }, 409)
  })

  it('removes a row typed by mistake, never one a certificate cites', async () => {
    const { entry } = await ok('manager', 'POST', '/compliance/rules/standards', { code: 'EN 99999', title: 'Typed by mistake', kind: 'STANDARD' })
    expect(await ok('manager', 'DELETE', `/compliance/rules/standards/${entry.id}?version=1`)).toEqual({ deleted: entry.id })
    const { entries } = await ok('manager', 'GET', '/compliance/rules/standards')
    const cited = entryOf(entries, 'EN 17092-3:2020')
    expect((await refused('manager', 'DELETE', `/compliance/rules/standards/${cited.id}?version=${cited.version}`, undefined, 409)).message).toBe(
      'EN 17092-3:2020 is cited by certificate SEED-CERT-0001 and 2 more: it stays in the register (mark it superseded or withdrawn instead).',
    )
  })
})

describe('the harmonised-standard watch (PRD-274)', () => {
  let change: Json

  it('records a revision a person noticed: the certificates that cite it and the styles they cover', async () => {
    const { entries } = await ok('manager', 'GET', '/compliance/rules/standards')
    const old = entryOf(entries, 'EN 17092-3:2020')
    const fresh = entryOf(entries, 'EN 17092-3:2026')
    ;({ change } = await ok('manager', 'POST', `/compliance/rules/standards/${old.id}/changes`, { kind: 'REVISION', whatChanged: 'Made up: a new edition is cited in the Official Journal.', sourceReference: 'OJ L 1, 1.1.2027', transitionEndsOn: '2027-06-30', newStandardId: fresh.id }))
    expect(change).toMatchObject({ standard: { label: 'EN 17092-3:2020' }, newStandard: { label: 'EN 17092-3:2026' }, status: 'OPEN', transition: 'RUNNING', impact: null, task: null, reviews: [] })
    expect(change.certificates.map((certificate: Json) => certificate.number)).toEqual(['SEED-CERT-0001', 'SEED-CERT-2161', 'SEED-CERT-2162'])
    expect(change.styles).toEqual([{ id: jacket, code: 'SEED-JKT-01', name: 'Seed leather jacket', certificateIds: [certJacket] }])
    const { changes } = await ok('viewer', 'GET', '/compliance/rules/standard-changes?open=true')
    // Open ones, the transition ending soonest first (the withdrawal's ends in December).
    expect(changes[0].kind).toBe('WITHDRAWAL')
    expect(changes.map((entry: Json) => entry.kind).sort()).toEqual(['AMENDMENT', 'REVISION', 'WITHDRAWAL'])
  })

  it('assesses the impact once, opening W2a\'s type-change review for the certificate that needs the notified body again', async () => {
    expect((await refused('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/assess`, { version: change.version, impact: 'NONE', assessment: 'Nothing to do.', reviewCertificateIds: [certJacket] }, 409)).issues[0].path).toBe('refusal/NO_REVIEW_FOR_NONE')
    ;({ change } = await ok('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/assess`, { version: change.version, impact: 'RETEST', assessment: 'Made up: the abrasion test changes; the notified body tests the jacket again.', reviewCertificateIds: [certJacket] }))
    expect(change).toMatchObject({ status: 'ASSESSED', impact: 'RETEST', assessedBy: { id: manager }, reviews: [{ certificateId: certJacket, styleId: jacket, styleCode: 'SEED-JKT-01', status: 'OPEN' }] })
    const [review] = await admin(`SELECT status, changes FROM "TypeChangeReview" WHERE id = $1`, [change.reviews[0].id])
    expect(review).toMatchObject({ status: 'OPEN', changes: [{ kind: 'OTHER', what: 'Standard', before: 'EN 17092-3:2020', after: 'EN 17092-3:2026', bomLineId: null }] })
    await refused('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/assess`, { version: change.version, impact: 'NONE', assessment: 'Again.' }, 409)
  })

  it('opens the impact task listing the affected styles, once; closes the change, which then never changes (a 409, never a 500)', async () => {
    ;({ change } = await ok('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/task`, { version: change.version, assigneeId: null, language: 'en' }))
    expect(change.task).toMatchObject({ title: 'Standard EN 17092-3:2020 revised: check the styles', status: 'OPEN' })
    const task = (await admin<Json>(`SELECT description, checklist, "dueDate"::text AS due FROM "Task" WHERE id = $1`, [change.task.id]))[0]!
    expect(task.description).toContain('The transition period ends on 2027-06-30.')
    expect(task.checklist.map((item: Json) => item.text)).toEqual(['SEED-JKT-01 Seed leather jacket (certificate SEED-CERT-0001): check against the new edition'])
    expect(task.due).toBe('2027-05-31')
    expect((await refused('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/task`, { version: change.version, assigneeId: null }, 409)).issues[0].path).toBe('refusal/TASK_NAMED')
    ;({ change } = await ok('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/close`, { version: change.version }))
    expect(change).toMatchObject({ status: 'CLOSED', closedBy: { id: manager } })
    // The database refuses any change to a CLOSED one: in its words, as a 409.
    const late = await refused('manager', 'POST', `/compliance/rules/standard-changes/${change.id}/certificates`, { version: change.version, certificateIds: [certProtector] }, 409)
    expect(late.message).toMatch(/is CLOSED; it never changes\.$/)
    const events = await admin<{ type: string }>(`SELECT DISTINCT type FROM "OutboxEvent" WHERE type LIKE 'compliance_rules.%' OR type = 'compliance.type_change_found' ORDER BY type`)
    expect(events.map((row) => row.type)).toEqual(['compliance.type_change_found', 'compliance_rules.change_moved', 'compliance_rules.change_raised', 'compliance_rules.standard_changed'])
  })
})

describe('market profiles (PRD-275)', () => {
  it('lists the markets with the LanguageMatrix; the open ones are off with the Owner question', async () => {
    const { markets, matrix } = await ok('viewer', 'GET', '/compliance/rules/markets')
    expect(markets.map((market: Json) => [market.code, market.switchedOn])).toEqual([['IT', true], ['DE', true], ['FR', true], ['ES', true], ['UK', false], ['CH', false], ['US', false]])
    expect(markets.find((market: Json) => market.code === 'UK')).toMatchObject({ markings: ['UKCA'], importerNeeded: true, offReason: expect.stringContaining('Q23') })
    expect(markets.find((market: Json) => market.code === 'FR').nationalRules).toEqual([{ key: 'fr-seed-extra', words: { it: 'Regola nazionale di esempio (inventata).', en: 'A made-up national rule.' }, law: 'Seed national law', href: null }])
    expect(matrix.languages).toEqual(['de', 'es', 'fr', 'it', 'en'])
  })

  it('adds a market, switches it off only with the reason, archives it; refuses a twin and a switch to the state it is in', async () => {
    const { market } = await ok('manager', 'POST', '/compliance/rules/markets', { code: 'NL', name: 'Netherlands (test)', labelLanguages: ['nl'], docLanguages: ['nl'], userInfoLanguages: ['nl'], markings: ['CE'], seq: 5 })
    expect(market).toMatchObject({ code: 'NL', switchedOn: true, offReason: null, switchedBy: { id: manager }, status: 'ACTIVE', version: 1 })
    expect((await refused('manager', 'POST', '/compliance/rules/markets', { code: 'IT', name: 'Twin' }, 409)).message).toBe('There is a market IT already (perhaps archived): edit or restore it.')
    expect((await refused('manager', 'POST', '/compliance/rules/markets', { code: 'BE', name: 'x', labelLanguages: ['nl-BE'] }, 400)).issues[0].path).toBe('body/labelLanguages')
    expect((await refused('manager', 'PUT', '/compliance/rules/markets/NL/switch', { version: 1, on: false }, 400)).issues[0].path).toBe('body/reason')
    const off = await ok('manager', 'PUT', '/compliance/rules/markets/NL/switch', { version: 1, on: false, reason: 'Made up: not sold there yet.' })
    expect(off.market).toMatchObject({ switchedOn: false, offReason: 'Made up: not sold there yet.', version: 2 })
    expect((await refused('manager', 'PUT', '/compliance/rules/markets/NL/switch', { version: 2, on: false, reason: 'Again.' }, 409)).message).toBe('Market NL is already off.')
    const archived = await ok('manager', 'PATCH', '/compliance/rules/markets/NL', { version: 2, status: 'ARCHIVED' })
    expect(archived.market.status).toBe('ARCHIVED')
    expect((await ok('viewer', 'GET', '/compliance/rules/markets')).markets.map((entry: Json) => entry.code)).not.toContain('NL')
    // UK on for the phrases below (English joins the languages the markets need).
    const uk = (await ok('viewer', 'GET', '/compliance/rules/markets/UK')).market
    await ok('manager', 'PUT', '/compliance/rules/markets/UK/switch', { version: uk.version, on: true })
    await refused('companyB', 'PUT', '/compliance/rules/markets/UK/switch', { version: uk.version + 1, on: false, reason: 'Not mine.' }, 403)
  })
})

describe('economic operators per style and market (PRD-298)', () => {
  it('resolves who applies to the brand\'s jacket: the brand as manufacturer (Owner question 3), the CH distributor in CH', async () => {
    const plain = await ok('viewer', 'GET', `/compliance/rules/operators/resolve?styleId=${jacket}&companyId=${companyA}`)
    expect(plain.operators.map((entry: Json) => [entry.role, entry.level, entry.operator.printedName])).toEqual([['MANUFACTURER', 'BRAND', 'Seed Customer One S.r.l.']])
    const ch = await ok('viewer', 'GET', `/compliance/rules/operators/resolve?styleId=${jacket}&marketCode=CH&companyId=${companyA}`)
    expect(ch.operators.map((entry: Json) => [entry.role, entry.level, entry.forMarket])).toEqual([['MANUFACTURER', 'BRAND', false], ['DISTRIBUTOR', 'STYLE', true]])
    expect(ch.needs).toEqual([{ role: 'MANUFACTURER', met: true }, { role: 'IMPORTER_OR_REPRESENTATIVE', met: false }])
  })

  it('names an importer for UK; refuses one without its party and a second distributor on the same days, in words', async () => {
    expect((await refused('manager', 'POST', '/compliance/rules/operators', { role: 'IMPORTER', companyId: companyA, marketCode: 'UK', printedName: 'Test Importer Ltd', printedAddress: '1 Test Street, Testtown', validFrom: '2026-11-01' }, 400)).issues[0].path).toBe('body/partyId')
    const { operator } = await ok('manager', 'POST', '/compliance/rules/operators', { role: 'IMPORTER', companyId: companyA, marketCode: 'UK', partyId: partyP3, printedName: 'Test Importer Ltd', printedAddress: '1 Test Street, Testtown', contact: 'import@test.example', validFrom: '2026-11-01' })
    expect(operator).toMatchObject({ role: 'IMPORTER', level: 'COMPANY', marketCode: 'UK', party: { id: partyP3 }, validOnDay: true })
    const uk = await ok('viewer', 'GET', `/compliance/rules/operators/resolve?styleId=${jacket}&marketCode=UK&companyId=${companyA}`)
    expect(uk.needs).toEqual([{ role: 'MANUFACTURER', met: true }, { role: 'IMPORTER_OR_REPRESENTATIVE', met: true }])
    expect((await refused('manager', 'POST', '/compliance/rules/operators', { role: 'DISTRIBUTOR', styleId: jacket, marketCode: 'CH', partyId: partyP1, printedName: 'Test', printedAddress: 'Test', validFrom: '2027-01-01' }, 409)).message).toBe(
      'Style SEED-JKT-01 already has a distributor for market CH from 2026-06-01 to 2027-05-31 (Seed Customer Three): give that one a last day before this one starts, or change the days.',
    )
    expect((await refused('manager', 'POST', '/compliance/rules/operators', { role: 'IMPORTER', marketCode: 'ZZ', partyId: partyP3, printedName: 'T', printedAddress: 'T', validFrom: '2026-11-01' }, 400)).issues[0].message).toBe('There is no market ZZ (add it under Markets first).')
    // Ending the row: its last day.
    const ended = await ok('manager', 'PATCH', `/compliance/rules/operators/${operator.id}`, { version: operator.version, validTo: '2026-11-05' })
    expect(ended.operator).toMatchObject({ validTo: '2026-11-05', validOnDay: false })
  })
})

describe('the phrase library (PRD-343)', () => {
  it('shows a cell per language the switched-on markets need: approved, proposed, missing', async () => {
    const { phrases, languages } = await ok('viewer', 'GET', '/compliance/rules/phrases')
    expect(languages).toEqual(['de', 'en', 'es', 'fr', 'it'])
    const animal = phrases.find((phrase: Json) => phrase.key === 'marking.animal-origin')
    expect(Object.fromEntries(animal.cells.map((cell: Json) => [cell.language, cell.state]))).toEqual({ de: 'APPROVED', en: 'APPROVED', es: 'MISSING', fr: 'APPROVED', it: 'SOURCE' })
    const warning = phrases.find((phrase: Json) => phrase.key === 'warning.class-a')
    expect(warning.cells.find((cell: Json) => cell.language === 'de').state).toBe('PROPOSED')
  })

  it('adds a phrase, takes a proposal, approves it by a second person only; new source words make the approval stale', async () => {
    let { phrase } = await ok('manager', 'POST', '/compliance/rules/phrases', { key: 'warning.test-b', kind: 'WARNING', sourceText: 'Indumento di prova di classe B.' })
    expect(phrase).toMatchObject({ key: 'warning.test-b', sourceLanguage: 'it', revision: 1, status: 'ACTIVE' })
    ;({ phrase } = await ok('manager', 'POST', '/compliance/rules/phrases/warning.test-b/translations', { language: 'de', text: 'Testkleidungsstück der Klasse B.' }))
    const proposed = phrase.cells.find((cell: Json) => cell.language === 'de')
    expect(proposed).toMatchObject({ state: 'PROPOSED', draft: { revision: 1, sourceRevision: 1, proposedBy: { id: manager } } })
    expect((await refused('manager', 'POST', `/compliance/rules/phrases/warning.test-b/translations/${proposed.draft.id}/approve`, { version: proposed.draft.version }, 409)).issues[0].path).toBe('refusal/OWN_PROPOSAL')
    expect((await refused('manager', 'POST', '/compliance/rules/phrases/warning.test-b/translations', { language: 'it', text: 'x' }, 400)).message).toBe('The phrase is written in it: change its source words instead.')
    ;({ phrase } = await ok('approver', 'POST', `/compliance/rules/phrases/warning.test-b/translations/${proposed.draft.id}/approve`, { version: proposed.draft.version }))
    expect(phrase.cells.find((cell: Json) => cell.language === 'de')).toMatchObject({ state: 'APPROVED', approved: { revision: 1, approvedBy: { id: approver } }, draft: null })
    expect((await ok('viewer', 'GET', '/compliance/rules/phrases/texts?keys=warning.test-b&languages=it,de,fr')).texts).toEqual([
      { key: 'warning.test-b', language: 'it', text: 'Indumento di prova di classe B.', revision: 1 },
      { key: 'warning.test-b', language: 'de', text: 'Testkleidungsstück der Klasse B.', revision: 1 },
      { key: 'warning.test-b', language: 'fr', text: null, revision: 1 },
    ])
    // New source words: revision 2, the German approval is stale and no longer prints.
    ;({ phrase } = await ok('manager', 'PATCH', '/compliance/rules/phrases/warning.test-b', { version: phrase.version, sourceText: 'Indumento di prova di classe B: leggere le istruzioni.' }))
    expect(phrase).toMatchObject({ revision: 2 })
    expect(phrase.cells.find((cell: Json) => cell.language === 'de').state).toBe('STALE')
    expect((await ok('viewer', 'GET', '/compliance/rules/phrases/texts?keys=warning.test-b&languages=de')).texts[0].text).toBeNull()
    // Translated again and approved: the first approval is superseded.
    ;({ phrase } = await ok('approver', 'POST', '/compliance/rules/phrases/warning.test-b/translations', { language: 'de', text: 'Testkleidungsstück der Klasse B: Anleitung lesen.' }))
    const again = phrase.cells.find((cell: Json) => cell.language === 'de').draft
    expect(again).toMatchObject({ revision: 2, sourceRevision: 2 })
    ;({ phrase } = await ok('manager', 'POST', `/compliance/rules/phrases/warning.test-b/translations/${again.id}/approve`, { version: again.version }))
    const { history } = await ok('viewer', 'GET', '/compliance/rules/phrases/warning.test-b')
    expect(history.map((entry: Json) => [entry.language, entry.revision, entry.status])).toEqual([['de', 2, 'APPROVED'], ['de', 1, 'SUPERSEDED']])
    // A draft nobody wants is withdrawn; an approved one is kept.
    ;({ phrase } = await ok('manager', 'POST', '/compliance/rules/phrases/warning.test-b/translations', { language: 'fr', text: 'Vêtement de test de classe B.' }))
    const fr = phrase.cells.find((cell: Json) => cell.language === 'fr').draft
    ;({ phrase } = await ok('manager', 'DELETE', `/compliance/rules/phrases/warning.test-b/translations/${fr.id}?version=${fr.version}`))
    expect(phrase.cells.find((cell: Json) => cell.language === 'fr').state).toBe('MISSING')
    const approved = history[0]
    expect((await refused('manager', 'DELETE', `/compliance/rules/phrases/warning.test-b/translations/${approved.id}?version=1`, undefined, 409)).issues[0].path).toBe('refusal/NOT_DRAFT')
    await refused('viewer', 'POST', '/compliance/rules/phrases', { key: 'x.y', kind: 'CARE', sourceText: 'x' }, 403)
  })
})

describe('the public DoC page\'s sender (Owner question 3)', () => {
  it('is the brand for its style sold under its name, from its manufacturer row; the company once sold under our name', async () => {
    const asSystem = { audience: 'office', tenantId: tenant, actorId: SYSTEM_ACTOR_ID } as const
    const sender = await database.withScope(asSystem, (client) => readDocSender(client, { tenantId: tenant, kind: 'STYLE', id: jacket }, companyA, '2026-11-10'))
    expect(sender).toMatchObject({ makerRole: 'BRAND', sender: { companyId: companyA, name: 'Seed Customer One S.r.l.', logoPath: null }, contact: { email: 'compliance.p1@example.com' } })
    await admin(`UPDATE "Style" SET "soldUnderOurName" = true WHERE id = $1`, [jacket])
    const ours = await database.withScope(asSystem, (client) => readDocSender(client, { tenantId: tenant, kind: 'STYLE', id: jacket }, companyA, '2026-11-10'))
    expect(ours).toMatchObject({ makerRole: 'COMPANY', sender: { companyId: companyA } })
    expect(ours!.sender.name).not.toBe('Seed Customer One S.r.l.')
  })
})
