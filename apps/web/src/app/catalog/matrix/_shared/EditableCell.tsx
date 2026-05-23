'use client'

/**
 * PIM C.3 — Editable matrix cell.
 *
 * Click to edit, Enter/blur commits, Escape reverts. The component is
 * stateless about persistence — the caller wires `onCommit` to the
 * mutation hook and updates its own local row state synchronously
 * (optimistic UI). On error, the parent reverts the row from the
 * `rollback` payload the hook surfaces.
 *
 * Supports three input types via `kind`:
 *   text   — generic string (brand, name)
 *   number — numeric (basePrice, stock); commits as number | null
 *   select — enumerated values (status); commits as string
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

interface BaseProps {
  /** Stable cell id (`${rowId}:${field}`) used by tests + a11y. */
  cellKey: string
  /** Current displayed value. */
  value: string | number | null
  /** Operator-friendly placeholder when value is null/empty. */
  placeholder?: string
  /** Tighter row height variant (used for variant rows). */
  compact?: boolean
  className?: string
  /** Called when the operator commits a new value (Enter/blur). The
   *  parent should optimistically update its own row state and then
   *  call mutationHook.commit. */
  onCommit: (next: string | number | null) => void
}

interface TextProps extends BaseProps {
  kind: 'text'
}
interface NumberProps extends BaseProps {
  kind: 'number'
  /** Lower bound clamp (e.g. 0 for stock). Optional. */
  min?: number
  /** Decimal step for numeric inputs. */
  step?: number
}
interface SelectProps extends BaseProps {
  kind: 'select'
  options: Array<{ value: string; label: string }>
}

type Props = TextProps | NumberProps | SelectProps

export default function EditableCell(props: Props) {
  const { cellKey, value, placeholder, compact, className, onCommit } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

  // Reset draft when the upstream value changes (e.g. after a server
  // refresh) and we're not currently editing.
  useEffect(() => {
    if (!editing) setDraft(value == null ? '' : String(value))
  }, [value, editing])

  const enterEdit = useCallback(() => {
    setDraft(value == null ? '' : String(value))
    setEditing(true)
  }, [value])

  const cancel = useCallback(() => {
    setDraft(value == null ? '' : String(value))
    setEditing(false)
  }, [value])

  const commit = useCallback(() => {
    let next: string | number | null
    if (props.kind === 'number') {
      const trimmed = draft.trim()
      if (trimmed === '') {
        next = null
      } else {
        const n = Number(trimmed)
        if (Number.isNaN(n)) {
          cancel()
          return
        }
        next = n
      }
    } else if (props.kind === 'select') {
      next = draft
    } else {
      next = draft
    }
    setEditing(false)
    if (next === value || (next == null && (value == null || value === ''))) return
    onCommit(next)
  }, [draft, value, props.kind, onCommit, cancel])

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    },
    [commit, cancel],
  )

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      if ('select' in inputRef.current) inputRef.current.select?.()
    }
  }, [editing])

  if (editing) {
    if (props.kind === 'select') {
      return (
        <select
          ref={(el) => {
            inputRef.current = el
          }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          className={cn(
            'w-full px-1 py-0.5 rounded border border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white dark:bg-zinc-900',
            compact ? 'text-xs' : 'text-sm',
            className,
          )}
        >
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    }
    return (
      <input
        ref={(el) => {
          inputRef.current = el
        }}
        type={props.kind === 'number' ? 'number' : 'text'}
        step={props.kind === 'number' ? props.step ?? 0.01 : undefined}
        min={props.kind === 'number' ? props.min : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className={cn(
          'w-full px-1 py-0.5 rounded border border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white dark:bg-zinc-900',
          compact ? 'text-xs' : 'text-sm',
          props.kind === 'number' && 'text-right tabular-nums',
          className,
        )}
      />
    )
  }

  // ── Display (not editing) ──────────────────────────────────────
  const displayValue =
    value == null || value === ''
      ? (placeholder ?? '—')
      : props.kind === 'number'
      ? typeof value === 'number'
        ? formatNumber(value, props.step)
        : String(value)
      : props.kind === 'select'
      ? props.options.find((o) => o.value === value)?.label ?? String(value)
      : String(value)

  const isPlaceholder = value == null || value === ''

  return (
    <button
      type="button"
      onClick={enterEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          enterEdit()
        }
      }}
      data-cell-key={cellKey}
      className={cn(
        'w-full text-left rounded px-1 py-0.5 truncate',
        'hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-blue-400',
        isPlaceholder && 'italic text-zinc-400',
        props.kind === 'number' && 'text-right tabular-nums',
        className,
      )}
      aria-label={`Edit ${cellKey}`}
    >
      {displayValue}
    </button>
  )
}

function formatNumber(n: number, step?: number): string {
  if (step != null && step < 1) {
    const decimals = Math.max(0, -Math.floor(Math.log10(step)))
    return n.toFixed(decimals)
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
