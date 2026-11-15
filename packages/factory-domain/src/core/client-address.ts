/**
 * Whose address a request carries (B-W2b-F57; PLT-244, PLT-066, PLT-075; GDPR art. 32). Every browser reaches the API
 * through the factory web (and, on Railway, the web through Railway's edge), so the TCP peer the API sees is a proxy, not
 * the person. The address that the rate limit, sessions, security events and audit use is decided here, ONCE, for the
 * API (`clientAddress`) and for the web's proxy (`forwardedForChain`):
 *
 *   - X-Forwarded-For counts only when the request came from a TRUSTED proxy (a list of addresses, CIDR ranges and the
 *     named sets `loopback` and `private`; never "trust everything"). A request from anybody else keeps its own TCP
 *     address, whatever header it sends: a forged header can neither dodge the rate limit nor write another address
 *     into a session or a security event.
 *   - From a trusted proxy, the chain is read right to left (each proxy appends the address it received the request
 *     from) and the client is the right-most address that is NOT a trusted proxy. An entry that is no address stops the
 *     walk at the last proxy we trust (a proxy appends addresses, so garbage there is a client's, never an address).
 *   - Addresses are compared and returned in one canonical form (IPv4 dotted; IPv6 compressed, lower case, RFC 5952;
 *     an IPv4-mapped IPv6 address as its IPv4), so `::ffff:198.51.100.7` and `198.51.100.7` are one client.
 *
 * Pure: no I/O, no environment. apps/factory-api reads its list from FACTORY_TRUSTED_PROXIES (env.ts) and applies it in
 * core/client-address.ts; apps/factory-web reads its own (the edges in front of it) in src/lib/api/forwarded.ts.
 */

/** Most X-Forwarded-For entries read, from the right (a chain longer than this is cut, never trusted further). */
export const MAX_FORWARDED_HOPS = 20

/** The named sets a list may use. */
export const NAMED_PROXY_SETS = {
  /** This machine: 127.0.0.0/8 and ::1. The local default of the API (the web runs beside it). */
  loopback: ['127.0.0.0/8', '::1/128'],
  /**
   * Addresses that are never on the public internet: RFC 1918 (10/8, 172.16/12, 192.168/16), RFC 6598 shared space
   * (100.64/10, which Railway's edge and private network use) and IPv6 unique local (fc00::/7). On Railway, where the
   * edge publishes no address range and every peer of a service is the edge or a service of the same project.
   */
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'],
} as const satisfies Record<string, readonly string[]>

/** The shortest prefix a range may have: a wider one would trust public address space. */
const MIN_PREFIX = { 4: 8, 16: 7 } as const

export class TrustedProxiesError extends Error {
  override name = 'TrustedProxiesError'
}

/** The bytes of an IP address: 4 for IPv4 (and an IPv4-mapped IPv6 address), 16 for IPv6. Null when it is none. */
export function parseIp(text: string): Uint8Array | null {
  const value = text.trim()
  if (value === '') return null
  if (!value.includes(':')) return parseIpv4(value)
  const bytes = parseIpv6(value.replace(/%[0-9A-Za-z._~-]+$/, ''))
  if (bytes === null) return null
  return isIpv4Mapped(bytes) ? bytes.slice(12) : bytes
}

/** An address in its canonical text, or null when the text is no address. */
export function canonicalIp(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const bytes = parseIp(text)
  return bytes === null ? null : formatIp(bytes)
}

/** The canonical text of 4 or 16 address bytes. */
export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join('.')
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0))
  // RFC 5952 §4.2: the longest run of two or more zero groups becomes `::` (the first one when two are as long).
  let bestStart = -1
  let bestLength = 1
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start += 1
      continue
    }
    let end = start
    while (end < 8 && groups[end] === 0) end += 1
    if (end - start > bestLength) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  const hex = (from: number, to: number) => groups.slice(from, to).map((group) => group.toString(16)).join(':')
  if (bestStart < 0) return hex(0, 8)
  return `${hex(0, bestStart)}::${hex(bestStart + bestLength, 8)}`
}

/** One X-Forwarded-For entry as an address: bare, `[v6]`, `[v6]:port` or `v4:port`. Null when it is none. */
export function forwardedEntry(text: string): string | null {
  const value = text.trim()
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value)
  if (bracketed) return bracketed[1]!.includes(':') ? canonicalIp(bracketed[1]!) : null
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value)
  return canonicalIp(withPort ? withPort[1]! : value)
}

/** The entries of X-Forwarded-For (one header or several lines of it), left to right, empty ones left out. */
export function forwardedEntries(header: string | readonly string[] | null | undefined): string[] {
  if (header === null || header === undefined) return []
  const lines = typeof header === 'string' ? [header] : header
  return lines.flatMap((line) => line.split(',')).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

interface Range {
  readonly bytes: Uint8Array
  readonly prefix: number
}

/** The proxies whose X-Forwarded-For counts. */
export interface TrustedProxies {
  /** The list as configured, in canonical words (`loopback, 10.0.0.0/8`), or `none`. */
  readonly description: string
  readonly isEmpty: boolean
  /** True when the address (any text form) is one of the trusted proxies. */
  has(address: string | null | undefined): boolean
}

/** Trusts nobody: every request keeps its own TCP address. */
export const NO_TRUSTED_PROXIES: TrustedProxies = Object.freeze({ description: 'none', isEmpty: true, has: () => false })

function rangeOf(entry: string): Range {
  const [address, prefixText, ...rest] = entry.split('/')
  const bytes = address === undefined ? null : parseIp(address)
  if (bytes === null || rest.length > 0 || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) {
    throw new TrustedProxiesError(`"${entry}" is not an address, a range (address/prefix) or one of: ${Object.keys(NAMED_PROXY_SETS).join(', ')}, none`)
  }
  // An IPv4-mapped IPv6 range is its IPv4 range (parseIp gave 4 bytes): its prefix counts from bit 96.
  const mapped = bytes.length === 4 && address!.includes(':')
  const width = bytes.length * 8
  const prefix = prefixText === undefined ? width : Number(prefixText) - (mapped ? 96 : 0)
  if (prefix < 0 || prefix > width) throw new TrustedProxiesError(`"${entry}" has a prefix outside 0-${mapped ? 128 : width}`)
  const minimum = MIN_PREFIX[bytes.length as 4 | 16]
  if (prefix < minimum) {
    throw new TrustedProxiesError(`"${entry}" is too wide: a trusted range is at least /${minimum} (never "trust everything")`)
  }
  return { bytes, prefix }
}

function inRange(address: Uint8Array, range: Range): boolean {
  if (address.length !== range.bytes.length) return false
  const whole = Math.floor(range.prefix / 8)
  for (let index = 0; index < whole; index += 1) if (address[index] !== range.bytes[index]) return false
  const bits = range.prefix % 8
  if (bits === 0) return true
  const mask = (0xff << (8 - bits)) & 0xff
  return ((address[whole] ?? 0) & mask) === ((range.bytes[whole] ?? 0) & mask)
}

/**
 * The trusted proxies of a list: entries separated by commas or spaces, each an address, a range `address/prefix` or a
 * named set (`loopback`, `private`); `none` (alone) or an empty list trusts nobody. Throws TrustedProxiesError, in words,
 * for anything else: an unknown word, a bad address, `*`, `all`, or a range wider than /8 (IPv4) or /7 (IPv6).
 */
export function trustedProxies(list: string | null | undefined): TrustedProxies {
  const entries = (list ?? '').split(/[\s,]+/).filter((entry) => entry !== '')
  if (entries.length === 0 || (entries.length === 1 && entries[0]!.toLowerCase() === 'none')) return NO_TRUSTED_PROXIES
  const ranges: Range[] = []
  const words: string[] = []
  for (const raw of entries) {
    const entry = raw.toLowerCase()
    if (entry === 'none') throw new TrustedProxiesError('"none" stands alone: it trusts nobody, so it cannot be listed with proxies')
    if (Object.hasOwn(NAMED_PROXY_SETS, entry)) {
      for (const member of NAMED_PROXY_SETS[entry as keyof typeof NAMED_PROXY_SETS]) ranges.push(rangeOf(member))
      words.push(entry)
      continue
    }
    const range = rangeOf(entry)
    ranges.push(range)
    words.push(range.prefix === range.bytes.length * 8 ? formatIp(range.bytes) : `${formatIp(range.bytes)}/${range.prefix}`)
  }
  const description = [...new Set(words)].join(', ')
  return Object.freeze({
    description,
    isEmpty: false,
    has(address: string | null | undefined) {
      const bytes = typeof address === 'string' ? parseIp(address) : null
      return bytes !== null && ranges.some((range) => inRange(bytes, range))
    },
  })
}

/** What a request says about where it came from: its TCP peer and the X-Forwarded-For it carried. */
export interface RequestAddresses {
  readonly socket: string | null | undefined
  readonly forwardedFor: string | readonly string[] | null | undefined
}

/**
 * THE client address of a request (the API's rule). The TCP peer, unless it is a trusted proxy: then the right-most
 * X-Forwarded-For entry that is not a trusted proxy (every entry trusted: the left-most one). A peer that is no address
 * (none in a test without a socket) is `unknown` and never trusted.
 */
export function clientAddress(request: RequestAddresses, trusted: TrustedProxies): string {
  const socket = canonicalIp(request.socket)
  if (socket === null) return 'unknown'
  if (!trusted.has(socket)) return socket
  let current = socket
  const entries = forwardedEntries(request.forwardedFor)
  for (let index = entries.length - 1, read = 0; index >= 0 && read < MAX_FORWARDED_HOPS; index -= 1, read += 1) {
    const address = forwardedEntry(entries[index]!)
    if (address === null) return current
    if (!trusted.has(address)) return address
    current = address
  }
  return current
}

/** True when the request's TCP peer is a trusted proxy (so headers a proxy sets, such as a place, can count). */
export function cameThroughTrustedProxy(request: Pick<RequestAddresses, 'socket'>, trusted: TrustedProxies): boolean {
  return trusted.has(request.socket)
}

/**
 * The X-Forwarded-For a proxy sends on (the web's rule): the chain it received, only when its TCP peer is a trusted edge,
 * then that peer's address; from anybody else, the peer's address alone (a browser's own header is dropped). Null when
 * the peer is no address: send nothing then, so the next hop sees the proxy itself.
 */
export function forwardedForChain(request: RequestAddresses, trusted: TrustedProxies): string | null {
  const socket = canonicalIp(request.socket)
  if (socket === null) return null
  if (!trusted.has(socket)) return socket
  const received = forwardedEntries(request.forwardedFor).slice(-MAX_FORWARDED_HOPS)
  return [...received, socket].join(', ')
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (const [index, part] of parts.entries()) {
    // Decimal only: a leading zero (`010`) means octal to some parsers, so it is refused rather than guessed.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const number = Number(part)
    if (number > 255) return null
    bytes[index] = number
  }
  return bytes
}

function parseIpv6(value: string): Uint8Array | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(value)) return null
  const halves = value.split('::')
  if (halves.length > 2) return null
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const pieces = part.split(':')
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        // An embedded IPv4 address, only as the last piece.
        if (index !== pieces.length - 1) return null
        const v4 = parseIpv4(piece)
        if (v4 === null) return null
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
        continue
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }
  const head = groupsOf(halves[0]!)
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : []
  if (head === null || tail === null) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail]
  const bytes = new Uint8Array(16)
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8
    bytes[index * 2 + 1] = group & 0xff
  }
  return bytes
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let index = 0; index < 10; index += 1) if (bytes[index] !== 0) return false
  return bytes[10] === 0xff && bytes[11] === 0xff
}
