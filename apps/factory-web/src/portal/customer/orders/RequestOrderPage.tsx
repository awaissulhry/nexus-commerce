'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { orderLogPath, orderLogReader } from '../../../lib/change-log/api'
import { reviewDraftOf } from '../../../lib/order-draft/review-send'
import type { DraftRecord } from '../../../lib/order-draft/schema'
import { ReviewSendWindow } from '../../../lib/order-draft/view/ReviewSendWindow'
import { orderPicturePath, orderPictureSaver, pictureReader } from '../../../lib/record-picture/api'
import { OrderPictureWindow } from '../../../lib/record-picture/OrderPictureWindow'
import { WithMessages } from '../../../record-panels/i18n'
// ---- owb-po6.1: the ONE lines table (web A's), mounted
import { Button } from '@nexus/ui/primitives'
import { lineRowsOfDraft, OrderLinesTable, ownColumnsOfRecord } from '../../../lib/order-lines'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { sendDraft } from '../neworder/api'
import { CustomerRequestRecordPage } from '../requests/RequestPage'
import { NS } from './model'
import { ORDER_PAGE_NS, usePageWords } from './page-words'
import { pictureChoicesOfDraft } from './picture'
import { fetchRequestRecord, requestFilesOf, requestFrameOf, requestTabOf, takeBackRefusal, takeBackRequest } from './request-record'
import { AllChangesWindow } from './view/AllChangesWindow'
import { RequestOrderView, type RequestOrderViewModel } from './view/RequestOrderView'
import { useOffline } from './hooks'

/**
 * `/p/<party>/orders/requests/<id>` (owb-po5.2, lead settle 2): ONE route for both kinds of request. A Draft or Sent order (a
 * `PortalOrderRequest`, its draft record) draws the order's frame — the band (back · picture · "Your order · <subject>" · their PO ·
 * the life chip · ONE primary: Draft "Review and send…" (A's ReviewSendWindow) · Sent "Take it back") and the five tabs; an e-mail
 * request (an `Inquiry`, whose id the draft read does not know: 404) keeps its own page (B-TH-222). An accepted request sends the
 * person to the order it became. Who opens it: a customer who reads orders or keeps drafts (the brand's Designer starts drafts).
 */
export function CustomerRequestRoute({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const [kind, setKind] = useState<'reading' | 'draft' | 'email'>('reading')
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [failed, setFailed] = useState(false)
  const mayDraft = frame.me.permissions.includes('portal.orderDrafts.edit')
  const reads = frame.me.permissions.includes('portal.salesOrders.view')
  const read = useCallback(async () => {
    try {
      const answer = mayDraft || reads ? await fetchRequestRecord(api, id) : null
      setRecord(answer)
      setKind(answer ? 'draft' : 'email')
      setFailed(false)
    } catch {
      setFailed(true)
      setKind('draft')
    }
  }, [api, id, mayDraft, reads])
  useEffect(() => {
    void read()
  }, [read])
  if (kind === 'email') return <CustomerRequestRecordPage id={id} />
  return (
    <WithMessages namespaces={[NS, ORDER_PAGE_NS, 'ds-words', 'lists', 'order-draft']}>
      <RequestOrderContainer id={id} record={record} reading={kind === 'reading'} failed={failed} onRead={read} onRecord={setRecord} />
    </WithMessages>
  )
}

function RequestOrderContainer({ id, record, reading, failed, onRead, onRecord }: { id: string; record: DraftRecord | null; reading: boolean; failed: boolean; onRead: () => Promise<void>; onRecord: (record: DraftRecord) => void }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const search = useSearchParams()
  const t = usePageWords()
  const offline = useOffline()
  const can = (permission: string) => frame.me.permissions.includes(permission)
  const preview = frame.me.preview
  const shown = useMemo(() => (record ? requestFrameOf(record, { orderName: t('request.name') }, { mayOrder: can('portal.orderRequests.manage'), mayDraft: can('portal.orderDrafts.edit'), preview }) : null), [record, t, preview, frame.me.permissions])
  const tab = requestTabOf(search?.get('tab'), shown?.seesPrices ?? false)
  const href = `${frame.prefix}/orders/requests/${encodeURIComponent(id)}`
  const [notice, setNotice] = useState<RequestOrderViewModel['notice']>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [pictureOpen, setPictureOpen] = useState(false)
  const [review, setReview] = useState<{ busy: boolean } | null>(null)
  const [takingBack, setTakingBack] = useState(false)
  const pictures = useMemo(() => pictureReader(api), [api])
  const log = useMemo(() => orderLogReader(api, orderLogPath('portal', 'request', id)), [api, id])

  // An accepted request is an order now: its own page (the number is the order's).
  useEffect(() => {
    if (shown?.orderId) router.replace(`${frame.prefix}/orders/${encodeURIComponent(shown.orderId)}`)
  }, [shown?.orderId, frame.prefix, router])

  // The live channel: a change of this request (the office's, a colleague's) reads it again.
  usePortalLive({
    onChange: (change) => {
      if (change.type.startsWith('portal_order_request.') && change.fields.requestId === id) void onRead()
    },
    onReconnect: () => void onRead(),
  })

  const takeBack = async () => {
    if (!shown || takingBack) return
    setTakingBack(true)
    try {
      onRecord(await takeBackRequest(api, id, shown.version, newIdempotencyKey()))
      setNotice({ tone: 'success', text: t('takeBack.done') })
    } catch (error) {
      setNotice({ tone: 'warning', text: t(takeBackRefusal(error)) })
      void onRead()
    } finally {
      setTakingBack(false)
    }
  }

  const send = async () => {
    if (!record || !shown || review?.busy) return
    setReview({ busy: true })
    try {
      onRecord(await sendDraft(api, id, shown.version, newIdempotencyKey()))
      setReview(null)
      setNotice({ tone: 'success', text: t('send.done') })
    } catch {
      setReview({ busy: false })
      setNotice({ tone: 'danger', text: t('send.failed') })
    }
  }

  const held = preview ? t('held.preview') : offline ? t('held.offline') : null
  const primary =
    shown?.primary === 'send'
      ? { id: 'send', label: t('band.send'), variant: 'primary' as const, heldReason: held ?? (shown.may.send ? null : t('held.mayOrder')), onClick: () => setReview({ busy: false }) }
      : shown?.primary === 'takeBack'
        ? { id: 'take-back', label: t('band.takeBack'), variant: 'primary' as const, heldReason: held ?? (takingBack ? t('held.busy') : shown.may.takeBack ? null : t('held.takeBack')), onClick: () => void takeBack() }
        : null
  usePortalBand(
    shown
      ? {
          title: shown.title,
          back: { href: `${frame.prefix}/orders`, label: t('band.back') },
          refs: shown.customerRef ? { theirs: shown.customerRef, ours: null } : null,
          // The shared StateChip draws the life's own words (the label is only the plain pill's, never drawn with a life).
          status: { label: '', tone: 'neutral', life: shown.life, note: shown.note },
          picture: { recordId: id, number: shown.title, source: 'customerRequest', onOpen: shown.may.picture ? () => setPictureOpen(true) : null },
          actions: primary ? [primary] : [],
        }
      : { title: t('request.name'), back: { href: `${frame.prefix}/orders`, label: t('band.back') } },
  )

  const model: RequestOrderViewModel = {
    state: reading ? 'loading' : failed || !shown ? 'error' : 'ready',
    frame: shown,
    tab,
    href,
    files: record ? requestFilesOf(record) : [],
    notice,
    // A's New order window still opens on this address (its ?draft=); the order band's own window comes with it.
    draftHref: shown?.status === 'DRAFT' ? `${frame.prefix}/orders/new?draft=${encodeURIComponent(id)}` : null,
    // owb-po6.1: the ONE lines table — a draft reads here and changes in the order window (A's, today's address); a sent order reads
    // ("take it back to change it": the table's own words). The Your price column only for a price holder.
    lines:
      record && shown ? (
        <div className="fw-pord-tab">
          <OrderLinesTable
            model={{
              rows: lineRowsOfDraft(record.request),
              mode: shown.status === 'DRAFT' ? 'draft' : 'sent',
              columns: ownColumnsOfRecord(record.request.ownColumns),
              styles: [],
              kinds: [],
              prices: record.seesPrices ? { currency: record.request.currency, edit: false, byLine: Object.fromEntries(record.request.lines.map((line) => [line.id, { list: line.priceNow ?? null, own: line.brandUnitPrice ?? null }])) } : null,
              pending: false,
              removed: [],
              writeHeld: shown.status === 'DRAFT' ? t('lines.draftHeld') : null,
              saving: [],
              columnsDoor: false,
              door: 'portal',
            }}
          />
          {shown.status === 'DRAFT' ? (
            <Button asChild size="sm">
              <a href={`${frame.prefix}/orders/new?draft=${encodeURIComponent(id)}`}>{t('request.lines.open')}</a>
            </Button>
          ) : null}
        </div>
      ) : undefined,
  }

  return (
    <>
      <RequestOrderView model={model} actions={{ onRetry: () => void onRead(), onChanges: () => setChangesOpen(true), onDismissNotice: () => setNotice(null) }} />
      <AllChangesWindow open={changesOpen} onClose={() => setChangesOpen(false)} name={shown?.title ?? ''} read={log} />
      {record && shown ? (
        <OrderPictureWindow
          open={pictureOpen}
          onClose={() => setPictureOpen(false)}
          number={shown.title}
          subject={shown.subject}
          record={{ source: 'customerRequest', recordId: id, read: pictures }}
          now={{ fileId: shown.picture?.fileId ?? null, version: shown.version }}
          choices={pictureChoicesOfDraft(record)}
          save={orderPictureSaver(api, orderPicturePath('portal', 'request', id))}
          onSaved={() => void onRead()}
        />
      ) : null}
      {record && shown && review ? (
        <ReviewSendWindow
          model={{ open: true, drafts: [reviewDraftOf(record, shown.title)], currency: record.request.currency, note: '', noteDoor: false, held: held ?? (shown.may.send ? null : t('held.mayOrder')), busy: review.busy, results: null }}
          actions={{ onClose: () => setReview(null), onSend: () => void send() }}
        />
      ) : null}
    </>
  )
}
