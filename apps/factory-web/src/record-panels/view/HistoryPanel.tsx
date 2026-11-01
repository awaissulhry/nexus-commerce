'use client'

import type { ReactNode } from 'react'
import { History } from 'lucide-react'
import { Banner, EmptyState, type TimelineStep } from '@nexus/ui/components'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { Timeline } from '../../lib/i18n/ds-parts'
import { formatDateTime } from '../../lib/i18n/format'
import type { Translate } from '../../lib/i18n/messages'
import { useLocale, useT } from '../../lib/i18n/provider'
import type { Locale } from '../../lib/i18n/locales'
import { audienceBadges, changedValues, changeVerbKey, TIMELINE_FILTERS, type PanelTimelineEntry, type RecordPanelsViewModel, type TimelineFilter } from '../model'
import type { RecordPanelsActions } from './actions'

/**
 * The record's history (COL-002): one feed, newest first, of its messages, its changes and its files, with filter
 * chips. A change says what was done, by whom, its status move and which fields; the values before → after only when the
 * API gave them (audit.read over the row; money only with its grain) — the panel never guesses one.
 */
export function HistoryPanel({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const locale = useLocale()
  const { items, more, problem } = model.timeline
  return (
    <div className="fw-rp-history">
      <SegmentedControl
        ariaLabel={t('history.filterLabel')}
        size="sm"
        wrap
        value={model.timelineFilter}
        onChange={(value) => actions?.onTimelineFilter?.(value as TimelineFilter)}
        options={TIMELINE_FILTERS.map((filter) => ({ value: filter, label: t(`history.filter.${filter}`) }))}
      />
      {problem ? (
        <Banner tone="danger" title={t(problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('timeline')}>{t('panels.retry')}</Button>} />
      ) : items === null ? (
        <p className="fw-rp-loading" role="status">
          <Spinner size={14} /> {t('history.loading')}
        </p>
      ) : items.length === 0 ? (
        <EmptyState icon={<History size={22} aria-hidden />} title={t('history.empty.title')} description={t(`history.empty.body.${model.timelineFilter}`)} />
      ) : (
        <>
          <Timeline label={t('history.label')} steps={items.map((entry) => stepOf(entry, t, locale, model))} />
          {more && (
            <div className="fw-rp-more">
              <Button size="sm" onClick={() => actions?.onMoreTimeline?.()}>
                {t('history.older')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One entry as a Timeline step: the sentence, then when (the site's time) and what else it says. */
function stepOf(entry: PanelTimelineEntry, t: Translate, locale: Locale, model: RecordPanelsViewModel): TimelineStep {
  const when = <time dateTime={entry.at}>{formatDateTime(entry.at, { locale })}</time>
  const party = model.party?.name || t('message.theParty')
  if (entry.kind === 'message') {
    const who = entry.authorName ?? t('message.author.SYSTEM')
    const label =
      entry.direction === 'INTERNAL_NOTE'
        ? t('history.message.note', { who })
        : entry.direction === 'OUTBOUND'
          ? t('history.message.outbound', { who, party })
          : t('history.message.inbound', { who, party })
    return {
      key: `message:${entry.id}`,
      tone: entry.direction === 'INTERNAL_NOTE' ? 'neutral' : 'info',
      label,
      detail: (
        <Detail when={when}>
          <span className="fw-rp-excerpt">{entry.excerpt}</span>
          {entry.attachmentCount > 0 && <span>{t('history.attachments', { count: entry.attachmentCount })}</span>}
        </Detail>
      ),
    }
  }
  if (entry.kind === 'file') {
    const audiences = audienceBadges(entry.visibility)
      .map((badge) => t(badge.key))
      .join(', ')
    return {
      key: `file:${entry.id}`,
      tone: entry.status === 'QUARANTINED' ? 'neutral' : 'success',
      label: t(entry.status === 'QUARANTINED' ? 'history.file.quarantined' : 'history.file.available', { name: entry.name }),
      detail: (
        <Detail when={when}>
          <span>{t('history.file.detail', { kind: t(`files.kind.${entry.fileKind}`), audiences })}</span>
        </Detail>
      ),
    }
  }
  const who = entry.actorName ?? t(`history.actor.${entry.actorAudience}`)
  // The status move has its own line: it is not repeated among the values.
  const values = changedValues(entry).filter((value) => !(entry.status && value.field === 'status'))
  return {
    key: `change:${entry.id}`,
    tone: 'neutral',
    label: t('history.change.label', { who, verb: t(changeVerbKey(entry.action)) }),
    detail: (
      <Detail when={when}>
        {entry.status && (entry.status.from || entry.status.to) && (
          <span>{t('history.change.status', { from: entry.status.from ?? '—', to: entry.status.to ?? '—' })}</span>
        )}
        {values.length > 0 ? (
          <span className="fw-rp-values" role="list" aria-label={t('history.change.valuesLabel')}>
            {values.map((value) => (
              <span key={value.field} role="listitem">
                <code>{value.field}</code>: {value.before} → {value.after}
              </span>
            ))}
          </span>
        ) : entry.fields.length > 0 ? (
          <span>{t('history.change.fields', { fields: entry.fields.join(', ') })}</span>
        ) : null}
        {entry.reason && <span>{t('history.change.reason', { reason: entry.reason })}</span>}
        <code className="fw-rp-muted">{entry.action}</code>
      </Detail>
    ),
  }
}

function Detail({ when, children }: { when: ReactNode; children?: ReactNode }) {
  return (
    <span className="fw-rp-step-detail">
      <span>{when}</span>
      {children}
    </span>
  )
}
