/**
 * Phase 9 — Amazon A+ Content metadata reconciliation.
 *
 * Pulls /aplus/2020-11-01/contentDocuments (paginated metadata list) and
 * upserts one APlusContent row per document. Idempotent on the
 * `amazonDocumentId` (= Amazon's contentReferenceKey).
 *
 * v1 scope: metadata only — name, status, marketplace, locale, A+ document id.
 * Full module body extraction would require GET /contentDocuments/{key} per row
 * (72 docs = 72 calls) and a mapping from Amazon's 17 module schemas to our
 * APlusModule schema. Deferred until operators ask for it.
 *
 * Operators get visibility today: "Amazon side has 72 A+ docs, here they are."
 * From there they can edit/create new ones via the existing Nexus UI; existing
 * ones can be deep-pulled on demand later.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

interface AmazonContentMetadataRecord {
  contentReferenceKey: string
  contentMetadata?: {
    name?: string
    marketplaceId?: string
    status?: string  // 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED' | 'REJECTED'
    badgeSet?: string[]
    updateTime?: string
    contentSubType?: string  // 'EBC' | 'BRAND_STORY' (we filter to EBC)
    contentType?: string
  }
}

interface AplusListResponse {
  contentMetadataRecords?: AmazonContentMetadataRecord[]
  nextPageToken?: string
  warnings?: unknown
  // SP-API sometimes wraps in payload
  payload?: AplusListResponse
}

async function getLwaAccessToken(): Promise<string> {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('LWA credentials missing')
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  })
  if (!res.ok) throw new Error(`LWA failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

export interface AplusPullSummary {
  documentsListed: number
  documentsUpserted: number
  documentsSkipped: number
  pages: number
  durationMs: number
  errors: Array<{ contentReferenceKey: string; error: string }>
}

/**
 * Pull all A+ Content metadata for the given marketplace and upsert into
 * APlusContent. Returns count of new vs existing.
 */
export async function pullAPlusContentMetadata(opts: {
  marketplaceId?: string
} = {}): Promise<AplusPullSummary> {
  const t0 = Date.now()
  const marketplaceId = opts.marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  const region = (process.env.AMAZON_REGION ?? 'eu') as string
  const host = `sellingpartnerapi-${region}.amazon.com`

  const accessToken = await getLwaAccessToken()

  const collected: AmazonContentMetadataRecord[] = []
  let nextPageToken: string | undefined
  let pages = 0
  while (true) {
    const params = new URLSearchParams({
      marketplaceId,
      pageSize: '20',
      ...(nextPageToken ? { pageToken: nextPageToken } : {}),
    })
    const res = await fetch(
      `https://${host}/aplus/2020-11-01/contentDocuments?${params.toString()}`,
      { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`aplus listDocs ${res.status}: ${body.slice(0, 200)}`)
    }
    const raw = (await res.json()) as AplusListResponse
    // SP-API sometimes wraps in {payload: ...}, sometimes flat. Unwrap defensively.
    const data = raw.payload ?? raw
    const records = data.contentMetadataRecords ?? []
    collected.push(...records)
    pages++
    nextPageToken = data.nextPageToken
    if (!nextPageToken || pages >= 50) break
    await new Promise((r) => setTimeout(r, 250))
  }

  logger.info('[aplus-pull] Listed', { documents: collected.length, pages })

  // HB.8 — canonical 2-letter code (IT / DE / ES / FR / UK / …). The
  // legacy 'AMAZON_XX' prefixed form is migrated to plain code in the
  // 20260521_hb8_marketplace_code_sweep migration; this writer must
  // produce the same shape so re-ingests don't re-introduce the prefix.
  const marketplaceRow = await prisma.marketplace.findFirst({
    where: { channel: 'AMAZON', marketplaceId },
    select: { code: true },
  })
  const marketCode = marketplaceRow?.code ?? marketplaceId.slice(0, 6)

  const errors: AplusPullSummary['errors'] = []
  let upserted = 0
  let skipped = 0
  for (const record of collected) {
    try {
      const refKey = record.contentReferenceKey
      const m = record.contentMetadata ?? {}
      // Filter to EBC (A+ Content); Brand Stories have contentSubType=STORY
      // and are handled separately. Default to processing if subType missing.
      if (m.contentSubType && m.contentSubType !== 'EBC') {
        skipped++
        continue
      }

      // Upsert by amazonDocumentId (= Amazon's contentReferenceKey)
      const existing = await (prisma as any).aPlusContent.findFirst({
        where: { amazonDocumentId: refKey },
        select: { id: true },
      })

      const locale = 'it-IT' // Default Italian; Amazon's list endpoint doesn't expose locale per doc

      // Amazon's `updateTime` reflects when the document was last
      // modified server-side. For PUBLISHED status this is effectively
      // the publish time; for DRAFT/SUBMITTED it's the last edit time.
      // Populating both submittedAt + publishedAt from updateTime is a
      // best-effort approximation that beats leaving them NULL
      // (otherwise dashboards see "all submitted/published today").
      const updateTime = m.updateTime ? new Date(m.updateTime) : null
      const submittedAt = updateTime && ['SUBMITTED','APPROVED','PUBLISHED'].includes(m.status ?? '') ? updateTime : null
      const publishedAt = updateTime && m.status === 'PUBLISHED' ? updateTime : null

      if (existing) {
        await (prisma as any).aPlusContent.update({
          where: { id: existing.id },
          data: {
            name: m.name ?? `(Untitled ${refKey.slice(0, 8)})`,
            marketplace: marketCode,
            status: m.status ?? 'PUBLISHED',
            ...(submittedAt && { submittedAt }),
            ...(publishedAt && { publishedAt }),
          },
        })
      } else {
        await (prisma as any).aPlusContent.create({
          data: {
            name: m.name ?? `(Untitled ${refKey.slice(0, 8)})`,
            marketplace: marketCode,
            locale,
            status: m.status ?? 'PUBLISHED',
            amazonDocumentId: refKey,
            submittedAt,
            publishedAt,
            notes: 'Imported via aplus-pull (metadata only — body modules not extracted)',
          },
        })
      }
      upserted++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push({ contentReferenceKey: record.contentReferenceKey, error: msg })
      logger.warn('[aplus-pull] upsert failed', {
        contentReferenceKey: record.contentReferenceKey,
        error: msg,
      })
    }
  }

  return {
    documentsListed: collected.length,
    documentsUpserted: upserted,
    documentsSkipped: skipped,
    pages,
    durationMs: Date.now() - t0,
    errors,
  }
}
