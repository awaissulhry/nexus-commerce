'use client'

import { type ReactNode } from 'react'
import { FilterPanel, FilterField } from './FilterPanel'
import { MultiSelect, Combobox } from '../components'
import { Toggle } from '../primitives'

/**
 * FilterBar — the ONE declarative, config-driven filter bar for every grid
 * workspace (products, listings, fulfillment, pricing…). Pass a `dimensions`
 * array; the bar renders the collapsible Ad-Manager panel (built on
 * `FilterPanel`) with the right control per dimension — so feature pages own
 * *configuration*, never the bar's UI. Reproduces the campaigns-page filter bar
 * (`.h10-am-fpanel`) through DS tokens; change it here and every consumer
 * updates.
 */

export interface FilterBarOption {
  value: string
  label: string
  /** Optional facet count — rendered muted after the label. */
  count?: number
}

export type FilterDimension =
  | {
      key: string
      label: string
      kind: 'multiselect'
      options: FilterBarOption[]
      value: string[]
      onChange: (next: string[]) => void
      placeholder?: string
      /** Span two columns of the 6-col grid. */
      wide?: boolean
    }
  | {
      key: string
      label: string
      kind: 'select'
      options: FilterBarOption[]
      value: string
      onChange: (next: string) => void
      placeholder?: string
      wide?: boolean
    }
  | {
      key: string
      label: string
      kind: 'range'
      min: string
      max: string
      onChange: (min: string, max: string) => void
      unit?: '€' | '%' | ''
      wide?: boolean
    }
  | {
      key: string
      label: string
      kind: 'toggle'
      value: boolean
      onChange: (next: boolean) => void
      wide?: boolean
    }

export interface FilterBarProps {
  /** Panel title (default "Filters"). */
  title?: ReactNode
  /** Declarative filter dimensions, rendered in order across the 6-col grid. */
  dimensions: FilterDimension[]
  /** Optional preset chips row above the field grid. */
  presets?: ReactNode
  /** Clear-all handler; renders the footer "Clear" button (disabled when inactive). */
  onClear?: () => void
  /** Count of active filters; disables Clear at 0. */
  activeCount?: number
  /** Initial open state (default true — matches the campaigns grid). */
  defaultOpen?: boolean
}

function optionLabel(o: FilterBarOption): ReactNode {
  if (o.count == null) return o.label
  return (
    <>
      {o.label} <span className="h10-ds-ms-count">{o.count}</span>
    </>
  )
}

function RangeField({
  min,
  max,
  onChange,
  unit = '',
}: {
  min: string
  max: string
  onChange: (min: string, max: string) => void
  unit?: '€' | '%' | ''
}) {
  const cls = unit === '€' ? ' cur' : unit === '%' ? ' pct' : ''
  return (
    <div className="h10-ds-field h10-ds-range">
      <div className={`h10-ds-range-in${cls}`}>
        {unit === '€' && <span className="ad">€</span>}
        <input
          inputMode="decimal"
          placeholder="Min"
          value={min}
          onChange={(e) => onChange(e.target.value, max)}
          aria-label="Minimum"
        />
        {unit === '%' && <span className="ad">%</span>}
      </div>
      <div className={`h10-ds-range-in${cls}`}>
        {unit === '€' && <span className="ad">€</span>}
        <input
          inputMode="decimal"
          placeholder="Max"
          value={max}
          onChange={(e) => onChange(min, e.target.value)}
          aria-label="Maximum"
        />
        {unit === '%' && <span className="ad">%</span>}
      </div>
    </div>
  )
}

function DimensionControl<T extends FilterDimension>({ d }: { d: T }) {
  switch (d.kind) {
    case 'multiselect':
      return (
        <MultiSelect
          options={d.options.map((o) => ({ value: o.value, label: optionLabel(o) }))}
          value={d.value}
          onChange={d.onChange}
          placeholder={d.placeholder ?? 'All'}
        />
      )
    case 'select':
      return (
        <Combobox
          options={d.options.map((o) => ({ value: o.value, label: o.label }))}
          value={d.value}
          onChange={d.onChange}
          placeholder={d.placeholder ?? 'All'}
        />
      )
    case 'range':
      return <RangeField min={d.min} max={d.max} onChange={d.onChange} unit={d.unit} />
    case 'toggle':
      return (
        <div className="h10-ds-field h10-ds-toggle-field">
          <Toggle checked={d.value} onChange={d.onChange} />
        </div>
      )
  }
}

export function FilterBar({ title, dimensions, presets, onClear, activeCount, defaultOpen = true }: FilterBarProps) {
  return (
    <FilterPanel
      title={title}
      presets={presets}
      defaultOpen={defaultOpen}
      onReset={onClear}
      resetLabel="Clear"
      resetDisabled={activeCount === 0}
    >
      {dimensions.map((d) => (
        <FilterField key={d.key} label={d.label} wide={d.wide}>
          <DimensionControl d={d} />
        </FilterField>
      ))}
    </FilterPanel>
  )
}
