'use client'

import type { ReactNode } from 'react'
import { ArrowUpToLine, Download, FileArchive, Flag, FlagOff, ListChecks, MessageSquareWarning, MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { useCardList } from '@nexus/ui/grid/card-list/index'
import { Button } from '@nexus/ui/primitives'
import { phoneBarOf, type BulkActionId, type BulkBar } from '../bulk/model'
import { useProductionPageWords } from '../words'

/**
 * F-PR-23a — the bulk bar's buttons on My production, drawn by the list frame in place of the search while rows are picked (the
 * frame draws "3 selected" and Clear; on a phone the DS card list's bar under Select): Select all, the bar's own actions — Mark
 * urgent · Mark regular · Move to top (F-PR-23b adds Approve and Ask ▾) — and More ▾ (Report a problem · Download files · Export).
 * On a phone only the first two stay on the bar; the rest join More ▾. A held action keeps its focus and says why.
 */

export interface BulkBarActions {
  onSelectAll?: () => void
  onAction?: (id: BulkActionId) => void
}

const ICONS: Readonly<Record<BulkActionId, ReactNode>> = {
  URGENT: <Flag size={13} aria-hidden />,
  REGULAR: <FlagOff size={13} aria-hidden />,
  TOP: <ArrowUpToLine size={13} aria-hidden />,
  APPROVE: <ListChecks size={13} aria-hidden />,
  REPORT: <MessageSquareWarning size={14} aria-hidden />,
  FILES: <FileArchive size={14} aria-hidden />,
  EXPORT: <Download size={14} aria-hidden />,
}

export function BulkBarButtons({ bar, actions, phone }: { bar: BulkBar; actions?: BulkBarActions; phone?: boolean }) {
  const { t } = useProductionPageWords()
  const narrow = useCardList()
  const shown = (phone ?? narrow) ? phoneBarOf(bar) : bar
  const more: MenuItemDef[] = shown.more.map((action) => ({
    id: action.id,
    label: action.label,
    icon: ICONS[action.id],
    disabled: action.held !== null,
    description: action.held ?? action.hint ?? undefined,
    onSelect: () => actions?.onAction?.(action.id),
  }))
  return (
    <>
      {shown.selectAll ? (
        <Button size="sm" variant="quiet" aria-label={shown.selectAll} onClick={() => actions?.onSelectAll?.()}>
          <ListChecks size={13} aria-hidden /> <SelectionLabel>{shown.selectAll}</SelectionLabel>
        </Button>
      ) : null}
      {shown.actions.map((action) => (
        <Button key={action.id} size="sm" aria-label={action.label} heldReason={action.held} onClick={() => actions?.onAction?.(action.id)}>
          {ICONS[action.id]} <SelectionLabel>{action.label}</SelectionLabel>
        </Button>
      ))}
      {more.length > 0 ? (
        <Menu
          align="right"
          label={
            <>
              <MoreHorizontal size={14} aria-hidden /> <SelectionLabel>{t('bulk.more')}</SelectionLabel>
            </>
          }
          triggerProps={{ 'aria-label': t('bulk.moreLabel', { count: bar.count }) }}
          items={more}
        />
      ) : null}
    </>
  )
}
