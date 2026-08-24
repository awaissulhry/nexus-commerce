import { useState } from 'react'
import { CalendarDays, LayoutGrid, LayoutList } from 'lucide-react'
import { SegmentedControl } from '@nexus/design-system'

/** `md` (default) and `sm` — the compact single-select for 2–4 mutually-exclusive view modes. */
export const Sizes = () => {
  const [source, setSource] = useState('live')
  const [view, setView] = useState('list')
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      <SegmentedControl
        options={[
          { value: 'live', label: 'Live' },
          { value: 'official', label: 'Official' },
        ]}
        value={source}
        onChange={setSource}
      />
      <SegmentedControl
        size="sm"
        options={[
          { value: 'list', label: 'List' },
          { value: 'board', label: 'Board' },
          { value: 'calendar', label: 'Calendar' },
        ]}
        value={view}
        onChange={setView}
      />
    </div>
  )
}

/** Each option takes an optional `icon`, rendered ahead of the label. */
export const WithIcons = () => {
  const [view, setView] = useState('grid')
  return (
    <SegmentedControl
      options={[
        { value: 'list', label: 'List', icon: <LayoutList size={14} aria-hidden /> },
        { value: 'grid', label: 'Grid', icon: <LayoutGrid size={14} aria-hidden /> },
        { value: 'calendar', label: 'Schedule', icon: <CalendarDays size={14} aria-hidden /> },
      ]}
      value={view}
      onChange={setView}
    />
  )
}

/** In its real home — a labelled grain switch above a grid, next to a `disabled` control. */
export const InContext = () => {
  const [grain, setGrain] = useState('day')
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Grain</span>
        <SegmentedControl
          size="sm"
          options={[
            { value: 'hour', label: 'Hour' },
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
          ]}
          value={grain}
          onChange={setGrain}
        />
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Placement</span>
        <SegmentedControl
          size="sm"
          disabled
          options={[
            { value: 'all', label: 'All' },
            { value: 'top', label: 'Top of search' },
          ]}
          value="all"
          onChange={() => {}}
        />
      </span>
    </div>
  )
}
