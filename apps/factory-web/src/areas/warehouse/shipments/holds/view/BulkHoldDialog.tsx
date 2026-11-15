'use client'

import { Field } from '@nexus/ui/components'
import { Pill, RadioCard } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, useDepthWords } from '../../queue/shared/DepthDialog'
import { BULK_REASONS, bulkProblem, holdable, HOLD_WORDS_MAX, MONEY_REASONS, type BulkHoldActions, type BulkHoldModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-592 — the list's selection "Hold" (design sh-grid selection row 'Hold' (W2b); B-W2b-386 `POST /shipping/holds`): the
 * reason (Other needs words), the shipments picked — those already gone are named and left out before anything is sent —
 * then ONE command; the answer names each placed and each skipped (already held for that reason, no longer open).
 */
export function BulkHoldDialog({ model, actions }: { model: BulkHoldModel; actions?: BulkHoldActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <BulkHold model={model} actions={actions} />
    </WithMessages>
  )
}

function BulkHold({ model, actions }: { model: BulkHoldModel; actions?: BulkHoldActions }) {
  const { t, say } = useDepthWords()
  const open = model.picked.filter((row) => holdable(row.status))
  const gone = model.picked.filter((row) => !holdable(row.status))
  const problem = bulkProblem(model)
  const done = model.outcome ? (
    <div className="fw-shd-stack" role="status">
      <p>{t('holds.bulk.placed', { count: model.outcome.placed.length })}</p>
      {model.outcome.placed.length > 0 && (
        <ul className="fw-sh-list">
          {model.outcome.placed.map((row) => (
            <li key={row.shipmentId}>{row.number}</li>
          ))}
        </ul>
      )}
      {model.outcome.skipped.length > 0 && (
        <>
          <p>{t('holds.bulk.skipped', { count: model.outcome.skipped.length })}</p>
          <ul className="fw-sh-list">
            {model.outcome.skipped.map((row) => (
              <li key={row.shipmentId}>
                {row.number} — {t(`holds.refusal.${row.code}`)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  ) : undefined
  return (
    <DepthDialog
      title={t('holds.bulk.title', { count: open.length })}
      held={model.busy ? t('holds.held.busy') : say(problem)}
      onGo={() => actions?.onGo?.()}
      goLabel={t('holds.bulk.go', { count: open.length })}
      onClose={() => actions?.onClose?.()}
      problem={say(model.problem)}
      done={done}
    >
      <p className="fw-sh-hint">{t('holds.bulk.body')}</p>
      <fieldset className="fw-shd-choices">
        <legend className="fw-sh-h3">{t('holds.reason')}</legend>
        {BULK_REASONS.map((reason) => (
          <RadioCard
            key={reason}
            name="bulk-hold-reason"
            value={reason}
            checked={model.reason === reason}
            selected={model.reason === reason}
            onChange={() => actions?.onReason?.(reason)}
            title={t(`holdReason.${reason}`)}
            description={MONEY_REASONS.includes(reason) ? t('holds.releasedBy.finance') : t('holds.releasedBy.warehouse')}
          />
        ))}
      </fieldset>
      <Field label={model.reason === 'OTHER' ? t('holds.wordsRequired') : t('holds.wordsOptional')} hint={t('holds.wordsHint')}>
        <Textarea rows={3} limit={HOLD_WORDS_MAX} value={model.text} onChange={(event) => actions?.onText?.(event.target.value)} />
      </Field>
      <div className="fw-shd-stack">
        <span className="fw-sh-h3">{t('holds.bulk.picked', { count: open.length })}</span>
        <span className="fw-shd-chips">
          {open.map((row) => (
            <Pill key={row.id} tone="neutral">
              {row.number}
            </Pill>
          ))}
        </span>
        {gone.length > 0 && <p className="fw-sh-hint">{t('holds.bulk.gone', { count: gone.length, numbers: gone.map((row) => row.number).join(', ') })}</p>}
      </div>
    </DepthDialog>
  )
}
