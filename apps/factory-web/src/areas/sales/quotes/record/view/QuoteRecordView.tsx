'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { Copy, ExternalLink, FileX, Inbox, Lock, ShieldOff, Tags } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DocumentSendView, type DocumentSendActions, type SendParts } from '../../../../_shared/document-send/view/DocumentSendView'
import { previewHref, type QuoteDetail } from '../../api'
import { customerSeesOf, customerSeesWords, daysUntil, isWideTab, nextStep, QUOTE_TABS, readOnlyReason, STATUS_TONE, type QuoteTab } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'
import type { QuoteDepthSlots } from '../lines-depth/slots'
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import { ApprovalTab } from './ApprovalTab'
import { QuoteDialogs } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { PriceTab } from './PriceTab'
import { TermsTab } from './TermsTab'
import { VersionsTab } from './VersionsTab'
// ---- B-TH-257: the quote on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import '../../quotes.css'

export type { QuoteRecordViewModel, QuoteRecordActions } from '../record-model'

/**
 * SCR-035 — the quote record (design sales.quotes "Record: Quote"; 00 §2.2 record studio; Owner L1: the tabs always in view), on
 * RecordFrame (B-TH-257; threads plan O-SAL-QUO-REC, the rule of picture 38). The band in the shell's band row: ‹ Quotes,
 * "<number> · <customer>", ONE status pill, then the revision (r2), its validity, the contact, the price list it is priced from,
 * "Made from INQ-… — Open" and "Customer sees: …" for a quote made from a request, the accepted quote's order, the save words; the
 * next step as the primary (by state, held with its reason), the Thread button (⌘J), ⋯ with its Keyboard line. The thread is docked
 * beside every tab (40 %; one third on Lines under 1600 px); Activity's tools are in the thread's "⋯" (R-ACT), its files in the
 * Files view. The tabs 7 → 5: Lines (style blocks: colour × size grids typed from the keyboard, autosaved per block; the summary
 * rail beside them), Price & margin, Terms & delivery (explicit save), Revisions, Approval & sending (the rules and requests, then
 * the PDF — live draft or frozen sent —, the accept link and what it did, the evidence, the proofs, the deposit). ONE notice in the
 * body column, the most serious first, the rest behind "N more notices". Money follows the person's grains: cost and margin columns
 * are absent, never zero. It draws one view model and fetches nothing (QuoteRecord.tsx loads it).
 */
// B-TH-257: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view
// shows of it.
type Slots = { thread?: ReactNode; printThread?: ReactNode; sendActions?: DocumentSendActions; /** B-W2b-165: Approval & sending › Proofs (the container mounts it). */ proofs?: ReactNode; /** B-W2b-316: the W2b parts (lines-depth/slots.ts). */ depth?: QuoteDepthSlots; /** B-W2b-432: the send panel's language and message template. */ sendParts?: SendParts }

export function QuoteRecordView({ model, actions, ...slots }: { model: QuoteRecordViewModel; actions?: QuoteRecordActions } & Slots) {
  return (
    <WithMessages namespaces={['sales', 'records']}>
      <QuoteRecord model={model} actions={actions} {...slots} />
    </WithMessages>
  )
}

function QuoteRecord({ model, actions, ...slots }: { model: QuoteRecordViewModel; actions?: QuoteRecordActions } & Slots) {
  const t = useT('sales')
  const listHref = `${model.prefix}/sales/quotes`
  const loaded = model.quote

  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="Quote"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={220} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-q-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-q-skeleton">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </RecordFrame>
    )
  }
  return <ReadyRecord quote={loaded.value} model={model} actions={actions} {...slots} />
}

function ReadyRecord({ quote, model, actions, thread, printThread, sendActions, proofs, depth, sendParts }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions } & Slots) {
  const t = useT('sales')
  const locale = useLocale()
  const recordHref = `${model.prefix}/sales/quotes/${quote.id}`
  const tabHref = (tab: QuoteTab) => `${recordHref}?tab=${tab}`
  const step = nextStep(quote, model.me, model.can)
  const readOnly = readOnlyReason(quote, model.can)
  const status = quote.current.status
  const pendingRequest = quote.approval.requests.find((request) => request.status === 'PENDING') ?? null

  // Keys (00 §3.17 + the page's own): ⌘↵ opens Send, a asks for an approval — never while typing. ⌘J is the frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      const inDialog = !!target?.closest('[role="dialog"]')
      if (inDialog || model.dialog || model.send) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.step === 'send' && !step.held) {
        event.preventDefault()
        actions?.onOpenSend?.()
        return
      }
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'a' && step.step === 'askApproval' && !step.held) {
        event.preventDefault()
        actions?.onDialog?.('ask')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const issueCount = quote.issues.filter((issue) => issue.severity === 'BLOCKS' || issue.severity === 'BLOCKS_SEND').length
  // B-TH-257: the five tabs, each counting what it lists (Approval & sending: the approval rounds).
  const tabs: TabItem[] = QUOTE_TABS.map((tab) => ({
    id: tab,
    href: tabHref(tab),
    label: tab === 'lines' && issueCount > 0 ? (
      <span className="fw-q-tablabel">
        {t(`tab.${tab}`)}
        <span className="fw-q-dot" aria-label={t('tab.problems', { count: issueCount })} role="img" />
      </span>
    ) : (
      t(`tab.${tab}`)
    ),
    count: tab === 'lines' ? quote.lines.length : tab === 'versions' ? quote.currentRevision : tab === 'approval' ? (quote.approval.needed || quote.approval.requests.length > 0 ? quote.approval.requests.length : null) : null,
  }))

  const validity = status === 'SENT' && quote.current.validUntil ? daysUntil(quote.current.validUntil, model.today) : null

  const primary = (() => {
    const held = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null
    switch (step.step) {
      case 'send':
        return (
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onOpenSend?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('action.send')}
          </Button>
        )
      case 'askApproval':
        return (
          <>
            <Button size="sm" heldReason={t('held.needsApproval', { reasons: quote.approval.rules.filter((rule) => rule.broken).map((rule) => t(`reason.${rule.reason}`)).join(' · ') })} onClick={() => undefined}>
              {t('action.send')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialog?.('ask')} aria-keyshortcuts="a">
              {t('action.ask')}
            </Button>
          </>
        )
      case 'decide':
        return (
          <>
            <Button size="sm" variant="danger-outline" heldReason={held} onClick={() => actions?.onDialog?.('reject')}>
              {t('action.reject')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialog?.('approve')}>
              {t('action.approve')}
            </Button>
          </>
        )
      case 'withdraw':
        return (
          <Button size="sm" heldReason={held} onClick={() => actions?.onDialog?.('withdraw')}>
            {t('action.withdraw')}
          </Button>
        )
      case 'revise':
        return (
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialog?.('revise')}>
            {t('action.revise', { next: quote.currentRevision + 1 })}
          </Button>
        )
      default:
        return null
    }
  })()

  const canCancel = model.can.manage && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(status)
  const more: MenuItemDef[] = [
    { id: 'preview', label: t('action.previewPdf'), icon: <ExternalLink size={14} aria-hidden />, href: previewHref(quote.id, quote.current.language === 'en' ? 'en' : 'it'), target: '_blank' as const },
    ...(status === 'APPROVED' && model.can.manage ? [{ id: 'reopen', label: t('action.reopen'), onSelect: () => actions?.onDialog?.('reopen') }] : []),
    ...(status === 'SENT' && model.can.send ? [{ id: 'newLink', label: t('action.newLink'), onSelect: () => actions?.onDialog?.('newLink') }] : []),
    // B-W2a-49 (SAL-155): a new draft copied from a version of this quote, for this customer or another.
    { id: 'duplicate', label: t('action.duplicate'), icon: <Copy size={14} aria-hidden />, disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDuplicateStart?.() },
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(quote.number).catch(() => undefined)
      },
    },
    // Cancel last (it revokes the accept link: its dialog says so).
    ...(canCancel ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.('cancel') }] : []),
  ]

  const saveWords =
    model.save.state === 'saving' ? (
      <span className="fw-q-save" role="status">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    ) : model.save.state === 'failed' ? (
      <span className="fw-q-save is-failed" role="status">
        {t('save.failed')}{' '}
        <Button size="sm" variant="quiet" onClick={() => actions?.onRetrySave?.()}>
          {t('save.retry')}
        </Button>
      </span>
    ) : model.save.at ? (
      <span className="fw-q-save" role="status">
        {t('save.saved', { time: formatTime(model.save.at, { locale }) })}
      </span>
    ) : (
      <span className="fw-q-save" role="status" />
    )

  // ---- B-TH-257 (B-TH-078's API): where the quote came from and where it went ----
  const madeFrom = quote.madeFrom ?? null
  const sees = customerSeesOf(quote)
  const order = quote.order ?? null
  const madeOrder = order?.state === 'MADE' && order.id && order.number ? { id: order.id, number: order.number, cancelled: order.status === 'CANCELLED' } : null
  const orderWaits = order?.state === 'WAITS' ? order : null
  const makeHeld = !model.orders?.make ? t('held.noOrders') : model.busy ? t('held.busy') : null

  return (
    <>
      <RecordFrame
        recordType="Quote"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(model.tab)}
        band={{
          back: <Link href={quotesHref(model.prefix)}>{t('record.back')}</Link>,
          title: (
            <span className="fw-q-title">
              {quote.number} <span className="fw-q-title-party">· {quote.party.legalName}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>,
          meta: (
            <>
              <Tag tone="neutral">{t('record.versionChip', { revision: quote.currentRevision })}</Tag>
              {validity !== null && <Tag tone={validity < 0 ? 'danger' : validity <= 7 ? 'warning' : 'info'}>{validity < 0 ? t('record.validEnded') : t('record.validLeft', { count: validity })}</Tag>}
              {quote.contact && <span className="fw-q-hint">{quote.contact.name}</span>}
              {/* B-W2a-49 (design page.conn "Price list"): the list version this quote is priced from, a link to it. */}
              {quote.current.priceList && (
                <Link className="fw-q-hint" href={`${model.prefix}/sales/price-lists/${encodeURIComponent(quote.current.priceList.listId)}?tab=prices&version=${encodeURIComponent(quote.current.priceList.versionId)}`}>
                  <Tags size={12} aria-hidden /> {t('record.priceList', { code: quote.current.priceList.code, revision: quote.current.priceList.revision })}
                </Link>
              )}
              {/* B-TH-257: "Made from INQ-… — Open" (office only: the portal never reads the request number), and what the customer reads of it. */}
              {madeFrom &&
                (model.readsRequests ? (
                  <Link className="fw-q-hint" href={`${model.prefix}/sales/incoming/${encodeURIComponent(madeFrom.inquiryId)}`}>
                    <Inbox size={12} aria-hidden /> {t('record.madeFrom', { number: madeFrom.number })}
                  </Link>
                ) : (
                  <span className="fw-q-hint">{t('record.madeFromPlain', { number: madeFrom.number })}</span>
                ))}
              {sees && <span className="fw-q-hint">{t('record.customerSees', { state: customerSeesWords(sees, locale) })}</span>}
              {/* B-TH-257: the accepted quote's order (a cancelled one says so). */}
              {madeOrder &&
                (model.orders?.view ? (
                  <Link className="fw-q-hint" href={`${model.prefix}/sales/orders/${encodeURIComponent(madeOrder.id)}`}>
                    {t(madeOrder.cancelled ? 'record.orderCancelled' : 'record.order', { number: madeOrder.number })}
                  </Link>
                ) : (
                  <span className="fw-q-hint">{t(madeOrder.cancelled ? 'record.orderCancelledPlain' : 'record.orderPlain', { number: madeOrder.number })}</span>
                ))}
              {saveWords}
            </>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-257: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={t(model.notice.key, model.notice.params)}
              action={
                actions?.onDismissNotice ? (
                  <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                    {t('common.dismiss')}
                  </Button>
                ) : undefined
              }
            />
          )}
          {/* B-W2b-316: a W2b part's notice. */}
          {depth?.notice}
          {model.changed && (
            <Banner
              tone="info"
              title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {status === 'PENDING_APPROVAL' && pendingRequest && (
            <Banner tone="warning" title={t('record.waitingApproval', { reasons: pendingRequest.reasons.map((reason) => t(`reason.${reason}`)).join(' · ') })}>
              {pendingRequest.createdById === model.me ? t('record.waitingYours') : t('record.waitingWho')}
            </Banner>
          )}
          {/* B-TH-257 (O-SAL-QUO-REC.band-F03): the customer accepted, no order exists yet — why, and the door when nothing else holds it. */}
          {orderWaits?.reason && (
            <Banner
              tone="warning"
              title={t(`record.orderWaits.${orderWaits.reason}`)}
              action={
                orderWaits.reason === 'NOT_MADE' ? (
                  <Button size="sm" variant="primary" heldReason={makeHeld} onClick={() => actions?.onMakeOrder?.()}>
                    {t('record.makeOrder')}
                  </Button>
                ) : undefined
              }
            />
          )}
          {status === 'ACCEPTED' && (
            <Banner
              tone="success"
              title={t('record.accepted')}
              action={
                model.tab !== 'approval' ? (
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={tabHref('approval')}>{t('tab.approval')}</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
          {readOnly && (model.tab === 'lines' || model.tab === 'terms') && status !== 'PENDING_APPROVAL' && (
            <Banner tone="info" title={<span className="fw-q-inline"><Lock size={14} aria-hidden /> {t(readOnly, { revision: quote.currentRevision, next: quote.currentRevision + 1, date: quote.current.validUntil ? formatDate(quote.current.validUntil, { locale }) : '—' })}</span>} />
          )}
        </RecordNotices>

        <div className="fw-q-main">
          {model.tab === 'lines' && <LinesTab quote={quote} model={model} actions={actions} step={step} depth={depth} />}
          {model.tab === 'price' && <PriceTab quote={quote} model={model} depth={depth?.price} /* B-W2b-343 */ pricing={depth?.pricing} />}
          {model.tab === 'terms' && <TermsTab quote={quote} model={model} actions={actions} depth={depth} />}
          {model.tab === 'versions' && <VersionsTab quote={quote} model={model} actions={actions} depth={depth?.versionsList} />}
          {/* B-TH-257: Approval & sending — the approval, then the quote's way to the customer (the PDF, the link, the evidence, the proofs, the deposit). */}
          {model.tab === 'approval' && (
            <div className="fw-q-merged">
              <ApprovalTab quote={quote} model={model} actions={actions} />
              <DocumentsTab quote={quote} model={model} actions={actions} proofs={proofs} depositActions={depth?.depositActions} />
            </div>
          )}
        </div>
      </RecordFrame>

      <QuoteDialogs quote={quote} model={model} actions={actions} />
      {depth?.overlay}
      {model.duplicate && <DuplicateDialog model={model.duplicate} canManage={model.can.manage} actions={actions} />}
      {model.send && <DocumentSendView open model={model.send} actions={sendActions} parts={sendParts} />}
    </>
  )
}

const quotesHref = (prefix: string) => `${prefix}/sales/quotes`
