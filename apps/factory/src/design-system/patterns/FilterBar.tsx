'use client'

import { useId, type ReactNode } from 'react'
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
 *
 * 2026-10-12 (the ads pages' filter bar): every control is named by its field's label and its value ("Campaign 2
 * selected"); a multiselect may be HELD with its reason (`heldReason`: focusable, says why, does not open); an option
 * drawn with a count still searches by its words (`searchText`, default its label); while collapsed the header says what
 * is filtered (`filterSummary`) and offers Clear; `open` / `onOpenChange` let a page remember the panel for the person.
 */

export interface FilterBarOption {
  value: string
  label: string
  /** Optional facet count — rendered muted after the label. */
  count?: number
  /** The words the in-popover search matches. Default: `label`. */
  searchText?: string
}

export type FilterDimension =
  | {
      key: string
      label: ReactNode
      kind: 'multiselect'
      options: FilterBarOption[]
      value: string[]
      onChange: (next: string[]) => void
      placeholder?: string
      /**
       * Always offer the in-popover search, whatever the option count. The picker adds one on
       * its own past seven options; a DATA-DRIVEN list (product types, brands, tags) is worth
       * searching at any size, because the operator is looking for a name, not scanning a menu.
       */
      searchable?: boolean
      /** Span two columns of the 6-col grid. */
      wide?: boolean
      /** HELD: why nothing can be picked now (the list is read, or has nothing). Null / undefined = it opens. */
      heldReason?: string | null
    }
  | {
      key: string
      label: ReactNode
      kind: 'select'
      options: FilterBarOption[]
      value: string
      onChange: (next: string) => void
      placeholder?: string
      wide?: boolean
    }
  | {
      key: string
      label: ReactNode
      kind: 'range'
      min: string
      max: string
      onChange: (min: string, max: string) => void
      unit?: '€' | '%' | ''
      wide?: boolean
    }
  | {
      key: string
      label: ReactNode
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
  /** Controlled open state, for a page that remembers it per person (with `onOpenChange`). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** A field's label as words, when it is plain text. */
const labelWords = (label: ReactNode): string | null => (typeof label === 'string' || typeof label === 'number' ? String(label) : null)

/**
 * What the dimensions filter now, in one line for the collapsed header: "Portfolio: Boots IT +1 · Price: 10–50". A pick
 * whose option is not listed shows by count ("2 selected"). Empty when nothing filters. PURE.
 */
export function filterSummary(dimensions: readonly FilterDimension[]): string {
  const parts: string[] = []
  for (const d of dimensions) {
    const name = labelWords(d.label)
    const say = (what: string) => parts.push(name ? `${name}: ${what}` : what)
    if (d.kind === 'multiselect' && d.value.length) {
      const first = d.options.find((o) => o.value === d.value[0])
      say(first ? `${first.label}${d.value.length > 1 ? ` +${d.value.length - 1}` : ''}` : `${d.value.length} selected`)
    } else if (d.kind === 'select' && d.value) {
      say(d.options.find((o) => o.value === d.value)?.label ?? d.value)
    } else if (d.kind === 'range' && (d.min || d.max)) {
      say(d.min && d.max ? `${d.min}–${d.max}` : d.min ? `≥ ${d.min}` : `≤ ${d.max}`)
    } else if (d.kind === 'toggle' && d.value && name) {
      parts.push(name)
    }
  }
  return parts.join(' · ')
}

function optionLabel(o: FilterBarOption): ReactNode {
  if (o.count == null) return o.label
  return (
    <>
      {o.label} <span className="nds-ms-count">{o.count}</span>
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
    <div className="nds-range">
      <div className={`nds-range-in${cls}`}>
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
      <div className={`nds-range-in${cls}`}>
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

function DimensionControl<T extends FilterDimension>({ d, labelId }: { d: T; labelId: string }) {
  switch (d.kind) {
    case 'multiselect':
      return (
        <MultiSelect
          options={d.options.map((o) => ({ value: o.value, label: optionLabel(o), searchText: o.searchText ?? o.label }))}
          value={d.value}
          onChange={d.onChange}
          placeholder={d.placeholder ?? 'All'}
          searchable={d.searchable}
          labelledBy={labelId}
          heldReason={d.heldReason}
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
        <div className="nds-field nds-toggle-field">
          <Toggle checked={d.value} onChange={d.onChange} />
        </div>
      )
  }
}

/** One field: its label carries an id the control is named by. */
function DimensionField({ d }: { d: FilterDimension }) {
  const labelId = useId()
  return (
    <FilterField label={d.label} wide={d.wide} labelId={labelId}>
      <DimensionControl d={d} labelId={labelId} />
    </FilterField>
  )
}

export function FilterBar({ title, dimensions, presets, onClear, activeCount, defaultOpen = true, open, onOpenChange }: FilterBarProps) {
  return (
    <FilterPanel
      title={title}
      presets={presets}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      summary={filterSummary(dimensions)}
      onReset={onClear}
      resetLabel="Clear"
      resetDisabled={activeCount === 0}
    >
      {dimensions.map((d) => <DimensionField key={d.key} d={d} />)}
    </FilterPanel>
  )
}
