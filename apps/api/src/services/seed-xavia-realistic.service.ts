/**
 * Realistic Xavia catalog seed.
 *
 * Generates ~67 parent products + ~1,272 ProductVariation rows across
 * 6 motorcycle-gear categories. Size + color are variation-level;
 * gender / athlete / fit / graphics are product-level dimensions
 * (separate parent SKUs) — matches Rithum + Amazon SP-API variation
 * theme conventions for moto gear.
 *
 * Marker: importSource = 'XAVIA_REALISTIC_TEST' on parents → cleanup
 * is a single DELETE that cascades to variations via FK.
 *
 * Idempotent: Product.sku and ProductVariation.sku are both @unique
 * so re-running is a no-op.
 *
 * Consumed by:
 *   POST /api/admin/seed-xavia-realistic
 *   (defined in apps/api/src/routes/products.routes.ts)
 */

import { PrismaClient } from '@prisma/client'

export const BRAND = 'Xavia Racing'
export const IMPORT_SOURCE = 'XAVIA_REALISTIC_TEST'
const SYNC_CHANNELS = ['AMAZON', 'EBAY']

// ── Stock profiles ──────────────────────────────────────────────────
// Realistic-ish distributions: middle sizes carry more inventory
// than extremes. Returns a stock count for a given size index within
// the size array.
type StockProfile = 'race' | 'apparel' | 'footwear' | 'helmet'

function stockFor(profile: StockProfile, sizeIndex: number, sizeCount: number): number {
  // Bell-ish curve centered on middle size
  const mid = (sizeCount - 1) / 2
  const distance = Math.abs(sizeIndex - mid)
  const peak = profile === 'race' ? 25 : profile === 'helmet' ? 12 : 40
  const decay = profile === 'race' ? 0.5 : 0.4
  const base = Math.round(peak * Math.exp(-decay * distance))
  // ±20% noise for realism, never < 0
  const jitter = Math.round(base * (0.8 + Math.random() * 0.4))
  return Math.max(0, jitter)
}

// ── Templates ──────────────────────────────────────────────────────
// Each template defines:
//   modelLines:    parent-product name variants ("Aether", "Volt", …)
//   productDims:   product-level cartesian dimensions (gender, athlete, …)
//                  → multiplied with modelLines to make distinct parents
//   variationDims: per-parent variation cartesian (size × color)
//   priceModifiers: per-product-dimension multipliers (Marquez +25%, …)

interface Template {
  category: string
  skuPrefix: string
  basePrice: number
  modelLines: string[]
  productDims: Record<string, string[]>
  /** Drop combinations where the predicate returns false — e.g.
   *  Marquez/Bagnaia race-replica gear is men's-only. */
  productCombinationFilter?: (combo: Record<string, string>) => boolean
  variationDims: { size: string[]; color: string[] }
  priceModifiers?: Record<string, Record<string, number>>
  stockProfile: StockProfile
  description: (combo: Record<string, string>) => string
}

const TEMPLATES: Template[] = [
  {
    category: 'RACE_JACKET',
    skuPrefix: 'XAV-RJK',
    basePrice: 599.0,
    modelLines: ['Aether', 'Volt', 'Apex'],
    productDims: {
      athlete: ['Generic', 'Marquez', 'Bagnaia'],
      gender: ['Men', 'Women'],
    },
    productCombinationFilter: (c) =>
      // Athlete-replica race jackets are men's-only signature lines.
      c.athlete === 'Generic' || c.gender === 'Men',
    variationDims: {
      size: ['44', '46', '48', '50', '52', '54', '56', '58'],
      color: ['Black', 'Red/Black', 'White/Red'],
    },
    priceModifiers: {
      athlete: { Generic: 1.0, Marquez: 1.25, Bagnaia: 1.2 },
    },
    stockProfile: 'race',
    description: (c) =>
      `Premium leather race jacket. ${c.athlete === 'Generic' ? '' : `Official ${c.athlete} replica colours. `}CE level 2 protection on shoulders, elbows, and back. ${c.gender} fit.`,
  },
  {
    category: 'TOURING_JACKET',
    skuPrefix: 'XAV-TJK',
    basePrice: 449.0,
    modelLines: ['Voyager', 'Stratus', 'Nimbus'],
    productDims: {
      fit: ['Standard', 'Tall'],
      gender: ['Men', 'Women', 'Unisex'],
    },
    productCombinationFilter: (c) =>
      // Tall fit only for Men + Unisex (not Women).
      !(c.fit === 'Tall' && c.gender === 'Women'),
    variationDims: {
      size: ['S', 'M', 'L', 'XL', 'XXL', '3XL'],
      color: ['Black', 'Black/Yellow', 'Black/Red'],
    },
    stockProfile: 'apparel',
    description: (c) =>
      `All-weather touring jacket. Removable thermal liner, waterproof membrane, hi-viz panels. ${c.fit === 'Tall' ? 'Tall fit (extended length).' : 'Standard fit.'} ${c.gender}.`,
  },
  {
    category: 'MESH_JACKET',
    skuPrefix: 'XAV-MJK',
    basePrice: 199.0,
    modelLines: ['AirMesh', 'Estiva', 'Breeze', 'Flow'],
    productDims: {
      gender: ['Men', 'Women'],
    },
    variationDims: {
      size: ['S', 'M', 'L', 'XL', 'XXL'],
      color: ['Black', 'Grey', 'Hi-Viz'],
    },
    stockProfile: 'apparel',
    description: (c) =>
      `Summer mesh jacket. Maximum airflow, CE-armoured shoulders and elbows. ${c.gender} cut.`,
  },
  {
    category: 'LEATHER_GLOVES',
    skuPrefix: 'XAV-GLV',
    basePrice: 119.0,
    modelLines: [
      'Riser',
      'Strada',
      'Velo',
      'Pista',
      'Touring',
      'Sport',
      'Heritage',
    ],
    productDims: {
      type: ['Short', 'Gauntlet'],
    },
    variationDims: {
      size: ['S', 'M', 'L', 'XL', 'XXL'],
      color: ['Black', 'Red', 'White'],
    },
    stockProfile: 'apparel',
    description: (c) =>
      `Premium leather motorcycle glove. ${c.type === 'Gauntlet' ? 'Long-cuff gauntlet style for sport / track use.' : 'Short-cuff for street and commuting.'} Touchscreen-compatible fingertips.`,
  },
  {
    category: 'RACE_BOOTS',
    skuPrefix: 'XAV-BTS',
    basePrice: 349.0,
    modelLines: ['Apex', 'Velocita', 'Track'],
    productDims: {
      gender: ['Men', 'Women'],
    },
    variationDims: {
      size: ['39', '40', '41', '42', '43', '44', '45', '46'],
      color: ['Black', 'Black/White'],
    },
    stockProfile: 'footwear',
    description: (c) =>
      `Race-spec motorcycle boots. Magnesium toe sliders, internal ankle brace, vented uppers. ${c.gender}.`,
  },
  {
    category: 'HELMET',
    skuPrefix: 'XAV-HLM',
    basePrice: 399.0,
    modelLines: ['Aero', 'Forza', 'Pista'],
    productDims: {
      graphics: ['Plain', 'Marquez Replica', 'Bagnaia Replica', 'Italia'],
    },
    variationDims: {
      size: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
      color: ['Black', 'White', 'Red', 'Blue'],
    },
    priceModifiers: {
      graphics: {
        Plain: 1.0,
        'Marquez Replica': 1.4,
        'Bagnaia Replica': 1.35,
        Italia: 1.15,
      },
    },
    stockProfile: 'helmet',
    description: (c) =>
      `Full-face motorcycle helmet. ECE 22.06 certified. ${c.graphics === 'Plain' ? 'Solid-colour finish.' : `${c.graphics} graphics.`}`,
  },
]

// ── Helpers ─────────────────────────────────────────────────────────

function cartesian<T extends Record<string, string[]>>(
  dims: T,
): Array<Record<keyof T, string>> {
  const keys = Object.keys(dims) as Array<keyof T>
  if (keys.length === 0) return [{} as Record<keyof T, string>]
  let combos: Array<Record<keyof T, string>> = [{} as Record<keyof T, string>]
  for (const key of keys) {
    const values = dims[key]
    const next: Array<Record<keyof T, string>> = []
    for (const combo of combos) {
      for (const v of values) {
        next.push({ ...combo, [key]: v })
      }
    }
    combos = next
  }
  return combos
}

function slugify(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildParentSku(template: Template, modelLine: string, dims: Record<string, string>): string {
  const dimSlug = Object.values(dims).map(slugify).join('-')
  return [template.skuPrefix, slugify(modelLine), dimSlug].filter(Boolean).join('-')
}

function buildVariationSku(
  parentSku: string,
  size: string,
  color: string,
): string {
  return `${parentSku}-${slugify(size)}-${slugify(color)}`
}

function buildProductName(
  template: Template,
  modelLine: string,
  dims: Record<string, string>,
): string {
  const tokens: string[] = ['Xavia']
  // Athlete / graphics dimensions go BEFORE the model line for
  // signature products
  if (dims.athlete && dims.athlete !== 'Generic') tokens.push(dims.athlete)
  if (dims.graphics && dims.graphics !== 'Plain') tokens.push(dims.graphics)
  tokens.push(modelLine)
  tokens.push(template.category.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))
  if (dims.fit && dims.fit !== 'Standard') tokens.push(`(${dims.fit} Fit)`)
  if (dims.type) tokens.push(`(${dims.type})`)
  if (dims.gender && dims.gender !== 'Unisex') tokens.push(`— ${dims.gender}`)
  return tokens.join(' ')
}

function applyPriceModifiers(
  base: number,
  template: Template,
  dims: Record<string, string>,
): number {
  if (!template.priceModifiers) return base
  let multiplier = 1
  for (const [dim, table] of Object.entries(template.priceModifiers)) {
    const v = dims[dim]
    if (v && table[v] !== undefined) multiplier *= table[v]
  }
  return Math.round(base * multiplier * 100) / 100
}

// ── Function (callable from Fastify endpoint or CLI) ───────────────

export interface SeedSummary {
  parentsTouched: number
  variationsCreated: number
  productCount: number
  variationCount: number
  byCategory: Record<string, { parents: number; variations: number }>
}

export async function seedRealisticXavia(
  client: PrismaClient,
  log: (msg: string) => void = () => {},
): Promise<SeedSummary> {
  let parentsTouched = 0
  let variationsCreated = 0
  const byCategory: Record<string, { parents: number; variations: number }> = {}

  for (const template of TEMPLATES) {
    log(`-- ${template.category}`)
    byCategory[template.category] = { parents: 0, variations: 0 }
    const productCombos = cartesian(template.productDims)
    const filteredCombos = template.productCombinationFilter
      ? productCombos.filter(template.productCombinationFilter)
      : productCombos

    for (const modelLine of template.modelLines) {
      for (const combo of filteredCombos) {
        const parentSku = buildParentSku(template, modelLine, combo)
        const parentName = buildProductName(template, modelLine, combo)
        const parentPrice = applyPriceModifiers(
          template.basePrice,
          template,
          combo,
        )
        const variationCombos = cartesian(template.variationDims)

        const variationsToCreate = variationCombos.map((vc) => {
          const sizeIdx = template.variationDims.size.indexOf(vc.size)
          const sizeCount = template.variationDims.size.length
          const stock = stockFor(template.stockProfile, sizeIdx, sizeCount)
          return {
            sku: buildVariationSku(parentSku, vc.size, vc.color),
            price:
              sizeIdx === sizeCount - 1
                ? (parentPrice * 1.05).toFixed(2)
                : parentPrice.toFixed(2),
            stock,
            name: 'Size',
            value: vc.size,
            variationAttributes: { size: vc.size, color: vc.color },
          }
        })
        const totalStock = variationsToCreate.reduce(
          (acc, v) => acc + v.stock,
          0,
        )

        const parent = await client.product.upsert({
          where: { sku: parentSku },
          update: {},
          create: {
            sku: parentSku,
            name: parentName,
            description: template.description(combo),
            brand: BRAND,
            productType: template.category,
            basePrice: parentPrice.toFixed(2),
            totalStock,
            status: 'ACTIVE',
            isParent: true,
            variationTheme: Object.keys(template.variationDims).join(','),
            syncChannels: SYNC_CHANNELS,
            importSource: IMPORT_SOURCE,
          },
        })

        if (parent.totalStock === 0 && totalStock > 0) {
          await client.product.update({
            where: { id: parent.id },
            data: { totalStock },
          })
        }

        const result = await client.productVariation.createMany({
          data: variationsToCreate.map((v) => ({
            productId: parent.id,
            sku: v.sku,
            name: v.name,
            value: v.value,
            variationAttributes: v.variationAttributes,
            price: v.price,
            stock: v.stock,
          })),
          skipDuplicates: true,
        })

        parentsTouched++
        variationsCreated += result.count
        byCategory[template.category].parents++
        byCategory[template.category].variations += result.count
        log(
          `  ${parentName} (parent=${parent.id.slice(0, 8)}…, vars=${result.count}/${variationsToCreate.length})`,
        )
      }
    }
  }

  const productCount = await client.product.count({
    where: { importSource: IMPORT_SOURCE },
  })
  const variationCount = await client.productVariation.count({
    where: { product: { importSource: IMPORT_SOURCE } },
  })

  return {
    parentsTouched,
    variationsCreated,
    productCount,
    variationCount,
    byCategory,
  }
}

// (Standalone CLI wrapper removed when this module relocated from
// packages/database/scripts/ to apps/api/src/services/. The seed
// runs via the /api/admin/seed-xavia-realistic Fastify endpoint.)
