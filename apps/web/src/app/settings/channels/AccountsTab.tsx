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

export interface AccountsTabProps {
  catalogue: CatalogueChannel[] | null
  reloadSignal: unknown
  onStart: (channelKey: string, opts: { intent: 'connect' | 'reconnect'; targetConnectionId?: string }) => void
}

export function AccountsTab({ catalogue, reloadSignal, onStart }: AccountsTabProps) {
  const askConfirm = useConfirm()
  // Every AVAILABLE catalogue entry gets a "Connect another …" affordance in the
  // panel, keyed by channelType — the panel groups accounts by channelType.
  const onConnect: Record<string, () => void> = {}
  for (const c of catalogue ?? []) {
    if (c.available) onConnect[c.channelType] = () => onStart(c.key, { intent: 'connect' })
  }
  return (
    <AccountsPanel
      apiBase={getBackendUrl()}
      onConnect={onConnect}
      onReconnect={(a) => {
        const entry = (catalogue ?? []).find((c) => c.channelType === a.channel && c.available)
        if (entry) onStart(entry.key, { intent: 'reconnect', targetConnectionId: a.id })
      }}
      reloadSignal={reloadSignal}
      confirm={askConfirm}
    />
  )
}
