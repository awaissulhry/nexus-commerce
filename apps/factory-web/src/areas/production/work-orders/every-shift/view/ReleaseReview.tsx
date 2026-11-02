'use client'

import type { ReactNode } from 'react'
import { ReviewChangesModal } from '../../../../../lib/i18n/ds-parts'
import { useScopedT, useT } from '../../../../../lib/i18n/provider'
import { previewCounts } from '@nexus/factory-domain/views/bulk/rules'
import type { ReleasePreviewRow } from '../api'
import { refusedWords, SHIFT_NAMESPACE, type BulkReleaseModel } from '../model'

/**
 * "Release N work orders" (design wo-grid selection row, ReviewChangesModal with per-row blockers): the review of the rows
 * as they are now — those that will be released, those released already, and those a check holds, each with what holds it
 * in the record's own words. Save releases each through its own release (version, lock, batch number, audit); a row a
 * check refuses at Save says so on its line. A release has no undo.
 */
export function ReleaseReview({ model, onSave, onRetry, onClose }: { model: BulkReleaseModel; onSave?: () => void; onRetry?: () => void; onClose?: () => void }) {
  const t = useT(SHIFT_NAMESPACE)
  const tp = useT('production')
  const scoped = useScopedT('production')
  const preview = model.preview ?? []
  const counts = previewCounts(preview)
  const name = (row: Pick<ReleasePreviewRow, 'id' | 'label'>) => {
    const own = model.rows.find((entry) => entry.id === row.id)
    return own ? `${own.number} · ${own.styleCode}` : row.label
  }
  const changing = preview.filter((row) => row.refusal === null && row.changes.length > 0)
  const refused = preview.filter((row) => row.refusal !== null)
  const stateWord = (value: string | number | null) => (value === null ? '—' : tp(`status.${value}`))
  const blocker = (row: ReleasePreviewRow): string => {
    const words = refusedWords(row.refusal!)
    if (words.checks.length > 0) return t(words.key, { checks: words.checks.map((code) => tp(`check.name.${code}`)).join(', ') })
    return t(words.key, { status: row.refusal!.status ? tp(`status.${row.refusal!.status}`) : '—' })
  }
  const state = model.state
  const lead: ReactNode =
    refused.length > 0 || counts.unchanged > 0 ? (
      <div className="fw-list-bulk-lead">
        {counts.unchanged > 0 && <p className="fw-list-bulk-note">{t('release.already', { count: counts.unchanged })}</p>}
        {refused.length > 0 && (
          <>
            <p className="fw-list-bulk-note">{t('release.heldTitle', { count: refused.length })}</p>
            <ul className="fw-list-bulk-refused">
              {refused.map((row) => (
                <li key={row.id}>
                  <b>{name(row)}</b> — {blocker(row)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    ) : undefined
  const done = state.phase === 'done'
    ? Object.fromEntries(
        state.results.map((result) => [
          result.id,
          result.ok
            ? { ok: true, words: t('release.released') }
            : { ok: false, words: result.refusal ? blocker({ id: result.id, label: result.label, version: result.version, changes: [], refusal: result.refusal }) : t('release.refusal.failed') },
        ]),
      )
    : null
  return (
    <ReviewChangesModal
      open
      onClose={() => (state.phase === 'saving' ? undefined : onClose?.())}
      changes={changing.map((row) => ({ id: row.id, where: name(row), what: tp('col.status'), now: stateWord(row.changes[0]?.now ?? null), next: stateWord(row.changes[0]?.next ?? null) }))}
      state={done ? { phase: 'done', results: done } : state.phase === 'failed' ? { phase: 'failed', error: scoped(state.words.key, state.words.params) } : state.phase === 'reading' ? { phase: 'reading' } : state.phase === 'saving' ? { phase: 'saving' } : { phase: 'ready' }}
      title={t('release.title', { count: model.rows.length })}
      summary={t('release.summary')}
      {...(model.preview ? { metrics: [{ label: t('release.metric.changing'), value: String(counts.changing) }, { label: t('release.metric.already'), value: String(counts.unchanged) }, { label: t('release.metric.held'), value: String(counts.refused) }] } : {})}
      saveLabel={t('release.save', { count: counts.changing })}
      onSave={() => onSave?.()}
      onRetry={() => onRetry?.()}
      onDone={() => onClose?.()}
      doneVerb={t('release.doneVerb')}
      lead={lead}
    />
  )
}
