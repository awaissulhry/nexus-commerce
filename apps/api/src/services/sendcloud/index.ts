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
import { createParcel, fetchParcel, voidParcel, fetchLabelPdf } from './client.js'
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
  // Stored as plaintext JSON today (TODO: rotate to AES-256-GCM
  // matching MarketplaceCredential — flagged in fulfillment.routes.ts
  // line 6548). decrypt() helper lands with that rotation.
  let parsed: SendcloudCredentials
  try {
    parsed = JSON.parse(carrier.credentialsEncrypted) as SendcloudCredentials
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
): Promise<number | null> {
  const carrier = await prisma.carrier.findUnique({
    where: { code: 'SENDCLOUD' },
    select: { defaultServiceMap: true },
  })
  const map = (carrier?.defaultServiceMap as ServiceMap | null) ?? null
  if (!map) return null
  const key = `${channel}_${marketplace ?? 'GLOBAL'}`
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
