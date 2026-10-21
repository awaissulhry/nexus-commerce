/**
 * Meta step 33 — what upload-meta-events reads from Nexus: the business's orders of the days (or ids) asked, every
 * channel, with the buyer's contact data in memory only; Nexus's own records of what it sent in the last 9 days (the
 * first time each sale went and its sale time, confirmed if any record says so); the buyers' first orders; the doubt that
 * stops every upload while an earlier one may have reached Meta without its record (review F1). The database client
 * is a stand-in that records the queries asked. Made-up ids and buyers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ orders: vi.fn(), changes: vi.fn(), logs: vi.fn(), create: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { order: { findMany: h.orders }, agentChange: { findMany: h.changes }, auditLog: { findMany: h.logs, create: h.create } } }))

import { closeSendLog, EVENTS_TOOL, eventsUploadDoubt, firstOrderTimes, MAX_EVENT_ORDERS_READ, nexusSentEvents, ordersForEvents, SEND_LOG, SENT_LOOKBACK_MS, startSendLog } from './events-orders.js'

const ROW = {
  id: 'ord-1', channel: 'MANUAL', channelOrderId: 'M-1001', status: 'DELIVERED', purchaseDate: new Date('2026-10-19T10:00:00Z'), createdAt: new Date('2026-10-19T11:00:00Z'),
  cancelledAt: null, totalPrice: '49.90', currencyCode: 'eur', customerEmail: 'buyer@example.com', customerId: 'cust-1',
  shippingAddress: { city: 'Roma', country: 'IT' }, customer: { addresses: [{ phone: '+39 06 1234 5678', isPrimary: false }, { phone: '+39 333 123 4567', isPrimary: true }] },
  items: [{ sku: 'SKU-1', quantity: 2, price: '24.95' }],
}

beforeEach(() => {
  h.orders.mockReset().mockResolvedValue([ROW])
  h.changes.mockReset().mockResolvedValue([])
  h.logs.mockReset().mockResolvedValue([])
  h.create.mockReset().mockResolvedValue({})
})

describe('ordersForEvents', () => {
  it('reads every channel of the days asked (by the sale\'s time), out of the recycle bin, at most 2,000', async () => {
    const { orders, tooMany } = await ordersForEvents({ from: '2026-10-15', to: '2026-10-20' })
    const q = h.orders.mock.calls[0][0]
    expect(q.where).toEqual({ deletedAt: null, OR: [{ purchaseDate: { gte: new Date('2026-10-15T00:00:00Z'), lt: new Date('2026-10-21T00:00:00Z') } }, { purchaseDate: null, createdAt: { gte: new Date('2026-10-15T00:00:00Z'), lt: new Date('2026-10-21T00:00:00Z') } }] })
    expect(q.take).toBe(MAX_EVENT_ORDERS_READ + 1)
    expect(tooMany).toBe(false)
    expect(orders).toEqual([{
      orderId: 'ord-1', channel: 'MANUAL', channelOrderId: 'M-1001', status: 'DELIVERED', at: new Date('2026-10-19T10:00:00Z'), cancelled: false,
      totalCents: 4990, currency: 'EUR', email: 'buyer@example.com', phone: '+39 333 123 4567', country: 'IT', customerKey: 'cust-1',
      items: [{ sku: 'SKU-1', quantity: 2, priceCents: 2495 }],
    }])
  })
  it('or the ids named (Nexus\'s or the channel\'s); the address\'s phone first', async () => {
    h.orders.mockResolvedValueOnce([{ ...ROW, shippingAddress: { country: 'IT', phone: '+39 02 000 0000' }, customerId: null }])
    const { orders } = await ordersForEvents({ orderIds: ['ord-1', 'M-1001'] })
    expect(h.orders.mock.calls[0][0].where).toEqual({ deletedAt: null, OR: [{ id: { in: ['ord-1', 'M-1001'] } }, { channelOrderId: { in: ['ord-1', 'M-1001'] } }] })
    expect(orders[0]).toMatchObject({ phone: '+39 02 000 0000', customerKey: 'email:buyer@example.com' })
  })
})

describe('nexusSentEvents', () => {
  it('each sale once: its first time out, its sale time, confirmed if any record says so, its first event id and pixel', async () => {
    h.changes.mockResolvedValueOnce([
      { executedAt: new Date('2026-10-20T08:00:00Z'), after: { pixelId: '120000000000050', sent: [{ orderId: 'ord-1', eventId: 'nexus.ord-1', eventTime: '2026-10-19T10:00:00.000Z', sentAt: '2026-10-20T08:00:00.000Z', confirmed: false }] } },
      { executedAt: new Date('2026-10-20T20:00:00Z'), after: { pixelId: '120000000000050', sent: [{ orderId: 'ord-1', eventId: 'nexus.ord-1', sentAt: '2026-10-20T20:00:00.000Z', confirmed: true }, { orderId: 'ord-2', eventId: 'nexus.ord-2' }] } },
      { executedAt: new Date('2026-10-20T21:00:00Z'), after: { sent: 'not a list' } },
    ])
    const now = new Date('2026-10-21T12:00:00Z')
    const sent = await nexusSentEvents(now)
    // Review F8 — only the last 9 days (7 days an event may be sent in + Meta's 48-hour merge window).
    expect(h.changes.mock.calls[0][0].where).toEqual({ toolName: EVENTS_TOOL, executedAt: { gte: new Date(now.getTime() - SENT_LOOKBACK_MS) } })
    expect(SENT_LOOKBACK_MS).toBe(9 * 86_400_000)
    expect(sent.get('ord-1')).toEqual({ orderId: 'ord-1', eventId: 'nexus.ord-1', pixelId: '120000000000050', eventTime: new Date('2026-10-19T10:00:00Z'), sentAt: new Date('2026-10-20T08:00:00Z'), confirmed: true })
    expect(sent.get('ord-2')).toEqual({ orderId: 'ord-2', eventId: 'nexus.ord-2', pixelId: '120000000000050', eventTime: null, sentAt: new Date('2026-10-20T20:00:00Z'), confirmed: false })
    expect(sent.size).toBe(2)
  })
})

describe('firstOrderTimes', () => {
  it('the earliest kept order of each buyer named', async () => {
    h.orders.mockResolvedValueOnce([
      { customerId: 'cust-1', customerEmail: 'buyer@example.com', purchaseDate: new Date('2026-05-01T00:00:00Z'), createdAt: new Date() },
      { customerId: 'cust-1', customerEmail: 'buyer@example.com', purchaseDate: null, createdAt: new Date('2026-03-01T00:00:00Z') },
      { customerId: null, customerEmail: 'other@example.com', purchaseDate: new Date('2026-04-01T00:00:00Z'), createdAt: new Date() },
    ])
    const first = await firstOrderTimes(['cust-1', 'email:other@example.com'])
    expect(first).toEqual(new Map([['cust-1', new Date('2026-03-01T00:00:00Z')], ['email:other@example.com', new Date('2026-04-01T00:00:00Z')]]))
    expect(h.orders.mock.calls[0][0].where).toMatchObject({ deletedAt: null, cancelledAt: null, OR: [{ customerId: { in: ['cust-1'] } }, { customerEmail: { in: ['other@example.com'] } }] })
    expect(await firstOrderTimes([])).toEqual(new Map())
  })
})

describe('re-review N1 — the send log: written before the first request, read for 9 days whatever became of the approval', () => {
  const NOW = new Date('2026-10-21T12:00:00Z')
  const since = new Date(NOW.getTime() - SENT_LOOKBACK_MS)
  const SALES = [{ orderId: 'ord-1', eventId: 'nexus.ord-1', eventTime: '2026-10-19T10:00:00.000Z' }]
  const log = (action: string, sendId: string, at = new Date('2026-10-20T08:00:00Z')) => ({ action, entityId: '120000000000050', createdAt: at, after: { sendId, approvalId: 'ap-0', sales: SALES } })
  it('an open log (no record with its sendId, not closed) stops every upload and names what to check', async () => {
    h.logs.mockResolvedValue([log('send', 's-1')])
    expect(await eventsUploadDoubt(NOW)).toMatch(/^an upload of 1 sale to pixel 120000000000050 began at 2026-10-20 08:00 UTC and left no record; an earlier upload of sales to Meta may have reached Meta.*meta-datasets.*until 9 days after it\.$/)
    expect(h.logs.mock.calls[0][0].where).toEqual({ entityType: SEND_LOG, createdAt: { gte: since } })
    // Its sales count as maybe sent, at the log's time.
    expect((await nexusSentEvents(NOW)).get('ord-1')).toEqual({ orderId: 'ord-1', eventId: 'nexus.ord-1', pixelId: '120000000000050', eventTime: new Date('2026-10-19T10:00:00Z'), sentAt: new Date('2026-10-20T08:00:00Z'), confirmed: false })
  })
  it('a log matched by its run\'s change record, or closed (Meta took nothing), stops nothing', async () => {
    h.logs.mockResolvedValue([log('send', 's-1'), log('send', 's-2'), log('send-none', 's-2')])
    h.changes.mockResolvedValue([{ after: { sendId: 's-1', pixelId: '120000000000050', sent: [] }, executedAt: new Date('2026-10-20T08:00:01Z') }])
    expect(await eventsUploadDoubt(NOW)).toBeNull()
  })
  it('round-2 F1 — a CLOSED log counts its sales as nothing (they go again with the same event_id); an open one as maybe sent', async () => {
    h.logs.mockResolvedValue([log('send', 's-2'), log('send-none', 's-2')])
    expect((await nexusSentEvents(NOW)).has('ord-1')).toBe(false)
    expect(await eventsUploadDoubt(NOW)).toBeNull()
    h.logs.mockResolvedValue([log('send', 's-2')])
    expect((await nexusSentEvents(NOW)).get('ord-1')).toMatchObject({ eventId: 'nexus.ord-1', confirmed: false })
    expect(await eventsUploadDoubt(NOW)).toMatch(/left no record/)
  })
  it('round-2 F2 — an open log younger than a run takes is another upload that may be running now: ask again in minutes', async () => {
    h.logs.mockResolvedValue([log('send', 's-3', new Date(NOW.getTime() - 5 * 60_000))])
    expect(await eventsUploadDoubt(NOW)).toBe('another upload of 1 sale to pixel 120000000000050 started at 2026-10-21 11:55 UTC and may be running now; this request sent nothing. Ask again in a few minutes.')
    // An old open log is named first: it stops uploads for days.
    h.logs.mockResolvedValue([log('send', 's-1'), log('send', 's-3', new Date(NOW.getTime() - 5 * 60_000))])
    expect(await eventsUploadDoubt(NOW)).toMatch(/^an upload of 1 sale .*began at 2026-10-20 08:00 UTC and left no record/)
    // Newest first from the database (5,000 at most), read oldest first.
    expect(h.logs.mock.calls[0][0]).toMatchObject({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5000 })
  })
  it('startSendLog writes the log first (sales, no buyer data), then refuses and closes its own when another is open', async () => {
    h.logs.mockResolvedValue([])
    expect(await startSendLog({ sendId: 's-9', pixelId: '120000000000050', approvalId: 'ap-1', userId: 'u-owner', sales: SALES }, NOW)).toBeNull()
    expect(h.create.mock.calls[0][0]).toEqual({ data: { userId: 'u-owner', entityType: SEND_LOG, entityId: '120000000000050', action: 'send', after: { sendId: 's-9', approvalId: 'ap-1', sales: SALES }, metadata: { tool: EVENTS_TOOL } } })
    h.logs.mockResolvedValue([log('send', 's-1'), log('send', 's-9')])
    expect(await startSendLog({ sendId: 's-9', pixelId: '120000000000050', approvalId: 'ap-1', userId: 'u-owner', sales: SALES }, NOW)).toMatch(/^an upload of 1 sale .*left no record/)
    expect(h.create.mock.calls.at(-1)![0]).toEqual({ data: { userId: 'u-owner', entityType: SEND_LOG, entityId: '120000000000050', action: 'send-none', after: { sendId: 's-9' }, metadata: { tool: EVENTS_TOOL } } })
    await closeSendLog('s-7', '120000000000050')
    expect(h.create.mock.calls.at(-1)![0].data).toMatchObject({ action: 'send-none', after: { sendId: 's-7' } })
  })
})
