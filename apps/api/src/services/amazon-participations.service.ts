/**
 * M1 — refresh SP-API marketplace participations and persist to DB.
 *
 * Calls `GET /sellers/v1/marketplaceParticipations` and reconciles the
 * response with our `Marketplace` rows. Each Amazon marketplace gets
 * its `isParticipating` / `participationStatus` / `participationCheckedAt`
 * fields updated. Marketplaces not returned by SP-API stay at
 * `isParticipating=false` (they were probably never authorized).
 *
 * Idempotent and read-only against external state — safe to run from
 * any operator-triggered route or scheduled job.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

interface SpapiParticipation {
  marketplace?: {
    id?: string
    name?: string
    countryCode?: string
    defaultCurrencyCode?: string
    defaultLanguageCode?: string
    domainName?: string
  }
  participation?: {
    isParticipating?: boolean
    hasSuspendedListings?: boolean
  }
}

export type ParticipationStatus =
  | 'PARTICIPATING'
  | 'SUSPENDED'
  | 'NOT_PARTICIPATING'
  | 'ACCESS_DENIED'
  | 'UNKNOWN'

export interface ParticipationRefreshResult {
  ranAt: string
  durationMs: number
  rowsReturned: number
  upserted: number
  marketplaces: Array<{
    marketplaceId: string
    code: string | null
    status: ParticipationStatus
    isParticipating: boolean
  }>
  warnings: string[]
}

async function getLwaAccessToken(): Promise<string> {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('LWA credentials missing (need AMAZON_LWA_CLIENT_ID + AMAZON_LWA_CLIENT_SECRET + AMAZON_REFRESH_TOKEN)')
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
  if (!res.ok) {
    throw new Error(`LWA token exchange failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

function deriveStatus(p: SpapiParticipation): ParticipationStatus {
  if (p.participation?.isParticipating === false) return 'NOT_PARTICIPATING'
  if (p.participation?.hasSuspendedListings) return 'SUSPENDED'
  if (p.participation?.isParticipating === true) return 'PARTICIPATING'
  return 'UNKNOWN'
}

export async function refreshAmazonParticipations(): Promise<ParticipationRefreshResult> {
  const t0 = Date.now()
  const warnings: string[] = []
  const region = process.env.AMAZON_REGION ?? 'eu'
  const host = `sellingpartnerapi-${region}.amazon.com`

  const accessToken = await getLwaAccessToken()

  const res = await fetch(`https://${host}/sellers/v1/marketplaceParticipations`, {
    headers: { 'x-amz-access-token': accessToken },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getMarketplaceParticipations failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { payload?: SpapiParticipation[] }
  const participations = data.payload ?? []
  logger.info('[amazon-participations] SP-API returned', { count: participations.length })

  const now = new Date()
  const marketplaces: ParticipationRefreshResult['marketplaces'] = []
  let upserted = 0

  for (const p of participations) {
    const mid = p.marketplace?.id
    if (!mid) {
      warnings.push('SP-API row missing marketplace.id; skipping')
      continue
    }

    const status = deriveStatus(p)
    const isParticipating = status === 'PARTICIPATING' || status === 'SUSPENDED'

    // Update our Marketplace row, if it exists. We never auto-create
    // marketplace rows here — Marketplace is a curated reference table
    // seeded by marketplaces.routes.ts. SP-API may return marketplaces
    // we don't track yet (e.g. SA, AE) — those become warnings.
    const existing = await prisma.marketplace.findFirst({
      where: { channel: 'AMAZON', marketplaceId: mid },
      select: { id: true, code: true },
    })
    if (!existing) {
      warnings.push(
        `SP-API reports marketplace ${p.marketplace?.countryCode ?? mid} (${mid}) which is not in our Marketplace table`,
      )
      marketplaces.push({
        marketplaceId: mid,
        code: null,
        status,
        isParticipating,
      })
      continue
    }

    await prisma.marketplace.update({
      where: { id: existing.id },
      data: {
        isParticipating,
        participationStatus: status,
        participationCheckedAt: now,
      },
    })
    upserted++
    marketplaces.push({
      marketplaceId: mid,
      code: existing.code,
      status,
      isParticipating,
    })
  }

  // Marketplaces in our DB but NOT returned by SP-API → mark as
  // NOT_PARTICIPATING (they're configured locally but auth doesn't cover
  // them).
  const seenIds = new Set(
    participations
      .map((p) => p.marketplace?.id)
      .filter((v): v is string => Boolean(v)),
  )
  const ours = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', marketplaceId: { not: null } },
    select: { id: true, code: true, marketplaceId: true },
  })
  for (const row of ours) {
    if (!row.marketplaceId || seenIds.has(row.marketplaceId)) continue
    await prisma.marketplace.update({
      where: { id: row.id },
      data: {
        isParticipating: false,
        participationStatus: 'NOT_PARTICIPATING',
        participationCheckedAt: now,
      },
    })
    marketplaces.push({
      marketplaceId: row.marketplaceId,
      code: row.code,
      status: 'NOT_PARTICIPATING',
      isParticipating: false,
    })
  }

  const durationMs = Date.now() - t0
  logger.info('[amazon-participations] refresh complete', {
    rowsReturned: participations.length,
    upserted,
    warnings: warnings.length,
    durationMs,
  })

  return {
    ranAt: now.toISOString(),
    durationMs,
    rowsReturned: participations.length,
    upserted,
    marketplaces,
    warnings,
  }
}

/** Convenience: list the SP-API marketplaceIds we should fan out backfills
 *  across (only those with `isParticipating=true AND isActive=true`). */
export async function getParticipatingAmazonMarketplaceIds(): Promise<
  Array<{ id: string; code: string }>
> {
  const rows = await prisma.marketplace.findMany({
    where: {
      channel: 'AMAZON',
      isActive: true,
      isParticipating: true,
      marketplaceId: { not: null },
    },
    select: { code: true, marketplaceId: true },
    orderBy: { code: 'asc' },
  })
  return rows
    .filter((r): r is { code: string; marketplaceId: string } => Boolean(r.marketplaceId))
    .map((r) => ({ id: r.marketplaceId, code: r.code }))
}
