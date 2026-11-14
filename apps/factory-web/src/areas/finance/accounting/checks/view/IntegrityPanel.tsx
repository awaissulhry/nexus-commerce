'use client'

import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { CheckList as DsCheckList } from '@nexus/ui/patterns/checklist/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { fixLabel } from '../../model'
import type { IntegrityActions, IntegrityModel } from '../use-integrity'
import { fixAddress, historyPhrase, integrityPhrase, integrityState, runHeld } from '../model'
import { useAccountingWords } from '../words'

const dayInstant = (day: string): string => `${day}T12:00:00Z`

/**
 * The integrity checks on 2 · Checks (FIN-157; design finance.accounting sec:step-checks "totals equal row sums ·
 * placements never exceed payments"): every night (04:10) Nexus checks the documents of this month and the twelve before,
 * and keeps each named check's result; the export reads the last run. Each check with its state (the DS CheckList: Done,
 * Open, Unknown — could not run or not run yet, said in words), when it ran and whether by the nightly run or a person, the records that fail
 * it (opened in a new tab) and the runs before. "Run the checks now" (accounting.export) runs them at once.
 */
export function IntegrityPanel({ model, prefix, actions }: { model: IntegrityModel; prefix: string; actions?: IntegrityActions }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const ds = useDsWords()
  const value = model.value
  const held = value ? runHeld(value.can, model.running) : null
  return (
    <Card padded className="fw-fac-card" aria-labelledby="fw-fac-integrity-title">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3" id="fw-fac-integrity-title">
          {t('integrity.title')}
        </h3>
        {value && (
          <span className="fw-fac-inline">
            <span className="fw-fac-muted">{value.lastRunAt ? t('integrity.lastRun', { at: formatDateTime(value.lastRunAt, { locale }) }) : t('integrity.neverRun')}</span>
            <Button size="sm" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onRun?.()}>
              <RefreshCw size={13} aria-hidden /> {t('integrity.run')}
            </Button>
          </span>
        )}
      </div>
      <p className="fw-fac-muted">{value ? t('integrity.lead', { from: formatDate(dayInstant(value.window.from), { locale }), to: formatDate(dayInstant(value.window.to), { locale }) }) : t('integrity.leadShort')}</p>
      {model.problem ? (
        <EmptyState title={t('integrity.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      ) : !value ? (
        <p className="fw-fac-muted" role="status">
          <Spinner size={12} /> {t('integrity.reading')}
        </p>
      ) : (
        <>
          {model.runProblem && <Banner tone="danger" title={t(model.runProblem.key, model.runProblem.params)} />}
          <DsCheckList
            label={t('integrity.title')}
            summary={false}
            labels={ds.checkList}
            checks={value.checks.map((check) => {
              const sentence = integrityPhrase(check)
              const earlier = historyPhrase(check)
              const when = check.ranAt ? t(check.ranBy ? 'integrity.ranBy' : 'integrity.ranNightly', { at: formatDateTime(check.ranAt, { locale }), who: check.ranBy?.name ?? t('history.someone') }) : null
              return {
                id: check.code,
                state: integrityState(check.result, model.running),
                name: t(`integrity.check.${check.code}.title`),
                detail: <span className="fw-fac-stack">{[t(sentence.key, sentence.params), when, earlier ? t(earlier.key, earlier.params) : null].filter(Boolean).join(' · ')}</span>,
                ...(check.result === 'FAILED' && check.failures.length > 0
                  ? {
                      fix: (
                        <div className="fw-fac-check-fix">
                        <ul className="fw-fac-fixes" aria-label={t('integrity.failuresLabel', { check: t(`integrity.check.${check.code}.title`) })}>
                          {check.failures.map((failure) => {
                            const label = fixLabel(failure)
                            return (
                              <li key={`${failure.recordType}|${failure.recordId}|${failure.code ?? ''}`}>
                                <Link className="fw-fac-link" href={`${prefix}${fixAddress(failure)}`} target="_blank" rel="noopener noreferrer">
                                  {t(label.key, label.params)}
                                </Link>
                                {failure.code && <span className="fw-fac-muted">{` · ${t(`integrity.failure.${failure.code}`)}`}</span>}
                              </li>
                            )
                          })}
                          {check.failureCount > check.failures.length && <li className="fw-fac-muted">{t('check.moreFixes', { count: check.failureCount - check.failures.length })}</li>}
                        </ul>
                        </div>
                      ),
                    }
                  : {}),
              }
            })}
          />
          <p className="fw-fac-muted">{t('integrity.export')}</p>
        </>
      )}
    </Card>
  )
}
