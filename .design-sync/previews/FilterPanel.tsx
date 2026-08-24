import { useState } from 'react'
import { Button, Combobox, FilterField, FilterPanel, Input, MultiSelect, Select } from '@nexus/design-system'

const PROGRAMS = [
  { value: 'sp', label: 'Sponsored Products' },
  { value: 'sb', label: 'Sponsored Brands' },
  { value: 'sd', label: 'Sponsored Display' },
]
const MARKETPLACES = [
  { value: 'it', label: 'Amazon Italy' },
  { value: 'de', label: 'Amazon Germany' },
  { value: 'fr', label: 'Amazon France' },
  { value: 'es', label: 'Amazon Spain' },
]

/** The full panel: preset row, the 6-column field grid, and a footer with an extra left slot. */
export const AdsFilters = () => {
  const [programs, setPrograms] = useState<string[]>(['sp', 'sd'])
  const [marketplace, setMarketplace] = useState('it')
  return (
    <FilterPanel
      presets={
        <>
          <Button size="sm">All</Button>
          <Button size="sm">Active</Button>
          <Button size="sm">Paused</Button>
          <Button size="sm">Over budget</Button>
        </>
      }
      onReset={() => {}}
      onApply={() => {}}
      footerExtra={<Button>Save to library</Button>}
    >
      <FilterField label="Campaign type">
        <MultiSelect options={PROGRAMS} value={programs} onChange={setPrograms} />
      </FilterField>
      <FilterField label="Marketplace">
        <Combobox options={MARKETPLACES} value={marketplace} onChange={setMarketplace} placeholder="Search…" />
      </FilterField>
      <FilterField label="Status">
        <Select defaultValue="active">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </Select>
      </FilterField>
      <FilterField label="Min spend">
        <Input prefix="€" placeholder="0" />
      </FilterField>
      <FilterField label="Max ACOS">
        <Input suffix="%" placeholder="100" />
      </FilterField>
    </FilterPanel>
  )
}

/** `resetLabel="Clear"` + `resetDisabled` is the Ad-Manager footer with nothing filtered yet. */
export const NothingFiltered = () => {
  const [channels, setChannels] = useState<string[]>([])
  return (
    <FilterPanel
      title="Filter listings"
      onReset={() => {}}
      onApply={() => {}}
      resetLabel="Clear"
      resetDisabled
    >
      <FilterField label="Channel">
        <MultiSelect
          options={[
            { value: 'amazon', label: 'Amazon' },
            { value: 'ebay', label: 'eBay' },
            { value: 'shopify', label: 'Shopify' },
          ]}
          value={channels}
          onChange={setChannels}
        />
      </FilterField>
      <FilterField label="Listing state">
        <Select defaultValue="all">
          <option value="all">All</option>
          <option value="live">Live</option>
          <option value="suppressed">Suppressed</option>
        </Select>
      </FilterField>
      <FilterField label="Buy Box %">
        <Input suffix="%" placeholder="80" />
      </FilterField>
    </FilterPanel>
  )
}

/** `defaultOpen={false}` — collapsed to its header, the state a workspace opens in when no filter is set. */
export const Collapsed = () => (
  <FilterPanel defaultOpen={false} onReset={() => {}} onApply={() => {}}>
    <FilterField label="Marketplace">
      <Select defaultValue="it">
        <option value="it">Amazon Italy</option>
      </Select>
    </FilterField>
  </FilterPanel>
)
