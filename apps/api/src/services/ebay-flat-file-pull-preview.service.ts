/**
 * eBay Flat-File Pull Preview Service
 *
 * Phase 3 sibling of apps/api/src/services/amazon/flat-file-pull-preview.service.ts.
 * Same job-queue / in-memory / no-DB-write contract; eBay-shaped rows.
 *
 * Used by /products/ebay-flat-file so an operator can pull fresh data
 * from eBay directly into the editor's local row state, review it
 * through PullDiffModal, undo via Cmd+Z, and persist only when they
 * click Save.
 */

import prisma from '../db.js'
import { EbayService } from './marketplaces/ebay.service.js'
import {
  persistPullJobInitial,
  persistPullJobFinal,
} from './flat-file-pull-job-store.js'

// eBay site IDs the rest of the app uses. Mirrors the constant in
// apps/web/src/app/products/ebay-flat-file/ebay-columns.ts so a
// marketplace code coming off the URL ("IT", "UK", …) lands on the
// canonical site id eBay's APIs expect ("EBAY_IT", "EBAY_GB").
const EBAY_MARKETPLACE_ID_MAP: Record<string, string> = {
  IT: 'EBAY_IT',
  DE: 'EBAY_DE',
  FR: 'EBAY_FR',
  ES: 'EBAY_ES',
  UK: 'EBAY_GB',
  GB: 'EBAY_GB',
}

// Editor row shape — mirrors EbayRow in EbayFlatFileClient.tsx.
// `_*` keys are editor metadata; everything else is a column id the
// merge in the client will copy over verbatim.
export interface EbayPullRow {
  _rowId: string
  _productId: string
  _isNew?: false
  _dirty?: boolean
  item_sku: string         // bridge field for matching in the diff modal
  sku: string              // eBay editor uses 'sku' instead of 'item_sku'
  title: string
  description: string
  condition: string
  category_id: string
  price: string
  quantity: string
  best_offer_enabled: string
  best_offer_floor: string
  best_offer_ceiling: string
  handling_time: string
  ean: string
  mpn: string
  fulfillment_policy_id: string
  payment_policy_id: string
  return_policy_id: string
  listing_status: string
  image_1: string
  image_2: string
  image_3: string
  image_4: string
  image_5: string
  image_6: string
  [key: string]: unknown
}

export interface EbayPullPreviewJob {
  jobId: string
  marketplace: string         // 'IT' | 'DE' | 'FR' | 'ES' | 'UK'
  skus: string[] | null       // null = pull everything in the editor's catalog
  status: 'running' | 'done' | 'failed'
  progress: number
  total: number
  pulled: number
  skipped: number
  failed: number
  errors: Array<{ sku: string; error: string }>
  rows: EbayPullRow[]
  startedAt: string
  doneAt?: string
  fatalError?: string
}

const JOB_TTL_MS = 2 * 60 * 60 * 1000
const jobs = new Map<string, EbayPullPreviewJob>()

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, j] of jobs) {
    if (new Date(j.startedAt).getTime() < cutoff) jobs.delete(id)
  }
}

export function startEbayPullPreviewJob(opts: {
  marketplace: string
  skus?: string[]
}): string {
  pruneOldJobs()
  const jobId = `ebpreview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job: EbayPullPreviewJob = {
    jobId,
    marketplace: opts.marketplace.toUpperCase(),
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
  void persistPullJobInitial('EBAY', {
    jobId: job.jobId,
    marketplace: job.marketplace,
    productType: null,
    skus: job.skus,
    startedAt: job.startedAt,
  })
  void runEbayPreviewJob(job).catch((err) => {
    job.status = 'failed'
    job.fatalError = err instanceof Error ? err.message : String(err)
    job.doneAt = new Date().toISOString()
    void persistPullJobFinal('EBAY', {
      jobId: job.jobId,
      status: 'failed',
      progress: job.progress, total: job.total,
      pulled: job.pulled, skipped: job.skipped, failed: job.failed,
      errors: job.errors, rows: [],
      doneAt: job.doneAt,
      fatalError: job.fatalError,
    })
  })
  return jobId
}

export function getEbayPullPreviewJobStatus(jobId: string): EbayPullPreviewJob | null {
  return jobs.get(jobId) ?? null
}

async function runEbayPreviewJob(job: EbayPullPreviewJob): Promise<void> {
  const mp = job.marketplace
  const mpLower = mp.toLowerCase()   // 'it' | 'de' | 'fr' | 'es' | 'uk' for per-market columns
  const marketplaceId = EBAY_MARKETPLACE_ID_MAP[mp] ?? 'EBAY_IT'

  const where: Record<string, any> = { deletedAt: null }
  if (job.skus) where.sku = { in: job.skus }

  const products = await prisma.product.findMany({
    where,
    select: {
      id: true,
      sku: true,
      name: true,
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
    void persistPullJobFinal('EBAY', {
      jobId: job.jobId,
      status: 'done',
      progress: job.progress, total: job.total,
      pulled: job.pulled, skipped: job.skipped, failed: job.failed,
      errors: job.errors, rows: job.rows,
      doneAt: job.doneAt,
    })
    return
  }

  const ebay = new EbayService()

  for (const product of products) {
    try {
      const listing = await ebay.fetchListingForFlatFile(
        product.sku,
        marketplaceId,
        product.id,
      )
      if (!listing) {
        job.skipped++
        job.progress++
        continue
      }

      const imageUrls = listing.imageUrls.slice(0, 6)

      const row: EbayPullRow = {
        _rowId: product.id,
        _productId: product.id,
        _isNew: false,
        item_sku: product.sku,    // for sku-match against current editor rows
        sku: product.sku,

        title:                listing.title ?? '',
        description:          listing.description ?? '',
        condition:            listing.condition ?? '',
        category_id:          listing.categoryId ?? '',
        price:                listing.price != null ? String(listing.price) : '',
        quantity:             listing.quantity != null ? String(listing.quantity) : '',
        best_offer_enabled:   listing.bestOfferEnabled != null ? String(listing.bestOfferEnabled) : '',
        best_offer_floor:     listing.bestOfferFloor != null ? String(listing.bestOfferFloor) : '',
        best_offer_ceiling:   listing.bestOfferCeiling != null ? String(listing.bestOfferCeiling) : '',
        handling_time:        listing.handlingTime != null ? String(listing.handlingTime) : '',
        ean:                  listing.ean ?? '',
        mpn:                  listing.mpn ?? '',
        fulfillment_policy_id: listing.fulfillmentPolicyId ?? '',
        payment_policy_id:    listing.paymentPolicyId ?? '',
        return_policy_id:     listing.returnPolicyId ?? '',
        listing_status:       listing.listingStatus ?? '',
        image_1: imageUrls[0] ?? '',
        image_2: imageUrls[1] ?? '',
        image_3: imageUrls[2] ?? '',
        image_4: imageUrls[3] ?? '',
        image_5: imageUrls[4] ?? '',
        image_6: imageUrls[5] ?? '',
      }

      // Per-marketplace fields. Editor uses lowercase prefixes (it_price,
      // de_qty, …). Only the requested marketplace's columns are
      // populated so the merge in the client doesn't clobber other
      // markets' overrides.
      row[`${mpLower}_price`]      = listing.price != null ? String(listing.price) : ''
      row[`${mpLower}_qty`]        = listing.quantity != null ? String(listing.quantity) : ''
      row[`${mpLower}_item_id`]    = listing.itemId ?? ''
      row[`${mpLower}_listing_id`] = listing.offerId ?? ''
      row[`${mpLower}_status`]     = listing.listingStatus ?? ''

      // Item specifics → aspect_* columns. The editor builds matching
      // column ids at runtime from the category schema.
      for (const [k, v] of Object.entries(listing.aspects)) {
        row[`aspect_${k}`] = v
      }

      job.rows.push(row)
      job.pulled++
    } catch (err: any) {
      job.failed++
      job.errors.push({ sku: product.sku, error: err?.message ?? 'Pull failed' })
    }
    job.progress++
  }

  job.status = 'done'
  job.doneAt = new Date().toISOString()
  void persistPullJobFinal('EBAY', {
    jobId: job.jobId,
    status: 'done',
    progress: job.progress, total: job.total,
    pulled: job.pulled, skipped: job.skipped, failed: job.failed,
    errors: job.errors, rows: job.rows,
    doneAt: job.doneAt,
  })
}
