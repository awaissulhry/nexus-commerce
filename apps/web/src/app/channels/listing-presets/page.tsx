'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/lib/workspaces/navigation'
import { PageHeader } from '@/design-system/patterns'
import { Banner, Field, Listbox, ProgressBar } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import ListingPresetsClient from './ListingPresetsClient'

interface PlatformStatus {
  platform: string; connected: boolean
  marketplaces: { code: string; label: string }[]
}

export default function ListingPresetsPage() {
  return <Suspense fallback={<ProgressBar indeterminate ariaLabel="Loading listing presets" />}><ListingPresetsWorkspace /></Suspense>
}

function ListingPresetsWorkspace() {
  const params = useSearchParams()
  const router = useRouter()
  const channel = params.get('channel')?.toUpperCase() ?? ''
  const market = params.get('market')?.toUpperCase() ?? ''
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([])
  const [scopeError, setScopeError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`${getBackendUrl()}/api/listing-wizard/connection-status`, { credentials: 'include', signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.error ?? 'Could not load destination filters'); return data })
      .then(data => { if (!controller.signal.aborted) setPlatforms(data.platforms ?? []) })
      .catch(error => { if (!controller.signal.aborted) setScopeError(error.message) })
    return () => controller.abort()
  }, [])
  const setScope = (nextChannel: string, nextMarket: string) => {
    const next = new URLSearchParams()
    if (nextChannel) next.set('channel', nextChannel)
    if (nextMarket) next.set('market', nextMarket)
    router.replace(`/channels/listing-presets${next.size ? `?${next}` : ''}`, { scroll: false })
  }
  const markets = new Map(platforms.filter(p => !channel || p.platform === channel).flatMap(p => p.marketplaces.map(m => [m.code, m.label] as const)))
  if (market && !markets.has(market)) markets.set(market, market)
  const channelOptions = platforms.map(p => ({ value: p.platform, label: `${p.platform}${p.connected ? '' : ' · not connected'}` }))
  if (channel && !channelOptions.some(p => p.value === channel)) channelOptions.push({ value: channel, label: channel })
  return <div style={{ display: 'grid', gap: 'var(--nds-space-16)' }}>
    <PageHeader title="Listing presets" subtitle={channel ? `Presets including ${channel}${market ? ` ${market}` : ''}` : 'Shared defaults for the listing wizard'} />
    {scopeError && <Banner tone="warning">{scopeError}. Presets remain available below.</Banner>}
    <div style={{ display: 'flex', gap: 'var(--nds-space-12)', flexWrap: 'wrap' }}>
      <Field label="Destination channel"><Listbox width="auto" value={channel} options={[{ value: '', label: 'All channels' }, ...channelOptions]} onChange={value => setScope(value, '')} /></Field>
      <Field label="Market"><Listbox width="auto" value={market} options={[{ value: '', label: 'All markets' }, ...Array.from(markets, ([value, label]) => ({ value, label }))]} onChange={value => setScope(channel, value)} /></Field>
    </div>
    <ListingPresetsClient key={`${channel}:${market}`} channel={channel} market={market} />
  </div>
}
