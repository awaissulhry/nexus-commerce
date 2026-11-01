'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Mail, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Invoice } from '../../../_shared/api'
import { creditHeld, dayInstant, journeyOf, nextStepOf, PAY_TONE, payStateOf, SDI_TONE, sdiCodeOf, STATUS_TONE, dueDateOf, type JourneyStep } from '../../../_shared/model'
import { JourneyStrip } from '../../../_shared/parts'
import { refundHref, xmlHref } from '../../daily/model'
import { RECORD_TABS, type InvoiceRecordActions, type InvoiceRecordModel, type RecordTab } from '../record-model'
import { InvoiceDialogs } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { MoneyTab } from './MoneyTab'
import { SdiTab } from './SdiTab'
import '../../../_shared/finance.css'

export type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

/**
 * SCR-081 — the invoice record (design finance.invoices "Record: Invoice"; 00 §2.2; Owner L1: the tabs always in view).
 * The band: ‹ Invoices, "<number or Draft> · <customer>", the type in words with its code, the state, where it is at SDI
 * and whether it is paid, the journey (Draft → Checks → Issued → SDI → Delivered → Paid), the next step by state as the
 * primary (a draft: Check and issue, held until the checks pass; issued: Send to SDI; rejected: Fix and resend with the
 * same number and date; delivered and open: Record payment), Send copy when SDI could not deliver it, the thread (⌘J),
 * ⋯. Tabs: Lines & VAT (the checks before issue, the lines with the VAT in words, the totals bridge), Deposits &
 * payments, SDI status (the timeline in words, the rejection and its fix), Documents (the legal XML, the courtesy PDF,
 * the DDTs), Activity (the record panels; beside any tab on a wide screen with ⌘J). An issued invoice never changes.
 */
export function InvoiceRecordView({ model, actions, panels }: { model: InvoiceRecordModel; actions?: InvoiceRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', 'lists', 'records']}>
      <InvoiceRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function InvoiceRecord({ model, actions, panels }: { model: InvoiceRecordModel; actions?: InvoiceRecordActions; panels?: ReactNode }) {
  const t = useT('finance')
  const listHref = `${model.prefix}/finance/invoices`
  const loaded = model.invoice
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fin">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fin-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-fin-stack">
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
  return <ReadyRecord invoice={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyRecord({ invoice, model, actions, panels }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions; panels?: ReactNode }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const recordHref = `${model.prefix}/finance/invoices/${invoice.id}`
  const checks = model.checks?.value ?? null
  const sdi = model.sdi?.value ?? null
  const step = nextStepOf(invoice, sdi, model.can, checks)
  const stepHeld = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null
  const payHref = `${model.prefix}/finance/payments?new=1&invoice=${invoice.id}`
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')

  // Keys: ⌘J the thread; ⌘↵ the next step (never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (target?.closest('[role="dialog"]') || model.dialog) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && !stepHeld) {
        event.preventDefault()
        if (step.kind === 'recordPayment') window.location.assign(payHref)
        else actions?.onDialog?.({ kind: step.kind === 'issue' ? 'issue' : step.kind === 'fix' ? 'fix' : 'send' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const rejected = invoice.status === 'REJECTED'
  const tabs: TabItem[] = RECORD_TABS.map((tab: RecordTab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      tab === 'sdi' && rejected ? (
        <span className="fw-fin-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-fin-dot" aria-label={t('tab.rejected')} role="img" />
        </span>
      ) : tab === 'lines' && invoice.status === 'DRAFT' && checks && !checks.ready ? (
        <span className="fw-fin-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-fin-dot" aria-label={t('tab.checksFail')} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tab === 'lines' ? invoice.lines.length : tab === 'money' ? (model.related.value ? model.related.value.payments.length + model.related.value.depositRequests.length : null) : null,
  }))

  const primaryLabel = step.kind ? t(`step.${step.kind}`) : null
  const primary =
    step.kind === 'recordPayment' ? (
      stepHeld ? (
        <Button size="sm" variant="primary" heldReason={stepHeld}>
          {primaryLabel}
        </Button>
      ) : (
        <Button size="sm" variant="primary" asChild aria-keyshortcuts="Meta+Enter Control+Enter">
          <Link href={payHref}>{primaryLabel}</Link>
        </Button>
      )
    ) : step.kind ? (
      <Button size="sm" variant="primary" heldReason={stepHeld} onClick={() => actions?.onDialog?.({ kind: step.kind === 'issue' ? 'issue' : step.kind === 'fix' ? 'fix' : 'send' })} aria-keyshortcuts="Meta+Enter Control+Enter">
        {primaryLabel}
      </Button>
    ) : null

  const draft = invoice.status === 'DRAFT'
  const creditWait = creditHeld(invoice, model.can)
  // B-W2a-80: an issued credit note is refunded from Finance › Payments (the ONE Refund dialog, preset with it).
  const refundable = invoice.docType === 'TD04' && !draft && invoice.status !== 'REJECTED'
  const more: MenuItemDef[] = [
    ...(invoice.xmlFileId ? [{ id: 'xml-view', label: d('xml.open'), href: xmlHref(model.prefix, invoice.id), target: '_blank' as const }] : []),
    ...(invoice.xmlFileId ? [{ id: 'xml', label: t('action.downloadXml'), onSelect: () => actions?.onDownload?.(invoice.xmlFileId!) }] : []),
    ...(invoice.pdfFileId ? [{ id: 'pdf', label: t('action.downloadPdf'), onSelect: () => actions?.onDownload?.(invoice.pdfFileId!) }] : []),
    ...(invoice.filesPending && model.can.issueInvoices ? [{ id: 'files', label: t('action.makeFiles'), onSelect: () => actions?.onMakeFiles?.() }] : []),
    ...(!draft && invoice.docType !== 'TD04' ? [{ id: 'credit', label: t('action.creditNote'), disabled: !!creditWait, description: creditWait ? t(creditWait.key) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'credit' }) }] : []),
    ...(draft ? [{ id: 'delete', label: t('action.deleteDraft'), tone: 'danger' as const, disabled: !model.can.manageInvoices, description: model.can.manageInvoices ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'delete' }) }] : []),
    ...(invoice.number
      ? [
          {
            id: 'copy',
            label: t('action.copyNumber'),
            onSelect: () => {
              void navigator.clipboard?.writeText(invoice.number!).catch(() => undefined)
            },
          },
        ]
      : []),
  ]

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const pay = payStateOf({ ...invoice, dueDate: dueDateOf(invoice) }, model.today)
  const sdiCode = sdi?.state.code ?? sdiCodeOf(invoice.status)
  const journeyWords = (journey: JourneyStep): string => {
    if (journey.key === 'issued' && invoice.number) return t('journey.issuedNumber', { number: invoice.number })
    if (journey.key === 'delivered' && journey.state === 'problem') return t('journey.notDelivered')
    if (journey.key === 'sdi' && invoice.status === 'REJECTED') return t('journey.rejected')
    return t(`journey.${journey.key}`)
  }
  const orders = model.related.value?.orders ?? []
  const copyWanted = sdi?.state.next.action === 'CHECK_COPY'

  return (
    <div className="fw-fin">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/finance/invoices`}>{t('record.back')}</Link>}
          title={
            <span className="fw-fin-title">
              {invoice.number ?? t('record.draftTitle', { type: t(`docType.${invoice.docType}`) })} <span className="fw-fin-title-sub">· {invoice.party.legalName}</span>
            </span>
          }
          actions={
            <span className="fw-fin-actions">
              {primary}
              {refundable &&
                (model.can.viewPayments ? (
                  <Button size="sm" asChild>
                    <Link href={refundHref(model.prefix, invoice.id)}>{d('refundLink.go')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" heldReason={d('refundLink.noRight')}>
                    {d('refundLink.go')}
                  </Button>
                ))}
              {copyWanted && activity && (
                <Button size="sm" heldReason={model.can.email ? null : t('held.noEmail')} onClick={() => actions?.onDock?.()} title={t('record.sendCopyHint')}>
                  <Mail size={14} aria-hidden /> <span>{t('action.sendCopy')}</span>
                </Button>
              )}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-fin-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              {more.length > 0 && <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />}
            </span>
          }
        />
        <div className="fw-fin-meta-row">
          <span className="fw-fin-meta">
            <Tag tone="neutral">{t('record.typeChip', { type: t(`docType.${invoice.docType}`), code: invoice.docType })}</Tag>
            {draft ? <Pill tone={STATUS_TONE[invoice.status]}>{t(`invoiceStatus.${invoice.status}`)}</Pill> : <Pill tone={SDI_TONE[sdiCode]}>{t(`sdi.state.${sdiCode}`)}</Pill>}
            {model.can.price && pay && pay.state !== 'NONE' && <Pill tone={PAY_TONE[pay.state]}>{t(`pay.${pay.state}`, { count: pay.days })}</Pill>}
            {rejected && sdi?.deadline && <Pill tone="danger">{t(sdi.deadline.overdue ? 'record.resendOverdue' : 'record.resendBy', { date: day(sdi.deadline.deadline), count: sdi.deadline.workingDaysLeft })}</Pill>}
            {draft && invoice.deadline && (
              <Pill tone={invoice.deadline.state === 'LATE' ? 'danger' : invoice.deadline.state === 'DUE_SOON' ? 'warning' : 'neutral'}>
                {d(invoice.deadline.state === 'LATE' ? 'deferred.issueLate' : 'deferred.issueBy', { date: day(invoice.deadline.dueBy), count: Math.abs(invoice.deadline.daysLeft), type: invoice.deadline.docType })}
              </Pill>
            )}
            {invoice.issueDate && <span className="fw-fin-hint">{t('record.issuedOn', { date: day(invoice.issueDate) })}</span>}
            {hasRecordPage('Party', OFFICE_PAGES) && model.can.viewParties ? (
              <Link className="fw-fin-link fw-fin-hint" href={`${model.prefix}${recordAddress({ type: 'Party', id: invoice.buyerPartyId }, OFFICE_PAGES)}`}>
                {invoice.party.legalName}
              </Link>
            ) : null}
            {orders.map((order) =>
              model.can.viewOrders && hasRecordPage('SalesOrder', OFFICE_PAGES) ? (
                <Link key={order.id} className="fw-fin-link fw-fin-hint" href={`${model.prefix}${recordAddress({ type: 'SalesOrder', id: order.id }, OFFICE_PAGES)}`}>
                  {t('record.order', { number: order.number })}
                </Link>
              ) : (
                <span key={order.id} className="fw-fin-hint">
                  {t('record.order', { number: order.number })}
                </span>
              ),
            )}
          </span>
          <span className="fw-fin-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <JourneyStrip steps={journeyOf(invoice, checks)} words={journeyWords} />
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
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {!model.can.manageInvoices && !model.can.issueInvoices && !model.can.recordPayments && <Banner tone="info" title={t('record.readOnly')} />}

      <div className={showDock ? 'fw-fin-body has-dock' : 'fw-fin-body'}>
        <div className="fw-fin-main">
          {model.tab === 'lines' && <LinesTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'money' && <MoneyTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'sdi' && <SdiTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'documents' && <DocumentsTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-fin-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-fin-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <InvoiceDialogs invoice={invoice} model={model} actions={actions} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}
