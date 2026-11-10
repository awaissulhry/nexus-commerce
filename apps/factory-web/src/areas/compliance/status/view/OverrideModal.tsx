'use client'

import { Field } from '@nexus/ui/components'
import { GateExplainer } from '@nexus/ui/components/GateExplainer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, StepUpModal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { latestUntil, marketName, OVERRIDE_REASON_MAX, overrideProblems, overrideSendHeld, romeDay, untilOf } from '../model'
import type { StatusActions, StatusModel } from './types'

/**
 * pop:cs-override — "Override a gate" (design compliance.status; PRD-272), from a Gate refusals row, for the roles the requirement
 * names only: what the gate refused and why (the DS GateExplainer), a written reason (required, 10 to 2000 characters), the last
 * day it holds (at most the requirement's days, never more than 7; the end of that day in Rome, or the latest moment allowed),
 * the scope (this work order / shipment only) and where the override is listed. The primary says what it does ("Override for
 * WO-0142 until 21/11/2026, 23:59"); a fresh authenticator code (the DS StepUpModal) is asked when the API asks for it; ⌘Enter
 * sends. A refusal of the API is said in our words; the feed reads again.
 */
export function OverrideModal({ model, actions }: { model: StatusModel; actions?: StatusActions | undefined }) {
  const t = useT('compliance-status')
  const ds = useDsWords()
  const locale = useLocale()
  const state = model.override
  if (!state) return null
  const { event, draft } = state
  const now = new Date(model.now)
  const maxDays = event.requirement.overrideMaxDays
  const latest = latestUntil(now, maxDays)
  const problems = overrideProblems(draft, now, maxDays)
  const held = overrideSendHeld(draft, now, maxDays, state.busy)
  const until = !problems.day ? untilOf(draft.day, now, maxDays) : null
  const number = event.subject.number ?? event.requirement.code
  const kind = event.subject.type === 'Shipment' ? 'Shipment' : 'WorkOrder'
  const subject = t(`subject.${kind}`)
  // Inside a sentence: "this work order".
  const subjectInText = t(`subjectInText.${kind}`)
  const markets = model.board.status === 'ready' ? model.board.value.markets : []
  const what = [event.style?.code, event.colourway, event.size, event.marketCode ? marketName(event.marketCode, markets, locale) : null].filter(Boolean).join(' · ')
  const shown = (field: 'reason' | 'day') => (state.touched.includes(field) && problems[field] ? t(problems[field]!) : undefined)
  const send = () => {
    if (held) {
      actions?.onOverrideTouch?.('reason')
      actions?.onOverrideTouch?.('day')
      return
    }
    actions?.onOverrideSend?.()
  }
  return (
    <>
      <Modal
        open
        onClose={() => actions?.onOverride?.(null)}
        title={t('override.title', { number })}
        size="lg"
        footer={
          <>
            <Button onClick={() => actions?.onOverride?.(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" heldReason={held && held !== 'override.held.busy' ? t(held) : null} onClick={send} aria-keyshortcuts="Meta+Enter Control+Enter">
              {state.busy ? <Spinner size={12} /> : null} {until ? t('override.send', { number, until: formatDateTime(until.toISOString(), { locale }) }) : t('override.sendPlain', { number })}
            </Button>
          </>
        }
      >
        <div
          className="fw-cs-dialog"
          onKeyDown={(keyEvent) => {
            if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key === 'Enter') {
              keyEvent.preventDefault()
              send()
            }
          }}
        >
          <GateExplainer
            title={t('override.gate', { gate: t(`gate.${event.gate}`), subject, number })}
            rule={what ? t('override.what', { what }) : undefined}
            checks={[
              {
                id: event.id,
                state: 'fail',
                label: `${event.requirement.name} (${event.requirement.code})`,
                reason: event.reason,
                ...(event.requirement.legalReference ? { law: { law: event.requirement.legalReference, plain: t('override.lawPlain') } } : {}),
              },
            ]}
            override={{ label: t('override.scope', { subject: subjectInText, number }), who: event.requirement.overrideRoleKeys.join(', '), how: t('override.how', { count: Math.min(maxDays, 7) }) }}
            headingLevel={3}
            labels={ds.gateExplainer}
            lawLabels={ds.lawRef}
          />
          {state.problem ? (
            <p className="fw-cs-note fw-cs-problem" role="alert">
              {t(state.problem)}
            </p>
          ) : null}
          <Field label={t('override.reason')} required hint={t('override.reasonHint', { max: OVERRIDE_REASON_MAX })} error={shown('reason')} htmlFor="cs-override-reason">
            <Textarea id="cs-override-reason" rows={4} value={draft.reason} maxLength={OVERRIDE_REASON_MAX} onChange={(change) => actions?.onOverrideDraft?.({ reason: change.target.value })} onBlur={() => actions?.onOverrideTouch?.('reason')} />
          </Field>
          <Field label={t('override.until')} required hint={t('override.untilHint', { latest: formatDateTime(latest.toISOString(), { locale }), count: Math.min(maxDays, 7) })} error={shown('day')}>
            <DateField
              value={draft.day}
              min={romeDay(now)}
              max={romeDay(latest)}
              ariaLabel={t('override.until')}
              onChange={(day) => {
                actions?.onOverrideDraft?.({ day })
                actions?.onOverrideTouch?.('day')
              }}
            />
          </Field>
          <p className="fw-cs-hint">{t('override.scopeLine', { subject: subjectInText, number })}</p>
          <p className="fw-cs-hint">{t('override.listed')}</p>
          <p className="fw-cs-hint">{t('override.refusedAt', { at: formatDate(event.at, { locale }) })}</p>
        </div>
      </Modal>
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={t('stepUp.sentence', { number })}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpCode?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </>
  )
}
