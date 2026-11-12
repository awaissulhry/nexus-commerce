'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, quantity } from '../../../../_shared/stock/model'
import type { WaitingAdjustment } from '../api'
import { DEPTH_NAMESPACE, requestHref, type ApprovalNotice, type PostingState } from '../model'

/**
 * The parts the Adjust stock dialog and the pages around it draw for B-W2b-327: the warehouse rules' "Needs approval above
 * € 500" banner (design st-adjust; who says yes from the active approval rules; the value with the cost grain only), the
 * posting day's check in words (the back-dating limit, a closed month, a soft-locked month's reason), and "Waiting for
 * approval by Finance since 10:42" with Open request (design mv-approval) after an adjustment above the value.
 */

/** "Needs approval above € 500,00 · Who approves: Finance". */
export function ApprovalBanner({ notice }: { notice: ApprovalNotice }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const title = notice.amount !== null && notice.currency ? t('wd.adj.approvalAbove', { amount: money(notice.amount, notice.currency, locale) }) : t('wd.adj.approvalHeld')
  return (
    <Banner tone="info" title={title}>
      {notice.approvers.length > 0 ? t('wd.adj.approvers', { names: notice.approvers.join(', ') }) : t('wd.adj.approversUnknown')}
    </Banner>
  )
}

/** The posting day's check: allowed, refused with the earliest day, a closed month, or the reason a soft-locked month asks. */
export function PostingNote({ posting, onLockReason }: { posting: PostingState; onLockReason: (reason: string) => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone: 'UTC' })
  const check = posting.check
  if (!check || check.status === 'loading') return <p className="fw-stk-hint" role="status">{t('wd.posting.checking')}</p>
  if (check.status === 'error') return <Banner tone="warning" title={s(check.problem)} />
  const value = check.value
  if (value.periodLock?.level === 'HARD') return <Banner tone="danger" title={t('wd.posting.closed')}>{t('wd.posting.closedBody', { from: day(value.periodLock.periodStart), to: day(value.periodLock.periodEnd) })}</Banner>
  if (!value.allowed) return <Banner tone="danger" title={value.earliest ? t('wd.posting.tooFar', { earliest: day(value.earliest) }) : t('wd.posting.notAllowed')} />
  return (
    <>
      <p className="fw-stk-hint" role="status">
        {t('wd.posting.ok', { day: day(value.day) })}
      </p>
      {value.periodLock?.needsReason && (
        <Field label={t('wd.posting.lockReasonLabel')} required hint={t('wd.posting.lockReasonHint', { from: day(value.periodLock.periodStart), to: day(value.periodLock.periodEnd) })}>
          <Input value={posting.lockReason} maxLength={500} onChange={(event) => onLockReason(event.target.value)} />
        </Field>
      )}
    </>
  )
}

/** "Waiting for approval by Finance since 10:42" (design mv-approval): what waits, stock from → to, Open request. */
export function WaitingBanner({ waiting, prefix, timeZone, onDismiss }: { waiting: WaitingAdjustment; prefix: string; timeZone: string; onDismiss?: () => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  const unit = s(`uom.${waiting.item.baseUom}`)
  return (
    <Banner
      tone="info"
      title={waitingWords(t, waiting, { locale, timeZone })}
      action={
        <Button size="sm" asChild>
          <Link href={requestHref(prefix, waiting.taskId)}>
            <ExternalLink size={13} aria-hidden /> {t('wd.waiting.open')}
          </Link>
        </Button>
      }
      {...(onDismiss ? { onDismiss } : {})}
    >
      {t('wd.waiting.what', { material: waiting.item.code, place: waiting.location.code, from: quantity(waiting.onHand.from, locale), to: quantity(waiting.onHand.to, locale), unit })}
    </Banner>
  )
}

/** "Waiting for approval by Finance since 10:42" (today) or "… since 9 Nov, 10:42". */
export function waitingWords(t: (key: string, params?: Record<string, string | number>) => string, waiting: Pick<WaitingAdjustment, 'approver' | 'requestedAt'>, place: { locale: Parameters<typeof formatTime>[1]['locale']; timeZone: string }): string {
  const today = formatDate(new Date(), place) === formatDate(waiting.requestedAt, place)
  const since = today ? formatTime(waiting.requestedAt, place) : `${formatDate(waiting.requestedAt, place)} ${formatTime(waiting.requestedAt, place)}`
  return waiting.approver.name ? t('wd.waiting.by', { approver: waiting.approver.name, since }) : t('wd.waiting.byUnknown', { since })
}
