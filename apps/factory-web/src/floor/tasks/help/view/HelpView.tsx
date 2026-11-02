'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Camera, Check, CircleAlert, ClipboardPen, Flag, HardHat, House, MessageSquarePlus, Package, ShieldAlert, ShieldCheck, TriangleAlert, Users, WifiOff, Wrench, X } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { FloorActionBar, FloorButton, FloorTile, FloorTileGrid, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { Modal, Textarea, Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { ProblemState, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import type { CallType, HelpCall, HelpStation } from '../api'
import { callTone, callWords, comingOf, DANGER_AFTER_MS, detailsHeld, followUpOf, isKnownRefusal, NOTE_MAX, progressOf, WARN_AFTER_MS, type QueuedCall, type Who } from '../model'
import '../help.css'

/**
 * SCR-172 — Floor › Call for help (B-W2b-70; design floor.help, MES-142, -143, -145): one job per screen inside the floor
 * frame, tablet first, centred.
 *
 *   Who do you need?  the site's call types (icon + colour + word): one tap sends; station and person are known. A tile with
 *                     an open call or one still on this tablet shows it, never a second call. Offline, honestly: the call
 *                     waits on this tablet, so call out loud or use the line lamp
 *   Your call         type, sent time, the elapsed time big, who acknowledged ("Paolo · Line 1 team · on the way")
 *   Who is coming     Sent → Seen → On the way → Solved, with times
 *   Add details       words added to the open call (call first, explain after); the photo held with its reason
 *   Cancel this call? a confirm that names who is on the way; Enter keeps the call
 *
 * Never money. The view fetches nothing: the container (Help.tsx) reads and maps.
 */

export type HelpStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'tiles' }
  | { readonly kind: 'call'; readonly callId: string; readonly cancelling?: boolean; readonly done?: 'details' | null }
  | { readonly kind: 'queued'; readonly clientEventId: string; readonly typeId: string; readonly ticks: TickState; readonly refusal: Refusal | null }
  | { readonly kind: 'details'; readonly callId: string; readonly words: string; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'closed'; readonly clientEventId: string; readonly what: 'SOLVED' | 'CANCELLED'; readonly type: string; readonly ticks: TickState; readonly refusal: Refusal | null }
  | { readonly kind: 'problem'; readonly problem: TaskProblem }

interface Refusal {
  readonly code: string
  readonly message: string
}

export interface HelpViewModel {
  readonly frame: FrameModel
  readonly online: boolean
  readonly step: HelpStep
  readonly station: HelpStation | null
  /** The station as this tablet read it, with the time (offline). */
  readonly asOf: string | null
  /** The calls saved on this tablet and not yet recorded. */
  readonly queued: readonly QueuedCall[]
  readonly timeZone?: string
}

export type HelpAction =
  | { type: 'tile'; typeId: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'solved' }
  | { type: 'askCancel' }
  | { type: 'keep' }
  | { type: 'cancel' }
  | { type: 'details' }
  | { type: 'words'; text: string }
  | { type: 'sendDetails' }
  | { type: 'machine' }

export interface HelpViewProps {
  model: HelpViewModel
  onAction?: (action: HelpAction) => void
  onFrame?: (action: FrameAction) => void
}

/** A call type's icon: its code's, by kind where the site chose none. */
function callIcon(type: Pick<CallType, 'kind' | 'code'>): ReactNode {
  if (type.code === 'SAFETY') return <ShieldAlert />
  switch (type.kind) {
    case 'MATERIAL':
      return <Package />
    case 'QUALITY':
      return <ShieldCheck />
    case 'MACHINE':
    case 'MAINTENANCE':
      return <Wrench />
    case 'SUPERVISOR':
      return <Flag />
    default:
      return <HardHat />
  }
}

const STATUS_TONE: Readonly<Record<HelpCall['status'], FloorTone>> = { SENT: 'warning', SEEN: 'info', ON_THE_WAY: 'info', SOLVED: 'success', CANCELLED: 'neutral' }

/** A person the card may name, or "the office" for an office colleague (the floor reads no user table). */
const whoWords = (who: Who, t: Translate): string => who.name ?? t(who.office ? 'who.office' : 'who.someone')

function refusalOf(t: Translate, refusal: Refusal | TaskProblem | null | undefined): { message: string; fix: string | null } | null {
  if (!refusal) return null
  const code = 'code' in refusal ? refusal.code : ''
  if (isKnownRefusal(code)) return { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) }
  return 'message' in refusal && refusal.message ? { message: refusal.message, fix: null } : null
}

export function HelpView({ model, onAction, onFrame }: HelpViewProps) {
  const t = useT('floor-help')
  const locale = useLocale()
  const send = (action: HelpAction) => onAction?.(action)
  const { step, station, online } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const backAction = { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'quiet' as const }
  let actions: FloorActions | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'loading':
      body = <FloorState tone="info" icon={<Users />} title={t('loading')} busy />
      break

    case 'tiles': {
      const here = station?.station ?? null
      body = (
        <div className="fw-floor-stack">
          {model.asOf ? <TaskLine tone="warning" icon={<WifiOff />}>{t('asOf', { time: time(model.asOf) })}</TaskLine> : null}
          {!online ? <TaskLine tone="warning" icon={<WifiOff />} alert>{t('offline')}</TaskLine> : null}
          {!here ? <TaskLine tone="warning" icon={<CircleAlert />}>{t('held.noStation')}</TaskLine> : null}
          <section className="fw-floor-section" aria-labelledby="fw-hp-types">
            <h2 id="fw-hp-types" className="fw-floor-subtitle">
              {t('tiles.title')}
            </h2>
            {(station?.tiles.length ?? 0) === 0 ? (
              <p className="fw-floor-lead">{t('tiles.none')}</p>
            ) : (
              <FloorTileGrid label={t('tiles.title')} columns={3}>
                {station!.tiles.map((tile) => {
                  const waiting = model.queued.some((call) => call.typeId === tile.type.id)
                  return (
                    <FloorTile
                      key={tile.type.id}
                      icon={callIcon(tile.type)}
                      label={callWords(tile.type, locale)}
                      hint={tile.open ? t(`status.${tile.open.status}`) : waiting ? t('tiles.waiting') : t('tiles.oneTap')}
                      tone={tile.open || waiting ? 'warning' : callTone(tile.type)}
                      heldReason={here ? null : t('held.noStation')}
                      onPress={() => send({ type: 'tile', typeId: tile.type.id })}
                    />
                  )
                })}
              </FloorTileGrid>
            )}
          </section>
        </div>
      )
      break
    }

    case 'call': {
      const call = station?.open.find((entry) => entry.id === step.callId) ?? null
      if (!call) {
        body = <FloorState tone="success" icon={<Check />} title={t('call.gone')} />
        actions = [{ label: t('action.tiles'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
        break
      }
      body = <CallCard call={call} step={step} asOf={model.asOf} online={online} send={send} t={t} locale={locale} time={time} />
      actions = [backAction, { label: t('action.cancel'), icon: <X />, variant: 'secondary', onPress: () => send({ type: 'askCancel' }) }, { label: t('action.solved'), icon: <Check />, variant: 'success', onPress: () => send({ type: 'solved' }) }]
      break
    }

    case 'queued': {
      const type = station?.tiles.find((tile) => tile.type.id === step.typeId)?.type
      const words = type ? callWords(type, locale) : t('card.kind')
      const refused = step.ticks === 'refused'
      body = refused ? (
        <FloorState tone="danger" icon={<CircleAlert />} title={refusalOf(t, step.refusal)?.message ?? t('queued.refused')} alert>
          <p className="fw-floor-card-code">{words}</p>
          <p className="fw-floor-state-text">{refusalOf(t, step.refusal)?.fix ?? t('queued.refusedFix')}</p>
        </FloorState>
      ) : (
        <FloorState tone={online ? 'info' : 'warning'} icon={online ? <Users /> : <WifiOff />} title={t('queued.title', { type: words })} alert={!online}>
          <p className="fw-hp-ticks">
            <Ticks state={step.ticks} />
          </p>
          <p className="fw-floor-state-text">{online ? t('queued.sending') : t('offline')}</p>
        </FloorState>
      )
      actions = [{ label: t('action.tiles'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'back' }) }]
      break
    }

    case 'details': {
      const heldKey = detailsHeld(step.words, online)
      const refusal = step.problem?.kind === 'refused' ? refusalOf(t, step.problem) : null
      body = (
        <div className="fw-floor-stack">
          <section className="fw-floor-section" aria-labelledby="fw-hp-details">
            <h2 id="fw-hp-details" className="fw-floor-subtitle">
              {t('details.title')}
            </h2>
            <p className="fw-floor-muted">{t('details.lead')}</p>
            <Field label={t('details.words')} htmlFor="fw-hp-words">
              <Textarea id="fw-hp-words" value={step.words} rows={3} limit={NOTE_MAX} maxLength={NOTE_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
            </Field>
          </section>
          <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={t('held.photo')} onClick={() => undefined}>
            {t('details.photo')}
          </FloorButton>
          {!online ? <TaskLine tone="warning" icon={<WifiOff />}>{t('held.detailsOffline')}</TaskLine> : null}
          {refusal ? <TaskLine tone="danger" icon={<CircleAlert />} alert>{refusal.message}</TaskLine> : step.problem ? <TaskLine tone="danger" icon={<CircleAlert />} alert>{t('details.failed')}</TaskLine> : null}
        </div>
      )
      actions = [backAction, { label: t('details.send'), icon: <MessageSquarePlus />, heldReason: heldKey ? t(`held.details.${heldKey}`) : null, onPress: () => send({ type: 'sendDetails' }) }]
      break
    }

    case 'closed': {
      const refused = step.ticks === 'refused'
      body = refused ? (
        <FloorState tone="danger" icon={<CircleAlert />} title={refusalOf(t, step.refusal)?.message ?? t('queued.refused')} alert>
          <p className="fw-floor-state-text">{refusalOf(t, step.refusal)?.fix ?? t('queued.refusedFix')}</p>
        </FloorState>
      ) : (
        <FloorState tone={step.what === 'SOLVED' ? 'success' : 'info'} icon={<Check />} title={t(`closed.${step.what}`, { type: step.type })}>
          <p className="fw-hp-ticks">
            <Ticks state={step.ticks} />
          </p>
        </FloorState>
      )
      actions = [{ label: t('action.tiles'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'back' }) }, { label: t('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    }

    case 'problem':
      body = <ProblemState problem={step.problem} words={(code) => (isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null)} />
      actions = [{ label: t('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar actions={actions} label={t('title')} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}

/** Your call and Who is coming; the follow-up of its type; Cancel this call? */
function CallCard({ call, step, asOf, online, send, t, locale, time }: { call: HelpCall; step: Extract<HelpStep, { kind: 'call' }>; asOf: string | null; online: boolean; send: (action: HelpAction) => void; t: Translate; locale: Locale; time: (value: string) => string }) {
  const ds = useDsWords()
  const coming = comingOf(call)
  const name = coming ? whoWords(coming.who, t) : null
  const follow = followUpOf(call.type)
  return (
    <div className="fw-floor-stack">
      <FloorCard
        icon={callIcon(call.type)}
        kind={t('card.kind')}
        code={callWords(call.type, locale)}
        status={{ label: t(`status.${call.status}`), tone: STATUS_TONE[call.status] }}
        facts={[
          { id: 'station', label: t('fact.station'), value: `${call.station.code} · ${call.station.name}` },
          { id: 'sent', label: t('fact.sent'), value: time(call.sentAt) },
          { id: 'who', label: t('fact.who'), value: coming ? [name, coming.team, t(`status.${coming.step}`)].filter(Boolean).join(' · ') : t('fact.nobody') },
        ]}
        asOf={asOf}
        formatTime={time}
        labels={ds.floorCard}
      >
        <div className="fw-hp-elapsed">
          <FloorElapsed since={call.sentAt} label={t('card.elapsed')} warnAfterMs={WARN_AFTER_MS} dangerAfterMs={DANGER_AFTER_MS} size="lg" labels={ds.floorElapsed} />
        </div>
      </FloorCard>
      {step.done === 'details' ? <TaskLine tone="success" icon={<Check />}>{t('details.done')}</TaskLine> : null}
      {call.note ? <p className="fw-hp-note">{call.note}</p> : null}
      <section className="fw-floor-section" aria-labelledby="fw-hp-progress">
        <h2 id="fw-hp-progress" className="fw-floor-subtitle">
          {t('progress.title')}
        </h2>
        <Timeline
          className="fw-hp-progress"
          label={t('progress.title')}
          steps={progressOf(call).map((row) => ({
            key: row.step,
            label: t(`progress.${row.step}`),
            tone: row.at ? 'success' : 'neutral',
            at: row.at,
            detail: row.by ? whoWords(row.by, t) : undefined,
          }))}
        />
      </section>
      <div className="fw-hp-more">
        <FloorButton size="lg" variant="secondary" icon={<MessageSquarePlus />} heldReason={online ? null : t('held.detailsOffline')} onClick={() => send({ type: 'details' })}>
          {t('action.details')}
        </FloorButton>
        {follow === 'machine' ? (
          <FloorButton size="lg" variant="secondary" icon={<ClipboardPen />} onClick={() => send({ type: 'machine' })}>
            {t('action.machine')}
          </FloorButton>
        ) : follow === 'incident' ? (
          <FloorButton size="lg" variant="secondary" icon={<TriangleAlert />} heldReason={t('held.incident')} onClick={() => undefined}>
            {t('action.incident')}
          </FloorButton>
        ) : null}
      </div>
      <Modal open={Boolean(step.cancelling)} onClose={() => send({ type: 'keep' })} title={t('cancel.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">{coming ? t('cancel.coming', { name: name ?? '' }) : t('cancel.nobody')}</p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="danger" icon={<X />} onClick={() => send({ type: 'cancel' })}>
              {t('cancel.confirm')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<Check />} autoFocus onClick={() => send({ type: 'keep' })}>
              {t('cancel.keep')}
            </FloorButton>
          </div>
        </div>
      </Modal>
    </div>
  )
}
