// AccountSwitcher calls Next's usePathname/useRouter/useSearchParams at render,
// so outside a Next App Router host it throws. `_PreviewRouterHost` is exported
// from the DS bundle itself so the contexts are the SAME module instance the
// component reads. Deliberately not cfg.provider — that is in the global grade
// key and would re-key all 60 components for one card. The component is
// untouched; `initialData` is its own seam for the fetch.
import type { ReactNode } from 'react'
import { AccountSwitcher, _PreviewRouterHost, type AccountsPayload } from '@nexus/design-system'



// The router host must come from the DS bundle, not be built here: a locally
// imported Next context is a second module instance and the component would
// still throw "invariant expected app router to be mounted".
const RouterHost = ({ children, account }: { children: ReactNode; account?: string }) => (
  <_PreviewRouterHost pathname="/marketing/ads/campaigns" search={account ? `account=${account}` : ''}>
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>{children}</div>
  </_PreviewRouterHost>
)

const PAYLOAD: AccountsPayload = {
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
      health: 'warn', healthReason: 'Token expires in 6 days', isPrimary: false, sortOrder: 2,
      externalAccountId: 'A1KD84PQRS', accountColor: '#c77700',
      tokenExpiresAt: '2026-08-30T09:00:00Z', lastSyncAt: '2026-08-24T07:41:00Z',
      lastSyncStatus: 'ok', lastSyncError: null,
    },
    {
      id: 'ebay-de', channel: 'EBAY', managedBy: 'nexus', label: 'Nexus Trading DE',
      labelSource: 'signInName', labelIsPlaceholder: false, markets: ['DE'],
      health: 'error', healthReason: 'Re-authorisation required', isPrimary: false, sortOrder: 3,
      externalAccountId: 'nexus_trading_de', accountColor: null,
      tokenExpiresAt: '2026-08-19T09:00:00Z', lastSyncAt: '2026-08-19T22:10:00Z',
      lastSyncStatus: 'error', lastSyncError: 'invalid_grant',
    },
  ],
}

// The collapsed chip aggregates per channel and colours a dot by the WORST
// health in that channel, so two cells only differ if their payloads differ in
// health — the `?account=` query changes only the open dropdown's checkmark.
const ALL_OK: AccountsPayload = {
  ...PAYLOAD,
  accounts: PAYLOAD.accounts.map((a) => ({
    ...a, health: 'ok' as const, healthReason: null,
    lastSyncStatus: 'ok', lastSyncError: null,
    tokenExpiresAt: '2026-11-02T09:00:00Z',
  })),
}

/** The collapsed chip — top-right account identity, every channel healthy. */
export const Chip = () => (
  <RouterHost account="amz-eu">
    <AccountSwitcher endpoint="/api/accounts" initialData={ALL_OK} manageHref="/settings/channels" />
  </RouterHost>
)

/** Degraded health surfaces on the chip itself: amazon expiring, eBay needs re-auth. */
export const MixedHealth = () => (
  <RouterHost account="amz-uk">
    <AccountSwitcher endpoint="/api/accounts" initialData={PAYLOAD} manageHref="/settings/channels" />
  </RouterHost>
)

/** A single connected account, nothing to switch between. */
export const SingleAccount = () => (
  <RouterHost account="amz-eu">
    <AccountSwitcher
      endpoint="/api/accounts"
      initialData={{ ...ALL_OK, canSwitch: false, accounts: [ALL_OK.accounts[0]] }}
      manageHref="/settings/channels"
    />
  </RouterHost>
)
