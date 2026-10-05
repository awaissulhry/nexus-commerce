'use client'

import { connectionScopePolicy } from './presence/connection'
import { useStudioDiscovery, useStudioProduct } from './contracts'
import { useMemo } from 'react'
import { AliasMark, Button } from '@/design-system/primitives'
import { Listbox, MultiSelect } from '@/design-system/components'
import { aliasMarkSpoken, listingParamOf, listingPickerOptions, listingPickerValue, showListingPicker } from './listingScope'
import { useListingChoices } from './useListingChoices'
import { ScopeBar } from '@/design-system/patterns'
import { languageSummary, orderedLocales } from './languageControl'
import { participationSuffix, scopeItems } from './scopeItems'
import { useScopeReadiness, useStudioScope, useStudioSave } from './contracts'
import { MASTER_SCOPE } from './types'
import { languageLabel, scopeLanguages } from './scopes'
import styles from './studio.module.css'

/** Scope selects the owner; product navigation selects the work. Grid controls stay in the sheet. */
export function StudioBar() {
  const { marketplaces, listingId, destination, setListing, accountId, accounts, setAccount, scope, market, locale, locales, setLocales, setLanguages, primaryLanguage, options, setScope, setMarket, setLocale } = useStudioScope()
  const readiness = useScopeReadiness()
  const discovery = useStudioDiscovery()
  const save = useStudioSave()
  const product = useStudioProduct()
  /* Aliases (Owner 2026-10-05: "I do not want to do anything in the address bar") — the listings of this channel ·
     market · account, from one read; the picker below chooses one of them, or all. */
  const listingChoices = useListingChoices(product.id, product.parentId ?? product.id,
    { channel: scope === MASTER_SCOPE ? null : scope, marketplace: market, accountId }).choices
  // A-55 — the items and their readiness words live in `scopeItems.ts` (pure, tested); "Not set up" only when proven.
  // The open channel's primary destination has no listing on this market (an alias destination is a choice, not a fact).
  const unlisted = destination.status === 'ready' && !destination.data.listing && !destination.data.aliasKey
  const items = useMemo(() => scopeItems({ channels: options.channels, market, marketplaces, readiness, scope, save, locale,
    discoveryFailed: discovery?.failed === true, destination: destination.status, unlisted }),
  [options.channels, market, marketplaces, readiness, scope, save, locale, discovery?.failed, destination.status, unlisted])
  const available = options.locales.map(language => language.code)
  /* SHEET-VIEWS (Owner, 2026-09-26: "why do we have two different dropdowns for the country and then the
     language?"). On a channel scope the language list is the MARKET's languages, and every market but
     Amazon BE (nl, fr) has exactly one — so a second dropdown offered a choice that was not one. A
     one-language market names its language in the market dropdown ("IT · Italy · Italian") and the
     language control is not drawn; a market with two or more keeps it, and so does Shared (every
     market's languages, a real choice). A market with NO declared language keeps the control too, so
     its empty state stays visible rather than silently absent. */
  const languagesOf = (code: string) => scopeLanguages(scope, code, marketplaces, null)
  const languageChoice = scope === MASTER_SCOPE || available.length !== 1
  const languageOptions = options.locales.map(language => ({ value: language.code,
    label: `${languageLabel(language.code)}${scope === MASTER_SCOPE && language.code === primaryLanguage ? ' · source' : ''}` }))
  /* P2 (I4-4) — the account, market and language controls do not depend on the save state: kept as one element so a
     save (pending, saved) redraws the scope menu's items and not every control beside it. */
  const right = useMemo(() => (
    <>
      {scope !== MASTER_SCOPE && <>
      {accounts.length > 1 && <Listbox size="sm" width="auto" value={accountId} options={accounts.map(a => ({ value: a.id, label: a.label + (a.primary ? ' · primary' : '') + (connectionScopePolicy(a.health, scope, false).needsReconnect ? ' · needs reconnecting' : '') }))} onChange={setAccount} ariaLabel="Account" placeholder="Choose account" />}
      <Listbox size="sm" width="auto" options={options.markets.filter(m => m.channels.includes(scope)).map(m => { const only = languagesOf(m.code); return { value: m.code, label: m.label + (only.length === 1 ? ` · ${languageLabel(only[0])}` : '') + participationSuffix(marketplaces.find(p => p.channel === scope && p.code === m.code)) } })}
        value={market ?? undefined} onChange={setMarket} ariaLabel="Market" placeholder="Market" />

      {/* The listing picker: All listings · ★ Main listing · ① <alias> · ② <alias>… — the sheet's own marks and names.
          "All listings" is the way back (it clears the choice). Without a read of the listings, a chosen listing keeps
          its Clear button. The page stays on its product (review 2026-10-05): "Main listing" writes THIS product's own
          main record. A long alias name truncates instead of widening the bar (`.listingPicker`); a mark that only
          repeats the name ("Main listing") is hidden from screen readers, so the listing is read once. */}
      {listingChoices && showListingPicker(listingChoices, listingId)
        ? <Listbox size="sm" width="auto" className={styles.listingPicker} ariaLabel="Listing" placeholder="Listing"
            value={listingPickerValue(listingId, destination.status === 'ready' && listingId ? destination.data.aliasKey : undefined, listingChoices)}
            options={listingPickerOptions(listingChoices, product.id).map(option => ({ value: option.value, label: option.label, disabled: option.disabled, title: option.title,
              leading: option.position === null ? undefined : aliasMarkSpoken(option.position, option.label)
                ? <AliasMark position={option.position} /> : <span aria-hidden="true"><AliasMark position={option.position} /></span> }))}
            onChange={value => setListing(listingParamOf(value, listingChoices, product.id))} />
        : listingId && <Button size="sm" variant="ghost" onClick={() => setListing()} title="Clear this listing selection and show all listings in the selected account and market">{destination.status === 'ready' && destination.data.aliasKey ? 'Listing customization' : 'Selected listing'} · Clear</Button>}
      </>}
      {/* TOOLBAR REBUILD (Owner, 2026-09-27) — THE language control, and the only one: the sheet's "Languages" chip
          is gone. Always a multi-choice that never drops below one language. One ticked is the ordinary sheet; two or
          more show every text field once per language, whatever view is on. Remembered per scope. */}
      {languageChoice && <MultiSelect size="sm" width="auto" ariaLabel="Content languages" options={languageOptions}
        value={locales ?? (locale ? [locale] : [])} minSelected={1}
        formatLabel={value => `Languages: ${languageSummary(value, available, languageLabel)}`}
        onChange={next => {
          const ordered = orderedLocales(next, available)
          if (!ordered) return
          if (setLanguages) setLanguages(ordered)
          else if (ordered.length === 1) { setLocales(null); setLocale(ordered[0]) }
          else setLocales(ordered)
        }} />}
    </>
  ), [scope, accounts, accountId, setAccount, options, marketplaces, market, setMarket, listingId, destination, setListing, listingChoices, product.id, primaryLanguage, locales, locale, setLanguages, setLocales, setLocale]) // everything the controls (and `languagesOf`, `available`, `languageOptions`) read
  return <ScopeBar variant="menu" className="nds-workspace-scope" label="Editing" items={items} active={scope} onChange={setScope} right={right} />
}

