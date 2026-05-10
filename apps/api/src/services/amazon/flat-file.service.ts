/**
 * Amazon Flat-File Spreadsheet Service
 *
 * Converts Amazon's productTypeDefinitions schema into a flat-file
 * column manifest (the same structure sellers see in the Seller Central
 * Excel templates), then serialises rows back to the JSON_LISTINGS_FEED
 * format for Feeds API submission.
 *
 * Groups mirror Amazon's official flat file section order:
 *   Identity → Variation → Content → Pricing & Inventory →
 *   Identifiers → Schema Attributes (dynamic per productType)
 */

import type { PrismaClient } from '@nexus/database'
import { CategorySchemaService } from '../categories/schema-sync.service.js'

// ── Constants ──────────────────────────────────────────────────────────

export const MARKETPLACE_ID_MAP: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

export const LANGUAGE_TAG_MAP: Record<string, string> = {
  IT: 'it_IT',
  DE: 'de_DE',
  FR: 'fr_FR',
  ES: 'es_ES',
  UK: 'en_GB',
}

export const CURRENCY_MAP: Record<string, string> = {
  IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP',
}

// ── Types ──────────────────────────────────────────────────────────────

export type FlatFileColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean'

export interface FlatFileColumn {
  id: string
  label: string
  description?: string
  required: boolean
  kind: FlatFileColumnKind
  options?: string[]
  maxLength?: number
  width: number
  examples?: string[]
}

export interface FlatFileColumnGroup {
  id: string
  label: string
  color: string   // tailwind colour class prefix for the group band
  columns: FlatFileColumn[]
}

export interface FlatFileManifest {
  marketplace: string
  productType: string
  variationThemes: string[]
  fetchedAt: string
  groups: FlatFileColumnGroup[]
}

export interface FlatFileRow {
  // Row metadata (underscore-prefixed so they don't collide with Amazon cols)
  _rowId: string
  _isNew?: boolean
  _productId?: string
  _dirty?: boolean
  _status?: 'idle' | 'pending' | 'success' | 'error'
  _feedMessage?: string

  // Fixed columns
  update_delete: string
  item_sku: string
  feed_product_type: string
  parent_child: string
  parent_sku: string
  relationship_type: string
  variation_theme: string
  item_name: string
  product_description: string
  bullet_point1: string
  bullet_point2: string
  bullet_point3: string
  bullet_point4: string
  bullet_point5: string
  generic_keyword: string
  standard_price: string
  currency_code: string
  quantity: string
  external_product_id: string
  external_product_id_type: string

  // Dynamic schema columns
  [key: string]: unknown
}

// ── Column IDs that live in fixed groups; exclude from schema group ────

const FIXED_COL_IDS = new Set([
  'item_name', 'product_description', 'bullet_point',
  'generic_keyword', 'standard_price', 'quantity',
  'item_sku', 'external_product_id', 'external_product_id_type',
  'parent_sku', 'relationship_type', 'variation_theme', 'parent_child',
])

// ── Fixed group definitions ────────────────────────────────────────────

function identityGroup(): FlatFileColumnGroup {
  return {
    id: 'identity',
    label: 'Identity',
    color: 'blue',
    columns: [
      { id: 'update_delete', label: 'Operation', kind: 'enum', required: true, width: 120,
        options: ['Update', 'PartialUpdate', 'Delete'],
        description: 'Update = full replace; PartialUpdate = merge; Delete = remove listing' },
      { id: 'item_sku', label: 'Seller SKU', kind: 'text', required: true, width: 180,
        description: 'Your unique identifier. Must match exactly on Amazon.' },
      { id: 'feed_product_type', label: 'Product Type', kind: 'text', required: true, width: 140,
        description: 'Amazon product type code (e.g. OUTERWEAR)' },
    ],
  }
}

function variationGroup(variationThemes: string[]): FlatFileColumnGroup {
  return {
    id: 'variation',
    label: 'Variation',
    color: 'purple',
    columns: [
      { id: 'parent_child', label: 'Parent/Child', kind: 'enum', required: false, width: 110,
        options: ['', 'Parent', 'Child'],
        description: 'Leave blank for standalone. "Parent" for variation parent (not buyable). "Child" for variant.' },
      { id: 'parent_sku', label: 'Parent SKU', kind: 'text', required: false, width: 170,
        description: 'Required when Parent/Child = Child' },
      { id: 'relationship_type', label: 'Relationship', kind: 'enum', required: false, width: 120,
        options: ['', 'Variation'],
        description: 'Required when Parent/Child = Child' },
      { id: 'variation_theme', label: 'Variation Theme', kind: 'enum', required: false, width: 160,
        options: ['', ...variationThemes],
        description: 'e.g. SizeColor — required on Parent rows' },
    ],
  }
}

function contentGroup(): FlatFileColumnGroup {
  return {
    id: 'content',
    label: 'Content',
    color: 'emerald',
    columns: [
      { id: 'item_name', label: 'Title', kind: 'text', required: true, width: 300, maxLength: 200,
        description: 'Product title shown on Amazon.' },
      { id: 'product_description', label: 'Description', kind: 'longtext', required: false, width: 260,
        description: 'Full HTML or plain-text product description.' },
      { id: 'bullet_point1', label: 'Bullet 1', kind: 'text', required: false, width: 220, maxLength: 255 },
      { id: 'bullet_point2', label: 'Bullet 2', kind: 'text', required: false, width: 220, maxLength: 255 },
      { id: 'bullet_point3', label: 'Bullet 3', kind: 'text', required: false, width: 220, maxLength: 255 },
      { id: 'bullet_point4', label: 'Bullet 4', kind: 'text', required: false, width: 220, maxLength: 255 },
      { id: 'bullet_point5', label: 'Bullet 5', kind: 'text', required: false, width: 220, maxLength: 255 },
      { id: 'generic_keyword', label: 'Search Terms', kind: 'text', required: false, width: 220, maxLength: 250,
        description: 'Space-separated backend keywords not visible to customers.' },
    ],
  }
}

function pricingGroup(defaultCurrency: string): FlatFileColumnGroup {
  return {
    id: 'pricing',
    label: 'Pricing & Inventory',
    color: 'amber',
    columns: [
      { id: 'standard_price', label: 'Price', kind: 'number', required: true, width: 100,
        description: 'Regular selling price.' },
      { id: 'currency_code', label: 'Currency', kind: 'enum', required: false, width: 90,
        options: ['EUR', 'GBP', 'USD'],
        description: `Defaults to ${defaultCurrency} for this marketplace.` },
      { id: 'quantity', label: 'Qty', kind: 'number', required: false, width: 75,
        description: 'Available stock. Leave blank for FBA.' },
    ],
  }
}

function identifiersGroup(): FlatFileColumnGroup {
  return {
    id: 'identifiers',
    label: 'Identifiers',
    color: 'slate',
    columns: [
      { id: 'external_product_id', label: 'EAN / UPC / GTIN', kind: 'text', required: false, width: 160,
        description: 'Global Trade Item Number for this variant.' },
      { id: 'external_product_id_type', label: 'ID Type', kind: 'enum', required: false, width: 90,
        options: ['', 'EAN', 'UPC', 'GTIN', 'ISBN'],
        description: 'Type of the external_product_id above.' },
    ],
  }
}

// ── Schema → column mapping ────────────────────────────────────────────

function schemaKindToColKind(kind: string): FlatFileColumnKind | null {
  switch (kind) {
    case 'text':    return 'text'
    case 'longtext': return 'longtext'
    case 'enum':    return 'enum'
    case 'number':  return 'number'
    case 'boolean': return 'enum'
    case 'string_array': return 'text'
    case 'measurement':  return 'text'
    default: return null  // skip json_object + unsupported
  }
}

function parseSchemaProperty(
  fieldId: string,
  prop: Record<string, any>,
  isRequired: boolean,
): FlatFileColumn | null {
  // Unwrap the Amazon "wrapped array" pattern
  const inner = prop?.items?.properties?.value ?? prop
  const kind = determineKind(inner)
  const colKind = schemaKindToColKind(kind)
  if (!colKind) return null

  const label = toTitleCase(fieldId.replace(/_/g, ' '))
  const options: string[] = colKind === 'enum'
    ? (inner?.enum ?? inner?.['x-amazon-attributes']?.validValues ?? []).map(String)
    : colKind === 'boolean' ? ['', 'true', 'false']
    : []

  return {
    id: fieldId,
    label,
    required: isRequired,
    kind: colKind,
    options: options.length > 0 ? options : undefined,
    maxLength: typeof inner?.maxLength === 'number' ? inner.maxLength : undefined,
    width: colKind === 'longtext' ? 240 : colKind === 'enum' && options.length < 5 ? 120 : 160,
    description: inner?.['x-amazon-attributes']?.usageGuidelines
      ?? inner?.description
      ?? undefined,
    examples: Array.isArray(inner?.examples)
      ? inner.examples.slice(0, 3).map(String)
      : undefined,
  }
}

function determineKind(inner: Record<string, any>): string {
  const t = inner?.type
  if (inner?.enum || inner?.['x-amazon-attributes']?.validValues) return 'enum'
  if (t === 'number' || t === 'integer') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'string') {
    if ((inner?.maxLength ?? 0) > 500) return 'longtext'
    return 'text'
  }
  return 'unsupported'
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Main service ───────────────────────────────────────────────────────

export class AmazonFlatFileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly schemas: CategorySchemaService,
  ) {}

  async generateManifest(
    marketplace: string,
    productType: string,
    forceRefresh = false,
  ): Promise<FlatFileManifest> {
    const mp = marketplace.toUpperCase()
    const pt = productType.toUpperCase()

    const cached = forceRefresh
      ? await this.schemas.refreshSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
      : await this.schemas.getSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })

    const def = (cached.schemaDefinition ?? {}) as Record<string, any>
    const properties = (def.properties ?? {}) as Record<string, any>
    const requiredSet = new Set(Array.isArray(def.required) ? def.required : [])

    // Variation themes from schema
    const rawThemes = (cached.variationThemes as any)?.themes ?? []
    const variationThemes: string[] = Array.isArray(rawThemes)
      ? rawThemes.map(String)
      : []

    // Schema attributes group (everything not already in fixed groups)
    const schemaColumns: FlatFileColumn[] = []
    for (const [fieldId, prop] of Object.entries(properties)) {
      if (FIXED_COL_IDS.has(fieldId)) continue
      const col = parseSchemaProperty(fieldId, prop as Record<string, any>, requiredSet.has(fieldId))
      if (col) schemaColumns.push(col)
    }

    // Sort: required first, then alphabetical
    schemaColumns.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      return a.id.localeCompare(b.id)
    })

    const currency = CURRENCY_MAP[mp] ?? 'EUR'

    const groups: FlatFileColumnGroup[] = [
      identityGroup(),
      variationGroup(variationThemes),
      contentGroup(),
      pricingGroup(currency),
      identifiersGroup(),
    ]

    if (schemaColumns.length > 0) {
      groups.push({
        id: 'attributes',
        label: 'Product Attributes',
        color: 'violet',
        columns: schemaColumns,
      })
    }

    return {
      marketplace: mp,
      productType: pt,
      variationThemes,
      fetchedAt: new Date().toISOString(),
      groups,
    }
  }

  // Fetch existing products and their Amazon listings for this marketplace
  // and shape them into FlatFileRow objects.
  async getExistingRows(marketplace: string, productType?: string): Promise<FlatFileRow[]> {
    const mp = marketplace.toUpperCase()

    const where: Record<string, any> = {
      deletedAt: null,
    }
    if (productType) where.productType = productType.toUpperCase()

    const products = await this.prisma.product.findMany({
      where,
      include: {
        channelListings: {
          where: { channel: 'AMAZON', marketplace: mp },
        },
      },
      orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
      take: 2000,
    })

    return products.map((p) => {
      const listing = (p.channelListings as any[])[0]
      const pa = (listing?.platformAttributes as any) ?? {}
      const attrs = (pa.attributes ?? {}) as Record<string, any>
      const currency = CURRENCY_MAP[mp] ?? 'EUR'

      // Extract bullet points from listing or attrs
      const bullets: string[] = Array.isArray(listing?.bulletPointsOverride)
        ? listing.bulletPointsOverride
        : Array.isArray(attrs.bullet_point)
        ? (attrs.bullet_point as any[]).map((b: any) => b?.value ?? String(b))
        : []

      const row: FlatFileRow = {
        _rowId: p.id,
        _productId: p.id,
        _isNew: false,
        _status: 'idle',

        update_delete: 'Update',
        item_sku: p.sku,
        feed_product_type: (p.productType as string | null) ?? productType ?? '',
        parent_child: p.isParent ? 'Parent' : p.parentId ? 'Child' : '',
        parent_sku: (p as any).parentAsin ?? '',
        relationship_type: p.parentId ? 'Variation' : '',
        variation_theme: String(attrs.variation_theme?.[0]?.value ?? ''),

        item_name: listing?.title ?? (attrs.item_name?.[0]?.value ?? p.name),
        product_description: listing?.description ?? (attrs.product_description?.[0]?.value ?? ''),
        bullet_point1: bullets[0] ?? '',
        bullet_point2: bullets[1] ?? '',
        bullet_point3: bullets[2] ?? '',
        bullet_point4: bullets[3] ?? '',
        bullet_point5: bullets[4] ?? '',
        generic_keyword: String(attrs.generic_keyword?.[0]?.value ?? ''),

        standard_price: listing?.price != null ? String(listing.price) : '',
        currency_code: currency,
        quantity: listing?.quantity != null ? String(listing.quantity) : '',

        external_product_id: (p as any).ean ?? (p as any).gtin ?? '',
        external_product_id_type: (p as any).ean ? 'EAN' : (p as any).gtin ? 'GTIN' : '',
      }

      // Copy over any schema attributes already stored
      for (const [k, v] of Object.entries(attrs)) {
        if (FIXED_COL_IDS.has(k) || k in row) continue
        const val = Array.isArray(v) ? (v[0]?.value ?? '') : v
        row[k] = val != null ? String(val) : ''
      }

      return row
    })
  }

  // Build a JSON_LISTINGS_FEED v2 body from flat file rows.
  buildJsonFeedBody(
    rows: FlatFileRow[],
    marketplace: string,
    sellerId: string,
  ): string {
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const languageTag = LANGUAGE_TAG_MAP[mp] ?? 'it_IT'

    const messages = rows
      .filter((r) => r.update_delete !== 'Delete' || r.item_sku)
      .map((row, i) => {
        const operationType = row.update_delete === 'Delete' ? 'DELETE' : 'UPDATE'
        const productType = (row.feed_product_type || '').toUpperCase()

        if (operationType === 'DELETE') {
          return { messageId: i + 1, sku: row.item_sku, operationType, productType, attributes: {} }
        }

        const attrs: Record<string, any> = {}

        function wrap(value: string): Array<{ value: string; marketplace_id: string }> {
          return [{ value, marketplace_id: marketplaceId }]
        }
        function wrapLocale(value: string): Array<{ value: string; language_tag: string; marketplace_id: string }> {
          return [{ value, language_tag: languageTag, marketplace_id: marketplaceId }]
        }

        if (row.item_name) attrs.item_name = wrapLocale(row.item_name)
        if (row.product_description) attrs.product_description = wrapLocale(row.product_description)

        // Bullet points → array
        const bullets = [
          row.bullet_point1, row.bullet_point2, row.bullet_point3,
          row.bullet_point4, row.bullet_point5,
        ].filter(Boolean) as string[]
        if (bullets.length > 0) {
          attrs.bullet_point = bullets.map((b) => ({
            value: b, language_tag: languageTag, marketplace_id: marketplaceId,
          }))
        }

        if (row.generic_keyword) attrs.generic_keyword = [{ value: row.generic_keyword, marketplace_id: marketplaceId }]

        if (row.standard_price) {
          const currency = row.currency_code || CURRENCY_MAP[mp] || 'EUR'
          attrs.purchasable_offer = [{
            currency,
            our_price: [{ schedule: [{ value_with_tax: parseFloat(row.standard_price) }] }],
            marketplace_id: marketplaceId,
          }]
        }

        if (row.quantity) {
          attrs.fulfillment_availability = [{
            fulfillment_channel_code: 'DEFAULT',
            quantity: parseInt(row.quantity, 10),
            marketplace_id: marketplaceId,
          }]
        }

        if (row.external_product_id && row.external_product_id_type) {
          attrs.externally_assigned_product_identifier = [{
            type: row.external_product_id_type.toLowerCase(),
            value: row.external_product_id,
            marketplace_id: marketplaceId,
          }]
        }

        // Variation fields
        if (row.parent_child === 'Parent') {
          if (row.variation_theme) attrs.variation_theme = wrap(row.variation_theme)
        }
        if (row.parent_child === 'Child') {
          if (row.parent_sku) attrs.child_parent_sku_relationship = [{ parent_sku: row.parent_sku, marketplace_id: marketplaceId }]
          if (row.relationship_type) attrs.parentage_level = [{ value: 'child', marketplace_id: marketplaceId }]
        }

        // Dynamic schema attributes (everything not already handled)
        const HANDLED = new Set([
          'update_delete', 'item_sku', 'feed_product_type', 'parent_child',
          'parent_sku', 'relationship_type', 'variation_theme', 'item_name',
          'product_description', 'bullet_point1', 'bullet_point2', 'bullet_point3',
          'bullet_point4', 'bullet_point5', 'generic_keyword', 'standard_price',
          'currency_code', 'quantity', 'external_product_id', 'external_product_id_type',
        ])
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith('_') || HANDLED.has(k) || !v) continue
          attrs[k] = wrap(String(v))
        }

        return {
          messageId: i + 1,
          sku: row.item_sku,
          operationType,
          productType,
          requirements: row.parent_child === 'Parent' ? 'LISTING_PRODUCT_ONLY' : 'LISTING',
          attributes: attrs,
        }
      })

    return JSON.stringify({
      header: { sellerId, version: '2.0', issueLocale: languageTag.replace('_', '-') },
      messages,
    })
  }

  // Export rows as TSV in Amazon flat file format.
  buildTsvExport(manifest: FlatFileManifest, rows: FlatFileRow[]): string {
    const allCols: FlatFileColumn[] = manifest.groups.flatMap((g) => g.columns)
    const colIds = allCols.map((c) => c.id)

    const header1 = `TemplateType=customizable\tVersion=2024.0.1\tProductType=${manifest.productType}\tMarketplace=${manifest.marketplace}`
    const header2 = colIds.join('\t')
    const header3 = allCols.map((c) => c.required ? 'Required' : 'Optional').join('\t')

    const dataRows = rows.map((row) =>
      colIds.map((id) => {
        const v = row[id]
        if (v == null) return ''
        return String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
      }).join('\t'),
    )

    return [header1, header2, header3, ...dataRows].join('\r\n')
  }

  // Parse an uploaded TSV flat file (from Amazon or exported from here)
  // and return rows. Tolerates the 3-row Amazon header format.
  parseTsv(content: string, productType: string): FlatFileRow[] {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) return []

    let headerLine = 0
    // Skip Amazon template meta-rows that don't look like column lists
    while (headerLine < lines.length && lines[headerLine].startsWith('TemplateType')) {
      headerLine++
    }
    if (headerLine >= lines.length) return []

    const cols = lines[headerLine].split('\t').map((c) => c.trim().toLowerCase())
    const dataStart = headerLine + 1

    // Skip "Required/Optional" annotation row if present
    const firstData = lines[dataStart] ?? ''
    const isAnnotation = /^required|^optional|^conditional/i.test(firstData.split('\t')[0] ?? '')
    const rowStart = isAnnotation ? dataStart + 1 : dataStart

    return lines.slice(rowStart).map((line, idx) => {
      const cells = line.split('\t')
      const row: FlatFileRow = {
        _rowId: `import-${idx}`,
        _isNew: false,
        _status: 'idle',
        update_delete: '',
        item_sku: '',
        feed_product_type: productType,
        parent_child: '',
        parent_sku: '',
        relationship_type: '',
        variation_theme: '',
        item_name: '',
        product_description: '',
        bullet_point1: '', bullet_point2: '', bullet_point3: '',
        bullet_point4: '', bullet_point5: '',
        generic_keyword: '',
        standard_price: '',
        currency_code: '',
        quantity: '',
        external_product_id: '',
        external_product_id_type: '',
      }
      cols.forEach((col, i) => {
        const val = cells[i]?.trim() ?? ''
        if (col in row) (row as any)[col] = val
        else if (val) row[col] = val
      })
      return row
    }).filter((r) => r.item_sku.length > 0)
  }
}
