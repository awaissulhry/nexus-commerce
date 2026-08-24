// AccountsPanel — the accounts each channel holds, and what you can do to them.
// Composition ported from the channels settings page
// (apps/web/src/app/settings/channels/ChannelsClient.tsx).
//
// ── Why there is a fetch stub here ────────────────────────────────────────────
// The panel reads `GET {apiBase}/api/accounts` itself and, unlike its sibling
// AccountSwitcher, exposes no `initialData` test seam — with a real apiBase it
// renders "Accounts unavailable — HTTP 404" and nothing else. So the DATA SOURCE
// is stubbed at module scope, exactly the way `initialData` stubs it for
// AccountSwitcher; the component itself is the real one, untouched, and every
// pixel below is its own markup. Each card is its own page, so the override
// cannot leak to another component's preview.
//
// The apiBase decides which response the story gets, which is what lets one file
// show the loaded, degraded, loading and failed states side by side.
import { AccountsPanel, type AccountsPayload } from '@nexus/design-system'

const LIVE = 'https://accounts.preview.nexus/live'
const ATTENTION = 'https://accounts.preview.nexus/attention'
const PENDING = 'https://accounts.preview.nexus/pending'
const DOWN = 'https://accounts.preview.nexus/down'

const HEALTHY: AccountsPayload = {
  success: true,
  canSwitch: true,
  notConnected: ['SHOPIFY'],
  accounts: [
    {
      id: 'amz-eu', channel: 'AMAZON', managedBy: 'nexus', label: 'Nexus EU Retail',
      labelSource: 'accountLabel', labelIsPlaceholder: false, markets: ['DE', 'FR', 'IT', 'ES'],
      health: 'ok', healthReason: null, isPrimary: true, sortOrder: 1,
      externalAccountId: 'A2X9QK1LMN', accountColor: '#1f6fde',
      tokenExpiresAt: '2026-11-02T09:00:00Z', lastSyncAt: '2026-08-24T07:41:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
    {
      id: 'amz-uk', channel: 'AMAZON', managedBy: 'nexus', label: 'Nexus UK',
      labelSource: 'storeName', labelIsPlaceholder: false, markets: ['UK'],
      health: 'ok', healthReason: null, isPrimary: false, sortOrder: 2,
      externalAccountId: 'A1KD84PQRS', accountColor: '#b87503',
      tokenExpiresAt: '2026-11-02T09:00:00Z', lastSyncAt: '2026-08-24T07:41:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
    {
      id: 'ebay-de', channel: 'EBAY', managedBy: 'nexus', label: 'Nexus Trading DE',
      labelSource: 'signInName', labelIsPlaceholder: false, markets: ['DE'],
      health: 'ok', healthReason: null, isPrimary: true, sortOrder: 3,
      externalAccountId: 'nexus_trading_de', accountColor: '#0f8b8d',
      tokenExpiresAt: '2026-10-14T09:00:00Z', lastSyncAt: '2026-08-24T07:38:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
  ],
}

const DEGRADED: AccountsPayload = {
  success: true,
  canSwitch: true,
  notConnected: ['SHOPIFY'],
  accounts: [
    {
      // env-managed: there is no OAuth grant to revoke, so the panel prints the
      // reason instead of a disabled Disconnect button.
      id: 'amz-env', channel: 'AMAZON', managedBy: 'env', label: 'Nexus EU Retail',
      labelSource: 'accountLabel', labelIsPlaceholder: false, markets: ['DE', 'FR', 'IT', 'ES'],
      health: 'ok', healthReason: null, isPrimary: true, sortOrder: 1,
      externalAccountId: 'A2X9QK1LMN', accountColor: '#1f6fde',
      tokenExpiresAt: null, lastSyncAt: '2026-08-24T07:41:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
    {
      id: 'amz-uk', channel: 'AMAZON', managedBy: 'nexus', label: 'Nexus UK',
      labelSource: 'storeName', labelIsPlaceholder: false, markets: ['UK'],
      health: 'warn', healthReason: 'Token expires in 6 days', isPrimary: false, sortOrder: 2,
      externalAccountId: 'A1KD84PQRS', accountColor: '#b87503',
      tokenExpiresAt: '2026-08-30T09:00:00Z', lastSyncAt: '2026-08-24T07:41:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
    {
      // No identity from the channel: no name to show, and multi-account stays
      // unavailable until it is reconnected. Both facts are said in the row.
      id: 'ebay-legacy', channel: 'EBAY', managedBy: 'nexus', label: 'EBAY',
      labelSource: 'channel', labelIsPlaceholder: true, markets: ['DE', 'IT'],
      health: 'error', healthReason: 'invalid_grant — re-authorisation required', isPrimary: true, sortOrder: 3,
      externalAccountId: null, accountColor: null,
      tokenExpiresAt: '2026-08-19T09:00:00Z', lastSyncAt: '2026-08-19T22:10:00Z',
      lastSyncStatus: 'error', lastSyncError: 'invalid_grant',
    },
  ],
}

const BY_BASE: Record<string, AccountsPayload> = { [LIVE]: HEALTHY, [ATTENTION]: DEGRADED }

// The panel touches `res.ok`, `res.status` and `res.json()` and nothing else.
const reply = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as unknown as Response)

if (typeof window !== 'undefined') {
  const passthrough = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    for (const base of Object.keys(BY_BASE)) {
      if (url === `${base}/api/accounts`) return reply(BY_BASE[base])
    }
    // Never settles — the skeleton the panel shows while the first read is in flight.
    if (url === `${PENDING}/api/accounts`) return new Promise<Response>(() => {})
    if (url === `${DOWN}/api/accounts`) return reply({ error: 'Accounts service unavailable' }, false, 503)
    return passthrough(input, init)
  }) as typeof fetch
}

const connect = { EBAY: () => {}, SHOPIFY: () => {} }

/** Two Amazon accounts and one eBay account, each with a primary, an identity colour and the full action row. */
export const ChannelAccounts = () => (
  <AccountsPanel apiBase={LIVE} onConnect={connect} onReconnect={() => {}} />
)

/** Everything that can be wrong at once: an env-managed account with no grant to revoke, a token six days from expiry, and an eBay connection that predates the identity permission. Shopify has a connect handler but no account, so it still gets a section. */
export const NeedsAttention = () => (
  <AccountsPanel apiBase={ATTENTION} onConnect={connect} onReconnect={() => {}} />
)

/** No `onConnect`: the panel drops every "+ Connect" affordance and lists only what exists. */
export const ReadOnly = () => <AccountsPanel apiBase={LIVE} />

/** The first read is still in flight — one pill-shaped skeleton, no phantom rows. */
export const Loading = () => <AccountsPanel apiBase={PENDING} />

/** The read failed. The server's own status is printed rather than reworded, because a refusal an operator cannot name is one they cannot act on. */
export const Unavailable = () => <AccountsPanel apiBase={DOWN} onConnect={connect} />
