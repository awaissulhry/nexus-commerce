'use client'

/**
 * CX.2 — Accounts tab. The DS `AccountsPanel` renders the honest rows
 * (status pill from authStatus, scope chips, permissions + drift, the four
 * timestamps, Test/Reconnect/Disconnect); this tab only wires the popup.
 */

import { AccountsPanel } from '@/design-system/components'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import type { CatalogueChannel } from './channels-data'
import { reconnectLabel } from '@/design-system/lib/accounts-panel'

export interface AccountsTabProps {
  catalogue: CatalogueChannel[] | null
  reloadSignal: unknown
  onStart: (channelKey: string, opts: { intent: 'connect' | 'reconnect'; targetConnectionId?: string; region?: string | null }) => void
}

export function AccountsTab({ catalogue, reloadSignal, onStart }: AccountsTabProps) {
  const askConfirm = useConfirm()
  // Every website-authorized catalogue entry gets a "Connect another …"
  // affordance. A private Amazon app can only re-import its one company
  // authorization, so presenting an add-account action would lead to a flow
  // Amazon does not support.
  const onConnect: Record<string, () => void> = {}
  for (const c of catalogue ?? []) {
    if (c.available && c.connectMode === 'website_oauth') {
      onConnect[c.channelType] = () => onStart(c.key, { intent: 'connect' })
    }
  }
  return (
    <AccountsPanel
      apiBase={getBackendUrl()}
      onConnect={onConnect}
      reconnectLabelForAccount={(a) => {
        const entry = catalogue?.find((c) => c.channelType === a.channel && c.available)
        if (!entry) return null
        if (entry.connectMode === 'self_authorization') return a.managedBy === 'env' ? 'Import authorization' : 'Verify access'
        return a.managedBy === 'env' ? 'Replace environment credentials' : reconnectLabel(a.scopeDrift, a.grantedScopes)
      }}
      onReconnect={(a) => {
        const entry = (catalogue ?? []).find((c) => c.channelType === a.channel && c.available)
        if (entry) onStart(entry.key, { intent: 'reconnect', targetConnectionId: a.id, region: a.region })
      }}
      reloadSignal={reloadSignal}
      confirm={askConfirm}
    />
  )
}
