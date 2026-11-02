'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Coffee, CheckCheck, CircleAlert, CloudOff, Clock, IdCard, LogIn, LogOut, Lock, Pause, RotateCcw, ScanLine, TriangleAlert, Users, X } from 'lucide-react'
import { FloorActionBar, FloorButton, PinPad, ScanInput, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import type { KeptRefusal } from '../kept'
import { barOf, KNOWN_REFUSALS, todayClock, flagsOf, type ClockAction, type ClockView, type OpenItem, type Receipt } from '../model'
import '../clock.css'

/**
 * SCR-170 — Clock in & out (design floor.clock; MES-223, MES-224, MES-239, MES-199, MES-117; B-W2b-33's API): the person's
 * own time today (the confirmation shows the time and the hours so far), Break out and in or fixed breaks deducted, a
 * badge scanned here clocks at once, Forgot your badge (name → PIN, flagged for the team leader), offline with the
 * tablet's time, and what a clock-out paused. Nobody signed in, it is a kiosk: a badge clocks, the person's answer
 * stays a few seconds and the next person scans. While the site's ATTENDANCE gate is off the page stays closed and says
 * why (Statuto dei Lavoratori art. 4 c.2-3); no biometrics: a badge, or a name and PIN (Garante; GDPR art. 9). One person's
 * own time, never a list, no money. The API's words are English: the screen says its own from the fields.
 */

export type ClockStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'closed' }
  /** The person holds no floor role here (the API's 403). */
  | { readonly kind: 'noRole' }
  | { readonly kind: 'unavailable' }
  /** Signed in: the person's time (null: offline, nothing read on this tablet). `asOf`: read earlier on this tablet. */
  | { readonly kind: 'mine'; readonly view: ClockView | null; readonly readAt: number; readonly asOf: string | null }
  /** Nobody signed in: a badge clocks. */
  | { readonly kind: 'kiosk' }
  | { readonly kind: 'names' }
  | { readonly kind: 'pin'; readonly name: string }
  /** Offline, a badge read: the tablet cannot know which it is. */
  | { readonly kind: 'choose' }

export interface ClockViewModel {
  frame: FrameModel
  step: ClockStep
  online: boolean
  receipt?: Receipt | null
  /** A queued action of the person signed in, where it stands. */
  ticks?: TickState | null
  /** "Clock out?": the bundles that will be paused. */
  confirm?: readonly string[] | null
  /** The work the last clock-out paused, or will pause while the worker has not got to it. */
  paused?: readonly OpenItem[]
  willPause?: readonly string[]
  busy?: boolean
  /** Workers for Forgot your badge (A–Z); a phone has no such button (only its person signs in). */
  roster?: readonly { id: string; name: string }[]
  forgot?: boolean
  pinProblem?: 'wrong' | 'rateLimited' | 'unavailable' | null
  /** Clockings kept at this kiosk: waiting, and the ones the office refused. */
  kept?: { waiting: number; available: boolean; refused: readonly KeptRefusal[] }
  timeZone?: string
}

export type ClockAct =
  | { type: 'action'; action: ClockAction }
  | { type: 'scan'; code: string }
  | { type: 'confirm' }
  | { type: 'cancel-confirm' }
  | { type: 'forgot' }
  | { type: 'name'; workerId: string }
  | { type: 'pin'; pin: string }
  | { type: 'back' }
  | { type: 'choose'; action: 'IN' | 'OUT' }
  | { type: 'retry' }
  | { type: 'dismiss-kept'; clientEventId: string }
  | { type: 'sign-in' }

const ACTION_ICON: Readonly<Record<ClockAction, ReactNode>> = { IN: <LogIn />, OUT: <LogOut />, BREAK_OUT: <Coffee />, BREAK_IN: <RotateCcw /> }

const refusalKnown = (code: string): boolean => (KNOWN_REFUSALS as readonly string[]).includes(code)

/** "4 h 12 min" in the screen's words. */
export function durationWords(t: Translate, minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? t('duration.hours', { hours, minutes: rest }) : t('duration.minutes', { minutes: rest })
}

export function ClockScreen({ model, onAction, onFrame }: { model: ClockViewModel; onAction?: (action: ClockAct) => void; onFrame?: (action: FrameAction) => void }) {
  const t = useT('floor-clock')
  const send = (action: ClockAct) => onAction?.(action)
  const { step } = model
  const bar = barActions(t, model, send)
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={bar ? <FloorActionBar label={t('bar')} actions={bar} /> : undefined}>
      <div className="fw-floor-stack fw-clock">
        {step.kind === 'loading' ? <FloorState tone="info" icon={<Clock />} title={t('loading')} busy /> : null}
        {step.kind === 'closed' ? <Closed /> : null}
        {step.kind === 'noRole' ? <FloorState tone="info" icon={<Lock />} title={t('noRole.title')} text={t('noRole.body')} /> : null}
        {step.kind === 'unavailable' ? <FloorState tone="warning" icon={<CircleAlert />} title={t('unavailable.title')} text={t('unavailable.body')} alert /> : null}
        {step.kind === 'mine' ? <Mine model={model} step={step} send={send} /> : null}
        {step.kind === 'kiosk' ? <Kiosk model={model} send={send} /> : null}
        {step.kind === 'names' ? <Names model={model} send={send} /> : null}
        {step.kind === 'pin' ? <Pin model={model} name={step.name} send={send} /> : null}
        {step.kind === 'choose' ? <Choose model={model} send={send} /> : null}
      </div>
      <Modal open={Boolean(model.confirm)} onClose={() => send({ type: 'cancel-confirm' })} title={t('confirm.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <Pause />
            </span>
            {model.confirm?.length === 1 ? t('confirm.one', { bundle: model.confirm[0]! }) : t('confirm.many', { count: model.confirm?.length ?? 0, bundles: (model.confirm ?? []).join(', ') })}
          </p>
          <p className="fw-floor-dialog-line fw-floor-muted">{t('confirm.next')}</p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'cancel-confirm' })}>
              {t('confirm.cancel')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<LogOut />} autoFocus onClick={() => send({ type: 'confirm' })}>
              {t('action.OUT')}
            </FloorButton>
          </div>
        </div>
      </Modal>
    </FloorFrameView>
  )
}

/** The big bar of the step; the main action last. */
function barActions(t: Translate, model: ClockViewModel, send: (action: ClockAct) => void): FloorActions | null {
  const { step } = model
  const held = model.busy ? t('held.busy') : null
  const back: FloorAction = { label: t('back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  switch (step.kind) {
    case 'mine': {
      // The main action last; a Clock out that is the main one asks a second look (it ends the day): the warning colour.
      const buttons = barOf(step.view).map((action): FloorAction => ({ label: t(`action.${action}`), icon: ACTION_ICON[action], onPress: () => send({ type: 'action', action }), heldReason: held, ...(action === 'OUT' && step.view !== null ? { variant: 'warning' as const } : {}) }))
      return buttons as unknown as FloorActions
    }
    case 'kiosk':
      return [{ label: t('toSignIn'), icon: <ArrowLeft />, onPress: () => send({ type: 'sign-in' }), variant: 'secondary' }]
    case 'names':
    case 'pin':
    case 'choose':
      return [back]
    case 'closed':
      return model.frame.operator ? null : [{ label: t('toSignIn'), icon: <ArrowLeft />, onPress: () => send({ type: 'sign-in' }), variant: 'secondary' }]
    case 'unavailable':
      return [{ label: t('retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
    default:
      return null
  }
}

/** The ATTENDANCE gate is off at this site: nothing to do here, and why in words (never a dead tile, never a person read). */
function Closed() {
  const t = useT('floor-clock')
  return (
    <FloorState tone="info" icon={<Lock />} title={t('closed.title')} text={t('closed.body')}>
      <p className="fw-floor-muted">{t('closed.fix')}</p>
    </FloorState>
  )
}

function ReceiptLine({ receipt, ticks, model }: { receipt: Receipt; ticks?: TickState | null; model: ClockViewModel }) {
  const t = useT('floor-clock')
  const locale = useLocale()
  const time = (iso: string) => formatTime(iso, { locale, timeZone: model.timeZone })
  switch (receipt.kind) {
    case 'recorded': {
      const done = receipt.repeated ? t('receipt.repeated', { time: time(receipt.at) }) : t(`receipt.${receipt.action}`, { time: time(receipt.at) })
      return (
        <TaskLine tone="success" icon={<CheckCheck />} alert>
          {receipt.name ? t('receipt.named', { name: receipt.name, done }) : done}
          {receipt.flags.includes('FORGOT_BADGE') ? ` ${t('flag.FORGOT_BADGE')}` : ''}
        </TaskLine>
      )
    }
    case 'saved':
      return (
        <div className="fw-floor-stack">
          <TaskLine tone="info" icon={<CloudOff />} alert>
            {t('receipt.saved', { time: time(receipt.at) })}
          </TaskLine>
          {receipt.clockWrong ? (
            <TaskLine tone="warning" icon={<TriangleAlert />}>
              {t('flag.CLOCK_SKEW')}
            </TaskLine>
          ) : null}
          {ticks ? <Ticks state={ticks} /> : null}
        </div>
      )
    case 'refused': {
      const known = refusalKnown(receipt.code)
      return (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {known ? t(`refusal.${receipt.code}.message`) : receipt.message}
          {known ? ` ${t(`refusal.${receipt.code}.fix`)}` : receipt.fix ? ` ${receipt.fix}` : ''}
        </TaskLine>
      )
    }
    case 'wrong':
      return (
        <TaskLine tone="danger" icon={<CircleAlert />} alert>
          {t('receipt.wrong')}
        </TaskLine>
      )
    case 'notBadge':
      return (
        <TaskLine tone="warning" icon={<ScanLine />} alert>
          {t('receipt.notBadge')}
        </TaskLine>
      )
    case 'rateLimited':
      return (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {t('receipt.rateLimited')}
        </TaskLine>
      )
    case 'unavailable':
      return (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {t('receipt.unavailable')}
        </TaskLine>
      )
  }
}

function ScanBadge({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  return (
    <ScanInput
      label={t('scan.label')}
      hideLabel
      acceptTyped={false}
      scannedLabel={() => t('scan.read')}
      hint={t('scan.hint')}
      disabled={model.busy}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )
}

function Forgot({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  if (!model.forgot) return null
  return (
    <div className="fw-floor-row-actions">
      <FloorButton size="md" variant="secondary" icon={<Users />} heldReason={model.online ? null : t('forgot.offline')} onClick={() => send({ type: 'forgot' })}>
        {t('forgot.button')}
      </FloorButton>
      {model.online ? null : <p className="fw-floor-muted">{t('forgot.offline')}</p>}
    </div>
  )
}

function Mine({ model, step, send }: { model: ClockViewModel; step: Extract<ClockStep, { kind: 'mine' }>; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  const locale = useLocale()
  const ds = useDsWords()
  const { view } = step
  const place = { locale, timeZone: model.timeZone }
  const time = (iso: string) => formatTime(iso, place)
  const range = (from: string, to: string) => `${time(from)}–${time(to)}`
  const stateLabel = view ? t(`state.${view.state}`) : t('state.unknown')
  const tone = view?.state === 'IN' ? 'success' : view?.state === 'ON_BREAK' ? 'warning' : 'neutral'
  const today = view ? t('today', { time: durationWords(t, view.minutes.worked) }) : null
  const head = !view ? t('head.unknown') : view.state === 'IN' && view.inSince ? t('head.IN', { time: time(view.inSince) }) : view.state === 'ON_BREAK' && view.breakSince ? t('head.ON_BREAK', { time: time(view.breakSince) }) : t('head.OUT')
  const clock = view ? todayClock(view, step.readAt) : null
  const flags = view ? flagsOf(view.events) : []
  return (
    <>
      {model.receipt ? <ReceiptLine receipt={model.receipt} ticks={model.ticks} model={model} /> : null}
      <div className="fw-floor-card-words">
        <FloorCard
          icon={<Clock />}
          kind={t('card.kind')}
          code={head}
          title={today}
          status={{ label: stateLabel, tone }}
          facts={
            view
              ? [
                  { id: 'shift', label: t('fact.shift'), value: view.shift ? [view.shift.label, range(view.shift.startsAt, view.shift.endsAt)].filter(Boolean).join(' · ') : null },
                  { id: 'break', label: t('fact.break'), value: view.breaks.mode === 'FIXED' && view.breaks.next ? t('fixedBreak', { time: range(view.breaks.next.startsAt, view.breaks.next.endsAt) }) : null },
                  { id: 'auto', label: t('fact.auto'), value: view.autoClockOutAt ? time(view.autoClockOutAt) : null },
                ]
              : []
          }
          flags={[
            ...(view?.forgottenSince ? [{ id: 'forgotten', label: t('flag.forgotten', { when: formatDateTime(view.forgottenSince, place) }), tone: 'warning' as const }] : []),
            ...flags.map((flag) => ({ id: flag, label: t(`flag.${flag}`), tone: 'warning' as const })),
          ]}
          asOf={step.asOf}
          formatTime={time}
          labels={ds.floorCard}
        >
          {clock ? (
            <div className="fw-clock-today">
              <FloorElapsed label={t('elapsed')} since={clock.since} carriedMs={clock.carriedMs} paused={clock.paused} precision="minutes" size="md" labels={ds.floorElapsed} />
            </div>
          ) : null}
        </FloorCard>
      </div>
      {!view ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('offline.unknown')}
        </TaskLine>
      ) : null}
      {view?.state !== 'OUT' && view?.breaks.mode === 'CLOCKED' && view.breaks.due ? (
        <TaskLine tone="warning" icon={<Coffee />}>
          {t('breakDue')} <LawRef law="D.Lgs. 66/2003 art. 8" plain={t('breakLaw')} labels={ds.lawRef} />
        </TaskLine>
      ) : null}
      {model.paused && model.paused.length > 0 ? <OpenWorkCard items={model.paused} /> : null}
      {(!model.paused || model.paused.length === 0) && model.willPause && model.willPause.length > 0 ? (
        <TaskLine tone="info" icon={<Pause />}>
          {model.willPause.length === 1 ? t('confirm.one', { bundle: model.willPause[0]! }) : t('confirm.many', { count: model.willPause.length, bundles: model.willPause.join(', ') })}
        </TaskLine>
      ) : null}
      <ScanBadge model={model} send={send} />
      <Forgot model={model} send={send} />
      {step.asOf ? (
        <p className="fw-floor-muted">{t('offline.asOf', { day: formatDate(step.asOf, place), time: time(step.asOf) })}</p>
      ) : null}
    </>
  )
}

/** "B-000123 at Op 30 paused.": the next sign-in offers to continue (MES-117). */
function OpenWorkCard({ items }: { items: readonly OpenItem[] }) {
  const t = useT('floor-clock')
  const ds = useDsWords()
  return (
    <div className="fw-floor-card-words">
      <FloorCard
        icon={<Pause />}
        kind={t('open.kind')}
        code={t('open.code', { count: items.length })}
        status={{ label: t('open.status'), tone: 'info' }}
        flags={items.map((item) => ({ id: item.bundleId, label: t('open.item', { bundle: item.bundleCode, seq: item.operation.seq }), tone: 'info' as const }))}
        labels={ds.floorCard}
      >
        <p className="fw-floor-muted">{t('open.next')}</p>
      </FloorCard>
    </div>
  )
}

function KeptLines({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  const locale = useLocale()
  const kept = model.kept
  if (!kept) return null
  return (
    <>
      {kept.waiting > 0 ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('kept.waiting', { count: kept.waiting })}
        </TaskLine>
      ) : null}
      {kept.refused.map((entry) => (
        <div key={entry.clientEventId} className="fw-floor-notice fw-floor-notice-card" data-tone="warning">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <TriangleAlert />
          </span>
          <span className="fw-floor-notice-card-text">
            <strong>{t('kept.refused', { what: t(`action.${entry.action}`), time: formatTime(entry.occurredAt, { locale, timeZone: model.timeZone }) })}</strong>
            <span>{t('kept.refusedFix')}</span>
          </span>
          <FloorButton size="md" variant="secondary" icon={<X />} onClick={() => send({ type: 'dismiss-kept', clientEventId: entry.clientEventId })}>
            {t('kept.dismiss')}
          </FloorButton>
        </div>
      ))}
    </>
  )
}

function Kiosk({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  return (
    <>
      {model.receipt ? <ReceiptLine receipt={model.receipt} model={model} /> : null}
      <div className="fw-clock-hero">
        <div className="fw-floor-hero" aria-hidden="true">
          <IdCard />
        </div>
        <h1 className="fw-floor-section-title fw-floor-center-text">{t('kiosk.title')}</h1>
        <p className="fw-floor-lead fw-floor-center-text">{t('kiosk.body')}</p>
      </div>
      <ScanBadge model={model} send={send} />
      <Forgot model={model} send={send} />
      <KeptLines model={model} send={send} />
    </>
  )
}

function Names({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  const locale = useLocale()
  const ds = useDsWords()
  const people = model.roster ?? []
  if (people.length === 0) return <FloorState tone="info" icon={<Users />} title={t('forgot.emptyTitle')} text={t('forgot.empty')} />
  return (
    <>
      <p className="fw-floor-muted">{t('forgot.flagged')}</p>
      <FloorNamePicker label={t('forgot.title')} people={people} locale={locale} headingLevel={2} heldReason={model.online ? null : t('forgot.offline')} labels={ds.floorNamePicker} onPick={(id) => send({ type: 'name', workerId: id })} />
    </>
  )
}

function Pin({ model, name, send }: { model: ClockViewModel; name: string; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  return (
    <div className="fw-floor-stack fw-floor-center">
      <h1 className="fw-floor-section-title fw-floor-center-text">{t('pin.title')}</h1>
      <p className="fw-floor-lead fw-floor-center-text">{t('pin.forName', { name })}</p>
      <PinPad
        key="clock"
        label={t('pin.title')}
        hideLabel
        enteredLabel={(entered, total) => t('pin.entered', { entered, total })}
        clearLabel={t('pin.clear')}
        backLabel={t('pin.backspace')}
        busy={model.busy}
        message={model.pinProblem ? t(`pin.problem.${model.pinProblem}`) : undefined}
        messageTone="danger"
        autoFocus
        onSubmit={(pin) => send({ type: 'pin', pin })}
      />
    </div>
  )
}

/** Offline the tablet cannot know the person's state: they say which; the office keeps it as the tablet recorded it. */
function Choose({ model, send }: { model: ClockViewModel; send: (action: ClockAct) => void }) {
  const t = useT('floor-clock')
  const available = model.kept?.available !== false
  return (
    <>
      <h1 className="fw-floor-section-title fw-floor-center-text">{t('choose.title')}</h1>
      {available ? (
        <p className="fw-floor-lead fw-floor-center-text">{t('choose.body')}</p>
      ) : (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {t('choose.notKept')}
        </TaskLine>
      )}
      <div className="fw-clock-choice">
        <FloorButton size="lg" variant="primary" block icon={<LogIn />} heldReason={available ? (model.busy ? t('held.busy') : null) : t('choose.notKept')} onClick={() => send({ type: 'choose', action: 'IN' })}>
          {t('action.IN')}
        </FloorButton>
        <FloorButton size="lg" variant="secondary" block icon={<LogOut />} heldReason={available ? (model.busy ? t('held.busy') : null) : t('choose.notKept')} onClick={() => send({ type: 'choose', action: 'OUT' })}>
          {t('action.OUT')}
        </FloorButton>
      </div>
    </>
  )
}
