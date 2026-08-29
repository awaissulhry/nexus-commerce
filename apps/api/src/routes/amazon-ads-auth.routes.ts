/**
 * Amazon Advertising API — LWA OAuth flow.
 *
 * GET  /api/amazon-ads/auth/connect   → redirects to Amazon consent page
 * GET  /api/amazon-ads/auth/callback  → exchanges code for tokens,
 *                                       discovers profiles, saves connections
 *
 * After a successful callback all active AmazonAdsConnection rows are
 * created/updated with the encrypted refresh token.
 *
 * CX.3a: the same callback then DUAL-WRITES the grant into the connection core
 * (one `ChannelConnection` + one `ConnectionScope` per discovered profile), so
 * a reconnect updates both stores. This route keeps working because the Ads
 * console's allowed return URL points here and only the Owner can change it —
 * the dual-write is what lets the core catch up without waiting on that.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { encryptSecret } from '../lib/crypto.js'
import { logger } from '../utils/logger.js'
import { normalizeMarketplaceCode } from '../utils/marketplace-code.js'
import type { ConnectionIdentity } from '../services/cx/catalog.js'
import type { GrantResult } from '../services/cx/token.service.js'

// In-memory PKCE store — keyed by random state param, expires in 15 min.
// Acceptable for a single-operator setup flow (connect→callback in one session).
const PKCE_STORE = new Map<string, { verifier: string; expiresAt: number }>()

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url') // 43-char URL-safe string
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

const CLIENT_ID = process.env.AMAZON_ADS_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.AMAZON_ADS_CLIENT_SECRET ?? ''

// Must match what is registered in the LWA app console.
const REDIRECT_URI =
  process.env.AMAZON_ADS_REDIRECT_URI ??
  'https://nexusapi-production-b7bb.up.railway.app/api/amazon-ads/auth/callback'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

// Amazon Advertising API endpoint — EU covers IT/DE/FR/ES/UK.
const ADS_API_BASE = 'https://advertising-api-eu.amazon.com'

interface LWATokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

interface AdsProfile {
  profileId: number | string
  countryCode: string
  currencyCode: string
  timezone: string
  accountInfo: {
    marketplaceStringId: string
    id: string
    type: string
    name: string
  }
}

// CX.3a — this file used to carry its own marketplace map and two of its
// entries were WRONG: `A1RKKUPIHCS9HS` was mapped to 'DE' when it is ES, and
// `APJ6JRA9NG5V4` to 'ES' when it is IT. The canonical map in
// `utils/marketplace-code.ts` is the single source the rest of the codebase
// already uses, so the local one is deleted and this resolves through it.
//
// One id survives locally because the canonical map does not have it:
const MARKETPLACE_ID_NOT_IN_CANONICAL_MAP: Record<string, string> = {
  A1PA7PVP2ZEA0: 'IT',
}

/** SP-API marketplace id → 2-letter code, 'EU' when nothing can name it. */
function marketplaceCountry(marketplaceStringId: string): string {
  const canonical = normalizeMarketplaceCode(marketplaceStringId, '')
  if (canonical) return canonical
  return MARKETPLACE_ID_NOT_IN_CANONICAL_MAP[marketplaceStringId] ?? 'EU'
}

// The two scopes the live consent URL asks for. Recorded on the grant as
// `grantedScopes` so the Channels page compares like with like.
const ADS_SCOPES = ['profile', 'advertising::campaign_management']

/** What one discovered profile becomes in the core: a `ConnectionScope`. */
interface AdsScopeInput {
  externalId: string
  label: string
  region: string
  isActive: boolean
  metadata: Record<string, unknown>
}

/**
 * The account this grant belongs to, as the profiles report it.
 *
 * One Ads account fans out over N marketplace profiles, and every profile
 * carries the same `accountInfo.id` for that account — so the most common id
 * IS the account. Ties and empties resolve to null rather than to a guess:
 * `externalAccountId` is load-bearing for the active-account unique index, so
 * an invented value is worse than no value.
 */
function dominantIdentity(profiles: AdsProfile[]): ConnectionIdentity | null {
  const counts = new Map<string, { count: number; name: string }>()
  for (const p of profiles) {
    const id = p.accountInfo?.id
    if (!id) continue
    const hit = counts.get(id)
    if (hit) hit.count++
    else counts.set(id, { count: 1, name: p.accountInfo?.name ?? id })
  }
  let bestId: string | null = null
  let best: { count: number; name: string } | null = null
  for (const [id, v] of counts) {
    if (!best || v.count > best.count) {
      bestId = id
      best = v
    }
  }
  if (!bestId || !best) return null
  return { userId: bestId, username: best.name, extra: { distinctAccountIds: counts.size } }
}

/**
 * CX.3a — write the same grant into the connection core.
 *
 * One `ChannelConnection` for AMAZON_ADS plus one `ConnectionScope` per
 * discovered profile: a grant that covers N profiles is ONE grant, not nine
 * connections (which is exactly how nine copies of one client secret happened).
 * The credential itself goes through `storeGrant`, so it lands as an envelope
 * and no plaintext column is written.
 *
 * Called best-effort by the callback: the operator's connect has already
 * succeeded by this point, and the legacy rows remain the engine's fallback.
 */
async function dualWriteGrantToCore(input: {
  accessToken: string
  refreshToken: string
  expiresInSec: number
  identity: ConnectionIdentity | null
  scopes: AdsScopeInput[]
}): Promise<{ connectionId: string; scopeCount: number; event: 'grant' | 'reconsent' }> {
  // Registers the catalogue entries `storeGrant` reads. Idempotent — src/index.ts
  // already imports it at boot; this makes the route independent of that ordering.
  await import('../services/cx/connectors/index.js')
  const { storeGrant } = await import('../services/cx/token.service.js')

  const existing = await prisma.channelConnection.findFirst({
    where: { channelType: 'AMAZON_ADS' },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, credentialsEnc: true },
  })
  const connectionId =
    existing?.id ??
    (
      await prisma.channelConnection.create({
        data: {
          channelType: 'AMAZON_ADS',
          managedBy: 'oauth',
          // storeGrant flips isActive once the credentials are actually stored,
          // and authStatus is left 'unknown' for the heartbeat to decide — a
          // connect never gets to claim its own health.
          isActive: false,
          authStatus: 'unknown',
          region: 'EU',
          isPrimary: true,
        },
        select: { id: true },
      })
    ).id

  const event: 'grant' | 'reconsent' = existing?.credentialsEnc ? 'reconsent' : 'grant'
  const grant: GrantResult = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresInSec: input.expiresInSec,
    grantedScopes: ADS_SCOPES,
    identity: input.identity,
    region: 'EU',
  }
  await storeGrant(connectionId, grant, { kind: 'operator', userId: null }, event)

  for (const scope of input.scopes) {
    const data = {
      label: scope.label,
      region: scope.region,
      isActive: scope.isActive,
      metadata: scope.metadata as Prisma.InputJsonValue,
    }
    await prisma.connectionScope.upsert({
      where: { connectionId_kind_externalId: { connectionId, kind: 'profile', externalId: scope.externalId } },
      create: { connectionId, kind: 'profile', externalId: scope.externalId, ...data },
      update: data,
    })
  }

  return { connectionId, scopeCount: input.scopes.length, event }
}

const amazonAdsAuthRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Step 1: redirect operator to Amazon consent page ──────────────────
  fastify.get('/amazon-ads/auth/connect', async (_request, reply) => {
    if (!CLIENT_ID) {
      return reply.code(500).send({
        error: 'AMAZON_ADS_CLIENT_ID env var not set',
      })
    }

    // PKCE — generates a JWT-format access token instead of the legacy
    // Atza| opaque token. Required for Amazon Advertising API SP v3
    // profile-scoped endpoints which use a JWT validator.
    // CX.0: prune expired sessions so abandoned connects cannot grow the map.
    const now = Date.now()
    for (const [k, v] of PKCE_STORE) if (v.expiresAt <= now) PKCE_STORE.delete(k)

    const state = randomBytes(16).toString('hex')
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    PKCE_STORE.set(state, { verifier: codeVerifier, expiresAt: now + 15 * 60 * 1000 })

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: ADS_SCOPES.join(' '),
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    const consentUrl = `https://www.amazon.com/ap/oa?${params.toString()}`
    logger.info('[amazon-ads-auth] redirecting to PKCE consent page', { state })
    return reply.redirect(consentUrl)
  })

  // ── Step 2: exchange code for tokens, discover + save profiles ─────────
  fastify.get('/amazon-ads/auth/callback', async (request, reply) => {
    const { code, error, error_description, state } = request.query as Record<string, string>

    if (error) {
      logger.error('[amazon-ads-auth] OAuth error', { error, error_description })
      return reply.code(400).send({ error, error_description })
    }

    if (!code) {
      return reply.code(400).send({ error: 'missing_code' })
    }

    // CX.0 (S4): the state is mandatory and must match a session this server
    // minted; an unknown or expired state is rejected before any exchange.
    // (The in-memory store is replaced by OAuthSession in CX.1.)
    if (!state) {
      return reply.code(400).send({ error: 'missing_state' })
    }
    const pkce = PKCE_STORE.get(state)
    PKCE_STORE.delete(state) // one-time use
    if (!pkce || Date.now() >= pkce.expiresAt) {
      logger.warn('[amazon-ads-auth] callback with unknown or expired state')
      return reply.code(400).send({ error: 'invalid_state' })
    }

    // Exchange auth code for access + refresh tokens
    let tokens: LWATokenResponse
    try {
      const exchangeParams: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }
      // PKCE verifier is always sent (the state check above guarantees it) —
      // Amazon issues JWT-format access tokens instead of legacy Atza| ones.
      exchangeParams.code_verifier = pkce.verifier
      const tokenRes = await fetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(exchangeParams).toString(),
      })
      if (!tokenRes.ok) {
        const text = await tokenRes.text()
        throw new Error(`LWA token exchange failed ${tokenRes.status}: ${text}`)
      }
      tokens = (await tokenRes.json()) as LWATokenResponse
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[amazon-ads-auth] token exchange failed', { error: msg })
      return reply.code(500).send({ error: 'token_exchange_failed', detail: msg })
    }

    // Discover all advertising profiles this token can access
    let profiles: AdsProfile[]
    try {
      const profilesRes = await fetch(`${ADS_API_BASE}/v2/profiles`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Amazon-Advertising-API-ClientId': CLIENT_ID,
          'Content-Type': 'application/json',
        },
      })
      if (!profilesRes.ok) {
        const text = await profilesRes.text()
        throw new Error(`GET /v2/profiles failed ${profilesRes.status}: ${text}`)
      }
      profiles = (await profilesRes.json()) as AdsProfile[]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[amazon-ads-auth] profile discovery failed', { error: msg })
      return reply.code(500).send({ error: 'profile_discovery_failed', detail: msg })
    }

    if (!profiles.length) {
      return reply.code(404).send({ error: 'no_profiles_found', detail: 'The token has no advertising profiles. Check your Amazon Ads account has campaigns.' })
    }

    // Save each profile as an AmazonAdsConnection
    const saved: Array<{ profileId: string; marketplace: string; country: string }> = []
    // …and, in the same pass, the shape the connection core wants.
    const coreScopes: AdsScopeInput[] = []
    const credentialsEncrypted = encryptSecret(
      JSON.stringify({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: tokens.refresh_token,
      }),
    )

    // AX-IE.0 — this is the moment of consent, and from 2026-07-30 it starts a
    // 365-day clock on the refresh token. Stamping it here is the only way to know
    // a connection's real age; everything downstream (the countdown in account
    // settings, the /health alert) derives from these two columns. Observed, so
    // never an estimate — that flag exists solely for the pre-AX-IE.0 rows whose
    // true consent date is unrecoverable.
    const tokenIssuedAt = new Date()
    const tokenExpiresAt = new Date(tokenIssuedAt.getTime() + 365 * 24 * 60 * 60 * 1000)

    for (const profile of profiles) {
      const profileId = String(profile.profileId)
      const marketplaceStringId = profile.accountInfo?.marketplaceStringId ?? ''
      const country = profile.countryCode ?? marketplaceCountry(marketplaceStringId)
      const accountLabel = profile.accountInfo?.name ?? `Account ${profileId}`

      const row = await prisma.amazonAdsConnection.upsert({
        where: { profileId },
        create: {
          profileId,
          marketplace: marketplaceStringId,
          region: 'EU',
          accountLabel,
          credentialsEncrypted,
          mode: 'sandbox',
          isActive: true,
          tokenIssuedAt,
          tokenExpiresAt,
          tokenIssuedAtIsEstimate: false,
        },
        update: {
          marketplace: marketplaceStringId,
          accountLabel,
          credentialsEncrypted,
          isActive: true,
          // A fresh consent issues a fresh refresh token, so the clock restarts and
          // any inherited estimate is now superseded by an observed timestamp.
          tokenIssuedAt,
          tokenExpiresAt,
          tokenIssuedAtIsEstimate: false,
          updatedAt: new Date(),
        },
      })

      saved.push({ profileId, marketplace: marketplaceStringId, country })
      coreScopes.push({
        externalId: profileId,
        label: `${accountLabel} · ${country}`,
        region: row.region ?? 'EU',
        // A sandbox profile is a real profile we deliberately do not act on, so
        // it is recorded and marked inactive rather than dropped.
        isActive: row.mode === 'production',
        metadata: {
          marketplace: country,
          marketplaceStringId,
          mode: row.mode,
          writesEnabledAt: row.writesEnabledAt?.toISOString() ?? null,
          lastWriteAt: row.lastWriteAt?.toISOString() ?? null,
          legacyRowId: row.id,
        },
      })
      logger.info('[amazon-ads-auth] saved connection', { profileId, country, accountLabel })
    }

    // ── CX.3a — dual-write the same grant into the connection core ────────
    // Best effort ON PURPOSE: the operator's connect has already succeeded and
    // the engine reads the rows above, so a core write that fails must be a log
    // line, never a failed connect. The one-shot adopt job and the next
    // reconnect both close the gap.
    try {
      const core = await dualWriteGrantToCore({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresInSec: tokens.expires_in,
        identity: dominantIdentity(profiles),
        scopes: coreScopes,
      })
      logger.info('[amazon-ads-auth] grant dual-written to the connection core', {
        connectionId: core.connectionId,
        scopes: core.scopeCount,
        event: core.event,
      })
    } catch (err) {
      logger.error('[amazon-ads-auth] connection-core dual-write failed; legacy rows are saved', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // CX.3a — this page used to render the first 10 characters of the access
    // token. No token material reaches a response body: the format check below
    // needs the token's SHAPE, and none of its characters.
    const isJwt = tokens.access_token?.startsWith('eyJ') === true

    // CX.3a — the old link pointed at https://nexus-commerce-web.up.railway.app,
    // a host that no longer resolves. Amazon Ads is an account in Settings →
    // Channels now, so that is where the operator lands.
    const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/+$/, '')
    const channelsUrl = `${webBase}/settings/channels?tab=accounts`

    // Return a simple success page the operator can read in the browser
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Amazon Ads Connected</title>
<style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px}
.ok{color:#16a34a}.warn{color:#d97706}.card{border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:12px 0}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}</style>
</head>
<body>
<h2 class="ok">✓ Amazon Advertising API Connected</h2>
<p class="${isJwt ? 'ok' : 'warn'}">
  Token format: ${isJwt ? '✓ JWT (works with SP v3 campaign endpoints)' : '⚠ Legacy Atza| opaque token (SP v3 campaign endpoints may reject it)'}
</p>
<p>${saved.length} profile(s) saved and encrypted.</p>
${saved.map(p => `<div class="card">
  <strong>Profile ID:</strong> <code>${p.profileId}</code><br>
  <strong>Marketplace:</strong> <code>${p.marketplace}</code> (${p.country})
</div>`).join('')}
<hr>
<p><strong>Next steps:</strong></p>
<ol>
  <li>Go to <a href="${channelsUrl}">Settings → Channels → Accounts</a> and check the Amazon Ads row</li>
  <li>Set <code>NEXUS_AMAZON_ADS_MODE=live</code> in Railway env vars</li>
  <li>Set <code>NEXUS_ENABLE_AMAZON_ADS_CRON=1</code> in Railway env vars</li>
  <li>Click <strong>Enable writes</strong> when ready for bid automation</li>
</ol>
</body></html>`

    return reply.type('text/html').send(html)
  })

  // ── HB.1 — Amazon Ads 24-month backfill orchestrator ──────────────────
  //
  // POST /api/amazon-ads/backfill
  //   body: { daysBack?: number, reportSets?: string[], adProducts?: string[] }
  //
  // Fires N report-creation jobs (N = ceil(daysBack/30) × profiles ×
  // reportSets × adProducts) into the existing AmazonAdsReportJob queue.
  // The poll + ingest crons drain the queue async over the next 30-90
  // minutes (depends on Amazon Ads API processing time per report).
  //
  // Read-only against external state aside from creating async report
  // requests at Amazon. Idempotent: re-running re-fires identical jobs
  // (the existing dedup logic in createReportJob skips already-queued
  // (profile, reportTypeId, startDate, endDate) tuples).
  fastify.post<{
    Body?: {
      daysBack?: number
      reportSets?: Array<'campaign' | 'searchTerm' | 'placement'>
      adProducts?: Array<'SPONSORED_PRODUCTS' | 'SPONSORED_DISPLAY' | 'SPONSORED_BRANDS'>
    }
  }>('/amazon-ads/backfill', async (request, reply) => {
    const { runAdsBackfill } = await import('../services/advertising/ads-backfill-orchestrator.service.js')
    try {
      const result = await runAdsBackfill(request.body ?? {})
      return result
    } catch (err) {
      fastify.log.error({ err }, '[amazon-ads/backfill] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

export default amazonAdsAuthRoutes
