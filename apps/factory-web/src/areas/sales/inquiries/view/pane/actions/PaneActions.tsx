'use client'

import { FilePlus2, MessageCircleQuestion, MoreHorizontal, PackagePlus, Shirt, XCircle } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { InquiryView } from '../../../api'
import { useWords } from '../../../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../../../record-model'
import { paneActions, type PaneAction } from './model'

const ICON = { quote: FilePlus2, askInfo: MessageCircleQuestion, decline: XCircle, order: PackagePlus, styleDraft: Shirt } as const
const KEY = { quote: 'q', askInfo: undefined, decline: 'd', order: undefined, styleDraft: undefined } as const

/**
 * Row 2 of the reading pane and the full page's side (B-TH-218): ONE main button that follows the request, the other actions
 * the API allows now (each held with its reason: never hidden, never a dead button), ⋯ Assign / Take off, Match to a customer,
 * Mark lost; a closed request says what it became instead.
 */
export function PaneActions({ model, view, actions, onEdit }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions; onEdit?: () => void }) {
  const { t, say } = useWords()
  const offline = model.live === 'offline'
  const row = paneActions(view, model.can, offline)
  const working = model.busy || model.saving ? t('common.working') : null
  if (row.outcome) return <p className="fw-rp-outcome">{say(row.outcome)}</p>
  const button = (action: PaneAction, primary: boolean) => {
    const Icon = ICON[action]
    return (
      <Button
        key={action}
        size="sm"
        variant={primary ? 'primary' : action === 'decline' ? 'danger-outline' : 'secondary'}
        heldReason={working ?? say(row.held[action])}
        onClick={() => actions?.onVerb?.(action)}
        aria-keyshortcuts={KEY[action]}
      >
        <Icon size={14} aria-hidden /> {t(`pane.action.${action}`)}
      </Button>
    )
  }
  const items: MenuItemDef[] = row.menu.map(({ id, held }) => {
    const words = say(held) ?? undefined
    if (id === 'match') return { id, label: t('pane.action.match'), disabled: !!held, description: words ?? t('pane.action.matchHint'), onSelect: () => onEdit?.() }
    const verb = id === 'lost' ? 'lost' : id
    return { id, label: t(id === 'assign' ? 'verb.assignKey' : id === 'unassign' ? 'verb.unassign' : 'verb.lost'), disabled: !!held, description: words, tone: id === 'lost' ? ('danger' as const) : undefined, onSelect: () => actions?.onVerb?.(verb) }
  })
  return (
    <span className="fw-inq-actions">
      {row.main && button(row.main, true)}
      {row.others.map((action) => button(action, false))}
      <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={[...items, { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() }]} />
    </span>
  )
}
