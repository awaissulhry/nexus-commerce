'use client'

/**
 * MX.P — the Matrix verbs for the selected rows (design §3.8), from ONE declaration (the engine's `matrixActions`).
 *
 * Since 2026-09-26 they live in the TOOLBAR while rows are selected, as on the sheet and the Variants tab (Owner: "go
 * with your recommendation" — the bottom `BulkActionBar` is gone). Eleven verbs do not fit one toolbar line, and the
 * selection cluster never wraps (`GridSelectionActions`), so they are grouped into three DS menus by what they change —
 * **Prices**, **Stock**, **Sync** — plus **More** for a verb declared later that no group names (it appears without
 * touching this file). The reach of the selection ("on Amazon · IT", "on all 8 coordinates") is the muted
 * `SelectionNote` beside them.
 *
 * A `hidden` verb (a parent-only selection) is not offered at all; a group with nothing to offer is not drawn.
 *
 * 🔴 A verb this selection cannot run is KEPT, with its reason as the menu item's second line (`MenuItemDef.description`):
 * the item stays keyboard reachable and cannot activate, so hover, focus and a press all explain themselves. "Nothing in
 * this selection carries inventory" is something the operator can fix by ticking different rows — a menu that hid the
 * verb would leave them no idea which selection would fill it.
 */
import { memo } from 'react'
import { ChevronDown } from 'lucide-react'

import { Menu, type MenuItemDef } from '@/design-system/components'
import { SelectionNote, type MatrixVerbSpec } from '@/design-system/grid'

export interface MatrixSelectionVerbsProps {
  verbs: readonly MatrixVerbSpec[]
  /** `on Amazon · IT` · `on all 8 coordinates` — what the selection's cells span. */
  scopeLabel: string
  busy: boolean
  onVerb: (verb: MatrixVerbSpec) => void
}

/** The toolbar's three menus, by what a verb changes. Order inside a group is the declaration's. */
export const MATRIX_VERB_GROUPS: ReadonlyArray<{ id: string; label: string; verbs: readonly string[] }> = [
  { id: 'prices', label: 'Prices', verbs: ['set-price', 'adjust-prices', 'copy-prices'] },
  { id: 'stock', label: 'Stock', verbs: ['pin-quantity', 'set-follow', 'set-buffer', 'set-fulfilment'] },
  { id: 'sync', label: 'Sync', verbs: ['pause-sync', 'resume-sync', 'push-now', 'retry-sync'] },
]

/** Pure: the menus to draw — offered verbs only, each in its group, anything ungrouped under "More". */
export function matrixVerbMenus(verbs: readonly MatrixVerbSpec[]): Array<{ id: string; label: string; verbs: MatrixVerbSpec[] }> {
  const offered = verbs.filter(verb => !verb.hidden)
  const grouped = new Set(MATRIX_VERB_GROUPS.flatMap(g => g.verbs))
  const menus = MATRIX_VERB_GROUPS.map(g => ({ id: g.id, label: g.label, verbs: offered.filter(v => g.verbs.includes(v.id)) }))
  menus.push({ id: 'more', label: 'More', verbs: offered.filter(v => !grouped.has(v.id)) })
  return menus.filter(m => m.verbs.length > 0)
}

export const MatrixSelectionVerbs = memo(function MatrixSelectionVerbs({ verbs, scopeLabel, busy, onVerb }: MatrixSelectionVerbsProps) {
  const menus = matrixVerbMenus(verbs)
  return (
    <>
      <SelectionNote>{scopeLabel}</SelectionNote>
      {menus.map(menu => {
        const items: MenuItemDef[] = menu.verbs.map(verb => {
          const held = verb.unavailable ?? null
          return {
            id: verb.id,
            label: verb.label,
            ...(verb.danger ? { tone: 'danger' as const } : {}),
            disabled: !!held || busy,
            ...(held ? { description: held } : {}),
            onSelect: () => { if (!held && !busy) onVerb(verb) },
          }
        })
        const runnable = menu.verbs.filter(v => !v.unavailable).length
        return (
          <Menu
            key={menu.id}
            label={<>{menu.label}<ChevronDown size={11} aria-hidden /></>}
            items={items}
            triggerProps={{
              className: 'nds-btn sm',
              disabled: busy,
              'aria-label': `${menu.label}: ${runnable} of ${menu.verbs.length} ${menu.verbs.length === 1 ? 'action' : 'actions'} available for this selection`,
            }}
          />
        )
      })}
    </>
  )
})
