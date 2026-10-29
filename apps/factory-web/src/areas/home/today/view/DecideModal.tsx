'use client'

import { useEffect, useState } from 'react'
import { Check, ExternalLink, X } from 'lucide-react'
import { Banner, Field, KeyValue, Modal, type KeyValueItem } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Kbd, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { decideKey, DECIDED_HERE, dueWords, rejectReasonProblem, type Notice, type QueueItem, type QuoteReview, type ReviewState } from '../model'
import { phraseText, sentenceText } from '../words'

/** What the decide modal asks of the container: the quotes module's own approve and reject (each resolves true when done). */
export interface DecideActions {
  onApprove?: (key: string, note: string | null) => Promise<boolean>
  onReject?: (key: string, reason: string) => Promise<boolean>
  onRetryReview?: (key: string) => void
}

const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const

/** Minor units as an amount in the person's language (the API sends integers: cents). */
const money = (minor: number, currency: string, locale: 'it' | 'en') => formatNumber(minor / 100, locale, { style: 'currency', currency })

/**
 * The decide modal (design home.today `decide`, W1; Owner answer O3 = A): one row of Today in a centred DetailModal,
 * J / K (and the arrows) to the next and previous row: "Work through N" is this modal from the first row on. A quote
 * approval is decided here with the quotes module's approve and reject (a reject needs a reason): its review shows the
 * rules it breaks, the request and the money the person's grains reach. No W1 row is a one-field change, so nothing is
 * approved from the list itself. Any other row says why it is the person's and what waits on it, and opens its own
 * review (mail to sort) or its record. Keys: a approves, r rejects.
 */
export function DecideModal({
  items,
  keys,
  open,
  total,
  reviews,
  busy,
  notice,
  onGo,
  onClose,
  actions,
}: {
  items: readonly QueueItem[]
  keys: readonly string[]
  open: string | null
  total: number | null
  reviews: Readonly<Record<string, ReviewState>>
  busy: boolean
  notice: Notice | null
  onGo: (key: string) => void
  onClose: () => void
  actions?: DecideActions
}) {
  const t = useT('home')
  const locale = useLocale()
  const item = open ? (items.find((entry) => entry.key === open) ?? null) : null
  const decidedHere = item !== null && DECIDED_HERE.has(item.kind)
  const review = item && decidedHere ? (reviews[item.key] ?? { status: 'loading' as const }) : null
  const ready = review?.status === 'ready' ? review.data : null
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    setRejecting(false)
    setReason('')
    setTried(false)
  }, [open])

  const canDecide = ready !== null && ready.decidable && !busy
  const approve = () => {
    if (!item || !canDecide) return
    void actions?.onApprove?.(item.key, null)
  }
  const startReject = () => {
    if (canDecide) setRejecting(true)
  }

  // a approves, r rejects (never in a text field, never with a modifier; the DetailModal keeps J / K).
  useEffect(() => {
    if (!item || !decidedHere || rejecting) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inField = target?.closest('input, textarea, select, [contenteditable="true"]') != null
      const action = decideKey(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, inField })
      if (!action) return
      event.preventDefault()
      if (action === 'approve') approve()
      else startReject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!item) return null
  const due = dueWords(item.due)
  const problem = rejectReasonProblem(reason)
  const held = !ready ? t('today.decide.reading') : !ready.decidable ? t('today.decide.notWaiting') : undefined

  const facts: KeyValueItem[] = [
    { label: t('today.decide.why'), value: phraseText(item.words.why, t, locale) },
    ...(item.words.blocks ? [{ label: t('today.decide.blocks'), value: phraseText(item.words.blocks, t, locale) }] : []),
    ...(due ? [{ label: t('today.decide.due'), value: t(due.key, { count: due.count, date: formatDate(due.date, { locale }) }) }] : []),
    { label: t('today.decide.since'), value: `${formatDateTime(item.since, { locale })} · ${t(item.ageDays === 0 ? 'today.row.ageToday' : 'today.row.age', { count: item.ageDays })}` },
    // A quote's review shows its money itself; any other row shows what the person's grains reach.
    ...(!decidedHere && item.figures?.netAmount !== undefined ? [{ label: t('today.decide.value'), value: money(item.figures.netAmount, item.figures.currency, locale) }] : []),
    ...(!decidedHere && item.figures?.purchaseAmount !== undefined ? [{ label: t('today.decide.purchaseValue'), value: money(item.figures.purchaseAmount, item.figures.currency, locale) }] : []),
  ]

  const footer = decidedHere ? (
    <div className="fw-today-decide-foot">
      <a className="fw-today-record" href={item.href}>
        {t('today.decide.openRecord', { record: item.record.label })} <ExternalLink size={12} aria-hidden />
      </a>
      <span className="fw-today-decide-buttons">
        <Button variant="secondary" onClick={startReject} heldReason={canDecide ? undefined : held}>
          <X size={14} aria-hidden /> {t('today.decide.reject.button')} <Kbd>R</Kbd>
        </Button>
        <Button variant="primary" onClick={approve} heldReason={canDecide ? undefined : (busy ? t('today.decide.busy') : held)}>
          <Check size={14} aria-hidden /> {t('today.decide.approve')} <Kbd>A</Kbd>
        </Button>
      </span>
    </div>
  ) : (
    <div className="fw-today-decide-foot">
      <span className="fw-today-muted">{t(item.reviewHref ? 'today.decide.ownReview' : item.decide === 'REVIEW' ? 'today.decide.ownPage' : 'today.decide.onRecord')}</span>
      <Button variant="primary" asChild>
        <a href={item.reviewHref ?? item.href}>
          {t(item.reviewHref ? 'today.decide.openReview' : 'today.decide.openRecord', { record: item.record.label })} <ExternalLink size={12} aria-hidden />
        </a>
      </Button>
    </div>
  )

  return (
    <>
      <DetailModal
        open
        onClose={onClose}
        title={item.record.label}
        subtitle={sentenceText(item, t, locale)}
        meta={
          <span className="fw-today-decide-meta">
            <Tag tone={SEVERITY_TONE[item.severity]}>{t(`today.severity.${item.severity}`)}</Tag>
            <Tag tone="neutral">{t(`today.kind.${item.kind}`) === `today.kind.${item.kind}` ? item.kind : t(`today.kind.${item.kind}`)}</Tag>
          </span>
        }
        nav={{ ids: keys, current: item.key, onGo, noun: t('today.decide.noun'), offset: 0, total: total ?? keys.length }}
        loading={decidedHere && review?.status === 'loading'}
        error={decidedHere && review?.status === 'error' ? t(review.problem) : undefined}
        onRetry={decidedHere ? () => actions?.onRetryReview?.(item.key) : undefined}
        footer={footer}
      >
        <div className="fw-today-decide">
          {notice && <Banner tone={notice.tone} title={t(notice.key, notice.params)} />}
          {ready && <QuoteReviewBody review={ready} />}
          <KeyValue items={facts} />
        </div>
      </DetailModal>

      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={t('today.decide.reject.title', { record: item.record.label })}
        footer={
          <span className="fw-today-decide-buttons">
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              {t('today.decide.reject.cancel')}
            </Button>
            <Button
              variant="danger"
              heldReason={busy ? t('today.decide.busy') : undefined}
              onClick={async () => {
                setTried(true)
                if (problem || !item) return
                const done = await actions?.onReject?.(item.key, reason)
                if (done !== false) setRejecting(false)
              }}
            >
              {t('today.decide.reject.confirm')}
            </Button>
          </span>
        }
      >
        <Field label={t('today.decide.reject.reason')} required hint={t('today.decide.reject.hint')} error={tried && problem ? t(problem) : undefined}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} limit={1000} autoFocus />
        </Field>
      </Modal>
    </>
  )
}

/** A quote approval's review: the quote, the rules it breaks and the request (money only as the grains allow). */
function QuoteReviewBody({ review }: { review: QuoteReview }) {
  const t = useT('home')
  const locale = useLocale()
  const facts: KeyValueItem[] = [
    { label: t('today.review.customer'), value: review.customer },
    { label: t('today.review.revision'), value: t('today.review.revisionValue', { revision: review.revision }) },
    ...(review.netAmount !== null ? [{ label: t('today.review.value'), value: money(review.netAmount, review.currency, locale) }] : []),
    ...(review.marginPct !== null
      ? [{ label: t('today.review.margin'), value: `${formatNumber(Number(review.marginPct), locale, { maximumFractionDigits: 1 })} %`, hint: review.marginFloorPct !== null ? t('today.review.floor', { floor: review.marginFloorPct }) : undefined }]
      : []),
    ...(review.validUntil ? [{ label: t('today.review.validUntil'), value: formatDate(review.validUntil, { locale }) }] : []),
  ]
  return (
    <div className="fw-today-review">
      {!review.decidable && <Banner tone="info" title={t('today.decide.notWaiting')} />}
      <KeyValue items={facts} />
      {review.rules.length > 0 && (
        <div>
          <h3 className="fw-today-group-h">{t('today.review.rules')}</h3>
          <ul className="fw-today-review-rules">
            {review.rules.map((rule) => (
              <li key={rule.reason}>{rule.message}</li>
            ))}
          </ul>
        </div>
      )}
      {review.request && (
        <p className="fw-today-muted">
          {t('today.review.asked', { at: formatDateTime(review.request.askedAt, { locale }) })}
          {review.request.note ? ` — “${review.request.note}”` : ''}
        </p>
      )}
    </div>
  )
}
