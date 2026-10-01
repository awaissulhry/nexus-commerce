import type { ChannelListing, Prisma, PrismaClient } from '@prisma/client'
import type { BulkSaveUnit } from '../services/products/bulk-save.service.js'

export const CLEAR_CATEGORY = '99000731'
export const COUNTRY_FIELD = 'attr_paese_di_origine'
export const CUSTOM_FIELD = 'attr_other_specific_genere'
export const COLOR_FIELD = 'attr_color'
export const COUNTRY_NAME = 'Paese di origine'
let serial = 0

export interface ClearEnvironment { accountId: string; otherAccountId: string }
export interface ClearFamily {
  parentId: string
  children: string[]
  productIds: string[]
  accountId: string
  market: string
  locale: string
  aliasKey: string
}

/** Entirely made-up cached category/account data. No channel credentials or provider calls. */
export async function seedClearEnvironment(client: PrismaClient): Promise<ClearEnvironment> {
  for (const [market, locale] of [['IT', 'it'], ['DE', 'de']]) {
    await client.marketplace.create({ data: { channel: 'EBAY', code: market, name: `Clear ${market}`, currency: 'EUR', region: 'EU', language: locale, languages: [locale] } })
    await client.categorySchema.create({ data: {
      channel: 'EBAY', marketplace: market, productType: CLEAR_CATEGORY, schemaVersion: 'e2e-family-clear', expiresAt: new Date('2099-01-01'),
      schemaDefinition: { aspects: [
        { id: `aspect_${COUNTRY_NAME}`, kind: 'enum', label: COUNTRY_NAME, localizedName: COUNTRY_NAME, options: ['Pakistan', 'Cina', 'Italia'], enumMode: 'strict', cardinality: 'SINGLE' },
        { id: 'aspect_Color', kind: 'text', label: 'Colore', localizedName: 'Colore', englishName: 'Color', cardinality: 'SINGLE', variantEligible: true },
      ] },
    } })
  }
  const accounts = []
  for (const primary of [true, false]) accounts.push(await client.channelConnection.create({ data: {
    channelType: 'EBAY', accountLabel: primary ? 'E2E clear main' : 'E2E clear other', isActive: true, isPrimary: primary,
    externalAccountId: `E2E-CLEAR-${primary ? 'MAIN' : 'OTHER'}`,
  } }))
  return { accountId: accounts[0].id, otherAccountId: accounts[1].id }
}

export async function seedClearFamily(client: PrismaClient, environment: ClearEnvironment, options: {
  children?: number; noParentListing?: boolean; omitLastListing?: boolean; emptyCountry?: boolean
} = {}): Promise<ClearFamily> {
  const prefix = `E2E-CLEAR-${++serial}`
  const parent = await client.product.create({ data: { sku: prefix, name: prefix, brand: 'Pakistan', basePrice: 10, isParent: true, variationAxes: ['Colore'] } })
  const children: string[] = []
  for (let index = 0; index < (options.children ?? 2); index++) {
    const child = await client.product.create({ data: { sku: `${prefix}-${String(index).padStart(3, '0')}`, name: `Clear child ${index}`, basePrice: 10, parentId: parent.id } })
    children.push(child.id)
  }
  const family: ClearFamily = { parentId: parent.id, children, productIds: [parent.id, ...children], accountId: environment.accountId, market: 'IT', locale: 'it', aliasKey: '' }
  await seedClearListings(client, family, options)
  return family
}

export async function seedClearListings(client: PrismaClient, family: ClearFamily, options: {
  noParentListing?: boolean; omitLastListing?: boolean; emptyCountry?: boolean
} = {}): Promise<void> {
  for (const [index, productId] of family.productIds.entries()) {
    if (index === 0 && options.noParentListing || index === family.productIds.length - 1 && options.omitLastListing) continue
    const specifics: Record<string, Prisma.InputJsonValue> = index === 0
      ? { ...(options.emptyCountry ? {} : { [COUNTRY_NAME]: 'Pakistan' }) }
      : { Colore: index === 1 ? 'Rosso' : 'Giallo', Genere: index === 1 ? 'Uomo' : 'Donna', ...(options.emptyCountry ? {} : { [COUNTRY_NAME]: 'Cina' }) }
    await client.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: family.market, channelMarket: `EBAY_${family.market}`,
      region: 'EU', channelConnectionId: family.accountId, aliasKey: family.aliasKey, version: 10,
      platformAttributes: { categoryId: CLEAR_CATEGORY, itemSpecifics: specifics },
    } })
  }
}

export const clearListings = (client: PrismaClient, family: ClearFamily) => client.channelListing.findMany({ where: {
  productId: { in: family.productIds }, channel: 'EBAY', marketplace: family.market, channelConnectionId: family.accountId, aliasKey: family.aliasKey,
}, orderBy: { productId: 'asc' } })

export const itemSpecifics = (listing: Pick<ChannelListing, 'platformAttributes'>): Prisma.JsonObject =>
  (listing.platformAttributes as { itemSpecifics?: Prisma.JsonObject } | null)?.itemSpecifics ?? {}

export function clearUnit(family: ClearFamily, listing: Pick<ChannelListing, 'productId' | 'version'>, field = COUNTRY_FIELD, key = listing.productId): BulkSaveUnit {
  return { key, expectedVersion: listing.version,
    marketplaceContexts: [{ channel: 'EBAY', marketplace: family.market, accountId: family.accountId, locale: family.locale, aliasKey: family.aliasKey }],
    changes: [{ id: listing.productId, field, value: null, target: 'channel', intent: 'set' }],
  }
}
