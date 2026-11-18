'use client'

import type { ReactNode } from 'react'
import { ArrowUpToLine, Ban, CheckCircle2, ChevronDown, Download, FileArchive, Flag, FlagOff, ListChecks, MessageSquareWarning, MoreHorizontal, PauseCircle, PlayCircle, Send } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { useCardList } from '@nexus/ui/grid/card-list/index'
import { Button } from '@nexus/ui/primitives'
import { phoneBarOf, type BulkAction, type BulkActionId, type BulkBar } from '../bulk/model'
import { useProductionPageWords } from '../words'

/**
 * F-PR-23a — the bulk bar's buttons on My production, drawn by the list frame in place of the search while rows are picked (the
 * frame draws "3 selected" and Clear; on a phone the DS card list's bar under Select): Select all, the bar's own actions — Mark
 * urgent · Mark regular · Move to top · Approve · Ask ▾ (F-PR-23b) — and More ▾ (Report a problem · Download files · Export).
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
  APPROVE: <CheckCircle2 size={13} aria-hidden />,
  ASK_HOLD: <PauseCircle size={14} aria-hidden />,
  ASK_CANCEL: <Ban size={14} aria-hidden />,
  ASK_RESUME: <PlayCircle size={14} aria-hidden />,
  REPORT: <MessageSquareWarning size={14} aria-hidden />,
  FILES: <FileArchive size={14} aria-hidden />,
  EXPORT: <Download size={14} aria-hidden />,
}

export function BulkBarButtons({ bar, actions, phone }: { bar: BulkBar; actions?: BulkBarActions; phone?: boolean }) {
  const { t } = useProductionPageWords()
  const narrow = useCardList()
  const shown = (phone ?? narrow) ? phoneBarOf(bar) : bar
  const item = (action: BulkAction): MenuItemDef => ({
    id: action.id,
    label: action.label,
    icon: ICONS[action.id],
    disabled: action.held !== null,
    description: action.held ?? action.hint ?? undefined,
    onSelect: () => actions?.onAction?.(action.id),
  })
  const more = shown.more.map(item)
  // F-PR-23b: Ask ▾ (pause, cancel, resume: the kinds the customer's limits open); on a phone its items are in More ▾.
  const ask = shown.ask && shown.ask.length > 0 ? shown.ask.map(item) : null
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
      {ask ? (
        <Menu
          align="right"
          label={
            <>
              <Send size={13} aria-hidden /> <SelectionLabel>{t('bulk.ask.menu')}</SelectionLabel> <ChevronDown size={12} aria-hidden />
            </>
          }
          triggerProps={{ 'aria-label': t('bulk.ask.menuLabel', { count: bar.count }) }}
          items={ask}
        />
      ) : null}
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
