import { describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/connection-resolver.service.js', () => ({ CONNECTION_PUBLIC_SELECT: {} }))
vi.mock('../services/cx/oauth.service.js', () => ({ complete: vi.fn(), start: vi.fn(), OAuthFlowError: class extends Error {} }))
vi.mock('../services/cx/events.service.js', () => ({ recordConnectionEvent: vi.fn() }))
vi.mock('../services/cx/connectors/amazon-sp/self-authorization.js', () => ({
  importAmazonEnvironmentAuthorization: vi.fn(), AmazonSelfAuthorizationError: class extends Error {},
}))
const { __cxConnectTest } = await import('./cx-connect.routes.js')

describe('OAuth callback account-name serialization', () => {
  it('keeps an operator-supplied closing script tag as data, without creating executable HTML', () => {
    const name = '</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>'
    const html = __cxConnectTest.callbackPage({
      ok: true, title: 'Connected', body: `Account: ${name}`,
      payload: { sellerName: name, state: 'expected-state' },
    })
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).not.toContain('<img src=x')
    const serialized = html.match(/var msg=(.*); var origin=/)?.[1]
    expect(serialized).toContain('\\u003c/script>')
    expect(JSON.parse(serialized!)).toMatchObject({ sellerName: name, state: 'expected-state' })
  })

  it('preserves readable names, quotes, ampersands and Unicode in the message', () => {
    const name = 'Caffè "Moto" & Racing'
    const html = __cxConnectTest.callbackPage({ ok: true, title: 'Connected', body: name, payload: { sellerName: name } })
    expect(JSON.parse(html.match(/var msg=(.*); var origin=/)![1]).sellerName).toBe(name)
    expect(html).toContain('Caffè &quot;Moto&quot; &amp; Racing')
  })
})
