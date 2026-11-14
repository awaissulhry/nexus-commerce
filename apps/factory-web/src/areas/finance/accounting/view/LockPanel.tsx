'use client'

import { Lock, LockOpen } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useAccountingWords } from '../checks/words'
import { hardOpenHeld } from '../hard-lock/model'
import { HardLockDialog } from '../hard-lock/view/HardLockDialog'
import { liftHeld, lockHeld, lockStateOf, monthWords, warningKey, type AccountingCan } from '../model'
import type { LockActions, LockDialogModel, LockPanelModel } from '../view-model'

/**
 * The period lock of one month (design finance.accounting sec:step-export "Lock period: soft (finance may override with
 * a reason) or hard (typed phrase)"; Owner answer P1: a typed phrase only for the monthly run and the final month close):
 * the month's lock now in words; Soft or Hard as two cards; Hard opens "Close <month> for good?" (B-W2b-426, pop:hard-lock:
 * the phrase typed — either language, as the API takes it — then a fresh code); after a soft lock what a hard lock would
 * still wait for. In the dialog, a lock in force can be lifted with a reason (a hard one by accounting.unlock, with a
 * fresh authenticator code).
 */
export function LockPanel({ model, can, actions, withLift = false }: { model: LockPanelModel; can: AccountingCan; actions?: LockActions; withLift?: boolean }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const month = model.month
  const current = model.current ?? null
  const state = lockStateOf(current)
  // B-W2b-426: Hard opens the pop-up (its button holds until the phrase matches); Soft locks from here.
  const held = model.level === 'HARD' ? hardOpenHeld({ month, current, can, busy: model.busy }) : lockHeld({ month, level: model.level, phrase: model.phrase, current, can, busy: model.busy })
  const label = month ? monthWords(month, locale) : ''
  const lifted = liftHeld(current, model.liftReason, can, model.liftBusy)
  const hardOnly = current?.status === 'LOCKED' && current.level === 'SOFT'
  return (
    <div className="fw-fac-lock">
      {month && model.current === undefined ? (
        <p className="fw-fac-muted" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      ) : month ? (
        <p className="fw-fac-muted">
          {current && current.status === 'LOCKED'
            ? t(`lock.now.${state}`, { month: label, by: current.lockedBy.name ?? t('history.someone'), at: formatDateTime(current.lockedAt, { locale }) })
            : current && current.status === 'UNLOCKED'
              ? t('lock.now.lifted', { month: label, by: current.unlockedBy?.name ?? t('history.someone'), at: current.unlockedAt ? formatDateTime(current.unlockedAt, { locale }) : '—' })
              : t('lock.now.open', { month: label })}
        </p>
      ) : null}
      {model.done ? (
        <Banner tone="success" title={t(model.done.lock.level === 'HARD' ? 'lock.done.hard' : 'lock.done.soft', { month: monthWords(model.done.lock.period.month, locale) })}>
          {model.done.warnings.length > 0 ? (
            <>
              <span>{t('lock.done.warnings')}</span>
              <ul className="fw-fac-list">
                {model.done.warnings.map((code) => (
                  <li key={code}>{t(warningKey(code))}</li>
                ))}
              </ul>
            </>
          ) : model.done.lock.level === 'SOFT' ? (
            <span>{t('lock.done.softBody')}</span>
          ) : (
            <span>{t('lock.done.hardBody')}</span>
          )}
        </Banner>
      ) : (
        <>
          <div className="fw-fac-cards" role="radiogroup" aria-label={t('lock.level')}>
            <RadioCard
              name={`fw-fac-lock-${month ?? 'none'}`}
              title={t('lock.soft.title')}
              description={hardOnly ? t('lock.soft.already') : t('lock.soft.body')}
              checked={model.level === 'SOFT'}
              selected={model.level === 'SOFT'}
              onChange={() => actions?.onLockLevel?.('SOFT')}
            />
            <RadioCard
              name={`fw-fac-lock-${month ?? 'none'}`}
              title={t('lock.hard.title')}
              description={t('lock.hard.body', { month: label })}
              checked={model.level === 'HARD'}
              selected={model.level === 'HARD'}
              onChange={() => actions?.onLockLevel?.('HARD')}
            />
          </div>
          {model.level === 'SOFT' && (
            <Field label={t('lock.note')}>
              <Textarea value={model.note} maxLength={1000} rows={2} onChange={(event) => actions?.onLockNote?.(event.target.value)} />
            </Field>
          )}
          {model.problem && !model.hardOpen && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
          <div className="fw-fac-actions">
            <Button size="sm" variant={model.level === 'HARD' ? 'danger' : 'primary'} heldReason={held ? t(held.key, held.params) : undefined} onClick={() => (model.level === 'HARD' ? actions?.onHardOpen?.() : actions?.onLock?.())}>
              <Lock size={13} aria-hidden /> {model.level === 'HARD' ? t('lock.hard.go', { month: label }) : t('lock.soft.go', { month: label })}
            </Button>
            {model.busy && !model.hardOpen && (
              <span className="fw-fac-muted" role="status">
                <Spinner size={12} /> {t('common.working')}
              </span>
            )}
          </div>
        </>
      )}
      {model.hardOpen && <HardLockDialog model={model} can={can} actions={actions} />}
      {withLift && current?.status === 'LOCKED' && !model.done && (
        <div className="fw-fac-lift">
          <h3 className="fw-fac-h3">{t('lift.title')}</h3>
          <p className="fw-fac-muted">{t(current.level === 'HARD' ? 'lift.hardBody' : 'lift.softBody')}</p>
          {model.lifted ? (
            <Banner tone="success" title={t('lift.done', { month: label })} />
          ) : (
            <>
              <Field label={t('lift.reason')} required>
                <Textarea value={model.liftReason} maxLength={1000} rows={2} onChange={(event) => actions?.onLiftReason?.(event.target.value)} />
              </Field>
              {model.liftProblem && <Banner tone="danger" title={t(model.liftProblem.key, model.liftProblem.params)} />}
              <div className="fw-fac-actions">
                <Button size="sm" variant="danger" heldReason={lifted ? t(lifted.key) : undefined} onClick={() => actions?.onLift?.()}>
                  <LockOpen size={13} aria-hidden /> {t('lift.go', { month: label })}
                </Button>
                {model.liftBusy && (
                  <span className="fw-fac-muted" role="status">
                    <Spinner size={12} /> {t('common.working')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** ⋯ Lock a period (and a band pill): the month chosen, then the same lock panel, with lifting. Esc closes. */
export function LockDialog({ model, can, actions, onClose }: { model: LockDialogModel; can: AccountingCan; actions?: LockActions; onClose?: () => void }) {
  const t = useAccountingWords()
  const locale = useLocale()
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={model.month ? t('lock.dialogTitle', { month: monthWords(model.month, locale) }) : t('lock.dialogTitleAny')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => onClose?.()}>
            {model.done || model.lifted ? t('common.done') : t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-fac-dialog">
        <Field label={t('lock.month')}>
          <Select value={model.month ?? ''} onChange={(event) => event.target.value && actions?.onLockMonth?.(event.target.value)}>
            <option value="">{t('lock.chooseMonth')}</option>
            {model.months.map((entry) => (
              <option key={entry.month} value={entry.month}>
                {`${monthWords(entry.month, locale)} · ${t(`lockState.${entry.state}`)}`}
              </option>
            ))}
          </Select>
        </Field>
        {model.readProblem && <Banner tone="danger" title={t('lock.readFailed')}>{t(model.readProblem)}</Banner>}
        <p className="fw-fac-muted">{t('lock.accountant')}</p>
        {model.month && <LockPanel model={model} can={can} actions={actions} withLift />}
      </div>
    </Modal>
  )
}
