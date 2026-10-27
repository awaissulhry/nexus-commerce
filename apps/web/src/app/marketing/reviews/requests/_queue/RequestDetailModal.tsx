'use client'

/**
 * Reviews › Requests › the request pop-up (`GET /api/review-queue/:id`): one request over the queue, K / J or the
 * arrows to the previous / next request of the page. Tabs Request · Order · History. Snooze (the new date shown),
 * Skip, Send now (asks first: a sent request cannot be taken back) and Allow again (a request that was not asked),
 * each held with the server's reason. Amazon's last answer is in words; the info tip has the raw code and time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { KeyValue, Menu, ProgressBar, SummaryTable, Timeline, useActionConfirm, useToast, type MenuItemDef } from '@/design-system/components'
import { DetailModal } from '@/design-system/patterns'
import { Button, InfoTip, Pill, Tag } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { EBAY_ASKS_WORDS, channelMarketWords } from '../../_lib/reviewWords'
import { rulePath } from '../requestsPaths'
import { readRequestDetail, type RequestDetail } from './queueDatasource'
import { bulkResultWords, type SnoozeDays } from './queueBulk'
import { gridDateTime } from './queueColumns'
import { headerView, moneyWords, orderDate, requestActions, returnWords, snoozeChoices, timelineView, windowView } from './requestDetailModel'
import { STATUS_TONES, STATUS_WORDS } from './queueTiles'
import s from './queue.module.css'

type Tab = 'request' | 'order' | 'history'
const TABS = [
  { id: 'request', label: 'Request' },
  { id: 'order', label: 'Order' },
  { id: 'history', label: 'History' },
]
const ATTEMPT_KINDS = new Set(['try', 'sent', 'failed', 'next'])

export interface RequestDetailModalProps {
  id: string
  /** The requests of the grid page, in the order shown. */
  ids: readonly string[]
  /** Where that page starts in the whole list ((page − 1) × page size) and the list's length: the counter counts the list. */
  offset?: number
  total?: number
  onGo: (id: string) => void
  onClose: () => void
  canManage: boolean
  returnFocusTo?: () => HTMLElement | null
}

interface BulkAnswer { changed: number; held: { id: string; words: string }[] }

export function RequestDetailModal({ id, ids, offset, total, onGo, onClose, canManage, returnFocusTo }: RequestDetailModalProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [tab, setTab] = useState<Tab>('request')
  const [detail, setDetail] = useState<{ id: string; data: RequestDetail | null; error: string | null; at: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      const res = await readRequestDetail(id, controller.signal)
      if (!controller.signal.aborted) setDetail({ id, data: res.data, error: res.error, at: Date.now() })
    } catch {
      // aborted: the next request's read is on its way
    }
  }, [id])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])

  const current = detail && detail.id === id ? detail : null
  const data = current?.data ?? null
  const now = useMemo(() => new Date(current?.at ?? 0), [current?.at])

  // The queue page listens for this (in this tab too) and reads the grid and the banner again.
  const after = useCallback(async () => {
    emitInvalidation({ type: 'review.request.updated', id })
    await load()
  }, [id, load])

  const bulk = useCallback(async (action: 'snooze' | 'skip' | 'send-now', days?: SnoozeDays) => {
    setBusy(true)
    const res = await reviewsSend<BulkAnswer>('POST', '/review-queue/bulk', { ids: [id], action, days }, { idempotent: true, what: 'change' })
    setBusy(false)
    if (res.error || !res.data) {
      toast(res.error ?? 'Nexus could not do this.', 'danger')
      return
    }
    toast(bulkResultWords(action, res.data.changed, res.data.held, days), res.data.changed > 0 ? 'success' : 'warning')
    await after()
  }, [id, toast, after])

  const sendNow = useCallback(async () => {
    if (!data) return
    const amazon = data.request.channel === 'AMAZON'
    const ok = await confirm.ask({
      level: 'confirm',
      title: `Send the request for order ${data.request.orderLabel} now?`,
      confirmLabel: 'Send now',
      consequences: [
        amazon ? 'Asks Amazon to send its standard review request to this buyer now' : `Sends our review email to ${data.request.buyer} now`,
        'A sent request cannot be taken back.',
      ],
      sideEffects: amazon ? ['If Amazon answers “too early”, Nexus tries again tomorrow'] : [],
    })
    if (ok) await bulk('send-now')
  }, [data, confirm, bulk])

  const allowAgain = useCallback(async () => {
    setBusy(true)
    const res = await reviewsSend<unknown>('POST', `/review-requests/${encodeURIComponent(id)}/unsuppress`, undefined, { idempotent: true, what: 'change' })
    setBusy(false)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    toast('Allowed again — it goes at the next run', 'success')
    await after()
  }, [id, toast, after])

  const header = data ? headerView(data) : null
  const actions = data ? requestActions(data, canManage) : []
  const held = (reason: string | null) => reason ?? (busy ? 'Working…' : null)

  const snoozeItems = useMemo<MenuItemDef[]>(() => {
    if (!data) return []
    return snoozeChoices(data, canManage).map((c) => ({
      id: `snooze-${c.days}`,
      label: c.to ? `${c.label} — next try ${c.to}` : c.label,
      disabled: !!c.held,
      description: c.held ?? undefined,
      onSelect: c.held ? undefined : () => void bulk('snooze', c.days as SnoozeDays),
    }))
  }, [data, canManage, bulk])

  const headerActions = data ? (
    <span className={s.detailActions}>
      {actions.map((a) => {
        if (a.id === 'snooze') {
          return a.held ? (
            <Button key={a.id} size="sm" heldReason={a.held}>Snooze</Button>
          ) : (
            <Menu key={a.id} label="Snooze" items={snoozeItems} align="right" triggerProps={{ 'aria-label': 'Snooze: move the next try' }} />
          )
        }
        if (a.id === 'skip') return <Button key={a.id} size="sm" onClick={() => void bulk('skip')} heldReason={held(a.held)}>Skip</Button>
        if (a.id === 'send-now') return <Button key={a.id} size="sm" variant="primary" onClick={() => void sendNow()} heldReason={held(a.held)}>Send now</Button>
        return <Button key={a.id} size="sm" onClick={() => void allowAgain()} heldReason={held(a.held)}>Allow again</Button>
      })}
    </span>
  ) : undefined

  const meta = data ? (
    <span className={s.detailMeta}>
      <Pill tone={STATUS_TONES[data.request.status]}>{STATUS_WORDS[data.request.status]}</Pill>
      <Tag>{header?.triesWords}</Tag>
      {data.request.rule ? <Tag>Rule: {data.request.rule.name}</Tag> : <Tag>No rule (default timing)</Tag>}
    </span>
  ) : undefined

  return (
    <>
      <DetailModal
        open
        onClose={onClose}
        title={header?.title ?? 'Request'}
        subtitle={header?.subtitle}
        meta={meta}
        actions={headerActions}
        tabs={TABS}
        activeTab={tab}
        onTabChange={(t) => setTab(t as Tab)}
        tabsLabel="Request sections"
        nav={ids.includes(id) ? { ids, current: id, onGo, noun: 'request', offset, total } : undefined}
        loading={!current}
        error={current?.error ?? undefined}
        onRetry={() => void load()}
        returnFocusTo={returnFocusTo}
        footer={<Button onClick={onClose}>Close</Button>}
      >
        {data && tab === 'request' && <RequestTab detail={data} now={now} />}
        {data && tab === 'order' && <OrderTab detail={data} />}
        {data && tab === 'history' && (
          <Timeline steps={timelineView(data)} label="Everything that happened to this request" now={current?.at} />
        )}
      </DetailModal>
      {confirm.element}
    </>
  )
}

function RequestTab({ detail, now }: { detail: RequestDetail; now: Date }) {
  const r = detail.request
  const win = windowView(detail, now)
  const attempts = timelineView({ ...detail, timeline: detail.timeline.filter((t) => ATTEMPT_KINDS.has(t.kind)) })
  const amazon = r.channel === 'AMAZON'
  return (
    <div className={s.detailBody}>
      {detail.amazonAnswer && (
        <div className={s.answer}>
          <div className={s.answerHead}>
            <span>Amazon’s last answer</span>
            <InfoTip tip={`Code: ${detail.amazonAnswer.code}${detail.amazonAnswer.at ? ` · ${gridDateTime(detail.amazonAnswer.at)}` : ''}`} />
          </div>
          <p className={s.answerWords}>{detail.amazonAnswer.words}</p>
        </div>
      )}
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: 'Order', value: r.orderLabel },
          { label: 'Buyer', value: r.buyer, hint: 'first name and initial only' },
          { label: 'Channel', value: channelMarketWords(r.channel, r.market) },
          { label: 'Product', value: r.product ?? '—', hint: r.productType ?? undefined },
          { label: 'Fulfilment', value: detail.order.fulfilment ?? '—' },
          { label: 'Delivered (ours)', value: win.delivered, hint: win.deliveredHint ?? undefined },
          ...(win.amazon
            ? [{
                label: 'Amazon’s window',
                value: (
                  <span className={s.window}>
                    <ProgressBar value={win.amazon.value} ariaLabel="Where this order is in Amazon’s day 5–30 window" />
                    <span>{win.amazon.words}</span>
                  </span>
                ),
                hint: win.amazon.lastDay ? `last day ${win.amazon.lastDay}` : undefined,
              }]
            : []),
          { label: 'Status', value: STATUS_WORDS[r.status], hint: r.reasonWords },
          { label: r.sentAt ? 'Sent' : 'Next try', value: r.sentAt ? gridDateTime(r.sentAt) : r.nextTryAt ? gridDateTime(r.nextTryAt) : '—', hint: r.dayWords },
          {
            label: 'Made by rule',
            value: r.rule ? <Link href={rulePath(r.rule.id)}>{r.rule.name}</Link> : 'No rule matched — default timing',
            hint: r.rule?.howWasIt ? 'asks “How was it?” first' : undefined,
          },
          {
            label: 'Message',
            value: amazon
              ? 'Amazon’s own standard email (its text is fixed)'
              : r.channel === 'EBAY' ? `None. ${EBAY_ASKS_WORDS}.` : 'Our review email (Preview email shows it)',
          },
        ]}
      />
      <div>
        <h3 className={s.sectionHead}>Attempts</h3>
        {attempts.length ? <Timeline steps={attempts} label="Tries of this request" /> : <p className={s.muted}>No try yet.</p>}
      </div>
    </div>
  )
}

function OrderTab({ detail }: { detail: RequestDetail }) {
  const o = detail.order
  return (
    <div className={s.detailBody}>
      <SummaryTable
        label="Order lines"
        columns={['Product', 'SKU', 'Qty', 'Price']}
        rows={o.lines.map((l, i) => ({ id: `${i}:${l.sku}`, cells: [l.name ?? '—', l.sku, String(l.quantity), moneyWords(l.price, o.currency)] }))}
      />
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: 'Ordered', value: orderDate(o.dates.ordered) },
          { label: 'Shipped', value: orderDate(o.dates.shipped) },
          { label: 'Delivered (ours)', value: orderDate(o.dates.delivered), hint: detail.window.estimate && o.dates.delivered ? 'our estimate' : undefined },
          { label: 'Cancelled', value: o.dates.cancelled ? orderDate(o.dates.cancelled) : 'No' },
          { label: 'Total', value: moneyWords(o.total, o.currency) },
          { label: 'Refund', value: o.refund ? `${moneyWords(o.refund.amount, o.refund.currency)} on ${orderDate(o.refund.at)}` : 'None' },
          { label: 'Return', value: returnWords(o.return) },
        ]}
      />
      <div>
        <Button asChild size="sm">
          <Link href={`/orders/${encodeURIComponent(o.id)}`}>
            <ExternalLink size={13} aria-hidden /> Open the order
          </Link>
        </Button>
      </div>
    </div>
  )
}
