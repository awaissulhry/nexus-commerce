import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ fetch: vi.fn(), account: vi.fn(), order: vi.fn(), find: vi.fn(), create: vi.fn() }))
// CX A2: the dry run now also READS v0's rows for cents parity (findMany); no assertion changed.
vi.mock('../db.js', () => ({ default: { order: { findFirst: m.order }, financialTransaction: { findFirst: m.find, findMany: vi.fn(async () => []), create: m.create } } }))
vi.mock('./gateway/amazon-sdk.js', () => ({ amazonSellerFetch: m.fetch }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonAccessToken: vi.fn(), amazonAccount: m.account }))
const { syncFinancialTransactions, financialsDryRunRefusal, readTransactionsPage, probeFinancialTransactionsEnvelope } = await import('./amazon-financial-events.service.js')

// Schema-based reduced fixture, not copied from Amazon's internally inconsistent example.
// https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/finances-api-model/finances_2024-06-19.json
const tx = { transactionId: 'official-tx-1', transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2026-09-20T10:00:00Z',
  totalAmount: { currencyAmount: 10, currencyCode: 'EUR' },
  relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-at-amazon' }],
  breakdowns: [{ breakdownType: 'Sales', breakdownAmount: { currencyAmount: 10, currencyCode: 'EUR' }, breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: { currencyAmount: 10, currencyCode: 'EUR' } }] }],
}
const start = new Date('2026-09-20T00:00:00Z'), end = new Date('2026-09-21T00:00:00Z')
const response = (transactions: unknown[], nextToken?: unknown) => ({ ok: true, json: async () => ({ payload: { transactions, ...(nextToken === undefined ? {} : { nextToken }) } }) })
const run = (opts: { dryRun?: boolean; accountId?: string } = { dryRun: true }) => syncFinancialTransactions(start, end, 'APJ6JRA9NG5V4', opts)
beforeEach(() => {
  vi.resetAllMocks()
  m.account.mockResolvedValue({ id: 'account-2' })
  m.order.mockResolvedValue({ id: 'db-order', currencyCode: 'EUR' })
  m.find.mockResolvedValue(null)
  m.fetch.mockResolvedValue(response([tx]))
})

it('uses official ORDER_ID and transactionId with an explicit account and reports legacy overlap risk', async () => {
  m.find.mockImplementation(async ({ where }: any) => where.amazonTransactionId === 'order-at-amazon' ? { id: 'legacy' } : null)
  const result = await run({ dryRun: true, accountId: 'account-2' })
  expect(m.account).toHaveBeenCalledWith({ accountId: 'account-2' })
  expect(m.order).toHaveBeenCalledWith(expect.objectContaining({ where: { channel: 'AMAZON', channelOrderId: 'order-at-amazon', channelConnectionId: 'account-2' } }))
  expect(m.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ amazonTransactionId: 'official-tx-1' }) }))
  expect(result).toMatchObject({ txCreated: 0, txWouldCreate: 1, txWouldDuplicateV0: 1, accountId: 'account-2', marketplaceId: 'APJ6JRA9NG5V4', comparisonScope:'identity_and_order_overlap_only' })
  expect(m.create).not.toHaveBeenCalled()
})
it('supports deliberate account-wide comparison by omitting marketplaceId (including US MFN)', async () => {
  expect(await syncFinancialTransactions(start,end,null,{dryRun:true,accountId:'account-2'})).toMatchObject({ marketplaceId:null, accountId:'account-2' })
  expect(new URL('https://example.test'+m.fetch.mock.calls[0][0].path).searchParams.has('marketplaceId')).toBe(false)
})
it('refuses account-wide comparison without a named account', async () => {
  await expect(syncFinancialTransactions(start,end,null,{dryRun:true})).rejects.toThrow(/explicit accountId/)
  expect(m.fetch).not.toHaveBeenCalled()
})
it('fails the comparison on a later-page HTTP error without producing writes or partial counts', async () => {
  m.fetch.mockResolvedValueOnce(response([tx],'p2')).mockResolvedValueOnce({ok:false,status:503,text:async ()=>'unavailable'})
  await expect(run()).rejects.toThrow(/503/)
  expect(m.create).not.toHaveBeenCalled()
  expect(m.order).not.toHaveBeenCalled()
})
it('refuses the 50-page bound when continuation remains', async () => {
  vi.useFakeTimers()
  try {
    let page = 0
    m.fetch.mockImplementation(async () => response([tx],`page-${++page}`))
    const assertion = expect(run()).rejects.toThrow(/page bound/)
    await vi.runAllTimersAsync()
    await assertion
    expect(m.fetch).toHaveBeenCalledTimes(50)
    expect(m.order).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
it('counts distinct provider transactions at the same timestamp and dedupes repeated provider IDs', async () => {
  m.fetch.mockResolvedValue(response([tx, { ...tx, transactionId: 'official-tx-2' }, tx]))
  expect(await run()).toMatchObject({ txCreated: 0, txWouldCreate: 2, txSkipped: 1 })
})
it.each([[42], [null], [{}], [{ relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'   ' }]].map(relatedIdentifiers => ({relatedIdentifiers})))('refuses malformed related identifiers $relatedIdentifiers instead of reporting a quiet zero', async ({relatedIdentifiers}) => {
  m.fetch.mockResolvedValue(response([{...tx,relatedIdentifiers}]))
  await expect(run()).rejects.toThrow(/identifier|ORDER_ID/i)
  expect(m.order).not.toHaveBeenCalled()
})
it('refuses duplicate IDs with conflicting order association', async () => {
  m.fetch.mockResolvedValue(response([{...tx,relatedIdentifiers:[]},tx]))
  await expect(run()).rejects.toThrow(/conflicting|identity/i)
})
it('does not silently count an unidentifiable transaction as a zero-overlap observation', async () => {
  m.fetch.mockResolvedValue(response([{ ...tx, transactionId: undefined }]))
  await expect(run()).rejects.toThrow(/transactionId/)
  expect(m.create).not.toHaveBeenCalled()
})
it('preserves window/account filters through an empty page with continuation', async () => {
  m.fetch.mockResolvedValueOnce(response([], 'page-2')).mockResolvedValueOnce(response([tx]))
  expect(await run()).toMatchObject({ txWouldCreate: 1 })
  const params = new URL('https://example.test' + m.fetch.mock.calls[1][0].path).searchParams
  expect(params.get('postedAfter')).toBe(start.toISOString())
  expect(params.get('postedBefore')).toBe(end.toISOString())
  expect(params.get('marketplaceId')).toBe('APJ6JRA9NG5V4')
  expect(params.get('nextToken')).toBe('page-2')
  expect(m.fetch.mock.calls.every(([args]) => args.accountId === 'account-2')).toBe(true)
})
it.each([42, {}, [], ''])('refuses malformed continuation %j rather than returning partial success', nextToken => {
  expect(() => readTransactionsPage({ transactions: [], nextToken })).toThrow(/nextToken/)
})
it('accepts the documented null continuation as the last page', () => {
  expect(readTransactionsPage({ transactions: [], nextToken: null })).toEqual({ transactions: [], nextToken: undefined })
})
it('refuses an account parameter on the legacy writer instead of silently ignoring it', () => {
  expect(financialsDryRunRefusal({ accountId: 'other-seller' })).toMatch(/v0 writer was not called/)
})
it('uses the selected account for the single-page probe too', async () => {
  expect(await probeFinancialTransactionsEnvelope(start, end, 'APJ6JRA9NG5V4', 'account-2')).toMatchObject({ ok: true })
  expect(m.account).toHaveBeenCalledWith({ accountId: 'account-2' })
  expect(m.fetch).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-2' }))
  expect(m.create).not.toHaveBeenCalled()
})
it('does not replace an account-wide probe with an environment marketplace', async () => {
  expect(await probeFinancialTransactionsEnvelope(start,end,null,'account-2')).toMatchObject({ marketplaceId:null, accountId:'account-2' })
  expect(new URL('https://example.test'+m.fetch.mock.calls[0][0].path).searchParams.has('marketplaceId')).toBe(false)
})
it('refuses repeated continuation with no financial writes', async () => {
  m.fetch.mockImplementation(async () => response([tx], 'repeat'))
  await expect(run()).rejects.toThrow(/pagination|repeated/i)
  expect(m.create).not.toHaveBeenCalled()
}, 15000)
it.each([undefined, false, 'true', 1, null])('holds unsafe new-API writes for dryRun=%j before a channel call', async dryRun => {
  await expect(run({ dryRun: dryRun as never })).rejects.toThrow(/cutover|dryRun/)
  expect(m.fetch).not.toHaveBeenCalled()
  expect(m.create).not.toHaveBeenCalled()
})
it.each([['2026-09-21','2026-09-20'], ['bad','2026-09-21'], ['2025-01-01','2026-09-21']])('rejects invalid/oversized window %s..%s before calling Amazon', async (a,b) => {
  await expect(syncFinancialTransactions(new Date(a),new Date(b),'APJ6JRA9NG5V4',{dryRun:true})).rejects.toThrow(/window|180|date/i)
  expect(m.fetch).not.toHaveBeenCalled()
})
it.each([{dryRun:'true'}, {useV0:'false'}, {probe:'true'}])('rejects malformed route flags before routing %j', body => {
  expect(financialsDryRunRefusal(body as never)).toMatch(/boolean/)
})
