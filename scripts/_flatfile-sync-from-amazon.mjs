/**
 * Sync Amazon listing attributes back into Nexus DB.
 *
 * For each product with an ASIN the script calls:
 *   GET /listings/2021-08-01/items/{sellerId}/{sku}?includedData=attributes
 * and writes the result to both ChannelListing.platformAttributes (nested
 * Amazon JSON) and ChannelListing.flatFileSnapshot (flat row — the stored
 * flat file state). The flat file snapshot is the source of truth: every
 * subsequent open of the editor reads the snapshot first, with price/qty
 * overlaid from the live operational system.
 *
 * Products without an ASIN (not yet listed) are reported separately and
 * can be handled in a follow-up pass.
 *
 * Usage:
 *   node scripts/_flatfile-sync-from-amazon.mjs IT       # Amazon IT
 *   node scripts/_flatfile-sync-from-amazon.mjs IT DE    # IT then DE
 *   node scripts/_flatfile-sync-from-amazon.mjs IT DE FR ES   # all EU
 *
 * The script auto-detects multi-product-type families (e.g. COAT + PANTS
 * under one parent) by inspecting the variation_theme Amazon returns and
 * the distinct product_type values across siblings. Union families are
 * flagged in the report so the flat file editor can open them in union
 * (multi-category) mode.
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

// ── SP-API config ─────────────────────────────────────────────────────────────

const SELLER_ID = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
const LWA_CLIENT_ID = process.env.AMAZON_LWA_CLIENT_ID ?? ''
const LWA_CLIENT_SECRET = process.env.AMAZON_LWA_CLIENT_SECRET ?? ''
const REFRESH_TOKEN = process.env.AMAZON_REFRESH_TOKEN ?? ''
const REGION = process.env.AMAZON_REGION ?? 'eu'

const MARKETPLACE_ID = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

if (!SELLER_ID || !LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing SP-API credentials. Check AMAZON_SELLER_ID, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN in .env')
  process.exit(1)
}

// ── LWA token ─────────────────────────────────────────────────────────────────

let _token = null
let _tokenExpiry = 0

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry - 30_000) return _token
  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  })
  const data = await resp.json()
  if (!data.access_token) throw new Error(`LWA token refresh failed: ${JSON.stringify(data)}`)
  _token = data.access_token
  _tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000
  return _token
}

// ── SP-API listing attributes pull ───────────────────────────────────────────

async function getListingAttributes(sku, marketplaceId) {
  const token = await getAccessToken()
  const url = `https://sellingpartnerapi-${REGION}.amazon.com/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}?includedData=attributes&marketplaceIds=${marketplaceId}`
  const resp = await fetch(url, {
    headers: {
      'x-amz-access-token': token,
      'x-amzn-requestid': `nexus-ff-sync-${Date.now()}`,
    },
  })
  if (resp.status === 404) return null
  const data = await resp.json()
  if (data.errors?.length) {
    const msg = data.errors.map(e => e.message).join('; ')
    throw new Error(`SP-API error for ${sku}: ${msg}`)
  }
  return data.attributes ?? null
}

// ── Attribute expansion: SP-API nested JSON → flat file row ──────────────────
// Mirrors the expansion logic in getExistingRows() (flat-file.service.ts)
// so the flatFileSnapshot stored here matches what the editor expects.

const INFRA_KEYS = new Set(['marketplace_id', 'language_tag', 'audience'])

function expandAttributes(attrs, product, parentSku) {
  const CURRENCY_FALLBACK = 'EUR'
  const poAttrs = attrs.purchasable_offer?.[0]
  const poCurrency = String(poAttrs?.currency ?? CURRENCY_FALLBACK)
  const poCondition = String(poAttrs?.condition_type ?? '')
  const poSaleAttrs = poAttrs?.sale_price?.[0]

  // Resolve price from the nested schedule structure
  const ourPriceRaw = poAttrs?.our_price?.[0]?.schedule?.[0]?.value_with_tax
  const ourPrice = ourPriceRaw != null ? String(ourPriceRaw) : ''
  const salePriceRaw = poSaleAttrs?.schedule?.[0]?.value_with_tax
  const salePrice = salePriceRaw != null ? String(salePriceRaw) : ''

  const faAttrs = attrs.fulfillment_availability?.[0]
  const faCode = faAttrs?.fulfillment_channel_code != null
    ? String(faAttrs.fulfillment_channel_code)
    : (product.fulfillmentMethod === 'FBA' ? 'AMAZON_EU' : 'DEFAULT')
  const faCodeU = faCode.toUpperCase()
  const isFba = faCodeU.startsWith('AMAZON') || faCodeU === 'AFN' || faCodeU === 'FBA'
  const faLeadTime = faAttrs?.lead_time_to_ship_max_days != null ? String(faAttrs.lead_time_to_ship_max_days) : ''
  const faQty = isFba ? '' : (faAttrs?.quantity != null ? String(faAttrs.quantity) : '')

  // Bullets: Amazon returns them as a numbered array [{value: "..."}, ...]
  const bulletArr = Array.isArray(attrs.bullet_point)
    ? attrs.bullet_point.map(b => b?.value ?? String(b))
    : []

  const row = {
    item_sku: product.sku,
    product_type: String(attrs.product_type?.[0]?.value ?? product.productType ?? ''),
    record_action: 'full_update',
    parentage_level: product.isParent ? 'Parent' : (product.parentId ? 'Child' : ''),
    parent_sku: parentSku ?? '',
    variation_theme: String(attrs.variation_theme?.[0]?.value ?? attrs.variation_theme?.[0]?.name ?? ''),
    // Content
    item_name: String(attrs.item_name?.[0]?.value ?? product.name ?? ''),
    brand: String(attrs.brand?.[0]?.value ?? product.brand ?? ''),
    product_description: String(attrs.product_description?.[0]?.value ?? product.description ?? ''),
    bullet_point: '',
    bullet_point_1: bulletArr[0] ?? '',
    bullet_point_2: bulletArr[1] ?? '',
    bullet_point_3: bulletArr[2] ?? '',
    bullet_point_4: bulletArr[3] ?? '',
    bullet_point_5: bulletArr[4] ?? '',
    generic_keyword: String(attrs.generic_keyword?.[0]?.value ?? ''),
    color: String(attrs.color?.[0]?.value ?? ''),
    // Pricing
    purchasable_offer: '',
    purchasable_offer__condition_type: poCondition,
    purchasable_offer__currency: poCurrency,
    purchasable_offer__our_price: ourPrice,
    purchasable_offer__sale_price: salePrice,
    purchasable_offer__sale_from_date: String(poSaleAttrs?.start_at?.[0]?.value ?? ''),
    purchasable_offer__sale_end_date: String(poSaleAttrs?.end_at?.[0]?.value ?? ''),
    // Fulfillment
    fulfillment_availability: '',
    fulfillment_availability__fulfillment_channel_code: faCode,
    fulfillment_availability__quantity: faQty,
    fulfillment_availability__lead_time_to_ship_max_days: faLeadTime,
    // Images
    main_product_image_locator: String(attrs.main_product_image_locator?.[0]?.media_location ?? ''),
  }

  // Generic expansion for all remaining attributes (apparel fields,
  // dimensions, special_feature, occasion_type, seasons, etc.)
  for (const [k, v] of Object.entries(attrs)) {
    if (k in row) continue
    if (!Array.isArray(v)) {
      if (v != null) row[k] = String(v)
      continue
    }
    if (v.length === 0) continue
    const first = v[0]
    if (typeof first !== 'object' || first === null) {
      v.forEach((item, i) => { if (item != null) row[`${k}_${i + 1}`] = String(item) })
      continue
    }
    const keys = Object.keys(first).filter(fk => !INFRA_KEYS.has(fk))
    if (keys.length === 0) continue

    if (keys.length === 1 && keys[0] === 'value') {
      if (v.length > 1) {
        v.forEach((item, i) => { const val = item?.value; if (val != null) row[`${k}_${i + 1}`] = String(val) })
      } else {
        const val = first.value; if (val != null) row[k] = String(val)
      }
    } else if (keys.length === 2 && keys.includes('value') && keys.includes('unit')) {
      if (first.value != null) row[`${k}__value`] = String(first.value)
      if (first.unit) row[`${k}__unit`] = String(first.unit)
    } else if (v.length > 1 && keys.includes('value')) {
      v.forEach((item, i) => { const val = item?.value; if (val != null) row[`${k}_${i + 1}`] = String(val) })
    } else {
      // Sub-property object: expand each named sub-key
      for (const subKey of keys) {
        if (subKey === 'value') continue
        const subVal = first[subKey]
        if (typeof subVal === 'object' && subVal !== null) {
          if (Array.isArray(subVal)) {
            // e.g. outer[].material[] — multi-valued sub-array
            subVal.forEach((sv, i) => {
              const innerKeys = Object.keys(sv ?? {}).filter(ik => !INFRA_KEYS.has(ik))
              if (innerKeys.length === 1 && innerKeys[0] === 'value') {
                if (sv?.value != null) row[`${k}__${subKey}_${i + 1}`] = String(sv.value)
              }
            })
          } else if ('value' in subVal && 'unit' in subVal) {
            // {value, unit} dimension
            if (subVal.value != null) row[`${k}__${subKey}`] = String(subVal.value)
            if (subVal.unit) row[`${k}__${subKey}_unit`] = String(subVal.unit)
          } else if ('value' in subVal) {
            if (subVal.value != null) row[`${k}__${subKey}`] = String(subVal.value)
          } else {
            // Nested object with multiple typed sub-keys (e.g. leg[].style[])
            for (const [sk2, sv2] of Object.entries(subVal)) {
              if (INFRA_KEYS.has(sk2)) continue
              if (Array.isArray(sv2) && sv2[0]?.value != null) {
                row[`${k}__${subKey}__${sk2}`] = String(sv2[0].value)
              } else if (sv2 != null) {
                row[`${k}__${subKey}__${sk2}`] = String(sv2)
              }
            }
          }
        } else if (subVal != null && subVal !== '') {
          row[`${k}__${subKey}`] = String(subVal)
        }
      }
    }
  }

  return row
}

// ── Main ──────────────────────────────────────────────────────────────────────

const markets = (process.argv.slice(2).length ? process.argv.slice(2) : ['IT'])
  .map(m => m.toUpperCase())
  .filter(m => {
    if (!MARKETPLACE_ID[m]) { console.warn(`  ⚠ Unknown market "${m}", skipping`); return false }
    return true
  })

if (!markets.length) { console.error('No valid markets specified'); process.exit(1) }

// Load all products with their parent relationship
const allProducts = await prisma.product.findMany({
  where: { deletedAt: null },
  select: {
    id: true, sku: true, name: true, brand: true, description: true,
    productType: true, isParent: true, parentId: true, fulfillmentMethod: true,
    amazonAsin: true,
    channelListings: {
      select: {
        id: true, amazonAsin: true, price: true, salePrice: true, quantity: true,
        marketplace: true, channel: true, flatFileSnapshot: true,
      },
    },
  },
  orderBy: [{ isParent: 'desc' }, { sku: 'asc' }],
})

// Build id→sku map for parent resolution
const idToSku = new Map(allProducts.map(p => [p.id, p.sku]))

// Group by family (parent SKU) to detect union families
const families = new Map() // parentSku → { parent, children: [] }
for (const p of allProducts) {
  if (p.isParent) {
    if (!families.has(p.sku)) families.set(p.sku, { parent: p, children: [] })
  } else if (p.parentId) {
    const parentSku = idToSku.get(p.parentId)
    if (parentSku) {
      if (!families.has(parentSku)) families.set(parentSku, { parent: null, children: [] })
      families.get(parentSku).children.push(p)
    }
  } else {
    // Standalone (no parent)
    if (!families.has(p.sku)) families.set(p.sku, { parent: p, children: [] })
  }
}

// Detect union families: children have more than one distinct productType
const unionFamilies = []
for (const [parentSku, { children }] of families) {
  const types = new Set(children.map(c => c.productType).filter(Boolean))
  if (types.size > 1) unionFamilies.push({ parentSku, productTypes: [...types] })
}

console.log(`\n=== Flat File → Amazon Sync ===`)
console.log(`Products: ${allProducts.length}`)
console.log(`Families: ${families.size} (${unionFamilies.length} union families)`)
if (unionFamilies.length) {
  console.log('\nUnion families detected (will use multi-category template):')
  for (const uf of unionFamilies) {
    console.log(`  ${uf.parentSku}: [${uf.productTypes.join(' + ')}]`)
  }
}

for (const market of markets) {
  const marketplaceId = MARKETPLACE_ID[market]
  console.log(`\n─── Market: ${market} (${marketplaceId}) ───`)

  const stats = { synced: 0, skipped: 0, errors: 0, noAsin: 0 }
  const noAsinList = []
  const errorList = []

  for (const product of allProducts) {
    const listing = product.channelListings.find(l => l.channel === 'AMAZON' && l.marketplace === market)
    const asin = listing?.amazonAsin ?? product.amazonAsin

    if (!asin) {
      stats.noAsin++
      noAsinList.push(product.sku)
      continue
    }

    const parentSku = product.parentId ? (idToSku.get(product.parentId) ?? '') : ''

    try {
      process.stdout.write(`  ${product.sku} (${asin})... `)
      const attributes = await getListingAttributes(product.sku, marketplaceId)

      if (!attributes) {
        console.log('not found on this market, skipping')
        stats.skipped++
        continue
      }

      const flatRow = expandAttributes(attributes, product, parentSku)

      // Upsert ChannelListing
      if (listing) {
        await prisma.channelListing.update({
          where: { id: listing.id },
          data: {
            platformAttributes: { attributes },
            flatFileSnapshot: flatRow,
            lastSyncedAt: new Date(),
          },
        })
      } else {
        await prisma.channelListing.create({
          data: {
            channel: 'AMAZON',
            marketplace: market,
            channelMarket: `AMAZON_${market}`,
            region: market,
            productId: product.id,
            platformAttributes: { attributes },
            flatFileSnapshot: flatRow,
            lastSyncedAt: new Date(),
          },
        })
      }

      console.log('✓')
      stats.synced++
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      stats.errors++
      errorList.push({ sku: product.sku, error: err.message })
    }

    // SP-API rate limit: ~2 req/s for Listings Items API
    await new Promise(r => setTimeout(r, 550))
  }

  console.log(`\n  Results for ${market}:`)
  console.log(`    Synced:       ${stats.synced}`)
  console.log(`    Skipped (no ASIN):  ${stats.noAsin}`)
  console.log(`    Skipped (not in market): ${stats.skipped}`)
  console.log(`    Errors:       ${stats.errors}`)

  if (noAsinList.length) {
    console.log(`\n  Products without ASIN (need manual listing or new flat file):`)
    for (const sku of noAsinList) console.log(`    - ${sku}`)
  }
  if (errorList.length) {
    console.log(`\n  Errors:`)
    for (const { sku, error } of errorList) console.log(`    - ${sku}: ${error}`)
  }
}

console.log('\n=== Union family note ===')
console.log('For union families above, open the flat file editor in multi-category')
console.log('mode (e.g. COAT+PANTS) — the platform already supports this via MT.1.')
console.log('The variation_theme for each family was copied exactly from Amazon.')

await prisma.$disconnect()
