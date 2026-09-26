/**
 * CX A2 — the amended Finances 2024 dry run: a shape census with no amounts or ids, exact cents
 * parity against v0 for matched orders, and unattributed orders counted apart from unmatched ones.
 * Still a read: every case also asserts that nothing was created or updated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  orderFind: vi.fn(), txFindFirst: vi.fn(), txFindMany: vi.fn(), txCreate: vi.fn(), txUpdate: vi.fn(),
  sellerFetch: vi.fn(), amazonAccount: vi.fn(),
}))
vi.mock('../db.js', () => ({
  default: {
    order: { findFirst: m.orderFind },
    financialTransaction: { findFirst: m.txFindFirst, findMany: m.txFindMany, create: m.txCreate, update: m.txUpdate, updateMany: m.txUpdate, createMany: m.txCreate },
  },
}))
vi.mock('./gateway/amazon-sdk.js', () => ({ amazonSellerFetch: m.sellerFetch }))
vi.mock('../lib/amazon-sp-client.js', () => ({ amazonAccount: m.amazonAccount }))

const { syncFinancialTransactions } = await import('./amazon-financial-events.service.js')
const { storedHundredths } = await import('./amazon-finances-census.js')

const ACCOUNT = 'acct-A'
const ORDERS: Record<string, { id: string; channelConnectionId: string | null }> = {
  '404-0000001-0000001': { id: 'db-order-1', channelConnectionId: ACCOUNT },
  '404-0000002-0000002': { id: 'db-order-2', channelConnectionId: ACCOUNT },
  '404-0000003-0000003': { id: 'db-order-3', channelConnectionId: null },
  '404-0000004-0000004': { id: 'db-order-4', channelConnectionId: 'acct-B' },
}
const money = (currencyAmount: number, currencyCode = 'EUR') => ({ currencyAmount, currencyCode })
function tx(id: string, orderId: string, amount: number, over: Record<string, unknown> = {}) {
  return {
    transactionId: id, transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2026-09-20T10:00:00Z',
    totalAmount: money(amount),
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId }],
    breakdowns: [{ breakdownType: 'Sales', breakdownAmount: money(amount), breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: money(amount), breakdowns: [] }] }],
    ...over,
  }
}
const page = (transactions: unknown[]) => m.sellerFetch.mockResolvedValue({ ok: true, json: async () => ({ payload: { transactions } }) })
const run = () => syncFinancialTransactions(new Date('2026-09-20T00:00:00Z'), new Date('2026-09-21T00:00:00Z'), 'APJ6JRA9NG5V4', { dryRun: true, accountId: ACCOUNT })
/** A v0 row as Prisma returns it: Decimal-like values, v0's key shape (amazonTransactionId = order id). */
const decimal = (v: string) => ({ toFixed: (places: number) => Number(v).toFixed(places) })
function v0Row(orderId: string, channelOrderId: string, amount: string, over: Record<string, unknown> = {}) {
  return {
    orderId, transactionType: 'Order', currencyCode: 'EUR', amazonTransactionId: channelOrderId,
    amount: decimal(amount), grossRevenue: decimal(amount), netRevenue: decimal(amount),
    amazonFee: decimal('0'), fbaFee: decimal('0'), otherFees: decimal('0'), order: { channelOrderId }, ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.amazonAccount.mockResolvedValue({ id: ACCOUNT })
  m.orderFind.mockImplementation(async ({ where }: any) => {
    const order = ORDERS[where.channelOrderId]
    if (!order) return null
    if ('channelConnectionId' in where && where.channelConnectionId !== order.channelConnectionId) return null
    return order
  })
  m.txFindFirst.mockResolvedValue(null)
  m.txFindMany.mockResolvedValue([])
})

describe('A2 — unattributed is not unmatched', () => {
  it('🔴 counts an order we hold without an account link apart from an order we do not hold', async () => {
    page([tx('t1', '404-0000003-0000003', 10), tx('t2', '404-9999999-9999999', 10), tx('t3', '404-0000004-0000004', 10), tx('t4', '404-0000003-0000003', 5)])
    const s = await run()
    expect(s).toMatchObject({ unmatchedTransactions: 1, unattributedTransactions: 2, unattributedOrders: 1, otherAccountTransactions: 1, ordersSkipped: 1 })
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.txUpdate).not.toHaveBeenCalled()
  })
})

describe('A2 — the shape census', () => {
  it('counts by type, status and breakdown path, and by mapping outcome', async () => {
    page([
      tx('t1', '404-0000001-0000001', 10),
      tx('t2', '404-0000002-0000002', 7, { transactionStatus: 'DEFERRED' }),
      tx('t3', '404-0000002-0000002', 3, { transactionType: 'ServiceFee', relatedIdentifiers: [] }),
      tx('t4', '404-0000001-0000001', 10, { totalAmount: money(11) }),
    ])
    const { census } = await run()
    expect(census).toMatchObject({
      transactions: 4,
      byType: { Shipment: 3, ServiceFee: 1 },
      byStatus: { RELEASED: 3, DEFERRED: 1 },
      byTypeAndStatus: { 'Shipment/RELEASED': 2, 'Shipment/DEFERRED': 1, 'ServiceFee/RELEASED': 1 },
      breakdownPaths: { Sales: 4, 'Sales > Product Charges': 4 },
      outcomes: { mapped: 2, counted: 1, refused: 1 },
      counted: { unmapped_type: 1 },
      refusals: { total_sum_mismatch: 1 },
    })
  })

  it('carries no amounts and no identifiers', async () => {
    page([tx('tx-secret-777', '404-0000001-0000001', 12.34, {
      breakdowns: [{ breakdownType: 'Sales', breakdownAmount: money(12.34), breakdowns: [{ breakdownType: 'Order 404-0000001-0000001', breakdownAmount: money(12.34) }] }],
    })])
    const text = JSON.stringify((await run()).census)
    for (const leak of ['tx-secret-777', '404-0000001', '12.34', '1234']) expect(text).not.toContain(leak)
    expect(text).toContain('(unlisted)')
  })

  it('🔴 one transactionId seen as DEFERRED then DEFERRED_RELEASED is ONE transaction, counted as released', async () => {
    page([
      tx('t1', '404-0000001-0000001', 10, { transactionStatus: 'DEFERRED' }),
      tx('t1', '404-0000001-0000001', 10, { transactionStatus: 'DEFERRED_RELEASED' }),
    ])
    m.txFindMany.mockResolvedValue([v0Row('db-order-1', '404-0000001-0000001', '10.00')])
    const s = await run()
    expect(s.census).toMatchObject({ transactions: 1, byStatus: { DEFERRED_RELEASED: 1 }, statusChangesWithinRun: 1, outcomes: { mapped: 1 } })
    expect(s.census!.byStatus.DEFERRED).toBeUndefined()
    expect(s.txWouldCreate).toBe(1)
    // Counted once: equal to v0's 10.00, not 20.00, and not excluded as deferred.
    expect(s.parity!.byCurrency.EUR!.amount).toMatchObject({ equal: 1, different: 0 })
    expect(s.parity!.excluded.deferred).toBe(0)
  })

  it('a released status is not replaced by a later deferred one', async () => {
    page([
      tx('t1', '404-0000001-0000001', 10, { transactionStatus: 'RELEASED' }),
      tx('t1', '404-0000001-0000001', 10, { transactionStatus: 'DEFERRED' }),
    ])
    expect((await run()).census).toMatchObject({ transactions: 1, byStatus: { RELEASED: 1 }, statusChangesWithinRun: 1 })
  })
})

describe('A2 — cents parity against v0 for matched orders', () => {
  it('compares per column in exact hundredths: equal, different, v0-only and new-only', async () => {
    page([tx('t1', '404-0000001-0000001', 10), tx('t2', '404-0000002-0000002', 20.3)])
    m.txFindMany.mockResolvedValue([
      v0Row('db-order-1', '404-0000001-0000001', '10.00'),
      v0Row('db-order-2', '404-0000002-0000002', '20.10'),
      v0Row('db-order-2', '404-0000002-0000002', '-5.00', { transactionType: 'Refund' }),
      // A 2024-shaped row (not v0's key) is not v0's money.
      v0Row('db-order-1', '404-0000001-0000001', '99.00', { amazonTransactionId: 'tx-already-2024' }),
    ])
    const { parity } = await run()
    expect(parity!.byCurrency.EUR!.amount).toEqual({ equal: 1, different: 1, v0Only: 1, newOnly: 0, absDelta: '0.20', v0OnlyAbs: '5.00', newOnlyAbs: '0.00' })
    expect(parity!.comparedKeys).toBe(3)
    const args = m.txFindMany.mock.calls[0][0]
    expect(args.where.orderId.in.sort()).toEqual(['db-order-1', 'db-order-2'])
  })

  it('reports a new-only order and excludes deferred money that v0 cannot yet see', async () => {
    page([tx('t1', '404-0000001-0000001', 10), tx('t2', '404-0000002-0000002', 7, { transactionStatus: 'DEFERRED' })])
    const { parity } = await run()
    expect(parity!.byCurrency.EUR!.grossRevenue).toMatchObject({ newOnly: 1, newOnlyAbs: '10.00' })
    expect(parity!.excluded.deferred).toBe(1)
  })

  it('does not compare different currencies', async () => {
    page([tx('t1', '404-0000001-0000001', 10)])
    m.txFindMany.mockResolvedValue([v0Row('db-order-1', '404-0000001-0000001', '10.00', { currencyCode: 'GBP' })])
    const { parity } = await run()
    expect(parity!.currencyMismatches).toBe(1)
    expect(parity!.byCurrency).toEqual({})
  })

  it('reads stored values exactly and refuses one that is not two-decimal', () => {
    expect(storedHundredths(decimal('12.3'))).toBe(1230n)
    expect(storedHundredths('-0.05')).toBe(-5n)
    expect(storedHundredths(7)).toBe(700n)
    expect(() => storedHundredths(0.1 + 0.2)).toThrow(/two-decimal/)
  })

  it('writes nothing, and the census still runs when no order matches', async () => {
    page([tx('t1', '404-9999999-9999999', 10)])
    const s = await run()
    expect(s.parity).toMatchObject({ comparedKeys: 0, byCurrency: {} })
    expect(m.txFindMany).not.toHaveBeenCalled()
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.txUpdate).not.toHaveBeenCalled()
  })
})


describe('review P3 — validate every page observation before collapsing provider identities', () => {
  const orderId = '404-0000001-0000001'
  const observations = (first: unknown, second: unknown) => {
    m.sellerFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ transactions: [first], nextToken: 'second-page' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ transactions: [second] }) })
    m.txFindMany.mockResolvedValue([v0Row('db-order-1', orderId, '10.00')])
  }
  const refusesBeforeParity = async (reason: RegExp) => {
    await expect(run()).rejects.toThrow(reason)
    expect(m.sellerFetch).toHaveBeenCalledTimes(2)
    expect(m.orderFind).not.toHaveBeenCalled()
    expect(m.txFindMany).not.toHaveBeenCalled()
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.txUpdate).not.toHaveBeenCalled()
  }
  const item = (amount: number) => ({ totalAmount: money(amount), breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: money(amount) }] })

  it.each([['RELEASED', 'RELEASED'], ['DEFERRED', 'DEFERRED_RELEASED'], ['RELEASED', 'DEFERRED']])('refuses changed money across %s -> %s instead of reporting parity with the first page', async (first, second) => {
    observations(tx('t1', orderId, 10, { transactionStatus: first }), tx('t1', orderId, 11, { transactionStatus: second }))
    await refusesBeforeParity(/conflicting money/)
  })

  it('refuses identical numeric amounts in different currencies', async () => {
    const euro = tx('t1', orderId, 10)
    observations(euro, JSON.parse(JSON.stringify(euro).replaceAll('EUR', 'GBP')))
    await refusesBeforeParity(/conflicting money/)
  })

  it.each([
    { label: 'total sum', patch: { totalAmount: money(11) } },
    { label: 'breakdown sum', patch: { breakdowns: [{ breakdownType: 'Sales', breakdownAmount: money(10), breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: money(9) }] }] } },
    { label: 'item sum', patch: { items: [{ ...item(9), totalAmount: money(10) }] } },
    { label: 'amount', patch: { totalAmount: { currencyCode: 'EUR', currencyAmount: 'unreadable' } } },
    { label: 'unmapped breakdown', patch: { breakdowns: [{ breakdownType: 'Unknown', breakdownAmount: money(10) }] } },
  ])('refuses a duplicate with invalid $label even when its status is unchanged', async ({ patch }) => {
    observations(tx('t1', orderId, 10), tx('t1', orderId, 10, patch))
    await refusesBeforeParity(/invalid observation/)
  })

  it('does not hide an invalid first observation behind a later released status', async () => {
    observations(tx('t1', orderId, 10, { transactionStatus: 'DEFERRED', totalAmount: money(11) }), tx('t1', orderId, 10, { transactionStatus: 'DEFERRED_RELEASED' }))
    await refusesBeforeParity(/invalid observation/)
  })

  it.each(['unmapped type', 'deferral release'])('checks total-only money for counted %s observations too', async kind => {
    const patch = kind === 'unmapped type' ? { transactionType: 'ServiceFee', breakdowns: [] } : {
      relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId }, { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'original-deferred' }], breakdowns: [],
    }
    observations(tx('t1', orderId, 10, patch), tx('t1', orderId, 11, patch))
    await refusesBeforeParity(/conflicting money/)
  })

  it('compares all validated breakdown money even when the total is unchanged and the type is counted', async () => {
    const fee = (subscription: number) => tx('t1', orderId, 10, { transactionType: 'ServiceFee', breakdowns: [
      { breakdownType: 'Subscription', breakdownAmount: money(subscription) },
      { breakdownType: 'Adjustment', breakdownAmount: money(10 - subscription) },
    ] })
    observations(fee(6), fee(5))
    await refusesBeforeParity(/conflicting money/)
  })

  it.each(['totals and breakdowns', 'totals only', 'breakdowns only'])('compares item money as well as transaction money (%s)', async shape => {
    const items = (first: number) => [first, 10 - first].map(amount => shape === 'totals and breakdowns' ? item(amount)
      : shape === 'totals only' ? { totalAmount: money(amount) } : { breakdowns: item(amount).breakdowns })
    observations(tx('t1', orderId, 10, { items: items(6) }), tx('t1', orderId, 10, { items: items(5) }))
    await refusesBeforeParity(/conflicting money/)
  })

  const identifiedItem = (id: string, amount: number) => ({ ...item(amount), relatedIdentifiers: [
    { itemRelatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID', itemRelatedIdentifierValue: id },
  ] })

  it.each([true, false])('review P3 item identity — refuses money swapped between stable items (breakdowns=%s)', async withBreakdowns => {
    const items = (a: number, b: number) => [identifiedItem('item-A', a), identifiedItem('item-B', b)].map(record =>
      withBreakdowns ? record : { totalAmount: record.totalAmount, relatedIdentifiers: record.relatedIdentifiers })
    observations(tx('t1', orderId, 10, { items: items(6, 4) }), tx('t1', orderId, 10, { items: items(4, 6) }))
    await refusesBeforeParity(/conflicting money/)
  })

  it.each([{}, [{ itemRelatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID' }], [{ relatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID', relatedIdentifierValue: 'item-A' }]])('review P3 item identity — refuses malformed item identifiers %j', async relatedIdentifiers => {
    observations(tx('t1', orderId, 10, { items: [identifiedItem('item-A', 10)] }),
      tx('t1', orderId, 10, { items: [{ ...item(10), relatedIdentifiers }] }))
    await refusesBeforeParity(/invalid observation/)
  })

  it('review P3 item identity — accepts reordered complete items and duplicate identifier entries with equivalent decimals', async () => {
    const a = identifiedItem('item-A', 6), b = identifiedItem('item-B', 4)
    const first = tx('t1', orderId, 10, { transactionStatus: 'DEFERRED', items: [a, b] })
    const released = tx('t1', orderId, 10, { transactionStatus: 'DEFERRED_RELEASED', items: [b, { ...a, relatedIdentifiers: [...a.relatedIdentifiers, ...a.relatedIdentifiers] }] })
    const equivalent = JSON.parse(JSON.stringify(released), (key, value) => key === 'currencyAmount' ? Number(value).toFixed(2) : value)
    observations(first, equivalent)
    await expect(run()).resolves.toMatchObject({ duplicateTransactions: 1,
      census: { transactions: 1, byStatus: { DEFERRED_RELEASED: 1 }, outcomes: { mapped: 1 } },
      parity: { byCurrency: { EUR: { amount: { equal: 1, different: 0 } } }, excluded: { deferred: 0 } },
    })
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.txUpdate).not.toHaveBeenCalled()
  })

  it('refuses a duplicate that changes from original money to a counted deferral-release record', async () => {
    const original = tx('t1', orderId, 10)
    observations(original, { ...original, relatedIdentifiers: [...original.relatedIdentifiers, { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'another-original' }] })
    await refusesBeforeParity(/conflicting identities/)
  })

  it('accepts reordered breakdown components with the same exact money for a counted type', async () => {
    const first = tx('t1', orderId, 10, { transactionType: 'ServiceFee', transactionStatus: 'DEFERRED', breakdowns: [
      { breakdownType: 'Subscription', breakdownAmount: money(6) }, { breakdownType: 'Adjustment', breakdownAmount: money(4) },
    ] })
    const second = { ...first, transactionStatus: 'DEFERRED_RELEASED', breakdowns: [...first.breakdowns].reverse() }
    observations(first, second)
    await expect(run()).resolves.toMatchObject({ duplicateTransactions: 1, census: { transactions: 1, byStatus: { DEFERRED_RELEASED: 1 }, outcomes: { counted: 1 }, counted: { unmapped_type: 1 } } })
  })

  it('keeps status-only progression with equivalent decimal spellings and reordered item observations', async () => {
    const first = tx('t1', orderId, 10, { transactionStatus: 'DEFERRED', items: [item(6), item(4)] })
    const released = tx('t1', orderId, 10, { transactionStatus: 'DEFERRED_RELEASED', items: [item(4), item(6)] })
    const equivalent = JSON.parse(JSON.stringify(released), (key, value) => key === 'currencyAmount' ? Number(value).toFixed(2) : value)
    observations(first, equivalent)
    const pending = run()
    await expect(pending).resolves.toMatchObject({ duplicateTransactions: 1, txWouldCreate: 1, census: { transactions: 1, byStatus: { DEFERRED_RELEASED: 1 }, outcomes: { mapped: 1 }, statusChangesWithinRun: 1 } })
    const summary = await pending
    expect(summary.parity!.byCurrency.EUR!.amount).toMatchObject({ equal: 1, different: 0 })
    expect(summary.parity!.excluded.deferred).toBe(0)
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.txUpdate).not.toHaveBeenCalled()
  })
})
