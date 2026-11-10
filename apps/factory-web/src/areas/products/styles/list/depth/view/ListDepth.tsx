'use client'

import { useState, type ReactNode } from 'react'
import { Banner, Field, ProgressBar } from '@nexus/ui/components'
import { Button, Checkbox, Input, TokenChip } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { StyleRow } from '../../../api'
import type { GateSummaryRow } from '../../../record/overview/api'
import { completenessTone, gateItemKey, gateStateKey, pctNumber, pctText } from '../../../record/overview/model'
import { SEASON_MAX, seasonPlan, seasonProblem, seasonsInUse, type ListGate, type SeasonResult } from '../model'

const NS = 'products-styles-depth'

/**
 * SCR-343 — the Styles list in depth (design products.styles sec:styles.grid "Release blockers (count; completeness % W2b)"
 * and the selection row's "Set season (W2b)"): the release column of a row (the completeness meter of its newest draft,
 * else its score at release, with what is open and the first item), and the Set season pop-up over the selected rows.
 */
export function ReleaseCell({ row, gate, fallback }: { row: Pick<StyleRow, 'id'>; gate: ListGate | undefined; fallback: ReactNode }) {
  const t = useT(NS)
  const locale = useLocale()
  const summary: GateSummaryRow | undefined = gate?.byStyle[row.id]
  if (!summary) return gate?.state === 'loading' ? <span className="fw-st-hint">…</span> : <>{fallback}</>
  if (!summary.revision) return <span className="fw-st-hint">{t('column.release.noRevision')}</span>
  const sub = !summary.checked
    ? t('column.release.atRelease', { revision: summary.revision.revision })
    : summary.open === 0
      ? t('column.release.nothingOpen')
      : summary.first
        ? t('column.release.firstOpen', { count: summary.open, item: t(gateItemKey(summary.first.code)) })
        : t('score.open', { count: summary.open, blockers: summary.blockers })
  return (
    <span className="fw-st-cell" title={summary.first ? `${t(gateItemKey(summary.first.code))}: ${t(gateStateKey(summary.first.state))}` : undefined}>
      <ProgressBar ariaLabel={t('score.completenessOf', { value: pctText(summary.completenessPct, locale) })} value={pctNumber(summary.completenessPct)} tone={completenessTone(summary)} showValue height={5} />
      <span className={summary.blockers > 0 ? 'fw-st-row-sub fw-st-warn' : 'fw-st-row-sub'}>{sub}</span>
    </span>
  )
}

/** Set season on the selected styles: one text for all; archived ones left out; each style written at its own version. */
export function SetSeasonDialog({ rows, inUse, busy, result, onApply, onClose }: { rows: readonly StyleRow[]; inUse: readonly Pick<StyleRow, 'season'>[]; busy: boolean; result: SeasonResult | null; onApply: (ids: string[], season: string | null) => void; onClose: () => void }) {
  const t = useT(NS)
  const [typed, setSeason] = useState('')
  // Clearing is chosen on purpose: an empty field alone never clears the season of many styles.
  const [clear, setClear] = useState(false)
  const season = clear ? '' : typed
  const plan = seasonPlan(rows, season)
  const problem = clear ? null : seasonProblem(season)
  const held = problem ?? (!clear && season.trim() === '' ? 'season.held.empty' : plan.change.length === 0 ? 'season.held.nothing' : busy ? 'hold.busy' : null)
  const picks = seasonsInUse(inUse)
  const apply = () => {
    if (!held) onApply(plan.change.map((row) => row.id), season.trim() === '' ? null : season.trim())
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('season.title', { count: rows.length })}
      size="md"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('base.close')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('base.cancel')}</Button>
            <Button variant="primary" heldReason={held ? t(held, { max: SEASON_MAX }) : null} onClick={apply} aria-keyshortcuts="Meta+Enter Control+Enter">
              {season.trim() === '' ? t('season.clear', { count: plan.change.length }) : t('season.apply', { count: plan.change.length })}
            </Button>
          </>
        )
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            apply()
          }
        }}
      >
        {result ? (
          <>
            {result.done > 0 && <Banner tone="success" title={t('season.done', { count: result.done })} />}
            {result.refused.length > 0 && (
              <Banner tone="warning" title={t('season.refused', { count: result.refused.length })}>
                <ul className="fw-st-list">
                  {result.refused.map((entry) => (
                    <li key={entry.id}>
                      <b>{entry.code}</b> — {t(entry.key)}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </>
        ) : (
          <>
            <p className="fw-st-hint">{t('season.intro')}</p>
            <Field label={t('season.field')} hint={t('season.hint', { max: SEASON_MAX })} error={problem ? t(problem, { max: SEASON_MAX }) : undefined}>
              <Input value={typed} maxLength={SEASON_MAX + 5} autoFocus disabled={clear} onChange={(event) => setSeason(event.target.value)} />
            </Field>
            <Checkbox checked={clear} tone="warning" onChange={(event) => setClear(event.target.checked)} label={`${t('season.clearToggle')} — ${t('season.clearHint')}`} />
            {!clear && picks.length > 0 && (
              <div className="fw-st-inline" aria-label={t('season.inUse')}>
                <span className="fw-st-hint">{t('season.inUse')}</span>
                {picks.map((pick) => (
                  <Button key={pick} size="sm" variant="quiet" aria-pressed={season.trim() === pick} onClick={() => setSeason(pick)}>
                    {pick}
                  </Button>
                ))}
              </div>
            )}
            <ul className="fw-st-list">
              {plan.change.map((row) => (
                <li key={row.id}>
                  <b>{row.code}</b> · {row.name} — {row.season ?? t('season.none')} → {season.trim() === '' ? t('season.none') : season.trim()}
                </li>
              ))}
            </ul>
            {plan.same.length > 0 && <p className="fw-st-hint">{t('season.same', { count: plan.same.length })}</p>}
            {plan.archived.length > 0 && (
              <span className="fw-st-inline">
                <span className="fw-st-hint">{t('season.archived', { count: plan.archived.length })}</span>
                {plan.archived.map((row) => (
                  <TokenChip key={row.id}>{row.code}</TokenChip>
                ))}
              </span>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
