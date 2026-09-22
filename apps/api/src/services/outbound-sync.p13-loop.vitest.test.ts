/**
 * P1.3 — the 1-minute backup loop takes the oldest N pending rows per tick (it read all of them), and
 * the Amazon sender uses the seller of the row's own account (it used the default seller).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ findManyArgs: [] as any[], sellerFor: [] as Array<string | undefined> }))
vi.mock('../db.js', () => ({ default: {
  outboundSyncQueue: { findMany: vi.fn(async (args: any) => { h.findManyArgs.push(args); return [] }) },
  channelListing: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
} }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/amazon-sp-client.js', async (original) => ({
  ...(await original<object>()),
  getAmazonSellerId: vi.fn(async (id?: string) => { h.sellerFor.push(id); throw new Error('STOP_AFTER_SELLER') }),
}))
vi.mock('./connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  listActiveConnections: vi.fn(async () => [{ id: 'amz-A', channelType: 'AMAZON', isActive: true, isPrimary: true }, { id: 'amz-B', channelType: 'AMAZON', isActive: true, isPrimary: false }]),
}))

import { OutboundSyncService } from './outbound-sync.service.js'
const service = new OutboundSyncService() as any
afterEach(() => { vi.unstubAllEnvs(); h.findManyArgs.length = 0; h.sellerFor.length = 0 })

describe('P1.3 — backup loop limit', () => {
  it('retains non-dead auth-held work even when its normal budget is exhausted, in bounded oldest-first batches', async () => {
    await service.processPendingSyncs()
    const retry = h.findManyArgs.find(a => a?.where?.syncStatus === 'FAILED')
    expect(retry).toMatchObject({take:200,orderBy:{nextRetryAt:'asc'},where:{isDead:false,OR:[{retryCount:{lt:3}},{errorCode:'AUTH_REQUIRED'}]}})
  })
  it('reads at most 200 pending rows per tick, oldest first; NEXUS_OUTBOUND_BACKUP_BATCH changes it', async () => {
    const pendingReads = () => h.findManyArgs.filter((a) => a?.where?.syncStatus === 'PENDING')
    await service.processPendingSyncs()
    expect(pendingReads()[0]).toMatchObject({ take: 200, orderBy: { createdAt: 'asc' } })
    vi.stubEnv('NEXUS_OUTBOUND_BACKUP_BATCH', '50')
    await service.processPendingSyncs()
    expect(pendingReads()[1]).toMatchObject({ take: 50 })
  })
})

describe('P1.3 — the Amazon sender uses the row\'s own account', () => {
  it('a row for the second Amazon account asks for THAT account\'s seller', async () => {
    await expect(service.syncToAmazon({ id: 'q1', channelConnectionId: 'amz-B', targetChannel: 'AMAZON', product: { sku: 'S' }, payload: {} })).rejects.toThrow('STOP_AFTER_SELLER')
    expect(h.sellerFor).toEqual(['amz-B'])
  })
  it('a row that names no account on a channel with two accounts: refused, terminal — no seller asked', async () => {
    const r = await service.syncToAmazon({ id: 'q2', targetChannel: 'AMAZON', product: { sku: 'S' }, payload: {} })
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'NO_DESTINATION_ACCOUNT', retryable: false })
    expect(h.sellerFor).toEqual([])
  })
})
