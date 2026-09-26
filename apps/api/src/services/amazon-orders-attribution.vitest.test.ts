/**
 * CX A0 — an Amazon order carries the account it was imported through.
 *
 * Before this slice `upsertOrder` never set `Order.channelConnectionId`, so every new
 * Amazon order was created unattributed: invisible to per-account finance matching
 * (the 2024 comparison matches orders within the resolved account only) and to the
 * attribution census. The rule mirrors eBay's MAP.2 link: a new order takes the pinned
 * account; an unattributed order gains it by compare-and-set; a DIFFERENT existing
 * account is a conflict that is logged and counted, never overwritten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(),
  fetchOrders: vi.fn(), fetchOrderItems: vi.fn(), fetchOrderById: vi.fn(),
  amazonAccount: vi.fn(), spClient: vi.fn(), warn: vi.fn(), events: [] as string[],
}))

// The status decision and the upsert run in one locked transaction (stock model R1); the account
// link is a compare-and-set on the global client after it commits. The transaction shares the mocks.
vi.mock('../db.js', () => {
  const order = { findUnique: m.findUnique, upsert: m.upsert, updateMany: m.updateMany }
  const tx = { order, $queryRaw: async () => [{ workspaceId: 'ws-test' }], $executeRaw: async () => 0 }
  return { default: { order, $transaction: async (work: (t: typeof tx) => Promise<unknown>) => { const result = await work(tx); m.events.push('commit'); return result } } }
})
vi.mock('./marketplaces/amazon.service.js', () => ({
  AmazonService: class {
    isConfigured = async () => true
    fetchOrders = m.fetchOrders
    fetchOrderItems = m.fetchOrderItems
    fetchOrderById = m.fetchOrderById
  },
}))
vi.mock('../lib/amazon-sp-client.js', () => ({ amazonAccount: m.amazonAccount, amazonSpClient: m.spClient }))
vi.mock('./sales-aggregate.service.js', () => ({ recordOrderItem: vi.fn() }))
vi.mock('./stock-level.service.js', () => ({ reserveOpenOrder: vi.fn(), consumeOpenOrder: vi.fn(), resolveLocationByCode: vi.fn() }))
vi.mock('./stock-movement.service.js', () => ({ recascadeProduct: vi.fn() }))
vi.mock('./order-events.service.js', () => ({ publishOrderEvent: vi.fn() }))
vi.mock('./customer-cache.service.js', () => ({ linkAndRefreshCustomerForOrder: vi.fn(async () => undefined) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: m.warn, error: vi.fn(), debug: vi.fn() } }))

const { amazonOrdersService } = await import('./amazon-orders.service.js')

const RAW = {
  AmazonOrderId: '404-1111111-2222222', PurchaseDate: '2026-09-20T10:00:00Z', LastUpdateDate: '2026-09-20T12:00:00Z',
  OrderStatus: 'Shipped', FulfillmentChannel: 'AFN', MarketplaceId: 'APJ6JRA9NG5V4',
  OrderTotal: { Amount: '31.98', CurrencyCode: 'EUR' },
}
const sync = () => amazonOrdersService.syncNewOrders(new Date('2026-09-20T00:00:00Z'))

beforeEach(() => {
  vi.clearAllMocks()
  m.amazonAccount.mockResolvedValue({ id: 'acct-A' })
  m.fetchOrders.mockResolvedValue([RAW])
  m.fetchOrderItems.mockResolvedValue([])
  m.updateMany.mockImplementation(async () => { m.events.push('link'); return { count: 1 } })
  m.events.length = 0
})

describe('A0 — the importing account is stamped on the order', () => {
  it('fetches through the pinned account, so the stamped account is the one the order came from', async () => {
    m.findUnique.mockResolvedValue(null)
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: 'acct-A' })
    await sync()
    expect(m.amazonAccount).toHaveBeenCalledTimes(1)
    expect(m.fetchOrders).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-A' }))
  })

  it('creates a NEW order attributed to the pinned account', async () => {
    m.findUnique.mockResolvedValue(null)
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: 'acct-A' })
    const summary = await sync()
    expect(summary.ordersUpserted).toBe(1)
    const args = m.upsert.mock.calls[0][0]
    expect(args.create.channelConnectionId).toBe('acct-A')
    // The update arm never carries the account: it cannot overwrite another account.
    expect('channelConnectionId' in args.update).toBe(false)
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 attributes an existing UNATTRIBUTED order by compare-and-set on NULL', async () => {
    m.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING', channelConnectionId: null })
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: null })
    await sync()
    expect(m.updateMany).toHaveBeenCalledWith({ where: { id: 'order-1', channelConnectionId: null }, data: { channelConnectionId: 'acct-A' } })
    expect('channelConnectionId' in m.upsert.mock.calls[0][0].update).toBe(false)
    // Stock model × A0: the link runs after the locked state transaction commits, never inside it
    // (from inside, its own connection would wait on the row lock that transaction holds).
    expect(m.events).toEqual(['commit', 'link'])
  })

  it('leaves an order already attributed to the same account alone', async () => {
    m.findUnique.mockResolvedValue({ id: 'order-1', status: 'SHIPPED', channelConnectionId: 'acct-A' })
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: 'acct-A' })
    const summary = await sync()
    expect(summary.ordersUpserted).toBe(1)
    expect(m.updateMany).not.toHaveBeenCalled()
    expect(summary.accountConflicts ?? 0).toBe(0)
  })

  it('🔴 never overwrites a DIFFERENT account: the conflict is logged and counted', async () => {
    m.findUnique.mockResolvedValue({ id: 'order-1', status: 'SHIPPED', channelConnectionId: 'acct-B' })
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: 'acct-B' })
    const summary = await sync()
    expect(m.updateMany).not.toHaveBeenCalled()
    expect('channelConnectionId' in m.upsert.mock.calls[0][0].update).toBe(false)
    expect(summary.accountConflicts).toBe(1)
    expect(m.warn).toHaveBeenCalledWith(expect.stringMatching(/different Amazon account/), expect.objectContaining({ linkedConnectionId: 'acct-B', importingConnectionId: 'acct-A' }))
  })

  it('a concurrent writer that attributed first wins: a lost compare-and-set is a conflict, not an overwrite', async () => {
    m.findUnique.mockResolvedValueOnce({ id: 'order-1', status: 'SHIPPED', channelConnectionId: null })
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: null })
    m.updateMany.mockResolvedValue({ count: 0 })
    m.findUnique.mockResolvedValueOnce({ channelConnectionId: 'acct-B' })
    const summary = await sync()
    expect(m.updateMany).toHaveBeenCalledTimes(1)
    expect(summary.accountConflicts).toBe(1)
  })

  it('a lost compare-and-set to the SAME account is not a conflict', async () => {
    m.findUnique.mockResolvedValueOnce({ id: 'order-1', status: 'SHIPPED', channelConnectionId: null })
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: null })
    m.updateMany.mockResolvedValue({ count: 0 })
    m.findUnique.mockResolvedValueOnce({ channelConnectionId: 'acct-A' })
    const summary = await sync()
    expect(m.updateMany).toHaveBeenCalledTimes(1)
    expect(summary.ordersUpserted).toBe(1)
    expect(summary.accountConflicts ?? 0).toBe(0)
  })

  it('an unresolvable account records a fetch failure and writes nothing', async () => {
    m.amazonAccount.mockRejectedValue(Object.assign(new Error('Connect an Amazon seller account'), { code: 'amazon_account_unavailable' }))
    const summary = await sync()
    expect(summary.errors).toEqual([expect.objectContaining({ orderId: 'FETCH' })])
    expect(m.fetchOrders).not.toHaveBeenCalled()
    expect(m.upsert).not.toHaveBeenCalled()
  })
})

describe('review #9 — every read for one order goes through the same account', () => {
  it('🔴 the items and the eager getOrder for a PENDING €0 order are read through the pinned account', async () => {
    m.findUnique.mockResolvedValue(null)
    m.upsert.mockResolvedValue({ id: 'order-1', channelConnectionId: 'acct-A' })
    m.fetchOrders.mockResolvedValue([{ ...RAW, OrderStatus: 'Pending', OrderTotal: undefined }])
    m.fetchOrderById.mockResolvedValue({ OrderTotal: { Amount: '31.98', CurrencyCode: 'EUR' } })
    await sync()
    expect(m.fetchOrderById).toHaveBeenCalledWith(RAW.AmazonOrderId, 'acct-A')
    expect(m.fetchOrderItems).toHaveBeenCalledWith(RAW.AmazonOrderId, 'acct-A')
  })
})
