'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { CircleHelp, Package, Settings2, ShieldAlert, UserRound, Wrench, type LucideIcon } from 'lucide-react'
import { Pill, SWATCHES, Tag, TagGlyph } from '@nexus/ui/primitives'
import type { CallKind, CallStatus } from '@nexus/factory-domain/production/calls/rules'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Call } from '../api'
import { CALLS_NAMESPACE, durationPhrase, KIND_SWATCH, STATUS_TONE, typeLabel, type Phrase } from '../model'

/** Says a phrase of this page (`help-calls`). */
export const say = (t: (key: string, params?: Readonly<Record<string, string | number>>) => string, phrase: Phrase | null | undefined): string => (phrase ? t(phrase.key, phrase.params) : '—')

export function useCallsT() {
  return useT(CALLS_NAMESPACE)
}

const KIND_ICON: Readonly<Record<CallKind, LucideIcon>> = { MACHINE: Wrench, MATERIAL: Package, QUALITY: ShieldAlert, SUPERVISOR: UserRound, MAINTENANCE: Settings2, OTHER: CircleHelp }

/** A kind's colour: its DS swatch. */
export const kindColour = (kind: CallKind): string => SWATCHES.find((swatch) => swatch.name === KIND_SWATCH[kind])?.hex ?? 'var(--nds-text-3)'

/**
 * A call's type as icon + word (design cl-queue "type (icon + word: machine, material, quality, supervisor, maintenance)"):
 * the type's own icon and colour from the help-call reason list where it has one, else its kind's; the word in the page's
 * language, the kind under it.
 */
export function TypeCell({ type, withKind = true }: { type: Call['type']; withKind?: boolean }) {
  const t = useCallsT()
  const locale = useLocale()
  const Icon = KIND_ICON[type.kind]
  const colour = type.colour ?? kindColour(type.kind)
  return (
    <span className="fw-cl-type">
      {type.icon ? <TagGlyph icon={type.icon} color={colour} size={16} /> : <Icon size={16} aria-hidden style={{ color: colour }} />}
      <span className="fw-cl-cell">
        <span className="fw-cl-ellipsis">{typeLabel(type, locale)}</span>
        {withKind && <span className="fw-cl-sub">{t(`kind.${type.kind}`)}</span>}
      </span>
    </span>
  )
}

/** A kind as icon + word (the chart's legend, the response times). */
export function KindLabel({ kind }: { kind: CallKind }) {
  const t = useCallsT()
  const Icon = KIND_ICON[kind]
  return (
    <span className="fw-cl-type">
      <Icon size={14} aria-hidden style={{ color: kindColour(kind) }} />
      <span>{t(`kind.${kind}`)}</span>
    </span>
  )
}

export function StatusPill({ status }: { status: CallStatus }) {
  const t = useCallsT()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

/** "Waiting time not counted" (MES-148): the station's time books to an off-standard code while the call is open. */
export function WaitingTag() {
  const t = useCallsT()
  return (
    <Tag tone="info" title={t('waiting.hint')}>
      {t('waiting.tag')}
    </Tag>
  )
}

export function Duration({ seconds, empty }: { seconds: number | null | undefined; empty?: ReactNode }) {
  const t = useCallsT()
  const phrase = durationPhrase(seconds)
  return <span className="fw-cl-num">{phrase ? say(t, phrase) : (empty ?? '—')}</span>
}

// ---- the elapsed time of an open call ---------------------------------------------------------------------------------------

const TICK_MS = 15_000
let clockNow = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  if (!timer) {
    clockNow = Date.now()
    timer = setInterval(() => {
      clockNow = Date.now()
      for (const each of listeners) each()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
// Before the clock runs, the moment cut to the tick: the same value on every read until the next tick (React asks twice).
const snapshot = () => (timer ? clockNow : (clockNow = Math.floor(Date.now() / TICK_MS) * TICK_MS))

/**
 * OpenFor — the time a call has been open, in words that move on by themselves ("open 7 min"), warning-toned once it
 * waits longer than the site's limit (design cl-queue "opened (Countdown since)"). Composed here and NAMED: the DS
 * Countdown counts down to an instant only (it says "now" from zero on) and FloorElapsed is the floor's numeral-sized
 * clock, so neither fits a grid cell. One shared 15-second clock for the page; `now` fixes the moment (design cases).
 */
export function OpenFor({ sentAt, waitingMinutes, now }: { sentAt: string; waitingMinutes: number; now?: number }) {
  const t = useCallsT()
  const live = useSyncExternalStore(subscribe, snapshot, () => now ?? Date.parse(sentAt))
  const at = now ?? live
  const seconds = Math.max(0, Math.floor((at - Date.parse(sentAt)) / 1000))
  const late = seconds >= waitingMinutes * 60
  return (
    <span className={late ? 'fw-cl-open late' : 'fw-cl-open'} title={late ? t('open.lateHint', { minutes: waitingMinutes }) : undefined}>
      {t('open.for', { time: say(t, durationPhrase(seconds < 60 ? seconds : Math.floor(seconds / 60) * 60)) })}
    </span>
  )
}
