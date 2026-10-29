'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, ExternalLink, Inbox, X } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, MetricStrip, Modal, SummaryTable } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, InfoTip, Kbd, Pill, Skeleton, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { ApprovalRow, QuoteDetail } from '../../../sales/quotes/api'
import { APPROVAL_TONE, marginTone, money, percent, unitPrice } from '../../../sales/quotes/model'
import { APPROVAL_VIEWS, heldKey, recheck, type ApprovalsActions, type ApprovalsViewModel } from '../model'
import '../approvals.css'

export type { ApprovalsViewModel, ApprovalsActions } from '../model'

/**
 * SCR-030 — Approvals (Home; design home.approvals, W1 quote approvals; 00 §2.1 queue variant, §3.11): the three views as
 * tiles (waiting for me · my requests · decided in the last 7 days), the queue as rows whose sentence says what is asked
 * and why (the margin figure only with the margin grain), and the centred review: the request, the re-check, the numbers
 * behind each broken rule, the lines; Approve (A) and Reject (R, a reason) held with their reason for the requester or
 * a person without the margin grain; J / K walk the queue. It fetches nothing (Approvals.tsx loads it).
 */
export function ApprovalsView({ model, actions }: { model: ApprovalsViewModel; actions?: ApprovalsActions }) {
  return (
    <WithMessages namespaces={['approvals', 'sales']}>
      <Approvals model={model} actions={actions} />
    </WithMessages>
  )
}

function Approvals({ model, actions }: { model: ApprovalsViewModel; actions?: ApprovalsActions }) {
  const t = useT('approvals')
  const sales = useT('sales')
  const locale = useLocale()
  const items = model.rows.items
  // Read and write problems are the quotes screens' words (sales catalogue); the rest is this page's.
  const words = (key: string, params?: Record<string, string | number>) => (key.startsWith('problem.') ? sales(key, params) : t(key, params))
  const who = (person: ApprovalRow['askedBy']) => (person ? (person.you ? t('you') : (person.name ?? t('colleague'))) : '—')
  const sentence = (row: ApprovalRow) => {
    const reasons = row.reasons.map((reason) => sales(`reason.${reason}`)).join(' · ')
    if (row.reasons.includes('MARGIN_FLOOR') && row.marginPct !== undefined && row.marginFloorPct !== undefined) return t('sentence.margin', { number: row.number, customer: row.partyName, pct: percent(row.marginPct, locale), floor: percent(row.marginFloorPct, locale) })
    return t('sentence.reasons', { number: row.number, customer: row.partyName, reasons })
  }
  const columns = [t('col.request'), t('col.askedBy'), ...(model.grains.price ? [t('col.amount')] : []), t('col.since'), t('col.state'), t('col.open')]
  const rows = (items ?? []).map((row) => ({
    id: row.id,
    cells: [
      <span key="r" className="fw-apv-cell">
        <Link className="fw-apv-link" href={`${model.prefix}/home/approvals?view=${model.view}&open=${row.id}`} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          actions?.onOpen?.(row.id)
        }}>
          {sentence(row)}
        </Link>
        <span className="fw-apv-sub">{t('version', { revision: row.revision })}</span>
      </span>,
      who(row.askedBy),
      ...(model.grains.price ? [money(row.netAmount, row.currency, locale)] : []),
      formatDateTime(row.askedAt, { locale }),
      <span key="s" className="fw-apv-tags">
        <Pill tone={APPROVAL_TONE[row.status]}>{sales(`approvalStatus.${row.status}`)}</Pill>
        {row.status === 'PENDING' && row.held && row.held !== 'NOT_WAITING' && <Tag tone="neutral">{t(`heldShort.${row.held}`)}</Tag>}
      </span>,
      <Link key="o" className="fw-apv-link" href={`${model.prefix}/sales/quotes/${row.quoteId}?tab=approval`}>
        {row.number}
      </Link>,
    ],
  }))

  return (
    <div className="fw-apv">
      <div className="fw-apv-head">
        <p className="fw-apv-hint">{t('intro')}</p>
        <span className="fw-apv-hint" role="status">
          {model.asOf ? t('updated', { time: formatTime(model.asOf, { locale }) }) : t('notYet')}
        </span>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={words(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <MetricStrip
        metrics={APPROVAL_VIEWS.map((view) => {
          const count = model.counts[view]
          return { label: t(`tile.${view}`), value: count === null ? '—' : model.counts.capped && count >= 200 ? t('tileMore', { count }) : String(count), onClick: () => actions?.onView?.(view), active: model.view === view }
        })}
      />
      {model.rows.problem ? (
        <Card padded>
          <EmptyState title={t('failed')} description={words(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
        </Card>
      ) : items === null ? (
        <Card padded aria-busy="true">
          <p className="fw-apv-hint" role="status">
            <Spinner size={14} /> {t('loading')}
          </p>
          <div className="fw-apv-skeleton">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : items.length === 0 ? (
        <Card padded>
          <EmptyState
            icon={<Inbox size={24} aria-hidden />}
            title={t(`empty.${model.view}.title`)}
            description={t(`empty.${model.view}.body`)}
            action={
              model.view === 'waiting' && (model.counts.mine ?? 0) > 0 ? (
                <Button size="sm" onClick={() => actions?.onView?.('mine')}>
                  {t('empty.showMine', { count: model.counts.mine ?? 0 })}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="fw-apv-table">
            <SummaryTable label={t(`tableLabel.${model.view}`)} columns={columns} rows={rows} density="roomy" stackOnPhone widths={model.grains.price ? ['36%', '14%', '12%', '14%', '14%', '10%'] : ['40%', '16%', '16%', '16%', '12%']} />
          </div>
          <div className="fw-apv-foot">
            <InfoTip tip={t('keys')} size={14} />
          </div>
        </Card>
      )}
      <Review model={model} actions={actions} />
    </div>
  )
}

function Review({ model, actions }: { model: ApprovalsViewModel; actions?: ApprovalsActions }) {
  const t = useT('approvals')
  const sales = useT('sales')
  const locale = useLocale()
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const openId = model.open?.id ?? null
  useEffect(() => {
    setNote('')
    setReason('')
  }, [openId])
  const items = model.rows.items ?? []
  const row = openId ? (items.find((item) => item.id === openId) ?? null) : null
  const loaded = model.open?.quote
  const quote: QuoteDetail | null = loaded?.status === 'ready' ? loaded.value : null
  const held = row ? heldKey(row, model.busy) : 'held.busy'
  const state = row ? recheck(row, quote) : 'unknown'
  const changedHeld = state === 'changed' ? 'held.changed' : null
  const approveHeld = held ?? changedHeld
  const approve = () => {
    if (approveHeld) return
    void actions?.onApprove?.(note)
  }
  const reject = () => {
    if (held || changedHeld) return
    actions?.onRejecting?.(true)
  }
  // A approves, R rejects (never while typing, never with the reason dialog open).
  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.rejecting) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
      if (event.key === 'a') {
        event.preventDefault()
        approve()
      } else if (event.key === 'r') {
        event.preventDefault()
        reject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!openId) return null
  const reasonHeld = reason.trim().length < 3 ? t('held.reason') : reason.trim().length > 500 ? t('held.long') : model.busy ? t('held.busy') : null
  const brokenRules = quote?.approval.rules.filter((rule) => rule.broken) ?? []
  const lowLines = quote?.lines.filter((line) => line.belowFloor) ?? []

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpen?.(null)}
        title={row ? t('review.title', { number: row.number }) : t('review.titleUnknown')}
        subtitle={row ? `${row.partyName} · ${t('version', { revision: row.revision })}` : undefined}
        meta={
          row ? (
            <>
              <Pill tone={APPROVAL_TONE[row.status]}>{sales(`approvalStatus.${row.status}`)}</Pill>
              {row.reasons.map((item) => (
                <Tag key={item} tone="warning">
                  {sales(`reason.${item}`)}
                </Tag>
              ))}
            </>
          ) : undefined
        }
        nav={items.length > 1 ? { ids: items.map((item) => item.id), current: openId, onGo: (id) => actions?.onOpen?.(id), noun: t('noun') } : undefined}
        loading={!loaded || loaded.status === 'loading'}
        error={loaded && loaded.status !== 'loading' && loaded.status !== 'ready' ? (loaded.status === 'error' ? sales(loaded.problem) : t(`review.${loaded.status}`)) : undefined}
        onRetry={() => actions?.onRetryReview?.()}
        actions={
          row && row.status === 'PENDING' ? (
            <>
              <Button size="sm" variant="danger-outline" heldReason={held ? t(held) : changedHeld ? t(changedHeld) : null} onClick={reject} aria-keyshortcuts="r">
                <X size={14} aria-hidden /> {t('reject')} <Kbd>R</Kbd>
              </Button>
              <Button size="sm" variant="primary" heldReason={approveHeld ? t(approveHeld) : null} onClick={approve} aria-keyshortcuts="a">
                <Check size={14} aria-hidden /> {t('approve')} <Kbd>A</Kbd>
              </Button>
            </>
          ) : undefined
        }
      >
        {row && (
          <div className="fw-apv-review">
            <Banner tone="info" title={t('review.asked', { who: row.askedBy ? (row.askedBy.you ? t('you') : (row.askedBy.name ?? t('colleague'))) : '—', at: formatDateTime(row.askedAt, { locale }) })}>
              {row.requestNote ? `“${row.requestNote}”` : t('review.noNote')}
            </Banner>
            {row.held && row.held !== 'NOT_WAITING' && <Banner tone="warning" title={t(`held.${row.held}`)} />}
            {row.status !== 'PENDING' && (
              <Banner tone={row.status === 'APPROVED' ? 'success' : 'neutral'} title={t('review.decided', { status: sales(`approvalStatus.${row.status}`), who: row.decidedBy ? (row.decidedBy.you ? t('you') : (row.decidedBy.name ?? t('colleague'))) : '—', at: row.decidedAt ? formatDateTime(row.decidedAt, { locale }) : '—' })}>
                {row.decisionNote ? `“${row.decisionNote}”` : undefined}
              </Banner>
            )}
            {row.status === 'PENDING' && (
              <p className={`fw-apv-recheck is-${state}`} role="status">
                {state === 'current' ? t('review.current', { time: model.asOf ? formatTime(model.asOf, { locale }) : '—' }) : state === 'changed' ? t('review.changed') : t('review.checking')}
              </p>
            )}
            {quote && (
              <>
                <KeyValue
                  dense
                  labelCase="sentence"
                  columns={2}
                  items={[
                    { label: t('review.customer'), value: quote.party.legalName },
                    ...(model.grains.price ? [{ label: t('review.net'), value: money(quote.current.netAmount, quote.current.currency, locale) }, { label: t('review.gross'), value: money(quote.current.grossAmount, quote.current.currency, locale) }] : []),
                    ...(model.grains.margin ? [{ label: t('review.margin'), value: t('review.marginValue', { pct: percent(quote.current.marginPct, locale), floor: percent(quote.current.marginFloorPct, locale) }) }] : []),
                    { label: t('review.discountLimit'), value: percent(quote.approval.discountLimitPct, locale) },
                    { label: t('review.validUntil'), value: quote.current.validUntil ? formatDate(`${quote.current.validUntil}T12:00:00Z`, { locale }) : '—' },
                  ]}
                />
                <section aria-labelledby="fw-apv-rules">
                  <h3 id="fw-apv-rules" className="fw-apv-h">
                    {t('review.rules')}
                  </h3>
                  <ul className="fw-apv-list">
                    {brokenRules.length === 0 ? <li>{t('review.noRule')}</li> : brokenRules.map((rule) => <li key={rule.reason}>{t(`rule.${rule.reason}`, { limit: percent(quote.approval.discountLimitPct, locale) })}</li>)}
                    {model.grains.margin && lowLines.map((line) => <li key={line.id}>{t('review.lowLine', { line: `${line.style.code} ${line.colourway.code}`, pct: percent(line.marginPct, locale) })}</li>)}
                  </ul>
                  {!model.grains.margin && <p className="fw-apv-hint">{t('review.noMargin')}</p>}
                </section>
                <SummaryTable
                  label={t('review.lines')}
                  columns={[t('review.col.line'), t('review.col.pieces'), ...(model.grains.price ? [t('review.col.unit'), t('review.col.net')] : []), ...(model.grains.margin ? [t('review.col.margin')] : [])]}
                  rows={quote.lines.map((line) => ({
                    id: line.id,
                    cells: [
                      `${line.style.code} · ${line.colourway.name}`,
                      line.sizes.map((size) => `${size.size}×${size.quantity}`).join(' · '),
                      ...(model.grains.price ? [unitPrice(line.unitPrice, quote.current.currency, locale), money(line.netAmount, quote.current.currency, locale)] : []),
                      ...(model.grains.margin
                        ? [
                            <span key="m" className="fw-apv-tags">
                              {percent(line.marginPct, locale)}
                              {marginTone(line.marginPct, quote.current.marginFloorPct) === 'warning' || marginTone(line.marginPct, quote.current.marginFloorPct) === 'danger' ? <Tag tone="warning">{sales('lines.belowFloor')}</Tag> : null}
                            </span>,
                          ]
                        : []),
                    ],
                  }))}
                  density="compact"
                  stackOnPhone
                />
                {row.status === 'PENDING' && !row.held && (
                  <Field label={t('review.note')} hint={t('review.noteHint')}>
                    <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} />
                  </Field>
                )}
              </>
            )}
            <Button size="sm" variant="quiet" asChild>
              <Link href={`${model.prefix}/sales/quotes/${row.quoteId}?tab=approval`}>
                <ExternalLink size={14} aria-hidden /> {t('review.openQuote')}
              </Link>
            </Button>
          </div>
        )}
      </DetailModal>
      {model.rejecting && row && (
        <Modal
          open
          onClose={() => actions?.onRejecting?.(false)}
          title={t('rejectDialog.title', { who: row.askedBy ? (row.askedBy.you ? t('you') : (row.askedBy.name ?? t('colleague'))) : t('colleague') })}
          size="sm"
          footer={
            <>
              <Button onClick={() => actions?.onRejecting?.(false)}>{t('back')}</Button>
              <Button variant="danger" heldReason={reasonHeld} onClick={() => !reasonHeld && void actions?.onReject?.(reason)}>
                {t('reject')}
              </Button>
            </>
          }
        >
          <div
            className="fw-apv-review"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !reasonHeld) {
                event.preventDefault()
                void actions?.onReject?.(reason)
              }
            }}
          >
            <p className="fw-apv-hint">{t('rejectDialog.body')}</p>
            <Field label={t('rejectDialog.reason')} required>
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  )
}
