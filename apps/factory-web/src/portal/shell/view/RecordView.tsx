'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowUpRight, Info } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton, ToolbarButton } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { SummaryTone } from '../record/model'

/**
 * The portal's generic page (B-W2b-173; B-TH-274: P-ANY, PL5; picture 41 "the portal generic page"): `/p/<party>/open/<type>/<id>`
 * for a record whose own page is not built, a record's conversation as its own page (`?view=conversation`: an invoice's "Ask about
 * this invoice") and the account conversation (`Party`: "Ask us a question"). No tabs: the conversation is the main column (~2/3)
 * and the record's summary sits beside it from 1280 px (~1/3) — its type and number in words, its state, the record it belongs
 * to as a link, and the record's own page when there is one (an invoice's PDF is in Documents). Narrower: one line (type, number,
 * state) above the conversation, the rest behind its "i". A record that is not the partner's — or no longer exists — says so,
 * with the way Home (the same words for both: the API answers 404 alike).
 */

export interface RecordSummaryModel {
  state: 'loading' | 'error' | 'ready'
  /** The record type in the page's language ("Delivery note"). */
  type: string
  /** Its number as the partner reads it (our number, else their reference; a customer's own number). */
  label: string | null
  /** Their own reference (their PO number), when they gave one and it is not the label. */
  theirRef: string | null
  /** The state in words, and its pill's tone. */
  stateWords: string | null
  stateTone: SummaryTone
  /** The record it belongs to (a delivery note's order), only when the person opens it too. */
  parent: { words: string; href: string } | null
  /** The record's own page, when one is built (an invoice: Documents, where its PDF is). */
  ownPage: { href: string; words: string } | null
}

export interface RecordViewModel {
  missing: boolean
  /** One line under the band (what the record belongs to), from the conversation's read; null: none. */
  subtitle: string | null
  homeHref: string
  /** The account conversation (a question with no record): no summary, the account's words. */
  account?: boolean
  /** The summary row (B-TH-274); null: not drawn (the account, or a design case without it). */
  summary?: RecordSummaryModel | null
}

export function RecordView({ model, children, onRetrySummary }: { model: RecordViewModel; children?: ReactNode; onRetrySummary?: () => void }) {
  const t = useT('portal')
  const [details, setDetails] = useState(false)
  if (model.missing) {
    return (
      <EmptyState
        title={t('record.missingTitle')}
        description={t('record.missing')}
        action={
          <Button asChild variant="primary">
            <Link href={model.homeHref}>{t('record.toHome')}</Link>
          </Button>
        }
      />
    )
  }
  const summary = model.account ? null : (model.summary ?? null)
  return (
    <div className={summary ? 'fw-precord has-summary' : 'fw-precord'}>
      {model.subtitle ? <p className="fw-precord-sub">{model.subtitle}</p> : null}
      {summary ? (
        <div className="fw-precord-compact">
          <SummaryLine summary={summary} />
          <ToolbarButton icon={<Info size={16} />} label={t('record.summary.details')} onClick={() => setDetails(true)} />
        </div>
      ) : null}
      <div className="fw-precord-layout">
        <section id="messages" className="fw-precord-messages" aria-label={model.account ? t('thread.accountTitle') : t('record.messages')}>
          {children}
        </section>
        {summary ? (
          <aside className="fw-precord-side" aria-label={t('record.summary.title')}>
            <SummaryCard summary={summary} onRetry={onRetrySummary} />
          </aside>
        ) : null}
      </div>
      {summary && details ? (
        <Modal open sheet title={t('record.summary.title')} onClose={() => setDetails(false)}>
          <SummaryCard summary={summary} onRetry={onRetrySummary} bare />
        </Modal>
      ) : null}
    </div>
  )
}

/** Narrower than 1280 px (375: type + number): one line above the conversation. */
function SummaryLine({ summary }: { summary: RecordSummaryModel }) {
  return (
    <p className="fw-precord-line">
      <span className="fw-precord-what">{summary.label ? `${summary.type} ${summary.label}` : summary.type}</span>
      {summary.state === 'ready' && summary.stateWords ? <Pill tone={summary.stateTone}>{summary.stateWords}</Pill> : null}
    </p>
  )
}

function SummaryCard({ summary, onRetry, bare = false }: { summary: RecordSummaryModel; onRetry?: () => void; bare?: boolean }) {
  const t = useT('portal')
  const body =
    summary.state === 'loading' ? (
      <div className="fw-precord-facts" role="status" aria-label={t('state.loading')}>
        <Skeleton height={20} />
        <Skeleton height={20} />
      </div>
    ) : summary.state === 'error' ? (
      <div className="fw-precord-failed" role="alert">
        <AlertCircle size={14} aria-hidden /> <span>{t('record.summary.failed')}</span>
        {onRetry ? (
          <Button size="sm" variant="quiet" onClick={onRetry}>
            {t('state.retry')}
          </Button>
        ) : null}
      </div>
    ) : (
      <dl className="fw-precord-facts">
        <div className="fw-precord-fact">
          <dt>{t('record.summary.type')}</dt>
          <dd>{summary.type}</dd>
        </div>
        {summary.label ? (
          <div className="fw-precord-fact">
            <dt>{t('record.summary.number')}</dt>
            <dd className="fw-precord-mono">{summary.label}</dd>
          </div>
        ) : null}
        {summary.theirRef ? (
          <div className="fw-precord-fact">
            <dt>{t('record.summary.theirRef')}</dt>
            <dd className="fw-precord-mono">{summary.theirRef}</dd>
          </div>
        ) : null}
        {summary.stateWords ? (
          <div className="fw-precord-fact">
            <dt>{t('record.summary.state')}</dt>
            <dd>
              <Pill tone={summary.stateTone}>{summary.stateWords}</Pill>
            </dd>
          </div>
        ) : null}
        {summary.parent ? (
          <div className="fw-precord-fact">
            <dt>{t('record.summary.partOf')}</dt>
            <dd>
              <Link href={summary.parent.href}>{summary.parent.words}</Link>
            </dd>
          </div>
        ) : null}
      </dl>
    )
  const own = summary.state === 'ready' && summary.ownPage ? (
    <Button asChild size="sm" variant="secondary">
      <Link href={summary.ownPage.href}>
        {summary.ownPage.words} <ArrowUpRight size={14} aria-hidden />
      </Link>
    </Button>
  ) : null
  if (bare) {
    return (
      <div className="fw-precord-card">
        {body}
        {own}
      </div>
    )
  }
  return (
    <Card padded className="fw-precord-card">
      <h2 className="fw-precord-h2">{t('record.summary.title')}</h2>
      {body}
      {own}
    </Card>
  )
}
