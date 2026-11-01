'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, BadgeCheck, CircleAlert, CircleHelp, IdCard, Info, KeyRound, Users, X } from 'lucide-react'
import { FloorButton, FloorTile, FloorTileGrid, PinPad, ScanInput, operatorInitials } from '@nexus/ui/floor'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { rosterLetters } from '../../model'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'

/**
 * SCR-021 — floor sign-in (design floor.signin; PLT-057, PLT-058, PLT-062, MES-176, MES-177, MES-182, MES-188): scan
 * your badge (a typed badge is refused: `acceptTyped` off), or pick your name and type your PIN. Where the site lets a
 * badge alone sign in (Owner answer F1 a) the scan is all; elsewhere the PIN pad follows. The screen speaks the
 * device's language until someone signs in, then the person's. Every refusal is one answer (the API names no reason:
 * no oracle), a lock blocks one worker, never the tablet. After an administrator's PIN reset the worker chooses their
 * own PIN here before anything else opens.
 */

export type SignInStep =
  | { kind: 'badge' }
  | { kind: 'names'; letter: string | null }
  /** `forName`: the name picked; null: the badge just scanned. */
  | { kind: 'pin'; forName: string | null }
  /** A new PIN after a reset: the office's PIN (when not typed at sign-in), the new one, then again. */
  | { kind: 'change'; stage: 'current' | 'new' | 'repeat' }

export type SignInProblem = 'wrong' | 'rateLimited' | 'unavailable' | 'operatorActive' | 'pinNeeded'
export type ChangeProblem = 'mismatch' | 'refused' | 'wrong' | 'repeat' | 'run' | null
export type SignedOutWhy = 'idle' | 'self' | 'ended' | null

export interface SignInViewModel {
  frame: FrameModel
  step: SignInStep
  /** The site's rule: a badge alone signs in. */
  badgeOnly: boolean
  /** The site's workers with a PIN (names only), A–Z. */
  roster: readonly { id: string; name: string }[]
  problem?: SignInProblem | null
  changeProblem?: ChangeProblem
  busy?: boolean
  /** Why the last person left this screen. */
  signedOut?: SignedOutWhy
  /** A switch of person on a busy station: who is signed in now. */
  switchingFrom?: string | null
  forgotOpen?: boolean
}

export type SignInAction =
  | { type: 'badge'; code: string }
  | { type: 'names' }
  | { type: 'letter'; letter: string | null }
  | { type: 'name'; workerId: string }
  | { type: 'pin'; pin: string }
  | { type: 'back' }
  | { type: 'forgot'; open: boolean }
  | { type: 'change'; pin: string }
  | { type: 'cancel-switch' }

export interface SignInViewProps {
  model: SignInViewModel
  onAction?: (action: SignInAction) => void
  onFrame?: (action: FrameAction) => void
}

export function SignInView({ model, onAction, onFrame }: SignInViewProps) {
  const t = useT('floor')
  const send = (action: SignInAction) => onAction?.(action)
  const { step } = model

  let body: ReactNode
  switch (step.kind) {
    case 'badge':
      body = (
        <div className="fw-floor-stack fw-floor-center">
          <div className="fw-floor-hero" aria-hidden="true">
            <IdCard />
          </div>
          <h1 className="fw-floor-section-title fw-floor-center-text">{t('signIn.badge.title')}</h1>
          <p className="fw-floor-lead fw-floor-center-text">{model.badgeOnly ? t('signIn.badge.alone') : t('signIn.badge.withPin')}</p>
          <ScanInput
            label={t('signIn.badge.label')}
            hideLabel
            acceptTyped={false}
            scannedLabel={() => t('signIn.badge.read')}
            hint={t('signIn.badge.scanOnly')}
            disabled={model.busy}
            onScan={(code) => send({ type: 'badge', code })}
          />
          <FloorButton size="md" variant="secondary" icon={<Users />} onClick={() => send({ type: 'names' })}>
            {t('signIn.badge.noBadge')}
          </FloorButton>
        </div>
      )
      break
    case 'names': {
      const letters = rosterLetters(model.roster)
      const shown = step.letter ? model.roster.filter((entry) => entry.name.trim().toLocaleUpperCase().startsWith(step.letter!)) : model.roster
      body =
        model.roster.length === 0 ? (
          <FloorState tone="info" icon={<Users />} title={t('signIn.names.emptyTitle')} text={t('signIn.names.empty')} />
        ) : (
          <div className="fw-floor-stack">
            <h1 className="fw-floor-section-title">{t('signIn.names.title')}</h1>
            <p className="fw-floor-muted">{t('signIn.names.pinAfter')}</p>
            {letters.length > 1 ? (
              <div role="group" aria-label={t('signIn.names.letters')} className="fw-floor-letters">
                <FloorButton size="sm" variant={step.letter === null ? 'primary' : 'secondary'} aria-pressed={step.letter === null} onClick={() => send({ type: 'letter', letter: null })}>
                  {t('signIn.names.all')}
                </FloorButton>
                {letters.map((letter) => (
                  <FloorButton key={letter} size="sm" variant={step.letter === letter ? 'primary' : 'secondary'} aria-pressed={step.letter === letter} onClick={() => send({ type: 'letter', letter })}>
                    {letter}
                  </FloorButton>
                ))}
              </div>
            ) : null}
            <FloorTileGrid label={t('signIn.names.title')}>
              {shown.map((entry) => (
                <FloorTile key={entry.id} icon={<span className="fw-floor-initials">{operatorInitials(entry.name)}</span>} label={entry.name} onPress={() => send({ type: 'name', workerId: entry.id })} />
              ))}
            </FloorTileGrid>
          </div>
        )
      break
    }
    case 'pin':
      body = (
        <div className="fw-floor-stack fw-floor-center">
          <h1 className="fw-floor-section-title fw-floor-center-text">{model.switchingFrom ? t('signIn.switch.title') : t('signIn.pin.title')}</h1>
          <p className="fw-floor-lead fw-floor-center-text">
            {model.switchingFrom ? t('signIn.switch.body', { name: model.switchingFrom }) : step.forName ? t('signIn.pin.forName', { name: step.forName }) : t('signIn.pin.forBadge')}
          </p>
          <PinPad
            key="sign-in"
            label={t('signIn.pin.label')}
            hideLabel
            enteredLabel={(entered, total) => t('signIn.pin.entered', { entered, total })}
            clearLabel={t('signIn.pin.clear')}
            backLabel={t('signIn.pin.backspace')}
            busy={model.busy}
            message={model.problem ? t(`signIn.problem.${model.problem}`) : undefined}
            messageTone="danger"
            autoFocus
            onSubmit={(pin) => send({ type: 'pin', pin })}
          />
          <div className="fw-floor-row-actions">
            {model.switchingFrom ? (
              <FloorButton size="md" variant="secondary" icon={<X />} onClick={() => send({ type: 'cancel-switch' })}>
                {t('signIn.switch.cancel')}
              </FloorButton>
            ) : (
              <FloorButton size="md" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'back' })}>
                {t('signIn.pin.notYou')}
              </FloorButton>
            )}
            <FloorButton size="md" variant="quiet" icon={<CircleHelp />} aria-haspopup="dialog" onClick={() => send({ type: 'forgot', open: true })}>
              {t('signIn.pin.forgot')}
            </FloorButton>
          </div>
        </div>
      )
      break
    case 'change':
      body = (
        <div className="fw-floor-stack fw-floor-center">
          <h1 className="fw-floor-section-title fw-floor-center-text">{t('signIn.change.title')}</h1>
          <p className="fw-floor-lead fw-floor-center-text">{t(`signIn.change.${step.stage}`)}</p>
          {step.stage !== 'current' ? <p className="fw-floor-muted fw-floor-center-text">{t('signIn.change.rules')}</p> : null}
          <PinPad
            key={`change-${step.stage}`}
            label={t(`signIn.change.${step.stage}`)}
            hideLabel
            enteredLabel={(entered, total) => t('signIn.pin.entered', { entered, total })}
            clearLabel={t('signIn.pin.clear')}
            backLabel={t('signIn.pin.backspace')}
            busy={model.busy}
            message={model.changeProblem ? t(`signIn.change.problem.${model.changeProblem}`) : undefined}
            messageTone="danger"
            autoFocus
            onSubmit={(pin) => send({ type: 'change', pin })}
          />
        </div>
      )
      break
  }

  // Problems of the badge and name steps sit above the job (the PIN step shows its own under the pad).
  const banner =
    step.kind !== 'pin' && step.kind !== 'change' && model.problem ? (
      <p role="alert" className="fw-floor-notice" data-tone="danger">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <CircleAlert />
        </span>
        {t(`signIn.problem.${model.problem}`)}
      </p>
    ) : model.signedOut && step.kind === 'badge' && !model.switchingFrom ? (
      <p role="status" className="fw-floor-notice" data-tone="info">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Info />
        </span>
        {t(`signIn.signedOut.${model.signedOut}`)}
      </p>
    ) : null

  return (
    <FloorFrameView
      frame={model.frame}
      onFrame={onFrame}
      actions={
        step.kind === 'names' ? (
          <div className="fw-floor-bar">
            <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'back' })}>
              {t('signIn.names.back')}
            </FloorButton>
          </div>
        ) : undefined
      }
    >
      {banner}
      {body}
      <Modal open={Boolean(model.forgotOpen)} onClose={() => send({ type: 'forgot', open: false })} title={t('signIn.forgot.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <KeyRound />
            </span>
            {t('signIn.forgot.body')}
          </p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="primary" icon={<BadgeCheck />} onClick={() => send({ type: 'forgot', open: false })}>
              {t('frame.close')}
            </FloorButton>
          </div>
        </div>
      </Modal>
    </FloorFrameView>
  )
}
