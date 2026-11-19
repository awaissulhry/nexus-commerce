'use client'

import { ChevronDown, Eye, Filter, Layers, MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { WIDTH_NS, WidthMenu } from '../../../../../lib/record-thread/head/view/WidthMenu'
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
    <WithMessages namespaces={['record-thread', WIDTH_NS]}>
      <Head {...props} />
    </WithMessages>
  )
}

function Head({ title, model, actions, customerHref }: FeedHeadProps) {
  const t = useT('record-thread')
  const th = useT(WIDTH_NS)
  const frame = useRecordFrame()
  const width = frame?.width ?? null
  const viewItems: MenuItemDef[] = FEED_VIEWS.map((view) => ({ id: `view-${view}`, label: t(`allOfCustomer.view.${view}`), checked: view === model.view, onSelect: () => actions?.onView?.(view) }))
  const kindItems: MenuItemDef[] = FEED_KIND_CHOICES.map((kind) => ({ id: `kind-${kind}`, label: t(`allOfCustomer.kind.${kind}`), checked: kind === model.kind, onSelect: () => actions?.onKind?.(kind) }))
  const moreItems: MenuItemDef[] = [
    ...(frame && width !== null
      ? [
          { id: 'hide', label: th('width.hide'), onSelect: () => frame.choose('hide') },
          { id: 'reset', label: th('width.reset'), onSelect: () => frame.choose('reset') },
        ]
      : []),
    ...(customerHref ? [{ id: 'customer', label: t('allOfCustomer.openRecord', { record: model.customerName }), href: customerHref }] : []),
  ]
  return (
    <div className="fw-rth fw-aoc-head" role="group" aria-label={title}>
      <span className="fw-aoc-title" title={title}>
        <Eye size={14} aria-hidden />
        <span className="fw-aoc-title-words">{title}</span>
      </span>
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
      <WidthMenu width={width} onWidth={frame ? (choice) => frame.choose(choice) : undefined} />
      {moreItems.length > 0 && <Menu align="right" className="fw-rth-menu" label={<MoreHorizontal size={16} aria-hidden />} items={moreItems} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': th('more.label') }} />}
    </div>
  )
}
