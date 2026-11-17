'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, FileX, Send, ShieldOff, Undo2, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Claim } from '../../api'
import { actHeld, answerDraftOf, goodsDraftOf, KIND_TONE, otherActs, primaryAct, RECORD_TABS, say, sendDraftOf, STATUS_TONE, type ClaimAct, type ClaimDialog, type ClaimRecordActions, type ClaimRecordModel } from '../../model'
import { ClaimDialogs } from './ClaimDialogs'
import { ClaimTab } from './ClaimTab'
import { CreditTab, GoodsTab } from './GoodsCreditTabs'
import '../../../../_shared/buying/buying.css'
import '../../claims.css'
// B-W2b-F51: a refusal names the missing right in words, never its code.
import { rightRef } from '../../../../../lib/i18n/rights'
// ---- B-TH-263: the claim on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

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
 * SCR-131 — a supplier claim (design purchasing.claims "Record: Supplier claim", `?tab=claim|goods`), on RecordFrame (B-TH-263;
 * the rule of picture 38, the tabs of 08-tabs O-PUR-CLM): the band in the shell's band row (‹ Returns & claims, "<number> ·
 * <supplier>", ONE state pill, its kind, the main act by state — Send, Record the supplier's answer, Send the goods back, Close —
 * held with why in words; the Thread button ⌘J, the frame's; ⋯ the other acts, the receipt, the order, Copy number, its Keyboard
 * line), the docked thread beside every tab (Activity's tools in its "⋯", R-ACT), the tabs 4 → 2: Claim (what is wrong and what is
 * asked, saved explicitly; its lines), Goods & credit (the return DDTs and the stock moves out, then the credit expected beside
 * the credit note Finance matches). Closed or cancelled: read-only, said in the ONE notice of the body column.
 */
// B-TH-263: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function ClaimRecordView({ model, actions, thread, printThread }: { model: ClaimRecordModel; actions?: ClaimRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <WithMessages namespaces={['purchasing-claims', 'lists', 'records']}>
      <Record model={model} actions={actions} thread={thread} printThread={printThread} />
    </WithMessages>
  )
}

function Record({ model, actions, thread, printThread }: { model: ClaimRecordModel; actions?: ClaimRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('purchasing-claims')
  const listHref = `${model.prefix}/purchasing/claims`
  const loaded = model.claim
  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="SupplierClaim"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
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
      </RecordFrame>
    )
  }
  return <Ready claim={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} />
}

function Ready({ claim, model, actions, thread, printThread }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const href = `${model.prefix}/purchasing/claims/${claim.id}`
  // ⌘J is the frame's (the thread).

  const primary = primaryAct(claim)
  const primaryHeld = primary ? actHeld(claim, primary, model.can) : null
  const others = otherActs(claim, model.can)
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: `${href}?tab=${tab}`,
    label: t(`tab.${tab}`),
    count: tab === 'claim' ? claim.lines.length : claim.ddts.filter((ddt) => !ddt.cancelled).length,
  }))
  const more: MenuItemDef[] = [
    ...others.map((act) => ({ id: act, label: t(`act.${act}`), tone: act === 'cancel' ? ('danger' as const) : undefined, onSelect: () => actions?.onDialog?.(dialogFor(act, claim)) })),
    ...(claim.goodsReceipt ? [{ id: 'receipt', label: t('record.openReceipt', { number: claim.goodsReceipt.number }), href: `${model.prefix}/warehouse/receipts/${claim.goodsReceipt.id}` }] : []),
    ...(claim.purchaseOrder ? [{ id: 'order', label: t('record.openOrder', { number: claim.purchaseOrder.number }), href: `${model.prefix}/purchasing/orders/${claim.purchaseOrder.id}` }] : []),
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopyNumber?.() },
  ]
  const Icon = primary ? ACT_ICON[primary] : null
  const settled = claim.status === 'CLOSED' || claim.status === 'CANCELLED'

  return (
    <>
      <RecordFrame
        recordType="SupplierClaim"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={`${model.prefix}/purchasing/claims`}>{t('record.back')}</Link>,
          title: (
            <span className="fw-by-title">
              {claim.number} <span className="fw-by-title-sub">· {claim.supplier.name}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[claim.status]}>{t(`status.${claim.status}`)}</Pill>,
          meta: (
            <>
              <Tag tone={KIND_TONE[claim.kind]}>{t(`kind.${claim.kind}`)}</Tag>
              <span className="fw-by-hint">{[claim.site.code, t(`foundAt.${claim.foundAt}`), t('record.created', { date: formatDate(claim.createdAt, place) })].join(' · ')}</span>
            </>
          ),
          primary:
            primary && Icon ? (
              <Button size="sm" variant="primary" heldReason={primaryHeld ? say(t, primaryHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.(dialogFor(primary, claim))}>
                <Icon size={14} aria-hidden /> {t(primary === 'send' && claim.status === 'REJECTED' ? 'act.sendAgain' : `act.${primary}`)}
              </Button>
            ) : undefined,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-263: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
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
          {settled ? (
            <Banner tone="info" title={claim.status === 'CLOSED' ? t('record.readOnlyClosed', { time: claim.closedAt ? formatDateTime(claim.closedAt, place) : '—' }) : t('record.readOnlyCancelled', { time: claim.cancelledAt ? formatDateTime(claim.cancelledAt, place) : '—' })}>
              {claim.status === 'CLOSED' ? claim.closeNote : claim.cancelReason}
            </Banner>
          ) : (
            !model.can.manage && <Banner tone="info" title={t('record.readOnlyRight', { right: rightRef('purchasing.claims.manage') })} />
          )}
        </RecordNotices>

        <div className="fw-by-main">
          {model.tab === 'claim' && <ClaimTab claim={claim} model={model} actions={actions} />}
          {/* B-TH-263: Goods & credit — the goods that went back, then the credit expected (both tabs' work, in that order). */}
          {model.tab === 'goods' && (
            <div className="fw-by-stack">
              <GoodsTab claim={claim} model={model} actions={actions} />
              <CreditTab claim={claim} model={model} />
            </div>
          )}
        </div>
      </RecordFrame>

      {model.dialog && <ClaimDialogs claim={claim} model={model} actions={actions} />}
    </>
  )
}
