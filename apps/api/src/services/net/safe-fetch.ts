import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'

/**
 * The one way to fetch an address a person typed (a catalog source link, a photo link). Moved here from
 * services/pim/catalog-source-fetch.ts so every such fetch shares it (MCP full control P2).
 *
 * - Only http(s), no embedded credentials, only the default ports (80/443).
 * - The host must RESOLVE to public internet addresses only: loopback, private networks, link-local (the cloud
 *   metadata address 169.254.169.254), carrier-grade NAT, test, multicast and non-global IPv6 are refused.
 * - The connection is pinned to the checked DNS answer, so a second lookup cannot swap in another address.
 * - Time and bytes are bounded. Redirects are refused unless `maxRedirects` allows them; each hop is then checked
 *   exactly like the first address before anything is requested from it.
 */

export function publicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase()
    // Restrict IPv6 to global unicast, excluding mapped/transition/local ranges.
    return /^[23]/.test(a) && !a.startsWith('2001:') && !a.startsWith('2002:')
  }
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0)
}

/** Why a fetch did not return a body: the address was refused, the source answered non-200, or it was too large. */
export class SafeFetchError extends Error {
  constructor(message: string, readonly reason: 'refused' | 'status' | 'too_large', readonly status?: number) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

export interface SafeFetchOptions {
  maxBytes: number
  timeoutMs: number
  /** How many redirects to follow; 0 (the default) refuses every redirect. */
  maxRedirects?: number
}

export interface SafeFetchResult {
  buffer: Buffer
  contentType: string | null
  /** The address the body came from, after any redirects. */
  url: URL
}

type Answer = { address: string; family: number }

async function checkedAddress(url: URL): Promise<Answer> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) {
    throw new SafeFetchError('Use a public HTTP(S) source URL without embedded credentials or a custom port', 'refused')
  }
  const answers = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!answers.length || answers.some(a => !publicAddress(a.address))) {
    throw new SafeFetchError('Source URL must resolve to a public internet address', 'refused')
  }
  return answers[0]
}

type Hop = { kind: 'body'; buffer: Buffer; contentType: string | null } | { kind: 'redirect'; location: string }

function getPinned(url: URL, address: Answer, options: SafeFetchOptions, followRedirect: boolean): Promise<Hop> {
  const megabytes = Math.round(options.maxBytes / (1024 * 1024))
  return new Promise<Hop>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: ((_hostname, lookupOptions, callback) => lookupOptions.all ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
      signal: AbortSignal.timeout(options.timeoutMs), headers: { 'Accept-Encoding': 'identity' },
    }, response => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (followRedirect && status >= 300 && status < 400 && location) { response.resume(); resolve({ kind: 'redirect', location }); return }
      if (status !== 200) {
        response.resume()
        reject(new SafeFetchError(`Source returned HTTP ${status}${options.maxRedirects ? '' : '; redirects are not followed'}`, 'status', status))
        return
      }
      if (Number(response.headers['content-length']) > options.maxBytes) { request.destroy(new SafeFetchError(`Source exceeds ${megabytes} MB`, 'too_large')); return }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxBytes) request.destroy(new SafeFetchError(`Source exceeds ${megabytes} MB`, 'too_large'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const type = response.headers['content-type']
        resolve({ kind: 'body', buffer: Buffer.concat(chunks), contentType: typeof type === 'string' ? type : null })
      })
    })
    request.on('error', reject)
  })
}

export async function safeFetch(sourceUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let url = new URL(sourceUrl)
  const maxRedirects = options.maxRedirects ?? 0
  for (let hop = 0; ; hop++) {
    const address = await checkedAddress(url)
    const result = await getPinned(url, address, options, hop < maxRedirects)
    if (result.kind === 'body') return { buffer: result.buffer, contentType: result.contentType, url }
    url = new URL(result.location, url)
  }
}
