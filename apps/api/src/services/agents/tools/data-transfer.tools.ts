/**
 * MCP full control (09 §4, decision P-3) — `export-rows`: catalog rows into the conversation, read only.
 *
 * Catalog only — products, listings, prices, stock — and at most 500 rows a page. Orders and customers are never
 * exported here: their exports stay a download in Nexus (P-3). Deleted products are never rows.
 *
 * Money. Each row is a record (a key per column), not a CSV string, so the door's money filter (call-tool.ts
 * `visibleTo`) removes every money column a person may not see — the cost price, for one — from every row, at any
 * depth. A CSV text could not be filtered after it was written; Claude lays the rows out as a table or CSV itself.
 *
 * MCP full control P9 (Owner, choice A, 2026-10-02) — the import half:
 *   · `import-catalog` imports a small file (≤ 500 rows, ≤ 512 KB; CSV text or a public https link fetched through
 *     safeFetch) through the SAME catalog import a person runs: the dry run plans it with the wizard's own functions,
 *     and after approval the wizard reviews the file again and applies it only when its review writes exactly what
 *     was approved. Its checks, matching and messages are the wizard's (catalog-import-golden.vitest.test.ts).
 *   · `rollback-bulk-operation` undoes a finished bulk job (Nexus's bulk rollback) or a catalog import (a re-import of
 *     the values its records replaced — their "before" record, pim/catalog-transfer-before.ts). Refused when a value
 *     changed since the job wrote it. It is also the undo `import-catalog` asks for.
 * Both reach the import wizard and the bulk services through data-transfer-runner.ts, loaded inside the handlers only:
 * importing the registry pulls in no channel or auth service.
 *
 * Pages follow the SKU order (then channel, market, id for listings) with a keyset cursor bound to the tool, the
 * business and the filters (lib/pagination/cursor.ts).
 */

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { likeEscaped } from '../../../lib/like-pattern.js'
import {
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  cursorScope,
  decodeCursor,
  encodeCursor,
  fitPage,
  type CursorPosition,
} from '../../../lib/pagination/cursor.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import type { ImportArgs } from './data-transfer-runner.js'

const ENTITIES = ['products', 'listings', 'prices', 'stock'] as const
type Entity = (typeof ENTITIES)[number]
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
const MAX_ROWS = 500
const DEFAULT_ROWS = 100
/** A page of up to 500 rows is bigger than a list page: held under this many bytes, the rest on the next page. */
const MAX_EXPORT_BYTES = 250_000
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const num = (value: Prisma.Decimal | null | undefined) => (value == null ? null : Number(value))
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

interface Args {
  entity: Entity
  sku?: string
  brand?: string
  productType?: string
  status?: string
  channel?: string
  market?: string
  limit?: number
  cursor?: string
}

/** The products a filter names: never a deleted one; a SKU prefix also matches its variants. */
function productWhere(args: Args): Prisma.ProductWhereInput {
  return {
    deletedAt: null,
    ...(args.sku ? { sku: { startsWith: likeEscaped(args.sku), mode: 'insensitive' } } : {}),
    ...(args.brand ? { brand: { equals: args.brand, mode: 'insensitive' } } : {}),
    ...(args.productType ? { productType: { equals: args.productType, mode: 'insensitive' } } : {}),
    ...(args.status ? { status: args.status } : {}),
  }
}

/** Products strictly after the cursor's (sku, id). */
function productsAfter(position: CursorPosition | null): Prisma.ProductWhereInput {
  if (!position) return {}
  const [sku] = position.values
  if (typeof sku !== 'string') throw new InvalidCursorError()
  return { OR: [{ sku: { gt: sku } }, { sku, id: { gt: position.id } }] }
}

/** Listings strictly after the cursor's (sku, channel, market, id). */
function listingsAfter(position: CursorPosition | null): Prisma.ChannelListingWhereInput {
  if (!position) return {}
  const [sku, channel, marketplace] = position.values
  if (typeof sku !== 'string' || typeof channel !== 'string' || typeof marketplace !== 'string') throw new InvalidCursorError()
  return {
    OR: [
      { product: { sku: { gt: sku } } },
      { product: { sku }, channel: { gt: channel } },
      { product: { sku }, channel, marketplace: { gt: marketplace } },
      { product: { sku }, channel, marketplace, id: { gt: position.id } },
    ],
  }
}

type Row = Record<string, unknown> & { _position: CursorPosition }

async function productRows(entity: Exclude<Entity, 'listings'>, args: Args, position: CursorPosition | null, take: number): Promise<Row[]> {
  const products = await prisma.product.findMany({
    where: { AND: [productWhere(args), productsAfter(position)] },
    orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true, sku: true, name: true, brand: true, productType: true, status: true, isParent: true, parentId: true,
      gtin: true, ean: true, upc: true, basePrice: true, minPrice: true, maxPrice: true, costPrice: true,
      totalStock: true, lowStockThreshold: true, fulfillmentMethod: true, weightValue: true, weightUnit: true,
      updatedAt: true,
      ...(entity === 'prices'
        ? { channelListings: { select: { channel: true, marketplace: true, price: true, salePrice: true }, orderBy: [{ channel: 'asc' as const }, { marketplace: 'asc' as const }], take: 20 } }
        : {}),
    },
  })
  const parentSkus = new Map<string, string>()
  const parentIds = [...new Set(products.map((p) => p.parentId).filter((id): id is string => !!id))]
  if (parentIds.length) {
    for (const parent of await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true } })) parentSkus.set(parent.id, parent.sku)
  }
  return products.map((p) => {
    const base = { _position: { values: [p.sku], id: p.id }, productId: p.id, sku: p.sku }
    if (entity === 'stock') {
      return { ...base, name: p.name, totalStock: p.totalStock, lowStockThreshold: p.lowStockThreshold, fulfillmentMethod: p.fulfillmentMethod, status: p.status }
    }
    if (entity === 'prices') {
      return {
        ...base,
        name: p.name,
        basePrice: num(p.basePrice),
        minPrice: num(p.minPrice),
        maxPrice: num(p.maxPrice),
        // A money column: the door removes it for a person who may not see costs.
        costPrice: num(p.costPrice),
        listingPrices: ((p as unknown as { channelListings?: Array<{ channel: string; marketplace: string; price: Prisma.Decimal | null; salePrice: Prisma.Decimal | null }> }).channelListings ?? [])
          .map((l) => ({ channel: l.channel, market: l.marketplace, price: num(l.price), salePrice: num(l.salePrice) })),
      }
    }
    return {
      ...base,
      name: p.name,
      brand: p.brand,
      productType: p.productType,
      status: p.status,
      isParent: p.isParent,
      parentSku: p.parentId ? parentSkus.get(p.parentId) ?? null : null,
      gtin: p.gtin ?? p.ean ?? p.upc ?? null,
      basePrice: num(p.basePrice),
      costPrice: num(p.costPrice),
      totalStock: p.totalStock,
      weight: p.weightValue != null ? `${Number(p.weightValue)} ${p.weightUnit ?? ''}`.trim() : null,
      updatedAt: iso(p.updatedAt),
    }
  })
}

async function listingRows(args: Args, position: CursorPosition | null, take: number): Promise<Row[]> {
  const listings = await prisma.channelListing.findMany({
    where: {
      AND: [
        { product: productWhere(args) },
        args.channel ? { channel: args.channel } : {},
        args.market ? { marketplace: args.market } : {},
        listingsAfter(position),
      ],
    },
    orderBy: [{ product: { sku: 'asc' } }, { channel: 'asc' }, { marketplace: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true, channel: true, marketplace: true, title: true, price: true, salePrice: true, quantity: true,
      listingStatus: true, isPublished: true, syncPaused: true, offerClosedAt: true, externalListingId: true,
      lastSyncedAt: true, lastSyncStatus: true, product: { select: { id: true, sku: true } },
    },
  })
  return listings.map((l) => ({
    _position: { values: [l.product.sku, l.channel, l.marketplace], id: l.id },
    listingId: l.id,
    productId: l.product.id,
    sku: l.product.sku,
    channel: l.channel,
    market: l.marketplace,
    title: l.title,
    price: num(l.price),
    salePrice: num(l.salePrice),
    quantity: l.quantity,
    status: l.listingStatus,
    published: l.isPublished,
    syncPaused: l.syncPaused,
    closed: !!l.offerClosedAt,
    channelItemId: l.externalListingId,
    lastSyncedAt: iso(l.lastSyncedAt),
    lastSyncStatus: l.lastSyncStatus,
  }))
}

const exportRows: AgentTool = {
  name: 'export-rows',
  title: 'Export catalog rows',
  category: 'catalog',
  description:
    'Catalog rows of this business for a table or a CSV you lay out: entity=products (identity, master price, '
    + 'stock), listings (one row per channel listing: title, price, quantity, status, channel item id), prices '
    + '(master price, floor and ceiling, each listing\'s price) or stock (totals per product). At most 500 rows a page '
    + '(default 100), in SKU order; filter by SKU prefix, brand, product type, status, and for listings channel and '
    + 'market; follow nextCursor for more. Money columns a person may not see (the cost price) are left out. Orders '
    + 'and customers are not exported here. Read only.',
  input: z.object({
    entity: z.enum(ENTITIES).describe('which rows: products, listings, prices or stock'),
    sku: z.string().trim().min(1).max(100).optional().describe('only SKUs starting with this (a parent SKU also matches its variants)'),
    brand: z.string().trim().min(1).max(120).optional().describe('only this brand'),
    productType: z.string().trim().min(1).max(120).optional().describe('only this product type'),
    status: z.preprocess(upper, z.enum(['ACTIVE', 'DRAFT', 'INACTIVE'])).optional().describe('only products in this status'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('listings only: this channel'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('listings only: this marketplace code, e.g. IT'),
    limit: z.coerce.number().int().min(1).max(MAX_ROWS).optional().describe(`rows per page (default ${DEFAULT_ROWS}, at most ${MAX_ROWS})`),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional().describe('nextCursor from the previous page, with the same filters'),
  }),
  requires: [F.productsExport],
  riskTier: 'low',
  readOnly: true,
  async handler(raw): Promise<ToolResult> {
    const args = raw as unknown as Args
    const { limit: _limit, cursor: _cursor, ...filters } = raw
    const scope = cursorScope('export-rows', { business: workspaceIdForQuery(), ...filters })
    try {
      const position = decodeCursor(scope, args.cursor)
      const size = args.limit ?? DEFAULT_ROWS
      const rows = args.entity === 'listings'
        ? await listingRows(args, position, size + 1)
        : await productRows(args.entity, args, position, size + 1)
      const more = rows.length > size
      const shown = rows.slice(0, size)
      const page = fitPage(
        { items: shown, nextCursor: more ? encodeCursor(scope, shown[shown.length - 1]._position) : null },
        scope,
        (row) => row._position,
        MAX_EXPORT_BYTES,
      )
      return {
        ok: true,
        data: {
          entity: args.entity,
          rows: page.items.map(({ _position, ...row }) => row),
          nextCursor: page.nextCursor,
          ...(page.nextCursor
            ? { hint: `More rows match${page.cut ? ` (this page was cut by ${page.cut} to stay within the size limit)` : ''}: call again with cursor set to nextCursor and the same filters.` }
            : {}),
        },
      }
    } catch (error) {
      if (error instanceof InvalidCursorError) return { ok: false, error: `export-rows was called wrongly — cursor: ${error.message}` }
      throw error
    }
  },
}

// ── import-catalog and rollback-bulk-operation (P9) ──────────────────────────────────────────────────

/** The wizard and the bulk services, loaded only when a handler runs (they reach channel and auth services). */
const runner = () => import('./data-transfer-runner.js')

/** 09 §4 — Claude imports at most this much text at once (the runner checks the bytes; this bounds the characters). */
const MAX_TEXT = 512 * 1024

const sourceValue = z.union([
  z.object({ column: z.string().trim().min(1).max(250).describe('take it from this column of the file') }),
  z.object({ value: z.string().max(250).describe('the same value for every row') }),
])
const importBinding = z.object({
  source: z.string().trim().min(1).max(250).describe('the file column'),
  entity: z.enum(['Products', 'Listings', 'Overrides'])
    .describe('Products = the shared product; Listings = a channel listing\'s own fields; Overrides = a listing\'s value for a channel field'),
  field: z.string().trim().min(1).max(250).describe('the Nexus field (e.g. name, description, family) or the channel field key (e.g. item_name)'),
  format: z.enum(['text', 'json']).default('text').describe('text (default) or json (a list or an object in the cell)'),
  action: z.enum(['SET', 'CLEAR', 'INHERIT']).optional().describe('what a filled cell does (default SET; a blank cell leaves the value as it is)'),
  actionColumn: z.string().trim().min(1).max(250).optional().describe('or a file column that says SET, CLEAR or INHERIT per row'),
  versionColumn: z.string().trim().min(1).max(250).optional().describe('a file column holding the record version an export wrote (refused when it moved)'),
  channel: sourceValue.optional().describe('Listings and Overrides: the channel, e.g. {"value":"AMAZON"}'),
  accountId: sourceValue.optional().describe('Listings and Overrides: the channel account id (channel-connections lists them)'),
  marketplace: sourceValue.optional().describe('Listings and Overrides: the marketplace code, e.g. {"value":"IT"}'),
  aliasKey: sourceValue.optional().describe('a listing alias, when the product has several listings on one account'),
  locale: sourceValue.optional().describe('the language of a translated field, e.g. {"value":"de"}'),
})
const importMapping = z.object({
  skuColumn: z.string().trim().min(1).max(250).describe('the file column holding the SKU: rows are matched by SKU only'),
  market: z.string().trim().toUpperCase().regex(/^(?:[A-Z]{2}|GLOBAL)$/).describe('the marketplace whose attribute dictionary applies, e.g. IT'),
  mode: z.enum(['update', 'upsert', 'create']).describe('update = existing SKUs only; upsert = update and create; create = new SKUs only'),
  policy: z.object({
    shared: z.enum(['replace', 'fill-empty', 'exclude']).default('replace').describe('product values: replace, fill only empty ones, or leave alone'),
    overrides: z.enum(['replace', 'preserve', 'exclude']).default('replace').describe('listing values: replace, keep existing ones, or leave alone'),
  }).default({ shared: 'replace', overrides: 'replace' }).describe('what the file may overwrite (default: replace both)'),
  bindings: z.array(importBinding).min(1).max(200).describe('one entry per imported column'),
})

const IMPORT_CATALOG_UNDO: ToolUndo = {
  // What still reads as the import wrote it: the import's values that moved since (none = the undo may run).
  current: async (change) => {
    const jobId = String((change.after as { jobId?: unknown } | null)?.jobId ?? '')
    return { jobId, changedSince: await (await runner()).importChangedSince(jobId) }
  },
  request: (change) => {
    const jobId = (change.after as { jobId?: unknown } | null)?.jobId
    return typeof jobId === 'string' && jobId
      ? { tool: 'rollback-bulk-operation', args: { jobId } }
      : { refusal: 'This import kept no job id, so it cannot be undone here.' }
  },
}

const importCatalog: AgentTool = {
  name: 'import-catalog',
  title: 'Import catalog rows',
  category: 'catalog',
  description:
    'Import a small catalog file into this business through Nexus\'s catalog import, the same review a person runs in '
    + 'Products › Import. Give the file as CSV text or a public https link (at most 500 rows and 512 KB) and how its columns '
    + 'map to Nexus fields (or a saved mapping). Rows are matched by SKU only: update changes existing products and '
    + 'listings, upsert also creates. The preview shows the counts, the first changed values (before → after) and refuses '
    + 'a file Nexus would refuse, with its reasons. Nothing changes until a person approves it in Nexus; Nexus then reviews '
    + 'the file again and applies it only if its review writes exactly what was approved. Undo re-imports the values it '
    + 'replaced; products and listings it created stay.',
  input: z.object({
    text: z.string().min(1).max(MAX_TEXT).optional().describe('the file as CSV text, header row first (at most 512 KB and 500 rows)'),
    url: z.string().trim().min(1).max(2048).optional()
      .describe('or a public https link to the file (CSV, XLSX or JSON; at most 512 KB and 500 rows); private and local addresses are refused'),
    mapping: importMapping.optional().describe('how the file\'s columns map to Nexus fields'),
    savedMappingId: z.string().trim().min(1).max(64).optional().describe('or the id of a mapping saved in Nexus (Products › Import), instead of mapping'),
  }),
  requires: [F.productsImport],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // It reads the web (a link), and the listings it changes sync to their channels.
  openWorld: true,
  // Values come back; products and listings it created, and what channels were sent meanwhile, do not.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: IMPORT_CATALOG_UNDO,
  handler: async (args, ctx) => (await runner()).importCatalogDryRun(args as ImportArgs, ctx),
  execute: async (args, ctx) => (await runner()).importCatalogExecute(args as ImportArgs, ctx),
}

const rollbackBulkOperation: AgentTool = {
  name: 'rollback-bulk-operation',
  title: 'Undo a bulk job or an import',
  category: 'catalog',
  description:
    'Undo a finished bulk job or catalog import of this business. A bulk price, stock, status or attribute job goes back to '
    + 'the values it replaced, through Nexus\'s bulk rollback. An import is undone by re-importing the values its records '
    + 'replaced, through Nexus\'s catalog import; products and listings it created stay. Refused when a value changed since '
    + 'the job wrote it (undo would overwrite that later change), and for an import Nexus kept no record of. The preview '
    + 'shows what goes back. Nothing changes until a person approves it in Nexus; the values then reach the channels like '
    + 'any edit.',
  input: z.object({
    jobId: z.string().trim().min(1).max(64)
      .describe('the bulk job or import to undo: its id from job-history (kind bulk or transfer), or the jobId import-catalog answered'),
  }),
  requires: [F.bulkRollback],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // It is itself the undo: what it puts back stands (an import's undo can be undone as an import of its own).
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  handler: async (args, ctx) => (await runner()).rollbackDryRun(String(args.jobId), ctx),
  execute: async (args, ctx) => (await runner()).rollbackExecute(String(args.jobId), ctx),
}

export const DATA_TRANSFER_TOOLS: AgentTool[] = [exportRows, importCatalog, rollbackBulkOperation]
