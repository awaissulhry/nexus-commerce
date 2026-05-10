/**
 * eBay Inventory Import Service
 *
 * Pulls live inventory items from the eBay Inventory API and upserts them
 * as Nexus Product records. Use this when eBay is the source of truth for
 * a product — i.e. you have eBay listings but no Nexus product yet.
 *
 * For reconciling EXISTING Nexus products to eBay listings, use
 * listing-reconciliation.service.ts (runEbayReconciliation).
 *
 * API used: GET /sell/inventory/v1/inventory_item (paginated, limit 200)
 * Auth: user-level OAuth via EbayAuthService.getValidToken()
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { ebayAuthService } from './ebay-auth.service.js'

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

interface EbayInventoryItem {
  sku: string
  product?: {
    title?: string
    description?: string
    aspects?: Record<string, string[]>
    imageUrls?: string[]
    ean?: string[]
    upc?: string[]
    mpn?: string
  }
  availability?: {
    shipToLocationAvailability?: { quantity?: number }
  }
  condition?: string
  packageWeightAndSize?: {
    weight?: { value?: number; unit?: string }
    dimensions?: { length?: number; width?: number; height?: number; unit?: string }
  }
}

async function fetchAllInventoryItems(accessToken: string): Promise<EbayInventoryItem[]> {
  const all: EbayInventoryItem[] = []
  let offset = 0
  const limit = 200

  while (true) {
    const res = await fetch(
      `${EBAY_API_BASE}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      throw new Error(`eBay GET /inventory_item failed: ${res.status} ${body}`)
    }
    const data: any = await res.json()
    const items: EbayInventoryItem[] = data.inventoryItems ?? []
    all.push(...items)
    if (all.length >= (data.total ?? 0) || items.length < limit) break
    offset += limit
  }

  return all
}

function extractAspect(aspects: Record<string, string[]> | undefined, keys: string[]): string | undefined {
  if (!aspects) return undefined
  for (const k of keys) {
    const val = aspects[k]?.[0]
    if (val) return val
  }
  return undefined
}

export async function importEbayCatalog(): Promise<{
  created: number
  updated: number
  total: number
  products: any[]
}> {
  // Get the active eBay connection
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true, displayName: true },
  })
  if (!connection) {
    throw new Error('No active eBay ChannelConnection found. Complete eBay OAuth first.')
  }

  const accessToken = await ebayAuthService.getValidToken(connection.id)
  logger.info('[ebay-import] Fetching inventory items', { connection: connection.displayName })

  const items = await fetchAllInventoryItems(accessToken)
  logger.info('[ebay-import] Items fetched', { count: items.length })

  const results: any[] = []
  let created = 0
  let updated = 0

  for (const item of items) {
    try {
      const aspects = item.product?.aspects ?? {}
      const title = item.product?.title ?? item.sku
      const brand = extractAspect(aspects, ['Brand', 'Marke', 'Marca'])
      const manufacturer = extractAspect(aspects, ['Manufacturer', 'Hersteller', 'Produttore'])
      const material = extractAspect(aspects, ['Material', 'Materiale', 'Werkstoff'])
      const color = extractAspect(aspects, ['Color', 'Colour', 'Colore', 'Farbe'])

      const categoryAttributes: Record<string, string> = {}
      if (material) categoryAttributes.material = material
      if (color) categoryAttributes.color = color
      if (extractAspect(aspects, ['Size', 'Größe', 'Taglia'])) {
        categoryAttributes.apparel_size = extractAspect(aspects, ['Size', 'Größe', 'Taglia'])!
      }

      const weight = item.packageWeightAndSize?.weight
      const dims = item.packageWeightAndSize?.dimensions
      const ean = item.product?.ean?.[0] ?? undefined
      const upc = item.product?.upc?.[0] ?? undefined

      const existing = await prisma.product.findUnique({ where: { sku: item.sku }, select: { id: true } })

      const data = {
        name: title,
        productType: 'APPAREL',
        categoryAttributes: Object.keys(categoryAttributes).length > 0 ? categoryAttributes : undefined,
        brand: brand ?? undefined,
        manufacturer: manufacturer ?? undefined,
        ean: ean ?? undefined,
        upc: upc ?? undefined,
        bulletPoints: [],
        weightValue: weight?.value ? weight.value : undefined,
        weightUnit: weight?.unit ?? undefined,
        dimLength: dims?.length ?? undefined,
        dimWidth: dims?.width ?? undefined,
        dimHeight: dims?.height ?? undefined,
        dimUnit: dims?.unit ?? undefined,
      }

      if (existing) {
        await prisma.product.update({ where: { id: existing.id }, data })
        updated++
        results.push({ sku: item.sku, action: 'updated', id: existing.id })
      } else {
        const created_ = await prisma.product.create({
          data: {
            sku: item.sku,
            name: title,
            basePrice: 0,
            ...data,
          },
        })
        created++
        results.push({ sku: item.sku, action: 'created', id: created_.id })
      }
    } catch (err: any) {
      logger.error('[ebay-import] Failed to upsert product', { sku: item.sku, error: err.message })
      results.push({ sku: item.sku, action: 'error', error: err.message })
    }
  }

  logger.info('[ebay-import] Done', { created, updated, total: items.length })
  return { created, updated, total: items.length, products: results }
}

export async function getEbayImportStats(): Promise<{
  totalProducts: number
  ebayProducts: number
}> {
  const [totalProducts, ebayProducts] = await Promise.all([
    prisma.product.count(),
    prisma.channelListing.count({ where: { channel: 'EBAY' } }),
  ])
  return { totalProducts, ebayProducts }
}
