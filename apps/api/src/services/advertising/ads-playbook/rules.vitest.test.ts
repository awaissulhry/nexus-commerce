/**
 * ADS PLAYBOOK PB-6a — a compiled rule saved once (rules.ts) on a real PostgreSQL with the production schema and every
 * business policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   once      the first save writes the rule (propose-only, a dry run, one run a day) and its link; the same compile
 *             again writes nothing
 *   re-save   a changed compile changes the action, the name and `enabled` only — the autonomy level a person set stays
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
  it('the first save writes the rule and its link; the same compile again writes nothing', async () => {
    const first = await inA(() => save())
    expect(first).toMatchObject({ created: true, changed: true })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: first.ruleId } }))
    expect(rule).toMatchObject({
      workspaceId: A, domain: 'advertising', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', maxExecutionsPerDay: 1, actions: [action],
    })
    expect(await inA(() => db().adsPlaybookLink.findMany())).toEqual([
      expect.objectContaining({ playbookId: 'pb_test_1', kind: 'harvestRule', key: 'harvest', refId: first.ruleId, origin: 'built', compiledVersion: 1 }),
    ])
    // jsonb keeps its own key order: the same compile, keys in another order, is unchanged.
    const again = await inA(() => save({ action: Object.fromEntries(Object.entries(action).reverse()) }))
    expect(again).toEqual({ ruleId: first.ruleId, created: false, changed: false })
    expect(await inA(() => db().automationRule.count())).toBe(1)
  })

  it('a re-save changes the action, the name and enabled — never the autonomy level a person set', async () => {
    const { ruleId } = await inA(() => save())
    await inA(() => db().automationRule.update({ where: { id: ruleId }, data: { autonomyLevel: 'NOTIFY', maxExecutionsPerDay: 2 } }))
    const resaved = await inA(() => save({ action: { ...action, cadenceDays: 7 }, enabled: true, name: 'TEST-SKU (IT) — harvest, weekly', compiledVersion: 2 }))
    expect(resaved).toEqual({ ruleId, created: false, changed: true })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(rule).toMatchObject({ autonomyLevel: 'NOTIFY', maxExecutionsPerDay: 2, enabled: true, name: 'TEST-SKU (IT) — harvest, weekly', actions: [{ ...action, cadenceDays: 7 }] })
    expect((await inA(() => db().adsPlaybookLink.findFirstOrThrow())).compiledVersion).toBe(2)
  })

  it('another business sees neither; its own save of the same key is its own rule and link', async () => {
    expect(await inB(() => db().automationRule.findMany())).toEqual([])
    expect(await inB(() => db().adsPlaybookLink.findMany())).toEqual([])
    const theirs = await inB(() => save())
    expect(theirs.created).toBe(true)
    expect((await inB(() => db().automationRule.findUniqueOrThrow({ where: { id: theirs.ruleId } }))).workspaceId).toBe(B)
    expect(await inA(() => db().automationRule.count())).toBe(1)
  })
})
