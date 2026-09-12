'use client'

/**
 * CX.2 — Accounts tab. The DS `AccountsPanel` renders the honest rows
 * (status pill from authStatus, scope chips, permissions + drift, the four
 * timestamps, Test/Reconnect/Disconnect); this tab only wires the popup.
 */

import { useState } from 'react'
import { AccountsPanel } from '@/design-system/components'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { AssignAccountProfileDialog } from './AssignAccountProfileDialog'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import type { CatalogueChannel } from './channels-data'

export interface AccountsTabProps {
  catalogue: CatalogueChannel[] | null
  reloadSignal: unknown
  onChanged: () => void
  onStart: (channelKey: string, opts: { intent: 'connect' | 'reconnect'; targetConnectionId?: string; region?: string | null }) => void
}

export function AccountsTab({ catalogue, reloadSignal, onStart, onChanged }: AccountsTabProps) {
  const askConfirm = useConfirm()
  const { activeProfile } = useProfileScope()
  const [assigning, setAssigning] = useState<AccountRow | null>(null)
  // Every AVAILABLE catalogue entry gets a "Connect another …" affordance in the
  // panel, keyed by channelType — the panel groups accounts by channelType.
  const onConnect: Record<string, () => void> = {}
  for (const c of catalogue ?? []) {
    if (c.available) onConnect[c.channelType] = () => onStart(c.key, { intent: 'connect' })
  }
  return (
    <><AccountsPanel
      apiBase={getBackendUrl()}
      onConnect={onConnect}
      includeDisconnected={WORKSPACES_ENABLED}
      onAssignProfile={WORKSPACES_ENABLED && activeProfile?.isOwner ? setAssigning : undefined}
      onChanged={onChanged}
      onReconnect={(a) => {
        const entry = (catalogue ?? []).find((c) => c.channelType === a.channel && c.available)
        if (entry) onStart(entry.key, { intent: 'reconnect', targetConnectionId: a.id, region: a.region })
      }}
      reloadSignal={reloadSignal}
      confirm={askConfirm}
    />{assigning && activeProfile?.isOwner && <AssignAccountProfileDialog account={assigning} source={activeProfile} onClose={() => setAssigning(null)} onSaved={onChanged} />}</>
  )
}
