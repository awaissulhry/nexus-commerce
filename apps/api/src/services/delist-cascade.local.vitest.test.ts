import { expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('FORBIDDEN outbound call during PR.2 rehearsal') }); vi.stubGlobal('fetch', outbound)
  vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run'); vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true')
  vi.stubEnv('NEXUS_DISABLE_BACKGROUND_JOBS', '1'); vi.stubEnv('ENABLE_QUEUE_WORKERS', '0'); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  return { outbound, fixtureFetch: vi.fn(), end: vi.fn(), add: vi.fn(), resolve: vi.fn(), batchIds: [] as string[] }
})
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
vi.mock('../lib/queue.js', () => ({ redis: { connection: null }, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, addJobSafely: m.add }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class {} }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fake-seller' }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'fake-token' } }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: m.resolve }))
vi.mock('./ebay-trading-api.service.js', async original => ({ ...await original<typeof import('./ebay-trading-api.service.js')>(), endFixedPriceItem: m.end }))
vi.mock('./variation-sync-processor.service.js', () => ({ variationSyncProcessor: {} }))
vi.mock('./repricer.service.js', () => ({ calculateTargetPrice: vi.fn() }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))

it.skipIf(process.env.PR2_LOCAL_REHEARSAL !== '1')('LOCAL Docker: committed cascade → result/cancel → delayed read-back → cleanup by value', async () => {
  const target = new URL(process.env.DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(target.hostname); expect(target.port).toBe('55439'); expect(target.pathname).toBe('/nexus_development')
  console.log(`PR.2 REHEARSAL DATABASE ${target.host}${target.pathname}; NO PRODUCTION/CHANNEL WRITES`)
  const { prisma } = await import('@nexus/database')
  const [{ enqueueDelistCascade, dispatchCommittedDelistRows }, { processOutboundSyncJob }, { delistCascadeRoutes }, { amazonSpApiClient }, { getAmazonPublishMode }, { default: service }] = await Promise.all([
    import('./outbound-enqueue.js'), import('../workers/bullmq-sync.worker.js'), import('../routes/delist-cascade.routes.js'), import('../clients/amazon-sp-api.client.js'), import('./amazon-publish-gate.service.js'),
    import('./outbound-sync.service.js'),
  ])
  expect(getAmazonPublishMode()).toBe('dry-run')
  const database = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`
  expect(database[0].name).toBe('nexus_development')
  const gale = await prisma.product.findUniqueOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523' }, select: { familyId: true, version: true } })
  expect(gale.familyId).toBeTruthy()
  console.log(`LOCAL ${database[0].name}; GALE version=${gale.version}; family=${gale.familyId}; rollback proof precedes fixture`)
  const marker = `PR2-DELIST-REHEARSAL-${randomUUID()}`
  const product = { id: marker, sku: marker, name: 'PR.2 disposable delist rehearsal', status: 'DRAFT' as const, familyId: gale.familyId, basePrice: 1 }
  const rollback = new Error('PR2 rollback proof')
  await expect(prisma.$transaction(async tx => { await tx.product.create({ data: product }); throw rollback })).rejects.toThrow('PR2 rollback proof')
  expect(await prisma.product.count({ where: { sku: marker } })).toBe(0)
  const accounts = await prisma.channelConnection.findMany({ where: { channelType: { in: ['AMAZON', 'EBAY'] }, isActive: true }, select: { id: true, channelType: true } })
  const amazon = accounts.find(row => row.channelType === 'AMAZON'), ebay = accounts.find(row => row.channelType === 'EBAY')
  expect(amazon).toBeTruthy(); expect(ebay).toBeTruthy()
  m.resolve.mockImplementation(async ({ accountId }) => accounts.find(row => row.id === accountId) ?? null)
  m.add.mockResolvedValue({ enqueued: false })
  const deletes = vi.spyOn(amazonSpApiClient, 'deleteListingsItem')
  const app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    request.authUser = { id: 'pr2-fixture-operator', roleKeys: [], permissionsVersion: 1 } as any
    request.__rbacResolved = { isOwner: false, permissions: new Set(['products.delete']) }
  })
  await app.register(delistCascadeRoutes, { prefix: '/api' }); await app.ready()
  const readDelay = () => new Promise(resolve => setTimeout(resolve, 8100))
  let queueIds: string[] = []
  const table: any[] = []
  try {
    const committed = await prisma.$transaction(async tx => {
      await tx.product.create({ data: product })
      for (const [arm, channel, marketplace, account] of [
        ['transport', 'EBAY', 'IT', ebay!.id], ['access', 'EBAY', 'GB', ebay!.id],
        ['unpublish', 'AMAZON', 'IT', amazon!.id], ['cancel', 'AMAZON', 'DE', amazon!.id],
      ]) await tx.channelListing.create({ data: {
        id: `${marker}-${arm}`, productId: marker, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: account,
        aliasKey: '', externalListingId: `${marker}-EXTERNAL-${arm}`, listingStatus: 'ACTIVE', isPublished: false, syncPaused: true,
      } })
      const cascade = await enqueueDelistCascade(tx, [marker], 'delete', 'pr2-fixture-operator')
      expect(cascade.entries).toHaveLength(4); expect(cascade.channelSkipped).toEqual([])
      await tx.product.deleteMany({ where: { sku: marker } })
      return cascade
    })
    queueIds = committed.entries.map(row => row.id)
    const afterCommit = await dispatchCommittedDelistRows(prisma, committed.entries)
    expect(afterCommit.channelCascadeDispatched).toBe(4); expect(afterCommit.channelCascadePartial).toBe(false); expect(m.add).toHaveBeenCalledTimes(4)
    await readDelay()
    const held = await prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds } } })
    expect(held).toHaveLength(4)
    for (const row of held) { expect(row.productId).toBeNull(); expect(row.channelListingId).toBeNull(); expect(row.holdUntil!.getTime()).toBeGreaterThan(Date.now()); expect((row.payload as any).productId).toBe(marker); expect((row.payload as any).sellerSku).toBe(marker) }
    expect(await prisma.product.count({ where: { sku: marker } })).toBe(0)
    for (const arm of ['transport', 'access', 'unpublish', 'cancel']) {
      const row = held.find(row => (row.payload as any).channelListingId === `${marker}-${arm}`)!
      vi.clearAllMocks()
      if (arm === 'cancel') {
        const cancelled = await app.inject({ method: 'POST', url: '/api/products/delist-cascade/cancel', payload: { queueIds: [row.id] } })
        expect(cancelled.statusCode, cancelled.body).toBe(200); expect(cancelled.json().cancelled).toEqual([row.id])
      } else {
        await prisma.outboundSyncQueue.updateMany({ where: { id: row.id, syncStatus: 'PENDING' }, data: {
          holdUntil: new Date(Date.now() - 1000), ...(arm === 'unpublish' ? { syncType: 'UNPUBLISH_LISTING' } : {}),
        } })
        if (arm === 'transport') {
          m.fixtureFetch.mockRejectedValue(new TypeError('fetch failed: simulated transport disconnect'))
          m.end.mockImplementation(() => m.fixtureFetch('fixture://transport'))
        } else if (arm === 'access') {
          m.fixtureFetch.mockResolvedValue(new Response('<Ack>Failure</Ack><ShortMessage>Item cannot be accessed</ShortMessage>'))
          m.end.mockImplementation(async () => { const raw = await (await m.fixtureFetch('fixture://access')).text(); throw new Error(`eBay EndFixedPriceItem Failure: ${raw.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)![1]}`) })
        }
      }
      const result = await processOutboundSyncJob({ id: `bull-${row.id}`, attemptsMade: 0, data: { queueId: row.id, syncType: 'QUANTITY_UPDATE', targetChannel: 'WOOCOMMERCE' } } as any)
      expect(result.status).toBe(arm === 'cancel' ? 'CANCELLED' : arm === 'unpublish' ? 'FAILED' : 'UNKNOWN')
      expect(m.outbound).not.toHaveBeenCalled(); expect(deletes).not.toHaveBeenCalled()
      if (arm === 'cancel' || arm === 'unpublish') expect(m.end).not.toHaveBeenCalled()
      table.push({ arm, queueId: row.id, workerStatus: result.status, syntheticFetchCalls: m.fixtureFetch.mock.calls.length, outboundCalls: m.outbound.mock.calls.length, deleteListingsItemCalls: deletes.mock.calls.length })
    }
    await readDelay()
    const outcomes = await prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds } } })
    for (const entry of table) {
      const row = outcomes.find(row => row.id === entry.queueId)!, payload = row.payload as any
      Object.assign(entry, { syncStatus: row.syncStatus, outcome: payload.delistOutcome ?? 'NOT_SENT', fact: payload.channelFact ?? 'UNKNOWN', errorCode: row.errorCode, holdUntil: row.holdUntil?.toISOString() ?? null })
      if (entry.arm === 'transport') { expect(payload.delistOutcome).toBe('UNKNOWN'); expect(row.syncStatus).toBe('PENDING'); expect(row.holdUntil!.getTime()).toBeGreaterThan(Date.now()); expect(row.errorCode).toBe('DELIST_TRANSPORT_UNKNOWN') }
      if (entry.arm === 'access') { expect(payload.delistOutcome).toBe('UNKNOWN'); expect(payload.channelFact).toBe('REFUSED'); expect(row.syncStatus).toBe('SKIPPED') }
      if (entry.arm === 'unpublish') expect(row.errorCode).toBe('AMAZON_UNPUBLISH_NOT_IMPLEMENTED')
      if (entry.arm === 'cancel') expect(row.syncStatus).toBe('CANCELLED')
    }
    const attempted = table.find(entry => entry.arm === 'transport')!
    const lateCancel = await app.inject({ method: 'POST', url: '/api/products/delist-cascade/cancel', payload: { queueIds: [attempted.queueId] } })
    expect(lateCancel.statusCode).toBe(200)
    expect(lateCancel.json()).toEqual({ cancelled: [], notCancelled: [attempted.queueId] })
    expect(await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: attempted.queueId }, select: { syncStatus: true } })).toEqual({ syncStatus: 'PENDING' })
    expect(await prisma.productEvent.count({ where: { aggregateId: { startsWith: marker } } })).toBe(4)
    await prisma.outboundSyncQueue.update({ where: { id: attempted.queueId }, data: { holdUntil: new Date(0), nextRetryAt: new Date(0) } })
    m.batchIds = [attempted.queueId]
    const drain = await service.processPendingSyncs()
    m.batchIds = []
    expect(drain).toMatchObject({ processed: 1, skipped: 1, succeeded: 0, failed: 0 })
    await readDelay()
    const afterDrain = await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: attempted.queueId }, select: { syncStatus: true, syncedAt: true, nextRetryAt: true, errorCode: true, errorMessage: true, retryCount: true, payload: true } })
    expect(afterDrain).toMatchObject({ syncStatus: 'SKIPPED', syncedAt: null, nextRetryAt: null, errorCode: 'DELIST_TRANSPORT_UNKNOWN', retryCount: 1,
      payload: { delistOutcome: 'UNKNOWN', channelFact: 'UNKNOWN', delistDispatchErrorCode: 'LIFECYCLE_DISPATCH_REFUSED' } })
    expect(m.outbound).not.toHaveBeenCalled(); expect(deletes).not.toHaveBeenCalled()
    attempted.afterDrain = afterDrain
    await mkdir('../../docs/audits/2026-09-13-presence/pr2', { recursive: true })
    await writeFile('../../docs/audits/2026-09-13-presence/pr2/rehearsal.json', JSON.stringify({ database: `${target.host}/${database[0].name}`, marker, galeVersion: gale.version, at: new Date().toISOString(), afterCommit, table }, null, 2))
    console.table(table)
  } finally {
    m.batchIds = []
    // Unique sentinel VALUES, not a snapshot restore over any existing row.
    await prisma.outboundSyncQueue.deleteMany({ where: { payload: { path: ['productId'], equals: marker } } })
    await prisma.productEvent.deleteMany({ where: { aggregateId: { startsWith: marker } } })
    await prisma.product.deleteMany({ where: { sku: marker } })
    await readDelay()
    const cleanup = { products: await prisma.product.count({ where: { sku: marker } }), listings: await prisma.channelListing.count({ where: { id: { startsWith: marker } } }), queues: await prisma.outboundSyncQueue.count({ where: { payload: { path: ['productId'], equals: marker } } }), events: await prisma.productEvent.count({ where: { aggregateId: { startsWith: marker } } }) }
    expect(cleanup).toEqual({ products: 0, listings: 0, queues: 0, events: 0 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523' }, select: { version: true } })).toEqual({ version: gale.version })
    expect(m.outbound).not.toHaveBeenCalled()
    console.log('CLEANUP READ +8s', JSON.stringify(cleanup))
    await writeFile('../../docs/audits/2026-09-13-presence/pr2/rehearsal-cleanup.json', JSON.stringify({ at: new Date().toISOString(), database: `${target.host}${target.pathname}`, marker, cleanup, galeVersion: gale.version }, null, 2))
    await app.close(); deletes.mockRestore(); await prisma.$disconnect()
  }
}, 90_000)
