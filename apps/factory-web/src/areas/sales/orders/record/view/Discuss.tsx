'use client'

import { History, MessageSquarePlus, Users } from 'lucide-react'
import { Button, ToolbarButton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { discussAboutOf, type DiscussPart } from '../dock/discuss'

/**
 * F-SA-266 (sales page plan N2, N4; picks P2, P9; 10-order-page §2 "Doors legend") — a row's door into the order's conversation:
 * Discuss (the icon button "Discuss … in the thread": the dock shows, the pick goes to This order, the box opens on Office note with
 * the chip) and, on a history row, Show in the thread (its step in the feed). Drawn only where the page has a conversation (the
 * frame's doors); nothing else on the row changes.
 */
export function DiscussDoor({ order, thing, ...part }: { order: { readonly id: string; readonly number: string; /* B-SA-070b */ readonly customerSeq?: number | null | undefined }; /** The button's words ("Discuss line 2 in the thread"); default the part. */ thing?: string } & DiscussPart) {
  const frame = useRecordFrame()
  const t = useT('orders')
  const f = useT('record-frame')
  if (!frame?.discuss) return null
  // B-SA-070b: the customer reads its own number of the order ("your order 12"), never the office's SO-….
  const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
  const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, part)
  return <ToolbarButton icon={<MessageSquarePlus size={14} aria-hidden />} label={f('discuss.of', { thing: thing ?? part.part })} onClick={() => frame.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })} />
}

/** A history row's step in the order's conversation (the change nearest its time). */
export function ShowInThreadDoor({ order, at }: { order: { readonly id: string }; at: string }) {
  const frame = useRecordFrame()
  const f = useT('record-frame')
  if (!frame?.showInThread) return null
  return <ToolbarButton icon={<History size={14} aria-hidden />} label={f('discuss.showInThread')} onClick={() => frame.showInThread?.({ record: { type: 'SalesOrder', id: order.id }, at })} />
}

/** "Followers…" (O3 People): the thread's followers, opened from the body (the frame's door; only where the page has a conversation). */
export function FollowersDoor() {
  const frame = useRecordFrame()
  const f = useT('record-frame')
  if (!frame?.discuss || !frame.openDoor) return null
  return (
    <Button size="sm" variant="quiet" onClick={() => frame.openDoor?.('followers')}>
      <Users size={13} aria-hidden /> {f('discuss.followers')}
    </Button>
  )
}
