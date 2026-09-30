/**
 * The store switch for Shopify colour products (docs/studies/shopify-linked-variations-PLAN.md §3.2): per Shopify
 * account, whether families show each colour as its own Shopify product, and which two product fields group them. Kept
 * in `ChannelConnection.connectionMetadata`, like the other per-store Shopify settings (collection order). The grouping
 * method is named, so another one (Shopify Combined Listings, an app) can replace the theme fields later without new
 * products.
 */
import { z } from 'zod'
import prisma from '../../../db.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'

export const COLOUR_PRODUCTS_KEY = 'shopifyColourProducts'
const field = z.object({ namespace: z.string().min(1).max(255), key: z.string().min(1).max(64) }).strict()
export const colourProductSettingsSchema = z.object({
  enabled: z.boolean(),
  /** How the colour products are grouped. `theme-metafields`: every product names its colour and lists the group. */
  method: z.literal('theme-metafields'),
  /** Single-line text: the product's colour (Impact: `custom.variation_value`). */
  valueField: field,
  /** List of product references: every product of the group, itself included (Impact: `custom.variation_products`). */
  listField: field,
}).strict()
export type ColourProductSettings = z.infer<typeof colourProductSettingsSchema>
export const DEFAULT_COLOUR_PRODUCT_SETTINGS: ColourProductSettings = {
  enabled: false, method: 'theme-metafields',
  valueField: { namespace: 'custom', key: 'variation_value' },
  listField: { namespace: 'custom', key: 'variation_products' },
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

async function shopifyConnection(accountId: string) {
  const connection = await prisma.channelConnection.findFirst({ where: { id: accountId, channelType: 'SHOPIFY' }, select: { id: true, connectionMetadata: true, updatedAt: true } })
  if (!connection) throw new WorkspaceScopeError('Choose a Shopify store of this business.', 404)
  return connection
}

/** The store's switch, with the defaults filled in. A stored value that no longer parses reads as the defaults. */
export async function readColourProductSettings(accountId: string): Promise<ColourProductSettings & { revision: string }> {
  const connection = await shopifyConnection(accountId)
  const stored = colourProductSettingsSchema.safeParse({ ...DEFAULT_COLOUR_PRODUCT_SETTINGS, ...object(object(connection.connectionMetadata)[COLOUR_PRODUCTS_KEY]) })
  return { ...(stored.success ? stored.data : DEFAULT_COLOUR_PRODUCT_SETTINGS), revision: connection.updatedAt.toISOString() }
}

/** Saves the switch. `expectedRevision` is the revision the operator saw: a concurrent account change is never overwritten. */
export async function saveColourProductSettings(accountId: string, body: unknown): Promise<ColourProductSettings & { revision: string }> {
  const input = object(body)
  const settings = colourProductSettingsSchema.parse(input.settings)
  const connection = await shopifyConnection(accountId)
  if (input.expectedRevision !== connection.updatedAt.toISOString()) throw new WorkspaceScopeError('The store settings changed. Reload them before saving.', 409)
  const metadata = object(connection.connectionMetadata)
  const result = await prisma.channelConnection.updateMany({ where: { id: accountId, updatedAt: connection.updatedAt }, data: { connectionMetadata: { ...metadata, [COLOUR_PRODUCTS_KEY]: settings } as never } })
  if (result.count !== 1) throw new WorkspaceScopeError('A concurrent store update interrupted this save. Reload before retrying.', 409)
  return readColourProductSettings(accountId)
}

/**
 * Who owns the two grouping fields (PR 4: the link writer, link.service.ts). `family`: colour products manage this family
 * on this store and alias (a colour is confirmed). `products`: the confirmed colour products, of any family of the store,
 * among `ownerIds` and this family's own. Null: the switch is off, or none of them is a colour product.
 */
export async function colourGrouping(destination: { familyId: string; accountId: string; marketplace: string; aliasKey?: string | null }, ownerIds: readonly string[] = []) {
  const own = { familyId: destination.familyId, marketplace: destination.marketplace, aliasKey: destination.aliasKey ?? '' }
  // The rows first: most families and products have none, and then the store settings are not read at all.
  const rows = await prisma.shopifyColourProduct.findMany({ where: { channelConnectionId: destination.accountId, state: 'LINKED', shopifyProductId: { not: null },
    OR: [own, ...(ownerIds.length ? [{ shopifyProductId: { in: [...new Set(ownerIds)] } }] : [])] }, select: { familyId: true, marketplace: true, aliasKey: true, shopifyProductId: true } })
  if (!rows.length) return null
  const settings = await readColourProductSettings(destination.accountId)
  if (!settings.enabled) return null
  return { fields: [settings.valueField, settings.listField], family: rows.some(r => r.familyId === own.familyId && r.marketplace === own.marketplace && r.aliasKey === own.aliasKey),
    products: rows.map(r => r.shopifyProductId!) }
}
