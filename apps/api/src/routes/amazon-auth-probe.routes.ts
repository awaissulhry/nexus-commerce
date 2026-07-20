/**
 * AS.0-debug — one-shot Amazon auth topology probe (TEMPORARY diagnostic).
 *
 * The 2026-07-20 write-403 saga: reads (amazon-sp-api npm lib, SigV4-signed
 * via AWS_ROLE_ARN AssumeRole + LWA) work; writes (raw Bearer-only PATCH)
 * get "Access to requested resource is denied" — with the SAME refresh
 * token. This endpoint answers, from INSIDE the running service:
 *   1. which Amazon/AWS env vars the process actually holds (secrets as
 *      sha256-8 fingerprints, never raw)
 *   2. does a Bearer-only listings READ pass?
 *   3. does a SigV4-signed listings READ pass?
 *   4. (only with ?write=1) does a SigV4-signed NET-ZERO listings PATCH
 *      pass? (canary: a known-FBM listing re-submitted at its CURRENT
 *      quantity — changes nothing on Amazon either way)
 *
 * GET /api/admin/amazon-auth-probe[?write=1]
 * Read-only except the deliberate net-zero canary PATCH behind ?write=1.
 */
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const fp = (v: string | undefined): string =>
  v ? createHash('sha256').update(v).digest('hex').slice(0, 8) : 'unset'

const MP_IT = 'APJ6JRA9NG5V4'

async function lwaAccessToken(): Promise<{ token?: string; error?: string }> {
  try {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.AMAZON_REFRESH_TOKEN ?? '',
        client_id: process.env.AMAZON_LWA_CLIENT_ID ?? process.env.AMAZON_CLIENT_ID ?? '',
        client_secret: process.env.AMAZON_LWA_CLIENT_SECRET ?? process.env.AMAZON_CLIENT_SECRET ?? '',
      }).toString(),
    })
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
    if (!res.ok || !data.access_token) return { error: `${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`.trim() }
    return { token: data.access_token }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export default async function amazonAuthProbeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/amazon-auth-probe', async (request) => {
    const write = (request.query as { write?: string }).write === '1'
    const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''

    // ── 1. env census (never raw secrets) ─────────────────────────────
    const env = {
      AMAZON_LWA_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID ?? 'unset',
      AMAZON_CLIENT_ID: process.env.AMAZON_CLIENT_ID ?? 'unset',
      AMAZON_LWA_CLIENT_SECRET: fp(process.env.AMAZON_LWA_CLIENT_SECRET),
      AMAZON_CLIENT_SECRET: fp(process.env.AMAZON_CLIENT_SECRET),
      AMAZON_REFRESH_TOKEN: fp(process.env.AMAZON_REFRESH_TOKEN),
      AMAZON_SELLER_ID: sellerId || 'unset',
      AMAZON_MERCHANT_ID: process.env.AMAZON_MERCHANT_ID ?? 'unset',
      AMAZON_REGION: process.env.AMAZON_REGION ?? 'unset(default eu)',
      AMAZON_MARKETPLACE_ID: process.env.AMAZON_MARKETPLACE_ID ?? 'unset',
      AWS_ACCESS_KEY_ID: fp(process.env.AWS_ACCESS_KEY_ID),
      AWS_SECRET_ACCESS_KEY: fp(process.env.AWS_SECRET_ACCESS_KEY),
      AWS_ROLE_ARN: process.env.AWS_ROLE_ARN ?? 'unset',
      AWS_REGION: process.env.AWS_REGION ?? 'unset',
      AMAZON_SQS_QUEUE_URL: process.env.AMAZON_SQS_QUEUE_URL ? 'set' : 'unset',
      NEXUS_ENABLE_AMAZON_PUBLISH: process.env.NEXUS_ENABLE_AMAZON_PUBLISH ?? 'unset',
      AMAZON_PUBLISH_MODE: process.env.AMAZON_PUBLISH_MODE ?? 'unset(dry-run)',
    }

    // canary: a known-FBM published listing (never FBA — checked here too)
    const canary = await prisma.channelListing.findFirst({
      where: {
        channel: 'AMAZON',
        marketplace: 'IT',
        isPublished: true,
        quantity: { not: null },
        fulfillmentMethod: 'FBM',
        product: { fulfillmentMethod: { not: 'FBA' } },
      },
      select: { quantity: true, product: { select: { sku: true } } },
    })
    const canarySku = canary?.product?.sku ?? null
    const canaryQty = canary?.quantity ?? null

    // ── 2. Bearer-only listings READ ──────────────────────────────────
    let bearerRead: string
    const lwa = await lwaAccessToken()
    if (!lwa.token) {
      bearerRead = `LWA-FAILED: ${lwa.error}`
    } else if (!canarySku) {
      bearerRead = 'no canary sku'
    } else {
      try {
        const r = await fetch(
          `https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(canarySku)}?marketplaceIds=${MP_IT}&includedData=summaries`,
          { headers: { Authorization: `Bearer ${lwa.token}` } },
        )
        const body = await r.text()
        bearerRead = `${r.status}${r.ok ? ' OK' : ` ${body.slice(0, 160)}`}`
      } catch (err) {
        bearerRead = `ERR ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ── 3+4. SigV4-signed read (and optional net-zero write) via npm lib ─
    let signedRead = 'skipped'
    let signedWrite = write ? 'pending' : 'skipped (pass ?write=1 for the net-zero canary PATCH)'
    try {
      const { getAmazonSpClient } = await import('../lib/amazon-sp-client.js')
      const sp: any = await getAmazonSpClient()
      if (canarySku) {
        try {
          await sp.callAPI({
            operation: 'getListingsItem',
            endpoint: 'listingsItems',
            path: { sellerId, sku: canarySku },
            query: { marketplaceIds: [MP_IT], includedData: ['summaries'] },
          })
          signedRead = '200 OK'
        } catch (err) {
          signedRead = `ERR ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`
        }
        if (write && canaryQty !== null) {
          try {
            await sp.callAPI({
              operation: 'patchListingsItem',
              endpoint: 'listingsItems',
              path: { sellerId, sku: canarySku },
              query: { marketplaceIds: [MP_IT] },
              body: {
                productType: 'PRODUCT',
                patches: [
                  {
                    op: 'replace',
                    path: '/attributes/fulfillment_availability',
                    value: [{ fulfillment_channel_code: 'DEFAULT', quantity: canaryQty }],
                  },
                ],
              },
            })
            signedWrite = `200 OK (net-zero: ${canarySku} re-submitted at its current qty ${canaryQty})`
          } catch (err) {
            signedWrite = `ERR ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`
          }
        }
      }
    } catch (err) {
      signedRead = `lib-init ERR ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`
    }

    const result = { env, canary: canarySku ? `${canarySku}@IT qty=${canaryQty}` : 'none', bearerRead, signedRead, signedWrite }
    logger.warn('[amazon-auth-probe] result', result)
    return result
  })
}
