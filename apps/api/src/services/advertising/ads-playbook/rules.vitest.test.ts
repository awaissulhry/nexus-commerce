/**
 * ADS PLAYBOOK PB-6a — a compiled rule saved once (rules.ts) on a real PostgreSQL with the production schema and every
 * business policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   once      the first save writes the rule (propose-only, a dry run, one run a day, born off) and its link; the same
 *             compile again writes nothing
 *   re-sync   a changed compile changes the action and the name only — the on/off and the autonomy level stay his
 *   start     switches it on, never over a switch-off made after the last start (the start mark, or the change log)
 *   business  another business sees neither the rule nor the link, and its own save of the same key is its own
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { ensureCompiledRule } from './rules.js'

const A = 'pb6a_rules_alpha'
const B = 'pb6a_rules_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client

const action = { type: 'harvest_and_negate', v: 2, control: 'manual', mode: 'both', playbookId: 'pb_test_1', market: 'IT', cadenceDays: 1, homeScope: ['ag_test_1'], sources: [] }
const save = (over: Partial<Parameters<typeof ensureCompiledRule>[0]> = {}) => ensureCompiledRule({
  playbookId: 'pb_test_1', kind: 'harvestRule', key: 'harvest', name: 'TEST-SKU (IT) — harvest', action, enabled: false, compiledVersion: 1, actor: 'user:test', ...over,
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('PB-6a — ensureCompiledRule', () => {
  it('the first save writes the rule (born off) and its link; the same compile again writes nothing', async () => {
    const first = await inA(() => save())
    expect(first).toMatchObject({ created: true, changed: true, enabled: false })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: first.ruleId } }))
    expect(rule).toMatchObject({
      workspaceId: A, domain: 'advertising', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', maxExecutionsPerDay: 1, actions: [action],
    })
    expect(await inA(() => db().adsPlaybookLink.findMany())).toEqual([
      expect.objectContaining({ playbookId: 'pb_test_1', kind: 'harvestRule', key: 'harvest', refId: first.ruleId, origin: 'built', compiledVersion: 1 }),
    ])
    // jsonb keeps its own key order: the same compile, keys in another order, is unchanged.
    const again = await inA(() => save({ action: Object.fromEntries(Object.entries(action).reverse()) }))
    expect(again).toEqual({ ruleId: first.ruleId, created: false, changed: false, enabled: false })
    expect(await inA(() => db().automationRule.count())).toBe(1)
  })

  it('a re-sync changes the action and the name only: never the on/off, never the autonomy level a person set', async () => {
    const { ruleId } = await inA(() => save())
    await inA(() => db().automationRule.update({ where: { id: ruleId }, data: { autonomyLevel: 'NOTIFY', maxExecutionsPerDay: 2 } }))
    const resynced = await inA(() => save({ action: { ...action, cadenceDays: 7 }, enabled: true, name: 'TEST-SKU (IT) — harvest, weekly', compiledVersion: 2 }))
    expect(resynced).toEqual({ ruleId, created: false, changed: true, enabled: false })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(rule).toMatchObject({ autonomyLevel: 'NOTIFY', maxExecutionsPerDay: 2, enabled: false, name: 'TEST-SKU (IT) — harvest, weekly', actions: [{ ...action, cadenceDays: 7 }] })
    expect((await inA(() => db().adsPlaybookLink.findFirstOrThrow())).compiledVersion).toBe(2)
  })

  it('🔴 a start switches it on; a person switches it off; a re-sync and a later start leave it off, and say who', async () => {
    const weekly = { ...action, cadenceDays: 7 }
    const started = await inA(() => save({ action: weekly, start: true, compiledVersion: 2, name: 'TEST-SKU (IT) — harvest, weekly' }))
    expect(started).toMatchObject({ changed: true, enabled: true })
    const { ruleId } = started
    const on = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect((on.actions as Array<{ startedAt?: string }>)[0].startedAt).toEqual(expect.any(String))
    expect(await inA(() => db().advertisingActionLog.count({ where: { entityId: ruleId, actionType: 'update_rule' } }))).toBe(1)
    // The re-sync after the start compares equal (the start mark is the writer's own).
    expect(await inA(() => save({ action: weekly, compiledVersion: 2, name: 'TEST-SKU (IT) — harvest, weekly' }))).toMatchObject({ changed: false, enabled: true })

    // The person's switch, as the rules screen records it.
    await inA(async () => {
      await db().automationRule.update({ where: { id: ruleId }, data: { enabled: false } })
      await db().advertisingActionLog.create({ data: { userId: 'user:owner-test', actionType: 'update_rule', entityType: 'RULE', entityId: ruleId, payloadBefore: { enabled: true }, payloadAfter: { enabled: false }, amazonResponseStatus: 'SUCCESS' } })
    })
    expect(await inA(() => save({ action: { ...weekly, cadenceDays: 1 }, compiledVersion: 3 }))).toMatchObject({ changed: true, enabled: false })
    const again = await inA(() => save({ action: { ...weekly, cadenceDays: 1 }, start: true, compiledVersion: 3 }))
    expect(again).toMatchObject({ enabled: false, keptOff: expect.stringMatching(/^It stays off: user:owner-test switched it off after the playbook last started it/) })
    expect((await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))).enabled).toBe(false)
  })

  it('a start never overrides a logged switch-off, even on a rule no start ever switched on', async () => {
    const { ruleId } = await inA(() => save({ key: 'harvest-2', action: { ...action, market: 'DE' } }))
    await inA(() => db().advertisingActionLog.create({ data: { userId: 'user:owner-test', actionType: 'update_rule', entityType: 'RULE', entityId: ruleId, payloadBefore: { enabled: true }, payloadAfter: { enabled: false }, amazonResponseStatus: 'SUCCESS' } }))
    expect(await inA(() => save({ key: 'harvest-2', action: { ...action, market: 'DE' }, start: true }))).toMatchObject({ ruleId, enabled: false, keptOff: expect.stringContaining('user:owner-test') })
  })

  it('another business sees neither; its own save of the same key is its own rule and link', async () => {
    expect(await inB(() => db().automationRule.findMany())).toEqual([])
    expect(await inB(() => db().adsPlaybookLink.findMany())).toEqual([])
    const theirs = await inB(() => save())
    expect(theirs.created).toBe(true)
    expect((await inB(() => db().automationRule.findUniqueOrThrow({ where: { id: theirs.ruleId } }))).workspaceId).toBe(B)
    expect(await inA(() => db().automationRule.count())).toBe(2)
  })

  it('the rule is scoped to its market: set on the first save, kept by a re-sync that does not name it, moved by one that does', async () => {
    const { ruleId } = await inA(() => save({ key: 'harvest-scope', scopeMarketplace: 'TEST-MKT-1' }))
    const scopeOf = async () => (await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))).scopeMarketplace
    expect(await scopeOf()).toBe('TEST-MKT-1')
    expect(await inA(() => save({ key: 'harvest-scope' }))).toMatchObject({ ruleId, changed: false })
    expect(await scopeOf()).toBe('TEST-MKT-1')
    expect(await inA(() => save({ key: 'harvest-scope', scopeMarketplace: 'TEST-MKT-2' }))).toMatchObject({ ruleId, changed: true })
    expect(await scopeOf()).toBe('TEST-MKT-2')
  })
})
