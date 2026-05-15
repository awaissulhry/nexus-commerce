'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X, Replace } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  buildSearchRegex,
  findMatches,
  applyScope,
  replaceInString,
  type FindCell,
  type FindMatch,
  type FindOptions,
  type FindScope,
} from '../find-replace'

/**
 * W3.2 — Find & Replace floating bar. Sits at the top-right of the
 * grid container, opens on Cmd/Ctrl+F (parent wires the shortcut and
 * the open state). Self-contained — every find option, the match
 * cursor, and the replace flow live in this component. The parent
 * supplies:
 *   - cells: a flat list of every cell currently in the grid (used
 *     by find-replace.ts's pure functions)
 *   - rangeBounds: the selection box if any
 *   - visibleColumns: id + label pairs to populate the column-scope
 *     dropdown
 *   - onActivate(rowIdx, colIdx): called when the operator clicks
 *     Next / Prev — parent scrolls the cell into view + selects it
 *   - onMatchSetChange(set): the {rowIdx:colIdx} keys to highlight
 *   - onReplaceCell(rowId, columnId, newValue, batch): one cell
 *     write; W3.4 wires this through writeChange + a single
 *     history-batch entry so Cmd+Z reverts the whole replace-all.
 */

export interface FindReplaceBarProps {
  open: boolean
  onClose: () => void
  cells: FindCell[]
  rangeBounds: {
    minRow: number
    maxRow: number
    minCol: number
    maxCol: number
  } | null
  visibleColumns: Array<{ id: string; label: string }>
  /** Called when the operator activates a match (Next / Prev). The
   *  parent typically focuses + selects the cell so it's visible. */
  onActivate: (match: FindMatch) => void
  /** Called whenever the highlighted match-set changes — parent
   *  paints overlays for these (rowIdx,colIdx) keys. */
  onMatchSetChange: (keys: Set<string>) => void
  /** W3.4 — replace one cell. The optional `batch` lets the bar
   *  collect every replacement in a Replace-All into a single
   *  HistoryDelta[] so undo reverts the whole operation. */
  onReplaceCell: (
    rowId: string,
    columnId: string,
    newValue: unknown,
    batch?: unknown[],
  ) => void
  /** W3.4 — once a replace-all batch finishes, the bar tells the
   *  parent to push it onto the history stack. */
  onCommitReplaceBatch?: (batch: unknown[]) => void
}

type Scope = 'all' | 'selection' | 'column'

export function FindReplaceBar(props: FindReplaceBarProps) {
  const {
    open,
    onClose,
    cells,
    rangeBounds,
    visibleColumns,
    onActivate,
    onMatchSetChange,
    onReplaceCell,
    onCommitReplaceBatch,
  } = props

  // ── search state ────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [scope, setScope] = useState<Scope>(
    rangeBounds ? 'selection' : 'all',
  )
  const [columnId, setColumnId] = useState<string>(
    visibleColumns[0]?.id ?? '',
  )
  const [showReplace, setShowReplace] = useState(false)
  const [cursor, setCursor] = useState(0)

  const queryRef = useRef<HTMLInputElement>(null)

  // Reset cursor when the query changes — operators expect Next to
  // move forward from match #1 after retyping.
  useEffect(() => {
    setCursor(0)
  }, [query, caseSensitive, wholeWord, regex, scope, columnId])

  // Focus the query input on open — operators reach for Cmd+F and
  // expect to start typing immediately.
  useEffect(() => {
    if (open) {
      queryRef.current?.focus()
      queryRef.current?.select()
    }
  }, [open])

  const opts: FindOptions = useMemo(
    () => ({ query, caseSensitive, wholeWord, regex }),
    [query, caseSensitive, wholeWord, regex],
  )

  // Validate regex up front so the toolbar can dim Next/Replace
  // and surface 'Invalid regex' rather than silently 0-matching.
  const regexInvalid = regex && query.length > 0 && buildSearchRegex(opts) === null

  const findScope: FindScope = useMemo(
    () => ({
      kind: scope,
      bounds: scope === 'selection' ? rangeBounds ?? undefined : undefined,
      columnId: scope === 'column' ? columnId : undefined,
    }),
    [scope, rangeBounds, columnId],
  )

  const scoped = useMemo(() => applyScope(cells, findScope), [cells, findScope])
  const matches = useMemo(() => findMatches(scoped, opts), [scoped, opts])

  // Notify the grid overlay layer of the new match-set whenever it
  // changes. Done in an effect (not inline) so re-renders don't
  // thrash the parent's setState.
  useEffect(() => {
    if (!open) {
      onMatchSetChange(new Set())
      return
    }
    const keys = new Set<string>()
    for (const m of matches) keys.add(`${m.rowIdx}:${m.colIdx}`)
    onMatchSetChange(keys)
  }, [open, matches, onMatchSetChange])

  // Keep the cursor in range as matches change.
  const safeCursor = matches.length === 0 ? 0 : Math.min(cursor, matches.length - 1)

  const goNext = () => {
    if (matches.length === 0) return
    const next = (safeCursor + 1) % matches.length
    setCursor(next)
    onActivate(matches[next])
  }
  const goPrev = () => {
    if (matches.length === 0) return
    const next = (safeCursor - 1 + matches.length) % matches.length
    setCursor(next)
    onActivate(matches[next])
  }

  // ── replace ────────────────────────────────────────────────────
  const replaceOne = () => {
    if (matches.length === 0) return
    const m = matches[safeCursor]
    const next = replaceInString(m.display, opts, replacement)
    if (next === m.display) {
      // No-op replacement (e.g., search and replacement were the
      // same string). Skip the write but advance to the next match
      // so Replace-One stays useful as a "skip" affordance.
      goNext()
      return
    }
    onReplaceCell(m.rowId, m.columnId, next)
    // After replacing, the match list will refresh (parent re-renders
    // with the new value) and our cursor will land on the next match
    // automatically. To make Replace feel snappy when the next match
    // sits in the same cell (e.g., 'aa' → 'b' on 'aaa'), advance
    // explicitly so the operator doesn't see the cursor sitting on a
    // now-stale entry.
    setCursor((c) => Math.min(c + 1, Math.max(0, matches.length - 1)))
  }

  const replaceAll = () => {
    if (matches.length === 0) return
    const batch: unknown[] = []
    for (const m of matches) {
      const next = replaceInString(m.display, opts, replacement)
      if (next === m.display) continue
      onReplaceCell(m.rowId, m.columnId, next, batch)
    }
    if (batch.length > 0 && onCommitReplaceBatch) {
      onCommitReplaceBatch(batch)
    }
  }

  // ── keyboard shortcuts inside the bar ──────────────────────────
  const onBarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      // Enter = next, Shift+Enter = prev — Excel / Sheets / Notion
      // all share this convention.
      e.preventDefault()
      if (e.shiftKey) goPrev()
      else goNext()
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Find and replace"
      onKeyDown={onBarKeyDown}
      className="absolute right-3 top-3 z-20 w-[420px] bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-2"
    >
      {/* Find row */}
      <div className="flex items-center gap-1.5">
        <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <input
          ref={queryRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find…"
          className="flex-1 h-7 px-2 text-md border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <span
          className={cn(
            'text-xs tabular-nums whitespace-nowrap min-w-[3rem] text-center',
            matches.length === 0 ? 'text-slate-400' : 'text-slate-600',
            regexInvalid && 'text-red-600',
          )}
          aria-live="polite"
        >
          {regexInvalid
            ? 'invalid'
            : matches.length === 0
              ? '0'
              : `${safeCursor + 1} of ${matches.length}`}
        </span>
        <button
          type="button"
          onClick={goPrev}
          disabled={matches.length === 0}
          className="h-7 w-7 inline-flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-30 rounded"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={matches.length === 0}
          className="h-7 w-7 inline-flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:opacity-30 rounded"
          aria-label="Next match"
          title="Next match (Enter)"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 inline-flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded"
          aria-label="Close find"
          title="Close (Esc)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Options row */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <button
          type="button"
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(
            'h-6 px-1.5 rounded font-mono uppercase tracking-wide border',
            caseSensitive
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50',
          )}
          aria-pressed={caseSensitive}
          title="Case sensitive"
        >
          Aa
        </button>
        <button
          type="button"
          onClick={() => setWholeWord((v) => !v)}
          className={cn(
            'h-6 px-1.5 rounded font-mono uppercase tracking-wide border',
            wholeWord
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50',
          )}
          aria-pressed={wholeWord}
          title="Whole word"
        >
          Ab|
        </button>
        <button
          type="button"
          onClick={() => setRegex((v) => !v)}
          className={cn(
            'h-6 px-1.5 rounded font-mono uppercase tracking-wide border',
            regex
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50',
          )}
          aria-pressed={regex}
          title="Regular expression"
        >
          .*
        </button>

        <span className="ml-1 text-slate-400">in</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
          className="h-6 px-1.5 text-xs border border-slate-200 rounded bg-white"
        >
          <option value="all">All cells</option>
          <option value="selection" disabled={!rangeBounds}>
            Selection {rangeBounds ? '' : '(none)'}
          </option>
          <option value="column">Column…</option>
        </select>
        {scope === 'column' && (
          <select
            value={columnId}
            onChange={(e) => setColumnId(e.target.value)}
            className="h-6 px-1.5 text-xs border border-slate-200 rounded bg-white max-w-[140px]"
          >
            {visibleColumns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          className={cn(
            'ml-auto h-6 px-1.5 inline-flex items-center gap-1 rounded border text-xs',
            showReplace
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50',
          )}
          aria-pressed={showReplace}
        >
          <Replace className="w-3 h-3" />
          Replace
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="flex items-center gap-1.5">
          <Replace className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          <input
            type="text"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with…"
            className="flex-1 h-7 px-2 text-md border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={replaceOne}
            disabled={matches.length === 0 || regexInvalid}
            className="h-7 px-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
            title="Replace this match"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={replaceAll}
            disabled={matches.length === 0 || regexInvalid}
            className="h-7 px-2 text-xs font-medium text-white bg-blue-600 border border-blue-600 rounded hover:bg-blue-700 disabled:opacity-40"
            title="Replace all matches"
          >
            All ({matches.length})
          </button>
        </div>
      )}
    </div>
  )
}
