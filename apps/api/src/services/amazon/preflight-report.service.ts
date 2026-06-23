/**
 * ALA Phase 8 — Pre-Flight report aggregator (the capstone's data backbone).
 *
 * Assembles ONE "what's wrong + what's changing" report per Amazon listing by
 * unioning every detector built across the ALA series:
 *   - byte-length        (P0)  maxUtf8ByteLength overflow
 *   - required           (P0)  missing static required attributes
 *   - conditional        (P1)  allOf-derived conditionally-required-but-empty
 *   - mirrored           (P2)  open ListingIssue rows (live Amazon issues)
 *   - validation-preview (P1)  Amazon's authoritative VALIDATION_PREVIEW (live)
 * plus a per-attribute DIFF of pending edits vs current live Amazon state.
 *
 * Local detectors + mirrored issues always run (no SP-API needed). The diff and
 * live VALIDATION_PREVIEW are BEST-EFFORT: if SP-API is unavailable they're
 * marked unavailable and the report still returns the rest. The pure collectors
 * (collectLocalIssues / buildDiff) are unit-tested; the orchestration is the
 * impure shell. Reuses the SAME buildRow the publish path uses, so the report
 * reflects exactly what would be submitted.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { AmazonFlatFileService, MARKETPLACE_ID_MAP } from './flat-file.service.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { buildRow, COCKPIT_EXPANDED_FIELDS } from '../../routes/amazon-cockpit-publish.routes.js'
import { checkLengthLimits, findMissingRequired, type LengthColumn, type RequiredColumn } from '../listing-preflight.service.js'
import { conditionalRequirementIssues } from '../listing-wizard/conditional-requirements.js'
import { mirrorListingIssues } from '../listing-issues.service.js'

const amazonService = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazonService)
const flatFileService = new AmazonFlatFileService(prisma, schemaService)

export type PreflightSource = 'byte-length' | 'required' | 'conditional' | 'mirrored' | 'validation-preview'

export interface PreflightIssueItem {
  source: PreflightSource
  field: string | null
  severity: 'error' | 'warning'
  message: string
  code?: string
}
export interface PreflightDiffItem {
  field: string
  live: string | null
  pending: string | null
  changed: boolean
}
export interface PreflightListingReport {
  sku: string
  marketplace: string
  productType: string
  counts: { errors: number; warnings: number }
  issues: PreflightIssueItem[]
  diff: PreflightDiffItem[]
  validationPreview: 'ran' | 'skipped' | 'unavailable'
}
export interface PreflightReport {
  productId: string
  marketplace: string | null
  listings: PreflightListingReport[]
  summary: { listings: number; errors: number; warnings: number; blocked: number }
}

/** PURE — local schema-driven detectors on a built row. */
export function collectLocalIssues(
  row: Record<string, unknown>,
  ctx: {
    byteLimits: Record<string, number>
    requiredCols: RequiredColumn[]
    schemaDef: any
    labelOf: (id: string) => string
  },
): PreflightIssueItem[] {
  const out: PreflightIssueItem[] = []

  // byte-length (+ char fallback) on the columns that declare a cap
  const lengthCols: LengthColumn[] = Object.keys(row)
    .filter((k) => typeof row[k] === 'string')
    .map((k): LengthColumn | null => {
      const base = COCKPIT_EXPANDED_FIELDS[k] ?? k
      const cap = ctx.byteLimits[base]
      return typeof cap === 'number' ? { id: k, label: ctx.labelOf(base), maxUtf8ByteLength: cap } : null
    })
    .filter((c): c is LengthColumn => c !== null)
  for (const i of checkLengthLimits(row as Record<string, any>, lengthCols)) {
    out.push({ source: 'byte-length', field: i.field, severity: 'error', message: i.message })
  }

  // missing static required attributes
  for (const m of findMissingRequired(row as Record<string, any>, ctx.requiredCols)) {
    out.push({ source: 'required', field: m.id, severity: 'error', message: `Required attribute "${m.label}" is empty` })
  }

  // conditional (allOf) required-but-empty → advisory warnings
  for (const i of conditionalRequirementIssues(ctx.schemaDef, row as Record<string, any>, ctx.labelOf)) {
    out.push({ source: 'conditional', field: i.field, severity: 'warning', message: i.message })
  }

  return out
}

/** PURE — per-attribute diff of pending row values vs live Amazon state. */
export function buildDiff(
  live: { title?: string | null; price?: number | null; quantity?: number | null } | null,
  row: Record<string, unknown>,
): PreflightDiffItem[] {
  if (!live) return []
  const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
  const fields: Array<{ field: string; live: string | null; pending: string | null }> = [
    { field: 'item_name', live: s(live.title), pending: s(row.item_name) },
    { field: 'price', live: s(live.price), pending: s(row.purchasable_offer__our_price) },
    { field: 'quantity', live: s(live.quantity), pending: s(row.fulfillment_availability__quantity) },
  ]
  return fields
    .filter((f) => f.live !== null || f.pending !== null)
    .map((f) => ({ ...f, changed: f.live !== f.pending }))
}

/** Build the aggregated pre-flight report for a product's Amazon listings. */
export async function buildPreflightReport(
  productId: string,
  marketplace: string | null,
  opts: { live?: boolean } = {},
): Promise<PreflightReport> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { images: { select: { url: true, isPrimary: true, sortOrder: true, type: true } } },
  })
  if (!product) throw new Error('Product not found')

  let parentSku: string | null = null
  if (product.parentId) {
    const parent = await prisma.product.findUnique({ where: { id: product.parentId }, select: { sku: true } })
    parentSku = parent?.sku ?? null
  }

  const listings = await prisma.channelListing.findMany({
    where: { productId, channel: 'AMAZON', ...(marketplace ? { marketplace } : {}) },
  })

  const reports: PreflightListingReport[] = []
  for (const listing of listings) {
    const mp = String(listing.marketplace)
    const row = buildRow({ listing, product, marketplace: mp, parentSku })
    const productType = String(row.product_type ?? '')
    const issues: PreflightIssueItem[] = []
    let diff: PreflightDiffItem[] = []
    let validationPreview: PreflightListingReport['validationPreview'] = opts.live ? 'unavailable' : 'skipped'

    // ── schema-driven local detectors (no SP-API) ──
    try {
      const [hints, manifest, schema] = await Promise.all([
        flatFileService.getFeedSchemaHints(mp, productType),
        flatFileService.generateManifest(mp, productType),
        schemaService.getSchema({ channel: 'AMAZON', marketplace: mp, productType }),
      ])
      const cols = manifest.groups.flatMap((g) => g.columns)
      const labelMap = new Map(cols.map((c) => [c.id, c.labelEn]))
      const labelOf = (id: string) => labelMap.get(id) ?? id
      const requiredCols: RequiredColumn[] = cols.filter((c) => c.required).map((c) => ({ id: c.id, label: c.labelEn }))
      issues.push(...collectLocalIssues(row, {
        byteLimits: hints.byteLimits,
        requiredCols,
        schemaDef: (schema as any).schemaDefinition ?? {},
        labelOf,
      }))
    } catch (err) {
      logger.warn('preflight: local detectors failed', { sku: product.sku, marketplace: mp, error: err instanceof Error ? err.message : String(err) })
    }

    // ── mirrored open ListingIssue rows ──
    try {
      const open = await prisma.listingIssue.findMany({ where: { listingId: listing.id, resolvedAt: null } })
      for (const i of open) {
        issues.push({
          source: 'mirrored',
          field: i.attributeNames?.[0] ?? null,
          severity: i.severity === 'ERROR' ? 'error' : 'warning',
          message: i.message,
          code: i.code,
        })
      }
    } catch { /* table may be empty / new — non-fatal */ }

    // ── best-effort: diff vs live + VALIDATION_PREVIEW (SP-API) ──
    const sku = String(product.sku)
    const marketplaceId = MARKETPLACE_ID_MAP[mp.toUpperCase()] ?? MARKETPLACE_ID_MAP.IT
    try {
      const live = await amazonService.getListingState(listing.externalListingId || sku, marketplaceId)
      diff = buildDiff(live, row)
    } catch (err) {
      logger.info('preflight: live diff unavailable', { sku, marketplace: mp, error: err instanceof Error ? err.message : String(err) })
    }

    if (opts.live) {
      try {
        const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
        const hints = await flatFileService.getFeedSchemaHints(mp, productType)
        const feedBody = flatFileService.buildJsonFeedBody([row as any], mp, sellerId, COCKPIT_EXPANDED_FIELDS, hints)
        const msg = (JSON.parse(feedBody).messages ?? [])[0]
        const attrs = (msg?.attributes ?? {}) as Record<string, unknown>
        if (msg && String(msg.operationType) !== 'DELETE' && Object.keys(attrs).length > 0) {
          const preview = String(msg.operationType) === 'UPDATE'
            ? await amazonSpApiClient.validateListing({ sellerId, sku, marketplaceId, productType, attributes: attrs })
            : await amazonSpApiClient.validateListing({ sellerId, sku, marketplaceId, productType, patches: Object.entries(attrs).map(([k, v]) => ({ op: 'replace', path: `/attributes/${k}`, value: v })) })
          if (preview.available) {
            validationPreview = 'ran'
            await mirrorListingIssues(prisma, listing.id, (preview.issues ?? []).map((i: any) => ({ code: i.code, message: i.message, severity: i.severity, attributeNames: i.attributeNames, categories: i.categories })), 'validation-preview').catch(() => {})
            for (const i of preview.issues ?? []) {
              const sev = String((i as any).severity ?? 'ERROR').toUpperCase()
              issues.push({ source: 'validation-preview', field: (i as any).attributeNames?.[0] ?? null, severity: sev === 'ERROR' ? 'error' : 'warning', message: (i as any).message ?? '', code: (i as any).code })
            }
          }
        }
      } catch (err) {
        logger.info('preflight: VALIDATION_PREVIEW unavailable', { sku, marketplace: mp, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length
    const warnings = issues.length - errors
    reports.push({ sku, marketplace: mp, productType, counts: { errors, warnings }, issues, diff, validationPreview })
  }

  const errors = reports.reduce((n, r) => n + r.counts.errors, 0)
  const warnings = reports.reduce((n, r) => n + r.counts.warnings, 0)
  return {
    productId,
    marketplace,
    listings: reports,
    summary: { listings: reports.length, errors, warnings, blocked: reports.filter((r) => r.counts.errors > 0).length },
  }
}
