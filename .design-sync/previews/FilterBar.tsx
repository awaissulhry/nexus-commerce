import { useState } from 'react'
import { Button, FilterBar, type FilterDimension } from '@nexus/design-system'

const CHANNELS = [
  { value: 'amazon', label: 'Amazon', count: 212 },
  { value: 'ebay', label: 'eBay', count: 64 },
  { value: 'shopify', label: 'Shopify', count: 38 },
]
const STATES = [
  { value: 'live', label: 'Live', count: 248 },
  { value: 'suppressed', label: 'Suppressed', count: 41 },
  { value: 'incomplete', label: 'Incomplete', count: 25 },
]
const TYPES = [
  { value: 'helmet', label: 'Helmets' },
  { value: 'jacket', label: 'Jackets' },
  { value: 'gloves', label: 'Gloves' },
]
const MARKETPLACES = [
  { value: 'it', label: 'Amazon Italy' },
  { value: 'de', label: 'Amazon Germany' },
  { value: 'fr', label: 'Amazon France' },
]

const EMPTY = { channels: [] as string[], states: [] as string[], types: [] as string[], min: '', max: '' }

function useDims(seed: typeof EMPTY) {
  const [f, setF] = useState(seed)
  const dims: FilterDimension[] = [
    {
      key: 'channels',
      label: 'Channel',
      kind: 'multiselect',
      options: CHANNELS,
      value: f.channels,
      onChange: (v) => setF((s) => ({ ...s, channels: v })),
    },
    {
      key: 'states',
      label: 'Listing state',
      kind: 'multiselect',
      options: STATES,
      value: f.states,
      onChange: (v) => setF((s) => ({ ...s, states: v })),
    },
    {
      key: 'types',
      label: 'Product type',
      kind: 'multiselect',
      options: TYPES,
      value: f.types,
      onChange: (v) => setF((s) => ({ ...s, types: v })),
    },
    {
      key: 'price',
      label: 'Price',
      kind: 'range',
      unit: '€',
      min: f.min,
      max: f.max,
      onChange: (min, max) => setF((s) => ({ ...s, min, max })),
    },
  ]
  const active = f.channels.length + f.states.length + f.types.length + (f.min || f.max ? 1 : 0)
  return { dims, active, clear: () => setF(EMPTY) }
}

/** Config only: pass `dimensions` and the bar renders the right control per kind. Nothing filtered, so Clear is disabled. */
export const ListingsWorkspace = () => {
  const { dims, active, clear } = useDims(EMPTY)
  return <FilterBar title="Filter listings" dimensions={dims} activeCount={active} onClear={clear} />
}

/**
 * Filtered: the multiselects read "N selected", the €-range carries values and `activeCount`
 * enables Clear. `presets` adds the saved-view chips above the grid.
 */
export const ActiveFilters = () => {
  const { dims, active, clear } = useDims({
    channels: ['amazon', 'ebay'],
    states: ['live'],
    types: [],
    min: '40',
    max: '350',
  })
  return (
    <FilterBar
      title="Filter listings"
      dimensions={dims}
      activeCount={active}
      onClear={clear}
      presets={
        <>
          <Button size="sm">All listings</Button>
          <Button size="sm">Suppressed only</Button>
          <Button size="sm">No Buy Box</Button>
        </>
      }
    />
  )
}

/** A `select` dimension renders a typeahead, a `toggle` a switch; `defaultOpen={false}` starts collapsed. */
export const SelectAndToggle = () => {
  const [marketplace, setMarketplace] = useState('it')
  const [fbaOnly, setFbaOnly] = useState(true)
  const dims: FilterDimension[] = [
    {
      key: 'marketplace',
      label: 'Marketplace',
      kind: 'select',
      options: MARKETPLACES,
      value: marketplace,
      onChange: setMarketplace,
    },
    { key: 'fba', label: 'FBA only', kind: 'toggle', value: fbaOnly, onChange: setFbaOnly },
    {
      key: 'acos',
      label: 'ACOS',
      kind: 'range',
      unit: '%',
      min: '15',
      max: '40',
      onChange: () => {},
    },
  ]
  return <FilterBar title="Filter campaigns" dimensions={dims} activeCount={2} onClear={() => {}} />
}
