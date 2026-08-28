'use client'

/**
 * Saved views. Apply one from the list; save the current arrangement under a name; make one the
 * default (it becomes the grid's `initialState` on the next load); delete. A DS Menu, because a
 * view is a choice among a few named things, and an inline Input for the one moment a name is
 * needed — no browser prompt.
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Button, Input } from '@/design-system/primitives'
import { Menu, useToast, type MenuItemDef } from '@/design-system/components'
import type { useGridViews } from '@/design-system/patterns/workspace-grid/engine/useGridViews'

export function GridViewsMenu<TPage>({ views }: { views: ReturnType<typeof useGridViews<TPage>> }) {
  const { toast } = useToast()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const active = views.views.find((v) => v.id === views.activeId) ?? null

  const run = (label: string, fn: () => Promise<unknown>) =>
    fn().then(() => toast(label, 'success')).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))

  const items: MenuItemDef[] = [
    ...views.views.map((v) => ({
      id: v.id,
      label: (
        <>
          {v.name}
          {v.isDefault ? ' · default' : ''}
          {v.id === views.activeId ? ' ✓' : ''}
        </>
      ),
      onSelect: () => views.apply(v),
    })),
    { id: 'sep-1', separator: true },
    { id: 'save-new', label: 'Save current as new view…', onSelect: () => { setName(''); setNaming(true) } },
    ...(active
      ? [
          { id: 'update', label: `Update “${active.name}”`, onSelect: () => void run('View updated', () => views.save(active.name, { id: active.id, isDefault: active.isDefault })) },
          { id: 'default', label: 'Make default', disabled: active.isDefault, onSelect: () => void run('Default view set', () => views.setDefault(active.id)) },
          { id: 'delete', label: 'Delete view', onSelect: () => void run('View deleted', () => views.remove(active.id)) },
        ]
      : []),
  ]

  if (naming) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <Input
          autoFocus
          placeholder="View name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setNaming(false) }}
          style={{ width: 180 }}
          aria-label="View name"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!name.trim()}
          onClick={() => void run('View saved', () => views.save(name.trim())).then(() => setNaming(false))}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
      </span>
    )
  }
  return (
    <Menu
      label={<>{active ? active.name : 'Views'} <ChevronDown size={11} /></>}
      items={items}
      triggerProps={{ className: 'nds-btn sm' }}
    />
  )
}
