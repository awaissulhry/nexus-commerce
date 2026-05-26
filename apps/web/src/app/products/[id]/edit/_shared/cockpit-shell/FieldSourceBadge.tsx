'use client'

// FL.2 / FX.3 / BADGE.1+2 — Provenance + scope control.
//
// Replaces the old muted-emoji marker with a themed, prominent control:
//   • interactive (onClick) → a coloured pill (tone bg/border) with a
//     lucide icon + short label + chevron, with hover + cursor-pointer,
//     so it clearly reads as "click to change scope".
//   • static → a tone-coloured lucide icon (+ optional label), not a
//     grey emoji — legible and on-theme in light/dark.

import {
  Link2,
  ArrowUpFromLine,
  Pencil,
  Lock,
  Sparkles,
  ArrowLeftRight,
  Languages,
  Minus,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_PILL, STATUS_TEXT } from './tokens'
import { describeFieldSource, type FieldSource } from './contracts'

const ICON: Record<FieldSource, LucideIcon> = {
  linked: Link2,
  master: ArrowUpFromLine,
  manual: Pencil,
  locked: Lock,
  ai: Sparkles,
  sibling: ArrowLeftRight,
  translations: Languages,
  default: Minus,
}

export interface FieldSourceBadgeProps {
  source: FieldSource
  /** Show the short label next to the icon (static badges). */
  showLabel?: boolean
  /** Extra context appended after the label, e.g. "· 5". */
  detail?: string
  className?: string
  /** Becomes a clickable scope-control pill when set. */
  onClick?: () => void
}

export default function FieldSourceBadge({
  source,
  showLabel = false,
  detail,
  className,
  onClick,
}: FieldSourceBadgeProps) {
  const meta = describeFieldSource(source)
  const Icon = ICON[source] ?? Minus
  const title = detail ? `${meta.label} · ${detail}` : meta.label

  // Interactive → prominent coloured pill that clearly looks clickable.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${title} — click to change`}
        aria-label={`${title} — click to change scope`}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium leading-none',
          'cursor-pointer transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          STATUS_PILL[meta.tone],
          className,
        )}
      >
        <Icon className="h-3 w-3" />
        <span>{meta.short}</span>
        {detail && <span className="opacity-70">{detail}</span>}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
    )
  }

  // Static → tone-coloured icon (+ optional short label).
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 text-[11px] leading-none', STATUS_TEXT[meta.tone], className)}
      title={title}
      aria-label={title}
    >
      <Icon className="h-3 w-3" />
      {showLabel && <span>{meta.short}</span>}
      {detail && <span className="opacity-70">{detail}</span>}
    </span>
  )
}
