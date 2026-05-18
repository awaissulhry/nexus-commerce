/**
 * Phase A — Diagnostic probe harness for Amazon Advertising endpoints.
 *
 * Pure read-only diagnostic. Calls every endpoint variant we care about
 * for SP / SB / SD / Exports, captures the full response (status + first
 * 200 chars of body + key response headers), and returns a structured
 * report. No DB writes, no production code-path changes.
 *
 * Use this to determine — without committing to a migration — which
 * endpoint shape Amazon actually accepts for the current LWA token.
 * Output feeds the Phase B/C decision: try direct v3 list, or skip
 * straight to Exports v1.
 *
 * Manual-trigger only; not wired into any cron. Each invocation issues
 * 12+ requests to Amazon — don't loop this.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { decryptSecret } from '../../lib/crypto.js'

const REGION_ENDPOINT: Record<string, string> = {
  EU: 'https://advertising-api-eu.amazon.com',
  NA: 'https://advertising-api.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

// ── Independent LWA token fetch ──────────────────────────────────────
// Re-implemented locally rather than reusing ads-api-client.getLwaToken
// so the probe doesn't share the production token cache. Avoids the
// "did probe pollute live state?" question entirely.

interface ProbeCredentials { clientId: string; clientSecret: string; refreshToken: string }

async function probeLwaToken(creds: ProbeCredentials): Promise<{
  accessToken: string | null
  status: number
  responseSnippet: string
}> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: creds.refreshToken,
      client_id:     creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    return { accessToken: null, status: res.status, responseSnippet: text.slice(0, 200) }
  }
  let parsed: { access_token?: string; scope?: string }
  try { parsed = JSON.parse(text) } catch { return { accessToken: null, status: res.status, responseSnippet: text.slice(0, 200) } }
  return {
    accessToken: parsed.access_token ?? null,
    status: res.status,
    responseSnippet: `token issued · scopes=${parsed.scope ?? 'unknown'}`,
  }
}

// ── Probe variants ───────────────────────────────────────────────────

interface ProbeVariant {
  id: string
  description: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  acceptHeader?: string
  contentTypeHeader?: string
  /** When true, omit the Amazon-Advertising-API-Scope header (profile-agnostic probes). */
  profileAgnostic?: boolean
}

const PROBE_VARIANTS: ProbeVariant[] = [
  // ── Sanity / token introspection ────────────────────────────────────
  {
    id: 'profiles_v2',
    description: 'GET /v2/profiles (sanity: known to work, no profile scope)',
    method: 'GET', path: '/v2/profiles',
    profileAgnostic: true,
  },

  // ── Sponsored Products: legacy + v3 + exports ────────────────────────
  {
    id: 'sp_v2_get',
    description: 'GET /sp/campaigns (current failing path — legacy v2)',
    method: 'GET', path: '/sp/campaigns',
  },
  {
    id: 'sp_v3_list',
    description: 'POST /sp/campaigns/list (v3 unified list with versioned MIME)',
    method: 'POST', path: '/sp/campaigns/list',
    acceptHeader: 'application/vnd.spCampaign.v3+json',
    contentTypeHeader: 'application/vnd.spCampaign.v3+json',
    body: { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 5 },
  },
  {
    id: 'sp_v3_list_minimal',
    description: 'POST /sp/campaigns/list with empty body (probe minimum filter)',
    method: 'POST', path: '/sp/campaigns/list',
    acceptHeader: 'application/vnd.spCampaign.v3+json',
    contentTypeHeader: 'application/vnd.spCampaign.v3+json',
    body: { maxResults: 1 },
  },

  // ── Sponsored Brands ─────────────────────────────────────────────────
  {
    id: 'sb_v2_get',
    description: 'GET /sb/v4/campaigns (legacy SB v4)',
    method: 'GET', path: '/sb/v4/campaigns',
  },
  {
    id: 'sb_v4_list',
    description: 'POST /sb/v4/campaigns/list (SB v4 unified list)',
    method: 'POST', path: '/sb/v4/campaigns/list',
    acceptHeader: 'application/vnd.sbcampaignresource.v4+json',
    contentTypeHeader: 'application/vnd.sbcampaignresource.v4+json',
    body: { maxResults: 5 },
  },

  // ── Sponsored Display (working baseline) ─────────────────────────────
  {
    id: 'sd_v2_get',
    description: 'GET /sd/campaigns (currently live & working — baseline)',
    method: 'GET', path: '/sd/campaigns',
  },

  // ── Exports API v1 (the "unified" target) ────────────────────────────
  {
    id: 'exports_v1_campaigns_sp',
    description: 'POST /campaigns/export (Exports v1, SPONSORED_PRODUCTS)',
    method: 'POST', path: '/campaigns/export',
    acceptHeader: 'application/vnd.campaignsexport.v1+json',
    contentTypeHeader: 'application/vnd.campaignsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS'] },
  },
  {
    id: 'exports_v1_campaigns_sb',
    description: 'POST /campaigns/export (Exports v1, SPONSORED_BRANDS)',
    method: 'POST', path: '/campaigns/export',
    acceptHeader: 'application/vnd.campaignsexport.v1+json',
    contentTypeHeader: 'application/vnd.campaignsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_BRANDS'] },
  },
  {
    id: 'exports_v1_campaigns_sd',
    description: 'POST /campaigns/export (Exports v1, SPONSORED_DISPLAY)',
    method: 'POST', path: '/campaigns/export',
    acceptHeader: 'application/vnd.campaignsexport.v1+json',
    contentTypeHeader: 'application/vnd.campaignsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_DISPLAY'] },
  },
  {
    id: 'exports_v1_adgroups_sp',
    description: 'POST /adGroups/export (Exports v1, ad-group level)',
    method: 'POST', path: '/adGroups/export',
    acceptHeader: 'application/vnd.adgroupsexport.v1+json',
    contentTypeHeader: 'application/vnd.adgroupsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS'] },
  },
  {
    id: 'exports_v1_targets_sp',
    description: 'POST /targets/export (Exports v1, keyword/target level)',
    method: 'POST', path: '/targets/export',
    acceptHeader: 'application/vnd.targetsexport.v1+json',
    contentTypeHeader: 'application/vnd.targetsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS'] },
  },

  // ── H.1: Amazon Ads API v1 unified discovery ──────────────────────
  // The probes above test single-adProduct calls. The new unified v1
  // model uses adProductFilter arrays to scope across SP/SB/SD/STV/DSP
  // in a single request. The following probes verify the unified
  // multi-product call shape, plus expansion endpoints we haven't
  // touched (ads, negativeTargets, portfolios) that are part of the
  // v1 surface.

  {
    id: 'v1_campaigns_export_multi',
    description: 'POST /campaigns/export with [SP, SB, SD] in a single call (true v1 unified)',
    method: 'POST', path: '/campaigns/export',
    acceptHeader: 'application/vnd.campaignsexport.v1+json',
    contentTypeHeader: 'application/vnd.campaignsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] },
  },
  {
    id: 'v1_adgroups_export_multi',
    description: 'POST /adGroups/export with [SP, SB, SD] (v1 unified ad-group level)',
    method: 'POST', path: '/adGroups/export',
    acceptHeader: 'application/vnd.adgroupsexport.v1+json',
    contentTypeHeader: 'application/vnd.adgroupsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] },
  },
  {
    id: 'v1_targets_export_multi',
    description: 'POST /targets/export with [SP, SB] (v1 unified targets — SD has no targets)',
    method: 'POST', path: '/targets/export',
    acceptHeader: 'application/vnd.targetsexport.v1+json',
    contentTypeHeader: 'application/vnd.targetsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'] },
  },
  {
    id: 'v1_ads_export_sp',
    description: 'POST /ads/export (v1 ad-level for SP product-ad ASINs)',
    method: 'POST', path: '/ads/export',
    acceptHeader: 'application/vnd.adsexport.v1+json',
    contentTypeHeader: 'application/vnd.adsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS'] },
  },
  {
    id: 'v1_ads_export_sb',
    description: 'POST /ads/export (v1 ad-level for SB creatives — headlines, brand logo)',
    method: 'POST', path: '/ads/export',
    acceptHeader: 'application/vnd.adsexport.v1+json',
    contentTypeHeader: 'application/vnd.adsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_BRANDS'] },
  },
  {
    id: 'v1_negative_targets_export',
    description: 'POST /negativeTargets/export (v1 negative kw/target — closes Insights loop)',
    method: 'POST', path: '/negativeTargets/export',
    acceptHeader: 'application/vnd.negativetargetsexport.v1+json',
    contentTypeHeader: 'application/vnd.negativetargetsexport.v1+json',
    body: { adProductFilter: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'] },
  },
  {
    id: 'v1_portfolios_export',
    description: 'POST /portfolios/export (v1 portfolios — budget grouping)',
    method: 'POST', path: '/portfolios/export',
    acceptHeader: 'application/vnd.portfoliosexport.v1+json',
    contentTypeHeader: 'application/vnd.portfoliosexport.v1+json',
    body: {},
  },
]

// ── Probe executor ───────────────────────────────────────────────────

export interface ProbeResult {
  id: string
  description: string
  method: string
  path: string
  status: number
  ok: boolean
  durationMs: number
  responseSnippet: string
  responseHeaders: Record<string, string>
  requestHeaders: Record<string, string>
}

async function runProbe(
  baseUrl: string,
  variant: ProbeVariant,
  token: string,
  clientId: string,
  profileId: string,
): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': clientId,
  }
  if (!variant.profileAgnostic) headers['Amazon-Advertising-API-Scope'] = profileId
  if (variant.acceptHeader) headers['Accept'] = variant.acceptHeader
  if (variant.body != null) {
    headers['Content-Type'] = variant.contentTypeHeader ?? 'application/json'
  }

  const url = `${baseUrl}${variant.path}`
  const startedAt = Date.now()
  let status = 0
  let snippet = ''
  let responseHeaders: Record<string, string> = {}
  try {
    const res = await fetch(url, {
      method: variant.method,
      headers,
      body: variant.body != null ? JSON.stringify(variant.body) : undefined,
    })
    status = res.status
    res.headers.forEach((v, k) => { responseHeaders[k] = v })
    const text = await res.text()
    snippet = text.slice(0, 1200)
  } catch (err) {
    snippet = `[network error] ${err instanceof Error ? err.message : String(err)}`
  }
  const durationMs = Date.now() - startedAt

  // Redact Authorization in the echo of request headers
  const requestHeaders = { ...headers, Authorization: 'Bearer Atza|***REDACTED***' }

  return {
    id: variant.id,
    description: variant.description,
    method: variant.method,
    path: variant.path,
    status,
    ok: status >= 200 && status < 300,
    durationMs,
    responseSnippet: snippet,
    responseHeaders,
    requestHeaders,
  }
}

// ── Public entry point ───────────────────────────────────────────────

export interface ProbeReport {
  profileId: string
  marketplace: string | null
  region: string
  baseUrl: string
  generatedAt: string
  token: { acquired: boolean; status: number; snippet: string }
  results: ProbeResult[]
  summary: {
    total: number
    passed: number
    failed: number
    passedIds: string[]
    failedIds: string[]
  }
}

export async function probeAdvertisingEndpoints(args: {
  profileId: string
}): Promise<ProbeReport> {
  const generatedAt = new Date().toISOString()

  // 1. Load connection + credentials
  const conn = await prisma.amazonAdsConnection.findUnique({
    where: { profileId: args.profileId },
    select: { profileId: true, marketplace: true, region: true, credentialsEncrypted: true },
  })
  if (!conn) throw new Error(`no AmazonAdsConnection for profileId=${args.profileId}`)
  if (!conn.credentialsEncrypted) throw new Error('credentialsEncrypted is empty')

  const region = (conn.region ?? 'EU') as keyof typeof REGION_ENDPOINT
  const baseUrl = REGION_ENDPOINT[region] ?? REGION_ENDPOINT.EU
  const creds = JSON.parse(decryptSecret(conn.credentialsEncrypted)) as ProbeCredentials

  // 2. Acquire a fresh token (doesn't touch the production cache)
  const tokenResult = await probeLwaToken(creds)
  if (!tokenResult.accessToken) {
    return {
      profileId: args.profileId, marketplace: conn.marketplace, region, baseUrl, generatedAt,
      token: { acquired: false, status: tokenResult.status, snippet: tokenResult.responseSnippet },
      results: [],
      summary: { total: 0, passed: 0, failed: 0, passedIds: [], failedIds: [] },
    }
  }

  logger.info('[ads-probe] starting probes', {
    profileId: args.profileId, region, variantCount: PROBE_VARIANTS.length,
  })

  // 3. Run probes sequentially with a small delay — keep volume light
  const results: ProbeResult[] = []
  for (const variant of PROBE_VARIANTS) {
    const r = await runProbe(baseUrl, variant, tokenResult.accessToken, creds.clientId, args.profileId)
    results.push(r)
    // 200 ms spacing — avoids any per-IP rate-limit weirdness
    await new Promise((r) => setTimeout(r, 200))
  }

  const passedIds = results.filter((r) => r.ok).map((r) => r.id)
  const failedIds = results.filter((r) => !r.ok).map((r) => r.id)

  return {
    profileId: args.profileId,
    marketplace: conn.marketplace,
    region,
    baseUrl,
    generatedAt,
    token: {
      acquired: true,
      status: tokenResult.status,
      snippet: tokenResult.responseSnippet,
    },
    results,
    summary: {
      total: results.length,
      passed: passedIds.length,
      failed: failedIds.length,
      passedIds,
      failedIds,
    },
  }
}
