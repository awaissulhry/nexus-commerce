'use client'

import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { containmentHoursOf, containmentSaveHeld, containmentSpan } from '../../model'
import { NoticeLine, useNcrWords } from '../../parts'
import type { ListDialog, NcrListActions } from '../view-model'

/**
 * The containment time (B-W2b-17; B-W2a-47 decision 3 made a setting: QualitySettings.defaultContainmentHours): how many
 * hours after a problem is found an NCR's containment is due when nobody says otherwise — the company's own, or the
 * tenant-wide one, else 24 hours. Everyone who sees NCRs reads it; quality.settings.manage changes it (held with the
 * reason otherwise). The NCRs already raised keep their due time.
 */
export function ContainmentTimeDialog({ dialog, offline, actions }: { dialog: Extract<ListDialog, { kind: 'containmentTime' }>; offline: boolean; actions?: NcrListActions }) {
  const { t, say } = useNcrWords()
  const answer = dialog.answer
  const settings = answer?.settings ?? null
  const held = dialog.problem ? 'containmentTime.readFailed' : !answer ? 'containmentTime.heldReading' : containmentSaveHeld({ mayChange: answer.mayChange, settings, draft: dialog.draft, offline })
  const hours = containmentHoursOf(dialog.draft)
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('containmentTime.title')}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} disabled={dialog.busy} onClick={() => actions?.onSubmitContainmentTime?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-hint">{t('containmentTime.intro')}</p>
        <NoticeLine notice={dialog.notice} />
        {dialog.problem ? (
          <Banner tone="warning" title={t('containmentTime.readFailed')}>
            <Button size="sm" onClick={() => actions?.onRetryContainmentTime?.()}>
              {t('common.retry')}
            </Button>
          </Banner>
        ) : !settings ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('containmentTime.reading')}
          </p>
        ) : (
          <>
            <p className="fw-ncr-row" aria-live="polite">
              <strong>{say(containmentSpan(settings.inForce.hours))}</strong>
              <span className="fw-q-hint">{t(`containmentTime.source.${settings.inForce.source}`)}</span>
            </p>
            <Checkbox
              checked={dialog.draft.follow}
              disabled={!answer?.mayChange}
              onChange={(event) => actions?.onContainmentDraft?.({ follow: event.target.checked })}
              label={t(settings.companyId ? 'containmentTime.followTenant' : 'containmentTime.followDefault')}
            />
            <Field label={t('containmentTime.hours')} hint={hours !== undefined && hours !== null ? (say(containmentSpan(hours)) ?? undefined) : t('containmentTime.hoursHint')}>
              <Input
                size="sm"
                inputMode="numeric"
                value={dialog.draft.hours}
                disabled={dialog.draft.follow || !answer?.mayChange}
                maxLength={3}
                aria-invalid={!dialog.draft.follow && hours === undefined ? true : undefined}
                onChange={(event) => actions?.onContainmentDraft?.({ hours: event.target.value })}
              />
            </Field>
            {!answer?.mayChange && <p className="fw-q-hint">{t('containmentTime.heldNoRight')}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
