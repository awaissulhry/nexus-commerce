/**
 * CX.2 §5 — the detail page's pure half (`channelDetail.ts`), in the node-only web suite.
 * No jsdom, no testing-library, no React plugin — deliberate (vitest.config.ts) — so the
 * component is thin over these helpers and the helpers carry the assertions.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  disconnectHold,
  eventTone,
  identityLine,
  marketplaceOptions,
  marketplacesDescription,
  marketplacesPatchBody,
  patchMarketplaces,
  permissionsCopy,
  reconnectHold,
  reconnectLabel,
  relativeWhen,
  runHeartbeat,
  sameSet,
  showLastError,
  startReconnect,
  statusPill,
  testHold,
  timestampText,
  toggleMarketplace,
  type ChannelConnection,
} from './channelDetail'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')

function connection(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'conn_1',
    channel: 'EBAY',
    isActive: true,
    isManagedBy: 'oauth',
    sellerName: 'xaviaracing',
    storeName: null,
    storeFrontUrl: null,
    tokenExpiresAt: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-08-29T11:00:00.000Z',
    authStatus: 'connected',
    region: 'EU',
    grantedScopes: ['sell.inventory', 'sell.account'],
    scopeDrift: [],
    accessTokenExpiresAt: '2026-08-29T13:30:00.000Z',
    refreshTokenExpiresAt: '2027-12-01T00:00:00.000Z',
    lastRefreshAt: '2026-08-29T11:30:00.000Z',
    lastHeartbeatAt: '2026-08-29T11:45:00.000Z',
    lastInboundAt: null,
    lastOutboundAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    identity: { username: 'xaviaracing' },
    ...over,
  }
}

/** A `fetch` stand-in that records the call and answers with `body` at `status`. */
function fakeFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('statusPill — the §2 tone/label table, from authStatus and nothing else', () => {
  it.each([
    ['connected', 'success', 'Connected'],
    ['degraded', 'warning', 'Degraded — 3 failures'],
    ['needs_reauth', 'danger', 'Sign-in needed'],
    ['revoked', 'danger', 'Access revoked'],
    ['disconnected', 'neutral', 'Disconnected'],
    ['unknown', 'info', 'Not yet checked'],
  ])('%s → %s "%s"', (status, tone, label) => {
    expect(statusPill(status, 3)).toEqual({ tone, label })
  })

  it('singular failure count', () => {
    expect(statusPill('degraded', 1).label).toBe('Degraded — 1 failure')
  })

  it('an unknown string is "Not yet checked", never derived from isActive', () => {
    expect(statusPill('something-new', 0)).toEqual({ tone: 'info', label: 'Not yet checked' })
  })
})

describe('timestamps — relative text, absolute ISO in the title, honest nulls', () => {
  it('an event timestamp', () => {
    const cell = timestampText('2026-08-29T11:45:00.000Z', 'event', NOW)
    expect(cell).toEqual({ text: '15m ago', title: '2026-08-29T11:45:00.000Z', past: true })
  })

  it('a future expiry reads "in …" and is not past', () => {
    const cell = timestampText('2026-08-29T13:30:00.000Z', 'expiry', NOW)
    expect(cell.text).toBe('in 1h 30m')
    expect(cell.past).toBe(false)
  })

  it('null event → "never"; null expiry → "not recorded"; null inbound/outbound → "not tracked yet"', () => {
    expect(timestampText(null, 'event', NOW)).toEqual({ text: 'never' })
    expect(timestampText(null, 'expiry', NOW)).toEqual({ text: 'not recorded' })
    expect(timestampText(null, 'untracked', NOW)).toEqual({ text: 'not tracked yet' })
  })

  it('relativeWhen scales through minutes, hours, days and months', () => {
    expect(relativeWhen('2026-08-29T11:59:40.000Z', NOW)).toBe('just now')
    expect(relativeWhen('2026-08-29T11:20:00.000Z', NOW)).toBe('40m ago')
    expect(relativeWhen('2026-08-27T10:00:00.000Z', NOW)).toBe('2d 2h ago')
    expect(relativeWhen('2027-12-01T00:00:00.000Z', NOW)).toBe('in 15mo')
    expect(relativeWhen('2026-08-29T12:00:30.000Z', NOW)).toBe('in under a minute')
  })

  it('an unparseable value is shown verbatim rather than as NaN', () => {
    expect(relativeWhen('not-a-date', NOW)).toBe('not-a-date')
  })
})

describe('permissions — §2 copy and the Reconnect relabel', () => {
  it('drift', () => {
    expect(permissionsCopy(22, 3)).toBe('22 granted · 3 not granted — reconnect to grant them.')
    expect(reconnectLabel(3)).toBe('Reconnect to grant 3 permissions')
    expect(reconnectLabel(1)).toBe('Reconnect to grant 1 permission')
  })
  it('no drift', () => {
    expect(permissionsCopy(22, 0)).toBe('22 permissions granted — every permission this channel asks for.')
    expect(permissionsCopy(1, 0)).toBe('1 permission granted — every permission this channel asks for.')
    expect(reconnectLabel(0)).toBe('Reconnect')
  })
  it('nothing recorded', () => {
    expect(permissionsCopy(0, 0)).toMatch(/^No permissions recorded/)
  })
})

describe('last error — shown only while the status says something is wrong', () => {
  it.each([
    ['degraded', true],
    ['needs_reauth', true],
    ['connected', false],
    ['revoked', false],
  ])('%s → %s', (authStatus, shown) => {
    expect(showLastError(connection({ authStatus, lastError: 'auth_expired: token expired' }))).toBe(shown)
  })
  it('never without an error string', () => {
    expect(showLastError(connection({ authStatus: 'degraded', lastError: null }))).toBe(false)
  })
})

describe('identity line', () => {
  it('seller, then store, then what kind of nobody', () => {
    expect(identityLine(connection())).toBe('xaviaracing')
    expect(identityLine(connection({ sellerName: null, storeName: 'Moto Vento' }))).toBe('Moto Vento')
    expect(identityLine(connection({ sellerName: null, isManagedBy: 'env' }))).toBe('Set by environment')
    expect(identityLine(connection({ sellerName: null, isManagedBy: 'pending' }))).toBe('No account connected')
    expect(identityLine(connection({ sellerName: null }))).toBe('—')
  })
})

describe('holds — a refusal carries its reason (U13)', () => {
  it('Reconnect is held for every channel but eBay, with the CX.3 reason', () => {
    expect(reconnectHold('amazon', connection({ channel: 'AMAZON', isManagedBy: 'env' }))).toEqual({
      held: true,
      reason: 'Reconnect for Amazon arrives with CX.3',
    })
    expect(reconnectHold('shopify', connection({ channel: 'SHOPIFY', isManagedBy: 'pending' }))).toEqual({
      held: true,
      reason: 'Reconnect for Shopify arrives with CX.3',
    })
  })
  it('Reconnect is live for a signed-in eBay account', () => {
    expect(reconnectHold('ebay', connection())).toEqual({ held: false })
  })
  it('Reconnect is held for an eBay placeholder row', () => {
    const h = reconnectHold('ebay', connection({ isManagedBy: 'pending', id: 'pending:EBAY' }))
    expect(h.held).toBe(true)
    expect(h.held && h.reason).toMatch(/No eBay account is connected yet/)
  })
  it('Test is held only when nothing is connected — env-managed Amazon still tests', () => {
    expect(testHold('ebay', connection())).toEqual({ held: false })
    expect(testHold('amazon', connection({ channel: 'AMAZON', isManagedBy: 'env' }))).toEqual({ held: false })
    const h = testHold('etsy', connection({ channel: 'ETSY', isManagedBy: 'pending' }))
    expect(h.held && h.reason).toBe('Nothing to test — no Etsy account is connected.')
  })
  it('Disconnect is held for env-managed and placeholder rows', () => {
    expect(disconnectHold('ebay', connection())).toEqual({ held: false })
    const env = disconnectHold('amazon', connection({ channel: 'AMAZON', isManagedBy: 'env' }))
    expect(env.held && env.reason).toMatch(/set by environment/)
    const pending = disconnectHold('shopify', connection({ channel: 'SHOPIFY', isManagedBy: 'pending' }))
    expect(pending.held && pending.reason).toMatch(/Nothing to disconnect/)
  })
})

describe('runHeartbeat — Test', () => {
  it('POSTs the heartbeat URL with credentials and yields "OK · 412 ms"', async () => {
    const fetchImpl = fakeFetch({ success: true, latencyMs: 412, authStatus: 'connected' })
    expect(await runHeartbeat('conn_1', fetchImpl)).toEqual({ tone: 'success', text: 'OK · 412 ms' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/cx\/connections\/conn_1\/heartbeat$/)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
  })

  it('yields "Failed · errorClass · message" on a failed heartbeat', async () => {
    const fetchImpl = fakeFetch({ success: false, latencyMs: 90, errorClass: 'auth_expired', message: 'token expired' })
    expect(await runHeartbeat('conn_1', fetchImpl)).toEqual({
      tone: 'danger',
      text: 'Failed · auth_expired · token expired',
    })
  })

  it('names the HTTP status when the API gives no error class', async () => {
    const fetchImpl = fakeFetch({ success: false, error: 'Connection not found' }, 404)
    expect((await runHeartbeat('missing', fetchImpl)).text).toBe('Failed · HTTP 404 · Connection not found')
  })
})

describe('startReconnect — eBay consent for THIS connection', () => {
  it('POSTs intent reconnect + targetConnectionId with credentials and returns the authUrl', async () => {
    const fetchImpl = fakeFetch({ success: true, authUrl: 'https://auth.ebay.com/oauth2/authorize?x=1' })
    expect(await startReconnect('conn_1', fetchImpl)).toEqual({ authUrl: 'https://auth.ebay.com/oauth2/authorize?x=1' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/cx\/connect\/ebay\/start$/)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({ intent: 'reconnect', targetConnectionId: 'conn_1' })
  })
  it('surfaces the API error', async () => {
    const fetchImpl = fakeFetch({ success: false, error: 'eBay app credentials missing' }, 500)
    expect(await startReconnect('conn_1', fetchImpl)).toEqual({ error: 'eBay app credentials missing' })
  })
})

describe('marketplaces — options, draft, PATCH body', () => {
  it('options are the codes the API accepts, with country names', () => {
    expect(marketplaceOptions('ebay')).toEqual([
      { code: 'IT', name: 'Italy' },
      { code: 'DE', name: 'Germany' },
      { code: 'FR', name: 'France' },
      { code: 'ES', name: 'Spain' },
      { code: 'UK', name: 'United Kingdom' },
    ])
    expect(marketplaceOptions('amazon').map((o) => o.code)).toEqual(['IT', 'DE', 'FR', 'ES', 'UK'])
    expect(marketplaceOptions('shopify')).toEqual([])
    expect(marketplaceOptions('unknown-channel')).toEqual([])
  })

  it('single-store channels keep the "doesn\'t apply" copy', () => {
    expect(marketplacesDescription('shopify', [])).toBe(
      'Shopify is a single-store channel — there are no marketplaces to scope.',
    )
    expect(marketplacesDescription('ebay', [])).toMatch(/empty scope as ALL markets/)
    expect(marketplacesDescription('ebay', ['IT'])).toBe('Syncs and listings scoped to 1 market.')
    expect(marketplacesDescription('ebay', ['IT', 'DE'])).toBe('Syncs and listings scoped to 2 markets.')
  })

  it('toggling keeps the draft sorted; dirtiness compares by set', () => {
    expect(toggleMarketplace(['IT'], 'DE')).toEqual(['DE', 'IT'])
    expect(toggleMarketplace(['DE', 'IT'], 'IT')).toEqual(['DE'])
    expect(sameSet(['IT', 'DE'], ['DE', 'IT'])).toBe(true)
    expect(sameSet(['IT'], ['DE', 'IT'])).toBe(false)
  })

  it('the PATCH body is {marketplaces}, upper-cased, deduped, sorted', () => {
    expect(marketplacesPatchBody(['it', 'DE', 'IT'])).toEqual({ marketplaces: ['DE', 'IT'] })
    expect(marketplacesPatchBody([])).toEqual({ marketplaces: [] })
  })

  it('patchMarketplaces PATCHes that body to the channel endpoint', async () => {
    const fetchImpl = fakeFetch({ ok: true })
    await patchMarketplaces('ebay', ['DE', 'IT'], fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/settings\/channels\/ebay\/marketplaces$/)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ marketplaces: ['DE', 'IT'] })
  })

  it('patchMarketplaces throws the API reason on a 400', async () => {
    const fetchImpl = fakeFetch({ error: 'Unsupported marketplaces for EBAY: XX. Allowed: IT, DE, FR, ES, UK.' }, 400)
    await expect(patchMarketplaces('ebay', ['XX'], fetchImpl)).rejects.toThrow(/Unsupported marketplaces/)
  })
})

describe('inbound events — the processed pill', () => {
  const base = { id: 'e1', eventType: 'ORDER', externalId: 'x', processedAt: null, createdAt: '2026-08-29T11:00:00.000Z' }
  it('error beats processed; processed is ok; otherwise pending', () => {
    expect(eventTone({ ...base, isProcessed: true, error: 'boom' })).toEqual({ tone: 'danger', label: 'failed' })
    expect(eventTone({ ...base, isProcessed: true, error: null })).toEqual({ tone: 'success', label: 'ok' })
    expect(eventTone({ ...base, isProcessed: false, error: null })).toEqual({ tone: 'warning', label: 'pending' })
  })
})
