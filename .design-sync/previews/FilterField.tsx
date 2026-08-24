import { useState } from 'react'
import { Combobox, FilterField, FilterPanel, Input, MultiSelect, Select, Toggle } from '@nexus/design-system'

/**
 * `FilterField` is a label + control cell of the panel's field grid — it only renders
 * truthfully inside `FilterPanel`, so that is the composition shown. One field per control type.
 */
export const ControlTypes = () => {
  const [types, setTypes] = useState<string[]>(['helmet'])
  const [brand, setBrand] = useState('agv')
  return (
    <FilterPanel title="Filter products" onReset={() => {}} onApply={() => {}}>
      <FilterField label="Product type">
        <MultiSelect
          options={[
            { value: 'helmet', label: 'Helmets' },
            { value: 'jacket', label: 'Jackets' },
            { value: 'gloves', label: 'Gloves' },
          ]}
          value={types}
          onChange={setTypes}
        />
      </FilterField>
      <FilterField label="Brand">
        <Combobox
          options={[
            { value: 'agv', label: 'AGV' },
            { value: 'dainese', label: 'Dainese' },
            { value: 'alpinestars', label: 'Alpinestars' },
          ]}
          value={brand}
          onChange={setBrand}
          placeholder="Search brands…"
        />
      </FilterField>
      <FilterField label="Fulfilment">
        <Select defaultValue="fba">
          <option value="all">All</option>
          <option value="fba">FBA</option>
          <option value="fbm">Merchant</option>
        </Select>
      </FilterField>
      <FilterField label="Min price">
        <Input prefix="€" placeholder="0" />
      </FilterField>
      <FilterField label="Max margin">
        <Input suffix="%" placeholder="45" />
      </FilterField>
      <FilterField label="Archived">
        <Toggle checked={false} onChange={() => {}} aria-label="Include archived" />
      </FilterField>
    </FilterPanel>
  )
}

/**
 * `wide` asks for two of the six desktop columns — below 1320px, as here, the grid drops to
 * three columns and a wide field takes one, so the search field simply leads the row.
 */
export const WideField = () => {
  const [states, setStates] = useState<string[]>(['live'])
  return (
    <FilterPanel title="Filter listings" onReset={() => {}} onApply={() => {}} resetLabel="Clear">
      <FilterField label="Search title or ASIN" wide>
        <Input placeholder="e.g. Casco Integrale, B0CJ4M2XQ1" />
      </FilterField>
      <FilterField label="Listing state">
        <MultiSelect
          options={[
            { value: 'live', label: 'Live' },
            { value: 'suppressed', label: 'Suppressed' },
            { value: 'incomplete', label: 'Incomplete' },
          ]}
          value={states}
          onChange={setStates}
        />
      </FilterField>
      <FilterField label="Marketplace">
        <Select defaultValue="it">
          <option value="it">Amazon Italy</option>
          <option value="de">Amazon Germany</option>
          <option value="fr">Amazon France</option>
        </Select>
      </FilterField>
    </FilterPanel>
  )
}
