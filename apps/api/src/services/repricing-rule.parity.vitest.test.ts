/**
 * R17 (MCP full control, part 06) — a repricing rule's create and edit (repricing-rule.service.ts, which save-price-rule
 * saves through) answer byte for byte what the routes answered before their logic moved there:
 *   POST  /products/:id/repricing-rules  → createRepricingRule
 *   PATCH /repricing-rules/:id           → patchRepricingRule
 *
 * Those two routes were deleted on 2026-10-14 with the old product drawer, their only caller. Each line below is still
 * written as the route answered it (a refusal's status and body, else 201 or 200 and the value, as JSON), so the
 * snapshot WRITTEN BY THE ROUTES BEFORE THE MOVE is read unchanged. The answers and the rule rows each call leaves are
 * recorded. On a real PostgreSQL (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { isRefused, type ServiceOutcome } from './automation/service-outcome.js'
import type { RepricingRuleCreate, RepricingRulePatch } from './repricing-rule.service.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')

const answers: string[] = []
let productId = ''
/** One call, recorded as the deleted route answered it: `<label> → <status> <JSON body>`. */
async function ask(label: string, okStatus: number, work: () => Promise<ServiceOutcome<unknown>>) {
  const outcome = await inside(work)
  const status = isRefused(outcome) ? outcome.status : okStatus
  const body = JSON.stringify(isRefused(outcome) ? outcome.body : outcome.value)
  answers.push(`${label.split(' ')[0]} ${normalise(label.split(' ')[1])} → ${status} ${normalise(body)}`)
  return { body }
}

let service: typeof import('./repricing-rule.service.js')
/** What a route handler received: the request body after JSON (an inject payload is serialized, then parsed). */
const asBody = <T>(payload: object) => JSON.parse(JSON.stringify(payload)) as T

beforeAll(async () => {
  database = await formulaDatabase()
  service = await import('./repricing-rule.service.js')
  productId = (await inside(() => database.client.product.create({ data: { sku: 'TEST-SKU-1', name: 'TEST product', basePrice: '25.00' } as never }))).id
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R17 — the repricing rule service answers as the routes did before the move', () => {
  it('every outcome, and the rows each leaves', { timeout: 60_000 }, async () => {
    const create = (payload: object, id = productId) =>
      ask(`POST /api/products/${id}/repricing-rules`, 201, () => service.createRepricingRule(id, asBody<RepricingRuleCreate>(payload)))
    await create({})
    await create({ channel: 'EBAY', minPrice: -1, maxPrice: 5, strategy: 'manual' })
    await create({ channel: 'EBAY', minPrice: 10, maxPrice: 5, strategy: 'manual' })
    await create({ channel: 'EBAY', minPrice: 10, maxPrice: 20, strategy: 'nope' })
    await create({ channel: 'EBAY', minPrice: 10, maxPrice: 20, strategy: 'beat_lowest_by_pct' })
    await create({ channel: 'EBAY', minPrice: 10, maxPrice: 20, strategy: 'fixed_to_buy_box_minus' })
    await create({ channel: 'EBAY', minPrice: 10, maxPrice: 20, strategy: 'manual' }, 'tst-no-such-product')
    const made = await create({ channel: 'ebay', marketplace: 'it', minPrice: '10', maxPrice: 20.5, strategy: 'beat_lowest_by_pct', beatPct: '2.5', activeFromHour: 8, activeToHour: 20, activeDays: [1, 2], notes: '  first  ' })
    await create({ channel: 'EBAY', marketplace: 'IT', minPrice: 10, maxPrice: 20, strategy: 'manual' })
    await create({ channel: 'AMAZON', minPrice: 0, maxPrice: 0, strategy: 'match_buy_box', enabled: false, activeDays: 'x', notes: '' })
    const ruleId = (JSON.parse(made.body) as { rule: { id: string } }).rule.id
    const patch = (payload: object, id = ruleId) =>
      ask(`PATCH /api/repricing-rules/${id}`, 200, () => service.patchRepricingRule(id, asBody<RepricingRulePatch>(payload)))
    await patch({})
    await patch({ minPrice: -2 })
    await patch({ maxPrice: 'x' })
    await patch({ strategy: 'nope' })
    await patch({ enabled: 0, minPrice: '11', maxPrice: 19, strategy: 'beat_lowest_by_amount', beatPct: null, beatAmount: '1.5', activeFromHour: null, activeToHour: 22, activeDays: 'x', notes: '  second ' })
    await patch({ notes: null }, 'tst-no-such-rule')
    const rows = await inside(() => database.client.repricingRule.findMany({ orderBy: { createdAt: 'asc' } }))
    answers.push(`rows: ${normalise(JSON.stringify(rows))}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})
