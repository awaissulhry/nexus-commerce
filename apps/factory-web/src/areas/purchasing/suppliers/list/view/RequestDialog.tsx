'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { dueProblem } from '../../depth/model'
import { useSay } from '../../depth/view/parts'

export interface RequestRun {
  readonly targets: ReadonlyArray<{ id: string; name: string }>
  /** The due day (YYYY-MM-DD), or '' for none. */
  readonly due: string
  readonly tried: boolean
  readonly sending: boolean
  readonly results: ReadonlyArray<{ id: string; name: string; outcome: 'asked' | 'already' | 'refused'; problem?: string }>
  readonly done: boolean
}

/**
 * Request documents N (design purchasing.suppliers sec:grid "Bulk: Export · Request documents (W2b)"): one request to
 * upload their documents on each supplier's own record — what we ask of it is on its portal's "We ask for" —, with a due
 * day if any; each supplier's outcome in words as it goes (asked, one waiting already, refused and why).
 */
export function RequestDialog({ run, today, onDue, onSend, onClose }: { run: RequestRun | null; today: string; onDue?: (due: string) => void; onSend?: () => void; onClose?: () => void }) {
  const { t } = useSay()
  if (!run) return null
  const problem = dueProblem(run.due, today)
  const asked = run.results.filter((result) => result.outcome === 'asked').length
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('request.title', { count: run.targets.length })}
      footer={
        run.done ? (
          <Button variant="primary" onClick={() => onClose?.()}>
            {t('request.close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => onClose?.()}>{t('dialog.cancel')}</Button>
            <Button variant="primary" onClick={() => onSend?.()} heldReason={run.sending ? t('request.sending') : run.tried && problem ? t(problem.key, problem.params) : null}>
              {t('request.sendMany', { count: run.targets.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-spd-stack">
        <p className="fw-spd-hint">{t('request.body')}</p>
        {!run.done && !run.sending ? (
          <Field label={t('request.due')} hint={t('request.dueHint')} error={run.tried && problem ? t(problem.key, problem.params) : undefined}>
            <DateField value={run.due} clearable onChange={(value) => onDue?.(value)} />
          </Field>
        ) : null}
        <ul className="fw-spd-list" aria-live="polite">
          {run.targets.map((target) => {
            const result = run.results.find((entry) => entry.id === target.id)
            return (
              <li key={target.id}>
                {target.name}
                {' · '}
                <span className={result?.outcome === 'refused' ? 'fw-spd-error' : 'fw-spd-hint'}>
                  {result ? (result.outcome === 'refused' ? t('request.refused', { why: t(result.problem ?? 'problem.unavailable') }) : t(`request.outcome.${result.outcome}`)) : run.sending ? t('request.waiting') : t('request.toAsk')}
                </span>
              </li>
            )
          })}
        </ul>
        {run.done ? <Banner tone={asked === run.targets.length ? 'success' : 'warning'} title={t('request.summary', { asked, count: run.targets.length })} /> : null}
      </div>
    </Modal>
  )
}
