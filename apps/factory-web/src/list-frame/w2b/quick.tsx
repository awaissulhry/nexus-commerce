'use client'

import { Filter, X } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { FilterChip } from '@nexus/ui/primitives'
import { activeQuick, quickValueOf, toggledQuick, type ListQuick } from './model'

/**
 * Quick filters (B-W2b-13; PLT-167; design shell.lists sec:toolbar "quick filters 'Assigned to me', 'Due this week'",
 * sec:filter-row "Every active filter visible as a chip; nothing filters the list that is not a chip"): a "Quick
 * filters ▾" menu beside the list's own Rows ▾ (each filter a ticked item; a date filter its relative days), and every
 * quick filter that is on as a pressed chip with ✕ above the rows. The values are words ("me", "this-week") kept in the
 * list's address, so a saved view keeps them meaning the same.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

export function quickMenuItems(quick: ListQuick, t: Translate): MenuItemDef[] {
  const items: MenuItemDef[] = []
  quick.filters.forEach((filter, index) => {
    if (index > 0) items.push({ id: `s-${filter.id}`, separator: true })
    const value = quickValueOf(filter, quick.values[filter.id])
    if (filter.kind === 'date') {
      items.push({ id: `h-${filter.id}`, heading: true, label: filter.label })
      for (const choice of filter.choices) items.push({ id: `${filter.id}:${choice}`, label: t(`quick.day.${choice}`), checked: value === choice, onSelect: () => quick.onChange(filter.id, toggledQuick(filter, value, choice)) })
    } else {
      items.push({ id: filter.id, label: filter.label, checked: value !== null, onSelect: () => quick.onChange(filter.id, toggledQuick(filter, value)) })
    }
  })
  if (activeQuick(quick).length > 0) {
    items.push({ id: 's-clear', separator: true }, { id: 'clear', label: t('quick.clear'), onSelect: () => quick.filters.forEach((filter) => quick.onChange(filter.id, null)) })
  }
  return items
}

export function QuickMenu({ quick, t }: { quick: ListQuick; t: Translate }) {
  const on = activeQuick(quick).length
  return (
    <Menu
      label={
        <>
          <Filter size={13} aria-hidden /> {on > 0 ? t('quick.triggerOn', { count: on }) : t('quick.trigger')}
        </>
      }
      items={quickMenuItems(quick, t)}
      triggerProps={{ className: 'nds-btn sm', 'aria-label': t('quick.label') }}
    />
  )
}

/** The quick filters that are on, as chips (each with ✕); nothing when none is. */
export function QuickChips({ quick, t }: { quick: ListQuick; t: Translate }) {
  const on = activeQuick(quick)
  if (on.length === 0) return null
  return (
    <div className="fw-list-chips" role="group" aria-label={t('quick.chips')}>
      {on.map(({ filter, value }) => {
        const words = filter.kind === 'date' ? t('quick.chipDate', { filter: filter.label, day: t(`quick.day.${value}`) }) : filter.label
        return (
          <FilterChip key={filter.id} pressed onClick={() => quick.onChange(filter.id, null)} aria-label={t('quick.remove', { filter: words })}>
            {words} <X size={11} aria-hidden />
          </FilterChip>
        )
      })}
    </div>
  )
}
