/**
 * Unified Flat-File API
 *
 * Powers the /bulk-operations page with all-channel data in one grid.
 *
 * GET  /api/flat-file/unified-template   — column manifest (Master + all channel groups)
 * GET  /api/flat-file/unified-rows       — product rows with all channel fields
 * GET  /api/products/browse-nodes/facets — browse node facets for filter picker
 * PATCH /api/flat-file/unified-rows      — save changes (dispatches per channel)
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

// ─── Active channel × marketplace combos ─────────────────────────────────────

const AMAZON_MARKETS = ['IT', 'DE'] as const
const EBAY_MARKETS   = ['IT', 'DE', 'UK'] as const

// ─── Column group colours (matching existing flat-file page palette) ──────────

const MASTER_COLOR   = 'slate'
const AMAZON_COLORS: Record<string, string> = { IT: 'blue', DE: 'indigo' }
const EBAY_COLORS: Record<string, string>   = { IT: 'amber', DE: 'orange', UK: 'purple' }
const SHOPIFY_COLOR  = 'emerald'

// ─── Master column group ──────────────────────────────────────────────────────

function buildMasterGroup() {
  return {
    id: 'master',
    label: 'Master Data',
    color: MASTER_COLOR,
    columns: [
      { id: 'sku',           label: 'SKU',           kind: 'readonly', width: 140, frozen: true },
      { id: 'name',          label: 'Name',           kind: 'text',     width: 240 },
      { id: 'brand',         label: 'Brand',          kind: 'text',     width: 120 },
      { id: 'status',        label: 'Status',         kind: 'enum',     width: 100,
        options: ['ACTIVE', 'DRAFT', 'INACTIVE'],
        optionLabels: { ACTIVE: 'Active', DRAFT: 'Draft', INACTIVE: 'Inactive' } },
      { id: 'productType',   label: 'Product Type',   kind: 'text',     width: 140 },
      { id: 'basePrice',     label: 'Base Price',     kind: 'number',   width: 100 },
      { id: 'costPrice',     label: 'Cost Price',     kind: 'number',   width: 100 },
      { id: 'totalStock',    label: 'Total Stock',    kind: 'number',   width: 90 },
      { id: 'ean',           label: 'EAN',            kind: 'text',     width: 130 },
      { id: 'upc',           label: 'UPC',            kind: 'text',     width: 130 },
      { id: 'gtin',          label: 'GTIN',           kind: 'text',     width: 130 },
      { id: 'weightValue',   label: 'Weight',         kind: 'number',   width: 90 },
      { id: 'weightUnit',    label: 'Weight Unit',    kind: 'text',     width: 80 },
      { id: 'dimLength',     label: 'Length',         kind: 'number',   width: 80 },
      { id: 'dimWidth',      label: 'Width',          kind: 'number',   width: 80 },
      { id: 'dimHeight',     label: 'Height',         kind: 'number',   width: 80 },
      { id: 'dimUnit',       label: 'Dim Unit',       kind: 'text',     width: 80 },
    ],
  }
}

// ─── Amazon column groups (one per marketplace) ───────────────────────────────

function buildAmazonGroup(mp: string) {
  const label = `Amazon ${mp}`
  const prefix = `amazon_${mp}_`
  return {
    id: `amazon_${mp}`,
    label,
    color: AMAZON_COLORS[mp] ?? 'blue',
    columns: [
      { id: `${prefix}title`,         label: 'Title',           kind: 'text',     width: 240, maxLength: 200 },
      { id: `${prefix}bullet_1`,      label: 'Bullet 1',        kind: 'text',     width: 200 },
      { id: `${prefix}bullet_2`,      label: 'Bullet 2',        kind: 'text',     width: 200 },
      { id: `${prefix}bullet_3`,      label: 'Bullet 3',        kind: 'text',     width: 200 },
      { id: `${prefix}bullet_4`,      label: 'Bullet 4',        kind: 'text',     width: 200 },
      { id: `${prefix}bullet_5`,      label: 'Bullet 5',        kind: 'text',     width: 200 },
      { id: `${prefix}description`,   label: 'Description',     kind: 'longtext', width: 280 },
      { id: `${prefix}keywords`,      label: 'Keywords',        kind: 'text',     width: 200 },
      { id: `${prefix}price`,         label: 'Price',           kind: 'number',   width: 90 },
      { id: `${prefix}quantity`,      label: 'Quantity',        kind: 'number',   width: 80 },
      { id: `${prefix}asin`,          label: 'ASIN',            kind: 'readonly', width: 120 },
      { id: `${prefix}listing_status`,label: 'Listing Status',  kind: 'readonly', width: 120 },
      { id: `${prefix}fulfillment`,   label: 'Fulfillment',     kind: 'enum',     width: 100,
        options: ['DEFAULT', 'AMAZON_NA'],
        optionLabels: { DEFAULT: 'FBM', AMAZON_NA: 'FBA' } },
      { id: `${prefix}browse_node_id`,label: 'Browse Node ID',  kind: 'text',     width: 130 },
    ],
  }
}

// ─── eBay column groups (one per marketplace) ─────────────────────────────────

function buildEbayGroup(mp: string) {
  const label = `eBay ${mp}`
  const prefix = `ebay_${mp}_`
  return {
    id: `ebay_${mp}`,
    label,
    color: EBAY_COLORS[mp] ?? 'amber',
    columns: [
      { id: `${prefix}title`,       label: 'Title',          kind: 'text',     width: 200, maxLength: 80 },
      { id: `${prefix}price`,       label: 'Price',          kind: 'number',   width: 90 },
      { id: `${prefix}quantity`,    label: 'Quantity',       kind: 'number',   width: 80 },
      { id: `${prefix}item_id`,     label: 'Item ID',        kind: 'readonly', width: 130 },
      { id: `${prefix}listing_status`, label: 'Status',     kind: 'readonly', width: 110 },
      { id: `${prefix}condition`,   label: 'Condition',      kind: 'text',     width: 110 },
      { id: `${prefix}category_id`, label: 'Category ID',   kind: 'text',     width: 110 },
    ],
  }
}

// ─── Shopify column group ─────────────────────────────────────────────────────

function buildShopifyGroup() {
  return {
    id: 'shopify',
    label: 'Shopify',
    color: SHOPIFY_COLOR,
    columns: [
      { id: 'shopify_handle',   label: 'Handle',          kind: 'text',     width: 160 },
      { id: 'shopify_price',    label: 'Price',           kind: 'number',   width: 90 },
      { id: 'shopify_compare',  label: 'Compare at',      kind: 'number',   width: 100 },
      { id: 'shopify_inventory',label: 'Inventory',       kind: 'number',   width: 90 },
      { id: 'shopify_status',   label: 'Status',          kind: 'readonly', width: 100 },
    ],
  }
}

// ─── Row shaper ───────────────────────────────────────────────────────────────

function shapeUnifiedRow(
  product: any,
  isParent: boolean,
  parentId: string | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    _rowId: product.id,
    _productId: product.id,
    _isMaster: isParent,
    _parentId: parentId,
    _dirty: false,
    _status: 'idle',
    // Master fields
    sku: product.sku,
    name: product.name,
    brand: product.brand ?? '',
    status: product.status,
    productType: product.productType ?? '',
    basePrice: product.basePrice != null ? Number(product.basePrice) : null,
    costPrice: product.costPrice != null ? Number(product.costPrice) : null,
    totalStock: product.totalStock,
    ean: product.ean ?? '',
    upc: product.upc ?? '',
    gtin: product.gtin ?? '',
    weightValue: product.weightValue != null ? Number(product.weightValue) : null,
    weightUnit: product.weightUnit ?? '',
    dimLength: product.dimLength != null ? Number(product.dimLength) : null,
    dimWidth: product.dimWidth != null ? Number(product.dimWidth) : null,
    dimHeight: product.dimHeight != null ? Number(product.dimHeight) : null,
    dimUnit: product.dimUnit ?? '',
    _thumbnailUrl: (product.images as any[])?.[0]?.url ?? null,
    _browseNodeIds: [],
    _ebayCategoryId: null,
  }

  const listings: any[] = product.channelListings ?? []

  // Amazon fields per marketplace
  for (const mp of AMAZON_MARKETS) {
    const cl = listings.find((l: any) => l.channel === 'AMAZON' && l.marketplace === mp)
    const attrs = ((cl?.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
    const bullets: string[] = Array.isArray(attrs.bullet_point)
      ? (attrs.bullet_point as any[]).map((b: any) => b?.value ?? String(b))
      : []
    const prefix = `amazon_${mp}_`
    row[`${prefix}title`]         = cl?.title ?? attrs.item_name?.[0]?.value ?? ''
    row[`${prefix}bullet_1`]      = bullets[0] ?? ''
    row[`${prefix}bullet_2`]      = bullets[1] ?? ''
    row[`${prefix}bullet_3`]      = bullets[2] ?? ''
    row[`${prefix}bullet_4`]      = bullets[3] ?? ''
    row[`${prefix}bullet_5`]      = bullets[4] ?? ''
    row[`${prefix}description`]   = cl?.description ?? attrs.product_description?.[0]?.value ?? ''
    row[`${prefix}keywords`]      = (attrs.generic_keyword?.[0]?.value ?? '') as string
    row[`${prefix}price`]         = cl?.price != null ? Number(cl.price) : null
    row[`${prefix}quantity`]      = cl?.quantity ?? null
    row[`${prefix}asin`]          = cl?.externalListingId ?? ''
    row[`${prefix}listing_status`]= cl?.listingStatus ?? 'DRAFT'
    row[`${prefix}fulfillment`]   = attrs.fulfillment_availability?.[0]?.fulfillment_channel_code ?? 'DEFAULT'
    row[`${prefix}browse_node_id`]= attrs.recommended_browse_nodes?.[0]?.value ?? ''
    if (cl?.externalListingId && !Array.isArray(row._browseNodeIds)) {
      ;(row._browseNodeIds as string[]).push(cl.externalListingId)
    }
  }

  // eBay fields per marketplace
  for (const mp of EBAY_MARKETS) {
    const region = mp === 'UK' ? 'GB' : mp
    const cl = listings.find(
      (l: any) => l.channel === 'EBAY' && (l.region === mp || l.region === region),
    )
    const attrs = (cl?.platformAttributes ?? {}) as Record<string, any>
    const prefix = `ebay_${mp}_`
    row[`${prefix}title`]          = cl?.title ?? ''
    row[`${prefix}price`]          = cl?.price != null ? Number(cl.price) : null
    row[`${prefix}quantity`]       = cl?.quantity ?? null
    row[`${prefix}item_id`]        = cl?.externalListingId ?? ''
    row[`${prefix}listing_status`] = cl?.listingStatus ?? 'DRAFT'
    row[`${prefix}condition`]      = (attrs.conditionId as string | undefined) ?? ''
    row[`${prefix}category_id`]    = (attrs.categoryId as string | undefined) ?? ''
    if (!row._ebayCategoryId && attrs.categoryId) {
      row._ebayCategoryId = attrs.categoryId
    }
  }

  // Shopify fields
  const shopify = listings.find((l: any) => l.channel === 'SHOPIFY')
  const shopifyAttrs = (shopify?.platformAttributes ?? {}) as Record<string, any>
  row.shopify_handle    = (shopifyAttrs.handle as string | undefined) ?? ''
  row.shopify_price     = shopify?.price != null ? Number(shopify.price) : null
  row.shopify_compare   = shopify?.salePrice != null ? Number(shopify.salePrice) : null
  row.shopify_inventory = shopify?.quantity ?? null
  row.shopify_status    = shopify?.listingStatus ?? 'DRAFT'

  return row
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const flatFileUnifiedRoutes: FastifyPluginAsync = async (fastify) => {
  // ══════════════════════════════════════════════════════════════════
  // GET /api/flat-file/unified-template
  // ══════════════════════════════════════════════════════════════════
  fastify.get('/flat-file/unified-template', async (_request, reply) => {
    const groups = [
      buildMasterGroup(),
      ...AMAZON_MARKETS.map(buildAmazonGroup),
      ...EBAY_MARKETS.map(buildEbayGroup),
      buildShopifyGroup(),
    ]
    return reply.send({ groups })
  })

  // ══════════════════════════════════════════════════════════════════
  // GET /api/flat-file/unified-rows
  // ══════════════════════════════════════════════════════════════════
  fastify.get<{
    Querystring: {
      productIds?: string
      search?: string
      productTypes?: string
      parentage?: 'any' | 'parent' | 'variant'
      status?: string
      stockLevel?: 'all' | 'out' | 'low' | 'in'
      hasAsin?: 'any' | 'yes' | 'no'
      browseNodeId?: string | string[]
      ebayCategory?: string
      cursor?: string
      limit?: string
    }
  }>('/flat-file/unified-rows', async (request, reply) => {
    const q = request.query
    const limit = Math.min(parseInt(q.limit ?? '400', 10), 1000)

    // Build Prisma where clause
    const where: Record<string, any> = { deletedAt: null }

    // productIds deep-link
    if (q.productIds) {
      const ids = q.productIds.split(',').map((s) => s.trim()).filter(Boolean)
      if (ids.length) {
        // Accept both product IDs and SKUs
        where.OR = [{ id: { in: ids } }, { sku: { in: ids } }]
      }
    }

    // Text search
    if (q.search) {
      const term = q.search.trim()
      if (term) {
        where.OR = [
          { sku: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
        ]
      }
    }

    // Product types
    if (q.productTypes) {
      const types = q.productTypes.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      if (types.length) where.productType = { in: types }
    }

    // Parentage
    if (q.parentage === 'parent') where.isParent = true
    if (q.parentage === 'variant') where.parentId = { not: null }

    // Status
    if (q.status) {
      const statuses = q.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      if (statuses.length) where.status = { in: statuses }
    }

    // Stock level
    if (q.stockLevel === 'out') where.totalStock = 0
    if (q.stockLevel === 'low') where.totalStock = { gt: 0, lte: 10 }
    if (q.stockLevel === 'in')  where.totalStock = { gt: 0 }

    // Has ASIN
    if (q.hasAsin === 'yes') where.amazonAsin = { not: null }
    if (q.hasAsin === 'no')  where.amazonAsin = null

    // Cursor pagination (keyset on updatedAt + id)
    if (q.cursor) {
      try {
        const [ts, id] = Buffer.from(q.cursor, 'base64').toString().split('|')
        where.AND = [
          ...(where.AND ?? []),
          {
            OR: [
              { updatedAt: { lt: new Date(ts) } },
              { updatedAt: new Date(ts), id: { lt: id } },
            ],
          },
        ]
      } catch {}
    }

    try {
      const products = await prisma.product.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true, sku: true, name: true, brand: true, status: true,
          productType: true, basePrice: true, costPrice: true, totalStock: true,
          ean: true, upc: true, gtin: true, weightValue: true, weightUnit: true,
          dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
          isParent: true, parentId: true, amazonAsin: true, updatedAt: true,
          images: { where: { type: 'MAIN' }, select: { url: true }, take: 1 },
          channelListings: {
            select: {
              channel: true, region: true, marketplace: true,
              title: true, description: true, price: true, salePrice: true,
              quantity: true, externalListingId: true, listingStatus: true,
              platformAttributes: true,
            },
          },
          children: {
            where: { deletedAt: null },
            orderBy: { sku: 'asc' },
            select: {
              id: true, sku: true, name: true, brand: true, status: true,
              productType: true, basePrice: true, costPrice: true, totalStock: true,
              ean: true, upc: true, gtin: true, weightValue: true, weightUnit: true,
              dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
              isParent: true, parentId: true, amazonAsin: true, updatedAt: true,
              images: { where: { type: 'MAIN' }, select: { url: true }, take: 1 },
              channelListings: {
                select: {
                  channel: true, region: true, marketplace: true,
                  title: true, description: true, price: true, salePrice: true,
                  quantity: true, externalListingId: true, listingStatus: true,
                  platformAttributes: true,
                },
              },
            },
          },
        },
      })

      const hasMore = products.length > limit
      const page = hasMore ? products.slice(0, limit) : products

      // Build flat rows: parents first, then their children interleaved
      const rows: Record<string, unknown>[] = []
      for (const p of page) {
        rows.push(shapeUnifiedRow(p, p.isParent || (p.children as any[]).length > 0, p.parentId))
        for (const child of (p.children as any[]) ?? []) {
          rows.push(shapeUnifiedRow(child, false, p.id))
        }
      }

      // Cursor for next page
      let nextCursor: string | null = null
      if (hasMore) {
        const last = page[page.length - 1]
        nextCursor = Buffer.from(
          `${last.updatedAt.toISOString()}|${last.id}`,
        ).toString('base64')
      }

      return reply.send({ rows, nextCursor, total: rows.length })
    } catch (err: any) {
      fastify.log.error({ err }, '[GET /flat-file/unified-rows] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // GET /api/products/browse-nodes/facets
  // ══════════════════════════════════════════════════════════════════
  fastify.get('/products/browse-nodes/facets', async (_request, reply) => {
    try {
      // Aggregate browse node IDs from Amazon channel listing platformAttributes
      const listings = await prisma.channelListing.findMany({
        where: { channel: 'AMAZON', platformAttributes: { not: null } },
        select: { platformAttributes: true, product: { select: { name: true } } },
        take: 5000,
      })

      const counts = new Map<string, { label: string; count: number }>()
      for (const listing of listings) {
        const attrs = ((listing.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
        const nodeId = attrs.recommended_browse_nodes?.[0]?.value as string | undefined
        if (!nodeId) continue
        const existing = counts.get(nodeId)
        if (existing) existing.count++
        else counts.set(nodeId, { label: nodeId, count: 1 })
      }

      const facets = Array.from(counts.entries())
        .map(([browseNodeId, { label, count }]) => ({ browseNodeId, label, count }))
        .sort((a, b) => b.count - a.count)

      return reply.send(facets)
    } catch (err: any) {
      fastify.log.error({ err }, '[GET /products/browse-nodes/facets] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // PATCH /api/flat-file/unified-rows
  // ══════════════════════════════════════════════════════════════════
  fastify.patch<{
    Body: {
      changes: Array<{
        rowId: string // product ID
        colId: string // e.g. 'name', 'amazon_IT_title', 'ebay_UK_price', 'shopify_price'
        value: unknown
      }>
    }
  }>('/flat-file/unified-rows', async (request, reply) => {
    const { changes } = request.body
    if (!changes?.length) return reply.send({ saved: 0 })

    // Group changes by rowId
    const byRow = new Map<string, typeof changes>()
    for (const ch of changes) {
      const list = byRow.get(ch.rowId) ?? []
      list.push(ch)
      byRow.set(ch.rowId, list)
    }

    let saved = 0
    const errors: Array<{ rowId: string; error: string }> = []

    await Promise.allSettled(
      Array.from(byRow.entries()).map(async ([rowId, rowChanges]) => {
        const masterUpdates: Record<string, unknown> = {}
        const amazonChanges = new Map<string, Record<string, unknown>>() // mp → fields
        const ebayChanges   = new Map<string, Record<string, unknown>>() // mp → fields
        const shopifyFields: Record<string, unknown> = {}

        for (const { colId, value } of rowChanges) {
          // Amazon: amazon_IT_title → mp=IT, field=title
          const amazonMatch = colId.match(/^amazon_([A-Z]{2,3})_(.+)$/)
          if (amazonMatch) {
            const mp = amazonMatch[1]
            const field = amazonMatch[2]
            const cur = amazonChanges.get(mp) ?? {}
            cur[field] = value
            amazonChanges.set(mp, cur)
            continue
          }

          // eBay: ebay_IT_price → mp=IT, field=price
          const ebayMatch = colId.match(/^ebay_([A-Z]{2,3})_(.+)$/)
          if (ebayMatch) {
            const mp = ebayMatch[1]
            const field = ebayMatch[2]
            const cur = ebayChanges.get(mp) ?? {}
            cur[field] = value
            ebayChanges.set(mp, cur)
            continue
          }

          // Shopify: shopify_price → field=price
          if (colId.startsWith('shopify_')) {
            shopifyFields[colId.replace('shopify_', '')] = value
            continue
          }

          // Master field
          masterUpdates[colId] = value
        }

        try {
          // Save master fields
          if (Object.keys(masterUpdates).length) {
            const allowedMaster = new Set([
              'name', 'brand', 'status', 'productType', 'basePrice', 'costPrice',
              'totalStock', 'ean', 'upc', 'gtin', 'weightValue', 'weightUnit',
              'dimLength', 'dimWidth', 'dimHeight', 'dimUnit',
            ])
            const safeUpdates: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(masterUpdates)) {
              if (allowedMaster.has(k)) safeUpdates[k] = v
            }
            if (Object.keys(safeUpdates).length) {
              await prisma.product.update({ where: { id: rowId }, data: safeUpdates as any })
            }
          }

          // Save Amazon channel listings
          for (const [mp, fields] of amazonChanges.entries()) {
            const updateData: Record<string, unknown> = {}
            if ('title' in fields) updateData.title = fields.title
            if ('description' in fields) updateData.description = fields.description
            if ('price' in fields) updateData.price = fields.price
            if ('quantity' in fields) updateData.quantity = Number(fields.quantity)
            if ('listing_status' in fields) updateData.listingStatus = fields.listing_status

            // Bullets + other attrs go into platformAttributes.attributes
            const bulletKeys = ['bullet_1','bullet_2','bullet_3','bullet_4','bullet_5']
            const hasBullets = bulletKeys.some((k) => k in fields)
            if (hasBullets || 'keywords' in fields || 'browse_node_id' in fields || 'fulfillment' in fields) {
              const existing = await prisma.channelListing.findFirst({
                where: { productId: rowId, channel: 'AMAZON', marketplace: mp },
                select: { platformAttributes: true },
              })
              const attrs = ((existing?.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
              if (hasBullets) {
                attrs.bullet_point = bulletKeys
                  .map((k) => fields[k] as string ?? attrs.bullet_point?.[bulletKeys.indexOf(k)]?.value ?? '')
                  .filter(Boolean)
                  .map((v) => ({ value: v }))
              }
              if ('keywords' in fields) attrs.generic_keyword = [{ value: fields.keywords }]
              if ('browse_node_id' in fields) attrs.recommended_browse_nodes = [{ value: fields.browse_node_id }]
              if ('fulfillment' in fields) {
                attrs.fulfillment_availability = [{ fulfillment_channel_code: fields.fulfillment }]
              }
              updateData.platformAttributes = { attributes: attrs }
            }

            if (Object.keys(updateData).length) {
              await prisma.channelListing.upsert({
                where: {
                  productId_channel_marketplace: { productId: rowId, channel: 'AMAZON', marketplace: mp },
                } as any,
                create: {
                  productId: rowId, channel: 'AMAZON', region: mp,
                  marketplace: mp, channelMarket: `AMAZON_${mp}`,
                  listingStatus: 'DRAFT',
                  ...updateData,
                } as any,
                update: updateData as any,
              })
            }
          }

          // Save eBay channel listings
          for (const [mp, fields] of ebayChanges.entries()) {
            const region = mp === 'UK' ? 'GB' : mp
            const updateData: Record<string, unknown> = {}
            if ('title' in fields) updateData.title = fields.title
            if ('price' in fields) updateData.price = fields.price
            if ('quantity' in fields) updateData.quantity = Number(fields.quantity)

            const attrsToUpdate: Record<string, unknown> = {}
            if ('condition' in fields) attrsToUpdate.conditionId = fields.condition
            if ('category_id' in fields) attrsToUpdate.categoryId = fields.category_id
            if (Object.keys(attrsToUpdate).length) {
              const existing = await prisma.channelListing.findFirst({
                where: { productId: rowId, channel: 'EBAY', region },
                select: { platformAttributes: true },
              })
              updateData.platformAttributes = {
                ...((existing?.platformAttributes as object) ?? {}),
                ...attrsToUpdate,
              }
            }

            if (Object.keys(updateData).length) {
              const channelMarket = mp === 'UK' ? 'EBAY_GB' : `EBAY_${mp}`
              await prisma.channelListing.upsert({
                where: {
                  productId_channel_marketplace: { productId: rowId, channel: 'EBAY', marketplace: region },
                } as any,
                create: {
                  productId: rowId, channel: 'EBAY', region, marketplace: region,
                  channelMarket, listingStatus: 'DRAFT',
                  ...updateData,
                } as any,
                update: updateData as any,
              })
            }
          }

          // Save Shopify listing
          if (Object.keys(shopifyFields).length) {
            const shopifyData: Record<string, unknown> = {}
            if ('price' in shopifyFields) shopifyData.price = shopifyFields.price
            if ('compare' in shopifyFields) shopifyData.salePrice = shopifyFields.compare
            if ('inventory' in shopifyFields) shopifyData.quantity = Number(shopifyFields.inventory)

            if (Object.keys(shopifyData).length) {
              await prisma.channelListing.upsert({
                where: {
                  productId_channel_marketplace: { productId: rowId, channel: 'SHOPIFY', marketplace: 'GLOBAL' },
                } as any,
                create: {
                  productId: rowId, channel: 'SHOPIFY', region: 'GLOBAL',
                  marketplace: 'GLOBAL', channelMarket: 'SHOPIFY',
                  listingStatus: 'DRAFT',
                  ...shopifyData,
                } as any,
                update: shopifyData as any,
              })
            }
          }

          saved++
        } catch (err: any) {
          errors.push({ rowId, error: err?.message ?? String(err) })
        }
      }),
    )

    return reply.send({ saved, errors: errors.length ? errors : undefined })
  })
}

export default flatFileUnifiedRoutes
