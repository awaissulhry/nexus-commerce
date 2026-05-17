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

    async function getToken(scope?: string) {
      const params: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }
      if (scope) params.scope = scope
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
    const t1 = await getToken()
    // Token with profile + campaign scope (matches new connect URL)
    const t2 = await getToken('profile advertising::campaign_management')

    // Use IT profile for campaign tests (main Xavia market)
    const IT_PROFILE = '4117374346144545'

    const results: Record<string, unknown> = {
      // Show exactly which credentials are stored in the DB for this connection
      credentialsInDb: {
        profileId: conn.profileId,
        clientIdStored: creds.clientId,          // must == AMAZON_ADS_CLIENT_ID
        clientIdMatchesEnvVar: creds.clientId === process.env.AMAZON_ADS_CLIENT_ID,
        envVarClientId: process.env.AMAZON_ADS_CLIENT_ID ?? '(not set)',
        hasClientSecret: !!creds.clientSecret,
        refreshTokenPrefix: creds.refreshToken?.slice(0, 15),
      },
      tokenWithoutScope: t1.ok ? { prefix: t1.token!.slice(0, 15), length: t1.token!.length } : { error: t1.body },
      tokenWithScope:    t2.ok ? { prefix: t2.token!.slice(0, 15), length: t2.token!.length } : { error: t2.body },
    }

    // Test client_credentials grant — might return JWT (eyJ...) instead of Atza|
    const ccRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: 'advertising::campaign_management',
      }).toString(),
    })
    const ccBody = await ccRes.json() as Record<string, unknown>
    const ccToken = ccBody.access_token as string | undefined
    results.clientCredentialsToken = {
      status: ccRes.status,
      ok: ccRes.ok,
      tokenPrefix: ccToken?.slice(0, 20),
      tokenLength: ccToken?.length,
      tokenType: ccBody.token_type,
      error: ccRes.ok ? undefined : ccBody,
    }

    if (t1.token) {
      // Baseline (known failing)
      results.v3_refreshToken = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', t1.token, IT_PROFILE)

      // Try entity ID as Amazon-Advertising-API-ClientId instead of LWA client ID
      const ENTITY_ID = 'A1VRHKTGYO1JNU'
      const entityClientRes = await fetch('https://advertising-api-eu.amazon.com/sp/campaigns', {
        headers: {
          Authorization: `Bearer ${t1.token}`,
          'Amazon-Advertising-API-ClientId': ENTITY_ID,
          'Amazon-Advertising-API-Scope': IT_PROFILE,
        },
      })
      let entityClientBody: unknown
      try { entityClientBody = await entityClientRes.json() } catch { entityClientBody = await entityClientRes.text() }
      results.v3_entityAsClientId = { status: entityClientRes.status, body: entityClientBody }

      // Try with no ClientId header at all
      const noClientIdRes = await fetch('https://advertising-api-eu.amazon.com/sp/campaigns', {
        headers: {
          Authorization: `Bearer ${t1.token}`,
          'Amazon-Advertising-API-Scope': IT_PROFILE,
        },
      })
      let noClientIdBody: unknown
      try { noClientIdBody = await noClientIdRes.json() } catch { noClientIdBody = await noClientIdRes.text() }
      results.v3_noClientId = { status: noClientIdRes.status, body: noClientIdBody }
    }

    // Try client_credentials token with /sp/campaigns
    if (ccToken) {
      results.v3_clientCredentials = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', ccToken, IT_PROFILE)
    }

    // Try refresh token with openid scope → might return JWT
    const oidcRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: 'openid advertising::campaign_management',
      }).toString(),
    })
    const oidcBody = await oidcRes.json() as Record<string, unknown>
    const oidcToken = (oidcBody.access_token ?? oidcBody.id_token) as string | undefined
    results.oidcToken = {
      status: oidcRes.status,
      ok: oidcRes.ok,
      tokenPrefix: oidcToken?.slice(0, 20),
      tokenLength: oidcToken?.length,
      error: oidcRes.ok ? undefined : oidcBody,
    }

    if (oidcToken && oidcRes.ok) {
      results.v3_oidcToken = await tryUrl('https://advertising-api-eu.amazon.com/sp/campaigns', oidcToken, IT_PROFILE)
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

    // PKCE — generates a JWT-format access token instead of the legacy
    // Atza| opaque token. Required for Amazon Advertising API SP v3
    // profile-scoped endpoints which use a JWT validator.
    const state = randomBytes(16).toString('hex')
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    PKCE_STORE.set(state, { verifier: codeVerifier, expiresAt: Date.now() + 15 * 60 * 1000 })

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

    // Retrieve PKCE code_verifier from in-memory store
    const pkce = state ? PKCE_STORE.get(state) : undefined
    if (pkce) PKCE_STORE.delete(state) // one-time use

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
      // Include PKCE verifier if this flow used it — causes Amazon to issue
      // JWT-format access tokens instead of legacy Atza| opaque tokens.
      if (pkce && Date.now() < pkce.expiresAt) {
        exchangeParams.code_verifier = pkce.verifier
      }
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
}

export default amazonAdsAuthRoutes
