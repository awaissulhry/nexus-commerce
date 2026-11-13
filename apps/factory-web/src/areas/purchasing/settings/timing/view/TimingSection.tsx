'use client'

import { Field } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { ReminderSettings } from '../../api'
import type { Scope } from '../../model'
import { NS } from '../../view/parts'
import { chaseWordsKey, timingChanged, timingHeld, timingInForce, timingProblems, type TimingDraft } from '../model'

export interface TimingSectionModel {
  readonly settings: ReminderSettings
  readonly scope: Scope
  /** What is typed (null: not read yet). */
  readonly draft: TimingDraft | null
  readonly offline: boolean
  readonly busy: boolean
  /** ⌘S saves the timing (the page gives it to one bar at a time). */
  readonly shortcut: boolean
}

export interface TimingSectionActions {
  onTiming?: (draft: TimingDraft) => void
  onDiscardTiming?: () => void
  onApplyTiming?: () => void
}

/**
 * The reminders' timing in the Confirmation card (B-W2b-382; SCR-256 cases `w2b-382-*`): "Confirm by" (hours, 1–720) and
 * "Remind every" (days, 1–30) on the scope's row — empty follows every company's, else the default — each with what holds
 * now and where it comes from; the chase of late lines in words (OFF: the daily run sends no reminder and no chase; by hand
 * still goes). The Owner's: anyone else reads it as text with why. EditModeBar (⌘S) when something changed.
 */
export function TimingSection({ model, actions }: { model: TimingSectionModel; actions?: TimingSectionActions | undefined }) {
  const t = useT(NS)
  const { settings, scope } = model
  const draft = model.draft
  const inForce = timingInForce(settings)
  const problems = draft ? timingProblems(draft) : {}
  const changed = draft !== null && timingChanged(settings, scope, draft)
  const held = draft ? timingHeld(settings, scope, draft, model.offline, model.busy) : null
  const followHint = scope === 'company' ? t('timing.followCompany') : t('timing.followAll')
  const editable = settings.mayChange && draft !== null
  return (
    <section className="fw-pus-stack" aria-label={t('timing.title')}>
      <Field label={t('timing.hours')} hint={`${t(inForce.hours.key, inForce.hours.params)} ${editable ? followHint : ''}`.trim()} error={problems.hours ? t(problems.hours, { min: 1, max: 720 }) : undefined}>
        {editable ? (
          <Input inputMode="numeric" size="sm" value={draft.hours} placeholder={t('timing.empty')} aria-label={t('timing.hours')} disabled={model.busy} onChange={(event) => actions?.onTiming?.({ ...draft, hours: event.target.value })} />
        ) : (
          <p className="fw-pus-value">{t(inForce.hours.key, inForce.hours.params)}</p>
        )}
      </Field>
      <Field label={t('timing.days')} hint={`${t(inForce.days.key, inForce.days.params)} ${editable ? followHint : ''}`.trim()} error={problems.days ? t(problems.days, { min: 1, max: 30 }) : undefined}>
        {editable ? (
          <Input inputMode="numeric" size="sm" value={draft.days} placeholder={t('timing.empty')} aria-label={t('timing.days')} disabled={model.busy} onChange={(event) => actions?.onTiming?.({ ...draft, days: event.target.value })} />
        ) : (
          <p className="fw-pus-value">{t(inForce.days.key, inForce.days.params)}</p>
        )}
      </Field>
      {!settings.mayChange && <p className="fw-pus-held">{t(scope === 'all' ? 'timing.held.noRightAll' : 'timing.held.noRight')}</p>}
      <p className="fw-pus-hint">{t(chaseWordsKey(settings.on), { days: inForce.days.params.days ?? 1, count: inForce.days.params.days ?? 1 })}</p>
      {changed && (
        <EditModeBar
          count={1}
          busy={model.busy}
          applyHeldReason={held && held !== 'timing.held.busy' ? t(held) : null}
          applyLabel={t('timing.apply')}
          onDiscard={() => actions?.onDiscardTiming?.()}
          onApply={() => actions?.onApplyTiming?.()}
          saveShortcut={model.shortcut}
        />
      )}
    </section>
  )
}
