'use client'

import { Check, CircleAlert, Heart, Lightbulb, Lock, Mic, TriangleAlert, UserRound, WifiOff, X } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { FloorButton } from '@nexus/ui/floor'
import { Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { CaptureStep } from '../../tasks/machine/view/MediaParts'
import { TaskLine, Ticks, type TickState } from '../../tasks/shared/view/TaskParts'
import { SUGGESTION_KINDS, SUGGESTION_MAX, suggestionHeld, type SuggestionDraft, type SuggestionKind } from '../model'
import '../../basket/help/help2.css'
import '../me.css'

/**
 * owb-fl8 step 4 — "Tell the office" (design § 5zf B; P/fplus.js fplusModal 'fsay'): what it is about (an idea · something is wrong ·
 * thank you: one tap), words or a voice note, then **Send with my name** or **Send without my name**. Without the name nothing names
 * the worker, and it goes only with the network. A named one with no network waits on this phone (one tick → two ticks).
 */

export type TellStep =
  | { readonly kind: 'draft'; readonly recording?: boolean; readonly busy?: boolean; readonly failed?: string | null }
  | { readonly kind: 'sent'; readonly ticks: TickState | null }

export type TellAction =
  | { readonly type: 'kind'; readonly kind: SuggestionKind }
  | { readonly type: 'words'; readonly text: string }
  | { readonly type: 'record' }
  | { readonly type: 'voice'; readonly blob: Blob }
  | { readonly type: 'dropVoice' }
  | { readonly type: 'cancelVoice' }
  | { readonly type: 'send'; readonly withName: boolean }
  | { readonly type: 'close' }

const KIND_ICON: Readonly<Record<SuggestionKind, typeof Lightbulb>> = { IDEA: Lightbulb, WRONG: TriangleAlert, THANKS: Heart }

export function TellOfficeWindow({ open, step, draft, online, onAction }: { open: boolean; step: TellStep; draft: SuggestionDraft; online: boolean; onAction: (action: TellAction) => void }) {
  const t = useT('floor-help2')
  const machine = useT('floor-machine')
  const send = (action: TellAction) => onAction(action)
  const heldWith = suggestionHeld(draft, online, true)
  const heldWithout = suggestionHeld(draft, online, false)
  const busy = step.kind === 'draft' && step.busy === true
  const heldWords = (held: ReturnType<typeof suggestionHeld>) => (busy ? t('window.sending') : held ? t(`tell.held.${held}`) : null)

  let body
  if (step.kind === 'sent') {
    body = (
      <>
        <TaskLine tone="success" icon={<Check />}>
          {t('tell.sent')}
        </TaskLine>
        {step.ticks ? (
          <p className="fw-h2-ticks">
            <Ticks state={step.ticks} />
          </p>
        ) : null}
      </>
    )
  } else if (step.recording) {
    body = <CaptureStep kind="AUDIO" title={t('tell.voice')} t={machine} onPhoto={() => undefined} onVoice={(blob) => send({ type: 'voice', blob })} onCancel={() => send({ type: 'cancelVoice' })} />
  } else {
    body = (
      <>
        <p className="fw-floor-subtitle">{t('tell.what')}</p>
        <div className="fw-h2-actions" role="group" aria-label={t('tell.what')}>
          {SUGGESTION_KINDS.map((kind) => {
            const Icon = KIND_ICON[kind]
            return (
              <FloorButton key={kind} size="lg" variant={draft.kind === kind ? 'primary' : 'secondary'} icon={<Icon />} aria-pressed={draft.kind === kind} onClick={() => send({ type: 'kind', kind })}>
                {t(`tell.kind.${kind}`)}
              </FloorButton>
            )
          })}
        </div>
        <Field label={t('tell.words')} htmlFor="fw-me-tell-words">
          <Textarea id="fw-me-tell-words" value={draft.words} rows={3} limit={SUGGESTION_MAX} maxLength={SUGGESTION_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
        </Field>
        {draft.voice ? (
          <div className="fw-h2-actions">
            <span className="fw-h2-chip" data-tone="success">
              <Mic aria-hidden />
              {t('tell.voiceTaken', { count: draft.voice.seconds })}
            </span>
            <FloorButton variant="quiet" icon={<X />} onClick={() => send({ type: 'dropVoice' })}>
              {t('tell.dropVoice')}
            </FloorButton>
          </div>
        ) : (
          <FloorButton size="lg" variant="secondary" icon={<Mic />} heldReason={online ? null : t('media.offline')} onClick={() => send({ type: 'record' })}>
            {t('tell.voice')}
          </FloorButton>
        )}
        {!online ? (
          <TaskLine tone="warning" icon={<WifiOff />}>
            {t('tell.offline')}
          </TaskLine>
        ) : null}
        {step.failed ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {step.failed}
          </TaskLine>
        ) : null}
        <div className="fw-h2-actions" role="group" aria-label={t('tell.sendGroup')}>
          <FloorButton size="lg" variant="primary" icon={<UserRound />} heldReason={heldWords(heldWith)} onClick={() => send({ type: 'send', withName: true })}>
            {t('tell.withName')}
          </FloorButton>
          <FloorButton size="lg" variant="secondary" icon={<Lock />} heldReason={heldWords(heldWithout)} onClick={() => send({ type: 'send', withName: false })}>
            {t('tell.withoutName')}
          </FloorButton>
        </div>
        {heldWith && heldWith !== 'voiceOffline' ? <p className="fw-floor-muted">{t(`tell.held.${heldWith}`)}</p> : null}
        <p className="fw-floor-muted">{t('tell.privacy')}</p>
      </>
    )
  }

  return (
    <Modal
      open={open}
      onClose={() => send({ type: 'close' })}
      title={t('tell.title')}
      size="md"
      sheet
      className="fw-floor-dialog"
      closeHeld={busy ? t('window.sending') : null}
      footer={
        <FloorButton size="lg" variant="quiet" icon={<X />} heldReason={busy ? t('window.sending') : null} onClick={() => send({ type: 'close' })}>
          {t('window.close')}
        </FloorButton>
      }
    >
      <div className="fw-h2-window">{body}</div>
    </Modal>
  )
}
