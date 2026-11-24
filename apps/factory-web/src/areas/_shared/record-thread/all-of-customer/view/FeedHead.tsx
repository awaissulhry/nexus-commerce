'use client'

import { ChevronDown, Eye, Filter, Layers, MoreVertical } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { HEAD_NS } from '../../../../../lib/record-thread/head/view/RecordThreadHead' // the head's words: width, ⋮, allOf.line
import { DOCK_WIDTHS } from '../../../../../lib/record-thread/head/model' // tw- T.0: ⋮ › Width, as the record thread's head
import { useHeadPick } from '../../../../../lib/record-thread/head/view/HeadPick' // tw- W2.1: the dock's pick is this head's title
import { useRecordFrame } from '../../../record-frame/RecordFrame'
import { FEED_KIND_CHOICES, FEED_VIEWS, type AllOfCustomerModel } from '../model'
import type { AllOfCustomerFeedActions } from './AllOfCustomerFeed'
import '../../../../../lib/record-thread/head/head.css'
import '../all-of-customer.css'

export interface FeedHeadProps {
  /** The card's name, its title in the row ("All of Brand Alpha · Read only"). */
  readonly title: string
  readonly model: AllOfCustomerModel
  readonly actions?: AllOfCustomerFeedActions | undefined
  /** The customer's own page (the ⋯'s "Open <customer>"); absent: the page IS the customer's. */
  readonly customerHref?: string | null
}

/**
 * F-OP-204 (order page plan N4; 11-dock §3.1; RC1, D6) — the Head of All of <Customer>: ONE 44 px row of the same `.fw-rth` look as the
 * thread's Head, at the card's second band — [Eye] "All of X · Read only" (truncates) · View ▾ (All · With the customer · Office notes)
 * · Kind ▾ (every kind or one) · "N new · Show" only while messages wait (a hidden polite status names them) · the SAME width menu as
 * the thread's Head · ⋯ (Hide the thread, Default width, Open <customer>). In a card of 480 px or less View and Kind show their icon
 * only (their accessible names keep the words); the width menu and ⋯ never fold away. Draws its model and the frame's choice only.
 */
export function FeedHead(props: FeedHeadProps) {
  return (
    <WithMessages namespaces={['record-thread', HEAD_NS]}>
      <Head {...props} />
    </WithMessages>
  )
}

function Head({ title, model, actions, customerHref }: FeedHeadProps) {
  const t = useT('record-thread')
  const th = useT(HEAD_NS)
  const frame = useRecordFrame()
  const width = frame?.width ?? null
  const viewItems: MenuItemDef[] = FEED_VIEWS.map((view) => ({ id: `view-${view}`, label: t(`allOfCustomer.view.${view}`), checked: view === model.view, onSelect: () => actions?.onView?.(view) }))
  const kindItems: MenuItemDef[] = FEED_KIND_CHOICES.map((kind) => ({ id: `kind-${kind}`, label: t(`allOfCustomer.kind.${kind}`), checked: kind === model.kind, onSelect: () => actions?.onKind?.(kind) }))
  // tw- T.0 (one behaviour per act): the width lives in the ⋮ › Width, exactly as in the record thread's head — the four widths (the
  // one in use checked), Hide, Default width; then Open <customer>. No width button of its own.
  const widthRows: MenuItemDef[] =
    frame && width !== null
      ? [
          { id: 'width-heading', heading: true, label: th('width.title') },
          ...DOCK_WIDTHS.map((choice) => ({ id: `width-${choice}`, label: th(`width.${choice}`), checked: choice === width, onSelect: () => frame.choose(choice) })),
          { id: 'width-hide', label: th('width.hide'), onSelect: () => frame.choose('hide') },
          { id: 'width-reset', label: th('width.reset'), onSelect: () => frame.choose('reset') },
        ]
      : []
  const moreItems: MenuItemDef[] = [
    ...widthRows,
    ...(customerHref ? [...(widthRows.length > 0 ? [{ id: 'sep-customer', separator: true }] : []), { id: 'customer', label: t('allOfCustomer.openRecord', { record: model.customerName }), href: customerHref }] : []),
  ]
  const pick = useHeadPick()
  // tw- W2.5 (10-design §8): the one line under the title — "Read only · 3 threads" (the threads its messages come from).
  const threads = new Set(model.items.map((item) => `${item.record.type}:${item.record.id}`)).size
  const line = model.status === 'ready' && threads > 0 ? <p className="fw-rth-line">{th('allOf.line', { count: threads })}</p> : null
  return (
    <div className="fw-rth fw-aoc-head" role="group" aria-label={title}>
      {/* tw- W2.1 (Z4): the dock's pick as the title (one look for every scope), else the card's own name. */}
      {pick ? (
        <div className="fw-rth-titleblock">
          <div className="fw-rth-title">{pick}</div>
          {line}
        </div>
      ) : (
        <div className="fw-rth-titleblock">
          <span className="fw-aoc-title" title={title}>
            <Eye size={14} aria-hidden />
            <span className="fw-aoc-title-words">{title}</span>
          </span>
          {line}
        </div>
      )}
      <Menu
        align="right"
        className="fw-rth-menu fw-aoc-menu"
        label={
          <>
            <Filter size={14} aria-hidden />
            <span className="fw-aoc-menu-words">
              {t('allOfCustomer.view.label')}: {t(`allOfCustomer.view.${model.view}`)}
            </span>
            <ChevronDown size={14} aria-hidden />
          </>
        }
        items={viewItems}
        triggerProps={{ className: 'nds-btn sm', 'aria-label': `${t('allOfCustomer.view.label')}: ${t(`allOfCustomer.view.${model.view}`)} · ${t('allOfCustomer.view.menu')}` }}
      />
      <Menu
        align="right"
        className="fw-rth-menu fw-aoc-menu"
        label={
          <>
            <Layers size={14} aria-hidden />
            <span className="fw-aoc-menu-words">
              {t('allOfCustomer.kind.label')}: {t(`allOfCustomer.kind.${model.kind}`)}
            </span>
            <ChevronDown size={14} aria-hidden />
          </>
        }
        items={kindItems}
        triggerProps={{ className: 'nds-btn sm', 'aria-label': `${t('allOfCustomer.kind.label')}: ${t(`allOfCustomer.kind.${model.kind}`)} · ${t('allOfCustomer.kind.menu')}` }}
      />
      {model.pending > 0 && (
        <Button size="sm" variant="tonal" className="fw-aoc-news" onClick={() => actions?.onShowNew?.()}>
          {t('allOfCustomer.newShow', { count: model.pending })}
        </Button>
      )}
      {/* The list never moves by itself: the news is said, politely, and shown only on the person's own act. */}
      <span className="nds-vh" role="status" aria-live="polite">
        {model.pending > 0 ? t('allOfCustomer.newStatus', { count: model.pending }) : ''}
      </span>
      {moreItems.length > 0 && <Menu align="right" className="fw-rth-menu" label={<MoreVertical size={18} aria-hidden />} items={moreItems} triggerProps={{ className: 'nds-btn sm quiet icon', 'aria-label': th('more.label') }} />}
    </div>
  )
}
