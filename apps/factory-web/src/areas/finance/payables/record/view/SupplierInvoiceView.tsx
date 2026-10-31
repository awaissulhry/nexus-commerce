'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, CreditCard, ExternalLink, FileX, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { dayInstant } from '../../../_shared/model'
import type { SupplierInvoice } from '../../api'
import { actionHeld, MATCH_TONE, PAYABLES_NAMESPACE, RECORD_TABS, STATUS_TONE, xmlHref, type Phrase, type RecordTab } from '../../model'
import type { SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'
import { RecordDialogs } from './Dialogs'
import { approveHeldOf, ApprovalTab, LinesTab, MatchTab, PaymentTab } from './RecordTabs'
import '../../payables.css'
import '../../../_shared/finance.css'

export type { SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'

/**
 * SCR-153 — a supplier invoice's record (design finance.payables "Record: Supplier invoice", `/finance/payables/<id>?tab=…`;
 * 00 §2.2: the tabs always in view). The band: ‹ Supplier invoices, "<number> · <supplier>", its state, the match in words,
 * where it came from (SDI · e-mail · typed), the next step as the primary (Approve — held with the reason in words, e.g.
 * "You entered this invoice, so someone else approves it" —; Mark paid once approved), "As received" (the XML and PDF in a
 * new tab), the thread (⌘J), ⋯ (Match again, Send to buyer, Reject with reason, Reopen, Withdraw approval, Void a typed one,
 * Copy number). Tabs: Lines (mapped to PO lines, autosave per cell), Match (MatchPanel), Approval, Payment, Activity (the
 * record panels; beside any tab on a wide screen with ⌘J). Keys: a approves (held when you entered it), ⌘J the thread.
 */
export function SupplierInvoiceView({ model, actions, panels }: { model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={[PAYABLES_NAMESPACE, 'lists', 'records']}>
      <Record model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function Record({ model, actions, panels }: { model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; panels?: ReactNode }) {
  const t = useT(PAYABLES_NAMESPACE)
  const listHref = `${model.prefix}/finance/payables`
  if (!model.can.view) {
    return (
      <div className="fw-fpy">
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }
  const loaded = model.invoice
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fpy">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
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
      </div>
    )
  }
  return <Ready invoice={loaded.value} model={model} actions={actions} panels={panels} />
}

function Ready({ invoice, model, actions, panels }: { invoice: SupplierInvoice; model: SupplierInvoiceModel; actions?: SupplierInvoiceActions; panels?: ReactNode }) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const recordHref = `${model.prefix}/finance/payables/${invoice.id}`
  const can = model.can
  const words = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const approveHeld = approveHeldOf(invoice, model)
  const payHeld: Phrase | null = !can.pay ? { key: 'held.pay' } : actionHeld(invoice, 'pay')
  const manage = (action: 'dispute' | 'reopen' | 'void' | 'map'): Phrase | null => (!can.manage ? { key: 'held.manage' } : actionHeld(invoice, action))
  const outside = invoice.matches.some((entry) => entry.verdict !== 'WITHIN' && !entry.accepted)

  // Keys: ⌘J the thread; a approves (held when you entered it; never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (typing || target?.closest('[role="dialog"], [role="menu"]') || model.dialog || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'a' && invoice.status === 'RECEIVED' && !approveHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'approve', note: '' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const tabs: TabItem[] = RECORD_TABS.map((tab: RecordTab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      (tab === 'match' && outside) || (tab === 'approval' && invoice.status === 'RECEIVED' && invoice.approval.ready) ? (
        <span className="fw-fin-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-fin-dot" aria-label={t(tab === 'match' ? 'tab.differences' : 'tab.ready')} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
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

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const day = (value: string) => formatDate(dayInstant(value), { locale })

  return (
    <div className="fw-fpy">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/finance/payables`}>{t('record.back')}</Link>}
          title={
            <span className="fw-fin-title">
              {invoice.number} <span className="fw-fin-title-sub">· {invoice.supplier.name}</span>
            </span>
          }
          actions={
            <span className="fw-fin-actions">
              {primary}
              <Button size="sm" asChild>
                <Link href={xmlHref(model.prefix, invoice.id)} target="_blank" rel="noopener">
                  <ExternalLink size={14} aria-hidden /> <span>{t('record.asReceived')}</span>
                </Link>
              </Button>
              {activity && (
                <Button
                  size="sm"
                  variant={model.dockOpen ? 'tonal' : 'secondary'}
                  active={model.dockOpen}
                  aria-pressed={model.dockOpen}
                  onClick={() => actions?.onDock?.()}
                  title={t('record.dockHint')}
                >
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-fin-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-fin-meta-row">
          <span className="fw-fin-meta">
            <Pill tone={STATUS_TONE[invoice.status]}>{t(`status.${invoice.status}`)}</Pill>
            <Pill tone={MATCH_TONE[invoice.matchStatus]}>{t(`match.${invoice.matchStatus}`)}</Pill>
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
          </span>
          <span className="fw-fin-status" role="status">
            {t(`live.${model.live}`)}
          </span>
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
      {!can.manage && !can.approve && !can.pay && !can.accept && <Banner tone="info" title={t('record.readOnly')} />}

      <div className={showDock ? 'fw-fin-body has-dock' : 'fw-fin-body'}>
        <div className="fw-fin-main">
          {model.tab === 'lines' && <LinesTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'match' && <MatchTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'approval' && <ApprovalTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'payment' && <PaymentTab invoice={invoice} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-fpy-muted">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-fin-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <RecordDialogs invoice={invoice} model={model} actions={actions} />
    </div>
  )
}
