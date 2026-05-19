/**
 * Flat-File Pull Preview Service
 *
 * Non-destructive sibling of flat-file-pull.service.ts. Same SP-API calls,
 * same row expansion, but the pulled data is held in memory only — never
 * written to ChannelListing / Product / ProductVariation.
 *
 * Used by /products/amazon-flat-file so a user can pull fresh data from
 * Amazon directly into the editor's local row state, review it, undo via
 * Cmd+Z, and persist only when they click Save.
 *
 * The reconciliation pull (which DOES write to DB) is left untouched.
 */

import prisma from '../../db.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import {
  MARKETPLACE_ID_MAP,
  CURRENCY_MAP,
  type FlatFileRow,
} from './flat-file.service.js'

export interface PullPreviewJob {
  jobId: string
  marketplace: string
  productType: string
  skus: string[] | null
  status: 'running' | 'done' | 'failed'
  progress: number
  total: number
  pulled: number
  skipped: number
  failed: number
  errors: Array<{ sku: string; error: string }>
  rows: FlatFileRow[]
  startedAt: string
  doneAt?: string
  fatalError?: string
}

const JOB_TTL_MS = 2 * 60 * 60 * 1000
const jobs = new Map<string, PullPreviewJob>()

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, j] of jobs) {
    if (new Date(j.startedAt).getTime() < cutoff) jobs.delete(id)
  }
}

export function startPullPreviewJob(opts: {
  marketplace: string
  productType: string
  skus?: string[]
}): string {
  pruneOldJobs()
  const jobId = `ffpreview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job: PullPreviewJob = {
    jobId,
    marketplace: opts.marketplace.toUpperCase(),
    productType: opts.productType.toUpperCase(),
    skus: opts.skus && opts.skus.length > 0 ? opts.skus.slice() : null,
    status: 'running',
    progress: 0,
    total: 0,
    pulled: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    rows: [],
    startedAt: new Date().toISOString(),
  }
  jobs.set(jobId, job)
  void runPreviewJob(job).catch((err) => {
    job.status = 'failed'
    job.fatalError = err instanceof Error ? err.message : String(err)
    job.doneAt = new Date().toISOString()
  })
  return jobId
}

export function getPullPreviewJobStatus(jobId: string): PullPreviewJob | null {
  return jobs.get(jobId) ?? null
}

async function runPreviewJob(job: PullPreviewJob): Promise<void> {
  const mp = job.marketplace
  const pt = job.productType
  const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT

  const where: Record<string, any> = { deletedAt: null, productType: pt }
  if (job.skus) where.sku = { in: job.skus }

  const products = await prisma.product.findMany({
    where,
    select: {
      id: true,
      sku: true,
      name: true,
      productType: true,
      isParent: true,
      parentId: true,
    },
    orderBy: [{ isParent: 'desc' }, { sku: 'asc' }],
    take: 2000,
  })

  job.total = products.length

  if (!products.length) {
    job.status = 'done'
    job.doneAt = new Date().toISOString()
    return
  }

  const idToSku = new Map(products.map((p) => [p.id, p.sku]))
  const amazonService = new AmazonService()

  const pulledBySku = new Map<
    string,
    {
      asin: string | null
      attrs: Record<string, any>
      title: string | null
      listingStatus: string | null
    }
  >()

  for (const product of products) {
    try {
      const listing = await amazonService.fetchListingForFlatFile(product.sku, marketplaceId)
      if (!listing) {
        job.skipped++
        job.progress++
        continue
      }
      pulledBySku.set(product.sku, {
        asin: listing.asin,
        attrs: listing.attributes,
        title: listing.title,
        listingStatus: listing.listingStatus,
      })
      job.pulled++
    } catch (err: any) {
      job.failed++
      job.errors.push({ sku: product.sku, error: err?.message ?? 'Pull failed' })
    }
    job.progress++
  }

  // Row expansion. Mirrors the transformation block in
  // flat-file.service.ts → getExistingRows (the part after the DB query).
  // Duplicated here on purpose so the DB-writing path stays untouched.
  const INFRA = new Set(['marketplace_id', 'language_tag', 'audience'])

  job.rows = products
    .filter((p) => pulledBySku.has(p.sku))
    .map((p) => {
      const pulled = pulledBySku.get(p.sku)!
      const attrs = pulled.attrs
      const bullets: string[] = Array.isArray(attrs.bullet_point)
        ? (attrs.bullet_point as any[])
            .map((b: any) => b?.value ?? String(b))
            .filter(Boolean)
        : []

      const parentSku = p.parentId ? idToSku.get(p.parentId) ?? '' : ''

      const poAttrs = attrs.purchasable_offer?.[0] as Record<string, any> | undefined
      const poCurrency = String(poAttrs?.currency ?? CURRENCY_MAP[mp] ?? 'EUR')
      const poCondition = String(poAttrs?.condition_type ?? '')
      const poSaleAttrs = poAttrs?.sale_price?.[0] as Record<string, any> | undefined
      const poSalePrice =
        poSaleAttrs?.schedule?.[0]?.value_with_tax != null
          ? String(poSaleAttrs.schedule[0].value_with_tax)
          : ''
      const poOurPrice =
        poAttrs?.our_price?.[0]?.schedule?.[0]?.value_with_tax != null
          ? String(poAttrs.our_price[0].schedule[0].value_with_tax)
          : ''

      const faAttrs = attrs.fulfillment_availability?.[0] as Record<string, any> | undefined
      const faCode = String(faAttrs?.fulfillment_channel_code ?? 'DEFAULT')
      const faQty = faAttrs?.quantity != null ? String(faAttrs.quantity) : ''
      const faLeadTime =
        faAttrs?.lead_time_to_ship_max_days != null
          ? String(faAttrs.lead_time_to_ship_max_days)
          : ''

      const row: FlatFileRow = {
        _rowId: p.id,
        _productId: p.id,
        _isNew: false,
        _status: 'idle',
        item_sku: p.sku,
        product_type: (p.productType as string | null) ?? pt,
        record_action: 'full_update',
        parentage_level: p.isParent ? 'Parent' : p.parentId ? 'Child' : '',
        parent_sku: parentSku,
        variation_theme: String(attrs.variation_theme?.[0]?.value ?? ''),
        item_name: pulled.title ?? attrs.item_name?.[0]?.value ?? p.name ?? '',
        brand: String(attrs.brand?.[0]?.value ?? ''),
        product_description: String(attrs.product_description?.[0]?.value ?? ''),
        bullet_point: bullets[0] ?? '',
        bullet_point_2: bullets[1] ?? '',
        bullet_point_3: bullets[2] ?? '',
        bullet_point_4: bullets[3] ?? '',
        bullet_point_5: bullets[4] ?? '',
        generic_keyword: String(attrs.generic_keyword?.[0]?.value ?? ''),
        color: String(attrs.color?.[0]?.value ?? ''),
        purchasable_offer: '',
        purchasable_offer__condition_type: poCondition,
        purchasable_offer__currency: poCurrency,
        purchasable_offer__our_price: poOurPrice,
        purchasable_offer__sale_price: poSalePrice,
        purchasable_offer__sale_from_date: String(poSaleAttrs?.start_at?.[0]?.value ?? ''),
        purchasable_offer__sale_end_date: String(poSaleAttrs?.end_at?.[0]?.value ?? ''),
        fulfillment_availability: '',
        fulfillment_availability__fulfillment_channel_code: faCode,
        fulfillment_availability__quantity: faQty,
        fulfillment_availability__lead_time_to_ship_max_days: faLeadTime,
        main_product_image_locator: String(
          attrs.main_product_image_locator?.[0]?.media_location ?? '',
        ),
        _asin: pulled.asin ?? '',
        _listingStatus: pulled.listingStatus ?? '',
      }

      for (const [k, v] of Object.entries(attrs)) {
        if (k in row) continue
        if (!Array.isArray(v)) {
          if (v != null) row[k] = String(v)
          continue
        }
        if (v.length === 0) continue
        const first = v[0]
        if (typeof first !== 'object' || first === null) {
          v.forEach((item, i) => {
            if (item != null) row[`${k}_${i + 1}`] = String(item)
          })
          continue
        }
        const keys = Object.keys(first).filter((fk) => !INFRA.has(fk))
        if (keys.length === 0) continue
        if (keys.length === 1 && keys[0] === 'value') {
          if (v.length > 1) {
            v.forEach((item, i) => {
              const val = item?.value
              if (val != null) row[`${k}_${i + 1}`] = String(val)
            })
          } else {
            const val = first.value
            if (val != null) row[k] = String(val)
          }
        } else if (keys.length === 2 && keys.includes('value') && keys.includes('unit')) {
          if (first.value != null) row[`${k}__value`] = String(first.value)
          if (first.unit) row[`${k}__unit`] = String(first.unit)
        } else if (v.length > 1 && keys.includes('value')) {
          v.forEach((item, i) => {
            const val = item?.value
            if (val != null) row[`${k}_${i + 1}`] = String(val)
          })
        } else {
          for (const subKey of keys) {
            if (subKey === 'value') continue
            const subVal = first[subKey]
            if (typeof subVal === 'object' && subVal !== null) {
              if (subVal.value != null) row[`${k}__${subKey}`] = String(subVal.value)
              if (subVal.unit) row[`${k}__${subKey}_unit`] = String(subVal.unit)
            } else if (subVal != null && subVal !== '') {
              row[`${k}__${subKey}`] = String(subVal)
            }
          }
        }
      }

      return row
    })

  job.status = 'done'
  job.doneAt = new Date().toISOString()
}
