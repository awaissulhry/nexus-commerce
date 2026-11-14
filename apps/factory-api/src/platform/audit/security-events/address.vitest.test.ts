import { describe, expect, it } from 'vitest'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { authSecrets } from '../../auth/sessions/secrets'
import { addressHashOf, isIpAddress } from './address'

/** A search by address (B-W2b-399; PLT-077): only an address is hashed, and as the sessions hash it (never stored as typed). */
describe('addressHashOf', () => {
  it('knows IPv4 and IPv6 addresses, refuses anything else', () => {
    for (const address of ['192.0.2.10', '0.0.0.0', '255.255.255.255', '2001:db8::1', '::1', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::ffff:192.0.2.1']) expect(isIpAddress(address), address).toBe(true)
    for (const address of ['256.1.1.1', '1.2.3', 'a.b.c.d', 'example.com', '2001:db8:::1', '1:2:3:4:5:6:7:8:9', 'gggg::1', '']) expect(isIpAddress(address), address).toBe(false)
  })

  it('is the sessions’ own keyed hash of the shortened address; a bad one is a 400 on the field', () => {
    const sessions = authSecrets(LOCAL_COOKIE_SECRET)
    expect(addressHashOf(' 192.0.2.10 ', 'querystring/ip')).toBe(sessions.ipHash('192.0.2.10'))
    // The same /24 (as the sessions keep it): the same hash.
    expect(addressHashOf('192.0.2.99', 'querystring/ip')).toBe(sessions.ipHash('192.0.2.10'))
    let refused: unknown
    try {
      addressHashOf('nope', 'querystring/ip')
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(ValidationError)
    expect((refused as ValidationError).issues).toEqual([{ path: 'querystring/ip', message: 'Type an IPv4 or IPv6 address.' }])
  })
})
