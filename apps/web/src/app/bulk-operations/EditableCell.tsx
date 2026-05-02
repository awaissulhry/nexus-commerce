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
  initialValue: unknown
  /** Bumped after a successful Phase C save so cells reset isDirty */
  serverVersion: number
  meta: EditableMeta
  onCommit: (rowId: string, columnId: string, value: unknown) => void
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
 *   - Re-renders ONLY when (rowId, columnId, initialValue, serverVersion)
 *     changes. The custom memo comparator guarantees this even when the
 *     parent re-runs.
 *   - Local state owns isEditing / draftValue / isDirty so typing in
 *     this cell does not propagate state up the tree until blur/commit.
 *   - Commit updates the parent's changesMap via onCommit. The cell
 *     keeps its local isDirty=true until serverVersion bumps (after
 *     save), at which point useEffect resets isDirty + draftValue from
 *     the new initialValue.
 */
export const EditableCell = memo(
  function EditableCell({
    rowId,
    columnId,
    initialValue,
    serverVersion,
    meta,
    onCommit,
  }: Props) {
    const [isEditing, setIsEditing] = useState(false)
    const [draftValue, setDraftValue] = useState<unknown>(initialValue)
    const [isDirty, setIsDirty] = useState(false)
    const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

    // After a save (serverVersion bumps) or a hard initialValue change,
    // reset local state so this cell mirrors the canonical server value.
    useEffect(() => {
      setDraftValue(initialValue)
      setIsDirty(false)
      setIsEditing(false)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverVersion])

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

    const commitIfChanged = useCallback(
      (value: unknown) => {
        const changed = !shallowEquals(value, initialValue)
        if (changed) {
          setIsDirty(true)
          onCommit(rowId, columnId, value)
        } else {
          setIsDirty(false)
          // Pass through the original so parent can remove from changesMap
          onCommit(rowId, columnId, initialValue)
        }
      },
      [initialValue, rowId, columnId, onCommit]
    )

    const handleBlur = useCallback(() => {
      setIsEditing(false)
      commitIfChanged(draftValue)
    }, [draftValue, commitIfChanged])

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
        'w-full h-full px-2 outline-none ring-2 ring-blue-500 bg-white text-[13px]'
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
        className={cn(
          'w-full h-full px-2 flex items-center text-[13px] cursor-cell',
          'focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-inset',
          isDirty && 'bg-yellow-50',
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
    prev.serverVersion === next.serverVersion &&
    shallowEquals(prev.initialValue, next.initialValue) &&
    prev.meta === next.meta &&
    prev.onCommit === next.onCommit
)

function shallowEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  // Numbers: compare as numbers (handles 5 vs 5.0)
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}
