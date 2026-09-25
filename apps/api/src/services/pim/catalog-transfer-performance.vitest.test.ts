import { beforeEach, expect, it, vi } from 'vitest'
import { importTestStore, fixtureFields } from './catalog-transfer-test/store.js'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import type { TransferContracts } from './catalog-transfer-plan.js'

const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_, key) => state.store.db[key as string] }) }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
import { loadTransferContext } from './catalog-transfer.service.js'
import { buildTransferPlan } from './catalog-transfer-plan.js'
import { enrichTransferEffects } from './catalog-transfer-effects.js'

const row = (sku: string, patch: Partial<TransferRow> = {}): TransferRow => ({ row: 3, entity: 'Overrides', sku, channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', aliasKey: '', locale: 'it', field: 'item_name', action: 'SET', value: `Updated ${sku}`, version: 8, ...patch })
beforeEach(() => { state.store = importTestStore(); state.store.seed(25) })

it('bounds marketplace predicates by distinct destinations while preserving channel and active-market checks', async () => {
  state.store.data.marketplace.set('ebay-it', { channel: 'EBAY', code: 'IT', languages: ['de'], isActive: true })
  state.store.data.marketplace.set('inactive', { channel: 'ETSY', code: 'IT', languages: ['it'], isActive: false })
  const rows = [...state.store.data.product.values()].flatMap(p => Array.from({ length: 100 }, (_, i) => row(p.sku, { channel: i % 2 ? 'AMAZON' : 'EBAY', field: `attribute_${i}` })))
  rows.push(row('000000', { channel: 'ETSY' }))
  const context = await loadTransferContext(rows)
  expect(context.markets).toEqual(expect.arrayContaining([
    expect.objectContaining({ channel: 'AMAZON', code: 'IT', languages: ['it'] }),
    expect.objectContaining({ channel: 'EBAY', code: 'IT', languages: ['de'] }),
  ]))
  expect(context.markets).toHaveLength(2)
  const query = state.store.queries.find(q => q.model === 'marketplace')!
  expect(query.args.where.OR).toHaveLength(3)
})

it('resolves all changed titles from the batch language authority without a database read per listing', async () => {
  const rows = [...state.store.data.product.values()].map(p => row(p.sku))
  const context = await loadTransferContext(rows)
  const contracts: TransferContracts = { master: async () => [], channel: async () => ({ fields: fixtureFields as never }) }
  const plan = await buildTransferPlan(rows, 'update', context, contracts)
  expect(plan.issues).toEqual([])
  const before = state.store.queries.length
  await enrichTransferEffects('review', plan, context, contracts, 'IT')
  expect(plan.targets).toHaveLength(25)
  for (const target of plan.targets) {
    expect(target.cells[0].effectiveAfter).toMatchObject({ value: `Updated ${target.identity.sku}`, source: 'it · pin' })
    expect(target.cells[0].effectiveBefore).toHaveProperty('source')
  }
  expect(state.store.queries.slice(before).filter(q => q.model === 'marketplace')).toHaveLength(0)
})
