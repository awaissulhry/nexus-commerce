'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the row marks (6-neg-design.md §5): an outline icon whose words are
 * its tooltip and accessible name (`Mark`): our keyword or target (Crosshair) or a shopper's search term (TextSearch),
 * and the match chip (E · P · B · A · PT · C). No emoji (Owner 2026-10-07).
 *
 * The redesign (2026-10-26, BRIEF D6): a state is ONE chip — the DS Pill with its mark and a word in a tone ("Wasting",
 * "Waiting", "Blocked"), never a mark alone — and a smaller line under it for a clash, a follow-up or a
 * skip (`StateChip`, `StateSub`; their words: wasteModel.ts stateChip / stateSub). The icon-only state marks are gone.
 *
 *   running Play · paused / kept paused Pause · negative Ban · protected ShieldCheck · turned on outside Nexus
 *   TriangleAlert · not at Amazon CloudOff · waiting Hourglass · skipped AlarmClock · a clash or a refusal the DS warning
 */
import type { ReactNode } from 'react'
import { AlarmClock, Ban, CloudOff, Crosshair, Hourglass, Pause, Play, ShieldCheck, TextSearch, TriangleAlert } from 'lucide-react'
import { Pill, Tooltip } from '@/design-system/primitives'
import { useTooltipsDisabled } from '@/design-system/primitives/Tooltip'
import { IdentityChip, WarnGlyph } from '@/design-system/grid'
import { kindWord, matchChip, matchWord, type ChipMark, type StateChipView, type StateSubView } from './wasteModel'
import type { Match, RowKind } from './wasteTypes'
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

/* ── the redesign: one chip per state (D6) ────────────────────────────────────────────────────────────────────────── */

const CHIP_G = { size: 12, strokeWidth: 2.25, 'aria-hidden': true as const, className: 'nds-cell-glyph' }

/** A chip's mark (12 px, the chip's own tone colours it). */
export function ChipGlyph({ mark }: { mark: ChipMark }) {
  switch (mark) {
    case 'play': return <Play {...CHIP_G} />
    case 'pause': return <Pause {...CHIP_G} />
    case 'ban': return <Ban {...CHIP_G} />
    case 'shield': return <ShieldCheck {...CHIP_G} />
    case 'hourglass': return <Hourglass {...CHIP_G} />
    case 'alert': return <TriangleAlert {...CHIP_G} />
    case 'cloud': return <CloudOff {...CHIP_G} />
    case 'clock': return <AlarmClock {...CHIP_G} />
    default: return <WarnGlyph />
  }
}

/**
 * A row's state as the DS Pill: its mark and one word in a tone; the code's sentence on hover and, after the word, for a
 * screen reader. A long word ("Turned on elsewhere") ends in "…" inside the cell (Pill `truncate`).
 */
export function StateChip({ chip }: { chip: StateChipView }) {
  return (
    <Pill tone={chip.tone} size="sm" icon={<ChipGlyph mark={chip.mark} />} title={chip.title} truncate>
      {chip.word}<span className="nds-vh">. {chip.title}</span>
    </Pill>
  )
}

/** The smaller line under a chip: a clash in red, a follow-up or a skip muted; its words on hover too (it may be cut). */
export function StateSub({ sub }: { sub: StateSubView }) {
  return (
    <span className={`${styles.stateSub} ${sub.tone === 'danger' ? styles.tone_bad : styles.tone_muted}`} title={sub.word}>
      {sub.mark === 'warn' ? <WarnGlyph /> : <ChipGlyph mark={sub.mark} />}
      <span className={styles.stateSubText}>{sub.word}</span>
    </span>
  )
}
