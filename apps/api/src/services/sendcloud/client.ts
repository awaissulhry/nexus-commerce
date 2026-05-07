/**
 * O.6 — Sendcloud HTTP client.
 *
 * Two env knobs control behavior:
 *   NEXUS_SENDCLOUD_ENV          'sandbox' | 'production'   default 'sandbox'
 *   NEXUS_ENABLE_SENDCLOUD_REAL  'true' | 'false'           default 'false'
 *
 * When ENABLE_SENDCLOUD_REAL is false (the default), every API call
 * returns a structurally-identical mock so the rest of the system
 * (print-label endpoint in O.8, webhook handler in O.7, retry job in
 * O.12) can be wired and exercised end-to-end without ever touching
 * Sendcloud. Operators flip the flag to true once sandbox creds are
 * in place + smoke tests pass.
 *
 * The sandbox-vs-production distinction in Sendcloud is mostly about
 * which integration credentials get used (Sendcloud doesn't host a
 * separate sandbox API URL — it's the same panel.sendcloud.sc/api/v2
 * with a "test" integration). The env flag still picks the URL so
 * future Sendcloud sandbox URL changes don't require a code change.
 */

import {
  SendcloudCredentials,
  SendcloudError,
  SendcloudParcelInput,
  SendcloudParcelOutput,
} from './types.js'

const PROD_BASE_URL = 'https://panel.sendcloud.sc/api/v2'
// Sendcloud doesn't currently host a separate sandbox URL; this is here
// so a future change to the sandbox endpoint (or a per-deployment proxy)
// can be wired by env without code changes.
const SANDBOX_BASE_URL =
  process.env.NEXUS_SENDCLOUD_SANDBOX_URL ?? PROD_BASE_URL

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_SENDCLOUD_REAL === 'true'
}

function isSandbox(): boolean {
  return (process.env.NEXUS_SENDCLOUD_ENV ?? 'sandbox') !== 'production'
}

function baseUrl(): string {
  return isSandbox() ? SANDBOX_BASE_URL : PROD_BASE_URL
}

function authHeader(creds: SendcloudCredentials): string {
  const raw = `${creds.publicKey}:${creds.privateKey}`
  return `Basic ${Buffer.from(raw).toString('base64')}`
}

/**
 * Mock parcel — returned by every call when ENABLE_SENDCLOUD_REAL=false.
 * Shape matches SendcloudParcelOutput so callers don't need to branch.
 * The mock IDs are deterministic-per-run (Date.now-based) so logs read
 * naturally during dryRun smoke tests.
 */
function mockParcel(input: SendcloudParcelInput): SendcloudParcelOutput {
  const id = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000)
  const tracking = `MOCK${id}`
  return {
    id,
    tracking_number: tracking,
    tracking_url: `https://tracking.sendcloud.sc/forward?carrier=mock&code=${tracking}`,
    label: {
      normal_printer: [
        `${baseUrl()}/labels/normal_printer/${id}?label_format=8`,
      ],
      label_printer: null,
    },
    status: { id: 1, message: 'Ready to send (mock)' },
    carrier: { code: 'mock' },
    shipment: {
      id: input.shipment?.id ?? 0,
      name: 'Mock shipping method',
    },
    weight: input.weight,
  }
}

/**
 * Create a parcel. In real mode this calls POST /api/v2/parcels and
 * returns the full parcel (with label_url). In dryRun mode (default)
 * a structurally-identical mock is returned without any network I/O.
 *
 * Caller is responsible for persisting the returned tracking_number /
 * label url onto the Shipment row.
 */
export async function createParcel(
  creds: SendcloudCredentials,
  input: SendcloudParcelInput,
): Promise<SendcloudParcelOutput> {
  if (!isReal()) return mockParcel(input)
  const res = await fetch(`${baseUrl()}/parcels`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parcel: { ...input, request_label: input.request_label ?? true } }),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    throw new SendcloudError(
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
      body?.error?.code ?? null,
      body,
    )
  }
  return body.parcel as SendcloudParcelOutput
}

/**
 * Cancel a parcel — Sendcloud's "void label" equivalent. Only works
 * before the carrier has picked it up; afterwards Sendcloud rejects.
 */
export async function voidParcel(
  creds: SendcloudCredentials,
  parcelId: number,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  if (!isReal()) {
    return { ok: true, status: 'Cancelled (mock)' }
  }
  const res = await fetch(`${baseUrl()}/parcels/${parcelId}/cancel`, {
    method: 'POST',
    headers: { Authorization: authHeader(creds) },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* */
  }
  if (!res.ok) {
    return { ok: false, reason: body?.error?.message ?? `HTTP ${res.status}` }
  }
  return { ok: true, status: body?.status?.message ?? 'Cancelled' }
}

/**
 * Re-fetch a parcel — used by the webhook handler (O.7) to confirm
 * tracking state, and by manual "refresh" actions.
 */
export async function fetchParcel(
  creds: SendcloudCredentials,
  parcelId: number,
): Promise<SendcloudParcelOutput | null> {
  if (!isReal()) {
    return mockParcel({
      name: 'mock',
      address: 'mock',
      city: 'mock',
      postal_code: '00000',
      country: 'IT',
      weight: '1.000',
      order_number: `mock-${parcelId}`,
      total_order_value: '0',
    })
  }
  const res = await fetch(`${baseUrl()}/parcels/${parcelId}`, {
    headers: { Authorization: authHeader(creds) },
  })
  if (res.status === 404) return null
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* */
  }
  if (!res.ok) {
    throw new SendcloudError(
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
      body?.error?.code ?? null,
      body,
    )
  }
  return body.parcel as SendcloudParcelOutput
}

/**
 * O.28 — Fetch eligible Sendcloud shipping methods for a parcel
 * weight + destination. Used by the rate-compare UI to show options.
 * In dryRun returns three plausible mock services.
 */
export async function listShippingMethods(
  creds: SendcloudCredentials,
  filter: { weightKg: number; toCountry: string; fromCountry?: string },
): Promise<Array<{
  id: number
  name: string
  carrier: string
  price: number // EUR
  minWeightKg: number
  maxWeightKg: number
}>> {
  if (!isReal()) {
    return [
      { id: 1001, name: 'BRT 0–2kg Standard', carrier: 'BRT', price: 4.5, minWeightKg: 0, maxWeightKg: 2 },
      { id: 1002, name: 'GLS 0–3kg Business Parcel', carrier: 'GLS', price: 5.9, minWeightKg: 0, maxWeightKg: 3 },
      { id: 1003, name: 'DHL Express 0–5kg International', carrier: 'DHL', price: 14.5, minWeightKg: 0, maxWeightKg: 5 },
    ].filter((m) => filter.weightKg <= m.maxWeightKg)
  }
  // Sendcloud /shipping_methods supports query params for filtering;
  // we keep it simple and filter client-side once we have the list.
  const res = await fetch(`${baseUrl()}/shipping_methods?to_country=${filter.toCountry}`, {
    headers: { Authorization: authHeader(creds) },
  })
  if (!res.ok) {
    throw new SendcloudError(`HTTP ${res.status}`, res.status, null)
  }
  const body: any = await res.json()
  const methods = body?.shipping_methods ?? []
  return methods
    .filter((m: any) => filter.weightKg >= Number(m.min_weight ?? 0) && filter.weightKg <= Number(m.max_weight ?? Infinity))
    .map((m: any) => ({
      id: m.id,
      name: m.name,
      carrier: m.carrier,
      price: Number(m.countries?.[0]?.price ?? 0),
      minWeightKg: Number(m.min_weight ?? 0),
      maxWeightKg: Number(m.max_weight ?? 0),
    }))
}

/**
 * Fetch the label PDF as a buffer. Used by the print-label endpoint
 * (O.8) when it needs to stream the PDF directly rather than redirect
 * to Sendcloud's URL (some carriers have signed URLs that expire).
 */
export async function fetchLabelPdf(
  creds: SendcloudCredentials,
  labelUrl: string,
): Promise<Buffer> {
  if (!isReal()) {
    // Mock returns a tiny "PDF" payload so callers can verify wiring.
    return Buffer.from('%PDF-1.4\n%mock-label\n', 'utf8')
  }
  const res = await fetch(labelUrl, {
    headers: { Authorization: authHeader(creds) },
  })
  if (!res.ok) {
    throw new SendcloudError(
      `Label fetch failed: HTTP ${res.status}`,
      res.status,
      null,
      null,
    )
  }
  const arr = await res.arrayBuffer()
  return Buffer.from(arr)
}

/**
 * CR.2 — credential verification. Calls a lightweight Sendcloud
 * endpoint (/user — returns the integration's user record) to confirm
 * the public/private key pair authenticates. Used by the connect
 * endpoint before persisting credentials so a wrong key surfaces
 * immediately rather than silently failing on the first label print.
 *
 * Returns ok=true with the integration username on success, ok=false
 * with the Sendcloud-reported reason on failure. Network errors
 * propagate as ok=false (not throws) so the connect endpoint can
 * always render a clean 400 to the user.
 *
 * In dryRun mode (NEXUS_ENABLE_SENDCLOUD_REAL=false) this skips the
 * network and returns ok=true with a "(mock)" username so the
 * connect flow works end-to-end during local development without a
 * real Sendcloud account.
 */
export async function verifyCredentials(
  creds: SendcloudCredentials,
): Promise<{ ok: true; username: string } | { ok: false; reason: string; status?: number }> {
  if (!isReal()) {
    return { ok: true, username: 'sendcloud-mock-user' }
  }
  if (!creds.publicKey || !creds.privateKey) {
    return { ok: false, reason: 'publicKey + privateKey required' }
  }
  let res: Response
  try {
    res = await fetch(`${baseUrl()}/user`, {
      headers: { Authorization: authHeader(creds) },
    })
  } catch (err: any) {
    return { ok: false, reason: `Network error: ${err?.message ?? String(err)}` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'Invalid public/private key', status: res.status }
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body: any = await res.json()
      if (body?.error?.message) detail = body.error.message
    } catch { /* non-JSON body */ }
    return { ok: false, reason: detail, status: res.status }
  }
  let body: any = null
  try { body = await res.json() } catch { /* */ }
  const username = body?.user?.username ?? body?.user?.email ?? 'connected'
  return { ok: true, username }
}

// ── Internal helpers exposed for tests / debugging ──────────────────────
export const __test = { isReal, isSandbox, baseUrl, mockParcel }
