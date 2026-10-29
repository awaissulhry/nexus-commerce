import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { SENDCLOUD_SIGNATURE_HEADER, SENDCLOUD_STATUS_ACTION } from '@nexus/factory-domain/ports/carrier'
import type { SignatureVerifier, VerifyInput, VerifyResult } from '@nexus/factory-domain/ports/signature'

/**
 * Sendcloud's webhooks (API v3 "parcel status changed"; B-W1-48). Each delivery carries `Sendcloud-Signature`: the hex
 * HMAC-SHA256 of the raw body, keyed with the integration's secret key (here: the account's webhook secret, sealed,
 * purpose integration.webhook). The body:
 *
 *   { "action": "parcel_status_changed", "timestamp": <unix>, "carrier_status_change_timestamp": <unix> | null,
 *     "parcel": { "id": 1, "tracking_number": "…", "status": { "id": 11, "message": "Delivered" }, … } }
 *
 * Sendcloud gives no event id: one delivery is the parcel, its status and the timestamp (a resent delivery is the same
 * key, so the inbound ledger stores it once). Sendcloud signs no timestamp, so there is no freshness window; a replay is
 * a duplicate. LIVE and SANDBOX accounts use `sendcloudVerifier` (platform/inbound/providers.ts); a FAKE account the
 * platform's fake verifier, which the FAKE (./fake.ts) signs for as well as with Sendcloud's header.
 */

/** A parcel status change as the factory reads it. */
export interface SendcloudStatusChange {
  readonly action: string
  /** Milliseconds since the epoch (Sendcloud's unix timestamp, in seconds or milliseconds). */
  readonly timestampMs: number
  readonly parcelId: string
  readonly trackingNumber: string
  readonly statusId: number
  readonly statusMessage: string | null
  readonly carrierCode: string | null
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** A unix timestamp in seconds or milliseconds, as milliseconds; null when it is not one. */
function millis(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

/** The status change a body says, or null when it is not one (another action, or a body without its parcel). */
export function parseStatusChange(body: string): SendcloudStatusChange | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const root = record(parsed)
  const parcel = record(root.parcel)
  const status = record(parcel.status)
  const timestampMs = millis(root.carrier_status_change_timestamp) ?? millis(root.timestamp)
  const parcelId = typeof parcel.id === 'number' || typeof parcel.id === 'string' ? String(parcel.id) : null
  const trackingNumber = typeof parcel.tracking_number === 'string' && parcel.tracking_number.trim() !== '' ? parcel.tracking_number.trim() : null
  const statusId = typeof status.id === 'number' && Number.isSafeInteger(status.id) ? status.id : null
  if (root.action !== SENDCLOUD_STATUS_ACTION || timestampMs === null || parcelId === null || trackingNumber === null || statusId === null) return null
  const carrier = record(parcel.carrier)
  return {
    action: SENDCLOUD_STATUS_ACTION,
    timestampMs,
    parcelId,
    trackingNumber,
    statusId,
    statusMessage: typeof status.message === 'string' ? status.message.slice(0, 200) : null,
    carrierCode: typeof carrier.code === 'string' ? carrier.code.slice(0, 64) : null,
  }
}

/** The key of one delivery: its parcel, status and time (Sendcloud has no event id). */
export const statusChangeKey = (change: Pick<SendcloudStatusChange, 'parcelId' | 'statusId' | 'timestampMs'>): string =>
  `${SENDCLOUD_STATUS_ACTION}:${change.parcelId}:${change.statusId}:${change.timestampMs}`

/** The signature Sendcloud sends with `body` (the signing side: the FAKE and the tests). */
export const sendcloudSignature = (secret: string, body: Uint8Array | string): string => createHmac('sha256', secret).update(body).digest('hex')

const HEX = /^[0-9a-f]{64}$/i

export const sendcloudVerifier: SignatureVerifier = {
  verify({ rawBody, headers, secret }: VerifyInput): VerifyResult {
    if (!secret) return { ok: false, reason: 'no_webhook_secret' }
    const given = headers[SENDCLOUD_SIGNATURE_HEADER]?.trim()
    if (!given) return { ok: false, reason: 'missing_signature' }
    if (!HEX.test(given)) return { ok: false, reason: 'malformed_signature' }
    if (!timingSafeEqual(Buffer.from(sendcloudSignature(secret, rawBody), 'hex'), Buffer.from(given.toLowerCase(), 'hex'))) return { ok: false, reason: 'signature_mismatch' }
    const change = parseStatusChange(Buffer.from(rawBody).toString('utf8'))
    // A signed delivery the factory does not read (another action): kept once by its body's hash, processed as nothing.
    if (!change) return { ok: true, dedupeKey: `body:${createHash('sha256').update(rawBody).digest('hex')}`, eventType: 'other' }
    return { ok: true, dedupeKey: statusChangeKey(change), externalId: change.trackingNumber, eventType: change.action }
  },
}
