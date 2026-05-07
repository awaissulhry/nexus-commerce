/**
 * O.6 — Sendcloud public surface.
 *
 * Higher-level helpers that wrap the raw client + the Carrier table:
 *   resolveCredentials()  — pulls + parses Sendcloud creds from Carrier
 *   resolveServiceMap()   — looks up shipping_method id for a shipment
 *
 * The print-label endpoint (replaced in O.8) and the webhook handler
 * (added in O.7) compose these helpers. The module is import-side-effect
 * free; no DB access happens until a function is called.
 */

import prisma from '../../db.js'
import { createParcel, fetchParcel, voidParcel, fetchLabelPdf, listShippingMethods, listSenderAddresses, verifyCredentials } from './client.js'
import { decryptSecret, encryptSecret, isEncrypted } from '../../lib/crypto.js'
import {
  SendcloudCredentials,
  SendcloudError,
  ServiceMap,
} from './types.js'

export {
  createParcel,
  fetchParcel,
  voidParcel,
  fetchLabelPdf,
  listShippingMethods,
  listSenderAddresses,
  verifyCredentials,
  SendcloudError,
}
export type { SendcloudCredentials, ServiceMap } from './types.js'
export type {
  SendcloudParcelInput,
  SendcloudParcelOutput,
  SendcloudParcelItem,
  SendcloudAddress,
} from './types.js'

/**
 * Read SENDCLOUD carrier creds from the DB. Throws if the carrier is
 * unconnected or the stored blob is malformed. Caller catches and maps
 * to a 400 with a clear "open /fulfillment/carriers" message.
 */
export async function resolveCredentials(): Promise<SendcloudCredentials> {
  const carrier = await prisma.carrier.findUnique({
    where: { code: 'SENDCLOUD' },
  })
  if (!carrier?.isActive || !carrier.credentialsEncrypted) {
    throw new SendcloudError(
      'Sendcloud carrier is not connected. Open /fulfillment/carriers.',
      400,
      'CARRIER_NOT_CONNECTED',
    )
  }
  // CR.1: credentials are AES-256-GCM enveloped. Pre-CR.1 rows were
  // plaintext JSON; we transparently re-encrypt those on first read
  // so a Railway deploy + first label-print is the migration. No
  // separate backfill window. Detection is "starts with v1:".
  let plaintext: string
  if (isEncrypted(carrier.credentialsEncrypted)) {
    try {
      plaintext = decryptSecret(carrier.credentialsEncrypted)
    } catch {
      throw new SendcloudError(
        'Sendcloud credentials failed integrity check. Reconnect via /fulfillment/carriers.',
        500,
        'CREDENTIAL_DECRYPT_FAILED',
      )
    }
  } else {
    plaintext = carrier.credentialsEncrypted
    // Legacy plaintext row — re-encrypt in place. Fire-and-forget so
    // a write blip doesn't block label-print; next read re-tries.
    try {
      const reEncrypted = encryptSecret(plaintext)
      void prisma.carrier
        .update({ where: { code: 'SENDCLOUD' }, data: { credentialsEncrypted: reEncrypted } })
        .catch(() => { /* non-fatal */ })
    } catch {
      // Encryption misconfigured — surface a clear error rather than
      // silently failing. Operator must set NEXUS_CREDENTIAL_ENC_KEY.
      throw new SendcloudError(
        'Credential encryption is not configured (NEXUS_CREDENTIAL_ENC_KEY). See apps/api/src/lib/crypto.ts.',
        500,
        'CREDENTIAL_ENC_KEY_MISSING',
      )
    }
  }
  let parsed: SendcloudCredentials
  try {
    parsed = JSON.parse(plaintext) as SendcloudCredentials
  } catch {
    throw new SendcloudError(
      'Sendcloud credentials are unreadable. Reconnect via /fulfillment/carriers.',
      500,
      'CREDENTIAL_DECRYPT_FAILED',
    )
  }
  if (!parsed.publicKey || !parsed.privateKey) {
    throw new SendcloudError(
      'Sendcloud credentials missing publicKey/privateKey. Reconnect via /fulfillment/carriers.',
      500,
      'CREDENTIAL_INCOMPLETE',
    )
  }
  return parsed
}

/**
 * Look up the Sendcloud shipping_method id for a shipment based on its
 * Order's channel + marketplace. Returns null when no rule maps; caller
 * lets Sendcloud auto-select based on dimensions + destination.
 *
 * Carrier.defaultServiceMap is JSON like:
 *   { "AMAZON_IT": 12345, "EBAY_GLOBAL": 67890, "SHOPIFY_GLOBAL": 555 }
 */
export async function resolveServiceMap(
  channel: string,
  marketplace: string | null | undefined,
  warehouseId?: string | null,
): Promise<number | null> {
  // CR.7: prefer the normalized CarrierServiceMapping rows over the
  // legacy defaultServiceMap JSON. Resolution order:
  //   1. exact (channel, marketplace, warehouseId)        — most specific
  //   2. (channel, marketplace, warehouseId=null)         — channel+market default
  //   3. (channel, GLOBAL, warehouseId=null)              — channel default
  //   4. defaultServiceMap[channel_marketplace]           — legacy fallback
  //   5. defaultServiceMap[channel_GLOBAL]                — legacy fallback
  // Returns the Sendcloud shipping_method id (CarrierService.externalId
  // parsed as int) or null when nothing maps.
  const carrier = await prisma.carrier.findUnique({
    where: { code: 'SENDCLOUD' },
    select: { id: true, defaultServiceMap: true },
  })
  if (!carrier) return null

  const market = marketplace ?? 'GLOBAL'

  // (1) + (2) + (3): walk specificity tiers in CarrierServiceMapping.
  const candidates: Array<{ marketplace: string; warehouseId: string | null }> = []
  if (warehouseId) candidates.push({ marketplace: market, warehouseId })
  candidates.push({ marketplace: market, warehouseId: null })
  if (market !== 'GLOBAL') candidates.push({ marketplace: 'GLOBAL', warehouseId: null })

  for (const c of candidates) {
    const mapping = await prisma.carrierServiceMapping.findFirst({
      where: {
        carrierId: carrier.id,
        channel,
        marketplace: c.marketplace,
        warehouseId: c.warehouseId,
      },
      include: { service: { select: { externalId: true } } },
    })
    if (mapping?.service?.externalId) {
      const parsed = parseInt(mapping.service.externalId, 10)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  // (4) + (5): legacy fallback for rows that haven't been migrated yet.
  const map = (carrier.defaultServiceMap as ServiceMap | null) ?? null
  if (!map) return null
  const key = `${channel}_${market}`
  return map[key] ?? map[`${channel}_GLOBAL`] ?? null
}

/**
 * Convenience: report current env mode for the /carriers UI banner +
 * request logs. dryRun=true means no Sendcloud HTTP calls are made
 * regardless of carrier connection status.
 */
export function getSendcloudMode(): {
  env: 'sandbox' | 'production'
  real: boolean
  dryRun: boolean
} {
  const env = process.env.NEXUS_SENDCLOUD_ENV === 'production' ? 'production' : 'sandbox'
  const real = process.env.NEXUS_ENABLE_SENDCLOUD_REAL === 'true'
  return { env, real, dryRun: !real }
}
