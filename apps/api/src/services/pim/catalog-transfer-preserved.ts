import type { TransferCell, TransferRow } from '@nexus/shared/catalog-transfer'
import { TRANSFER_CHANNELS, transferCategoryField, transferIsStore, transferTargetKey } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { type TransferTarget, type TransferContracts } from './catalog-transfer-plan.js'
import { jsonRecord, storedChannelState } from './channel-value-mutation.js'

/** Enumerate untouched overrides for shared updates without materializing inherited channel facts. */
export async function preservedTransferOverrides(jobId: string, targets: TransferTarget[], contracts: TransferContracts) {
  const shared = targets.filter(t => t.identity.entity === 'Products' && t.before && t.cells.some(c => c.verdict === 'changed'))
  const bySku = new Map<string, TransferCell[]>()
  if (!shared.length) return bySku
  const byId = new Map(shared.map(t => [String(t.before!.id), t.identity.sku]))
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: [...byId.keys()] }, channel: { in: TRANSFER_CHANNELS } }, take: 10_001 })
  if (listings.length > 10_000) throw new Error('This review batch exceeds 10,000 listing destinations')
  const keys = listings.map(l => transferTargetKey({ entity: 'Listings', sku: byId.get(l.productId)!, channel: l.channel, accountId: l.channelConnectionId ?? '', marketplace: l.marketplace, aliasKey: l.aliasKey }))
  const declared = keys.length ? await prisma.importJobRow.findMany({ where: { jobId, targetId: { in: keys } }, select: { targetId: true, parsedValues: true } }) : []
  const addressed = new Map(declared.map(d => [d.targetId, (d.parsedValues as unknown as { rows: TransferRow[] }).rows]))
  const { resolveCategoriesForProducts } = await import('./mapping/category-mapping.service.js')
  const defaults = new Map<string, Record<string, { channelCategoryId?: string | null }>>()
  let preserved = 0
  for (const listing of listings) {
    const sku = byId.get(listing.productId)!, identity = { entity: 'Overrides' as const, sku, channel: listing.channel, accountId: listing.channelConnectionId ?? '', marketplace: listing.marketplace, aliasKey: listing.aliasKey }
    const categoryKey = transferCategoryField(listing.channel)
    const coordinate = JSON.stringify([listing.channel, listing.marketplace])
    if (!defaults.has(coordinate)) defaults.set(coordinate, await resolveCategoriesForProducts({ productIds: [...byId.keys()], channel: listing.channel, marketplace: listing.marketplace }))
    const category = String(jsonRecord(listing.platformAttributes)[categoryKey] ?? defaults.get(coordinate)?.[listing.productId]?.channelCategoryId ?? '')
    // With no schema/category, enumerate the explicit override bag and native follow flags.
    // These are storage entries, and are displayed as such; no effective value is inferred.
    const fallback = [
      ...Object.keys(jsonRecord(listing.overrideData)).map(fieldKey => ({ fieldKey, sheetKey: undefined, channelStore: undefined })),
      ...[['title', 'followMasterTitle', 'titleOverride'], ['description', 'followMasterDescription', 'descriptionOverride'], ['brand', 'followMasterBrand', 'brandOverride'], ['bulletPoints', 'followMasterBulletPoints', 'bulletPointsOverride'], ['keywords', 'followMasterKeywords', 'keywordsOverride']].filter(([, flag]) => (listing as unknown as Record<string, unknown>)[flag] === false).map(([fieldKey, followFlag, column]) => ({ fieldKey, sheetKey: undefined, channelStore: { kind: 'listingColumn' as const, followFlag, column } })),
    ]
    let fields: { fieldKey: string; sheetKey?: string; channelStore?: Parameters<typeof storedChannelState>[1] }[] = fallback
    if (category || transferIsStore(listing.channel)) {
      try {
        const canonical = (await contracts.channel(listing.channel, listing.marketplace, category)).fields
        const keys = new Set(canonical.flatMap(f => [f.fieldKey, f.sheetKey].filter(Boolean)))
        const flags = new Set(canonical.flatMap(f => f.channelStore?.kind === 'listingColumn' ? [f.channelStore.followFlag] : []))
        fields = [...canonical, ...fallback.filter(f => !keys.has(f.fieldKey) && (!f.channelStore || !flags.has(f.channelStore.followFlag)))]
      }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith('No cached ')) throw error }
    }
    const touched = addressed.get(transferTargetKey(identity)) ?? []
    const cells = bySku.get(sku) ?? []
    const seen = new Set<string>()
    for (const field of fields) {
      if (seen.has(field.fieldKey) || field.fieldKey === categoryKey || touched.some(r => r.field === field.fieldKey || r.field === field.sheetKey)) continue
      seen.add(field.fieldKey)
      const state = storedChannelState(listing, field.channelStore, [field.fieldKey, field.sheetKey].filter((k): k is string => !!k))
      if (state.state !== 'stored') continue
      if (++preserved > 50_000) throw new Error('This review batch exceeds 50,000 preserved override entries')
      cells.push({ ...identity, row: 0, locale: '', field: field.fieldKey, action: state.value == null ? 'CLEAR' : 'SET', before: state.value, after: state.value, beforeState: 'stored', afterState: 'stored', verdict: 'unchanged' })
    }
    bySku.set(sku, cells)
  }
  return bySku
}
