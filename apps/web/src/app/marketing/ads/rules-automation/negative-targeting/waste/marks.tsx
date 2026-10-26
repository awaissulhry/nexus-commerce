'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the row marks (6-neg-design.md §5): every state is an outline icon
 * with no visible words; the words are the tooltip and the accessible name. No emoji (Owner 2026-10-07).
 *
 *   our keyword or target  Crosshair            a shopper's search term  TextSearch
 *   running                Play                 paused                   Pause
 *   kept paused            Pause + Lock         negative                 Ban (+ the E / P chip)
 *   protected              ShieldCheck          turned on outside Nexus  TriangleAlert
 *   not at Amazon          CloudOff             waiting for you          Hourglass
 *   skipped                AlarmClock
 *   step 4: protection being removed, its negative follows  Hourglass (muted) · not stopped after it   the warning glyph
 */
import type { ReactNode } from 'react'
import { AlarmClock, Ban, CloudOff, Crosshair, Hourglass, Lock, Pause, Play, ShieldCheck, TextSearch, TriangleAlert } from 'lucide-react'
import { Tooltip } from '@/design-system/primitives'
import { useTooltipsDisabled } from '@/design-system/primitives/Tooltip'
import { IdentityChip, WarnGlyph } from '@/design-system/grid'
import { dayWords, relWords } from '../../bid/_shared/format'
import { kindWord, matchChip, matchWord, planWords, stateSentence, type AnyState } from './wasteModel'
import { followUpSentence } from './protectionModel'
import type { Match, RowKind, StoppedRow, WasteRow } from './wasteTypes'
import styles from '../negatives.module.css'

const G = { size: 13, strokeWidth: 2.25, 'aria-hidden': true as const }

/** One mark: an icon whose name is its sentence (tooltip on hover and focus; a native title where hints are off). */
export function Mark({ label, tone, children, focusable = false }: { label: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; children: ReactNode; focusable?: boolean }) {
  const quiet = useTooltipsDisabled()
  const mark = (
    <span className={`${styles.mark} ${tone ? styles[`tone_${tone}`] : ''}`} role="img" aria-label={label} title={quiet ? label : undefined} tabIndex={focusable ? 0 : undefined}>
      {children}
    </span>
  )
  return quiet ? mark : <Tooltip label={label} portal>{mark}</Tooltip>
}

/** Ours (Crosshair) or a shopper's (TextSearch). */
export function KindMark({ kind, match }: { kind: RowKind; match?: Match }) {
  return (
    <Mark label={kindWord(kind, match)} tone="muted">
      {kind === 'TERM' ? <TextSearch {...G} className="nds-cell-glyph" /> : <Crosshair {...G} className="nds-cell-glyph" />}
    </Mark>
  )
}

/** The match type as the DS identity chip (E · P · B · A · PT · C); nothing for none. */
export function MatchChip({ match }: { match: Match | null | undefined }) {
  const chip = matchChip(match)
  if (!chip) return null
  return <IdentityChip label={chip} tip={matchWord(match)} />
}

/** A row's state, one icon (and a lock for kept paused, the E / P chip for a negative). */
export function StateMark({ row, focusable = false }: { row: { state: AnyState; match?: Match; level?: 'AD_GROUP' | 'CAMPAIGN' | null; keptPaused?: StoppedRow['keptPaused']; clash?: unknown; protection?: WasteRow['protection'] }; focusable?: boolean }) {
  const label = stateSentence(row)
  switch (row.state) {
    case 'RUNNING': return <Mark label={label} tone="ok" focusable={focusable}><Play {...G} className="nds-cell-glyph" /></Mark>
    case 'PAUSED': return <Mark label={label} tone="muted" focusable={focusable}><Pause {...G} className="nds-cell-glyph" /></Mark>
    case 'KEPT_PAUSED': return (
      <Mark label={label} tone="warn" focusable={focusable}>
        <Pause {...G} className="nds-cell-glyph" /><Lock size={10} strokeWidth={2.5} aria-hidden className="nds-cell-glyph" />
      </Mark>
    )
    case 'NEGATED': return <Mark label={label} tone="info" focusable={focusable}><Ban {...G} className="nds-cell-glyph" /></Mark>
    case 'PROTECTED': return <Mark label={label} tone="ok" focusable={focusable}><ShieldCheck {...G} className="nds-cell-glyph" /></Mark>
    // With its clash mark beside it (a Wasting row), it shows that it runs; alone (a Stopped row), the warning.
    case 'TURNED_ON_ELSEWHERE': return row.clash
      ? <Mark label={label} tone="bad" focusable={focusable}><Play {...G} className="nds-cell-glyph" /></Mark>
      : <Mark label={label} tone="bad" focusable={focusable}><TriangleAlert {...G} className="nds-cell-glyph" /></Mark>
    case 'NOT_AT_AMAZON': return <Mark label={label} tone="muted" focusable={focusable}><CloudOff {...G} className="nds-cell-glyph" /></Mark>
    default: return null
  }
}

/** Waiting for a person: by whom, when it expires, and a plan's steps (decided together, NFIX). */
export function WaitingMark({ waiting }: { waiting: { by: { name: string }; at: string; expiresAt: string | null; plan?: { steps: number; offPage: number } } }) {
  const plan = planWords(waiting.plan)
  const label = `Waiting for you · asked by ${waiting.by.name} ${relWords(waiting.at)}${waiting.expiresAt ? ` · expires ${relWords(waiting.expiresAt)}` : ''}${plan ? ` · ${plan}, approved together` : ''}`
  return <Mark label={label} tone="warn"><Hourglass {...G} className="nds-cell-glyph" /></Mark>
}

/** A clash the Owner should see: the DS warning glyph, its words (`clash.label`) on hover, focus and for a screen reader. */
export function ClashMark({ clash, focusable = false }: { clash: { label: string }; focusable?: boolean }) {
  return <Mark label={clash.label} tone="bad" focusable={focusable}><WarnGlyph /></Mark>
}

/** Step 4 — Remove protection and stop still finishing on the server, or not stopped after the protection went (and why). */
export function FollowUpMark({ followUp, focusable = false }: { followUp: NonNullable<WasteRow['followUp']>; focusable?: boolean }) {
  return followUp.status === 'WAITING'
    ? <Mark label={followUpSentence(followUp)} tone="muted" focusable={focusable}><Hourglass {...G} className="nds-cell-glyph" /></Mark>
    : <Mark label={followUpSentence(followUp)} tone="bad" focusable={focusable}><WarnGlyph /></Mark>
}

/** Skipped until a day: the row comes back with fresh numbers. Step 4: a kept-protected row says so (`label`). */
export function SkippedMark({ skipped, label }: { skipped: { until: string }; label?: string | null }) {
  return <Mark label={label ?? `Skipped until ${dayWords(skipped.until)}`} tone="muted"><AlarmClock {...G} className="nds-cell-glyph" /></Mark>
}
