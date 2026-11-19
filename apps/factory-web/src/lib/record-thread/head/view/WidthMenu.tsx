'use client'

import { Columns2 } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DOCK_WIDTHS, type DockWidth } from '../model'

/** The Head's catalogue (RecordThreadHead's HEAD_NS; named here too: the Head imports this part). */
export const WIDTH_NS = 'record-thread-head'

/**
 * F-OP-204 (order page plan N4; 11-dock §1, §3.1; D6) — THE dock's width menu, lifted out of the thread's Head so the Head of a thread
 * and the Head of All of <Customer> (FeedHead) draw the SAME part: one third / 40 % / half / full, then Hide the thread (⌘J) and
 * Default width. Drawn only where the thread is docked (`width` null: no menu). Draws its words and the frame's choice only.
 */
export function WidthMenu({ width, onWidth }: { width: DockWidth | null; onWidth?: ((choice: DockWidth | 'hide' | 'reset') => void) | undefined }) {
  if (width === null) return null
  return (
    <WithMessages namespaces={[WIDTH_NS]}>
      <Widths width={width} onWidth={onWidth} />
    </WithMessages>
  )
}

function Widths({ width, onWidth }: { width: DockWidth; onWidth: ((choice: DockWidth | 'hide' | 'reset') => void) | undefined }) {
  const t = useT(WIDTH_NS)
  const items: MenuItemDef[] = [
    ...DOCK_WIDTHS.map((choice) => ({ id: choice, label: t(`width.${choice}`), checked: choice === width, onSelect: () => onWidth?.(choice) })),
    { id: 'sep', separator: true },
    { id: 'hide', label: t('width.hide'), onSelect: () => onWidth?.('hide') },
    { id: 'reset', label: t('width.reset'), onSelect: () => onWidth?.('reset') },
  ]
  return <Menu align="right" className="fw-rth-menu" label={<Columns2 size={16} aria-hidden />} items={items} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('width.label') }} />
}
