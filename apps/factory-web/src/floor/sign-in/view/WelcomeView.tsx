'use client'

import { ArrowRight, Check, CircleAlert, MessageSquareText, Pause, Play, Sparkles } from 'lucide-react'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { FloorActionBar, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'
import type { WelcomeCard } from '../arrival'

/**
 * SCR-021's "Welcome and checks" (design floor.signin; MES-033, MES-117): the handover note of the tablet's line with one
 * Seen, then "Continue bundle B-000123 at Op 30?". Each card has one main action; one job on the screen, nothing else.
 */

export interface WelcomeViewModel {
  frame: FrameModel
  /** The card on screen; null: reading. */
  card: WelcomeCard | null
  busy?: boolean
  /** The resume was refused: the work stays paused. */
  refused?: boolean
}

const TONES = new Set(['danger', 'warning', 'info', 'success', 'neutral'])
const toneOf = (tone: string) => (TONES.has(tone) ? (tone as 'danger' | 'warning' | 'info' | 'success' | 'neutral') : 'neutral')

export function WelcomeView({ model, onAction, onFrame }: { model: WelcomeViewModel; onAction?: (action: 'seen' | 'continue' | 'later') => void; onFrame?: (action: FrameAction) => void }) {
  const t = useT('floor')
  const locale = useLocale()
  const ds = useDsWords()
  const send = (action: 'seen' | 'continue' | 'later') => onAction?.(action)
  const { card } = model
  let actions: FloorActions | null = null
  let body
  if (!card) body = <FloorState tone="info" icon={<Sparkles />} title={t('signIn.welcome.loading')} busy />
  else if (card.kind === 'handover') {
    actions = [{ label: t('signIn.welcome.seen'), icon: <Check />, onPress: () => send('seen') }]
    body = (
      <div className="fw-floor-stack">
        <h1 className="fw-floor-section-title">{card.line ? t('signIn.welcome.handoverLine', { line: card.line }) : t('signIn.welcome.handover')}</h1>
        {card.notes.map((note) => (
          <div key={note.id} className="fw-floor-card-words">
            <FloorCard
              icon={<MessageSquareText />}
              kind={t('signIn.welcome.note')}
              code={`${note.shiftLabel} · ${formatDate(note.shiftDate, { locale })}`}
              flags={note.topics.map((topic) => ({ id: topic.topic, label: locale === 'it' ? topic.labelIt : topic.labelEn, tone: toneOf(topic.tone) }))}
              labels={ds.floorCard}
            >
              {note.text ? <p className="fw-floor-lead">{note.text}</p> : null}
            </FloorCard>
          </div>
        ))}
        <ReadAloudButton text={() => card.notes.flatMap((note) => [...note.topics.map((topic) => (locale === 'it' ? topic.labelIt : topic.labelEn)), note.text ?? '']).filter(Boolean).join('. ')} lang={speechLang(locale)} labels={ds.readAloud} />
      </div>
    )
  } else if (model.refused) {
    actions = [{ label: t('signIn.welcome.onward'), icon: <ArrowRight />, onPress: () => send('later') }]
    body = <FloorState tone="warning" icon={<CircleAlert />} title={t('signIn.welcome.refusedTitle')} text={t('signIn.welcome.refused', { bundle: card.item.bundleCode })} alert />
  } else {
    actions = [
      { label: t('signIn.welcome.later'), icon: <ArrowRight />, onPress: () => send('later'), variant: 'secondary' },
      { label: t('signIn.welcome.continue'), icon: <Play />, onPress: () => send('continue'), heldReason: model.busy ? t('signIn.welcome.resuming') : null },
    ]
    body = (
      <div className="fw-floor-card-words">
        <FloorCard
          icon={<Pause />}
          kind={t('signIn.welcome.pausedKind')}
          code={t('signIn.welcome.continueQuestion', { bundle: card.item.bundleCode, seq: card.item.operation.seq })}
          title={card.item.operation.name}
          status={{ label: t('signIn.welcome.pausedStatus'), tone: 'info' }}
          labels={ds.floorCard}
        />
      </div>
    )
  }
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('signIn.welcome.frameTitle')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}
