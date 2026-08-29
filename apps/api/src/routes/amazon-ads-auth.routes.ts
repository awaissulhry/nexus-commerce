/**
 * Amazon Advertising API — LWA OAuth flow.
 *
 * GET  /api/amazon-ads/auth/connect   → redirects to Amazon consent page
 * GET  /api/amazon-ads/auth/callback  → exchanges code for tokens,
 *                                       discovers profiles, saves connections
 *
 * After a successful callback all active AmazonAdsConnection rows are
 * created/updated with the encrypted refresh token. The operator then
 * goes to Settings → Advertising to test + enable live mode.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { encryptSecret } from '../lib/crypto.js'
import { logger } from '../utils/logger.js'

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

// Marketplace string ID → our short marketplace code
const MARKETPLACE_COUNTRY: Record<string, string> = {
  A1PA7PVP2ZEA0: 'IT',
  A1RKKUPIHCS9HS: 'DE',
  A13V1IB3VIYZZH: 'FR',
  APJ6JRA9NG5V4: 'ES',
  A1F83G8C2ARO7P: 'UK',
  ATVPDKIKX0DER: 'US',
  A2EUQ1WTGCTBG2: 'CA',
  A1VC38T7YXB528: 'JP',
  A39IBJ37TRP1C6: 'AU',
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
      scope: 'profile advertising::campaign_management',
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
      const country = profile.countryCode ?? MARKETPLACE_COUNTRY[marketplaceStringId] ?? 'EU'
      const accountLabel = profile.accountInfo?.name ?? `Account ${profileId}`

      await prisma.amazonAdsConnection.upsert({
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
      logger.info('[amazon-ads-auth] saved connection', { profileId, country, accountLabel })
    }

    const accessTokenPrefix = tokens.access_token?.slice(0, 10) ?? '?'
    const isJwt = tokens.access_token?.startsWith('eyJ')

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
  Token format: <code>${accessTokenPrefix}...</code> — ${isJwt ? '✓ JWT (will work with SP v3 campaign endpoints)' : '⚠ Legacy Atza| opaque token (SP v3 campaign endpoints may reject this)'}
</p>
<p>${saved.length} profile(s) saved and encrypted.</p>
${saved.map(p => `<div class="card">
  <strong>Profile ID:</strong> <code>${p.profileId}</code><br>
  <strong>Marketplace:</strong> <code>${p.marketplace}</code> (${p.country})
</div>`).join('')}
<hr>
<p><strong>Next steps:</strong></p>
<ol>
  <li>Go to <a href="https://nexus-commerce-web.up.railway.app/settings/advertising">Settings → Advertising</a></li>
  <li>Click <strong>Test</strong> to verify the connection</li>
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
