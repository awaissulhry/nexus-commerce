'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, CreditCard, ExternalLink, FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import type { SupplierInvoice } from '../../api'
import { actionHeld, MATCH_TONE, PAYABLES_NAMESPACE, RECORD_TABS, STATUS_TONE, xmlHref, type Phrase, type RecordTab } from '../../model'
import type { SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'
import { RecordDialogs } from './Dialogs'
import { approveHeldOf, ApprovalTab, LinesTab, MatchTab, PaymentTab, type SupplierInvoiceDepth } from './RecordTabs'
import '../../payables.css'
import '../../../_shared/finance.css'
// ---- B-TH-268: the supplier invoice on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'

/**
 * SCR-153 — a supplier invoice's record (design finance.payables "Record: Supplier invoice", `/finance/payables/<id>?tab=…`), on
 * RecordFrame (B-TH-268; the rule of picture 38, the tabs of 08-tabs O-FIN-PAY): the band in the shell's band row (‹ Supplier
 * invoices, "<number> · <supplier>", ONE pill — its state —, in its details the match in words, where it came from (SDI · e-mail ·
 * typed), the dates and the company; the next step as the primary — Approve, held with the reason in words (e.g. "You entered this
 * invoice, so someone else approves it"); Mark paid once approved — beside "As received" (the XML and PDF in a new tab); the Thread
 * button ⌘J, the frame's; ⋯ Match again, Send to buyer, Reject with reason, Reopen, Withdraw approval, Void a typed one, the PDF,
 * Copy number, its Keyboard line with the record's own key "a"), the docked thread beside every tab (the supplier's own; Activity's
 * tools in its "⋯", R-ACT), the tabs 5 → 3: Lines (mapped to PO lines, autosave per cell), Match (MatchPanel), Approval & payment
 * (who approves and why it waits, then when and how it is paid). Every banner in the ONE notice of the body column.
 */
// B-TH-268: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function SupplierInvoiceView({ model, actions, thread, printThread, depth }: { model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; thread?: ReactNode; printThread?: ReactNode; /** B-W2b-425: the area check, dual approval and the payment batch. */ depth?: SupplierInvoiceDepth }) {
  return (
    <WithMessages namespaces={[PAYABLES_NAMESPACE, 'lists', 'records']}>
      <Record model={model} actions={actions} thread={thread} printThread={printThread} depth={depth} />
    </WithMessages>
  )
}

function Record({ model, actions, thread, printThread, depth }: { model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; thread?: ReactNode; printThread?: ReactNode; depth?: SupplierInvoiceDepth }) {
  const t = useT(PAYABLES_NAMESPACE)
  const listHref = `${model.prefix}/finance/payables`
  // B-TH-268: no right, loading, a failed read and not found inside the frame, with no thread.
  const frame = (title: ReactNode, body: ReactNode) => (
    <RecordFrame recordType="SupplierInvoice" personId={model.personId ?? null} band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {body}
    </RecordFrame>
  )
  if (!model.can.view) return frame(t('record.title'), <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />)
  const loaded = model.invoice
  if (loaded.status !== 'ready') {
    return frame(
      loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'),
      <>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fpy-muted" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-fpy-stack">
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
      </>,
    )
  }
  return <Ready invoice={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} depth={depth} />
}

function Ready({ invoice, model, actions, thread, printThread, depth }: { invoice: SupplierInvoice; model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; thread?: ReactNode; printThread?: ReactNode; depth?: SupplierInvoiceDepth }) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const recordHref = `${model.prefix}/finance/payables/${invoice.id}`
  const can = model.can
  const words = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const approveHeld = approveHeldOf(invoice, model)
  const payHeld: Phrase | null = !can.pay ? { key: 'held.pay' } : actionHeld(invoice, 'pay')
  const manage = (action: 'dispute' | 'reopen' | 'void' | 'map'): Phrase | null => (!can.manage ? { key: 'held.manage' } : actionHeld(invoice, action))
  const outside = invoice.matches.some((entry) => entry.verdict !== 'WITHIN' && !entry.accepted)

  // Keys: a approves (held when you entered it; never while typing, inside a dialog or a menu, nor from inside the docked thread, whose
  // own single keys answer there); ⌘J is the frame's (the thread). "a" is listed in the frame's ONE Keyboard window (band.keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if (typing || target?.closest('[role="dialog"], [role="menu"], .fw-rcf-dock') || model.dialog || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'a' && invoice.status === 'RECEIVED' && !approveHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'approve', note: '' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // B-TH-268: the merged tab says both its jobs ("Approval & payment"; R-6); its address stays `approval`.
  const tabWords = (tab: RecordTab) => t(tab === 'approval' ? 'tab.approvalPayment' : `tab.${tab}`)
  const tabs: TabItem[] = RECORD_TABS.map((tab: RecordTab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      (tab === 'match' && outside) || (tab === 'approval' && invoice.status === 'RECEIVED' && invoice.approval.ready) ? (
        <span className="fw-fin-tablabel">
          {tabWords(tab)}
          <span className="fw-fin-dot" aria-label={t(tab === 'match' ? 'tab.differences' : 'tab.ready')} role="img" />
        </span>
      ) : (
        tabWords(tab)
      ),
    count: tab === 'lines' ? invoice.lines.length : tab === 'match' ? invoice.matches.length : null,
  }))

  const primary =
    invoice.status === 'RECEIVED' ? (
      <Button size="sm" variant="primary" heldReason={words(approveHeld)} onClick={() => actions?.onDialog?.({ kind: 'approve', note: '' })} aria-keyshortcuts="a">
        <CheckCheck size={14} aria-hidden /> {t('approval.approve')}
      </Button>
    ) : invoice.status === 'APPROVED' ? (
      <Button size="sm" variant="primary" heldReason={words(payHeld) ?? (model.busy ? t('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'pay', paidOn: model.today, paymentRef: '' })}>
        <CreditCard size={14} aria-hidden /> {t('payment.markPaid')}
      </Button>
    ) : null

  const item = (id: string, label: string, held: Phrase | null, onSelect: () => void, tone?: 'danger'): MenuItemDef => ({
    id,
    label,
    disabled: !!held,
    description: words(held) ?? undefined,
    onSelect,
    ...(tone ? { tone } : {}),
  })
  const more: MenuItemDef[] = [
    ...(invoice.matches.some((entry) => entry.stale) ? [item('match', t('match.again'), manage('map'), () => actions?.onMatchAgain?.())] : []),
    ...(outside ? [item('buyer', t('match.sendToBuyer'), manage('map'), () => actions?.onDialog?.({ kind: 'sendToBuyer', message: '' }))] : []),
    ...(invoice.status === 'RECEIVED' ? [item('dispute', t('approval.reject'), manage('dispute'), () => actions?.onDialog?.({ kind: 'dispute', reason: '' }))] : []),
    ...(invoice.status === 'DISPUTED' ? [item('reopen', t('approval.reopen'), manage('reopen'), () => actions?.onDialog?.({ kind: 'reopen', reason: '' }))] : []),
    ...(invoice.status === 'APPROVED'
      ? [item('withdraw', t('approval.withdraw'), !can.approve ? { key: 'held.approve' } : actionHeld(invoice, 'withdraw'), () => actions?.onDialog?.({ kind: 'withdraw', reason: '' }))]
      : []),
    ...(invoice.source !== 'SDI' && (invoice.status === 'RECEIVED' || invoice.status === 'DISPUTED')
      ? [item('void', t('record.void'), manage('void'), () => actions?.onDialog?.({ kind: 'void', reason: '' }), 'danger')]
      : []),
    ...(invoice.files.pdf ? [{ id: 'pdf', label: t('record.downloadPdf'), onSelect: () => actions?.onDownload?.(invoice.files.pdf!.id) }] : []),
    {
      id: 'copy',
      label: t('record.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(invoice.number).catch(() => undefined)
      },
    },
  ]

  const day = (value: string) => formatDate(dayInstant(value), { locale })

  return (
    <>
      <RecordFrame
        recordType="SupplierInvoice"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={`${model.prefix}/finance/payables`}>{t('record.back')}</Link>,
          title: (
            <span className="fw-fin-title">
              {invoice.number} <span className="fw-fin-title-sub">· {invoice.supplier.name}</span>
            </span>
          ),
          // ONE pill: its state; the match in words travels with the identity (a Tag of its tone).
          status: <Pill tone={STATUS_TONE[invoice.status]}>{t(`status.${invoice.status}`)}</Pill>,
          meta: (
            <>
              <Tag tone={MATCH_TONE[invoice.matchStatus]}>{t(`match.${invoice.matchStatus}`)}</Tag>
              <Tag tone={invoice.source === 'SDI' ? 'info' : 'neutral'}>{t(`source.${invoice.source}`)}</Tag>
              {invoice.kind === 'CREDIT_NOTE' && <Tag tone="neutral">{t('kind.CREDIT_NOTE')}</Tag>}
              {invoice.docType && <span className="fw-fpy-muted fw-fpy-code">{invoice.docType}</span>}
              <span className="fw-fpy-muted">{t('record.dates', { issued: day(invoice.issueDate), received: day(invoice.receivedOn) })}</span>
              <span className="fw-fpy-muted">{invoice.company.name}</span>
              {invoice.creditOf && (
                <Link className="fw-fpy-link fw-fpy-muted" href={`${model.prefix}/finance/payables/${invoice.creditOf.id}`}>
                  {t('record.creditOf', { number: invoice.creditOf.number })}
                </Link>
              )}
              <span className="fw-fin-status" role="status">
                {t(`live.${model.live}`)}
              </span>
            </>
          ),
          primary: (
            <span className="fw-fin-actions">
              {primary}
              <Button size="sm" asChild>
                <Link href={xmlHref(model.prefix, invoice.id)} target="_blank" rel="noopener">
                  <ExternalLink size={14} aria-hidden /> <span>{t('record.asReceived')}</span>
                </Link>
              </Button>
            </span>
          ),
          more,
          moreLabel: t('record.more'),
          // PR-14: the record's own key in the frame's ONE Keyboard window.
          keys: [{ keys: ['A'], label: t('keys.approve') }],
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-268: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {/* End check (B-TH-268): the answer to the person's own action first, as on every other record; the rest behind "N more notices". */}
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={model.notice.phrases.map((phrase) => t(phrase.key, phrase.params)).join(' ')}
              action={
                actions?.onDismissNotice ? (
                  <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                    {t('common.dismiss')}
                  </Button>
                ) : undefined
              }
            />
          )}
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
          {!can.manage && !can.approve && !can.pay && !can.accept && <Banner tone="info" title={t('record.readOnly')} />}
        </RecordNotices>

        <div className="fw-fin-main">
          {model.tab === 'lines' && <LinesTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'match' && <MatchTab invoice={invoice} model={model} actions={actions} depth={depth} />}
          {/* B-TH-268: Approval & payment — who approves and why it waits, then when and how it is paid (both tabs' work, in that order). */}
          {model.tab === 'approval' && (
            <div className="fw-fpy-stack">
              <ApprovalTab invoice={invoice} model={model} actions={actions} depth={depth} />
              <PaymentTab invoice={invoice} model={model} actions={actions} depth={depth} />
            </div>
          )}
        </div>
      </RecordFrame>

      <RecordDialogs invoice={invoice} model={model} actions={actions} />
    </>
  )
}
