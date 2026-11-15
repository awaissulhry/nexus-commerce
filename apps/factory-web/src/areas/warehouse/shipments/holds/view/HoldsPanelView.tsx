'use client'

import { CircleAlert, CircleCheck, Hand } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Pill, RadioCard } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { Hold, Holds } from '../api'
import { HOLD_WORDS_MAX, inForce, placeHeld, placeProblem, reasonChoices, releasedByWords, releaseHeld, releaseProblem, type HoldsPanelActions, type HoldsPanelModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-592 — the shipment's holds inside "Ready to ship" (design sh-ready "W2b: no hold (credit, deposit or balance, quality,
 * customer request)"; Owner rule W2b-6: a held shipment says who may release it). The check "No hold" (ok, or open with the
 * reasons in force), each hold in force with its words, since when, who placed it (a person's name inside this one record,
 * or the system: the balance before shipping, the account on hold, over the credit limit) and who releases it; Release
 * asks the words why; Place a hold picks one of the reasons the API offers (Other needs words); the released ones behind a
 * disclosure. A money hold or the system's is released by finance only: the button says so.
 */
export function HoldsPanelView({ model, actions }: { model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <HoldsPanel model={model} actions={actions} />
    </WithMessages>
  )
}

function HoldsPanel({ model, actions }: { model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  const { t, say } = useDepthWords()
  if (model.holds.state !== 'ready') {
    return (
      <section className="fw-shd-holds" aria-label={t('holds.title')}>
        <PartRead problem={model.holds.state === 'error' ? model.holds.problem : null} onRetry={actions?.onRetry} label={t('holds.title')} />
      </section>
    )
  }
  const holds = model.holds.value
  const live = inForce(holds)
  const released = holds.holds.filter((hold) => !hold.inForce)
  const placeBlocked = placeHeld(holds, model.can, model.busy)
  const open = holds.status === 'DRAFT' || holds.status === 'PACKED'
  return (
    <section className="fw-shd-holds" aria-label={t('holds.title')}>
      <ul className="fw-sh-checks">
        <li className="fw-sh-check" data-state={live.length > 0 ? 'open' : 'ok'}>
          {live.length > 0 ? <CircleAlert size={16} aria-hidden className="fw-sh-check-icon" /> : <CircleCheck size={16} aria-hidden className="fw-sh-check-icon" />}
          <span className="fw-sh-check-text">
            <strong>{t('holds.check')}</strong>
            <span>{live.length > 0 ? t('holds.checkOpen', { reasons: [...new Set(live.map((hold) => t(`holdReason.${hold.reason}`)))].join(', ') }) : t('holds.checkOk')}</span>
          </span>
        </li>
      </ul>
      {live.length > 0 && (
        <ul className="fw-shd-hold-list" aria-label={t('holds.inForce')}>
          {live.map((hold) => (
            <HoldRow key={hold.id} hold={hold} model={model} actions={actions} />
          ))}
        </ul>
      )}
      {model.done && <p className="fw-sh-hint" role="status">{say(model.done)}</p>}
      {open && (
        <span className="fw-sh-inline">
          <Button size="sm" heldReason={say(placeBlocked)} onClick={() => actions?.onDialog?.({ kind: 'place', reason: null, text: '' })}>
            <Hand size={14} aria-hidden /> {t('holds.place')}
          </Button>
        </span>
      )}
      {released.length > 0 && (
        <details className="fw-sh-details">
          <summary>{t('holds.released', { count: released.length })}</summary>
          <ul className="fw-shd-hold-list">
            {released.map((hold) => (
              <HoldRow key={hold.id} hold={hold} model={model} actions={actions} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/** The holds' dialogs (Place a hold, Release), drawn by the record whatever tab is open (⋯ "Place a hold…" opens one anywhere). */
export function HoldsDialogsView({ model, actions }: { model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <HoldsDialogs model={model} actions={actions} />
    </WithMessages>
  )
}

function HoldsDialogs({ model, actions }: { model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  if (model.holds.state !== 'ready') return null
  if (model.dialog?.kind === 'place') return <PlaceDialog holds={model.holds.value} model={model} actions={actions} />
  if (model.dialog?.kind === 'release') return <ReleaseDialog holds={model.holds.value} model={model} actions={actions} />
  return null
}

function HoldRow({ hold, model, actions }: { hold: Hold; model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const blocked = releaseHeld(hold, model.can, model.busy)
  return (
    <li className="fw-shd-hold">
      <span className="fw-shd-hold-head">
        <Pill tone={hold.inForce ? 'danger' : 'neutral'}>{t(`holdReason.${hold.reason}`)}</Pill>
        <span className="fw-sh-cell-sub">{hold.bySystem ? t('holds.bySystem') : t('holds.byPerson', { name: hold.placedBy ?? t('holds.someone') })}</span>
      </span>
      {hold.words && <span className="fw-shd-hold-words">{hold.words}</span>}
      <span className="fw-sh-cell-sub">{t('holds.since', { when: formatDateTime(hold.placedAt, { locale }) })}</span>
      {hold.inForce ? (
        <span className="fw-shd-hold-foot">
          <span className="fw-sh-cell-sub">{say(releasedByWords(hold))}</span>
          <Button size="sm" variant="quiet" heldReason={say(blocked)} onClick={() => actions?.onDialog?.({ kind: 'release', holdId: hold.id, text: '' })} aria-label={t('holds.releaseOf', { reason: t(`holdReason.${hold.reason}`) })}>
            {t('holds.release')}
          </Button>
        </span>
      ) : (
        <span className="fw-sh-cell-sub">
          {t('holds.releasedLine', { when: hold.releasedAt ? formatDateTime(hold.releasedAt, { locale }) : '—', who: hold.releasedBySystem ? t('holds.theSystem') : (hold.releasedBy ?? t('holds.someone')) })}
          {hold.releaseWords ? ` · ${hold.releaseWords}` : ''}
        </span>
      )}
    </li>
  )
}

function PlaceDialog({ holds, model, actions }: { holds: Holds; model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  const { t, say } = useDepthWords()
  if (model.dialog?.kind !== 'place') return null
  const dialog = model.dialog
  const choices = reasonChoices(holds)
  const problem = placeProblem(dialog, choices)
  const required = choices.find((choice) => choice.reason === dialog.reason)?.wordsRequired ?? false
  return (
    <DepthDialog
      title={t('holds.placeTitle', { number: holds.number })}
      held={model.busy ? t('holds.held.busy') : say(problem)}
      onGo={() => actions?.onPlace?.()}
      goLabel={dialog.reason ? t('holds.placeGo', { reason: t(`holdReason.${dialog.reason}`) }) : t('holds.place')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <p className="fw-sh-hint">{t('holds.placeBody')}</p>
      <fieldset className="fw-shd-choices">
        <legend className="fw-sh-h3">{t('holds.reason')}</legend>
        {choices.map((choice) => (
          <RadioCard
            key={choice.reason}
            name="hold-reason"
            value={choice.reason}
            checked={dialog.reason === choice.reason}
            selected={dialog.reason === choice.reason}
            onChange={() => actions?.onDialog?.({ ...dialog, reason: choice.reason })}
            title={t(`holdReason.${choice.reason}`)}
            description={choice.releasedBy === 'shipping.holds.release' ? t('holds.releasedBy.finance') : t('holds.releasedBy.warehouse')}
          />
        ))}
      </fieldset>
      {choices.length < holds.reasonChoices.length && <p className="fw-sh-hint">{t('holds.alreadyHeld')}</p>}
      <Field label={required ? t('holds.wordsRequired') : t('holds.wordsOptional')} hint={t('holds.wordsHint')}>
        <Textarea rows={3} limit={HOLD_WORDS_MAX} value={dialog.text} onChange={(event) => actions?.onDialog?.({ ...dialog, text: event.target.value })} />
      </Field>
    </DepthDialog>
  )
}

function ReleaseDialog({ holds, model, actions }: { holds: Holds; model: HoldsPanelModel; actions?: HoldsPanelActions }) {
  const { t, say } = useDepthWords()
  if (model.dialog?.kind !== 'release') return null
  const dialog = model.dialog
  const hold = holds.holds.find((entry) => entry.id === dialog.holdId)
  if (!hold) return null
  const others = inForce(holds).filter((entry) => entry.id !== hold.id)
  return (
    <DepthDialog
      title={t('holds.releaseTitle', { reason: t(`holdReason.${hold.reason}`) })}
      subtitle={holds.number}
      held={model.busy ? t('holds.held.busy') : say(releaseProblem(dialog))}
      onGo={() => actions?.onRelease?.()}
      goLabel={t('holds.release')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      {hold.bySystem && <Banner tone="warning" title={t('holds.releaseSystem')} />}
      <p className="fw-sh-hint">{others.length > 0 ? t('holds.stillHeld', { count: others.length }) : t('holds.freeAfter')}</p>
      <Field label={t('holds.why')} required hint={t('holds.whyHint')}>
        <Textarea rows={3} limit={HOLD_WORDS_MAX} value={dialog.text} onChange={(event) => actions?.onDialog?.({ ...dialog, text: event.target.value })} />
      </Field>
    </DepthDialog>
  )
}
