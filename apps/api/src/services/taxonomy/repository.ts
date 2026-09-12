import { listActiveConnections } from '../connection-resolver.service.js'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { mappingToken } from '../pim/mapping/revision-token.js'
import { taxonomyMarket, taxonomyProviders } from './providers.js'
import { TaxonomyError, validateTaxonomy, type TaxonomyDownload } from './model.js'
import { taxonomySearchCache } from './search-cache.js'

export const taxonomyWhere = (channel: string, market: string) => ({ channel: channel.toUpperCase(), marketplace: taxonomyMarket(channel.toUpperCase(), market) })
export const schemaMarkets = (channel: string, market: string) => [...new Set([taxonomyMarket(channel, market), market, ...(channel === 'EBAY' ? [market.startsWith('EBAY_') ? market : `EBAY_${market}`] : []), ...(['UK', 'GB', 'EBAY_GB', 'EBAY_UK'].includes(market) ? ['UK', 'GB', 'EBAY_GB', 'EBAY_UK'] : [])])]
const sourceKey = (channel: string, market: string) => ({ taxonomy_scope: workspaceKey(taxonomyWhere(channel, market)) })

export async function listTaxonomySources() {
  const [markets, sources, accounts] = await Promise.all([
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, name: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }] }),
    prisma.marketplaceTaxonomy.findMany(),
    listActiveConnections().then(rows => rows.filter(row => row.channelType !== 'AMAZON_ADS')),
  ])
  const snapshots = await prisma.marketplaceTaxonomySnapshot.findMany({ where: { id: { in: sources.flatMap(s => s.activeSnapshotId ? [s.activeSnapshotId] : []) } }, select: { id: true, nodeCount: true, addedCount: true, removedCount: true, changedCount: true, providerVersion: true } })
  // Selling connections appear before marketplace configuration. Advertising grants do
  // not define product categories; future selling channels still get an adapter state.
  for (const account of accounts) if (!markets.some(m => m.channel === account.channelType)) markets.push({ channel: account.channelType, code: 'GLOBAL', name: account.channelType })
  return markets.map(m => {
    const provider = taxonomyProviders[m.channel]
    const source = sources.find(s => s.channel === m.channel && s.marketplace === taxonomyMarket(m.channel, m.code))
    const snapshot = snapshots.find(s => s.id === source?.activeSnapshotId)
    return { channel: m.channel, market: m.code, name: m.name, label: provider?.label ?? m.channel,
      kind: provider?.kind ?? 'categories', supported: !!provider && (provider.scope === 'global' || m.code !== 'GLOBAL'), requirements: provider?.requirements ?? null,
      sourceMarket: taxonomyMarket(m.channel, m.code), sourceId: source?.id ?? null,
      snapshotId: source?.activeSnapshotId ?? null, nodeCount: snapshot?.nodeCount ?? null,
      changes: snapshot ? { added: snapshot.addedCount, removed: snapshot.removedCount, changed: snapshot.changedCount } : null,
      lastSyncedAt: source?.lastSyncedAt?.toISOString() ?? null, nextSyncAt: source?.nextSyncAt?.toISOString() ?? null,
      error: source?.lastError ?? null,
      state: !provider ? 'unsupported' : provider.scope === 'market' && m.code === 'GLOBAL' ? 'unconfigured' : source?.leaseUntil && source.leaseUntil > new Date() ? 'refreshing'
        : source && source.requestVersion > source.completedRequestVersion && !source.lastError ? 'queued'
        : source?.lastError ? 'failed' : !source?.activeSnapshotId ? 'missing' : !source.lastSyncedAt || source.lastSyncedAt.getTime() < Date.now() - 86_400_000 ? 'stale' : 'ready',
      accounts: accounts.filter(a => a.channelType === m.channel).map(a => ({ id: a.id, name: a.accountLabel || a.displayName || a.channelType })),
    }
  })
}

export async function assertConfiguredScope(channel: string, market: string) {
  const scopes = await listTaxonomySources()
  if (!scopes.some(s => s.channel === channel && s.market === market && (s.sourceMarket !== 'GLOBAL' || taxonomyProviders[channel]?.scope === 'global'))) throw new TaxonomyError('Choose a configured channel and market.', 404)
  if (!taxonomyProviders[channel]) throw new TaxonomyError('This channel needs a taxonomy adapter before categories can be synchronized.', 409)
}

export async function requestTaxonomyRefresh(channel: string, market: string, categoryId?: string) {
  await assertConfiguredScope(channel, market)
  if (categoryId) await getTaxonomyNode(channel, market, categoryId)
  return prisma.marketplaceTaxonomy.upsert({ where: sourceKey(channel, market),
    create: { ...taxonomyWhere(channel, market), requestVersion: 1, schemaRequests: categoryId ? [categoryId] : [] },
    update: { requestVersion: { increment: 1 }, lastError: null, retryAt: null, attempts: 0,
      ...(categoryId ? { schemaRequests: { push: categoryId } } : { nextSyncAt: new Date() }) },
  })
}

export async function searchTaxonomy(channel: string, market: string, input: { query?: string; parentId?: string; page?: number; snapshotId?: string; assignableOnly?: boolean }) {
  const source = await prisma.marketplaceTaxonomy.findUnique({ where: sourceKey(channel, market) })
  if (!source?.activeSnapshotId) return { items: [], total: 0, page: 1, pages: 0, snapshotId: null, state: 'missing' }
  if (input.snapshotId && input.snapshotId !== source.activeSnapshotId) throw new TaxonomyError('The taxonomy was updated. Refresh the results before continuing.', 409)
  // Always read the active pointer through business/actor RLS BEFORE accessing memory.
  // Immutable revisions can then be searched without two full database scans per keystroke.
  const result = await taxonomySearchCache.search(JSON.stringify([source.workspaceId, source.id, source.activeSnapshotId]), input,
    async () => {
      const rows = await prisma.marketplaceTaxonomyNode.findMany({ where: { snapshotId: source.activeSnapshotId! }, orderBy: [{ path: 'asc' }, { externalId: 'asc' }],
        select: { externalId: true, parentId: true, name: true, path: true, assignable: true } })
      if (!rows.length) throw new TaxonomyError('The category revision is unavailable. Reload before continuing.', 409)
      return rows
    })
  return { ...result, snapshotId: source.activeSnapshotId, state: source.nextSyncAt < new Date() ? 'stale' : 'ready' }
}

export async function getTaxonomyNode(channel: string, market: string, id: string, expectedSnapshot?: string) {
  const source = await prisma.marketplaceTaxonomy.findUnique({ where: sourceKey(channel, market) })
  if (!source?.activeSnapshotId) throw new TaxonomyError('Synchronize this channel’s taxonomy before choosing a category.', 409)
  if (expectedSnapshot && expectedSnapshot !== source.activeSnapshotId) throw new TaxonomyError('The taxonomy changed. Select the category again.', 409)
  const node = await prisma.marketplaceTaxonomyNode.findFirst({ where: { snapshotId: source.activeSnapshotId, externalId: id } })
  if (!node) throw new TaxonomyError('This category is not present in the current marketplace taxonomy.', 409, false)
  return { node, source }
}

export async function readTaxonomyRequirements(channel: string, market: string, id: string) {
  const { node, source } = await getTaxonomyNode(channel, market, id)
  const schema = channel === 'SHOPIFY' ? null : await prisma.categorySchema.findFirst({ where: { channel, productType: id,
    marketplace: { in: schemaMarkets(channel, market) }, isActive: true }, orderBy: { fetchedAt: 'desc' } })
  return { node, snapshotId: source.activeSnapshotId, schema: schema ? { id: schema.id, version: schema.schemaVersion, definition: schema.schemaDefinition, fetchedAt: schema.fetchedAt, expiresAt: schema.expiresAt } : null,
    state: !node.assignable ? 'notAssignable' : channel === 'SHOPIFY' ? 'store' : !schema ? 'missing' : schema.expiresAt < new Date() ? 'stale' : 'ready' }
}

/** Stage all rows, then atomically publish a complete revision under a fencing token. */
export async function publishTaxonomy(sourceId: string, leaseToken: string, download: TaxonomyDownload) {
  const checked = validateTaxonomy(download)
  const source = await prisma.marketplaceTaxonomy.findFirst({ where: { id: sourceId, leaseToken } })
  if (!source) throw new TaxonomyError('This refresh was superseded by another worker.', 409)
  const contentHash = mappingToken([...checked.nodes].sort((a, b) => a.externalId.localeCompare(b.externalId)))
  const active = source.activeSnapshotId ? await prisma.marketplaceTaxonomySnapshot.findUnique({ where: { id: source.activeSnapshotId } }) : null
  if (active?.contentHash === contentHash && active.providerVersion === checked.providerVersion) {
    const renewed = await prisma.marketplaceTaxonomy.updateMany({ where: { id: sourceId, leaseToken, leaseUntil: { gt: new Date() } }, data: { lastSyncedAt: new Date() } })
    if (renewed.count !== 1) throw new TaxonomyError('This refresh lost its worker lease.', 409)
    return active
  }
  const old = source.activeSnapshotId ? await prisma.marketplaceTaxonomyNode.findMany({ where: { snapshotId: source.activeSnapshotId }, select: { externalId: true, parentId: true, path: true, assignable: true } }) : []
  const before = new Map(old.map(n => [n.externalId, n]))
  const after = new Set(checked.nodes.map(n => n.externalId))
  // A drastic loss needs investigation, not automatic retirement of most of the catalogue.
  if (old.length > 100 && checked.nodes.length < old.length * 0.5) throw new TaxonomyError('The downloaded tree contains fewer than half the previous categories. The previous version has been preserved.', 409)
  const snapshot = await prisma.marketplaceTaxonomySnapshot.create({ data: { id: randomUUID(), sourceId, status: 'IMPORTING', providerVersion: checked.providerVersion,
    contentHash, nodeCount: checked.nodes.length,
    addedCount: checked.nodes.filter(n => !before.has(n.externalId)).length,
    removedCount: old.filter(n => !after.has(n.externalId)).length,
    changedCount: checked.nodes.filter(n => { const o = before.get(n.externalId); return o && (o.parentId !== n.parentId || o.path !== n.path || o.assignable !== n.assignable) }).length,
  } })
  try {
    for (let start = 0; start < checked.nodes.length; start += 500) {
      await prisma.marketplaceTaxonomyNode.createMany({ data: checked.nodes.slice(start, start + 500).map(node => ({ ...node, id: randomUUID(), snapshotId: snapshot.id, metadata: (node.metadata ?? {}) as Prisma.InputJsonValue })) })
    }
    await prisma.$transaction(async tx => {
      await tx.marketplaceTaxonomySnapshot.update({ where: { id: snapshot.id }, data: { status: 'SUCCEEDED', completedAt: new Date() } })
      const claim = await tx.marketplaceTaxonomy.updateMany({ where: { id: sourceId, leaseToken, leaseUntil: { gt: new Date() } }, data: { activeSnapshotId: snapshot.id, lastSyncedAt: new Date() } })
      if (claim.count !== 1) throw new TaxonomyError('This refresh lost its worker lease. The previous version has been preserved.', 409)
    })
    return snapshot
  } catch (error) {
    await prisma.marketplaceTaxonomySnapshot.update({ where: { id: snapshot.id }, data: { status: 'FAILED', completedAt: new Date(), error: error instanceof Error ? error.message : 'Import failed' } })
    throw error
  }
}

/** Keep recent trees for investigation; lightweight import history remains available. */
export async function pruneTaxonomyNodes(sourceId: string, leaseToken: string) {
  const source = await prisma.marketplaceTaxonomy.findFirst({ where: { id: sourceId, leaseToken, leaseUntil: { gt: new Date() } } })
  if (!source) return
  const snapshots = await prisma.marketplaceTaxonomySnapshot.findMany({ where: { sourceId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  const retained = new Set([source.activeSnapshotId, ...snapshots.slice(0, 3).map(s => s.id)])
  const old = snapshots.filter(s => !retained.has(s.id)).map(s => s.id)
  const failed = await prisma.marketplaceTaxonomySnapshot.findMany({ where: { sourceId, status: 'FAILED', createdAt: { lt: new Date(Date.now() - 86_400_000) } }, select: { id: true } })
  for (let i = 0, ids = [...old, ...failed.map(s => s.id)]; i < ids.length; i += 10) {
    await prisma.marketplaceTaxonomyNode.deleteMany({ where: { snapshotId: { in: ids.slice(i, i + 10) } } })
  }
}

export async function taxonomyHistory(sourceId: string) {
  return prisma.marketplaceTaxonomySnapshot.findMany({ where: { sourceId }, orderBy: { createdAt: 'desc' }, take: 25,
    select: { id: true, status: true, providerVersion: true, nodeCount: true, addedCount: true, removedCount: true, changedCount: true, error: true, createdAt: true, completedAt: true } })
}
