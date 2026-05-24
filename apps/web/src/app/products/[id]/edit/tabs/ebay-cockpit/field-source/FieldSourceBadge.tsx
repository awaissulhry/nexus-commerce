'use client'

// EC.2.3 — FieldSourceBadge.
//
// Always-visible chip next to a field showing where its current
// value came from. Tiny on purpose: it's a passive read; the
// SourceSwitcher is the action surface.

import { User, Layers, Languages, Sparkles, Copy, CircleSlash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SOURCE_HINTS, SOURCE_LABELS, type FieldSource } from './types'

const ICONS: Record<FieldSource, React.ComponentType<{ className?: string }>> = {
  manual:       User,
  master:       Layers,
  translations: Languages,
  ai:           Sparkles,
  sibling:      Copy,
  default:      CircleSlash,
}

const TONES: Record<FieldSource, { bg: string; text: string; ring: string }> = {
  manual:       { bg: 'bg-slate-100 dark:bg-slate-800',         text: 'text-slate-700 dark:text-slate-300',         ring: 'ring-slate-300 dark:ring-slate-700' },
  master:       { bg: 'bg-blue-50 dark:bg-blue-950/40',         text: 'text-blue-700 dark:text-blue-300',           ring: 'ring-blue-200 dark:ring-blue-800' },
  translations: { bg: 'bg-violet-50 dark:bg-violet-950/40',     text: 'text-violet-700 dark:text-violet-300',       ring: 'ring-violet-200 dark:ring-violet-800' },
  ai:           { bg: 'bg-amber-50 dark:bg-amber-950/40',       text: 'text-amber-700 dark:text-amber-300',         ring: 'ring-amber-200 dark:ring-amber-800' },
  sibling:      { bg: 'bg-emerald-50 dark:bg-emerald-950/40',   text: 'text-emerald-700 dark:text-emerald-300',     ring: 'ring-emerald-200 dark:ring-emerald-800' },
  default:      { bg: 'bg-slate-50 dark:bg-slate-900',          text: 'text-slate-400 dark:text-slate-500',         ring: 'ring-slate-200 dark:ring-slate-800' },
}

interface Props {
  source: FieldSource
  size?: 'xs' | 'sm'
  compact?: boolean
}

export default function FieldSourceBadge({ source, size = 'xs', compact }: Props) {
  const Icon = ICONS[source]
  const tone = TONES[source]
  const px = size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-1 py-0.5 text-[10px]'
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded ring-1 font-medium whitespace-nowrap',
        tone.bg,
        tone.text,
        tone.ring,
        px,
      )}
      title={SOURCE_HINTS[source]}
    >
      <Icon className={iconSize} />
      {!compact && SOURCE_LABELS[source]}
    </span>
  )
}
