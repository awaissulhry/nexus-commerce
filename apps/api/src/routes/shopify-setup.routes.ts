/**
 * RT.11 — Shopify webhook subscription setup endpoint.
 *
 * Registers every webhook topic Nexus listens to with the configured
 * Shopify shop. Existing handlers under /webhooks/shopify/* already
 * route through the normal flow (signature verification → WebhookEvent
 * upsert → handler dispatch → recordChannelStockEvent / order
 * cascade). The bottleneck pre-RT.11 was that registration had to be
 * done manually through the Shopify partner dashboard.
 *
 * Without this step:
 *   * /webhooks/shopify/inventory/update never fires → stock drift
 *     surfaces only on the next CS-series sweep (20-30 min)
 *   * /webhooks/shopify/orders/create never fires → operator must
 *     wait for the order-sync cron
 *
 * POST /api/admin/setup-shopify-webhooks
 *   Idempotent — Shopify rejects duplicates on (topic, address)
 *   composite so re-running is safe. Returns one row per topic with
 *   its registration status.
 *
 * GET /api/admin/shopify-webhook-status
 *   Lists currently-registered topics + addresses. Lets the operator
 *   verify the registration matches our route mounts.
 */

import type { FastifyInstance } from 'fastify'
import { ConfigManager } from '../utils/config.js'
import type { ShopifyConfig } from '../types/marketplace.js'
import { logger } from '../utils/logger.js'

/**
 * The full set of topics we have handlers for. URL paths match the
 * mounts in shopify-webhooks.ts — keep in sync if either side moves.
 *
 * inventory_levels/update is the Shopify topic name; the handler
 * mounts at /webhooks/shopify/inventory/update so we register that
 * URL. Re-mapping the path is invisible to Shopify.
 */
const WEBHOOK_REGISTRATIONS: Array<{ topic: string; path: string }> = [
  { topic: 'products/update', path: '/webhooks/shopify/products/update' },
  { topic: 'products/delete', path: '/webhooks/shopify/products/delete' },
  { topic: 'inventory_levels/update', path: '/webhooks/shopify/inventory/update' },
  { topic: 'orders/create', path: '/webhooks/shopify/orders/create' },
  { topic: 'orders/updated', path: '/webhooks/shopify/orders/update' },
  { topic: 'fulfillments/create', path: '/webhooks/shopify/fulfillments/create' },
  { topic: 'refunds/create', path: '/webhooks/shopify/refunds/create' },
]

function buildAddress(path: string): string | null {
  const base =
    process.env.NEXUS_PUBLIC_API_URL ??
    process.env.PUBLIC_API_URL ??
    process.env.RAILWAY_PUBLIC_DOMAIN
  if (!base) return null
  const normalised = base.startsWith('http') ? base : `https://${base}`
  return `${normalised.replace(/\/+$/, '')}${path}`
}

async function shopifyAdminRequest<T>(
  config: ShopifyConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: T | { errors?: unknown } }> {
  const apiVersion = config.apiVersion || '2024-01'
  const url = `https://${config.shopName}.myshopify.com/admin/api/${apiVersion}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) : {}
  return { ok: res.ok, status: res.status, body: parsed }
}

export default async function shopifySetupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/setup-shopify-webhooks', async (_req, reply) => {
    const config = ConfigManager.getConfig('SHOPIFY') as ShopifyConfig | null
    if (!config?.accessToken || !config?.shopName) {
      return reply
        .status(400)
        .send({ error: 'Shopify config missing accessToken or shopName' })
    }

    const results: Array<{
      topic: string
      address: string
      status: 'created' | 'already_exists' | 'failed' | 'no_address'
      detail?: unknown
    }> = []

    for (const { topic, path } of WEBHOOK_REGISTRATIONS) {
      const address = buildAddress(path)
      if (!address) {
        results.push({ topic, address: '', status: 'no_address' })
        continue
      }
      try {
        const created = await shopifyAdminRequest(config, 'POST', '/webhooks.json', {
          webhook: { topic, address, format: 'json' },
        })
        if (created.ok) {
          results.push({ topic, address, status: 'created' })
        } else if (
          created.status === 422 &&
          JSON.stringify(created.body).includes('has already been taken')
        ) {
          // Shopify's "address has already been taken for this topic" —
          // idempotent re-run. Not an error.
          results.push({ topic, address, status: 'already_exists' })
        } else {
          results.push({
            topic,
            address,
            status: 'failed',
            detail: created.body,
          })
          logger.warn('[shopify-setup] webhook create failed', {
            topic,
            address,
            status: created.status,
            body: created.body,
          })
        }
      } catch (err: any) {
        results.push({
          topic,
          address,
          status: 'failed',
          detail: err?.message ?? String(err),
        })
      }
    }

    return reply.send({
      shop: config.shopName,
      registrations: results,
      summary: {
        created: results.filter((r) => r.status === 'created').length,
        already_exists: results.filter((r) => r.status === 'already_exists').length,
        failed: results.filter((r) => r.status === 'failed').length,
        no_address: results.filter((r) => r.status === 'no_address').length,
      },
    })
  })

  app.get('/admin/shopify-webhook-status', async (_req, reply) => {
    const config = ConfigManager.getConfig('SHOPIFY') as ShopifyConfig | null
    if (!config?.accessToken || !config?.shopName) {
      return reply.send({ configured: false, reason: 'Shopify config missing' })
    }
    const r = await shopifyAdminRequest<{ webhooks: any[] }>(
      config,
      'GET',
      '/webhooks.json',
    )
    if (!r.ok) {
      return reply.status(502).send({ error: 'shopify list failed', detail: r.body })
    }
    const webhooks = (r.body as any).webhooks ?? []
    return reply.send({
      configured: true,
      shop: config.shopName,
      registered: webhooks.map((w: any) => ({
        id: w.id,
        topic: w.topic,
        address: w.address,
        createdAt: w.created_at,
      })),
      expected: WEBHOOK_REGISTRATIONS.map((r) => r.topic),
      missing: WEBHOOK_REGISTRATIONS.filter(
        (r) => !webhooks.some((w: any) => w.topic === r.topic),
      ).map((r) => r.topic),
    })
  })
}
