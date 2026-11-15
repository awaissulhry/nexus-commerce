import { describe, expect, it } from 'vitest'
import {
  MAX_FORWARDED_HOPS,
  NO_TRUSTED_PROXIES,
  TrustedProxiesError,
  cameThroughTrustedProxy,
  canonicalIp,
  clientAddress,
  forwardedEntries,
  forwardedEntry,
  forwardedForChain,
  trustedProxies,
} from './client-address'

// B-W2b-F57. Made-up addresses only: documentation ranges (RFC 5737, RFC 3849) for clients, private ranges for proxies.
const WEB = '10.0.0.5'
const EDGE = '100.64.3.4'
const BROWSER = '198.51.100.7'
const OTHER = '203.0.113.9'

describe('canonicalIp', () => {
  it('reads IPv4 and IPv6, and writes one canonical form', () => {
    expect(canonicalIp('198.51.100.7')).toBe('198.51.100.7')
    expect(canonicalIp(' 198.51.100.7 ')).toBe('198.51.100.7')
    expect(canonicalIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(canonicalIp('2001:db8:0000:0001:0000:0000:0000:0001')).toBe('2001:db8:0:1::1')
    expect(canonicalIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1')
    expect(canonicalIp('::1')).toBe('::1')
    expect(canonicalIp('::')).toBe('::')
    expect(canonicalIp('fe80::1%en0')).toBe('fe80::1')
    expect(canonicalIp('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8')
    expect(canonicalIp('1::2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7')
  })

  it('gives an IPv4-mapped IPv6 address (a dual-stack socket) as its IPv4 address', () => {
    expect(canonicalIp('::ffff:198.51.100.7')).toBe(BROWSER)
    expect(canonicalIp('::FFFF:c633:6407')).toBe(BROWSER)
    expect(canonicalIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
  })

  it('refuses what is no address', () => {
    for (const text of ['', ' ', 'unknown', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', '1:2:3:4:5:6:7:8:9', '1::2::3', ':1', '1:', '12345::1', 'g::1', '1::2:3:4:5:6:7:8', '::1.2.3.4:5', '[::1]', '198.51.100.7:80']) {
      expect(canonicalIp(text), text).toBeNull()
    }
    expect(canonicalIp(undefined)).toBeNull()
    expect(canonicalIp(null)).toBeNull()
  })
})

describe('forwardedEntry / forwardedEntries', () => {
  it('reads an entry bare, in brackets, or with a port', () => {
    expect(forwardedEntry(' 198.51.100.7 ')).toBe(BROWSER)
    expect(forwardedEntry('198.51.100.7:51234')).toBe(BROWSER)
    expect(forwardedEntry('[2001:db8::7]')).toBe('2001:db8::7')
    expect(forwardedEntry('[2001:db8::7]:443')).toBe('2001:db8::7')
    expect(forwardedEntry('2001:db8::7')).toBe('2001:db8::7')
    expect(forwardedEntry('[198.51.100.7]')).toBeNull()
    expect(forwardedEntry('unknown')).toBeNull()
    expect(forwardedEntry('_hidden')).toBeNull()
  })

  it('splits one header or several lines, left to right, without empty entries', () => {
    expect(forwardedEntries('198.51.100.7, 100.64.3.4')).toEqual([BROWSER, EDGE])
    expect(forwardedEntries(['198.51.100.7', ' 100.64.3.4 ,, ', '10.0.0.5'])).toEqual([BROWSER, EDGE, WEB])
    expect(forwardedEntries(undefined)).toEqual([])
    expect(forwardedEntries('')).toEqual([])
  })
})

describe('trustedProxies', () => {
  it('reads addresses, ranges and the named sets, and describes them canonically', () => {
    const trusted = trustedProxies('loopback, 10.0.0.0/8 2001:DB8::/32,203.0.113.1')
    expect(trusted.description).toBe('loopback, 10.0.0.0/8, 2001:db8::/32, 203.0.113.1')
    expect(trusted.isEmpty).toBe(false)
    for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '10.1.2.3', '2001:db8:ffff::1', '203.0.113.1']) expect(trusted.has(address), address).toBe(true)
    for (const address of ['128.0.0.1', '::2', '11.0.0.1', '2001:db9::1', '203.0.113.2', 'unknown', '', undefined, null]) expect(trusted.has(address), String(address)).toBe(false)
  })

  it('names private: RFC 1918, the shared space Railway uses and IPv6 unique local; never public space', () => {
    const trusted = trustedProxies('private')
    for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', 'fd12:3456::1', 'fc00::1']) expect(trusted.has(address), address).toBe(true)
    for (const address of ['172.32.0.1', '100.128.0.1', '192.169.0.1', BROWSER, OTHER, '2001:db8::1', '127.0.0.1', '::1']) expect(trusted.has(address), address).toBe(false)
  })

  it('reads a range on a bit boundary inside a byte, and an IPv4-mapped range as its IPv4 range', () => {
    const trusted = trustedProxies('198.51.100.64/26, ::ffff:203.0.113.0/120')
    expect(trusted.has('198.51.100.64')).toBe(true)
    expect(trusted.has('198.51.100.127')).toBe(true)
    expect(trusted.has('198.51.100.63')).toBe(false)
    expect(trusted.has('198.51.100.128')).toBe(false)
    expect(trusted.has('203.0.113.200')).toBe(true)
    expect(trusted.description).toBe('198.51.100.64/26, 203.0.113.0/24')
  })

  it('trusts nobody for an empty list or none', () => {
    for (const list of [undefined, null, '', '  ', 'none', 'NONE']) {
      expect(trustedProxies(list)).toBe(NO_TRUSTED_PROXIES)
    }
    expect(NO_TRUSTED_PROXIES.has('127.0.0.1')).toBe(false)
  })

  it('refuses trust-everything, unknown words and bad entries, in words', () => {
    for (const list of ['*', 'all', 'true', '1', '0.0.0.0/0', '::/0', '10.0.0.0/7', 'fc00::/6', '::ffff:0.0.0.0/96', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.0/x', 'localhost', 'loopback none', 'private,,, everything']) {
      expect(() => trustedProxies(list), list).toThrow(TrustedProxiesError)
    }
    expect(() => trustedProxies('0.0.0.0/0')).toThrow(/too wide: a trusted range is at least \/8 \(never "trust everything"\)/)
    expect(() => trustedProxies('localhost')).toThrow(/"localhost" is not an address, a range \(address\/prefix\) or one of: loopback, private, none/)
  })
})

describe('clientAddress (the API)', () => {
  const trusted = trustedProxies(`${WEB}, private`)

  it('keeps the TCP address of a request that does not come from a trusted proxy, whatever header it sends', () => {
    expect(clientAddress({ socket: OTHER, forwardedFor: '192.0.2.1' }, trusted)).toBe(OTHER)
    expect(clientAddress({ socket: OTHER, forwardedFor: [`192.0.2.1`, WEB] }, trusted)).toBe(OTHER)
    expect(clientAddress({ socket: BROWSER, forwardedFor: undefined }, trusted)).toBe(BROWSER)
    expect(clientAddress({ socket: '127.0.0.1', forwardedFor: '192.0.2.1' }, trusted)).toBe('127.0.0.1')
  })

  it('takes the browser from a trusted proxy, and the right-most untrusted address of several hops', () => {
    expect(clientAddress({ socket: WEB, forwardedFor: BROWSER }, trusted)).toBe(BROWSER)
    // browser → Railway edge → web → API: the edge wrote the browser, the web appended the edge.
    expect(clientAddress({ socket: WEB, forwardedFor: `${BROWSER}, ${EDGE}` }, trusted)).toBe(BROWSER)
    // A browser that wrote its own header before the edge: the edge appends, the forged entry stays left of the truth.
    expect(clientAddress({ socket: WEB, forwardedFor: `192.0.2.1, ${BROWSER}, ${EDGE}` }, trusted)).toBe(BROWSER)
    // Two header lines read as one chain.
    expect(clientAddress({ socket: WEB, forwardedFor: ['192.0.2.1', `${BROWSER}, ${EDGE}`] }, trusted)).toBe(BROWSER)
  })

  it('reads IPv6 at every hop, a dual-stack socket, brackets and ports', () => {
    const v6 = trustedProxies('fd12::/16')
    expect(clientAddress({ socket: 'fd12::5', forwardedFor: '2001:db8::7, fd12::9' }, v6)).toBe('2001:db8::7')
    expect(clientAddress({ socket: 'fd12::5', forwardedFor: '[2001:db8::7]:51234' }, v6)).toBe('2001:db8::7')
    expect(clientAddress({ socket: '::ffff:10.0.0.5', forwardedFor: '198.51.100.7:51234' }, trusted)).toBe(BROWSER)
    expect(clientAddress({ socket: '::ffff:198.51.100.7', forwardedFor: '192.0.2.1' }, trusted)).toBe(BROWSER)
  })

  it('stops at the last trusted proxy when an entry is no address, and answers the left-most when all are trusted', () => {
    expect(clientAddress({ socket: WEB, forwardedFor: `${BROWSER}, nonsense` }, trusted)).toBe(WEB)
    expect(clientAddress({ socket: WEB, forwardedFor: `nonsense, ${EDGE}` }, trusted)).toBe(EDGE)
    expect(clientAddress({ socket: WEB, forwardedFor: `${EDGE}, 10.9.9.9` }, trusted)).toBe(EDGE)
    expect(clientAddress({ socket: WEB, forwardedFor: '' }, trusted)).toBe(WEB)
    expect(clientAddress({ socket: WEB, forwardedFor: undefined }, trusted)).toBe(WEB)
  })

  it(`reads at most ${MAX_FORWARDED_HOPS} entries from the right`, () => {
    const proxies = Array.from({ length: MAX_FORWARDED_HOPS + 5 }, (_, index) => `10.1.0.${index + 1}`)
    expect(clientAddress({ socket: WEB, forwardedFor: [BROWSER, ...proxies].join(', ') }, trusted)).toBe(`10.1.0.6`)
  })

  it('never trusts a socket that is no address, and trusts nobody with none', () => {
    expect(clientAddress({ socket: undefined, forwardedFor: BROWSER }, trusted)).toBe('unknown')
    expect(clientAddress({ socket: 'a-unix-socket', forwardedFor: BROWSER }, trusted)).toBe('unknown')
    expect(clientAddress({ socket: WEB, forwardedFor: BROWSER }, NO_TRUSTED_PROXIES)).toBe(WEB)
  })

  it('says whether a request came through a trusted proxy', () => {
    expect(cameThroughTrustedProxy({ socket: WEB }, trusted)).toBe(true)
    expect(cameThroughTrustedProxy({ socket: '::ffff:10.0.0.5' }, trusted)).toBe(true)
    expect(cameThroughTrustedProxy({ socket: OTHER }, trusted)).toBe(false)
    expect(cameThroughTrustedProxy({ socket: undefined }, trusted)).toBe(false)
  })
})

describe('forwardedForChain (the web proxy)', () => {
  it('drops a header from anybody but a trusted edge and sends the peer alone', () => {
    expect(forwardedForChain({ socket: BROWSER, forwardedFor: '192.0.2.1' }, trustedProxies('private'))).toBe(BROWSER)
    expect(forwardedForChain({ socket: '::ffff:198.51.100.7', forwardedFor: undefined }, NO_TRUSTED_PROXIES)).toBe(BROWSER)
    expect(forwardedForChain({ socket: '::1', forwardedFor: '192.0.2.1' }, NO_TRUSTED_PROXIES)).toBe('::1')
  })

  it('appends the edge to the chain it received from a trusted edge', () => {
    expect(forwardedForChain({ socket: EDGE, forwardedFor: BROWSER }, trustedProxies('private'))).toBe(`${BROWSER}, ${EDGE}`)
    expect(forwardedForChain({ socket: EDGE, forwardedFor: undefined }, trustedProxies('private'))).toBe(EDGE)
    expect(forwardedForChain({ socket: EDGE, forwardedFor: ['192.0.2.1', BROWSER] }, trustedProxies('private'))).toBe(`192.0.2.1, ${BROWSER}, ${EDGE}`)
  })

  it(`keeps at most the last ${MAX_FORWARDED_HOPS} received entries, and sends nothing for a peer that is no address`, () => {
    const long = Array.from({ length: MAX_FORWARDED_HOPS + 3 }, (_, index) => `192.0.2.${index + 1}`)
    const chain = forwardedForChain({ socket: EDGE, forwardedFor: long.join(',') }, trustedProxies('private'))!
    expect(chain.split(', ')).toEqual([...long.slice(-MAX_FORWARDED_HOPS), EDGE])
    expect(forwardedForChain({ socket: undefined, forwardedFor: BROWSER }, trustedProxies('private'))).toBeNull()
  })

  it('is read back by the API as the browser (web → API, both rules together)', () => {
    const atWeb = forwardedForChain({ socket: EDGE, forwardedFor: BROWSER }, trustedProxies('private'))
    expect(clientAddress({ socket: WEB, forwardedFor: atWeb }, trustedProxies('private'))).toBe(BROWSER)
    // Locally: no edge in front of the web, the browser on loopback, the API trusting loopback.
    const local = forwardedForChain({ socket: '::1', forwardedFor: '192.0.2.1' }, NO_TRUSTED_PROXIES)
    expect(clientAddress({ socket: '127.0.0.1', forwardedFor: local }, trustedProxies('loopback'))).toBe('::1')
  })
})
