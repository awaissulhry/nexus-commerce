/**
 * P0.3 (docs/channel-connections/FINAL-PLAN.md, security finding S14) — the one way Nexus sends an
 * operator webhook (the test fire in routes/settings-webhooks.routes.ts and the alert dispatcher in
 * services/webhook-dispatch.service.ts).
 *
 * An operator types the URL, so every send is a request Nexus makes on someone's say-so from inside
 * our network. Before P0.3 both senders called fetch() on any URL: 127.0.0.1, the Railway private
 * network (*.railway.internal), the cloud metadata address, and they followed redirects there too.
 * They also stored the full reply body with no limit, and kept the signing secret in plain text.
 *
 * The rules here:
 *   1. HTTPS only, no user name or password in the URL, a public host name or a public IP literal.
 *   2. The address checked is the address connected to: the DNS answer is checked inside the socket's
 *      own lookup, so a name that answers "public" to a check and "private" to the connect (DNS
 *      rebinding) cannot get through. Every answer must be public, not just the first.
 *   3. No redirects (node:http never follows them; a 3xx is reported as a failure).
 *   4. 8 s for the whole exchange; at most 1 KB of the reply is read; at most 500 characters stored.
 *   5. The signing secret is stored as a v1 envelope (lib/crypto.ts, the same key the carrier and
 *      Sendcloud secrets use). A missing key refuses the save; plain text is never written.
 */
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
// node:http / node:https are imported when a webhook is sent, not at module load: this module sits in
// the import graph of every alert (services/monitoring/alert.service.ts), and a test that replaces
// node:http with a factory (services/pim/theme-change.vitest.test.ts) must not see it loaded early.
import type { IncomingMessage } from 'node:http'
import { decryptSecret, encryptSecret, isEncrypted } from './crypto.js'

export const WEBHOOK_TIMEOUT_MS = 8_000
export const WEBHOOK_REPLY_READ_BYTES = 1_024
export const WEBHOOK_ERROR_MAX_CHARS = 500

const PRIVATE_ADDRESS_ERROR = 'EWEBHOOK_PRIVATE_ADDRESS'
const NOT_PUBLIC = 'The webhook URL must be a public internet address. Nothing was sent.'

// Every range that is not the public internet. IPv4 first, then IPv6; the IPv6 list blocks whole
// transition ranges (NAT64, 6to4, Teredo) because each can carry a private IPv4 inside. IPv4-mapped
// addresses (::ffff:a.b.c.d) need no rule: BlockList checks them against the IPv4 rules. A rule for
// ::ffff:0:0/96 would block EVERY IPv4 address (measured 2026-09-19: BlockList maps IPv4 into it).
const NON_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
  ['ff00::', 8],
] as const) NON_PUBLIC.addSubnet(network, prefix, 'ipv6')

/** True only for an IP address on the public internet. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  try {
    return !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4')
  } catch {
    return false
  }
}

/** Test seams only. Production callers pass nothing. */
export interface WebhookTransportOptions {
  resolve?: typeof dnsLookup
  isAllowed?: (address: string) => boolean
  allowHttp?: boolean
  timeoutMs?: number
}

/**
 * Why this URL may not receive a webhook, as one plain sentence — or null when it may. Syntax and
 * host name only (no DNS); the connect-time lookup in deliverWebhook is the authority.
 */
export function webhookUrlProblem(raw: string, options: WebhookTransportOptions = {}): string | null {
  const isAllowed = options.isAllowed ?? isPublicAddress
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return 'Enter a valid https:// URL.'
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return 'The webhook URL must use HTTPS.'
  }
  if (url.username || url.password) return 'The webhook URL must not contain a user name or password.'
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (isIP(host)) return isAllowed(host) ? null : NOT_PUBLIC
  const internalName =
    !host.includes('.') ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.home.arpa', '.lan'].some((suffix) => host.endsWith(suffix))
  return internalName ? NOT_PUBLIC : null
}

/**
 * A socket lookup that refuses unless EVERY address the name resolves to is public. Handed to the
 * request itself, so the checked answer is the one connected to.
 */
export function guardedLookup(options: WebhookTransportOptions = {}): LookupFunction {
  const resolve = options.resolve ?? dnsLookup
  const isAllowed = options.isAllowed ?? isPublicAddress
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, answer) => {
      if (error) return callback(error, '', 0)
      const addresses = (Array.isArray(answer) ? answer : []) as LookupAddress[]
      if (addresses.length === 0 || addresses.some((a) => !isAllowed(a.address))) {
        const refused = Object.assign(new Error(NOT_PUBLIC), { code: PRIVATE_ADDRESS_ERROR }) as NodeJS.ErrnoException
        return callback(refused, '', 0)
      }
      if (lookupOptions?.all) return callback(null, addresses)
      return callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

export function capWebhookError(text: string | null | undefined): string | null {
  if (text == null) return null
  const flat = String(text)
  return flat.length > WEBHOOK_ERROR_MAX_CHARS ? `${flat.slice(0, WEBHOOK_ERROR_MAX_CHARS - 1)}…` : flat
}

export interface WebhookDelivery {
  ok: boolean
  /** HTTP status, or 0 when nothing came back (refused, network error, timeout). */
  status: number
  /** One plain sentence or the start of the receiver's reply; never longer than 500 characters. */
  error: string | null
  tookMs: number
}

/** POST one signed webhook body under the rules at the top of this file. Never throws. */
export async function deliverWebhook(
  input: { url: string; body: string; headers: Record<string, string> },
  options: WebhookTransportOptions = {},
): Promise<WebhookDelivery> {
  const started = Date.now()
  const done = (status: number, error: string | null): WebhookDelivery => ({
    ok: status >= 200 && status < 300 && error === null,
    status,
    error: capWebhookError(error),
    tookMs: Date.now() - started,
  })

  const problem = webhookUrlProblem(input.url, options)
  if (problem) return done(0, problem)

  const url = new URL(input.url.trim())
  const { request: send } = url.protocol === 'https:' ? await import('node:https') : await import('node:http')
  return new Promise((resolve) => {
    let settled = false
    const finish = (status: number, error: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(done(status, error))
    }
    const request = send(url, {
      method: 'POST',
      headers: { ...input.headers, 'Content-Length': String(Buffer.byteLength(input.body)) },
      lookup: guardedLookup(options),
      agent: false,
    })
    const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS
    const deadline = setTimeout(() => {
      request.destroy()
      finish(0, `No answer within ${Math.round(timeoutMs / 1000)} s.`)
    }, timeoutMs)

    request.on('response', (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (status >= 200 && status < 300) {
        response.destroy()
        return finish(status, null)
      }
      if (status >= 300 && status < 400) {
        response.destroy()
        return finish(status, `Redirects are not followed (HTTP ${status}).`)
      }
      const chunks: Buffer[] = []
      let size = 0
      const settleWithReply = () => {
        const text = Buffer.concat(chunks).subarray(0, WEBHOOK_REPLY_READ_BYTES).toString('utf8').trim()
        finish(status, text || `HTTP ${status}`)
      }
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        size += chunk.length
        if (size >= WEBHOOK_REPLY_READ_BYTES) {
          settleWithReply()
          response.destroy()
        }
      })
      response.on('end', settleWithReply)
      response.on('close', settleWithReply)
      response.on('error', settleWithReply)
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish(0, error.code === PRIVATE_ADDRESS_ERROR ? NOT_PUBLIC : error.message || String(error))
    })
    request.end(input.body)
  })
}

// ── Signing secret at rest ────────────────────────────────────────────────────────────────────────

/** Seal a new signing secret for the `secretHash` column. Throws when the encryption key is missing. */
export function sealWebhookSecret(secret: string): string {
  return encryptSecret(secret)
}

export type OpenedWebhookSecret =
  | { kind: 'encrypted'; secret: string }
  /** Written before P0.3. Still signs; the caller re-seals it on the same row write. */
  | { kind: 'legacy-plaintext'; secret: string }
  /** Written in the brief Phase E window; one-way, can never sign. */
  | { kind: 'legacy-bcrypt' }

/** Read the stored secret. Throws if a sealed secret fails its integrity check or the key is gone. */
export function openWebhookSecret(stored: string): OpenedWebhookSecret {
  if (stored.startsWith('$2')) return { kind: 'legacy-bcrypt' }
  if (isEncrypted(stored)) return { kind: 'encrypted', secret: decryptSecret(stored) }
  return { kind: 'legacy-plaintext', secret: stored }
}

/** The re-sealed value for a legacy plain-text row, or undefined when it cannot or need not change. */
export function resealIfLegacy(opened: OpenedWebhookSecret): string | undefined {
  if (opened.kind !== 'legacy-plaintext') return undefined
  try {
    return sealWebhookSecret(opened.secret)
  } catch {
    return undefined
  }
}
