'use client'

import { connectionScopePolicy } from './presence/connection'
import { useStudioDiscovery } from './contracts'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { useMemo } from 'react'
import { Button, FilterChip } from '@/design-system/primitives'
import { Listbox } from '@/design-system/components'
import { ScopeBar, type ScopeBarItem } from '@/design-system/patterns'
import { useScopeReadiness, useStudioScope, useStudioSave } from './contracts'
import { MASTER_SCOPE } from './types'
import { languageLabel } from './scopes'
import styles from './studio.module.css'

/** Scope selects the owner; product navigation selects the work. Grid controls stay in the sheet. */
export function StudioBar() {
  const { marketplaces, listingId, destination, setListing, accountId, accounts, setAccount, scope, market, locale, locales, primaryLanguage, options, setScope, setMarket, setLocale } = useStudioScope()
  const readiness = useScopeReadiness()
  const discovery = useStudioDiscovery()
  const save = useStudioSave()
  const items = useMemo<ScopeBarItem[]>(() => {
    const scored = (id: string): ScopeBarItem['readiness'] => {
      const participation = marketplaces.find(m => m.channel === id && m.code === market)
      if (participation?.isParticipating === false) return { pct: null, state: 'absent', note: `${id} · ${market} is not participating.` }
      if (id === scope && save.kind === 'error') return { pct: null, state: 'blocked', note: save.message }
      if (id === scope && save.kind === 'saving') return 'loading'
      if (readiness.status === 'loading') return 'loading'
      if (readiness.status === 'ready') {
        const value = readiness.byScope[id]
        if (!value) return { pct: null, state: 'absent', note: 'Choose this channel and account to check requirements.' }
        const others = value.languages?.filter(entry => entry.language !== locale).map(entry => `${entry.language.toUpperCase()}: ${readinessMeta(entry.state, 'scope').label} ${entry.pct === null ? '—' : `${entry.pct}%`}`)
        return { ...value, note: [`${locale?.toUpperCase() ?? 'Selected language'}: ${value.note ?? ''}`, ...(others ?? [])].join(' · ') }
      }
      return { pct: null, state: 'absent', note: readiness.status === 'unavailable' ? readiness.reason : readiness.message }
    }
    return [
      { id: MASTER_SCOPE, label: 'Shared product', readiness: scored(MASTER_SCOPE) },
      ...options.channels.map(c => {
        const policy = connectionScopePolicy(c.health, c.label, discovery?.failed === true)
        return { id: c.id, label: c.label, disabled: policy.disabled, disabledReason: policy.disabledReason ?? undefined,
          readiness: policy.disabled ? undefined : market && c.markets.includes(market) ? scored(c.id) : undefined }
      }),
    ]
  }, [options.channels, market, marketplaces, readiness, scope, save, locale, discovery?.failed])
  return <ScopeBar className="nds-workspace-scope" label="Editing" items={items} active={scope} onChange={setScope} right={
    <>
      {scope !== MASTER_SCOPE && <>
      {accounts.length > 1 && <Listbox size="sm" width="auto" value={accountId} options={accounts.map(a => ({ value: a.id, label: a.label + (a.primary ? ' · primary' : '') + (connectionScopePolicy(a.health, scope, false).needsReconnect ? ' · needs reconnecting' : '') }))} onChange={setAccount} ariaLabel="Account" placeholder="Choose account" />}
      <Listbox size="sm" width="auto" options={options.markets.filter(m => m.channels.includes(scope)).map(m => ({ value: m.code, label: m.label + (marketplaces.find(p => p.channel === scope && p.code === m.code)?.isParticipating === false ? ' (not participating)' : '') }))}
        value={market ?? undefined} onChange={setMarket} ariaLabel="Market" placeholder="Market" />

      {listingId && <Button size="sm" variant="ghost" onClick={() => setListing()} title="Clear this listing selection and show all listings in the selected account and market">{destination.status === 'ready' && destination.data.aliasKey ? 'Listing customization' : 'Selected listing'} · Clear</Button>}
      </>}
      <div role="group" aria-label="Content language" className={styles.languageChips}>
        {options.locales.map(language => <FilterChip key={language.code} size="md" pressed={locales ? locales.includes(language.code) : locale === language.code} onClick={() => setLocale(language.code)}>
          {languageLabel(language.code)}{scope === MASTER_SCOPE && language.code === primaryLanguage ? ' · source' : ''}
        </FilterChip>)}
      </div>
    </>
  } />
}
