'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, FileX, Lock, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { DocumentSendView, type DocumentSendActions } from '../../../../_shared/document-send/view/DocumentSendView'
import { previewHref, type QuoteDetail } from '../../api'
import { daysUntil, nextStep, QUOTE_TABS, readOnlyReason, STATUS_TONE, type QuoteTab } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'
import { ApprovalTab } from './ApprovalTab'
import { QuoteDialogs } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { PriceTab } from './PriceTab'
import { TermsTab } from './TermsTab'
import { VersionsTab } from './VersionsTab'
import '../../quotes.css'

export type { QuoteRecordViewModel, QuoteRecordActions } from '../record-model'

/**
 * SCR-035 — the quote record (design sales.quotes "Record: Quote"; 00 §2.2 record studio; Owner L1: the tabs always in
 * view). The band: ‹ Quotes, "<number> · <customer>", the version, the status and its validity, the save words, the next
 * step as the primary (by state, held with its reason), then ⋯. The tabs: Lines (style blocks: colour × size grids typed
 * from the keyboard, autosaved per block; the summary rail beside them), Price & margin, Terms & delivery (explicit save),
 * Versions, Approval, Documents (the PDF, the accept link, the evidence, the deposit), Activity (the record panels; also
 * beside any tab on a wide screen with ⌘J). Money follows the person's grains: cost and margin columns are absent, never
 * zero. It draws one view model and fetches nothing (QuoteRecord.tsx loads it).
 */
export function QuoteRecordView({ model, actions, sendActions, panels }: { model: QuoteRecordViewModel; actions?: QuoteRecordActions; sendActions?: DocumentSendActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['sales', 'records']}>
      <QuoteRecord model={model} actions={actions} sendActions={sendActions} panels={panels} />
    </WithMessages>
  )
}

function QuoteRecord({ model, actions, sendActions, panels }: { model: QuoteRecordViewModel; actions?: QuoteRecordActions; sendActions?: DocumentSendActions; panels?: ReactNode }) {
  const t = useT('sales')
  const listHref = `${model.prefix}/sales/quotes`
  const loaded = model.quote

  if (loaded.status !== 'ready') {
    return (
      <div className="fw-q">
        <div className="fw-q-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={220} height={22} /> : t('record.title')} />
        </div>
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
      </div>
    )
  }
  return <ReadyRecord quote={loaded.value} model={model} actions={actions} sendActions={sendActions} panels={panels} />
}

function ReadyRecord({ quote, model, actions, sendActions, panels }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions; sendActions?: DocumentSendActions; panels?: ReactNode }) {
  const t = useT('sales')
  const locale = useLocale()
  const recordHref = `${model.prefix}/sales/quotes/${quote.id}`
  const tabHref = (tab: QuoteTab) => `${recordHref}?tab=${tab}`
  const step = nextStep(quote, model.me, model.can)
  const readOnly = readOnlyReason(quote, model.can)
  const status = quote.current.status
  const pendingRequest = quote.approval.requests.find((request) => request.status === 'PENDING') ?? null

  // Keys (00 §3.17 + the page's own): ⌘↵ opens Send, a asks for an approval, ⌘J the thread — never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      const inDialog = !!target?.closest('[role="dialog"]')
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
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
  const more = [
    { id: 'preview', label: t('action.previewPdf'), icon: <ExternalLink size={14} aria-hidden />, href: previewHref(quote.id, quote.current.language === 'en' ? 'en' : 'it'), target: '_blank' as const },
    ...(status === 'APPROVED' && model.can.manage ? [{ id: 'reopen', label: t('action.reopen'), onSelect: () => actions?.onDialog?.('reopen') }] : []),
    ...(status === 'SENT' && model.can.send ? [{ id: 'newLink', label: t('action.newLink'), onSelect: () => actions?.onDialog?.('newLink') }] : []),
    ...(canCancel ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.('cancel') }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(quote.number).catch(() => undefined)
      },
    },
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

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity

  return (
    <div className="fw-q">
      <div className="fw-q-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/sales/quotes`}>{t('record.back')}</Link>}
          title={
            <span className="fw-q-title">
              {quote.number} <span className="fw-q-title-party">· {quote.party.legalName}</span>
            </span>
          }
          actions={
            <span className="fw-q-actions">
              {primary}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span className="fw-q-hide-phone">{t('record.dock')}</span>
                  <span className="fw-q-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        {/* Identity and state on their own row under the title (it wraps on a phone; the DS header's title row does not). */}
        <div className="fw-q-meta-row">
          <span className="fw-q-meta">
            <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
            <Tag tone="neutral">{t('record.versionChip', { revision: quote.currentRevision })}</Tag>
            {validity !== null && <Tag tone={validity < 0 ? 'danger' : validity <= 7 ? 'warning' : 'info'}>{validity < 0 ? t('record.validEnded') : t('record.validLeft', { count: validity })}</Tag>}
            {quote.contact && <span className="fw-q-hint">{quote.contact.name}</span>}
          </span>
          {saveWords}
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

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
      {status === 'PENDING_APPROVAL' && pendingRequest && (
        <Banner tone="warning" title={t('record.waitingApproval', { reasons: pendingRequest.reasons.map((reason) => t(`reason.${reason}`)).join(' · ') })}>
          {pendingRequest.createdById === model.me ? t('record.waitingYours') : t('record.waitingWho')}
        </Banner>
      )}
      {status === 'ACCEPTED' && <Banner tone="success" title={t('record.accepted')} />}
      {readOnly && (model.tab === 'lines' || model.tab === 'terms') && status !== 'PENDING_APPROVAL' && (
        <Banner tone="info" title={<span className="fw-q-inline"><Lock size={14} aria-hidden /> {t(readOnly, { revision: quote.currentRevision, next: quote.currentRevision + 1, date: quote.current.validUntil ? formatDate(quote.current.validUntil, { locale }) : '—' })}</span>} />
      )}

      <div className={showDock ? 'fw-q-body has-dock' : 'fw-q-body'}>
        <div className="fw-q-main">
          {model.tab === 'lines' && <LinesTab quote={quote} model={model} actions={actions} step={step} />}
          {model.tab === 'price' && <PriceTab quote={quote} model={model} />}
          {model.tab === 'terms' && <TermsTab quote={quote} model={model} actions={actions} />}
          {model.tab === 'versions' && <VersionsTab quote={quote} model={model} actions={actions} />}
          {model.tab === 'approval' && <ApprovalTab quote={quote} model={model} actions={actions} />}
          {model.tab === 'documents' && <DocumentsTab quote={quote} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-q-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-q-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <QuoteDialogs quote={quote} model={model} actions={actions} />
      {model.send && <DocumentSendView open model={model.send} actions={sendActions} />}
    </div>
  )
}
