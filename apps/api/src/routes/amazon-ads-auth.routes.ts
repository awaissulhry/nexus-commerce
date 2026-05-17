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

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { encryptSecret } from '../lib/crypto.js'
import { logger } from '../utils/logger.js'

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
  // ── Debug: test auth step-by-step ─────────────────────────────────────
  // GET /api/amazon-ads/debug/test-auth
  // Returns token prefix, raw /v2/profiles response, and /sp/campaigns
  // response for the first active connection. Remove once auth is stable.
  fastify.get('/amazon-ads/debug/test-auth', async (_request, reply) => {
    const { default: prisma } = await import('../db.js')
    const { decryptSecret } = await import('../lib/crypto.js')

    const conn = await prisma.amazonAdsConnection.findFirst({ where: { isActive: true } })
    if (!conn?.credentialsEncrypted) {
      return reply.code(404).send({ error: 'no_active_connection' })
    }

    let creds: { clientId: string; clientSecret: string; refreshToken: string }
    try {
      creds = JSON.parse(decryptSecret(conn.credentialsEncrypted))
    } catch (err) {
      return reply.code(500).send({ error: 'decrypt_failed', detail: String(err) })
    }

    async function getToken(withScope: boolean) {
      const params: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }
      if (withScope) params.scope = 'advertising::campaign_management'
      const r = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      })
      const body = await r.json() as Record<string, unknown>
      return { ok: r.ok, status: r.status, body, token: r.ok ? body.access_token as string : null }
    }

    async function tryUrl(url: string, token: string, profileId?: string) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': creds.clientId,
      }
      if (profileId) headers['Amazon-Advertising-API-Scope'] = profileId
      const r = await fetch(url, { headers })
      let body: unknown
      try { body = await r.json() } catch { body = await r.text() }
      return { status: r.status, body }
    }

    // Token without scope (current approach)
    const t1 = await getToken(false)
    // Token WITH scope (might return different format)
    const t2 = await getToken(true)

    // Use IT profile for campaign tests (main Xavia market)
    const IT_PROFILE = '4117374346144545'

    const results: Record<string, unknown> = {
      tokenWithoutScope: t1.ok ? { prefix: t1.token!.slice(0, 15), length: t1.token!.length } : { error: t1.body },
      tokenWithScope:    t2.ok ? { prefix: t2.token!.slice(0, 15), length: t2.token!.length } : { error: t2.body },
    }

    if (t1.token) {
      // 1. v3 path, with scope header (current, failing)
      results.v3_withScope = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', t1.token, IT_PROFILE)
      // 2. v3 path, NO scope header (see what error changes)
      results.v3_noScope = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', t1.token)
      // 3. Old v2 path (might still work with Atza| tokens)
      results.v2_campaigns = await tryUrl('https://advertising-api-eu.amazon.com/v2/sp/campaigns', t1.token, IT_PROFILE)
      // 4. v3 with stateFilter (different URL)
      results.v3_withFilter = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns?stateFilter=enabled,paused,archived', t1.token, IT_PROFILE)
    }

    if (t2.token) {
      // 5. v3 path with scoped token
      results.v3_scopedToken = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', t2.token, IT_PROFILE)
    }

    return reply.send(results)
  })
  // ── Step 1: redirect operator to Amazon consent page ──────────────────
  fastify.get('/amazon-ads/auth/connect', async (_request, reply) => {
    if (!CLIENT_ID) {
      return reply.code(500).send({
        error: 'AMAZON_ADS_CLIENT_ID env var not set',
      })
    }

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'advertising::campaign_management',
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      state: 'nexus-ads-oauth',
    })

    const consentUrl = `https://www.amazon.com/ap/oa?${params.toString()}`
    logger.info('[amazon-ads-auth] redirecting to consent page', { consentUrl })
    return reply.redirect(consentUrl)
  })

  // ── Step 2: exchange code for tokens, discover + save profiles ─────────
  fastify.get('/amazon-ads/auth/callback', async (request, reply) => {
    const { code, error, error_description } = request.query as Record<string, string>

    if (error) {
      logger.error('[amazon-ads-auth] OAuth error', { error, error_description })
      return reply.code(400).send({ error, error_description })
    }

    if (!code) {
      return reply.code(400).send({ error: 'missing_code' })
    }

    // Exchange auth code for access + refresh tokens
    let tokens: LWATokenResponse
    try {
      const tokenRes = await fetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }).toString(),
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
        },
        update: {
          marketplace: marketplaceStringId,
          accountLabel,
          credentialsEncrypted,
          isActive: true,
          updatedAt: new Date(),
        },
      })

      saved.push({ profileId, marketplace: marketplaceStringId, country })
      logger.info('[amazon-ads-auth] saved connection', { profileId, country, accountLabel })
    }

    // Return a simple success page the operator can read in the browser
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Amazon Ads Connected</title>
<style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px}
.ok{color:#16a34a}.card{border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:12px 0}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}</style>
</head>
<body>
<h2 class="ok">✓ Amazon Advertising API Connected</h2>
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
}

export default amazonAdsAuthRoutes
