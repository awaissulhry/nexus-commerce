'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Mail, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Invoice } from '../../../_shared/api'
import { creditHeld, dayInstant, journeyOf, nextStepOf, PAY_TONE, payStateOf, SDI_TONE, sdiCodeOf, STATUS_TONE, dueDateOf, type JourneyStep } from '../../../_shared/model'
import { JourneyStrip } from '../../../_shared/parts'
import { refundHref, xmlHref } from '../../daily/model'
import { RECORD_TABS, type InvoiceDepthSlots, type InvoiceRecordActions, type InvoiceRecordModel, type RecordTab } from '../record-model'
import { DEPTH } from '../../test-mode/depth'
import { InvoiceDialogs } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { MoneyTab } from './MoneyTab'
import { SdiTab } from './SdiTab'
import '../../../_shared/finance.css'
// ---- B-TH-268: the invoice on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame, useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { InvoiceDepthSlots, InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

/**
 * SCR-081 — the invoice record (design finance.invoices "Record: Invoice"), on RecordFrame (B-TH-268; the rule of picture 38, the tabs
 * of 08-tabs O-FIN-INV): the band in the shell's band row (‹ Invoices, "<number or Draft> · <customer>", ONE pill — a draft's state,
 * else where it is at SDI —, in its details the type in words with its code, whether it is paid, SDI's deadline to resend, the
 * customer and its orders; the next step by state as the primary — a draft: Check and issue, held until the checks pass; issued:
 * Send to SDI; rejected: Fix and resend with the same number and date; delivered and open: Record payment —; the Thread button ⌘J,
 * the frame's; ⋯ the files, the credit note, the debit note, Delete a draft, Copy number, its Keyboard line), the docked thread
 * beside every tab (the customer's own; Activity's tools in its "⋯", R-ACT), the journey (Draft → Checks → Issued → SDI → Delivered
 * → Paid) above the tabs 5 → 3: Lines & VAT (the checks before issue, the lines with the VAT in words, the totals bridge), Deposits
 * & payments, SDI & documents (the timeline in words, the rejection and its fix, then the legal XML, the courtesy PDF, the DDTs and
 * the copies e-mailed — Make the files when they are pending). Every banner in the ONE notice of the body column; when SDI could
 * not deliver it, the notice offers Send copy (the thread, to the customer). An issued invoice never changes.
 */
// B-TH-268: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function InvoiceRecordView({ model, actions, thread, printThread, depth }: { model: InvoiceRecordModel; actions?: InvoiceRecordActions; thread?: ReactNode; printThread?: ReactNode; /** B-W2b-417. */ depth?: InvoiceDepthSlots }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily', DEPTH, 'lists', 'records']}>
      <InvoiceRecord model={model} actions={actions} thread={thread} printThread={printThread} depth={depth} />
    </WithMessages>
  )
}

function InvoiceRecord({ model, actions, thread, printThread, depth }: { model: InvoiceRecordModel; actions?: InvoiceRecordActions; thread?: ReactNode; printThread?: ReactNode; depth?: InvoiceDepthSlots }) {
  const t = useT('finance')
  const listHref = `${model.prefix}/finance/invoices`
  const loaded = model.invoice
  if (loaded.status !== 'ready') {
    // B-TH-268: loading, a failed read, not found and no right inside the frame, with no thread.
    return (
      <RecordFrame
        recordType="Invoice"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
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
      </RecordFrame>
    )
  }
  return <ReadyRecord invoice={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} depth={depth} />
}

function ReadyRecord({ invoice, model, actions, thread, printThread, depth }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions; thread?: ReactNode; printThread?: ReactNode; depth?: InvoiceDepthSlots }) {
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

  // Keys: ⌘↵ the next step (never while typing or inside a dialog, nor from inside the docked thread, whose ⌘↵ sends); ⌘J is the
  // frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if (target?.closest('[role="dialog"], .fw-rcf-dock') || model.dialog) return
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
  // B-TH-268: the merged tab says both its jobs ("SDI & documents"; R-6); its address stays `sdi`.
  const tabWords = (tab: RecordTab) => t(tab === 'sdi' ? 'tab.sdiDocuments' : `tab.${tab}`)
  const tabs: TabItem[] = RECORD_TABS.map((tab: RecordTab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      tab === 'sdi' && rejected ? (
        <span className="fw-fin-tablabel">
          {tabWords(tab)}
          <span className="fw-fin-dot" aria-label={t('tab.rejected')} role="img" />
        </span>
      ) : tab === 'lines' && invoice.status === 'DRAFT' && checks && !checks.ready ? (
        <span className="fw-fin-tablabel">
          {tabWords(tab)}
          <span className="fw-fin-dot" aria-label={t('tab.checksFail')} role="img" />
        </span>
      ) : (
        tabWords(tab)
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
    // B-W2b-417: Debit note (an issued TD01/TD24).
    ...(depth?.more ?? []),
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
    <>
      <RecordFrame
        recordType="Invoice"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={`${model.prefix}/finance/invoices`}>{t('record.back')}</Link>,
          title: (
            <span className="fw-fin-title">
              {invoice.number ?? t('record.draftTitle', { type: t(`docType.${invoice.docType}`) })} <span className="fw-fin-title-sub">· {invoice.party.legalName}</span>
            </span>
          ),
          // ONE pill: a draft's state, else where it is at SDI.
          status: draft ? <Pill tone={STATUS_TONE[invoice.status]}>{t(`invoiceStatus.${invoice.status}`)}</Pill> : <Pill tone={SDI_TONE[sdiCode]}>{t(`sdi.state.${sdiCode}`)}</Pill>,
          meta: (
            <>
              <Tag tone="neutral">{t('record.typeChip', { type: t(`docType.${invoice.docType}`), code: invoice.docType })}</Tag>
              {model.can.price && pay && pay.state !== 'NONE' && <Tag tone={PAY_TONE[pay.state]}>{t(`pay.${pay.state}`, { count: pay.days })}</Tag>}
              {rejected && sdi?.deadline && <Tag tone="danger">{t(sdi.deadline.overdue ? 'record.resendOverdue' : 'record.resendBy', { date: day(sdi.deadline.deadline), count: sdi.deadline.workingDaysLeft })}</Tag>}
              {draft && invoice.deadline && (
                <Tag tone={invoice.deadline.state === 'LATE' ? 'danger' : invoice.deadline.state === 'DUE_SOON' ? 'warning' : 'neutral'}>
                  {d(invoice.deadline.state === 'LATE' ? 'deferred.issueLate' : 'deferred.issueBy', { date: day(invoice.deadline.dueBy), count: Math.abs(invoice.deadline.daysLeft), type: invoice.deadline.docType })}
                </Tag>
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
              <span className="fw-fin-status" role="status">
                {t(`live.${model.live}`)}
              </span>
            </>
          ),
          primary:
            primary || refundable ? (
              <span className="fw-fin-actions">
                {primary}
                {/* B-W2a-80: an issued credit note is refunded from Finance › Payments (the ONE Refund dialog, preset with it). */}
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
              </span>
            ) : undefined,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <JourneyStrip steps={journeyOf(invoice, checks)} words={journeyWords} />
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-268: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {/* B-W2b-417: the test-mode banner. */}
          {depth?.banner}
          {/* SDI could not deliver it: the customer gets a copy from the thread (its "Reply to", with the courtesy PDF). */}
          {copyWanted && thread && <SendCopyNotice can={model.can.email} />}
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
        </RecordNotices>

        <div className="fw-fin-main">
          {model.tab === 'lines' && <LinesTab invoice={invoice} model={model} actions={actions} depth={depth} />}
          {model.tab === 'money' && <MoneyTab invoice={invoice} model={model} actions={actions} depth={depth} />}
          {/* B-TH-268: SDI & documents — where it is at SDI, then its files (both tabs' work, in that order). */}
          {model.tab === 'sdi' && (
            <div className="fw-fin-stack">
              <SdiTab invoice={invoice} model={model} actions={actions} />
              <DocumentsTab invoice={invoice} model={model} actions={actions} />
            </div>
          )}
        </div>
      </RecordFrame>

      <InvoiceDialogs invoice={invoice} model={model} actions={actions} depth={depth} />
      {depth?.dialogs}
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
    </>
  )
}

/**
 * B-TH-268: when SDI could not deliver the invoice, the notice says so and Send copy shows the docked thread (the frame's showThread),
 * where "Reply to <the customer>" e-mails the copy with the courtesy PDF attached (held without the e-mail right). Docked: the thread
 * shows; narrower: it opens full width (Back returns to the tab).
 */
function SendCopyNotice({ can }: { can: boolean }) {
  const t = useT('finance')
  const frame = useRecordFrame()
  const show = () => frame?.showThread?.()
  return (
    <Banner
      tone="warning"
      title={t('record.sendCopyNotice')}
      action={
        <Button size="sm" heldReason={can ? null : t('held.noEmail')} onClick={show} title={t('record.sendCopyHint')}>
          <Mail size={14} aria-hidden /> <span>{t('action.sendCopy')}</span>
        </Button>
      }
    />
  )
}
