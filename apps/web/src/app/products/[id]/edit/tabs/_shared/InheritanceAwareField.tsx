'use client'

/**
 * PIM B.2 — Inheritance-aware field wrapper.
 *
 * Wraps any input control with inheritance visualization per the
 * brief: "If you leave the Amazon EU title blank, the UI visually
 * shows it 'inheriting' the Global title in gray text. If you type
 * over it, you break the inheritance and set a channel-specific
 * override."
 *
 * Two modes:
 *   - Inherited (no override set):
 *       Renders the effective value as gray italic ghost text.
 *       Click → reveals the input pre-filled with the inherited value;
 *       any edit transitions to override mode on the next save.
 *   - Overridden (override is set):
 *       Renders the input normally with bold styling on the value.
 *       Shows a "Reset to Global" inline action that calls onReset()
 *       to clear the override and return to inheritance.
 *
 * Stateless: parent owns the value + onChange + onReset. This wrapper
 * just handles the visual transitions + edit-mode toggling.
 */

import { useCallback, useState, type ReactNode } from 'react'
import { Pencil, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import InheritanceLabel from './InheritanceLabel'

interface Props {
  label: string
  /** The value that would be sent to the marketplace right now (after
   *  applying inheritance). Used as the ghost text in inherited mode
   *  and the prefilled value when operator clicks to edit. */
  effectiveValue: string | number | null
  /** Whether the channel has an override set. Drives the visual mode. */
  isOverridden: boolean
  /** Where the effective value comes from when inherited (e.g.
   *  "Global", "Variant master", "legacy column"). */
  sourceLabel?: string
  /** Where the override is applied when overridden (e.g. "Amazon IT"). */
  targetLabel?: string
  /** Operator wants to set an override. Receives the new value. */
  onSetOverride: (value: string) => void
  /** Operator wants to clear the override and inherit again. */
  onReset: () => void
  /** Renders the actual input control. Render-prop pattern so the
   *  wrapper doesn't care whether it's an Input, textarea, etc.
   *  The wrapper supplies `value`, `onChange`, and `bold` styling
   *  hint that the input should respect. */
  renderInput: (props: {
    value: string
    onChange: (next: string) => void
    isOverridden: boolean
    autoFocus?: boolean
  }) => ReactNode
  className?: string
}

export default function InheritanceAwareField({
  label,
  effectiveValue,
  isOverridden,
  sourceLabel = 'Global',
  targetLabel,
  onSetOverride,
  onReset,
  renderInput,
  className,
}: Props) {
  // Inherited mode shows a ghost; click to enter "edit-to-override" mode.
  const [editingInherit, setEditingInherit] = useState(false)
  const [draft, setDraft] = useState<string>('')

  const enterEdit = useCallback(() => {
    setDraft(effectiveValue == null ? '' : String(effectiveValue))
    setEditingInherit(true)
  }, [effectiveValue])

  // ── OVERRIDDEN MODE ──────────────────────────────────────────────
  if (isOverridden) {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
          <div className="flex items-center gap-2">
            <InheritanceLabel mode="override" targetLabel={targetLabel} />
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700"
              title={`Reset to ${sourceLabel}`}
            >
              <RotateCcw className="w-2.5 h-2.5" />
              Reset
            </button>
          </div>
        </div>
        {renderInput({
          value: effectiveValue == null ? '' : String(effectiveValue),
          onChange: onSetOverride,
          isOverridden: true,
        })}
      </div>
    )
  }

  // ── INHERITED MODE, EDITING ──────────────────────────────────────
  if (editingInherit) {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
          <div className="flex items-center gap-2">
            <span className="text-[11px] italic text-zinc-500">
              editing — saving creates an override
            </span>
            <button
              type="button"
              onClick={() => setEditingInherit(false)}
              className="text-[11px] text-zinc-500 hover:text-zinc-700"
            >
              cancel
            </button>
          </div>
        </div>
        {renderInput({
          value: draft,
          onChange: (next) => {
            setDraft(next)
            // Commit immediately on first keystroke so the parent's
            // onSetOverride fires per change — matches how the rest of
            // the edit page works (debounced PATCH on the parent).
            // Operators don't need to hit "save" inside the field.
            onSetOverride(next)
          },
          isOverridden: false,
          autoFocus: true,
        })}
      </div>
    )
  }

  // ── INHERITED MODE, GHOST ────────────────────────────────────────
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
        <InheritanceLabel mode="inherited" sourceLabel={sourceLabel} />
      </div>
      <button
        type="button"
        onClick={enterEdit}
        className={cn(
          'group flex items-center justify-between gap-2 w-full text-left',
          'px-3 py-2 rounded-md border border-dashed border-zinc-200 dark:border-zinc-700',
          'hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
          'transition-colors',
        )}
        aria-label={`${label}: inherited value. Click to override.`}
      >
        <span
          className={cn(
            'flex-1 truncate text-sm italic',
            effectiveValue == null || effectiveValue === ''
              ? 'text-zinc-400'
              : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          {effectiveValue == null || effectiveValue === '' ? (
            <span className="text-[12px]">no value set on {sourceLabel}</span>
          ) : (
            String(effectiveValue)
          )}
        </span>
        <Pencil className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    </div>
  )
}
