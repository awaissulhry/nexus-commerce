'use client'

import { useMemo } from 'react'
import { Button } from '@/design-system/primitives'
import { Listbox } from '@/design-system/components'
import { ScopeBar, type ScopeBarItem } from '@/design-system/patterns'
import { useScopeReadiness, useStudioScope, useStudioSave } from './contracts'
import { MASTER_SCOPE } from './types'

/** Scope selects the owner; product navigation selects the work. Grid controls stay in the sheet. */
export function StudioBar() {
  const { listingId, destination, setListing, accountId, accounts, setAccount, scope, market, locale, options, setScope, setMarket, setLocale } = useStudioScope()
  const readiness = useScopeReadiness()
  const save = useStudioSave()
  const items = useMemo<ScopeBarItem[]>(() => {
    const scored = (id: string): ScopeBarItem['readiness'] => {
      if (id === scope && save.kind === 'error') return { pct: null, state: 'blocked', note: save.message }
      if (id === scope && save.kind === 'saving') return 'loading'
      if (readiness.status === 'loading') return 'loading'
      if (readiness.status === 'ready') return readiness.byScope[id] ?? { pct: null, state: 'absent', note: 'Choose this channel and account to check requirements.' }
      return { pct: null, state: 'absent', note: readiness.status === 'unavailable' ? readiness.reason : readiness.message }
    }
    return [
      { id: MASTER_SCOPE, label: 'Shared product', readiness: scored(MASTER_SCOPE) },
      ...options.channels.map(c => ({ id: c.id, label: c.label, readiness: market && c.markets.includes(market) ? scored(c.id) : undefined })),
    ]
  }, [options.channels, market, readiness, scope, save])
  return <ScopeBar className="nds-workspace-scope" label="Editing" items={items} active={scope} onChange={setScope} right={
    scope === MASTER_SCOPE ? <Listbox
      size="sm" width="auto" options={options.locales.map(l => ({ value: l.code, label: l.label }))}
      value={locale ?? undefined} onChange={setLocale} ariaLabel="Content language" placeholder="Language"
    /> : <>
      {accounts.length > 1 && <Listbox size="sm" width="auto" value={accountId} options={accounts.map(a => ({ value: a.id, label: a.label + (a.primary ? ' · primary' : '') }))} onChange={setAccount} ariaLabel="Account" placeholder="Choose account" />}
      <Listbox size="sm" width="auto" options={options.markets.filter(m => m.channels.includes(scope)).map(m => ({ value: m.code, label: m.label }))}
        value={market ?? undefined} onChange={setMarket} ariaLabel="Market" placeholder="Market" />
      {['SHOPIFY', 'ETSY'].includes(scope) && <Listbox size="sm" width="auto" options={options.locales.map(l => ({ value: l.code, label: l.label }))} value={locale ?? undefined} onChange={setLocale} ariaLabel="Content language" placeholder="Language" />}
      {listingId && <Button size="sm" variant="ghost" onClick={() => setListing()} title="Clear this listing selection and show all listings in the selected account and market">{destination.status === 'ready' && destination.data.aliasKey ? 'Listing customization' : 'Selected listing'} · Clear</Button>}
    </>
  } />
}
