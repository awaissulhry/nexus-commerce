'use client'

import { type ReactNode, type CSSProperties } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * U.5 — Discoverable wrapper for click-to-edit values.
 *
 * Replaces the bare `<button onClick={startEdit}>...display...</button>`
 * pattern used across grid cells, drawer fields, and inline forms.
 *
 * Visual contract:
 * - At rest: invisible — looks like static text (1px transparent border
 *   reserves the slot so layout doesn't shift on hover).
 * - On hover/focus: subtle slate background + border + a fade-in pencil
 *   icon at the trailing edge, signalling "this is editable."
 * - Empty state (`empty`): dashed border so the user can see editable
 *   slots even when there's no value yet ("Add brand…" placeholders).
 *
 * Use the `align` prop to place the pencil correctly: 'right' keeps it
 * tight to the value for currency/numeric columns; 'left' parks it at
 * the trailing edge for free-text. The default is 'left'.
 */

interface Props {
  onClick: () => void
  /** Used in the title and aria-label: "Edit {label}". Lowercase noun
   *  phrase, e.g. "brand", "base price", "low-stock threshold". */
  label: string
  align?: 'left' | 'right'
  size?: 'sm' | 'md'
  /** Render with a dashed border so empty-but-editable slots are
   *  discoverable at rest, not just on hover. */
  empty?: boolean
  /** Suppress the trailing pencil icon — useful when the value is itself
   *  a strong affordance (e.g. a `<Badge>` whose color already cues
   *  interactivity) and the icon would feel cluttered. */
  hideIcon?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function InlineEditTrigger({
  onClick,
  label,
  align = 'left',
  size = 'md',
  empty = false,
  hideIcon = false,
  disabled = false,
  className,
  style,
  children,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`Click to edit ${label}`}
      aria-label={`Edit ${label}`}
      style={style}
      className={cn(
        'group/edit relative flex items-center w-full max-w-full rounded text-left',
        'border border-transparent',
        size === 'sm' ? 'min-h-[22px] py-px' : 'min-h-[26px] py-0.5',
        // Reserve space for the trailing pencil so it doesn't visually
        // collide with the value text.
        align === 'right' ? 'pl-5 pr-1.5 justify-end' : 'pl-1.5 pr-5',
        empty
          ? 'border-dashed border-slate-300 text-slate-400 hover:border-slate-400 hover:bg-slate-50'
          : 'hover:bg-slate-50 hover:border-slate-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:border-blue-400',
        'transition-colors',
        disabled &&
          'opacity-60 cursor-not-allowed hover:bg-transparent hover:border-transparent',
        className,
      )}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          align === 'right' && 'text-right',
        )}
      >
        {children}
      </span>
      {!hideIcon && !disabled && (
        <Pencil
          aria-hidden="true"
          className={cn(
            'absolute top-1/2 -translate-y-1/2 flex-shrink-0 text-slate-400 opacity-0 transition-opacity',
            'group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100',
            // When empty, keep the icon faintly visible at rest so the
            // dashed slot reads as "editable" rather than "decoration".
            empty && 'opacity-50',
            align === 'right' ? 'left-1' : 'right-1',
            size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3',
          )}
        />
      )}
    </button>
  )
}
