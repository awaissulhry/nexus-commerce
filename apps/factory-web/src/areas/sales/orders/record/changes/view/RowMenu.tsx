'use client'

import { useSearchParams } from 'next/navigation'
import type { MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { discussAboutOf, type DiscussPart } from '../../dock/discuss'
import { LineMenuButton } from '../../view/LineMenu'

/**
 * F-OC-302 (order CHANGES tab, 10-design §2, §3, §5) — ONE row ⋯ for the tab's rows (What changed and Waiting): Discuss in the thread
 * (only where the page has its conversation and the reader may write there), Show in the thread (a change's step in the feed), Who
 * was told… (a change the told read names) and Copy link to this row (`?tab=changes#<row>`, the dock's scope kept). Only the items
 * this row has; none: no ⋯ at all (never an empty menu). The doors of the frame are the page's own (Discuss.tsx's).
 */
export function RowMenu({ order, prefix, label, anchor, discuss, at, toldMessageId, onWhoWasTold }: { order: { readonly id: string; readonly number: string; readonly customerSeq?: number | null | undefined }; prefix: string; label: string; anchor: string | null; discuss?: DiscussPart | null; at?: string | null; toldMessageId?: string | null; onWhoWasTold?: (messageId: string) => void }) {
  const t = useT('orders')
  const f = useT('record-frame')
  const frame = useRecordFrame()
  const search = useSearchParams()?.toString() ?? ''
  const items: MenuItemDef[] = []
  if (discuss && frame?.discuss) {
    // The customer reads its own number of the order ("your order 12"), never the office's SO-….
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, discuss)
    items.push({ id: 'discuss', label: f('discuss.of', { thing: discuss.part }), onSelect: () => frame.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about }) })
  }
  if (at && frame?.showInThread) items.push({ id: 'show', label: f('discuss.showInThread'), onSelect: () => frame.showInThread?.({ record: { type: 'SalesOrder', id: order.id }, at }) })
  if (toldMessageId && onWhoWasTold) items.push({ id: 'told', label: t('changesTab.menu.told'), onSelect: () => onWhoWasTold(toldMessageId) })
  if (anchor) {
    items.push({
      id: 'link',
      label: t('changesTab.menu.copyLink'),
      onSelect: () => {
        const href = new URL(`${tabHref(`${prefix}/sales/orders/${order.id}`, 'changes', search)}#${anchor}`, window.location.href).toString()
        void navigator.clipboard?.writeText(href)
      },
    })
  }
  if (items.length === 0) return null
  return <LineMenuButton label={label} items={items} />
}
