'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, FileX, MessageSquare, MoreHorizontal, Send, ShieldOff, Undo2, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import type { Claim } from '../../api'
import { actHeld, answerDraftOf, goodsDraftOf, KIND_TONE, otherActs, primaryAct, RECORD_TABS, say, sendDraftOf, STATUS_TONE, type ClaimAct, type ClaimDialog, type ClaimRecordActions, type ClaimRecordModel } from '../../model'
import { ClaimDialogs } from './ClaimDialogs'
import { ClaimTab } from './ClaimTab'
import { CreditTab, GoodsTab } from './GoodsCreditTabs'
import '../../../../_shared/buying/buying.css'
import '../../claims.css'

export type { ClaimRecordActions, ClaimRecordModel } from '../../model'

const ACT_ICON = { send: Send, answer: CheckCircle2, returnGoods: Undo2, close: CheckCircle2, cancel: XCircle, removeLines: XCircle } as const

/** The dialog an act opens, fresh. */
export function dialogFor(act: ClaimAct, claim: Claim): ClaimDialog {
  switch (act) {
    case 'send':
      return { kind: 'send', draft: sendDraftOf(claim) }
    case 'answer':
      return { kind: 'answer', draft: answerDraftOf(claim) }
    case 'returnGoods':
      return { kind: 'returnGoods', draft: goodsDraftOf(claim) }
    case 'close':
      return { kind: 'close', note: '' }
    case 'cancel':
      return { kind: 'cancel', reason: '' }
    case 'removeLines':
      return { kind: 'removeLines', lineIds: [] }
  }
}

/**
 * SCR-131 — a supplier claim (design purchasing.claims "Record: Supplier claim", `?tab=claim|goods|credit|activity`):
 * the band (‹ Returns & claims, "<number> · <supplier>", kind and state, the main act by state — Send, Record the
 * supplier's answer, Send the goods back, Close — held with why in words; Thread ⌘J; ⋯ the other acts, the receipt, the
 * order, Copy number), the tabs: Claim (what is wrong and what is asked, saved explicitly; its lines), Goods returned
 * (the return DDTs and the stock moves out), Credit (what is expected, beside the credit note Finance matches), Activity
 * (the thread, files and history). Closed or cancelled: read-only, said in a banner.
 */
export function ClaimRecordView({ model, actions, panels }: { model: ClaimRecordModel; actions?: ClaimRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['purchasing-claims', 'lists', 'records']}>
      <Record model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function Record({ model, actions, panels }: { model: ClaimRecordModel; actions?: ClaimRecordActions; panels?: ReactNode }) {
  const t = useT('purchasing-claims')
  const listHref = `${model.prefix}/purchasing/claims`
  const loaded = model.claim
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-by">
        <div className="fw-by-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-by-stack">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.${loaded.status}.body`)}
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
  return <Ready claim={loaded.value} model={model} actions={actions} panels={panels} />
}

function Ready({ claim, model, actions, panels }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions; panels?: ReactNode }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const href = `${model.prefix}/purchasing/claims/${claim.id}`

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const primary = primaryAct(claim)
  const primaryHeld = primary ? actHeld(claim, primary, model.can) : null
  const others = otherActs(claim, model.can)
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: `${href}?tab=${tab}`,
    label: t(`tab.${tab}`),
    count: tab === 'claim' ? claim.lines.length : tab === 'goods' ? claim.ddts.filter((ddt) => !ddt.cancelled).length : null,
  }))
  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const more = [
    ...others.map((act) => ({ id: act, label: t(`act.${act}`), tone: act === 'cancel' ? ('danger' as const) : undefined, onSelect: () => actions?.onDialog?.(dialogFor(act, claim)) })),
    ...(claim.goodsReceipt ? [{ id: 'receipt', label: t('record.openReceipt', { number: claim.goodsReceipt.number }), href: `${model.prefix}/warehouse/receipts/${claim.goodsReceipt.id}` }] : []),
    ...(claim.purchaseOrder ? [{ id: 'order', label: t('record.openOrder', { number: claim.purchaseOrder.number }), href: `${model.prefix}/purchasing/orders/${claim.purchaseOrder.id}` }] : []),
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopyNumber?.() },
  ]
  const Icon = primary ? ACT_ICON[primary] : null
  const settled = claim.status === 'CLOSED' || claim.status === 'CANCELLED'

  return (
    <div className="fw-by">
      <div className="fw-by-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/purchasing/claims`}>{t('record.back')}</Link>}
          title={
            <span className="fw-by-title">
              {claim.number} <span className="fw-by-title-sub">· {claim.supplier.name}</span>
            </span>
          }
          actions={
            <span className="fw-by-actions">
              {primary && Icon && (
                <Button size="sm" variant="primary" heldReason={primaryHeld ? say(t, primaryHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.(dialogFor(primary, claim))}>
                  <Icon size={14} aria-hidden /> {t(primary === 'send' && claim.status === 'REJECTED' ? 'act.sendAgain' : `act.${primary}`)}
                </Button>
              )}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-by-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-by-meta-row">
          <span className="fw-by-meta">
            <Pill tone={KIND_TONE[claim.kind]}>{t(`kind.${claim.kind}`)}</Pill>
            <Pill tone={STATUS_TONE[claim.status]}>{t(`status.${claim.status}`)}</Pill>
            <span className="fw-by-hint">{[claim.site.code, t(`foundAt.${claim.foundAt}`), t('record.created', { date: formatDate(claim.createdAt, place) })].join(' · ')}</span>
          </span>
          <span className="fw-by-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, place) })}
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
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {settled ? (
        <Banner tone="info" title={claim.status === 'CLOSED' ? t('record.readOnlyClosed', { time: claim.closedAt ? formatDateTime(claim.closedAt, place) : '—' }) : t('record.readOnlyCancelled', { time: claim.cancelledAt ? formatDateTime(claim.cancelledAt, place) : '—' })}>
          {claim.status === 'CLOSED' ? claim.closeNote : claim.cancelReason}
        </Banner>
      ) : (
        !model.can.manage && <Banner tone="info" title={t('record.readOnlyRight', { permission: 'purchasing.claims.manage' })} />
      )}

      <div className={showDock ? 'fw-by-body has-dock' : 'fw-by-body'}>
        <div className="fw-by-main">
          {model.tab === 'claim' && <ClaimTab claim={claim} model={model} actions={actions} />}
          {model.tab === 'goods' && <GoodsTab claim={claim} model={model} actions={actions} />}
          {model.tab === 'credit' && <CreditTab claim={claim} model={model} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-by-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-by-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      {model.dialog && <ClaimDialogs claim={claim} model={model} actions={actions} />}
    </div>
  )
}
