import { randomUUID } from 'node:crypto'
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { publishTaxonomy, listTaxonomySources, schemaMarkets, getTaxonomyNode, pruneTaxonomyNodes } from '../services/taxonomy/repository.js'
import { taxonomyProviders } from '../services/taxonomy/providers.js'
import { TaxonomyError } from '../services/taxonomy/model.js'

const DAY = 86_400_000
const LEASE = 180_000
let task: ReturnType<typeof cron.schedule> | null = null
const messageFor = (error: unknown) => error instanceof Error ? error.message : 'Refresh failed.'
const retryDate = (attempts: number) => new Date(Date.now() + Math.min(DAY, 300_000 * 2 ** Math.min(attempts, 8)))

/** Database queue survives API restarts. Each source has one fenced worker at a time. */
export async function runTaxonomyRefresh() {
  const configured = await listTaxonomySources()
  const missing = configured.filter(s => s.supported && !s.sourceId)
  if (missing.length) await prisma.marketplaceTaxonomy.createMany({ data: missing.map(s => ({ channel: s.channel, marketplace: s.sourceMarket })), skipDuplicates: true })
  const scopes = configured.filter(s => s.supported).map(s => ({ channel: s.channel, marketplace: s.sourceMarket }))
  if (!scopes.length) return
  const now = new Date()
  // The workspace database proxy exposes query methods, not Prisma field references.
  // Compare versions on this small, configured source list before limiting the work.
  const eligible = await prisma.marketplaceTaxonomy.findMany({ where: { OR: scopes,
    AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, { OR: [{ retryAt: null }, { retryAt: { lte: now } }] }],
  }, orderBy: [{ nextSyncAt: 'asc' }, { id: 'asc' }] })
  const sources = eligible.filter(s => s.nextSyncAt <= now || s.requestVersion > s.completedRequestVersion).slice(0, 2)
  for (const source of sources) {
    const provider = taxonomyProviders[source.channel]
    if (!provider || !configured.some(s => s.channel === source.channel && s.sourceMarket === source.marketplace && s.supported)) continue
    const token = randomUUID()
    const claim = await prisma.marketplaceTaxonomy.updateMany({ where: { id: source.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE) } })
    if (claim.count !== 1) continue
    const renew = () => prisma.marketplaceTaxonomy.updateMany({ where: { id: source.id, leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE) } })
    const heartbeat = setInterval(() => { void renew().catch(error => logger.warn('Taxonomy lease renewal failed', { error: messageFor(error) })) }, 30_000)
    try {
      await prisma.marketplaceTaxonomySnapshot.updateMany({ where: { sourceId: source.id, status: 'IMPORTING', createdAt: { lt: now } }, data: { status: 'FAILED', completedAt: new Date(), error: 'The previous worker stopped before completing this import.' } })
      const full = !source.activeSnapshotId || source.nextSyncAt <= now
      if (full) {
        await publishTaxonomy(source.id, token, await provider.download(source.marketplace))
        // Preserve a newer explicit tree request; schema-only refreshes never postpone the scheduled tree refresh.
        await prisma.marketplaceTaxonomy.updateMany({ where: { id: source.id, leaseToken: token, requestVersion: source.requestVersion }, data: { nextSyncAt: new Date(Date.now() + DAY) } })
      }
      const markets = schemaMarkets(source.channel, source.marketplace)
      const inUse = full && provider.requirements === 'category' ? await prisma.categorySchema.findMany({ where: { channel: source.channel, marketplace: { in: markets }, isActive: true }, distinct: ['productType'], select: { productType: true } }) : []
      const mappings = full && provider.requirements === 'category' ? await prisma.categoryChannelMapping.findMany({ where: { channel: source.channel, marketplace: { in: [...markets, '*'] } }, select: { channelCategoryId: true } }) : []
      const requested = [...new Set([...source.schemaRequests, ...inUse.map(s => s.productType), ...mappings.map(m => m.channelCategoryId)])]
      const batch = provider.requirements === 'category' ? requested.slice(0, 25) : []
      const failed: string[] = [], errors: string[] = []
      if (batch.length) {
        const { CategorySchemaService } = await import('../services/categories/schema-sync.service.js')
        const { AmazonService } = await import('../services/marketplaces/amazon.service.js')
        const service = new CategorySchemaService(prisma, new AmazonService())
        const amazonScope = source.channel === 'AMAZON' ? await (await import('../services/taxonomy/amazon.js')).amazonTaxonomyScope(source.marketplace) : {}
        for (const id of batch) {
          if ((await renew()).count !== 1) throw new Error('Refresh ownership changed. Remaining requests will be retried.')
          try {
            const { node } = await getTaxonomyNode(source.channel, source.marketplace, id)
            if (!node.assignable) throw new TaxonomyError('This category can no longer be assigned.', 409, false)
            await service.refreshSchema({ ...amazonScope, channel: source.channel as 'AMAZON' | 'EBAY' | 'ETSY', marketplace: source.marketplace, productType: id })
          } catch (error) { if (!(error instanceof TaxonomyError) || error.retryable) failed.push(id); errors.push(`${id}: ${messageFor(error)}`) }
          await new Promise(resolve => setTimeout(resolve, 350))
        }
      }
      // A failed category goes behind unprocessed categories so it cannot starve the rest of the queue.
      const remaining = provider.requirements === 'category' ? [...requested.slice(batch.length), ...failed] : []
      const failure = errors.length ? `Requirements need attention. ${errors.join(' · ')}`.slice(0, 1000) : null
      await pruneTaxonomyNodes(source.id, token).catch(error => logger.warn('Taxonomy history cleanup deferred', { error: messageFor(error) }))
      await prisma.$transaction(async tx => {
        const cleared = await tx.marketplaceTaxonomy.updateMany({ where: { id: source.id, leaseToken: token, requestVersion: source.requestVersion }, data: {
          schemaRequests: remaining, completedRequestVersion: remaining.length ? source.completedRequestVersion : source.requestVersion,
          requestVersion: remaining.length ? { increment: 1 } : source.requestVersion,
        } })
        await tx.marketplaceTaxonomy.updateMany({ where: { id: source.id, leaseToken: token }, data: {
          leaseUntil: null, leaseToken: null, lastError: failure, retryAt: failure ? retryDate(source.attempts) : null, attempts: failure ? { increment: 1 } : 0,
          ...(cleared.count ? {} : { completedRequestVersion: source.requestVersion }),
        } })
      })
    } catch (error) {
      const message = messageFor(error).slice(0, 1000)
      await prisma.marketplaceTaxonomy.updateMany({ where: { id: source.id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null, attempts: { increment: 1 }, lastError: message, retryAt: retryDate(source.attempts) } })
      logger.warn('Taxonomy refresh needs attention; cached data remains available', { channel: source.channel, marketplace: source.marketplace, error: message })
    } finally { clearInterval(heartbeat) }
  }
}

export function startTaxonomyRefreshCron() {
  if (task || process.env.NEXUS_ENABLE_TAXONOMY_REFRESH_CRON === '0') return
  task = cron.schedule('* * * * *', () => runTaxonomyRefresh().catch(error => logger.error('Taxonomy refresh queue failed', { error: messageFor(error) })))
}
export function stopTaxonomyRefreshCron() { task?.stop(); task = null }
