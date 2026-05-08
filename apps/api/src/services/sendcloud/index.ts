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
import { createParcel, fetchParcel, voidParcel, fetchLabelPdf, listShippingMethods, listSenderAddresses, requestPickup, verifyCredentials } from './client.js'
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
  requestPickup,
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
 *
 * CR.10: optional warehouseId routes to the warehouse's bound
 * CarrierAccount when set; null falls back to the primary Carrier
 * row. Resolution order:
 *   1. Warehouse.defaultCarrierAccountId → CarrierAccount.credentialsEncrypted
 *   2. Carrier.credentialsEncrypted (primary, existing behavior)
 *
 * The CR.1 envelope works identically on both rows (same encryption
 * helper); the only difference is which row we pull ciphertext from.
 */
export async function resolveCredentials(warehouseId?: string | null): Promise<SendcloudCredentials> {
  // CR.10: try warehouse-bound account first.
  if (warehouseId) {
    const wh = await prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { defaultCarrierAccountId: true },
    })
    if (wh?.defaultCarrierAccountId) {
      const account = await prisma.carrierAccount.findUnique({
        where: { id: wh.defaultCarrierAccountId },
      })
      if (account?.isActive && account.credentialsEncrypted) {
        return parseEncryptedCreds(account.credentialsEncrypted, 'CarrierAccount')
      }
      // Account exists but inactive / no creds — fall through to
      // primary rather than failing the print-label call.
    }
  }

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
  return parseEncryptedCreds(carrier.credentialsEncrypted, 'Carrier')
}

/**
 * CR.10: shared decrypt + legacy-plaintext-migration helper. Used by
 * resolveCredentials for both the primary Carrier row and any
 * warehouse-bound CarrierAccount row. The `source` parameter only
 * shapes the legacy-plaintext re-encrypt path so a Carrier-side
 * stale plaintext row gets re-encrypted on Carrier (not on a random
 * CarrierAccount).
 */
function parseEncryptedCreds(
  ciphertext: string,
  source: 'Carrier' | 'CarrierAccount',
): SendcloudCredentials {
  // CR.1: credentials are AES-256-GCM enveloped. Pre-CR.1 rows were
  // plaintext JSON; we transparently re-encrypt those on first read
  // so a Railway deploy + first label-print is the migration. No
  // separate backfill window. Detection is "starts with v1:".
  let plaintext: string
  if (isEncrypted(ciphertext)) {
    try {
      plaintext = decryptSecret(ciphertext)
    } catch {
      throw new SendcloudError(
        'Sendcloud credentials failed integrity check. Reconnect via /fulfillment/carriers.',
        500,
        'CREDENTIAL_DECRYPT_FAILED',
      )
    }
  } else {
    plaintext = ciphertext
    // Legacy plaintext row — re-encrypt in place. Fire-and-forget so
    // a write blip doesn't block label-print; next read re-tries.
    try {
      const reEncrypted = encryptSecret(plaintext)
      if (source === 'Carrier') {
        void prisma.carrier
          .update({ where: { code: 'SENDCLOUD' }, data: { credentialsEncrypted: reEncrypted } })
          .catch(() => { /* non-fatal */ })
      } else {
        // CarrierAccount: we don't know the id from the ciphertext
        // alone. Skip the in-place re-encrypt — the next operator-
        // initiated update via the CR.9 PATCH endpoint will store
        // it encrypted.
      }
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
  destinationCountry?: string | null,
): Promise<number | null> {
  // CR.7 + CR.22: prefer normalized CarrierServiceMapping rows over
  // the legacy defaultServiceMap JSON. Falls back to a tier-matched
  // CarrierService when nothing maps explicitly. Resolution order:
  //   1. exact (channel, marketplace, warehouseId)        — most specific
  //   2. (channel, marketplace, warehouseId=null)         — channel+market default
  //   3. (channel, GLOBAL, warehouseId=null)              — channel default
  //   4. CarrierService whose tier matches the destination tier      ← CR.22
  //      (DOMESTIC/EU → STANDARD; INTL → EXPRESS)
  //   5. defaultServiceMap[channel_marketplace]           — legacy fallback
  //   6. defaultServiceMap[channel_GLOBAL]                — legacy fallback
  // Returns the Sendcloud shipping_method id or null when nothing maps.
  const carrier = await prisma.carrier.findUnique({
    where: { code: 'SENDCLOUD' },
    select: { id: true, defaultServiceMap: true, preferences: true },
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

  // (4) — CR.22 auto-tier fallback. Operator opts out via
  // Carrier.preferences.autoTierEnabled === false. When destination
  // is unknown, skip — INTL fallback would be wrong if the dest is
  // actually domestic.
  const prefs = (carrier.preferences as { autoTierEnabled?: boolean } | null) ?? null
  const autoTierEnabled = prefs?.autoTierEnabled !== false  // default ON
  if (autoTierEnabled && destinationCountry) {
    const { classifyDestinationTier, preferredTierFor } = await import('./destination-tier.js')

    // Origin: pull from the bound Warehouse if a warehouseId was
    // passed; default to IT (Xavia base) when no warehouse context.
    let origin: string | null = null
    if (warehouseId) {
      const wh = await prisma.warehouse.findUnique({
        where: { id: warehouseId },
        select: { country: true },
      })
      origin = wh?.country ?? null
    }
    if (!origin) origin = 'IT'

    const destTier = classifyDestinationTier(origin, destinationCountry)
    const wantedTier = preferredTierFor(destTier)

    // Pick the cheapest active service at the wanted tier. Sort by
    // basePriceCents (nulls last) so a free service doesn't beat
    // a real one.
    const tierMatch = await prisma.carrierService.findFirst({
      where: {
        carrierId: carrier.id,
        isActive: true,
        tier: wantedTier,
      },
      orderBy: [
        { basePriceCents: 'asc' },
        { syncedAt: 'desc' },
      ],
      select: { externalId: true },
    })
    if (tierMatch?.externalId) {
      const parsed = parseInt(tierMatch.externalId, 10)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  // (5) + (6): legacy fallback for rows that haven't been migrated yet.
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
