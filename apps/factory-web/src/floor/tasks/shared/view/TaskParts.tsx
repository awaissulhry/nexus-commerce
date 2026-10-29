'use client'

import type { ReactNode } from 'react'
import { Check, CheckCheck, CircleAlert, CloudOff, Info, Loader, Lock, RotateCcw, Undo2, WifiOff } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { FloorButton, PinPad, type FloorTone } from '@nexus/ui/floor'
import { Kbd } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { FloorFacts, type FloorFact } from '../../../frame/view/FloorFacts'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../task-api'
import './tasks.css'

/**
 * Parts every floor task screen shares (SCR-090, 093, 094, 095, 097; design 02-sections-floor "The floor frame"). The DS
 * floor kit has no FloorCard, FloorUndoStrip, FloorReasonGrid, PinSignBlock or "two ticks" part yet (design "New DS
 * parts"; packages/ui is frozen): these are the app's stand-ins, composed of DS parts (FloorButton, PinPad,
 * DetailPopover) with layout-only CSS, so the screens look and work the same until the DS gets them.
 *
 *   TaskCard      stand-in for FloorCard: what was scanned, its code big, a status pill, facts at floor size
 *   Ticks         "Saved on this tablet" (one tick) / "Recorded by the office" (two ticks) — never "saved" before it is
 *   UndoStrip     stand-in for FloorUndoStrip: the last action, its ticks, Undo while its window is open
 *   HeldLine      an action that waits for the network, with the reason in words
 *   ReasonGrid    stand-in for FloorReasonGrid: big reason tiles, each tap adds one (reason-first counting)
 *   PinSign       stand-in for PinSignBlock: what the PIN signs, the meaning in words, the DS PinPad
 *   ProblemState  a refusal or failure as a full-screen state (FloorState), never a toast
 *   ListKeys      the floor list's keys in ONE information icon in the list's footer (Owner rule 2026-10-29)
 */

// ---- the card of what was scanned ------------------------------------------------------------------------------------

export function TaskCard({
  icon,
  type,
  code,
  status,
  statusTone,
  facts,
  flags,
  big,
  children,
  id = 'fw-task-card-code',
}: {
  icon: ReactNode
  /** What it is ("Bundle", "Hide"). */
  type: string
  code: string
  status?: string | null
  statusTone?: FloorTone
  facts?: readonly FloorFact[]
  /** Lines between the head and the facts (a flag with icon + word). */
  flags?: ReactNode
  /** A big numeral beside the head (the bundle's quantity, the area left). */
  big?: { value: string; label: string } | null
  children?: ReactNode
  id?: string
}) {
  return (
    <section className="fw-floor-card" aria-labelledby={id}>
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{type}</span>
          <span id={id} className="fw-floor-card-code">
            {code}
          </span>
        </span>
        {big ? (
          <span className="fw-task-big">
            <span className="fw-task-big-value">{big.value}</span>
            <span className="fw-task-big-label">{big.label}</span>
          </span>
        ) : null}
        {status ? (
          <span className="fw-floor-pill" data-tone={statusTone ?? 'neutral'}>
            {status}
          </span>
        ) : null}
      </header>
      {flags}
      {facts && facts.length > 0 ? <FloorFacts facts={facts} /> : null}
      {children}
    </section>
  )
}

/** A short line inside a task with an icon and words (never colour alone). */
export function TaskLine({ tone, icon, children, alert }: { tone: 'info' | 'success' | 'warning' | 'danger'; icon: ReactNode; children: ReactNode; alert?: boolean }) {
  return (
    <p className="fw-floor-notice" data-tone={tone} role={alert ? 'alert' : tone === 'danger' || tone === 'warning' ? 'note' : 'status'}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </p>
  )
}

// ---- the two ticks --------------------------------------------------------------------------------------------------

/** Where an action stands (design "two ticks"): saved here, being sent, recorded by the office, or refused. */
export type TickState = 'saved' | 'sending' | 'recorded' | 'refused'

export function Ticks({ state }: { state: TickState }) {
  const t = useT('floor-tasks')
  const icon = state === 'recorded' ? <CheckCheck /> : state === 'sending' ? <Loader /> : state === 'refused' ? <CircleAlert /> : <Check />
  return (
    <span className="fw-task-ticks" data-state={state}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {icon}
      </span>
      {t(`ticks.${state}`)}
    </span>
  )
}

// ---- the undo strip -------------------------------------------------------------------------------------------------

export function UndoStrip({
  text,
  ticks,
  onUndo,
  undoHeld,
  undoLabel,
  extra,
}: {
  /** The last action, short: "BN-… · Op 30 · 20 good". */
  text: string
  ticks?: TickState | null
  onUndo?: (() => void) | null
  /** Why Undo cannot run now (offline for an online-only undo …). */
  undoHeld?: string | null
  undoLabel?: string
  /** A second action (Ask a correction, after the window). */
  extra?: ReactNode
}) {
  const t = useT('floor-tasks')
  return (
    <div className="fw-task-undo" role="status">
      <span className="fw-task-undo-text">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Undo2 />
        </span>
        <span className="fw-task-undo-what">{text}</span>
        {ticks ? <Ticks state={ticks} /> : null}
      </span>
      <span className="fw-task-undo-actions">
        {extra}
        {onUndo ? (
          <FloorButton size="md" variant="secondary" icon={<RotateCcw />} heldReason={undoHeld ?? null} onClick={onUndo}>
            {undoLabel ?? t('undo.label')}
          </FloorButton>
        ) : null}
      </span>
    </div>
  )
}

// ---- waits for the network --------------------------------------------------------------------------------------------

export function HeldLine({ text }: { text: string }) {
  return (
    <TaskLine tone="warning" icon={<CloudOff />}>
      {text}
    </TaskLine>
  )
}

// ---- reason tiles -----------------------------------------------------------------------------------------------------

export interface ReasonTile {
  readonly code: string
  readonly label: string
  /** How many pieces this reason has now (shown on the tile when > 0). */
  readonly count?: number
}

export function ReasonGrid({ label, reasons, onPick, onRemove, removeLabel, heldReason }: { label: string; reasons: readonly ReasonTile[]; onPick: (code: string) => void; onRemove?: (code: string) => void; removeLabel?: (reason: string) => string; heldReason?: string | null }) {
  return (
    <div className="fw-task-reasons" role="group" aria-label={label}>
      {reasons.map((reason) => (
        <span key={reason.code} className="fw-task-reason">
          <FloorButton size="lg" variant={reason.count ? 'warning' : 'secondary'} block heldReason={heldReason ?? null} onClick={() => onPick(reason.code)} aria-label={reason.count ? `${reason.label}: ${reason.count}` : reason.label}>
            <span className="fw-task-reason-label">{reason.label}</span>
            {reason.count ? <span className="fw-task-reason-count">{reason.count}</span> : null}
          </FloorButton>
          {reason.count && onRemove ? (
            <FloorButton size="sm" variant="quiet" onClick={() => onRemove(reason.code)} aria-label={removeLabel ? removeLabel(reason.label) : undefined}>
              −1
            </FloorButton>
          ) : null}
        </span>
      ))}
    </div>
  )
}

// ---- sign with the PIN ----------------------------------------------------------------------------------------------

export type PinProblem = 'wrong' | 'locked' | 'unavailable' | 'offline' | null

export function PinSign({ title, meaning, summary, onPin, busy, problem }: { title: string; meaning: string; summary?: ReactNode; onPin: (pin: string) => void; busy?: boolean; problem?: PinProblem }) {
  const t = useT('floor-tasks')
  return (
    <section className="fw-task-pin" aria-labelledby="fw-task-pin-title">
      <h2 id="fw-task-pin-title" className="fw-floor-section-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Lock />
        </span>
        {title}
      </h2>
      {summary}
      <p className="fw-task-pin-meaning">{meaning}</p>
      <PinPad
        label={t('pin.label')}
        enteredLabel={(entered, total) => t('pin.entered', { entered, total })}
        clearLabel={t('pin.clear')}
        backLabel={t('pin.back')}
        busy={busy}
        locked={problem === 'locked' || problem === 'offline'}
        message={problem ? t(`pin.problem.${problem}`) : busy ? t('pin.busy') : undefined}
        messageTone={problem === 'wrong' || problem === 'locked' ? 'danger' : problem ? 'warning' : 'info'}
        onSubmit={onPin}
        autoFocus
      />
    </section>
  )
}

// ---- a problem as a full-screen state ---------------------------------------------------------------------------------

/**
 * A failed call as the screen shows it: a rule's refusal in the screen's words (`words(code)` → message and fix, else
 * the API's), or the general problem's words. One big action comes from the screen's action bar.
 */
export function ProblemState({ problem, words, code }: { problem: TaskProblem; words?: (code: string) => { message: string; fix: string | null } | null; code?: string | null }) {
  const t = useT('floor-tasks')
  if (problem.kind === 'refused') {
    const own = words?.(problem.code) ?? null
    const message = own?.message ?? problem.message
    const fix = own ? own.fix : problem.fix
    return (
      <FloorState tone="danger" icon={<CircleAlert />} title={message} alert>
        {code ? <p className="fw-floor-card-code">{code}</p> : null}
        {fix ? <p className="fw-floor-state-text">{fix}</p> : null}
        {problem.others && problem.others.length > 0 ? (
          <ul className="fw-task-others">
            {problem.others.map((other) => {
              const words2 = words?.(other.code) ?? null
              return <li key={other.code}>{words2?.message ?? other.message}</li>
            })}
          </ul>
        ) : null}
      </FloorState>
    )
  }
  const kind = problem.kind === 'stepUp' ? 'forbidden' : problem.kind
  const icon = kind === 'offline' ? <WifiOff /> : kind === 'unavailable' ? <WifiOff /> : <CircleAlert />
  const tone = kind === 'offline' || kind === 'unavailable' || kind === 'rateLimited' ? 'warning' : 'danger'
  return (
    <FloorState tone={tone} icon={icon} title={t(`problem.${kind}.title`)} text={t(`problem.${kind}.body`)} alert>
      {code ? <p className="fw-floor-card-code">{code}</p> : null}
    </FloorState>
  )
}

// ---- the list's keys --------------------------------------------------------------------------------------------------

/** A floor list's footer: its count in words and its keys in one information icon (never above the list). */
export function ListFooter({ count, keys }: { count: string; keys: readonly { key: string; does: string }[] }) {
  const t = useT('floor-tasks')
  return (
    <div className="fw-task-list-footer">
      <span className="fw-floor-muted">{count}</span>
      <DetailPopover trigger={<Info aria-hidden />} triggerLabel={t('keys.trigger')} triggerClassName="fw-task-keys-trigger" label={t('keys.title')} hoverDelay={150}>
        <div className="fw-task-keys">
          <p className="fw-floor-subtitle">{t('keys.title')}</p>
          <dl className="fw-task-keymap">
            {keys.map((entry) => (
              <div key={entry.key} className="fw-task-keymap-row">
                <dt>
                  <Kbd>{entry.key}</Kbd>
                </dt>
                <dd>{entry.does}</dd>
              </div>
            ))}
          </dl>
        </div>
      </DetailPopover>
    </div>
  )
}
