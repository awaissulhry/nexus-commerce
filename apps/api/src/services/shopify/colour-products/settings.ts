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
 * The two grouping fields when colour products manage this family on this store and alias: the switch is on and at
 * least one colour is confirmed. Then the link writer (link.service.ts) is their only writer. Null: they are not managed.
 */
export async function colourManagedFields(destination: { familyId: string; accountId: string; marketplace: string; aliasKey?: string | null }) {
  // The rows first: most families have none, and then the store settings are not read at all.
  const linked = await prisma.shopifyColourProduct.count({ where: { familyId: destination.familyId, channelConnectionId: destination.accountId, marketplace: destination.marketplace,
    aliasKey: destination.aliasKey ?? '', state: 'LINKED' } })
  if (!linked) return null
  const settings = await readColourProductSettings(destination.accountId)
  return settings.enabled ? [settings.valueField, settings.listField] : null
}
