import type { TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../../db.js'
import { previewCatalogTransfer } from '../catalog-transfer.service.js'
import { readMappingImpact } from './impact.service.js'
import { mappingInputToken } from './review-inputs.js'
import { MappingConflict } from './revision-token.js'
import { mappingToken } from './revision-token.js'
import { getMappingForMarketplace } from '../schema-mapping.service.js'

/** A reviewed rule draft can instead become a one-time assignment to the exact existing
 * destinations in its review. The canonical transfer writer owns validation, version checks,
 * durable execution and per-destination results. It changes no shared product facts.
 */
export async function previewPresentationAssignment(jobId: string, userId: string | null) {
  const review = await readMappingImpact(jobId, userId)
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } })
  const payload = job?.changes as { inputToken?: string } | null
  if (!review || !job || !payload) return null
  if (review.state !== 'MAPPING_REVIEW' || !job.expiresAt || job.expiresAt < new Date()) throw new MappingConflict('Finish a fresh presentation review first')
  if (!review.presentationChange?.rule?.themeId || review.presentationChange.rule.order) throw new MappingConflict('One-time assignment currently supports a description theme. Variation-order and listing-preset assignments require their consumer integration.')
  if (mappingToken(await getMappingForMarketplace(review.channel, review.market)) !== review.token) throw new MappingConflict('Rules changed. Review the affected listings again')
  if (await mappingInputToken(review.channel, review.market) !== payload.inputToken) throw new MappingConflict('Inputs changed. Review the affected listings again')
  const rows: TransferRow[] = []
  let preserved = 0, excluded = 0
  for (let page = 0; page < review.pages; page++) {
    const part = page === 0 ? review : await readMappingImpact(jobId, userId, page)
    for (const raw of part?.rows ?? []) {
      const row = raw as { sku: string; accountId: string | null; listingId: string | null; aliasKey: string; field: string; after: unknown; changed: boolean; preserved: boolean; errors: string[]; language: string; matchesDraft?: boolean }
      if (row.field !== 'descriptionThemeId') continue
      if (row.preserved) { preserved++; continue }
      if (!row.matchesDraft || row.after !== review.presentationChange.rule.themeId || !row.listingId || !row.accountId || row.errors.length || !row.changed) { excluded++; continue }
      rows.push({ row: rows.length + 2, entity: 'Listings', sku: row.sku, channel: 'EBAY', accountId: row.accountId,
        marketplace: review.market, aliasKey: row.aliasKey, locale: row.language, field: 'descriptionThemeId', action: 'SET', value: row.after })
      if (rows.length > 5000) throw new MappingConflict('Narrow the matching scope to at most 5,000 listing assignments per review')
    }
  }
  if (!rows.length) throw new MappingConflict('No changed, valid existing listings remain after preserving customizations and excluding unattributed destinations')
  const preview = await previewCatalogTransfer({ rows, issues: [], mode: 'update', market: review.market,
    filename: `One-time presentation assignments from review ${jobId}`, userId })
  return { jobId: preview.jobId, href: `/products/catalog-transfer?job=${encodeURIComponent(preview.jobId)}`, preserved, excluded, assignments: rows.length }
}
