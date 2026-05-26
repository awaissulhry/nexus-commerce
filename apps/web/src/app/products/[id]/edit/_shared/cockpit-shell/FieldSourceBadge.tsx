'use client'

// FL.2 — Provenance badge.
//
// The muted Level-0 marker that sits next to a field's value telling the
// operator which rung of the resolution stack won (linked / master /
// pinned / locked / AI …). Deliberately quiet by default so the automated
// state doesn't shout; FL.3 makes it the clickable entry point to the
// per-field scope popover.

import { cn } from '@/lib/utils'
import { PROVENANCE_BADGE_BASE } from './tokens'
import { describeFieldSource, type FieldSource } from './contracts'

export interface FieldSourceBadgeProps {
  source: FieldSource
  /** Show the text label after the glyph (default: glyph only). */
  showLabel?: boolean
  /** Extra context appended to the tooltip, e.g. "· 5 markets". */
  detail?: string
  className?: string
  /** Becomes a button when set (FL.3 scope popover entry point). */
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
  const title = detail ? `${meta.label} · ${detail}` : meta.label
  const content = (
    <>
      <span aria-hidden>{meta.glyph}</span>
      {showLabel && <span className="ml-0.5">{meta.label}</span>}
      {detail && <span className="ml-0.5 opacity-70">{detail}</span>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        className={cn(
          PROVENANCE_BADGE_BASE,
          'rounded px-0.5 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800',
          className,
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <span className={cn(PROVENANCE_BADGE_BASE, className)} title={title} aria-label={title}>
      {content}
    </span>
  )
}
