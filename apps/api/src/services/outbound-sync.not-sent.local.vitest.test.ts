import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Forbidden outbound during PR.2 W1.9 rehearsal') })
  vi.stubGlobal('fetch', outbound)
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run'); vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true')
  vi.stubEnv('NEXUS_DISABLE_BACKGROUND_JOBS', '1'); vi.stubEnv('ENABLE_QUEUE_WORKERS', '0'); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  return { outbound, batchIds: [] as string[], publish: vi.fn(() => { throw new Error('Empty patch must not publish') }) }
})
// The service sees real DB operations, with only the table-drain reader fenced
// to the disposable IDs. Prisma delegates are proxies and cannot be spied on.
vi.mock('../db.js', async () => {
  const { prisma } = await import('@nexus/database')
  const queue = {
    findUnique: (args: any) => prisma.outboundSyncQueue.findUnique(args),
    findMany: (args: any) => prisma.outboundSyncQueue.findMany({ ...args, where: { AND: [args?.where ?? {}, { id: { in: m.batchIds } }] } }),
    update: (args: any) => prisma.outboundSyncQueue.update(args),
    updateMany: (args: any) => prisma.outboundSyncQueue.updateMany(args),
  }
  return { default: new Proxy(prisma, { get(target, key) { return key === 'outboundSyncQueue' ? queue : Reflect.get(target, key) } }) }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class {} }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fake-seller' }))
vi.mock('./listing-publish.service.js', () => ({ listingPublishService: { publish: m.publish } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('./repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))

it.skipIf(process.env.PR2_LOCAL_REHEARSAL !== '1')('LOCAL W1.9: pending/retry/BullMQ commit SKIPPED with reason and no syncedAt', async () => {
  const target = new URL(process.env.DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(target.hostname); expect(target.port).toBe('55439'); expect(target.pathname).toBe('/nexus_development')
  const { prisma } = await import('@nexus/database')
  const [{ default: service }, { processOutboundSyncJob }, { getAmazonPublishMode }] = await Promise.all([
    import('./outbound-sync.service.js'), import('../workers/bullmq-sync.worker.js'), import('./amazon-publish-gate.service.js'),
  ])
  expect(getAmazonPublishMode()).toBe('dry-run')
  const [{ name }] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`
  expect(name).toBe('nexus_development')
  console.log(`PR.2 W1.9 LOCAL ${target.host}/${name}; no channel/prod writes`)
  const gale = await prisma.product.findUniqueOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523' }, select: { familyId: true, version: true } })
  const marker = `PR2-NOT-SENT-${randomUUID()}`
  const product = { id: marker, sku: marker, name: 'PR.2 empty status disposable', status: 'DRAFT' as const, familyId: gale.familyId, basePrice: 1 }
  await expect(prisma.$transaction(async tx => { await tx.product.create({ data: product }); throw new Error('rollback proof') })).rejects.toThrow('rollback proof')
  expect(await prisma.product.count({ where: { sku: marker } })).toBe(0)
  const queueIds = ['pending', 'retry', 'bull'].map(arm => `${marker}-${arm}`)
  const pause = () => new Promise(resolve => setTimeout(resolve, 8100))
  const evidence: Record<string, unknown> = { at: new Date().toISOString(), database: `${target.host}/${name}`, marker, galeVersion: gale.version }
  try {
    await prisma.$transaction(async tx => {
      await tx.product.create({ data: product })
      for (const [i, id] of queueIds.entries()) await tx.outboundSyncQueue.create({ data: {
        id, productId: marker, channelListingId: null, targetChannel: 'AMAZON', targetRegion: 'IT', externalListingId: `${marker}-FAKE-ASIN`,
        syncType: 'STATUS_UPDATE', syncStatus: i === 1 ? 'FAILED' : 'PENDING',
        holdUntil: i === 2 ? new Date(Date.now() + 300_000) : null, nextRetryAt: i === 1 ? new Date(0) : null,
        payload: { source: marker, status: 'INACTIVE', productType: 'OUTERWEAR', marketplaceId: 'IT' },
      } })
    })
    await pause()
    expect(await prisma.outboundSyncQueue.count({ where: { id: { in: queueIds } } })).toBe(3)
    m.batchIds = queueIds.slice(0, 2)
    evidence.batch = await service.processPendingSyncs()
    expect(evidence.batch).toMatchObject({ processed: 2, succeeded: 0, failed: 0, skipped: 2 })
    m.batchIds = []
    await prisma.outboundSyncQueue.update({ where: { id: queueIds[2] }, data: { holdUntil: new Date(0) } })
    evidence.bull = await processOutboundSyncJob({ id: `${marker}-job`, attemptsMade: 0, data: { queueId: queueIds[2], productId: marker, syncType: 'STATUS_UPDATE', targetChannel: 'AMAZON' } } as any)
    expect(evidence.bull).toMatchObject({ status: 'SKIPPED' })
    await pause()
    const rows = await prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds } }, select: { id: true, syncStatus: true, syncedAt: true, errorCode: true, errorMessage: true, nextRetryAt: true } })
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toMatchObject({ syncStatus: 'SKIPPED', syncedAt: null, nextRetryAt: null, errorCode: 'AMAZON_EMPTY_PATCH_NOT_SENT', errorMessage: expect.stringContaining('Nothing was sent') })
    evidence.rows = rows
    expect(m.outbound).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled()
    evidence.outboundCalls = m.outbound.mock.calls.length; evidence.publishCalls = m.publish.mock.calls.length
  } finally {
    m.batchIds = []
    await prisma.outboundSyncQueue.deleteMany({ where: { payload: { path: ['source'], equals: marker } } })
    await prisma.product.deleteMany({ where: { sku: marker } })
    await pause()
    evidence.cleanup = { products: await prisma.product.count({ where: { sku: marker } }), queues: await prisma.outboundSyncQueue.count({ where: { payload: { path: ['source'], equals: marker } } }) }
    expect(evidence.cleanup).toEqual({ products: 0, queues: 0 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523' }, select: { version: true } })).toEqual({ version: gale.version })
    await writeFile('../../docs/audits/2026-09-13-presence/pr2/w19-rehearsal.json', JSON.stringify(evidence, null, 2))
    await prisma.$disconnect()
  }
}, 90_000)
