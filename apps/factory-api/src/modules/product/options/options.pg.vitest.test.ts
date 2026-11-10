import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Options and configuration rules on the local stack (B-W2b-229; PRD-081, PRD-206, PRD-207, PRD-208, PRD-211), with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security and
 * B-W2b-211's …_bom_options_w2b_guards are real), B-W2b-211's options seed (the liner, perforation, name and armour groups with
 * their rules and effects; SEED-JKT-05 offering all four, revision 1 DRAFT with the liner line only for LINER/YES and the
 * perforation step only for PERF/FRONT), and sessions from the test authenticator. Every code and name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/options`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let S: OptionsSeed

const NS = 'options-api-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const lastId = (key: string): string => `ffffffff${seedId(key).slice(8)}`
const tenant = seedId('tenant')

const PEOPLE: Record<string, { tenantId: string; permissions: readonly Permission[]; companies: ScopeSet }> = {
  maker: {
    tenantId: tenant,
    permissions: ['product.styles.view', 'product.styles.manage', 'product.options.manage', 'product.bom.view', 'product.bom.manage', 'product.routing.view', 'product.routing.manage', 'product.materials.view', 'audit.read'],
    companies: 'all',
  },
  pricer: { tenantId: tenant, permissions: ['product.styles.view', 'product.options.price', 'money.price'], companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.styles.view'], companies: 'all' },
  otherTenant: { tenantId: newId(), permissions: ['product.styles.view', 'product.options.manage'], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: newId(), grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const events = async (subject: string, type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])
const groupUrl = (groupId: string) => `/product/option-groups/${groupId}`
const valueUrl = (groupId: string, valueId: string) => `${groupUrl(groupId)}/values/${valueId}`
const groupOf = async (groupId: string, session = 'maker'): Promise<Json> => (await ok(session, 'GET', groupUrl(groupId))).group
const valueVersion = async (valueId: string) => (await admin<{ version: number }>('SELECT version FROM "OptionValue" WHERE id = $1', [valueId]))[0]!.version
const revisionVersion = async (revisionId: string) => (await admin<{ version: number }>('SELECT version FROM "StyleRevision" WHERE id = $1', [revisionId]))[0]!.version

beforeAll(async () => {
  db = await migratedDatabase('product_options')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  S = await seedOptions({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the option library (PRD-206, PRD-207, PRD-208, PRD-211)', () => {
  it('lists the groups with their counts and the certificate tile; reads a record with values, rules, effects and styles', async () => {
    const list = await ok('viewer', 'GET', '/product/option-groups')
    expect(list.groups.map((group: Json) => [group.code, group.kind, group.picks.en, group.values, group.styles, group.rules, group.outsideCertificate])).toEqual([
      ['SEED-OG-ARMOUR', 'SINGLE', '1–1', 2, 1, 0, 1],
      ['SEED-OG-LINER', 'SINGLE', '0–1', 1, 1, 1, 0],
      ['SEED-OG-NAME', 'FREE_TEXT', '0–1', 1, 1, 0, 0],
      ['SEED-OG-PERF', 'SINGLE', '0–1', 2, 1, 1, 0],
    ])
    expect(list.counts).toEqual({ all: 4, outsideCertificate: 1 })
    expect((await ok('viewer', 'GET', '/product/option-groups?outsideCertificate=true')).groups.map((group: Json) => group.code)).toEqual(['SEED-OG-ARMOUR'])

    const perf = await groupOf(S.groupIds.perforation, 'viewer')
    expect(perf.values.map((value: Json) => [value.code, value.usedBy])).toEqual([
      ['FRONT', { lines: 0, steps: 1 }],
      ['FULL', { lines: 0, steps: 0 }],
    ])
    expect(perf.rules).toEqual([
      expect.objectContaining({
        valueId: S.valueIds.perfFull,
        when: { combinator: 'and', rows: [{ id: 'subject', field: 'option', operator: 'eq', value: S.valueIds.perfFull }] },
        kind: 'EXCLUDES',
        other: expect.objectContaining({ code: 'YES', groupCode: 'SEED-OG-LINER' }),
        words: { it: 'Foratura totale esclude Imbottitura termica removibile — blocca', en: 'Full perforation excludes Removable thermal liner — block' },
        broken: { it: "La foratura totale esclude l'imbottitura termica", en: 'Full perforation excludes the thermal liner' },
      }),
    ])
    expect(perf.effects.map((effect: Json) => effect.words.en).sort()).toEqual(['+6 min at SEED-CUT-LEA', 'Adds operation SEED-PERF (standard minutes)', 'Moves the price', 'Moves the price', 'Puts SEED-LIN-210 in place of SEED-LIN-200'])
    // Money only with the price grain: the viewer reads no surcharge, the pricer does.
    expect(perf.effects.every((effect: Json) => !('priceDelta' in effect) && !('pricePct' in effect))).toBe(true)
    const priced = await groupOf(S.groupIds.perforation, 'pricer')
    const surcharge = (valueId: string) => priced.effects.filter((effect: Json) => effect.kind === 'PRICE' && effect.valueId === valueId).map((effect: Json) => [effect.priceDelta, effect.currency, effect.pricePct])
    expect(surcharge(S.valueIds.perfFront)).toEqual([[null, null, '5']])
    expect(surcharge(S.valueIds.perfFull)).toEqual([['40', 'EUR', null]])
    expect(perf.styles).toEqual([expect.objectContaining({ style: expect.objectContaining({ code: 'SEED-JKT-05' }), picks: { it: '0–1', en: '0–1' } })])
    expect(perf.subjectOptions.map((option: Json) => option.value)).toEqual(['*', S.valueIds.perfFront, S.valueIds.perfFull])
    expect(perf.may).toEqual({ manage: false, price: false })
    expect((await groupOf(S.groupIds.perforation)).may).toEqual({ manage: true, price: false })
    await refused('otherTenant', 'GET', groupUrl(S.groupIds.perforation), undefined, 404)
  })

  it('creates a group, its values and their free-text rules; refuses what the database would, in words', async () => {
    const created = (await ok('maker', 'POST', '/product/option-groups', { code: 'T-HOOD', name: 'Hood', nameI18n: { it: 'Cappuccio', en: 'Hood' }, kind: 'SINGLE' }, 201)).group
    expect(created).toMatchObject({ code: 'T-HOOD', kind: 'SINGLE', minPicks: 0, maxPicks: 1, companyId: null, values: [], version: 1 })
    expect((await events(created.id, 'option_group.changed')).map((event) => event.payload.change)).toEqual(['CREATED'])
    expect((await refused('maker', 'POST', '/product/option-groups', { code: 'T-HOOD', name: 'Again', kind: 'MULTI' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/code' })])
    expect((await refused('maker', 'POST', '/product/option-groups', { code: 'T-X', name: 'X', kind: 'SINGLE', maxPicks: 2 }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/maxPicks' })])
    await refused('viewer', 'POST', '/product/option-groups', { code: 'T-Y', name: 'Y', kind: 'MULTI' }, 403)

    const hood = (await ok('maker', 'POST', `${groupUrl(created.id)}/values`, { code: 'YES', name: 'Detachable hood' }, 201)).group
    expect(hood.values.map((value: Json) => [value.code, value.seq, value.freeText])).toEqual([['YES', 10, false]])
    // A free-text value: a length, and a pattern every check reads alike (JavaScript and PostgreSQL).
    const name = S.groupIds.name
    expect((await refused('maker', 'POST', `${groupUrl(name)}/values`, { code: 'NICK', name: 'Nickname' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/freeTextMaxLength' })])
    expect((await refused('maker', 'POST', `${groupUrl(name)}/values`, { code: 'NICK', name: 'Nickname', freeTextMaxLength: 10, freeTextPattern: '^[[:alpha:]]+$' }, 400)).issues[0].message).toContain('[[:alpha:]]')
    expect((await refused('maker', 'POST', `${groupUrl(name)}/values`, { code: 'NICK', name: 'Nickname', freeTextMaxLength: 10, freeTextPattern: '^(?<nick>[a-z]+)$' }, 400)).issues).toEqual([
      expect.objectContaining({ path: 'body/freeTextPattern', message: expect.stringContaining('database does not read') }),
    ])
    const nick = (await ok('maker', 'POST', `${groupUrl(name)}/values`, { code: 'NICK', name: 'Nickname', freeTextMaxLength: 10, freeTextPattern: '^[a-z]+$' }, 201)).group
    expect(nick.values.find((value: Json) => value.code === 'NICK')).toMatchObject({ freeText: true, freeTextMaxLength: 10, freeTextPattern: '^[a-z]+$' })

    // A change at the value's version; a stale one is refused.
    const yes = hood.values[0]
    const changed = (await ok('maker', 'PATCH', valueUrl(created.id, yes.id), { version: yes.version, name: 'Detachable storm hood' })).group
    expect(changed.values[0]).toMatchObject({ name: 'Detachable storm hood', version: yes.version + 1 })
    expect((await refused('maker', 'PATCH', valueUrl(created.id, yes.id), { version: yes.version, name: 'Old' }, 409)).code).toBe('conflict')
    // The group's picks and kind: a MULTI group of 3 at most, then single again.
    const multi = (await ok('maker', 'PATCH', groupUrl(created.id), { version: created.version, kind: 'MULTI', maxPicks: 3 })).group
    expect(multi).toMatchObject({ kind: 'MULTI', maxPicks: 3, version: created.version + 1 })
    expect((await ok('maker', 'PATCH', groupUrl(created.id), { version: multi.version, kind: 'SINGLE' })).group).toMatchObject({ kind: 'SINGLE', maxPicks: 1 })
    // FREE_TEXT only when every value takes a text.
    expect((await refused('maker', 'PATCH', groupUrl(S.groupIds.perforation), { version: (await groupOf(S.groupIds.perforation)).version, kind: 'FREE_TEXT' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/kind', message: expect.stringContaining('2 value(s)') })])
  })

  it('saves a group\'s rules as a set from RuleBuilder drafts; refuses a bad set in words and a stale version', async () => {
    const liner = await groupOf(S.groupIds.liner)
    const keep = liner.rules[0]
    const rules = [
      { id: keep.id, when: keep.when, kind: keep.kind, otherValueId: keep.otherValueId, severity: keep.severity },
      { when: { combinator: 'and', rows: [{ id: 'r', field: 'option', operator: 'eq', value: '*' }] }, kind: 'EXCLUDES', otherValueId: S.valueIds.perfFull, severity: 'WARN', message: { en: 'A liner and full perforation fight each other.' } },
    ]
    const saved = (await ok('maker', 'PUT', `${groupUrl(S.groupIds.liner)}/rules`, { version: liner.version, rules })).group
    expect(saved.version).toBe(liner.version + 1)
    // The kept rule was sent without its message: it keeps it.
    expect(saved.rules.map((rule: Json) => [rule.kind, rule.valueId, rule.words.en, rule.broken.en, rule.status]).sort()).toEqual([
      ['EXCLUDES', null, 'Any option of Thermal liner excludes Full perforation — warning', 'A liner and full perforation fight each other.', 'ACTIVE'],
      ['REQUIRES', S.valueIds.linerYes, 'Removable thermal liner requires Standard shoulder protectors — warning', 'The liner is cut for the standard shoulder protectors', 'ACTIVE'],
    ])
    expect((await events(S.groupIds.liner, 'option_group.changed')).map((event) => event.payload.change)).toEqual(['RULES'])
    // The rule kept its id; a stale version and a bad set are refused.
    expect(saved.rules.find((rule: Json) => rule.kind === 'REQUIRES').id).toBe(keep.id)
    await refused('maker', 'PUT', `${groupUrl(S.groupIds.liner)}/rules`, { version: liner.version, rules }, 409)
    const bad = await refused(
      'maker',
      'PUT',
      `${groupUrl(S.groupIds.liner)}/rules`,
      {
        version: saved.version,
        rules: [
          { when: { combinator: 'and', rows: [{ id: 'r', field: 'option', operator: 'in', value: [S.valueIds.linerYes] }] }, kind: 'REQUIRES', otherValueId: S.valueIds.armourStd, severity: 'BLOCK' },
        ],
      },
      400,
    )
    expect(bad.issues).toEqual([expect.objectContaining({ path: 'body/rules/0/when/rows/0/operator' })])
    const twice = await refused(
      'maker',
      'PUT',
      `${groupUrl(S.groupIds.liner)}/rules`,
      {
        version: saved.version,
        rules: [
          { when: { rows: [{ id: 'a', field: 'option', operator: 'eq', value: '*' }] }, kind: 'EXCLUDES', otherValueId: S.valueIds.linerYes, severity: 'BLOCK' },
          { when: { rows: [{ id: 'b', field: 'option', operator: 'eq', value: S.valueIds.linerYes }] }, kind: 'REQUIRES', otherValueId: S.valueIds.armourStd, severity: 'BLOCK' },
          { when: { rows: [{ id: 'c', field: 'option', operator: 'eq', value: S.valueIds.linerYes }] }, kind: 'EXCLUDES', otherValueId: S.valueIds.armourStd, severity: 'BLOCK' },
        ],
      },
      400,
    )
    expect(twice.issues.map((issue: Json) => issue.path)).toEqual(['body/rules/0/otherValueId', 'body/rules/2/kind'])
    // An option an active rule requires is kept: change the rule first.
    const std = await valueVersion(S.valueIds.armourStd)
    expect((await refused('maker', 'POST', `${valueUrl(S.groupIds.armour, S.valueIds.armourStd)}/archive`, { version: std }, 409)).message).toContain('required by 1 active rule')
    // Back to the seeded rule alone (the check below reads the seeded rules).
    await ok('maker', 'PUT', `${groupUrl(S.groupIds.liner)}/rules`, { version: saved.version, rules: [rules[0]] })
  })

  it("keeps an option's effects (the value's version) and its price surcharge (the price grain)", async () => {
    const hood = (await ok('maker', 'GET', '/product/option-groups?q=T-HOOD')).groups[0]
    const record = await groupOf(hood.id)
    const yes = record.values[0]
    const thread = S.itemIds.thread
    const added = (await ok('maker', 'POST', `${valueUrl(hood.id, yes.id)}/effects`, { version: yes.version, kind: 'BOM_ADD', itemId: thread, qty: '2.5', uom: 'M', section: 'THREAD' }, 201)).group
    const effect = added.effects[0]
    expect(effect).toMatchObject({ kind: 'BOM_ADD', item: { code: 'SEED-THR-530' }, qty: '2.5', uom: 'M', section: 'THREAD', words: { en: 'Adds SEED-THR-530 2.5 M · THREAD' } })
    expect(added.values[0].version).toBe(yes.version + 1)
    // Each kind its columns; a price is not an effect of this route.
    expect((await refused('maker', 'POST', `${valueUrl(hood.id, yes.id)}/effects`, { version: yes.version + 1, kind: 'BOM_ADD', itemId: thread, uom: 'M' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/qty' })])
    await refused('maker', 'POST', `${valueUrl(hood.id, yes.id)}/effects`, { version: yes.version + 1, kind: 'PRICE' }, 400)
    const certificate = (await ok('maker', 'POST', `${valueUrl(hood.id, yes.id)}/effects`, { version: yes.version + 1, kind: 'CERTIFICATE', note: 'A hood is not tested with the jacket.' }, 201)).group
    expect(certificate.values[0].outsideCertificate).toBe(true)
    const edited = (await ok('maker', 'PATCH', `${valueUrl(hood.id, yes.id)}/effects/${effect.id}`, { version: yes.version + 2, qty: '3' })).group
    expect(edited.effects.find((entry: Json) => entry.id === effect.id).qty).toBe('3')
    // The price: product.options.price with money.price.
    await refused('maker', 'PUT', `${valueUrl(hood.id, yes.id)}/price`, { version: yes.version + 3, currency: 'EUR' }, 403)
    const priced = (await ok('pricer', 'PUT', `${valueUrl(hood.id, yes.id)}/price`, { version: yes.version + 3, priceDelta: '35', currency: 'EUR' })).group
    expect(priced.effects.find((entry: Json) => entry.kind === 'PRICE')).toMatchObject({ priceDelta: '35', currency: 'EUR', pricePct: null })
    expect((await refused('pricer', 'PUT', `${valueUrl(hood.id, yes.id)}/price`, { version: yes.version + 4, priceDelta: '5', pricePct: '3', currency: 'EUR' }, 400)).issues[0].path).toBe('body/priceDelta')
    const pct = (await ok('pricer', 'PUT', `${valueUrl(hood.id, yes.id)}/price`, { version: yes.version + 4, pricePct: '7.5' })).group
    expect(pct.effects.filter((entry: Json) => entry.kind === 'PRICE').map((entry: Json) => [entry.priceDelta, entry.pricePct])).toEqual([[null, '7.5']])
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'OptionValue' AND "recordId" = $1 AND action = 'product.options.setPrice' ORDER BY at DESC LIMIT 1`, [yes.id])
    expect(audit[0]!.after).toMatchObject({ pricePct: { $money: 'price', value: '7.5' } })
    // The effects route never touches the price.
    const priceId = pct.effects.find((entry: Json) => entry.kind === 'PRICE').id
    expect((await refused('maker', 'DELETE', `${valueUrl(hood.id, yes.id)}/effects/${priceId}?version=${yes.version + 5}`, undefined, 409)).message).toContain('price surcharge')
    const removed = (await ok('maker', 'DELETE', `${valueUrl(hood.id, yes.id)}/effects/${effect.id}?version=${yes.version + 5}`)).group
    expect(removed.effects.map((entry: Json) => entry.kind)).toEqual(['CERTIFICATE', 'PRICE'])
  })
})

describe("a style's options, its option lines and steps (PRD-206, PRD-081, PRD-128)", () => {
  const jacketUrl = () => `/product/styles/${S.jacketStyleId}`

  it('reads the offers with their values, the option lines and steps of every revision', async () => {
    const { options } = await ok('viewer', 'GET', `${jacketUrl()}/options`)
    expect(options.offers.map((offer: Json) => [offer.group.code, offer.seq, offer.picks.en, offer.defaultValueId, offer.status])).toEqual([
      ['SEED-OG-LINER', 1, '0–1', null, 'ACTIVE'],
      ['SEED-OG-PERF', 2, '0–1', null, 'ACTIVE'],
      ['SEED-OG-NAME', 3, '0–1', null, 'ACTIVE'],
      ['SEED-OG-ARMOUR', 4, '1–1', S.valueIds.armourStd, 'ACTIVE'],
    ])
    expect(options.offers[3].values.map((value: Json) => [value.code, value.outsideCertificate])).toEqual([
      ['STD', false],
      ['NONE', true],
    ])
    expect(options.lines).toEqual([expect.objectContaining({ lineId: S.bomLineIds.liner, seq: 40, option: 'SEED-OG-LINER: YES', revision: expect.objectContaining({ revision: 1, status: 'DRAFT' }) })])
    expect(options.steps).toEqual([expect.objectContaining({ seq: 20, code: 'SEED-PERF', options: ['SEED-OG-PERF: FRONT'] })])
    expect(options.editable).toBe(false)
  })

  it('offers a group, changes the offer, withdraws it (removed or archived), under the edit rule', async () => {
    const hood = (await ok('maker', 'GET', '/product/option-groups?q=T-HOOD')).groups[0]
    const offered = (await ok('maker', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: null, maxPicks: 1 })).options
    const offer = offered.offers.find((entry: Json) => entry.group.code === 'T-HOOD')
    expect(offer).toMatchObject({ seq: 14, maxPicks: 1, version: 1, status: 'ACTIVE' })
    expect((await events(S.jacketStyleId, 'style.updated')).map((event) => event.payload.fields)).toEqual([['optionGroups']])
    expect((await refused('maker', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: null }, 409)).message).toContain('offers T-HOOD already')
    expect((await refused('maker', 'PUT', `${jacketUrl()}/options/${S.groupIds.armour}`, { version: 1, minPicks: 2 }, 400)).issues[0].path).toBe('body/minPicks')
    const yes = (await groupOf(hood.id)).values[0]
    const changed = (await ok('maker', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: 1, seq: 5, defaultValueId: yes.id })).options
    expect(changed.offers.find((entry: Json) => entry.group.code === 'T-HOOD')).toMatchObject({ seq: 5, defaultValueId: yes.id, version: 2 })
    await refused('maker', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: 1, seq: 6 }, 409)
    await refused('viewer', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: 2, seq: 6 }, 403)

    // B-W2b-221's edit rule: a discontinued style changes nothing (its rule is "blocked"), in words.
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Style" SET lifecycle = 'DISCONTINUED' WHERE id = '${S.jacketStyleId}'; COMMIT;`)
    const blocked = await refused('maker', 'PUT', `${jacketUrl()}/options/${hood.id}`, { version: 2, seq: 6 }, 409)
    expect(blocked.issues).toEqual([expect.objectContaining({ path: 'refusal/EDIT_BLOCKED' })])
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Style" SET lifecycle = 'CONCEPT' WHERE id = '${S.jacketStyleId}'; COMMIT;`)

    // Nothing of the style names the hood: removed. The liner's line 40 names LINER/YES: archived.
    const removed = await ok('maker', 'POST', `${jacketUrl()}/options/${hood.id}/withdraw`, { version: 2 })
    expect(removed).toMatchObject({ withdrawn: 'REMOVED' })
    expect(removed.options.offers.some((entry: Json) => entry.group.code === 'T-HOOD')).toBe(false)
    const linerOffer = removed.options.offers.find((entry: Json) => entry.group.code === 'SEED-OG-LINER')
    const archived = await ok('maker', 'POST', `${jacketUrl()}/options/${S.groupIds.liner}/withdraw`, { version: linerOffer.version })
    expect(archived).toMatchObject({ withdrawn: 'ARCHIVED', words: { en: expect.stringContaining('1 BOM line(s) and 0 routing step(s)') } })
    // Offered again (a new ACTIVE offer beside the archived one).
    const again = (await ok('maker', 'PUT', `${jacketUrl()}/options/${S.groupIds.liner}`, { version: null, seq: 1 })).options
    expect(again.offers.filter((entry: Json) => entry.group.code === 'SEED-OG-LINER').map((entry: Json) => entry.status)).toEqual(['ACTIVE', 'ARCHIVED'])
  })

  it('makes a draft BOM line only for an option, and a routing step only for options the style offers', async () => {
    const revisionUrl = `${jacketUrl()}/revisions/${S.jacketRevisionId}`
    const version = await revisionVersion(S.jacketRevisionId)
    const answer = await ok('maker', 'PUT', `${revisionUrl}/bom/lines/${S.bomLineIds.label}/option`, { version, optionValueId: S.valueIds.perfFull })
    expect(answer).toMatchObject({ line: { id: S.bomLineIds.label, seq: 50, optionValueId: S.valueIds.perfFull, option: 'SEED-OG-PERF: FULL' }, revision: { version: version + 1 } })
    expect((await events(S.jacketStyleId, 'style.bom_changed')).slice(-1)[0]!.payload).toMatchObject({ lineIds: [S.bomLineIds.label] })
    const hood = (await ok('maker', 'GET', '/product/option-groups?q=T-HOOD')).groups[0]
    const hoodYes = (await groupOf(hood.id)).values[0]
    expect((await refused('maker', 'PUT', `${revisionUrl}/bom/lines/${S.bomLineIds.label}/option`, { version: version + 1, optionValueId: hoodYes.id }, 400)).issues).toEqual([
      expect.objectContaining({ path: 'body/optionValueId', message: expect.stringContaining('does not offer T-HOOD') }),
    ])
    await ok('maker', 'PUT', `${revisionUrl}/bom/lines/${S.bomLineIds.label}/option`, { version: version + 1, optionValueId: null })
    // A released revision's line is frozen (409 in words).
    const linerRevision = `/product/styles/${S.linerStyleId}/revisions/${S.linerRevisionId}`
    const lines = await admin<{ id: string }>('SELECT id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [S.linerRevisionId])
    expect((await refused('maker', 'PUT', `${linerRevision}/bom/lines/${lines[0]!.id}/option`, { version: await revisionVersion(S.linerRevisionId), optionValueId: null }, 409)).message).toContain('frozen')

    // B-W2b-225's steps only for options, wired: the perforation step for full perforation too.
    const step = lastId('options:routing:JKT-05:1:SEED-PERF')
    const stepUrl = `${revisionUrl}/routing/steps/${step}/variants`
    const routing = (await ok('maker', 'PUT', stepUrl, { version: await revisionVersion(S.jacketRevisionId), optionValueIds: [S.valueIds.perfFull, S.valueIds.perfFront] })).routing
    expect(routing.options).toMatchObject({ available: true })
    expect(routing.steps.find((entry: Json) => entry.stepId === step).variants).toMatchObject({ optionValueIds: [S.valueIds.perfFront, S.valueIds.perfFull], words: { en: 'Only for options SEED-OG-PERF: FRONT, SEED-OG-PERF: FULL' } })
    expect((await refused('maker', 'PUT', stepUrl, { version: await revisionVersion(S.jacketRevisionId), optionValueIds: [hoodYes.id] }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/optionValueIds/0' })])
  })
})

describe('THE check of a configuration (PRD-207), with the effects (PRD-208)', () => {
  const checkUrl = () => `/product/styles/${S.jacketStyleId}/options/check`

  it('blocks a rule, a text and a count in words; takes the default; reads what the choice does', async () => {
    const blocked = (await ok('viewer', 'POST', checkUrl(), { picks: [{ valueId: S.valueIds.perfFull }, { valueId: S.valueIds.linerYes }] })).check
    expect(blocked).toMatchObject({ ok: false, warnings: [] })
    expect(blocked.blocks.map((finding: Json) => [finding.code, finding.message.en])).toEqual([['EXCLUDES', 'Full perforation excludes the thermal liner']])
    expect(blocked.chosen.map((entry: Json) => [entry.groupCode, entry.code, entry.byDefault])).toEqual([
      ['SEED-OG-PERF', 'FULL', false],
      ['SEED-OG-LINER', 'YES', false],
      ['SEED-OG-ARMOUR', 'STD', true],
    ])
    const text = (await ok('viewer', 'POST', checkUrl(), { picks: [{ valueId: S.valueIds.name, text: 'R2-D2' }, { valueId: S.valueIds.armourStd }, { valueId: S.valueIds.armourNone }] })).check
    expect(text.blocks.map((finding: Json) => [finding.code, finding.path])).toEqual([
      ['TEXT', 'picks/0'],
      ['TOO_MANY', `groups/${S.groupIds.armour}`],
    ])
    const warned = (await ok('viewer', 'POST', checkUrl(), { picks: [{ valueId: S.valueIds.linerYes }, { valueId: S.valueIds.armourNone }] })).check
    expect(warned).toMatchObject({ ok: true, blocks: [] })
    expect(warned.warnings.map((finding: Json) => finding.message.en)).toEqual(['The liner is cut for the standard shoulder protectors'])

    const full = (await ok('pricer', 'POST', checkUrl(), { picks: [{ valueId: S.valueIds.perfFull }, { valueId: S.valueIds.armourNone }, { valueId: S.valueIds.name, text: 'Ann' }] })).check
    expect(full.ok).toBe(true)
    expect(full.effects).toMatchObject({ minutesAdded: '4', operationsAtStandard: 1, outsideCertificate: true, price: { byCurrency: [{ currency: 'EUR', delta: '30' }], percent: null } })
    expect(full.effects.certificateNotes).toEqual([{ valueId: S.valueIds.armourNone, note: expect.stringContaining('not the certified class AA') }])
    expect(full.bom).toMatchObject({
      revision: { id: S.jacketRevisionId, status: 'DRAFT' },
      optionLinesTaken: [],
      optionLinesLeftOut: [S.bomLineIds.liner],
      removed: [{ lineId: S.bomLineIds.protector, seq: 30 }],
      replaced: [{ lineId: S.bomLineIds.lining, seq: 20, item: { code: 'SEED-LIN-210' } }],
      added: [expect.objectContaining({ kind: 'BOM_ADD', words: expect.objectContaining({ en: expect.stringContaining('SEED-THR-530') }) })],
      notes: [],
    })
    // Without the price grain the surcharges are not in the answer.
    expect('price' in (await ok('viewer', 'POST', checkUrl(), { picks: [{ valueId: S.valueIds.perfFull }] })).check.effects).toBe(false)
    // An option of no group the style offers, and another tenant's caller.
    const other = (await ok('viewer', 'POST', checkUrl(), { picks: [{ valueId: newId() }], useDefaults: false })).check
    expect(other.blocks.map((finding: Json) => finding.code)).toEqual(['NOT_OFFERED', 'TOO_FEW'])
    await refused('otherTenant', 'POST', checkUrl(), { picks: [] }, 404)
  })
})
