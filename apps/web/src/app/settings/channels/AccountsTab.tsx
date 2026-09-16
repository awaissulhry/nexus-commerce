'use client'

/**
 * CX.2 — Accounts tab. The DS `AccountsPanel` renders the honest rows
 * (status pill from authStatus, scope chips, permissions + drift, the four
 * timestamps, Test/Reconnect/Disconnect); this tab only wires the popup.
 */

import { useCallback, useEffect, useState } from 'react'
import { AccountsPanel } from '@/design-system/components'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { AssignAccountProfileDialog } from './AssignAccountProfileDialog'
import { ShareAccountDialog } from './ShareAccountDialog'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import type { CatalogueChannel } from './channels-data'
import { reconnectLabel } from '@/design-system/lib/accounts-panel'

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
  const [sharing, setSharing] = useState<AccountRow | null>(null)
  // BP.S1d — which rows on this page are BORROWED. Without it a shared account
  // renders with the owner's Rename/Reconnect/Disconnect buttons, every one of
  // which the server refuses: safe, but a lie on the screen.
  const [shared, setShared] = useState<Record<string, { ownerWorkspaceName: string; mode?: string }>>({})
  const loadShared = useCallback(async () => {
    if (!WORKSPACES_ENABLED) return
    try {
      const response = await fetch(`${getBackendUrl()}/api/accounts/shared-with-me`, { cache: 'no-store', credentials: 'include' })
      const result = await response.json()
      // A failure here leaves the map EMPTY, so rows render as owned. That is the
      // wrong way round for honesty, but the server refuses every one of those
      // actions anyway; inventing a "shared" state we could not read would be worse.
      setShared(!response.ok ? {} : Object.fromEntries(
        (result.shared ?? []).map((row: { connectionId: string; ownerWorkspaceName: string; mode: string }) => [row.connectionId, { ownerWorkspaceName: row.ownerWorkspaceName, mode: row.mode }]),
      ))
    } catch { setShared({}) }
  }, [])
  useEffect(() => { void loadShared() }, [loadShared, reloadSignal])
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
    <><AccountsPanel
      apiBase={getBackendUrl()}
      onConnect={onConnect}
      includeDisconnected={WORKSPACES_ENABLED}
      onAssignProfile={WORKSPACES_ENABLED && activeProfile?.isOwner ? setAssigning : undefined}
      onShareProfile={WORKSPACES_ENABLED && activeProfile?.isOwner ? setSharing : undefined}
      sharedAccounts={shared}
      onChanged={onChanged}
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
    />{assigning && activeProfile?.isOwner && <AssignAccountProfileDialog account={assigning} source={activeProfile} onClose={() => setAssigning(null)} onSaved={onChanged} />}
    {sharing && activeProfile?.isOwner && <ShareAccountDialog account={sharing} source={activeProfile} onClose={() => setSharing(null)} onSaved={() => { void loadShared(); onChanged() }} />}</>
  )
}
