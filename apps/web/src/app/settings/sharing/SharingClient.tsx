'use client'

/**
 * Settings › Shared products — assortments this business shares, shares it offered, and shares offered
 * to it, with the first copy. Plan: docs/2026-09-16-assortment-engine-plan.md §19.
 *
 * Only an owner of the business acts. Everyone else sees the same lists and one sentence saying why
 * there are no actions (plan §7.1 rule 9: a reason, never a disabled button). The API checks the same
 * thing again; this page never decides what is allowed on its own.
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, Tabs, tabPanelProps } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { AssortmentsPanel } from './AssortmentsPanel'
import { IncomingPanel, OutgoingPanel } from './SharesPanels'
import { sharingApi, SharingError, type Assortment, type Share } from './sharingApi'
import '../../profiles/profiles.css'
import './sharing.css'

type TabId = 'assortments' | 'outgoing' | 'incoming'
export type Access = { state: 'checking' } | { state: 'owner'; business: string } | { state: 'member'; business: string }

export default function SharingClient() {
  const { activeProfile } = useProfileScope()
  const [tab, setTab] = useState<TabId>('assortments')
  const [assortments, setAssortments] = useState<Assortment[] | null>(null)
  const [shares, setShares] = useState<{ outgoing: Share[]; incoming: Share[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)

  const access: Access = !activeProfile ? { state: 'checking' }
    : activeProfile.isOwner ? { state: 'owner', business: activeProfile.name } : { state: 'member', business: activeProfile.name }

  const load = useCallback(async () => {
    setError(null)
    try {
      const [a, s] = await Promise.all([
        sharingApi<{ assortments: Assortment[] }>('assortments'),
        sharingApi<{ outgoing: Share[]; incoming: Share[] }>('assortment-shares'),
      ])
      setAssortments(a.assortments)
      setShares({ outgoing: s.outgoing, incoming: s.incoming })
    } catch (err) {
      // A permission refusal is not a failure to load: say who can open this page instead.
      if (err instanceof SharingError && err.status === 403) setDenied(true)
      else setError(err instanceof Error ? err.message : 'Shared products could not be loaded.')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (!WORKSPACES_ENABLED) {
    return <div className="business-profiles"><Banner title="Business profiles are not turned on">Shared products work between business profiles.</Banner></div>
  }

  if (denied) {
    return <div className="business-profiles shared-products">
      <Banner tone="info" title="Shared products are not available to you here">Ask an owner of {activeProfile?.name ?? 'this business'} for access to business settings.</Banner>
    </div>
  }

  const tabs = [
    { id: 'assortments', label: 'Assortments', count: assortments?.length ?? null },
    { id: 'outgoing', label: 'Shared by this business', count: shares?.outgoing.length ?? null },
    { id: 'incoming', label: 'Shared with this business', count: shares?.incoming.length ?? null },
  ]

  return <div className="business-profiles shared-products">
    <header className="business-profiles-heading">
      <div>
        <h2>{activeProfile?.name ?? 'Shared products'}</h2>
        <p>Share products with your other business profiles, and copy products they share with you.</p>
      </div>
    </header>
    {access.state === 'member' && <Banner tone="info" title="You can view shared products here">Only an owner of {access.business} can create assortments, share them, answer offers or copy products.</Banner>}
    {error && <Banner tone="danger" title="Shared products could not be loaded" action={<Button onClick={() => { void load() }}>Retry</Button>}>{error}</Banner>}
    <Tabs ariaLabel="Shared products" idBase="shared-products" overflow="scroll" tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
    {/* After a failed load the banner says what happened; a panel saying "Loading…" beside it would not be true. */}
    {!(error && (!assortments || !shares)) && <div {...tabPanelProps('shared-products', tab)} className="shared-products-panel">
      {tab === 'assortments' && <AssortmentsPanel access={access} assortments={assortments} shares={shares} onChanged={load} onShared={async () => { await load(); setTab('outgoing') }} />}
      {tab === 'outgoing' && <OutgoingPanel access={access} assortments={assortments} shares={shares?.outgoing ?? null} onChanged={load} onCreateAssortment={() => setTab('assortments')} />}
      {tab === 'incoming' && <IncomingPanel access={access} shares={shares?.incoming ?? null} onChanged={load} />}
    </div>}
  </div>
}
