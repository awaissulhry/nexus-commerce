'use client'

import { Lock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useAccountingWords } from '../../checks/words'
import { lockHeld, monthWords, phraseFor, phraseState, warningKey, type AccountingCan } from '../../model'
import type { LockActions, LockPanelModel } from '../../view-model'
import { hardConsequences } from '../model'

/**
 * "Close August 2026 for good?" (design finance.accounting pop:hard-lock, opened from 5 · Export and lock or ⋯ Lock a
 * period; Owner answer P1: a typed phrase for the final month close): what closing means (nothing dated in the month can
 * change; a correction goes in an open month; only the owner lifts it), the phrase typed (`close August 2026` or
 * `chiudi agosto 2026`, case and spaces free, our own state words), a note, the month's problems when the API refuses
 * (every one, in words), then "Close August 2026" — and a fresh authenticator code, asked last. Esc closes and the focus
 * goes back to the opener (the DS Modal; it stacks over the lock dialog).
 */
export function HardLockDialog({ model, can, actions }: { model: LockPanelModel; can: AccountingCan; actions?: LockActions }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const month = model.month
  if (!month) return null
  const label = monthWords(month, locale)
  const current = model.current ?? null
  const softNow = current?.status === 'LOCKED' && current.level === 'SOFT'
  const held = lockHeld({ month, level: 'HARD', phrase: model.phrase, current, can, busy: model.busy })
  const typed = phraseState(month, model.phrase, locale)
  const wanted = phraseFor(month, locale)
  const problems = model.closeProblems
  return (
    <Modal
      open
      onClose={() => actions?.onHardClose?.()}
      closeHeld={model.busy ? t('hard.held.running') : null}
      title={t('hard.title', { month: label })}
      size="md"
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={model.busy ? t('hard.held.running') : undefined} onClick={() => actions?.onHardClose?.()}>
            {t('common.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="danger" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onLock?.()}>
            <Lock size={13} aria-hidden /> {t('hard.go', { month: label })}
          </Button>
        </>
      }
    >
      <div className="fw-fac-dialog">
        <p className="fw-fac-strong">{t('hard.lead', { month: label })}</p>
        <ul className="fw-fac-list">
          {hardConsequences(label).map((entry) => (
            <li key={entry.key}>{t(entry.key, entry.params)}</li>
          ))}
        </ul>
        {softNow && current ? <p className="fw-fac-muted">{t('lock.now.soft', { month: label, by: current.lockedBy.name ?? t('history.someone'), at: formatDateTime(current.lockedAt, { locale }) })}</p> : null}
        <Field label={t('lock.phrase.label', { phrase: wanted })} hint={t(`lock.phrase.${typed}`)}>
          <Input value={model.phrase} autoFocus autoComplete="off" spellCheck={false} aria-invalid={typed === 'mismatch' || undefined} placeholder={wanted} onChange={(event) => actions?.onLockPhrase?.(event.target.value)} />
        </Field>
        <Field label={t('lock.note')}>
          <Textarea value={model.note} maxLength={1000} rows={2} onChange={(event) => actions?.onLockNote?.(event.target.value)} />
        </Field>
        {problems.length > 0 ? (
          <Banner tone="danger" title={t('hard.problems', { month: label })}>
            <ul className="fw-fac-list">
              {problems.map((code) => (
                <li key={code}>{t(warningKey(code))}</li>
              ))}
            </ul>
          </Banner>
        ) : model.problem ? (
          <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />
        ) : null}
        <p className="fw-fac-muted">{t('hard.code')}</p>
        {model.busy && (
          <p className="fw-fac-muted" role="status">
            <Spinner size={12} /> {t('common.working')}
          </p>
        )}
      </div>
    </Modal>
  )
}
