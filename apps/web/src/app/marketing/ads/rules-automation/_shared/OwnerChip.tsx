'use client'

/**
 * Who owns a row — ONE chip for the ads pages (Negative Targeting 2026-10-11; the Bid page moves to it at its release).
 *
 *   Brain · Rule · Harvest · You · Claude · Hourly plan · Engine · —
 *
 * An outline lucide icon and one word; the name (a rule's, a person's) and why live on hover and focus and in the
 * accessible name, never as more words on the row. `locked`: the stop is its owner's to keep (Harvest's negative, the
 * Brain's funnel) — a lock beside the word says so. A chip with `href` is a real link (the workspace `Link`, so a new
 * tab works); with `onClick` it is a button; otherwise it only shows. No emoji (Owner 2026-10-07).
 */
import type { ReactNode } from 'react'
import { Bot, Brain, CircleSlash, Clock, Gauge, ListChecks, Lock, Sprout, User } from 'lucide-react'
import { Pill, Tooltip } from '@/design-system/primitives'
import { useTooltipsDisabled } from '@/design-system/primitives/Tooltip'
import Link from '@/lib/workspaces/Link'
import styles from './ownerChip.module.css'

export type OwnerChipKind = 'BRAIN' | 'RULE' | 'HARVEST' | 'PERSON' | 'CLAUDE' | 'PLAN' | 'ENGINE' | 'NONE'

export const OWNER_CHIP_WORD: Readonly<Record<OwnerChipKind, string>> = {
  BRAIN: 'Brain',
  RULE: 'Rule',
  HARVEST: 'Harvest',
  PERSON: 'You',
  CLAUDE: 'Claude',
  PLAN: 'Hourly plan',
  ENGINE: 'Engine',
  NONE: '—',
}

const TONE: Readonly<Record<OwnerChipKind, 'success' | 'info' | 'neutral'>> = {
  BRAIN: 'info', RULE: 'info', HARVEST: 'info', PERSON: 'success', CLAUDE: 'info', PLAN: 'info', ENGINE: 'info', NONE: 'neutral',
}

/** The owner's icon (outline, decorative: the chip says the words). */
export function OwnerIcon({ kind, size = 12 }: { kind: OwnerChipKind; size?: number }) {
  const props = { size, strokeWidth: 2.25, 'aria-hidden': true as const, className: 'nds-cell-glyph' }
  switch (kind) {
    case 'BRAIN': return <Brain {...props} />
    case 'RULE': return <ListChecks {...props} />
    case 'HARVEST': return <Sprout {...props} />
    case 'PERSON': return <User {...props} />
    case 'CLAUDE': return <Bot {...props} />
    case 'PLAN': return <Clock {...props} />
    case 'ENGINE': return <Gauge {...props} />
    default: return <CircleSlash {...props} />
  }
}

export interface OwnerChipProps {
  kind: OwnerChipKind
  /** The word on the chip; default the kind's word ("Rule"). */
  label?: string
  /** Who and why, on hover and focus and as the accessible name ("Rule: Stop waste — IT"). Default the label. */
  hint?: string
  /** Its owner keeps this stop (Harvest, the Brain's funnel): a lock beside the word. */
  locked?: boolean
  /** Opens where the owner is set (a rule on its page). */
  href?: string | null
  onClick?: () => void
  className?: string
}

export function OwnerChip({ kind, label, hint, locked = false, href, onClick, className }: OwnerChipProps) {
  const word = label ?? OWNER_CHIP_WORD[kind]
  const name = hint ?? word
  // Where the host turned its hints off (a dense grid), the name is the native title instead.
  const quiet = useTooltipsDisabled()
  const title = quiet ? name : undefined
  // Nobody: a plain dash, no icon (a slashed circle read like the Ban of a negative beside it).
  const body: ReactNode = (
    <span className={styles.inline}>
      {kind !== 'NONE' && <OwnerIcon kind={kind} />}
      <span className={styles.word}>{word}</span>
      {locked && <Lock size={10} strokeWidth={2.5} aria-hidden className="nds-cell-glyph" />}
    </span>
  )
  const pill = (extra?: { onClick?: () => void }) => (
    <Pill tone={TONE[kind]} size="sm" className={styles.pill} onClick={extra?.onClick} aria-label={extra?.onClick ? name : undefined}>{body}</Pill>
  )
  if (href) {
    return (
      <Tooltip label={name} portal>
        <Link href={href} className={[styles.link, className].filter(Boolean).join(' ')} aria-label={name} title={title}>{pill()}</Link>
      </Tooltip>
    )
  }
  if (onClick) return <Tooltip label={name} portal><span className={[styles.chip, className].filter(Boolean).join(' ')} title={title}>{pill({ onClick })}</span></Tooltip>
  return (
    <Tooltip label={name} portal>
      <span className={[styles.chip, className].filter(Boolean).join(' ')} role="img" aria-label={name} title={title} tabIndex={0}>{pill()}</span>
    </Tooltip>
  )
}
