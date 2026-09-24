'use client'

import { connectionScopePolicy } from './presence/connection'
import { useStudioDiscovery } from './contracts'
import { useMemo } from 'react'
import { Button } from '@/design-system/primitives'
import { Listbox, MultiSelect } from '@/design-system/components'
import { ScopeBar } from '@/design-system/patterns'
import { languageSummary, orderedLocales } from './languageControl'
import { participationSuffix, scopeItems } from './scopeItems'
import { useScopeReadiness, useStudioScope, useStudioSave } from './contracts'
import { MASTER_SCOPE } from './types'
import { languageLabel } from './scopes'

/** Scope selects the owner; product navigation selects the work. Grid controls stay in the sheet. */
export function StudioBar() {
  const { marketplaces, listingId, destination, setListing, accountId, accounts, setAccount, scope, market, locale, locales, setLocales, primaryLanguage, options, setScope, setMarket, setLocale } = useStudioScope()
  const readiness = useScopeReadiness()
  const discovery = useStudioDiscovery()
  const save = useStudioSave()
  // A-55 — the items and their readiness words live in `scopeItems.ts` (pure, tested); "Not set up" only when proven.
  const items = useMemo(() => scopeItems({ channels: options.channels, market, marketplaces, readiness, scope, save, locale,
    discoveryFailed: discovery?.failed === true, destination: destination.status }),
  [options.channels, market, marketplaces, readiness, scope, save, locale, discovery?.failed, destination.status])
  const available = options.locales.map(language => language.code)
  const languageOptions = options.locales.map(language => ({ value: language.code,
    label: `${languageLabel(language.code)}${scope === MASTER_SCOPE && language.code === primaryLanguage ? ' · source' : ''}` }))
  return <ScopeBar variant="menu" className="nds-workspace-scope" label="Editing" items={items} active={scope} onChange={setScope} right={
    <>
      {scope !== MASTER_SCOPE && <>
      {accounts.length > 1 && <Listbox size="sm" width="auto" value={accountId} options={accounts.map(a => ({ value: a.id, label: a.label + (a.primary ? ' · primary' : '') + (connectionScopePolicy(a.health, scope, false).needsReconnect ? ' · needs reconnecting' : '') }))} onChange={setAccount} ariaLabel="Account" placeholder="Choose account" />}
      <Listbox size="sm" width="auto" options={options.markets.filter(m => m.channels.includes(scope)).map(m => ({ value: m.code, label: m.label + participationSuffix(marketplaces.find(p => p.channel === scope && p.code === m.code)) }))}
        value={market ?? undefined} onChange={setMarket} ariaLabel="Market" placeholder="Market" />

      {listingId && <Button size="sm" variant="ghost" onClick={() => setListing()} title="Clear this listing selection and show all listings in the selected account and market">{destination.status === 'ready' && destination.data.aliasKey ? 'Listing customization' : 'Selected listing'} · Clear</Button>}
      </>}
      {/* Step 4.3 #2 (A-44) — ONE language control in the slot the nine chips took. The Languages view
          makes it a multi-select that can never drop below one language; `locales` keeps its URL. */}
      {locales
        ? <MultiSelect size="sm" width="auto" ariaLabel="Content languages" options={languageOptions} value={locales} minSelected={1}
            formatLabel={value => languageSummary(value, available, languageLabel)}
            onChange={next => { const ordered = orderedLocales(next, available); if (ordered) setLocales(ordered) }} />
        : <Listbox size="sm" width="auto" ariaLabel="Content language" options={languageOptions} value={locale ?? undefined} onChange={setLocale} placeholder="Language" />}
    </>
  } />
}

