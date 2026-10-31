'use client'

import { useMemo, type ReactNode } from 'react'
import { Check, CircleDashed, CircleDot, Minus, Undo2, Wrench } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { Pill, Tag, type Tone } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { QualityMessages } from '../../../quality/_shared/parts'
import type { RepairStage, ReturnStatus, SafetyState, StepState } from '../api'
import { fromMinor, type AfterSalesRow, type RowKind, type Words } from '../model'
import '../returns.css'

/**
 * View parts every Returns & repairs screen shares (SCR-111, SCR-112, B-W2a-77): the catalogue (`sales-returns` + the
 * shared `quality`, `lists`, `records`), the words of a status (each says its state in words: never colour alone), a
 * price-grain amount, and two parts the design names as NEW that only this area needs, composed here from DS parts
 * (packages/ui is frozen): the MilestoneTracker (an RMA's steps with their dates, SAL-362) and the GateChecklist (a
 * protective garment's safety check after its repair: each point passed, failed or not applicable, in words).
 */

export function ReturnsMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['sales-returns']}>{children}</QualityMessages>
}

/** The screen's words (`sales-returns`); a `quality:` key reads the shared quality catalogue (the kinds of a failed call). */
export function useWords(): Translate {
  const t = useT('sales-returns')
  const q = useT('quality')
  return useMemo<Translate>(() => (key, params) => (key.startsWith('quality:') ? q(key.slice(8), params) : t(key, params)), [t, q])
}

/**
 * Words with params whose values may be keys themselves (`stage.RECEIVED`); with `day`, a `date` param (YYYY-MM-DD) is
 * drawn in the reader's format.
 */
export function say(t: Translate, words: Words | null | undefined, day?: (value: string) => string): string {
  if (!words) return ''
  const params = words.params
    ? Object.fromEntries(
        Object.entries(words.params).map(([name, value]) => [
          name,
          typeof value === 'string' && /^(stage|stagePill|safety)\.[A-Za-z_.]+$/.test(value) ? t(value) : day && name === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? day(value) : value,
        ]),
      )
    : undefined
  return t(words.key, params)
}

const RETURN_TONE: Readonly<Record<ReturnStatus, Tone>> = {
  REQUESTED: 'info',
  AUTHORISED: 'info',
  RECEIVED: 'warning',
  INSPECTED: 'success',
  CLOSED: 'neutral',
  REJECTED: 'neutral',
  CANCELLED: 'neutral',
}
const STAGE_TONE: Readonly<Record<RepairStage, Tone>> = {
  AWAITING_GOODS: 'info',
  RECEIVED: 'warning',
  ESTIMATED: 'warning',
  APPROVED: 'warning',
  IN_REPAIR: 'info',
  REPAIRED: 'success',
  SHIPPED: 'neutral',
  CANCELLED: 'neutral',
}

export function ReturnStatusPill({ status }: { status: ReturnStatus }) {
  const t = useWords()
  return <Pill tone={RETURN_TONE[status]}>{t(`status.${status}`)}</Pill>
}

export function RepairStagePill({ stage }: { stage: RepairStage }) {
  const t = useWords()
  return <Pill tone={STAGE_TONE[stage]}>{t(`stagePill.${stage}`)}</Pill>
}

export function RowStatusPill({ row }: { row: AfterSalesRow }) {
  return row.status.kind === 'RETURN' ? <ReturnStatusPill status={row.status.status} /> : <RepairStagePill stage={row.status.stage} />
}

const SAFETY_TONE: Readonly<Record<SafetyState, Tone>> = { NOT_REQUIRED: 'neutral', NOT_CHECKED: 'warning', OUTDATED: 'warning', PASSED: 'success', FAILED: 'danger' }

export function SafetyTag({ state }: { state: SafetyState }) {
  const t = useWords()
  return <Tag tone={SAFETY_TONE[state]}>{t(`safety.state.${state}`)}</Tag>
}

export function KindTag({ kind }: { kind: RowKind }) {
  const t = useWords()
  return (
    <span className="fw-rr-kind">
      {kind === 'RETURN' ? <Undo2 size={12} aria-hidden /> : <Wrench size={12} aria-hidden />} {t(`kind.${kind}`)}
    </span>
  )
}

/** A price-grain amount in minor units ("120,00 €"); "—" when unknown. */
export function Money({ minor, currency }: { minor: number | null | undefined; currency: string | null | undefined }) {
  const locale = useLocale()
  if (minor === null || minor === undefined || !currency) return <span className="fw-q-hint">—</span>
  return <span className="fw-q-num">{formatNumber(fromMinor(minor), locale, { style: 'currency', currency })}</span>
}

export function DayText({ value }: { value: string | null | undefined }) {
  const locale = useLocale()
  if (!value) return <span className="fw-q-hint">—</span>
  return <time dateTime={value}>{formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale })}</time>
}

export function InstantText({ value }: { value: string | null | undefined }) {
  const locale = useLocale()
  if (!value) return <span className="fw-q-hint">—</span>
  return <time dateTime={value}>{formatDateTime(value, { locale })}</time>
}

/** A day as the reader reads it ("14 nov 2026"), for a sentence. */
export function useDayWords(): (value: string) => string {
  const locale = useLocale()
  return (value) => formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale })
}

// ---- MilestoneTracker (design: NEW; composed) -------------------------------------------------------------------------------

export interface Milestone {
  readonly id: string
  readonly label: string
  readonly state: StepState
  readonly at: string | null
  readonly sub: string
}

const STEP_ICON: Readonly<Record<StepState, ReactNode>> = {
  DONE: <Check size={14} aria-hidden />,
  CURRENT: <CircleDot size={14} aria-hidden />,
  WAITING: <CircleDashed size={14} aria-hidden />,
  SKIPPED: <Minus size={14} aria-hidden />,
}

/**
 * The status steps of a record with their dates (design MilestoneTracker, a NEW part only Returns & repairs needs: composed
 * here, named in the step notes). Each step says its state in words beside its mark (Done · Now · Waiting · Skipped); the
 * current one is `aria-current="step"`. Wraps on a phone.
 */
export function MilestoneTracker({ steps, label }: { steps: readonly Milestone[]; label: string }) {
  const t = useWords()
  return (
    <ol className="fw-rr-track" aria-label={label}>
      {steps.map((step) => (
        <li key={step.id} className="fw-rr-track-step" data-state={step.state} aria-current={step.state === 'CURRENT' ? 'step' : undefined}>
          <span className="fw-rr-track-mark">{STEP_ICON[step.state]}</span>
          <span className="fw-rr-track-text">
            <span className="fw-rr-track-label">{step.label}</span>
            <span className="fw-q-hint">
              {t(`track.word.${step.state}`)}
              {step.at ? ' · ' : ''}
              {step.at ? <InstantText value={step.at} /> : null}
            </span>
            {step.sub && <span className="fw-q-hint">{step.sub}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ---- GateChecklist (design: NEW; composed) ----------------------------------------------------------------------------------

export interface GatePoint {
  readonly id: string
  readonly label: string
  readonly hint?: string
  /** The control (a segmented choice) or, read-only, the answer in words. */
  readonly control: ReactNode
  readonly state: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'OPEN'
}

/**
 * A gate's points, each with its answer in a word and a mark (design GateChecklist, NEW, only the repair's safety check
 * needs it: composed here). A failed point is marked and named, never by colour alone.
 */
export function GateChecklist({ points, label }: { points: readonly GatePoint[]; label: string }) {
  const t = useWords()
  return (
    <ul className="fw-rr-gate" aria-label={label}>
      {points.map((point) => (
        <li key={point.id} className="fw-rr-gate-point" data-state={point.state}>
          <span className="fw-rr-gate-name">
            <span className="fw-rr-gate-label">{point.label}</span>
            {point.hint && <span className="fw-q-hint">{point.hint}</span>}
          </span>
          <span className="fw-rr-gate-control">{point.control}</span>
          <span className="fw-rr-gate-word">{t(`safety.answer.${point.state}`)}</span>
        </li>
      ))}
    </ul>
  )
}

// ---- keys ---------------------------------------------------------------------------------------------------------------------

export function KeysModal({ own, withSelection = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-q-keymap">
        {listKeys(own, withSelection).map((entry) => (
          <div key={`${entry.keys.join('+')}-${entry.does}`}>
            <dt>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** A key the page answers while the focus is on the page (not typing, not in a menu or a dialog). */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')
}
