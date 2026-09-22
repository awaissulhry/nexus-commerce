import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => m.transport }))
const { setupEbayNotifications, createEbayDestination } = await import('./notifications.js')
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', 'https://example.test/api/webhooks/ebay-notification')
  m.token.mockResolvedValue('fixture-app-token')
  m.transport.mockResolvedValue(new Response(JSON.stringify({ destinationId: 'destination-fixture' }), { status: 201 }))
})
afterEach(() => vi.unstubAllEnvs())
const invalid = ['', 'a'.repeat(31), 'a'.repeat(81), 'a'.repeat(32) + '=', 'a'.repeat(32) + ' ', 'a'.repeat(32) + '\n', 'a'.repeat(32) + 'é', 'a'.repeat(32) + '/', 'a'.repeat(32) + '+']
describe('eBay verification token preflight', () => {
  it.each(invalid)('rejects malformed token %j before even requesting an app token', async token => {
    vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', token)
    const result = await setupEbayNotifications()
    expect(result.configured).toBe(false)
    expect(result.error).toContain('EBAY_NOTIFICATION_VERIFICATION_TOKEN')
    if (token) expect(result.error).toMatch(/32.*80.*A-Za-z0-9_-/)
    expect(m.token).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
    if (token.length > 10) expect(result.error).not.toContain(token)
  })
  it('guards direct destination creation too', async () => {
    await expect(createEbayDestination('production', 'Nexus', 'https://example.test/hook', 'bad')).rejects.toThrow(/32.*80/)
    expect(m.token).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })
  it.each([32, 80])('positive control: accepts %i allowed characters and reaches the transport unchanged', async length => {
    const token = 'AZaz09_-'.repeat(10).slice(0, length)
    await expect(createEbayDestination('production', 'Nexus', 'https://example.test/hook', token)).resolves.toBe('destination-fixture')
    expect(m.transport).toHaveBeenCalledOnce()
    expect(JSON.parse(m.transport.mock.calls[0][1].body).deliveryConfig.verificationToken).toBe(token)
  })
})
