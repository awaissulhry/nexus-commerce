'use client'
import type { Dispatch, SetStateAction } from 'react'
import { transferIsStore } from '@nexus/shared/catalog-transfer'
import { Button, Checkbox, Input } from '@/design-system/primitives'
import { Banner, Disclosure, Field, Listbox } from '@/design-system/components'
import type { TransferOptions } from './sourceMapping'
import { channelName, destinationCategories, destinationCategoryLabel, destinationMarkets, languageName, workbookSelection, type WorkbookDestination } from './workbookSelection'
import styles from './transfer.module.css'
import { useWorkbookCategoryNames } from './useWorkbookCategoryNames'

export type WorkbookSetup = { destinations: WorkbookDestination[]; extras: string[]; regionalLanguages: string }
export function WorkbookTemplate({ options, market, familyId, busy, onDownload, value, onChange }: {
  options: TransferOptions; market: string; familyId: string; busy: boolean; onDownload: (payload: unknown) => void; value: WorkbookSetup; onChange: Dispatch<SetStateAction<WorkbookSetup>>
}) {
  const { destinations, extras, regionalLanguages } = value
  const categoryNames = useWorkbookCategoryNames(options, destinations)
  const setDestinations = (change: (rows: WorkbookDestination[]) => WorkbookDestination[]) => onChange(current => ({ ...current, destinations: change(current.destinations) }))
  const setExtras = (change: (languages: string[]) => string[]) => onChange(current => ({ ...current, extras: change(current.extras) }))
  const update = (i: number, patch: Partial<WorkbookDestination>) => setDestinations(rows => rows.map((r, n) => n === i ? { ...r, ...patch } : r))
  const selection = workbookSelection(options, destinations, [...extras, ...regionalLanguages.split(',')])
  const languageOptions = [...new Set(options.markets.flatMap(m => m.language ? [m.language.toLowerCase()] : []))].sort((a, b) => languageName(a).localeCompare(languageName(b)))
  const incomplete = selection.destinationErrors.some(Boolean) || !!selection.languageError
  const addDestination = () => {
    const accountId = destinations.at(-1)?.accountId || (options.accounts.length === 1 ? options.accounts[0].id : '')
    const available = destinationMarkets(options, accountId)
    setDestinations(rows => [...rows, { accountId, marketplace: available.length === 1 ? available[0].code : '', category: '' }])
  }
  return <div className={styles.stack}>
    <p>Choose where these products should be listed. Your file will contain shared product details, the right languages, and a separate sheet for each destination.</p>
    {destinations.map((d, i) => {
      const account = options.accounts.find(a => a.id === d.accountId)
      const store = transferIsStore(account?.channelType ?? '')
      const categories = destinationCategories(options, d)
      const labelFor = (id: string) => (account?.channelType === 'EBAY' ? categoryNames.labels[d.marketplace]?.[id] : undefined) || destinationCategoryLabel(options, d, id)
      return <fieldset key={i} className={styles.choices}>
        <legend>Listing destination {i + 1}</legend>
        <div className={styles.stack}>
          <div className={styles.fields}>
            <Field label={`Seller account ${i + 1}`} required><Listbox options={options.accounts.map(a => ({ value: a.id, label: `${channelName(a.channelType)} · ${a.displayName ?? a.id}` }))} value={d.accountId} onChange={accountId => { const markets = destinationMarkets(options, accountId); update(i, { accountId, marketplace: markets.length === 1 ? markets[0].code : '', category: '' }) }} disabled={busy} width="100%" placeholder="Choose an account" /></Field>
            <Field label={`Marketplace ${i + 1}`} required><Listbox options={destinationMarkets(options, d.accountId).map(m => ({ value: m.code, label: m.name }))} value={d.marketplace} onChange={marketplace => update(i, { marketplace, category: '' })} disabled={busy || !account} width="100%" placeholder="Choose a marketplace" /></Field>
            {store ? <Field label={`${account?.channelType === 'ETSY' ? 'Etsy category ID' : 'Shopify category ID'} ${i + 1}`} hint="Optional for this draft workbook. Core product fields are included; review category requirements before publishing.">
              <Input value={d.category} onChange={e => update(i, { category: e.target.value })} disabled={busy || !d.marketplace} placeholder={account?.channelType === 'ETSY' ? 'Numeric taxonomy ID' : 'gid://shopify/TaxonomyCategory/…'} />
            </Field> : <Field label={`Product category ${i + 1}`} required hint={!d.marketplace ? 'Choose a marketplace first.' : categories.length ? 'Determines the attributes and valid values included in this sheet.' : 'No category definitions are available here yet. Refresh the channel category to continue.'}>
              <Listbox options={categories.map(value => ({ value, label: labelFor(value), searchText: `${labelFor(value)} ${value}`, trailing: labelFor(value) !== value ? value : undefined }))} value={d.category} onChange={category => update(i, { category })} disabled={busy || !d.marketplace || !categories.length} width="100%" placeholder="Choose a category" searchable />
            </Field>}
          </div>
          {d.category && selection.destinationErrors[i] && <Banner tone="danger">{selection.destinationErrors[i]}</Banner>}
          <div><Button size="sm" disabled={busy} onClick={() => setDestinations(rows => rows.filter((_, n) => n !== i))} aria-label={`Remove listing destination ${i + 1}`}>Remove destination</Button></div>
        </div>
      </fieldset>
    })}
    {categoryNames.loading && <p role="status">Loading eBay category names…</p>}
    {categoryNames.failed && <Banner tone="warning" action={<Button size="sm" disabled={busy} onClick={categoryNames.retry}>Retry category names</Button>}>Some eBay category names are unavailable. Their exact IDs remain visible; retry the lookup if you need the names to choose.</Banner>}
    <div><Button disabled={busy || destinations.length >= 30 || !options.accounts.length} onClick={addDestination}>{destinations.length ? 'Add another destination' : 'Add a listing destination'}</Button></div>
    {!destinations.length && <p className={styles.secondary}>No listing destinations selected. Add one to include channel listing sheets.</p>}
    <fieldset className={styles.choices}>
      <legend>Content languages</legend>
      <div className={styles.stack}>
        <p>{selection.requiredLanguages.length ? `Included for your marketplaces: ${selection.requiredLanguages.map(languageName).join(', ')}.` : 'Marketplace languages are included automatically when you choose destinations.'} Add any other languages you need below.</p>
        <div className={styles.choiceOptions}>{languageOptions.map(code => <Checkbox key={code} label={`${languageName(code)}${selection.requiredLanguages.includes(code) ? ' · Included' : ''}`} checked={selection.languages.includes(code)} disabled={busy || selection.requiredLanguages.includes(code)} onChange={e => setExtras(current => e.target.checked ? [...current, code] : current.filter(l => l !== code))} />)}</div>
        <Disclosure summary="Additional regional languages"><Field label="Language codes" hint="Only needed for languages not listed above, for example en-gb or fr-ca. Separate codes with commas."><Input value={regionalLanguages} onChange={e => onChange(current => ({ ...current, regionalLanguages: e.target.value }))} disabled={busy} aria-invalid={!!selection.languageError} /></Field></Disclosure>
        {selection.languageError && <Banner tone="danger">{selection.languageError}</Banner>}
      </div>
    </fieldset>
    <p>One file · {destinations.length} listing {destinations.length === 1 ? 'destination' : 'destinations'} · {selection.languages.length} content {selection.languages.length === 1 ? 'language' : 'languages'}. Instructions, field guidance, valid values and formula examples are included.</p>
    {!familyId ? <p className={styles.secondary}>Choose a product family above to download your workbook.</p> : incomplete && <p className={styles.secondary}>Complete each destination and correct any language errors to continue.</p>}
    <div><Button variant="primary" disabled={busy || !familyId || incomplete} onClick={() => onDownload({ market, familyId, layout: 'wide', locales: selection.languages, channels: destinations.map(d => ({ ...d, channel: options.accounts.find(a => a.id === d.accountId)!.channelType })) })}>{busy ? 'Preparing workbook…' : 'Download one workbook'}</Button></div>
  </div>
}
