import { produceReadiness } from './readiness-index.service.js'
import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { contentField } from './content-resolver.js'
import { writeTranslation } from './translation-write.js'
import { marketLanguages } from './market-languages.js'
import { contentStorageValue } from './content-read.js'

export interface ContentWrite {
  productId: string; address: ContentAddress; values: Record<string, unknown>; reset?: string[]
  expectedVersion?: number; expectedContentVersion?: number; label: string
  userId?: string | null; ip?: string; state?: 'draft' | 'reviewed'
}
const refuse = (label: string) => Object.assign(new Error(`${label} changed. Reload before saving it.`), { statusCode: 409 })

/** Persist a validated, explicitly addressed edit; all shared writes cascade in this transaction. */
export async function writeContent(input: ContentWrite) {
  const address = contentAddress(input.address, input.label)
  if (address.tier === 'language') return writeTranslation({ ...input, address, locale: address.language, state: input.state ?? 'reviewed', expectedTranslationVersion: input.expectedContentVersion })
  return inDatabaseTransaction(prisma, async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: input.productId } })
    const values = Object.fromEntries(Object.entries(input.values).map(([key,value]) => [contentField(key), contentStorageValue(contentField(key), value)]))
    const resets = (input.reset ?? []).map(contentField)
    if (address.tier === 'source') {
      if (input.expectedVersion !== undefined && product.version !== input.expectedVersion) throw refuse(input.label)
      const attributes = { ...(product.categoryAttributes as Record<string, unknown> ?? {}) }, data: Record<string, any> = {}
      for (const [field,value] of Object.entries(values)) {
        const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
        if (column) data[column] = value ?? (['bulletPoints','keywords'].includes(column) ? [] : column === 'name' ? '' : null)
        else attributes[field] = value
      }
      for (const field of resets) {
        const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
        if (column) data[column] = ['bulletPoints','keywords'].includes(column) ? [] : column === 'name' ? '' : null
        else delete attributes[field]
        values[field] = null
      }
      const previousValues = Object.fromEntries(Object.keys(values).map(field => {
        const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
        return [field, column ? product[column] ?? null : (product.categoryAttributes as Record<string, unknown> | null)?.[field] ?? null]
      }))
      const updated = await prisma.product.updateMany({ where: { id: product.id, version: product.version }, data: { ...data, categoryAttributes: attributes as any, version: { increment: 1 } } })
      if (updated.count !== 1) throw refuse(input.label)
      const { masterContentService } = await import('../master-content.service.js')
      await masterContentService.update(product.id, values, { address, locale: PRIMARY_CONTENT_LOCALE, actor: input.userId, reviewed: input.state !== 'draft', masterAlreadyWritten: true, previousValues, tx: prisma as any })
      return prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    }
    const c = address.coordinate
    const languages = await marketLanguages(c.channel, c.market)
    // LX.F2 R-LX-16 (F-LX-8) — the refusal now NAMES THE ADDRESS IT NEEDS. R-LX-16
    // allows exactly two outcomes for a content write: it lands through the router,
    // or it answers 400 naming the address it needs. The old sentence named only the
    // language, so a client holding a pin address had nothing to retry with. The
    // shared/language tier is the destination that IS available for this language
    // (it is not coordinate-bound), so the sentence names that tier and the
    // coordinate's real languages.
    if (!languages.includes(address.language)) throw Object.assign(new Error(`${input.label} is unavailable in ${address.language} on ${c.channel} · ${c.market} — that coordinate carries ${languages.join(', ')}. Save it as the shared ${address.language} text instead (tier "language", language "${address.language}").`), { statusCode: 400 })
    const listings = await prisma.channelListing.findMany({ where: { productId: product.id, channel: c.channel as any, marketplace: c.market,
      ...(c.accountId ? { channelConnectionId: c.accountId } : {}), aliasKey: c.aliasId ?? '' }, include: { translations: true } })
    if (listings.length !== 1) throw Object.assign(new Error(`${input.label} needs one existing listing and account before a pin can be saved.`), { statusCode: 409 })
    const listing = listings[0], prior = listing.translations.find(row => row.language === address.language)
    if (input.expectedVersion !== undefined && listing.version !== input.expectedVersion || input.expectedContentVersion !== undefined && (prior?.version ?? 0) !== input.expectedContentVersion) throw refuse(input.label)
    const attributes = { ...(prior?.attributes as Record<string, unknown> ?? {}) }, data: Record<string, any> = {}
    const follows = new Set(prior?.follows ?? [])
    for (const [field,value] of Object.entries(values)) {
      const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      follows.delete(field)
      if (column) { data[column] = value ?? (['bulletPoints','keywords'].includes(column) ? [] : null); delete attributes[field]; if (value === null || value === '' || Array.isArray(value) && !value.length) attributes[field] = value }
      else attributes[field] = value
    }
    for (const field of resets) {
      const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      if (column) data[column] = ['bulletPoints','keywords'].includes(column) ? [] : null
      delete attributes[field]; follows.add(field)
    }
    const bumped = await prisma.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { version: { increment: 1 } } })
    if (bumped.count !== 1) throw refuse(input.label)
    Object.assign(data, { attributes, follows: [...follows], source: input.state === 'draft' ? 'ai' : 'manual', reviewedAt: input.state === 'draft' ? null : new Date() })
    if (prior) {
      const saved = await prisma.channelListingTranslation.updateMany({ where: { id: prior.id, version: prior.version }, data: { ...data, version: { increment: 1 } } })
      if (saved.count !== 1) throw refuse(input.label)
    } else await prisma.channelListingTranslation.create({ data: { ...data, channelListingId: listing.id, language: address.language, version: 1 } })
    await prisma.auditLog.create({ data: { entityType: 'ChannelListing', entityId: listing.id, action: 'update', userId: input.userId ?? null, ip: input.ip,
      before: prior as any ?? {}, after: { values, reset: resets } as any, metadata: { layer: 'pin', language: address.language, coordinate: c as any } } })
    await produceReadiness(product.id, { channel: listing.channel, market: listing.marketplace, accountId: listing.channelConnectionId })
    return prisma.channelListingTranslation.findUniqueOrThrow({ where: { channelListingId_language: workspaceKey({ channelListingId: listing.id, language: address.language }) } })
  })
}
