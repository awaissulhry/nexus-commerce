'use client'

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { cn } from '@/lib/utils'

export type FieldType = 'text' | 'number' | 'select'

export interface EditableMeta {
  editable: true
  fieldType: FieldType
  options?: string[]
  numeric?: boolean
  prefix?: string
  parse?: (raw: string) => unknown
  format?: (v: unknown) => string
}

interface Props {
  rowId: string
  columnId: string
  /** Canonical server value. When the parent updates products[] (after
   * a successful save), this prop changes and the memo comparator
   * triggers a re-render — only for cells whose value actually changed. */
  initialValue: unknown
  meta: EditableMeta
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  /** Set when a backend save rejected this specific cell. undefined for
   * the vast majority of cells; only failed cells re-render when this
   * map updates. */
  cellError?: string
  /** When this number changes, the cell resets its draftValue back to
   * initialValue. Used to revert pending edits that were rejected by a
   * higher-level flow (e.g., user cancelled the cascade choice modal).
   * Undefined means "no reset request"; treat as 0. */
  resetKey?: number
  /** True when this cell's pending change is a cascade. Drives the
   * orange-tinted background instead of yellow. */
  cellCascading?: boolean
}

const defaultFormat = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  return String(v)
}

const defaultParse = (raw: string, fieldType: FieldType): unknown => {
  if (fieldType === 'number') {
    if (raw === '' || raw === '-') return null
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  return raw
}

/**
 * Single editable cell.
 *
 * Performance contract:
 *   - Re-renders ONLY when (rowId, columnId, initialValue) actually
 *     changes. Custom memo comparator enforces this.
 *   - Local state owns only isEditing + draftValue. isDirty is DERIVED
 *     from `draftValue !== initialValue` — no separate state. When a
 *     successful save updates products[] in the parent, ONLY the cells
 *     whose value changed get a new initialValue prop (object identity
 *     stays for unchanged rows), so only those cells re-render. Yellow
 *     highlight clears automatically because draftValue and the new
 *     initialValue now match.
 *   - Commit reports the cell's current draftValue to the parent via
 *     onCommit; parent decides whether to add or remove the entry from
 *     its changesMap based on equality with the original.
 */
export const EditableCell = memo(
  function EditableCell({
    rowId,
    columnId,
    initialValue,
    meta,
    onCommit,
    cellError,
    resetKey,
    cellCascading,
  }: Props) {
    const [isEditing, setIsEditing] = useState(false)
    const [draftValue, setDraftValue] = useState<unknown>(initialValue)
    const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

    // Derived, NOT tracked as state. When the parent updates products[]
    // after a save, the new initialValue flows in via props, the memo
    // comparator triggers a re-render, and isDirty naturally evaluates
    // to false (because draftValue now equals the new server value).
    const isDirty = !shallowEquals(draftValue, initialValue)

    // resetKey reset: parent bumped the counter to ask us to throw away
    // local state (e.g., cascade modal cancelled). Only fires when the
    // value actually changes — initial undefined → undefined is a no-op.
    useEffect(() => {
      if (resetKey === undefined) return
      setDraftValue(initialValue)
      setIsEditing(false)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey])

    const enterEdit = useCallback(() => {
      setIsEditing(true)
      // Focus + select after the input mounts
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          if ('select' in el && typeof el.select === 'function') {
            el.select()
          }
        }
      })
    }, [])

    const handleBlur = useCallback(() => {
      setIsEditing(false)
      // Always notify the parent — it'll add or remove from changesMap
      // based on whether draftValue equals the original. Parent has the
      // canonical comparison logic; cell just reports its current value.
      onCommit(rowId, columnId, draftValue)
    }, [draftValue, rowId, columnId, onCommit])

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraftValue(initialValue)
          setIsEditing(false)
          // Don't commit; isDirty stays as it was before this edit
        }
        // Tab is left to native behaviour — the browser moves focus
        // to the next focusable input, which is an adjacent cell.
      },
      [initialValue]
    )

    if (isEditing) {
      const baseInputClass =
        'w-full h-full px-2 outline-none ring-2 ring-blue-500 bg-white text-[13px] select-text'
      if (meta.fieldType === 'select') {
        return (
          <select
            ref={(el) => {
              inputRef.current = el
            }}
            value={String(draftValue ?? '')}
            onChange={(e) => setDraftValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={cn(baseInputClass, meta.numeric && 'tabular-nums text-right')}
          >
            {(meta.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
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
          type={meta.fieldType === 'number' ? 'number' : 'text'}
          step={meta.fieldType === 'number' ? 'any' : undefined}
          value={
            draftValue === null || draftValue === undefined
              ? ''
              : String(draftValue)
          }
          onChange={(e) => {
            const parsed = meta.parse
              ? meta.parse(e.target.value)
              : defaultParse(e.target.value, meta.fieldType)
            setDraftValue(parsed)
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={cn(baseInputClass, meta.numeric && 'tabular-nums text-right')}
        />
      )
    }

    const display = meta.format ? meta.format(draftValue) : defaultFormat(draftValue)

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={enterEdit}
        onFocus={enterEdit}
        onKeyDown={(e) => {
          // F2 or Enter to enter edit mode when focused via Tab
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault()
            enterEdit()
          }
        }}
        title={cellError ?? (cellCascading && isDirty ? 'Will cascade to children' : undefined)}
        className={cn(
          'w-full h-full px-2 flex items-center text-[13px] cursor-cell',
          'focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-inset',
          isDirty && !cellError && !cellCascading && 'bg-yellow-50',
          isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
          cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          meta.numeric && 'tabular-nums justify-end'
        )}
      >
        {meta.prefix && display && <span className="text-slate-500 mr-1">{meta.prefix}</span>}
        <span className="truncate">{display || <span className="text-slate-300">—</span>}</span>
      </div>
    )
  },
  (prev, next) =>
    prev.rowId === next.rowId &&
    prev.columnId === next.columnId &&
    shallowEquals(prev.initialValue, next.initialValue) &&
    prev.meta === next.meta &&
    prev.onCommit === next.onCommit &&
    prev.cellError === next.cellError &&
    prev.resetKey === next.resetKey &&
    prev.cellCascading === next.cellCascading
)

function shallowEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  // Numbers: compare as numbers (handles 5 vs 5.0)
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}
