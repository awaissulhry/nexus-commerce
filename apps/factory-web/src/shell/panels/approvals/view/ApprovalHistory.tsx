'use client'

import { History } from 'lucide-react'
import { EmptyState, type TimelineStep } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Timeline } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { HistoryLine } from '../api'
import { ACTION_TONE, lineDetail, lineWords, NAMESPACE, type ApprovalHistoryActions, type ApprovalHistoryModel } from '../model'
import '../approvals-history.css'

/**
 * SCR-352 — Approvals: the history on a record (B-W2b-307; PLT-104; design shell.panels, the record panels' Approvals, and
 * home.approvals review "History"): every request for a yes and every domain approval of the record, newest first, each
 * line who did what and when, with the meaning of a signature and the words of a note or a no. It fetches nothing
 * (`use-approval-history.ts`); without approvals.view the section is absent.
 */
export function ApprovalHistory({ model, actions, heading = true }: { model: ApprovalHistoryModel; actions?: ApprovalHistoryActions; heading?: boolean }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <History_ model={model} actions={actions} heading={heading} />
    </WithMessages>
  )
}

function History_({ model, actions, heading }: { model: ApprovalHistoryModel; actions?: ApprovalHistoryActions; heading: boolean }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  if (!model.allowed) return null
  const read = model.read
  const titleId = 'fw-apd-history-title'
  const step = (line: HistoryLine): TimelineStep => {
    const words = lineWords(line)
    const params = { ...words.params, ...(words.params.meaning ? { meaning: t(`meaning.${words.params.meaning}`) } : {}) }
    const detail = lineDetail(line)
    return {
      key: line.id,
      label: t(words.key, params),
      tone: ACTION_TONE[line.action],
      at: line.at,
      detail: [formatDateTime(line.at, { locale }), detail].filter(Boolean).join(' · '),
    }
  }
  return (
    <section className="fw-apd-history" aria-labelledby={heading ? titleId : undefined} aria-label={heading ? undefined : t('history.title')}>
      {heading && (
        <h3 id={titleId} className="fw-apd-h">
          {t('history.title')}
        </h3>
      )}
      {read.status === 'loading' ? (
        <div aria-busy="true" aria-label={t('history.loading')}>
          <Skeleton height={18} />
          <Skeleton height={18} />
          <Skeleton height={18} />
        </div>
      ) : read.status === 'error' ? (
        <EmptyState
          title={t(`history.problem.${read.problem}`)}
          action={
            read.problem === 'unavailable' && actions?.onRetry ? (
              <Button size="sm" onClick={actions.onRetry}>
                {t('retry')}
              </Button>
            ) : undefined
          }
        />
      ) : read.lines.length === 0 ? (
        <EmptyState icon={<History size={22} aria-hidden />} title={t('history.empty.title')} description={t('history.empty.body')} />
      ) : (
        <>
          <Timeline label={t('history.title')} steps={read.lines.map(step)} now={model.now} />
          {read.more && (
            <Button size="sm" onClick={() => actions?.onMore?.()} heldReason={read.loadingMore ? t('history.loadingMore') : null}>
              {t('history.more')}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
