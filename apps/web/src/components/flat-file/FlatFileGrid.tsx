'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
  type KeyboardEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  ArrowRightLeft, ClipboardPaste, Copy, Image as ImageIcon, Loader2, Pin, Plus,
  Search, Trash2, Undo2, Redo2, Replace, SlidersHorizontal, Sparkles, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { FindReplaceBar } from '@/app/bulk-operations/components/FindReplaceBar'
import { ConditionalFormatBar } from '@/app/bulk-operations/components/ConditionalFormatBar'
import { evaluateRule, TONE_CLASSES, type ConditionalRule } from '@/app/bulk-operations/lib/conditional-format'
import { type FindCell } from '@/app/bulk-operations/lib/find-replace'
import { FFFilterPanel, FF_FILTER_DEFAULT, type FFFilterState } from '@/app/products/amazon-flat-file/FFFilterPanel'
import { FFSavedViews, type FFViewState } from '@/app/products/amazon-flat-file/FFSavedViews'
import { AIBulkModal } from '@/app/products/amazon-flat-file/AIBulkModal'
import { FFReplicateModal } from '@/app/products/amazon-flat-file/FFReplicateModal'
import type {
  FlatFileGridProps, BaseRow, FlatFileColumn, FlatFileColumnGroup,
  ValidationIssue, RenderCellContent, ModalsCtx, ToolbarFetchCtx, ToolbarImportCtx, ReplicateCtx,
} from './FlatFileGrid.types'

// ── Internal types ─────────────────────────────────────────────────────────

interface NormSel { rMin: number; rMax: number; cMin: number; cMax: number }

// ── Constants ──────────────────────────────────────────────────────────────

const GROUP_COLORS: Record<string, { band: string; header: string; text: string; cell: string; badge: string }> = {
  blue:    { band: 'bg-blue-50 dark:bg-blue-950/30', header: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200', text: 'text-blue-700 dark:text-blue-300', cell: 'bg-blue-50/50 dark:bg-blue-950/10', badge: 'bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800' },
  purple:  { band: 'bg-purple-50 dark:bg-purple-950/30', header: 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200', text: 'text-purple-700 dark:text-purple-300', cell: 'bg-purple-50/50 dark:bg-purple-950/10', badge: 'bg-purple-100 text-purple-700 border border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800' },
  emerald: { band: 'bg-emerald-50 dark:bg-emerald-950/30', header: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200', text: 'text-emerald-700 dark:text-emerald-300', cell: 'bg-emerald-50/50 dark:bg-emerald-950/10', badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' },
  orange:  { band: 'bg-orange-50 dark:bg-orange-950/30', header: 'bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-200', text: 'text-orange-700 dark:text-orange-300', cell: 'bg-orange-50/50 dark:bg-orange-950/10', badge: 'bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800' },
  teal:    { band: 'bg-teal-50 dark:bg-teal-950/30', header: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-200', text: 'text-teal-700 dark:text-teal-300', cell: 'bg-teal-50/50 dark:bg-teal-950/10', badge: 'bg-teal-100 text-teal-700 border border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800' },
  amber:   { band: 'bg-amber-50 dark:bg-amber-950/30', header: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200', text: 'text-amber-700 dark:text-amber-300', cell: 'bg-amber-50/50 dark:bg-amber-950/10', badge: 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  sky:     { band: 'bg-sky-50 dark:bg-sky-950/30', header: 'bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-200', text: 'text-sky-700 dark:text-sky-300', cell: 'bg-sky-50/50 dark:bg-sky-950/10', badge: 'bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800' },
  red:     { band: 'bg-red-50 dark:bg-red-950/30', header: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200', text: 'text-red-700 dark:text-red-300', cell: 'bg-red-50/50 dark:bg-red-950/10', badge: 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800' },
  violet:  { band: 'bg-violet-50 dark:bg-violet-950/30', header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', text: 'text-violet-700 dark:text-violet-300', cell: 'bg-violet-50/50 dark:bg-violet-950/10', badge: 'bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
  slate:   { band: 'bg-slate-50 dark:bg-slate-900/30', header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300', text: 'text-slate-600 dark:text-slate-400', cell: '', badge: 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700' },
}

function gColor(color: string) { return GROUP_COLORS[color] ?? GROUP_COLORS.slate }

function statusBadgeCls(status?: string | null) {
  switch (status?.toUpperCase()) {
    case 'ACTIVE': return 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'DRAFT':  return 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
    case 'ERROR':  return 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300'
    default:       return 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400'
  }
}
void statusBadgeCls

function padToMin(rows: BaseRow[], make: () => BaseRow, min: number): BaseRow[] {
  if (rows.length >= min) return rows
  return [...rows, ...Array.from({ length: min - rows.length }, make)]
}

// ── TbBtn ──────────────────────────────────────────────────────────────────

function TbBtn({ icon, title, onClick, disabled, active, badge }: {
  icon: React.ReactNode; title: string; onClick?: () => void
  disabled?: boolean; active?: boolean; badge?: number
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={cn(
        'relative h-7 w-7 flex items-center justify-center rounded transition-colors flex-shrink-0',
        active ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
               : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
        'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent dark:disabled:hover:bg-transparent',
      )}>
      {icon}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold bg-blue-500 text-white rounded-full flex items-center justify-center leading-none pointer-events-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

// ── MenuDropdown ───────────────────────────────────────────────────────────

function MenuDropdown({ label, items }: { label: string; items: Array<{ label?: string; icon?: React.ReactNode; shortcut?: string; onClick?: () => void; disabled?: boolean; separator?: boolean }> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function h(e: MouseEvent) { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [])
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={cn('h-7 px-2.5 text-xs font-medium rounded transition-colors',
          open ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
               : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100')}>
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-0.5 z-50 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 overflow-hidden">
          {items.map((item, i) => item.separator
            ? <div key={i} className="my-1 border-t border-slate-100 dark:border-slate-800" />
            : <button key={i} type="button" disabled={item.disabled}
                onClick={() => { if (!item.disabled && item.onClick) { item.onClick(); setOpen(false) } }}
                className={cn('w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left transition-colors',
                  item.disabled ? 'text-slate-300 dark:text-slate-600 cursor-default'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800')}>
                {item.icon && <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && <span className="text-[10px] font-mono text-slate-400">{item.shortcut}</span>}
              </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Text helpers ───────────────────────────────────────────────────────────

function getCharIndexFromPoint(x: number, y: number): number {
  if (typeof document === 'undefined') return -1
  if ('caretRangeFromPoint' in document) {
    const range = (document as any).caretRangeFromPoint(x, y) as Range | null
    if (range?.startContainer?.nodeType === Node.TEXT_NODE) return range.startOffset
  }
  if ('caretPositionFromPoint' in document) {
    const pos = (document as any).caretPositionFromPoint(x, y) as { offsetNode: Node; offset: number } | null
    if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) return pos.offset
  }
  return -1
}

function wordBoundsAt(text: string, pos: number): [number, number] {
  if (!text) return [0, 0]
  const p = Math.min(Math.max(pos, 0), text.length)
  const isWordChar = /\w/
  let start = p; while (start > 0 && isWordChar.test(text[start - 1])) start--
  let end = p;   while (end < text.length && isWordChar.test(text[end])) end++
  return start === end ? [p, p] : [start, end]
}

// ── EnumDropdown ───────────────────────────────────────────────────────────

function EnumDropdown({ options, current, onSelect, onClose }: {
  options: string[]; current: string; onSelect: (v: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => { const q = query.toLowerCase(); return options.filter((o) => !q || o.toLowerCase().includes(q)) }, [options, query])
  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => { setHi(0) }, [filtered])
  useEffect(() => { (listRef.current?.children[hi] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }) }, [hi])
  useEffect(() => {
    function h(e: MouseEvent) { if (!listRef.current?.parentElement?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [onClose])
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi] != null) onSelect(filtered[hi]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); if (filtered[hi] != null) onSelect(filtered[hi]) }
  }
  return (
    <div className="absolute left-0 top-full mt-0 z-50 w-48 min-w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden" onKeyDown={handleKeyDown}>
      <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
          className="w-full text-xs px-1.5 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>
      <div ref={listRef} className="max-h-48 overflow-y-auto">
        {filtered.length === 0
          ? <div className="px-3 py-2 text-xs text-slate-400 italic">No matches</div>
          : filtered.map((opt, i) => (
            <div key={opt || '_empty'} role="option" aria-selected={opt === current}
              onMouseDown={(e) => { e.preventDefault(); onSelect(opt) }}
              onMouseEnter={() => setHi(i)}
              className={cn('px-3 py-1.5 text-xs cursor-pointer truncate',
                i === hi ? 'bg-blue-500 text-white'
                : opt === current ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50')}>
              {opt === '' ? <span className="italic opacity-60">— empty —</span> : opt}
            </div>
          ))}
      </div>
    </div>
  )
}

// ── SpreadsheetCell ────────────────────────────────────────────────────────

interface CellInternalProps {
  col: FlatFileColumn; row: BaseRow; value: unknown
  isActive: boolean; cellBg: string; width: number; cellHeight: number
  ri: number; ci: number
  isSelected: boolean
  selEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  isCorner: boolean
  isFillTarget: boolean
  fillTargetEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  isEditing: boolean; editInitialChar: string | null
  isClipboard: boolean
  clipboardEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  validIssue?: ValidationIssue; stickyLeft?: number
  isMatch?: boolean; toneCls?: string
  renderCellContent?: RenderCellContent
  onCellPointerDown: (shiftKey: boolean) => void
  onCellDoubleClick: () => void
  onFillHandlePointerDown: () => void
  onFillDrop: () => void
  onDeactivate: () => void
  onChange: (val: unknown) => void
  onLiveChange: (val: string) => void
  onPushSnapshot: () => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetCell({ col, row, value, isActive, cellBg, width, cellHeight, ri, ci,
  isSelected, selEdges, isCorner, isFillTarget, fillTargetEdges,
  isEditing, editInitialChar, isClipboard, clipboardEdges,
  validIssue, stickyLeft, isMatch, toneCls,
  renderCellContent,
  onCellPointerDown, onCellDoubleClick, onFillHandlePointerDown, onFillDrop,
  onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate,
}: CellInternalProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [liveLen, setLiveLen] = useState(displayValue.length)
  const cancelledRef = useRef(false)
  const pendingWordSelRef = useRef<{ start: number; end: number } | null | undefined>(undefined)
  const originalValueRef = useRef('')
  const snapshotPushedRef = useRef(false)

  const isReadOnly = col.readOnly || col.kind === 'readonly'

  useEffect(() => {
    if (!isEditing || col.kind === 'enum' || col.kind === 'boolean' || !inputRef.current) return
    inputRef.current.focus()
    if (editInitialChar !== null) return
    const pending = pendingWordSelRef.current
    if (pending !== undefined) {
      requestAnimationFrame(() => {
        const inp = inputRef.current as HTMLInputElement | null
        if (!inp) return
        if (pending !== null) inp.setSelectionRange(pending.start, pending.end)
        else inp.setSelectionRange(displayValue.length, displayValue.length)
        pendingWordSelRef.current = undefined
      })
      return
    }
    if ('select' in inputRef.current) (inputRef.current as HTMLInputElement).select()
  }, [isEditing, col.kind, editInitialChar])

  useEffect(() => { if (isEditing) { snapshotPushedRef.current = false } }, [isEditing])
  useEffect(() => { if (isEditing) setLiveLen(displayValue.length) }, [isEditing])

  const isEmpty = !displayValue
  const cellStyle: React.CSSProperties = {
    minWidth: width, width,
    ...(stickyLeft !== undefined ? { position: 'sticky' as const, left: stickyLeft, zIndex: 4 } : {}),
  }
  const hStyle = { height: cellHeight }

  const selStyle: React.CSSProperties = selEdges ? {
    borderTop:    selEdges.top    ? '2px solid #3b82f6' : undefined,
    borderRight:  selEdges.right  ? '2px solid #3b82f6' : undefined,
    borderBottom: selEdges.bottom ? '2px solid #3b82f6' : undefined,
    borderLeft:   selEdges.left   ? '2px solid #3b82f6' : undefined,
  } : fillTargetEdges ? {
    borderTop:    fillTargetEdges.top    ? '2px dashed #3b82f6' : undefined,
    borderRight:  fillTargetEdges.right  ? '2px dashed #3b82f6' : undefined,
    borderBottom: fillTargetEdges.bottom ? '2px dashed #3b82f6' : undefined,
    borderLeft:   fillTargetEdges.left   ? '2px dashed #3b82f6' : undefined,
  } : clipboardEdges ? {
    borderTop:    clipboardEdges.top    ? '2px dashed #22c55e' : undefined,
    borderRight:  clipboardEdges.right  ? '2px dashed #22c55e' : undefined,
    borderBottom: clipboardEdges.bottom ? '2px dashed #22c55e' : undefined,
    borderLeft:   clipboardEdges.left   ? '2px dashed #22c55e' : undefined,
  } : {}

  const baseCls = cn(
    'border-b border-r border-slate-200 dark:border-slate-700 relative transition-colors',
    isSelected ? 'bg-blue-100/60 dark:bg-blue-900/20'
    : isClipboard ? 'bg-green-50/40 dark:bg-green-900/10'
    : isFillTarget ? 'bg-blue-50/80 dark:bg-blue-900/10'
    : isMatch ? 'bg-yellow-100 dark:bg-yellow-900/30'
    : toneCls ? toneCls
    : cellBg,
    isActive && !isEditing && 'outline outline-2 outline-blue-500 outline-offset-[-1px] z-[5]',
    isEditing && 'ring-2 ring-inset ring-blue-500 z-[5]',
    !isActive && !isSelected && !isMatch && !toneCls && (
      validIssue?.level === 'error' ? 'bg-red-100/80 dark:bg-red-950/30'
      : validIssue?.level === 'warn' ? 'bg-amber-50/80 dark:bg-amber-950/20'
      : ''
    ),
    isReadOnly && 'opacity-75',
  )

  const tdPointerDown = (e: React.PointerEvent<HTMLTableCellElement>) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    if (isEditing && (tag === 'INPUT' || tag === 'TEXTAREA')) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    onCellPointerDown(e.shiftKey)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') { e.preventDefault(); onNavigate(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Enter' && col.kind !== 'longtext') { e.preventDefault(); onNavigate(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Escape') {
      if (snapshotPushedRef.current) { onLiveChange(originalValueRef.current); snapshotPushedRef.current = false }
      cancelledRef.current = true
      onDeactivate(); setDropdownOpen(false)
    }
    else if (e.key === 'ArrowDown' && (col.kind === 'enum' || col.kind === 'boolean')) { e.preventDefault(); setDropdownOpen(true) }
  }

  const fillHandle = isCorner ? (
    <div className="absolute bottom-[-3px] right-[-3px] w-[7px] h-[7px] bg-blue-500 border-[1.5px] border-white dark:border-slate-900 z-20 cursor-crosshair"
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.releasePointerCapture(e.pointerId); onFillHandlePointerDown() }} />
  ) : null

  const tdShared = {
    'data-ri': ri, 'data-ci': ci,
    onPointerDown: tdPointerDown,
    onPointerUp: onFillDrop,
    onDoubleClick: (e: React.MouseEvent) => {
      const charPos = getCharIndexFromPoint(e.clientX, e.clientY)
      if (charPos >= 0) { const [s, end] = wordBoundsAt(displayValue, charPos); pendingWordSelRef.current = { start: s, end } }
      else { pendingWordSelRef.current = null }
      onCellDoubleClick()
    },
  }

  // Readonly cell
  if (isReadOnly) {
    const custom = renderCellContent?.(col, row, value, displayValue)
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <div className="px-1.5 flex items-center text-xs truncate text-slate-500 dark:text-slate-400" style={hStyle}>
          {custom ?? displayValue}
        </div>
      </td>
    )
  }

  // Enum / boolean cell
  const enumOptions = col.kind === 'boolean' ? ['', 'true', 'false'] : col.kind === 'enum' && col.options?.length ? col.options : null
  if (enumOptions) {
    const custom = renderCellContent?.(col, row, value, displayValue)
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}
        onClick={() => { if (isActive) setDropdownOpen(true) }}
        onDoubleClick={(e) => {
          const charPos = getCharIndexFromPoint(e.clientX, e.clientY)
          pendingWordSelRef.current = charPos >= 0 ? (() => { const [s, end] = wordBoundsAt(displayValue, charPos); return { start: s, end } })() : null
          onCellDoubleClick(); setDropdownOpen(true)
        }}>
        <div className="px-1.5 flex items-center justify-between gap-1 cursor-pointer group/cell" style={hStyle}>
          {custom != null ? custom : (
            <span className={cn('text-xs truncate flex-1', isEmpty ? 'text-slate-300 dark:text-slate-600 italic' : 'text-slate-800 dark:text-slate-200')}>
              {displayValue || (col.required ? '⚠ required' : enumOptions[1] ? `e.g. ${enumOptions[1]}` : '—')}
            </span>
          )}
          <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity" />
        </div>
        {fillHandle}
        {isActive && dropdownOpen && (
          <EnumDropdown options={enumOptions} current={displayValue}
            onSelect={(v) => { onChange(v); setDropdownOpen(false); onNavigate('right') }}
            onClose={() => { setDropdownOpen(false); onDeactivate() }} />
        )}
      </td>
    )
  }

  // Longtext cell
  if (col.kind === 'longtext') {
    if (isEditing) {
      const atLimit = col.maxLength != null && liveLen >= col.maxLength
      const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
      return (
        <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
          {fillHandle}
          <textarea ref={inputRef as any} defaultValue={editInitialChar !== null ? editInitialChar : displayValue}
            onInput={(e) => {
              const val = (e.target as HTMLTextAreaElement).value
              setLiveLen(val.length)
              if (!snapshotPushedRef.current) { originalValueRef.current = displayValue; onPushSnapshot(); snapshotPushedRef.current = true }
              onLiveChange(val)
            }}
            onBlur={() => { cancelledRef.current = false; onDeactivate() }}
            onKeyDown={handleKeyDown}
            maxLength={col.maxLength}
            className="w-full px-1.5 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200 resize-none"
            style={{ minWidth: width, minHeight: Math.max(cellHeight, 60) }} />
          {col.maxLength != null && (
            <div className={cn('absolute bottom-1 right-1.5 text-[9px] tabular-nums font-mono pointer-events-none select-none',
              atLimit ? 'text-red-500 font-bold' : nearLimit ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600')}>
              {liveLen}/{col.maxLength}
            </div>
          )}
        </td>
      )
    }
    const custom = renderCellContent?.(col, row, value, displayValue)
    return (
      <td {...tdShared} className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')} style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <div className="px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate" style={hStyle}>
          {custom ?? (displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{col.required ? '⚠ required' : ''}</span>)}
        </div>
      </td>
    )
  }

  // Text / number cell — editing
  if (isEditing) {
    const atLimit = col.maxLength != null && liveLen >= col.maxLength
    const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <input ref={inputRef as any} type={col.kind === 'number' ? 'number' : 'text'}
          defaultValue={editInitialChar !== null ? editInitialChar : displayValue} maxLength={col.maxLength}
          onInput={(e) => {
            const val = (e.target as HTMLInputElement).value
            setLiveLen(val.length)
            if (!snapshotPushedRef.current) { originalValueRef.current = displayValue; onPushSnapshot(); snapshotPushedRef.current = true }
            onLiveChange(val)
          }}
          onBlur={() => { cancelledRef.current = false; onDeactivate() }}
          onKeyDown={handleKeyDown}
          className="w-full px-1.5 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200"
          style={hStyle} />
        {col.maxLength != null && (
          <div className={cn('absolute bottom-0.5 right-1 text-[9px] tabular-nums font-mono pointer-events-none select-none leading-none',
            atLimit ? 'text-red-500 font-bold' : nearLimit ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600')}>
            {liveLen}/{col.maxLength}
          </div>
        )}
      </td>
    )
  }

  // Text / number — display
  const custom = renderCellContent?.(col, row, value, displayValue)
  return (
    <td {...tdShared} className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
      style={{ ...cellStyle, ...selStyle }} title={validIssue?.msg ?? col.description}>
      {fillHandle}
      <div className={cn('px-1.5 flex items-center text-xs truncate',
        isEmpty ? (col.required ? 'text-red-400 dark:text-red-500 italic' : 'text-slate-300 dark:text-slate-600') : 'text-slate-800 dark:text-slate-200')}
        style={hStyle}>
        {custom ?? (displayValue || (col.required ? '⚠ required' : ''))}
      </div>
    </td>
  )
}

// ── GroupHeader ────────────────────────────────────────────────────────────

function GroupHeader({ row, bandClass, isExpanded, onToggle, showImage, imageSize, colSpan }: {
  row: BaseRow; bandClass: string; isExpanded: boolean; onToggle: () => void
  showImage: boolean; imageSize: number; colSpan: number
}) {
  const label  = String(row.title ?? row.sku ?? row.item_sku ?? row._rowId)
  const imgUrl = row.image_1 as string | undefined
  return (
    <tr className={cn('border-b border-slate-200 dark:border-slate-700', bandClass)}>
      <td colSpan={colSpan} className="px-3 py-1">
        <div className="flex items-center gap-3">
          <button onClick={onToggle} className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !isExpanded && '-rotate-90')} />
            {label}
          </button>
          {showImage && imgUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imgUrl} alt="" style={{ width: imageSize, height: imageSize }}
              className="rounded object-cover border border-slate-200 dark:border-slate-700"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function FlatFileGrid({
  channel, title, titleIcon, marketplace, storageKey,
  columnGroups, initialRows, makeBlankRow, minRows = 15,
  getGroupKey, validate,
  onSave, onReload, onCellChange,
  renderCellContent, renderRowMeta, onBeforeEditCell,
  onReplicate,
  renderChannelStrip, renderPushExtras, renderFeedBanner, renderModals,
  renderToolbarFetch, renderToolbarImport, renderBar3Left,
}: FlatFileGridProps) {
  const router = useRouter()
  const { toast } = useToast()

  // ── Row state ──────────────────────────────────────────────────────────
  const paddedInitRef = useRef<BaseRow[] | null>(null)
  if (!paddedInitRef.current) paddedInitRef.current = padToMin(initialRows, makeBlankRow, minRows)

  const [rows, setRows]       = useState<BaseRow[]>(paddedInitRef.current)
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)

  // ── Undo / redo (Amazon-style history/future arrays) ───────────────────
  const rowsRef = useRef<BaseRow[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  const [history, setHistory] = useState<BaseRow[][]>([])
  const [future,  setFuture]  = useState<BaseRow[][]>([])

  const pushSnapshot = useCallback(() => {
    setHistory((prev) => [...prev.slice(-49), rowsRef.current])
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (!prev.length) return prev
      const next = [...prev]; const snap = next.pop()!
      setFuture((f) => [rowsRef.current, ...f.slice(0, 49)])
      setRows(snap)
      return next
    })
  }, [])

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (!prev.length) return prev
      const next = [...prev]; const snap = next.shift()!
      setHistory((h) => [...h.slice(-49), rowsRef.current])
      setRows(snap)
      return next
    })
  }, [])

  // ── Selection state ────────────────────────────────────────────────────
  const [selectedRows,   setSelectedRows]   = useState<Set<string>>(new Set())
  const [activeCell,     setActiveCell]     = useState<{ rowId: string; colId: string } | null>(null)
  const [selAnchor,      setSelAnchor]      = useState<{ ri: number; ci: number } | null>(null)
  const [selEnd,         setSelEnd]         = useState<{ ri: number; ci: number } | null>(null)
  const [isFillDragging, setIsFillDragging] = useState(false)
  const [fillDragEnd,    setFillDragEnd]    = useState<{ ri: number; ci: number } | null>(null)
  const [isEditing,      setIsEditing]      = useState(false)
  const [editInitialChar, setEditInitialChar] = useState<string | null>(null)
  const [clipboardRange, setClipboardRange] = useState<NormSel | null>(null)

  // ── Column / row resize ────────────────────────────────────────────────
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-col-widths`) ?? '{}') } catch { return {} }
  })
  const [rowHeight, setRowHeight] = useState<number>(() => {
    try { return Math.max(24, parseInt(localStorage.getItem(`${storageKey}-row-height`) ?? '28', 10) || 28) } catch { return 28 }
  })
  const [frozenColCount, setFrozenColCount] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(`${storageKey}-frozen-cols`) ?? '1', 10) || 1 } catch { return 1 }
  })
  const resizeDragRef = useRef<{ type: 'col' | 'row'; colId?: string; startX: number; startY: number; startVal: number } | null>(null)

  useEffect(() => { try { localStorage.setItem(`${storageKey}-col-widths`, JSON.stringify(colWidths)) } catch {} }, [colWidths, storageKey])
  useEffect(() => { try { localStorage.setItem(`${storageKey}-row-height`, String(rowHeight)) } catch {} }, [rowHeight, storageKey])
  useEffect(() => { try { localStorage.setItem(`${storageKey}-frozen-cols`, String(frozenColCount)) } catch {} }, [frozenColCount, storageKey])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = resizeDragRef.current; if (!d) return
      if (d.type === 'col' && d.colId) setColWidths((p) => ({ ...p, [d.colId!]: Math.max(60, d.startVal + e.clientX - d.startX) }))
      else if (d.type === 'row') setRowHeight(Math.max(24, d.startVal + e.clientY - d.startY))
    }
    function onUp() { resizeDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  const startColResize = useCallback((e: React.MouseEvent, colId: string, curW: number) => {
    e.preventDefault(); e.stopPropagation()
    resizeDragRef.current = { type: 'col', colId, startX: e.clientX, startY: 0, startVal: curW }
  }, [])
  const startRowResize = useCallback((e: React.MouseEvent, curH: number) => {
    e.preventDefault(); e.stopPropagation()
    resizeDragRef.current = { type: 'row', startX: 0, startY: e.clientY, startVal: curH }
  }, [])

  // ── UI toggles ─────────────────────────────────────────────────────────
  const [showFilter,      setShowFilter]      = useState(false)
  const [filterState,     setFilterState]     = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [showFindReplace, setShowFindReplace] = useState(false)
  const [showConditional, setShowConditional] = useState(false)
  const [cfRules,         setCfRules]         = useState<ConditionalRule[]>([])
  const [showValidation,  setShowValidation]  = useState(false)
  const [searchQuery,     setSearchQuery]     = useState('')
  const [saveFlash,       setSaveFlash]       = useState(false)
  const [aiModalOpen,     setAiModalOpen]     = useState(false)
  const [replicateOpen,   setReplicateOpen]   = useState(false)
  const [matchKeys,       setMatchKeys]       = useState<Set<string>>(new Set())
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-smart-paste`) === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem(`${storageKey}-smart-paste`, smartPasteEnabled ? '1' : '0') } catch {} }, [smartPasteEnabled, storageKey])

  // ── Image row ──────────────────────────────────────────────────────────
  const [showRowImages, setShowRowImages] = useState(false)
  const [imageSize, setImageSize]         = useState<24 | 32 | 48 | 64 | 96>(48)

  // ── Column group UI ────────────────────────────────────────────────────
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]')) } catch { return new Set() }
  })
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') } catch { return [] }
  })
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  // ── Row collapse ───────────────────────────────────────────────────────
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Set<string>>(new Set())

  // ── Drag-drop rows ─────────────────────────────────────────────────────
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [dropTarget,    setDropTarget]    = useState<{ rowId: string; half: 'top' | 'bottom' } | null>(null)
  const canDragRef   = useRef(false)
  const rowDragRef   = useRef<number | null>(null)

  // ── Refs for stale-closure-free callbacks ──────────────────────────────
  const displayRowsRef       = useRef<BaseRow[]>([])
  const allColumnsRef        = useRef<FlatFileColumn[]>([])
  const selAnchorRef         = useRef<{ ri: number; ci: number } | null>(null)
  const selEndRef            = useRef<{ ri: number; ci: number } | null>(null)
  const isEditingRef         = useRef(false)
  const onBeforeEditCellRef  = useRef(onBeforeEditCell)

  useEffect(() => { selAnchorRef.current = selAnchor }, [selAnchor])
  useEffect(() => { selEndRef.current    = selEnd }, [selEnd])
  useEffect(() => { isEditingRef.current = isEditing }, [isEditing])
  useEffect(() => { onBeforeEditCellRef.current = onBeforeEditCell }, [onBeforeEditCell])

  // ── Derived state ──────────────────────────────────────────────────────

  const orderedGroups = useMemo<FlatFileColumnGroup[]>(() => {
    if (!groupOrder.length) return columnGroups
    const map = new Map(columnGroups.map((g) => [g.id, g]))
    const ordered = groupOrder.map((id) => map.get(id)).filter(Boolean) as FlatFileColumnGroup[]
    const rest = columnGroups.filter((g) => !groupOrder.includes(g.id))
    return [...ordered, ...rest]
  }, [groupOrder, columnGroups])

  const openGroups = useMemo(
    () => new Set(columnGroups.map((g) => g.id).filter((id) => !closedGroups.has(id))),
    [closedGroups, columnGroups],
  )

  const visibleGroups = useMemo(
    () => orderedGroups.filter((g) => openGroups.has(g.id)),
    [orderedGroups, openGroups],
  )

  const allColumns = useMemo<FlatFileColumn[]>(
    () => visibleGroups.flatMap((g) => g.columns),
    [visibleGroups],
  )
  useEffect(() => { allColumnsRef.current = allColumns }, [allColumns])

  const colToGroup = useMemo<Map<string, FlatFileColumnGroup>>(() => {
    const m = new Map<string, FlatFileColumnGroup>()
    for (const g of orderedGroups) for (const c of g.columns) m.set(c.id, g)
    return m
  }, [orderedGroups])

  const defaultGetGroupKey = useCallback((row: BaseRow) => String(row.platformProductId ?? row._rowId), [])
  const resolvedGetGroupKey = getGroupKey ?? defaultGetGroupKey

  const rowGroups = useMemo(() => {
    const groups = new Map<string, BaseRow[]>()
    for (const row of rows) {
      const key = resolvedGetGroupKey(row)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    return groups
  }, [rows, resolvedGetGroupKey])

  const filteredRows = useMemo(() => {
    if (!searchQuery) return rows
    const q = searchQuery.toLowerCase()
    return rows.filter((r) =>
      String(r.sku ?? r.item_sku ?? '').toLowerCase().includes(q) ||
      String(r.title ?? '').toLowerCase().includes(q) ||
      String(r.ebay_item_id ?? r.asin ?? '').includes(q),
    )
  }, [rows, searchQuery])

  const displayRows = useMemo(() => {
    const result: BaseRow[] = []
    rowGroups.forEach((groupRows, groupKey) => {
      if (collapsedRowGroups.has(groupKey)) return
      result.push(...groupRows.filter((r) => filteredRows.some((fr) => fr._rowId === r._rowId)))
    })
    displayRowsRef.current = result
    return result
  }, [rowGroups, filteredRows, collapsedRowGroups])

  const normSel = useMemo<NormSel | null>(() => {
    if (!selAnchor || !selEnd) return null
    return {
      rMin: Math.min(selAnchor.ri, selEnd.ri), rMax: Math.max(selAnchor.ri, selEnd.ri),
      cMin: Math.min(selAnchor.ci, selEnd.ci), cMax: Math.max(selAnchor.ci, selEnd.ci),
    }
  }, [selAnchor, selEnd])

  const fillTarget = useMemo<NormSel | null>(() => {
    if (!isFillDragging || !fillDragEnd || !normSel) return null
    const { rMin, rMax, cMin, cMax } = normSel
    const { ri, ci } = fillDragEnd
    const dRow = ri > rMax ? ri - rMax : ri < rMin ? ri - rMin : 0
    const dCol = ci > cMax ? ci - cMax : ci < cMin ? ci - cMin : 0
    if (Math.abs(dRow) >= Math.abs(dCol)) {
      if (ri > rMax) return { rMin: rMax + 1, rMax: ri, cMin, cMax }
      if (ri < rMin) return { rMin: ri, rMax: rMin - 1, cMin, cMax }
    } else {
      if (ci > cMax) return { rMin, rMax, cMin: cMax + 1, cMax: ci }
      if (ci < cMin) return { rMin, rMax, cMin: ci, cMax: cMin - 1 }
    }
    return null
  }, [isFillDragging, fillDragEnd, normSel])

  const validationIssues = useMemo(
    () => validate ? validate(rows) : [],
    [rows, validate],
  )

  const dirtyCount  = rows.filter((r) => r._dirty).length
  const errorCount  = validationIssues.filter((i) => i.level === 'error').length
  const warnCount   = validationIssues.filter((i) => i.level === 'warn').length

  const toneMap = useMemo(() => {
    const out = new Map<string, string>()
    if (cfRules.length === 0) return out
    const active = cfRules.filter((r) => r.enabled)
    displayRows.forEach((row, ri) => {
      for (const rule of active) {
        if (evaluateRule(rule, row[rule.columnId])) { out.set(`${ri}:${rule.columnId}`, rule.tone); }
      }
    })
    return out
  }, [cfRules, displayRows])

  const findCells = useMemo<FindCell[]>(() => {
    const out: FindCell[] = []
    displayRows.forEach((row, ri) => {
      allColumnsRef.current.forEach((col, ci) => {
        out.push({ rowIdx: ri, colIdx: ci, rowId: row._rowId, columnId: col.id, value: row[col.id] })
      })
    })
    return out
  }, [displayRows])

  const stickyLeftByColIdx = useMemo<Record<number, number>>(() => {
    const out: Record<number, number> = {}
    let left = 36 + 40 // checkbox(36) + row#(40)
    for (let i = 0; i < Math.min(frozenColCount, allColumns.length); i++) {
      out[i] = left
      left += colWidths[allColumns[i].id] ?? allColumns[i].width
    }
    return out
  }, [frozenColCount, allColumns, colWidths])

  // ── Clipboard + fill ops ───────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    const tsv = displayRowsRef.current.slice(rMin, rMax + 1)
      .map((row) => allColumnsRef.current.slice(cMin, cMax + 1).map((col) => String(row[col.id] ?? '')).join('\t'))
      .join('\n')
    navigator.clipboard.writeText(tsv).catch(() => {})
  }, [normSel])

  const handleDeleteCells = useCallback(() => {
    if (!normSel) return
    pushSnapshot()
    const { rMin, rMax, cMin, cMax } = normSel
    setRows((prev) => {
      const next = [...prev]
      for (let ri = rMin; ri <= rMax; ri++) {
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const idx = prev.findIndex((r) => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: BaseRow = { ...prev[idx], _dirty: true }
        for (let ci = cMin; ci <= cMax; ci++) {
          const col = allColumnsRef.current[ci]
          if (col && !col.readOnly && col.kind !== 'readonly') updated[col.id] = ''
        }
        next[idx] = updated
      }
      return next
    })
  }, [normSel, pushSnapshot])

  const handleCut = useCallback(() => { handleCopy(); handleDeleteCells() }, [handleCopy, handleDeleteCells])

  const handlePaste = useCallback(async () => {
    if (!selAnchor) return
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text) return
    const pasteLines = text.split('\n').filter((l) => l.trim())
    if (!pasteLines.length) return
    const firstRow = pasteLines[0].split('\t')
    const colLookup = new Map<string, number>()
    allColumnsRef.current.forEach((c, i) => {
      colLookup.set(c.id.toLowerCase(), i)
      colLookup.set(c.label.toLowerCase(), i)
    })
    const headerMap = new Map<number, number>()
    let matchCount = 0
    firstRow.forEach((cell, pi) => {
      const ci = colLookup.get(cell.trim().toLowerCase())
      if (ci !== undefined) { headerMap.set(pi, ci); matchCount++ }
    })
    const hasHeaders = smartPasteEnabled && matchCount >= 2
    const dataRows = hasHeaders ? pasteLines.slice(1) : pasteLines
    const { ri: startRi, ci: startCi } = selAnchor
    pushSnapshot()
    setRows((prev) => {
      const next = [...prev]
      dataRows.forEach((line, riOffset) => {
        const pasteRow = line.split('\t')
        const dr = displayRowsRef.current[startRi + riOffset]; if (!dr) return
        const idx = prev.findIndex((r) => r._rowId === dr._rowId); if (idx === -1) return
        const updated: BaseRow = { ...prev[idx], _dirty: true }
        if (hasHeaders) {
          pasteRow.forEach((val, pi) => { const ci = headerMap.get(pi); if (ci !== undefined) { const col = allColumnsRef.current[ci]; if (col && !col.readOnly) updated[col.id] = val } })
        } else {
          pasteRow.forEach((val, ciOffset) => { const col = allColumnsRef.current[startCi + ciOffset]; if (col && !col.readOnly) updated[col.id] = val })
        }
        next[idx] = updated
      })
      return next
    })
    const lastR = dataRows.length - 1
    const lastC = hasHeaders ? Math.max(0, ...headerMap.values()) : startCi + Math.max(...dataRows.map((r) => r.split('\t').length)) - 1
    setSelEnd({ ri: startRi + lastR, ci: Math.min(lastC, allColumnsRef.current.length - 1) })
  }, [selAnchor, pushSnapshot, smartPasteEnabled])

  const handleFillDown = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    if (rMin === rMax) return
    pushSnapshot()
    const srcRow = displayRowsRef.current[rMin]; if (!srcRow) return
    setRows((prev) => {
      const next = [...prev]
      for (let ri = rMin + 1; ri <= rMax; ri++) {
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const idx = prev.findIndex((r) => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: BaseRow = { ...prev[idx], _dirty: true }
        for (let ci = cMin; ci <= cMax; ci++) {
          const col = allColumnsRef.current[ci]; if (col && !col.readOnly) updated[col.id] = srcRow[col.id]
        }
        next[idx] = updated
      }
      return next
    })
  }, [normSel, pushSnapshot])

  const handleSelectAll = useCallback(() => {
    const rMax = displayRowsRef.current.length - 1
    const cMax = allColumnsRef.current.length - 1
    if (rMax < 0 || cMax < 0) return
    setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: rMax, ci: cMax }); setActiveCell(null)
  }, [])

  const executeFill = useCallback(() => {
    if (!normSel || !fillTarget) return
    pushSnapshot()
    const { rMin, rMax, cMin, cMax } = normSel
    const selH = rMax - rMin + 1; const selW = cMax - cMin + 1
    setRows((prev) => {
      const next = [...prev]
      for (let ri = fillTarget.rMin; ri <= fillTarget.rMax; ri++) {
        const srcRi = rMin + ((ri - fillTarget.rMin) % selH)
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const srcDr = displayRowsRef.current[srcRi]; if (!srcDr) continue
        const idx = prev.findIndex((r) => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: BaseRow = { ...prev[idx], _dirty: true }
        for (let ci = fillTarget.cMin; ci <= fillTarget.cMax; ci++) {
          const srcCi = cMin + ((ci - fillTarget.cMin) % selW)
          const col = allColumnsRef.current[ci]; const srcCol = allColumnsRef.current[srcCi]
          if (col && srcCol && !col.readOnly) updated[col.id] = srcDr[srcCol.id]
        }
        next[idx] = updated
      }
      return next
    })
    setSelEnd({ ri: Math.max(normSel.rMax, fillTarget.rMax), ci: Math.max(normSel.cMax, fillTarget.cMax) })
    setIsFillDragging(false); setFillDragEnd(null)
  }, [normSel, fillTarget, pushSnapshot])

  // ── Pointer handlers ───────────────────────────────────────────────────

  const handleCellPointerDown = useCallback((ri: number, ci: number, shiftKey: boolean) => {
    if (shiftKey && selAnchorRef.current) {
      setSelEnd({ ri, ci }); setIsEditing(false); setActiveCell(null)
    } else {
      // Update ref immediately so onPointerMove sees it before React re-renders
      selAnchorRef.current = { ri, ci }
      setSelAnchor({ ri, ci }); setSelEnd({ ri, ci }); setIsEditing(false); setEditInitialChar(null)
      const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
      if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
    }
  }, [])

  const handleCellDoubleClick = useCallback((ri: number, ci: number) => {
    const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
    if (row && col && onBeforeEditCellRef.current?.(col, row)) return
    setSelAnchor({ ri, ci }); setSelEnd({ ri, ci }); setIsEditing(true); setEditInitialChar(null)
    if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
  }, [])

  const moveSelection = useCallback((dCol: number, dRow: number, extend = false) => {
    const maxRi = displayRowsRef.current.length - 1
    const maxCi = allColumnsRef.current.length - 1
    const anchor = selAnchorRef.current; if (!anchor) return
    setIsEditing(false); setEditInitialChar(null)
    if (extend) {
      const e = selEndRef.current ?? anchor
      setSelEnd({ ri: Math.max(0, Math.min(maxRi, e.ri + dRow)), ci: Math.max(0, Math.min(maxCi, e.ci + dCol)) })
    } else {
      const newRi = Math.max(0, Math.min(maxRi, anchor.ri + dRow))
      const newCi = Math.max(0, Math.min(maxCi, anchor.ci + dCol))
      setSelAnchor({ ri: newRi, ci: newCi }); setSelEnd({ ri: newRi, ci: newCi })
      const row = displayRowsRef.current[newRi]; const col = allColumnsRef.current[newCi]
      if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
      requestAnimationFrame(() => document.querySelector(`[data-ri="${newRi}"][data-ci="${newCi}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }, [])

  const handleFillHandlePointerDown = useCallback((ri: number, ci: number) => {
    setIsFillDragging(true); setFillDragEnd({ ri, ci })
  }, [])

  const handleFillDrop = useCallback(() => { if (isFillDragging) executeFill() }, [isFillDragging, executeFill])

  // ── Keyboard handler ───────────────────────────────────────────────────

  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && e.key === 'z' &&  e.shiftKey) { e.preventDefault(); redo(); return }
      if (mod && e.key === 'y')                { e.preventDefault(); redo(); return }
      if (mod && e.key === 'f') { e.preventDefault(); setShowFindReplace(true); return }

      if (isEditingRef.current) {
        if (e.key === 'Escape') { e.preventDefault(); setIsEditing(false); setEditInitialChar(null) }
        return
      }

      if (mod && e.key === 'a') { e.preventDefault(); handleSelectAll(); return }
      if (!selAnchorRef.current) return

      if (mod && e.key === 'c') { e.preventDefault(); handleCopy(); setClipboardRange(normSel); return }
      if (mod && e.key === 'x') { e.preventDefault(); handleCut(); setClipboardRange(normSel); return }
      if (mod && e.key === 'v') { e.preventDefault(); void handlePaste(); setClipboardRange(null); return }
      if (mod && e.key === 'd') { e.preventDefault(); handleFillDown(); return }

      if (mod && e.key === 'Home') {
        e.preventDefault()
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 })
        const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]
        if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
        requestAnimationFrame(() => document.querySelector('[data-ri="0"][data-ci="0"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }
      if (mod && e.key === 'End') {
        e.preventDefault()
        const ri = displayRowsRef.current.length - 1; const ci = allColumnsRef.current.length - 1
        setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
        const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
        if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
        requestAnimationFrame(() => document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }

      if (mod && e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  displayRowsRef.current.length - 1 - (selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -(selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowRight') { e.preventDefault(); moveSelection(allColumnsRef.current.length - 1 - (selAnchorRef.current?.ci ?? 0), 0); return }
      if (mod && e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-(selAnchorRef.current?.ci ?? 0), 0); return }

      if (!e.shiftKey && !mod) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  1); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1,  0); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0); return }
        if (e.key === 'Enter')      { e.preventDefault(); moveSelection(0,  1); return }
        if (e.key === 'Tab')        { e.preventDefault(); moveSelection(1,  0); return }
      }
      if (e.shiftKey && !mod) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  1, true); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1, true); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1,  0, true); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0, true); return }
        if (e.key === 'Tab')        { e.preventDefault(); moveSelection(-1, 0, true); return }
        if (e.key === 'Enter')      { e.preventDefault(); moveSelection(0, -1, true); return }
      }

      if (e.key === 'F2') {
        e.preventDefault()
        const anchor = selAnchorRef.current
        if (anchor) {
          const row = displayRowsRef.current[anchor.ri]; const col = allColumnsRef.current[anchor.ci]
          if (row && col && onBeforeEditCellRef.current?.(col, row)) return
        }
        setIsEditing(true); setEditInitialChar(null); return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); handleDeleteCells(); return }

      if (e.key === 'Escape') { setSelAnchor(null); setSelEnd(null); setClipboardRange(null); return }

      if (e.key.length === 1 && !mod) {
        const anchor = selAnchorRef.current
        if (anchor) {
          const row = displayRowsRef.current[anchor.ri]; const col = allColumnsRef.current[anchor.ci]
          if (row && col && onBeforeEditCellRef.current?.(col, row)) return
        }
        setIsEditing(true); setEditInitialChar(e.key)
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [undo, redo, normSel, handleCopy, handleCut, handlePaste, handleFillDown, handleDeleteCells, handleSelectAll, moveSelection])

  // ── Row ops ────────────────────────────────────────────────────────────

  function reorderRow(fromId: string, toId: string, half: 'top' | 'bottom') {
    if (fromId === toId) return
    pushSnapshot()
    setRows((prev) => {
      const displayed = displayRowsRef.current.map((r) => r._rowId)
      const rowMap = new Map(prev.map((r) => [r._rowId, r]))
      const next = [...displayed]
      const fi = next.indexOf(fromId); const ti = next.indexOf(toId)
      if (fi === -1 || ti === -1) return prev
      next.splice(fi, 1)
      const adj = fi < ti ? ti - 1 : ti
      next.splice(half === 'top' ? adj : adj + 1, 0, fromId)
      const notDisplayed = prev.filter((r) => !displayed.includes(r._rowId))
      return [...next.map((id) => rowMap.get(id)!).filter(Boolean), ...notDisplayed]
    })
    setDraggingRowId(null); setDropTarget(null)
  }

  function addRow() {
    const newRow = makeBlankRow()
    pushSnapshot(); setRows((prev) => [...prev, newRow])
  }

  function deleteSelected() {
    if (!selectedRows.size) return
    pushSnapshot(); setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId))); setSelectedRows(new Set())
  }

  // ── Cell update ────────────────────────────────────────────────────────

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    pushSnapshot()
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
    onCellChange?.(rowId, colId, value)
  }, [pushSnapshot, onCellChange])

  const liveUpdateCell = useCallback((rowId: string, colId: string, value: string) => {
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
  }, [])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumnsRef.current.map((c) => c.id)
    const rowIds = displayRowsRef.current.map((r) => r._rowId)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    if (dir === 'right') ci = Math.min(ci + 1, colIds.length - 1)
    else if (dir === 'left') ci = Math.max(ci - 1, 0)
    else if (dir === 'down') ri = Math.min(ri + 1, rowIds.length - 1)
    else ri = Math.max(ri - 1, 0)
    const nc = colIds[ci], nr = rowIds[ri]
    if (nc && nr) {
      setActiveCell({ rowId: nr, colId: nc }); setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
      setIsEditing(false); setEditInitialChar(null)
      requestAnimationFrame(() => document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }, [])

  const onDeactivate = useCallback(() => { setIsEditing(false); setEditInitialChar(null) }, [])

  // ── Save / reload ──────────────────────────────────────────────────────

  async function saveDraft() {
    const dirty = rows.filter((r) => r._dirty)
    if (!dirty.length) { toast({ title: 'Nothing to save', tone: 'info' }); return }
    setSaving(true)
    try {
      const { saved } = await onSave(dirty)
      setRows((prev) => prev.map((r) => ({ ...r, _dirty: false })))
      setSaveFlash(true); setTimeout(() => setSaveFlash(false), 2000)
      toast.success(`Saved ${saved} rows`)
    } catch (err) {
      toast.error('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally { setSaving(false) }
  }

  async function loadData() {
    setLoading(true)
    try {
      const loaded = await onReload()
      const padded = padToMin(loaded, makeBlankRow, minRows)
      setRows(padded); setHistory([]); setFuture([])
    } catch (err) {
      toast.error('Failed to reload: ' + (err instanceof Error ? err.message : String(err)))
    } finally { setLoading(false) }
  }

  // Load on mount
  useEffect(() => { void loadData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slot contexts ──────────────────────────────────────────────────────

  const modalsCtx = useMemo<ModalsCtx>(
    () => ({ rows, setRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  )
  const toolbarFetchCtx = useMemo<ToolbarFetchCtx>(
    () => ({ rows, selectedRows, loading, setRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedRows, loading],
  )
  const toolbarImportCtx = useMemo<ToolbarImportCtx>(
    () => ({ loading, setRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading],
  )
  const replicateCtx = useMemo<ReplicateCtx>(
    () => ({ rows, selectedRows, visibleGroups, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) }, setRows }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedRows, visibleGroups],
  )

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* ── Sticky header ────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {renderChannelStrip?.()}

        {/* Bar 1: menus + title + actions */}
        <div className="px-3 h-10 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">
          <button type="button" onClick={() => router.push('/products')}
            className="p-1 -ml-0.5 flex-shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" aria-label="Back">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <MenuDropdown label="File" items={[
            { label: 'Reload from server', icon: <Undo2 className="w-3.5 h-3.5" />, disabled: loading,
              onClick: () => { if (confirm('Reload rows? Unsaved edits will be lost.')) void loadData() } },
          ]} />
          <MenuDropdown label="Edit" items={[
            { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: !history.length, shortcut: '⌘Z' },
            { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: !future.length, shortcut: '⌘⇧Z' },
            { separator: true },
            { label: 'Reset column group order', onClick: () => { setGroupOrder([]); try { localStorage.removeItem(`${storageKey}-group-order`) } catch {} }, disabled: !groupOrder.length },
            { label: 'Show all column groups', onClick: () => { setClosedGroups(new Set()); try { localStorage.removeItem(`${storageKey}-closed-groups`) } catch {} }, disabled: !closedGroups.size },
          ]} />
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />
          {titleIcon}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">{title}</span>
          <Badge variant="default">{rows.length} rows</Badge>
          {dirtyCount > 0 && <Badge variant="warning" className="flex-shrink-0"><AlertCircle className="w-3 h-3 mr-1" />{dirtyCount} unsaved</Badge>}
          <div className="flex-1 min-w-0" />
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />
          <Button size="sm" variant="ghost" onClick={() => { if (!dirtyCount) return; if (confirm('Discard all unsaved changes?')) void loadData() }} disabled={!dirtyCount || loading} className="text-slate-500 hover:text-red-600 dark:hover:text-red-400">Discard</Button>
          <Button size="sm" variant="ghost" onClick={saveDraft} disabled={loading || saving} className={saveFlash ? 'text-emerald-600 dark:text-emerald-400' : ''}>
            {saving ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Saving…</> : saveFlash ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Saved</> : 'Save'}
          </Button>
          {renderPushExtras?.({ rows, selectedRows, dirtyCount, loading, saving })}
        </div>

        {/* Bar 2: icon toolbar */}
        <div className="px-3 h-8 flex items-center gap-0.5 border-b border-slate-100 dark:border-slate-800/60">
          <TbBtn icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo (⌘Z)" onClick={undo} disabled={!history.length} />
          <TbBtn icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo (⌘⇧Z)" onClick={redo} disabled={!future.length} />
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
          <TbBtn icon={<Copy className="w-3.5 h-3.5" />} title="Copy rows to another market" onClick={() => setReplicateOpen(true)} disabled={!rows.length} />
          {onReplicate && <TbBtn icon={<ArrowRightLeft className="w-3.5 h-3.5" />} title="Replicate to multiple markets" onClick={() => setReplicateOpen(true)} disabled={!rows.length} active={replicateOpen} />}
          {renderToolbarFetch?.(toolbarFetchCtx)}
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
          <TbBtn icon={<AlertTriangle className="w-3.5 h-3.5" />}
            title={errorCount + warnCount > 0 ? `Validation: ${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}` : 'Validation — no issues'}
            onClick={() => setShowValidation((o) => !o)} active={showValidation} badge={(errorCount + warnCount) || undefined} />
          <TbBtn icon={<ClipboardPaste className="w-3.5 h-3.5" />}
            title={smartPasteEnabled ? 'Smart paste ON — click to turn off' : 'Smart paste OFF — click to turn on'}
            onClick={() => setSmartPasteEnabled((o) => !o)} active={smartPasteEnabled} />
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
          {renderToolbarImport?.(toolbarImportCtx)}
          <TbBtn icon={<ImageIcon className="w-3.5 h-3.5" />}
            title={showRowImages ? 'Hide product images' : 'Show product images in rows'}
            onClick={() => setShowRowImages((o) => !o)} disabled={!rows.length} active={showRowImages} />
          {showRowImages && (
            <>
              {([24, 32, 48, 64, 96] as const).map((size) => (
                <button key={size} type="button" onClick={() => setImageSize(size)}
                  className={cn('h-6 px-1.5 rounded text-[10px] font-medium transition-colors',
                    imageSize === size ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                  {size === 24 ? 'XS' : size === 32 ? 'S' : size === 48 ? 'M' : size === 64 ? 'L' : 'XL'}
                </button>
              ))}
            </>
          )}
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
          <TbBtn icon={<SlidersHorizontal className="w-3.5 h-3.5" />} title="Sort rows" onClick={() => {}} />
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
          <TbBtn icon={<Replace className="w-3.5 h-3.5" />} title="Find & Replace (⌘F)" onClick={() => setShowFindReplace((o) => !o)} active={showFindReplace} />
          <TbBtn icon={<Sparkles className="w-3.5 h-3.5" />}
            title={cfRules.length > 0 ? `Conditional formatting (${cfRules.filter((r) => r.enabled).length} active)` : 'Conditional formatting'}
            onClick={() => setShowConditional((o) => !o)} active={showConditional}
            badge={cfRules.filter((r) => r.enabled).length || undefined} />
          <TbBtn icon={<Sparkles className="w-3.5 h-3.5 text-amber-500" />}
            title={selectedRows.size > 0 ? `AI bulk actions (${selectedRows.size} selected)` : 'AI bulk actions — select rows first'}
            onClick={() => setAiModalOpen(true)} disabled={selectedRows.size === 0} badge={selectedRows.size || undefined} />
        </div>

        {/* Bar 3: search + filter + saved views + column pills */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
          {renderBar3Left?.()}
          <div className="relative flex items-center">
            <Search className="absolute left-2 w-3 h-3 text-slate-400 pointer-events-none" />
            <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearchQuery('')} placeholder="Search rows…"
              className="pl-6 pr-6 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44" />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-1.5 text-slate-400 hover:text-slate-600"><X className="w-3 h-3" /></button>}
          </div>
          {searchQuery && <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">{filteredRows.length}/{rows.length}</span>}
          <FFFilterPanel open={showFilter} onOpenChange={setShowFilter} value={filterState} onChange={setFilterState} />
          <FFSavedViews
            currentState={{ closedGroups: [...closedGroups], ffFilter: filterState, cfRules, frozenColCount, sortConfig: [] } satisfies FFViewState}
            onApply={(state: FFViewState) => { setClosedGroups(new Set(state.closedGroups)); setFilterState(state.ffFilter); setCfRules(state.cfRules) }} />
          <div className="flex items-center gap-1 flex-wrap ml-auto">
            <span className="text-xs text-slate-400 mr-1">Columns:</span>
            {orderedGroups.map((g) => {
              const open = openGroups.has(g.id); const isDragging = draggingGroupId === g.id
              return (
                <button key={g.id} type="button" draggable
                  onDragStart={(e) => { setDraggingGroupId(g.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDraggingGroupId(null)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (!draggingGroupId || draggingGroupId === g.id) return
                    const ids = orderedGroups.map((x) => x.id)
                    const from = ids.indexOf(draggingGroupId); const to = ids.indexOf(g.id)
                    const next = [...ids]; next.splice(from, 1); next.splice(to, 0, draggingGroupId)
                    setGroupOrder(next); try { localStorage.setItem(`${storageKey}-group-order`, JSON.stringify(next)) } catch {}
                    setDraggingGroupId(null)
                  }}
                  onClick={() => setClosedGroups((prev) => {
                    if (open && orderedGroups.filter((x) => !prev.has(x.id)).length <= 1) return prev
                    const n = new Set(prev); open ? n.add(g.id) : n.delete(g.id)
                    try { localStorage.setItem(`${storageKey}-closed-groups`, JSON.stringify([...n])) } catch {}
                    return n
                  })}
                  title={g.label}
                  className={cn('inline-flex items-center gap-1 h-5 px-1.5 text-xs rounded border transition-all cursor-grab active:cursor-grabbing select-none',
                    gColor(g.color).badge, open ? 'opacity-100' : 'opacity-40 hover:opacity-65',
                    isDragging && 'opacity-30 scale-95')}>
                  <ChevronRight className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-90')} />
                  <span className="font-medium">{g.label}</span>
                  <span className="opacity-60 tabular-nums">{g.columns.length}</span>
                </button>
              )
            })}
            {(groupOrder.length > 0 || closedGroups.size > 0) && (
              <button type="button" onClick={() => { setGroupOrder([]); setClosedGroups(new Set()); try { localStorage.removeItem(`${storageKey}-group-order`); localStorage.removeItem(`${storageKey}-closed-groups`) } catch {} }}
                className="text-xs text-slate-400 hover:text-slate-600 px-1" title="Reset group order and visibility">↺</button>
            )}
          </div>
        </div>
      </header>

      {renderFeedBanner?.()}

      {/* Replicate modal */}
      {onReplicate && (
        <FFReplicateModal open={replicateOpen} onClose={() => setReplicateOpen(false)}
          sourceMarket={marketplace}
          groups={visibleGroups.map((g) => ({ id: g.id, labelEn: g.label, color: g.color }))}
          rowCount={rows.length} selectedRowCount={selectedRows.size}
          onReplicate={async (targets, groupIds, selectedOnly) => onReplicate(targets, groupIds, selectedOnly, replicateCtx)} />
      )}

      {/* AI modal */}
      <AIBulkModal open={aiModalOpen} onClose={() => setAiModalOpen(false)}
        selectedProductIds={[...selectedRows].flatMap((rowId) => { const row = rows.find((r) => r._rowId === rowId); return row?._productId ? [row._productId as string] : [] })}
        marketplace={marketplace} />

      {/* Find / Replace */}
      {showFindReplace && (
        <div className="fixed top-16 right-4 z-50">
          <FindReplaceBar open={showFindReplace} onClose={() => { setShowFindReplace(false); setMatchKeys(new Set()) }}
            cells={findCells}
            rangeBounds={normSel ? { minRow: normSel.rMin, maxRow: normSel.rMax, minCol: normSel.cMin, maxCol: normSel.cMax } : null}
            visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
            onActivate={(match) => {
              setSelAnchor({ ri: match.rowIdx, ci: match.colIdx }); setSelEnd({ ri: match.rowIdx, ci: match.colIdx })
              const row = displayRows[match.rowIdx]; if (row) setActiveCell({ rowId: row._rowId, colId: match.columnId })
              requestAnimationFrame(() => document.querySelector(`[data-ri="${match.rowIdx}"][data-ci="${match.colIdx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
            }}
            onMatchSetChange={setMatchKeys}
            onReplaceCell={(rowId, columnId, newValue) => { pushSnapshot(); setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [columnId]: newValue, _dirty: true } : r)) }} />
        </div>
      )}

      {/* Conditional format */}
      {showConditional && (
        <div className="fixed top-16 right-4 z-50">
          <ConditionalFormatBar open={showConditional} onClose={() => setShowConditional(false)}
            rules={cfRules} onChange={setCfRules} visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))} />
        </div>
      )}

      {/* Validation panel */}
      {showValidation && validationIssues.length > 0 && (
        <div className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 max-h-40 overflow-y-auto">
          {validationIssues.map((issue, i) => (
            <div key={i} className={cn('flex items-center gap-2 text-xs py-0.5', issue.level === 'error' ? 'text-red-600' : 'text-amber-600')}>
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="font-mono">{issue.sku}</span>
              <span className="text-slate-400">·</span>
              <span className="font-medium">{issue.field}</span>
              <span className="text-slate-400">·</span>
              <span>{issue.msg}</span>
            </div>
          ))}
        </div>
      )}

      {renderModals?.(modalsCtx)}

      {/* ── Main grid ──────────────────────────────────── */}
      <div className="flex-1 overflow-auto"
        onPointerMove={(e) => {
          if (e.buttons !== 1) return
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

          // Row # column drag — extend selection to whole rows vertically
          if (rowDragRef.current !== null) {
            const rowEl = el?.closest('[data-row-ri]') as HTMLElement | null
            if (rowEl) {
              const ri = parseInt(rowEl.dataset.rowRi ?? '', 10)
              if (!isNaN(ri)) {
                const maxCi = allColumnsRef.current.length - 1
                setSelEnd((p) => (p?.ri === ri && p?.ci === maxCi ? p : { ri, ci: maxCi }))
              }
            }
            return
          }

          // Regular cell selection / fill drag
          const td = el?.closest('[data-ri]') as HTMLElement | null; if (!td) return
          const ri = parseInt(td.dataset.ri ?? '', 10)
          const ci = parseInt(td.dataset.ci ?? '', 10)
          if (isNaN(ri) || isNaN(ci)) return
          if (isFillDragging) {
            setFillDragEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
          } else if (selAnchorRef.current) {
            setSelEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
            setActiveCell(null)
          }
        }}
        onPointerUp={() => { rowDragRef.current = null; if (isFillDragging) executeFill() }}>

        {loading && <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>}

        {!loading && (
          <table className="border-collapse text-sm w-max min-w-full">
            <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
              {/* Row 1: group color bands */}
              <tr>
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-9 min-w-[36px] text-center" rowSpan={2}>
                  <input type="checkbox" className="w-3.5 h-3.5 accent-blue-600"
                    checked={displayRows.length > 0 && selectedRows.size === displayRows.length}
                    ref={(el) => { if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < displayRows.length }}
                    onChange={(e) => setSelectedRows(e.target.checked ? new Set(displayRows.map((r) => r._rowId)) : new Set())} />
                </th>
                <th className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 text-xs text-slate-400 text-center font-normal w-10 min-w-[40px]" rowSpan={2}>#</th>
                {visibleGroups.map((g) => (
                  <th key={g.id} colSpan={g.columns.length}
                    className={cn('px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap', gColor(g.color).header)}>
                    <button onClick={() => setClosedGroups((prev) => { const n = new Set(prev); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n })} className="flex items-center gap-1">
                      <ChevronDown className={cn('h-3 w-3 transition-transform', closedGroups.has(g.id) && '-rotate-90')} />
                      {g.label}
                    </button>
                  </th>
                ))}
              </tr>
              {/* Row 2: column labels + resize handles + freeze pins */}
              <tr>
                {allColumns.map((col, colIdx) => {
                  const w = colWidths[col.id] ?? col.width
                  const isSticky = colIdx < frozenColCount
                  return (
                    <th key={col.id}
                      style={{ minWidth: w, width: w, cursor: 'pointer', ...(isSticky ? { position: 'sticky' as const, left: stickyLeftByColIdx[colIdx] ?? 0, zIndex: 25 } : {}) }}
                      className={cn('relative group/th px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap select-none hover:bg-blue-50/50 dark:hover:bg-blue-950/10',
                        gColor(colToGroup.get(col.id)?.color ?? 'slate').text,
                        col.required && 'font-bold',
                        isSticky && 'bg-white dark:bg-slate-900')}
                      title={col.description}
                      onClick={() => {
                        const maxRi = displayRows.length - 1
                        setSelAnchor({ ri: 0, ci: colIdx }); setSelEnd({ ri: maxRi, ci: colIdx }); setIsEditing(false)
                        const firstRow = displayRows[0]; if (firstRow) setActiveCell({ rowId: firstRow._rowId, colId: col.id })
                      }}>
                      {col.label}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                      {col.maxLength != null && <span className="ml-1 font-normal font-mono text-[10px] text-slate-300 dark:text-slate-600">max {col.maxLength}</span>}
                      {/* Freeze pin */}
                      <button type="button"
                        className={cn('ml-1 p-0.5 rounded-sm opacity-0 group-hover/th:opacity-100 transition-opacity flex-shrink-0',
                          isSticky ? 'text-blue-500 opacity-100' : 'text-slate-400 hover:text-blue-500')}
                        title={isSticky ? 'Unfreeze' : 'Freeze up to here'}
                        onClick={(e) => { e.stopPropagation(); setFrozenColCount(colIdx < frozenColCount ? colIdx : colIdx + 1) }}>
                        <Pin className="w-3 h-3" />
                      </button>
                      {/* Resize handle */}
                      <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/cr flex items-center justify-center z-10"
                        onMouseDown={(e) => { e.stopPropagation(); startColResize(e, col.id, w) }}
                        onDoubleClick={(e) => { e.stopPropagation(); setColWidths((p) => { const n = { ...p }; delete n[col.id]; return n }) }}>
                        <div className="w-px h-3/4 rounded-full bg-slate-300/50 group-hover/cr:bg-blue-400 dark:bg-slate-600/50 dark:group-hover/cr:bg-blue-500 transition-colors" />
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {(() => {
                const rendered: React.ReactNode[] = []
                const GROUP_BAND_COLORS = ['bg-blue-50/30 dark:bg-blue-950/10', 'bg-violet-50/30 dark:bg-violet-950/10', 'bg-emerald-50/30 dark:bg-emerald-950/10', 'bg-amber-50/30 dark:bg-amber-950/10', 'bg-rose-50/30 dark:bg-rose-950/10', 'bg-cyan-50/30 dark:bg-cyan-950/10']
                let bandIdx = 0; let displayIdx = 0

                rowGroups.forEach((groupRows, groupKey) => {
                  const bandClass = GROUP_BAND_COLORS[bandIdx++ % GROUP_BAND_COLORS.length]
                  const isCollapsed = collapsedRowGroups.has(groupKey)

                  if (groupRows.length > 1) {
                    rendered.push(
                      <GroupHeader key={`hdr-${groupKey}`} row={groupRows[0]} bandClass={bandClass}
                        isExpanded={!isCollapsed} showImage={showRowImages} imageSize={imageSize}
                        colSpan={allColumns.length + 2}
                        onToggle={() => setCollapsedRowGroups((prev) => { const n = new Set(prev); n.has(groupKey) ? n.delete(groupKey) : n.add(groupKey); return n })} />
                    )
                  }

                  if (isCollapsed) return

                  groupRows.filter((r) => filteredRows.some((fr) => fr._rowId === r._rowId)).forEach((row) => {
                    const ri         = displayIdx++
                    const isRowSel   = selectedRows.has(row._rowId)
                    const isDragging = draggingRowId === row._rowId
                    const dropInd    = dropTarget?.rowId === row._rowId ? dropTarget.half : null

                    const rowBg = isRowSel ? 'bg-blue-50/40 dark:bg-blue-900/10'
                      : row._status === 'pushed'  ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
                      : row._status === 'error'   ? 'bg-red-50/70 dark:bg-red-950/20'
                      : row._status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
                      : row._isNew  ? 'bg-sky-50/40 dark:bg-sky-950/10'
                      : row._dirty  ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
                      : groupRows.length > 1 ? bandClass : ''

                    const frozenBg = row._status === 'pushed'  ? 'bg-emerald-50 dark:bg-emerald-950/60'
                      : row._status === 'error'   ? 'bg-red-50 dark:bg-red-950/60'
                      : row._status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60'
                      : row._isNew  ? 'bg-sky-50 dark:bg-sky-950/40'
                      : row._dirty  ? 'bg-yellow-50 dark:bg-yellow-950/40'
                      : 'bg-white dark:bg-slate-900'

                    rendered.push(
                      <tr key={row._rowId} draggable
                        onDragStart={(e) => { if (!canDragRef.current) { e.preventDefault(); return } e.dataTransfer.effectAllowed = 'move'; setDraggingRowId(row._rowId) }}
                        onDragEnd={() => { canDragRef.current = false; setDraggingRowId(null); setDropTarget(null) }}
                        onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setDropTarget((p) => { const half: 'top' | 'bottom' = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'; return p?.rowId === row._rowId && p?.half === half ? p : { rowId: row._rowId, half } }) }}
                        onDrop={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); if (draggingRowId) reorderRow(draggingRowId, row._rowId, e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom') }}
                        style={{ borderTop: dropInd === 'top' ? '2px solid #3b82f6' : undefined, borderBottom: dropInd === 'bottom' ? '2px solid #3b82f6' : undefined }}
                        className={cn('group/row transition-colors', rowBg, isDragging ? 'opacity-40' : 'hover:bg-white/60 dark:hover:bg-slate-800/40')}>

                        {/* Checkbox + drag handle */}
                        <td className={cn('sticky left-0 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center cursor-grab active:cursor-grabbing', frozenBg)}
                          onMouseDown={() => { canDragRef.current = true }} onMouseUp={() => { canDragRef.current = false }}>
                          {row._status === 'pushed'  ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
                          : row._status === 'error'   ? <span title={String(row._feedMessage ?? '')}><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></span>
                          : row._status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
                          : <input type="checkbox" className="w-3.5 h-3.5 accent-blue-600" checked={isRowSel}
                              onChange={(e) => setSelectedRows((prev) => { const n = new Set(prev); e.target.checked ? n.add(row._rowId) : n.delete(row._rowId); return n })} />}
                        </td>

                        {/* Row # + optional image + row meta slot */}
                        <td data-row-ri={ri}
                          className={cn('sticky left-9 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-0.5 relative group/rr select-none', frozenBg)}
                          style={{ width: showRowImages ? imageSize + 12 : 40, minWidth: showRowImages ? imageSize + 12 : 40, height: rowHeight, cursor: 'ns-resize' }}
                          onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.releasePointerCapture(e.pointerId); rowDragRef.current = ri; const maxCi = allColumns.length - 1; selAnchorRef.current = { ri, ci: 0 }; setSelAnchor({ ri, ci: 0 }); setSelEnd({ ri, ci: maxCi }); setIsEditing(false); const col = allColumns[0]; if (col) setActiveCell({ rowId: row._rowId, colId: col.id }) }}>
                          <div className={cn('flex flex-col gap-0.5 w-full', showRowImages ? 'items-center' : 'items-end')} style={{ minHeight: rowHeight, justifyContent: 'center', padding: '4px 2px' }}>
                            {showRowImages && (() => {
                              const imgUrl = row.image_1 ? String(row.image_1) : null
                              return imgUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={imgUrl} alt="" className="object-contain rounded flex-shrink-0" style={{ width: imageSize, height: imageSize }} draggable={false} />
                              ) : (
                                <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0" style={{ width: imageSize, height: imageSize }}>
                                  <ImageIcon className="text-slate-300 dark:text-slate-600" style={{ width: imageSize * 0.4, height: imageSize * 0.4 }} />
                                </div>
                              )
                            })()}
                            <span className={cn('tabular-nums leading-none', showRowImages ? 'text-[9px] text-slate-400' : 'text-xs text-slate-400')}>{ri + 1}</span>
                            {renderRowMeta?.(row, ri)}
                          </div>
                          {/* Row resize handle */}
                          <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize flex items-end justify-center pb-px opacity-0 group-hover/rr:opacity-100 transition-opacity"
                            onMouseDown={(e) => startRowResize(e, rowHeight)}>
                            <div className="w-4 h-px rounded-full bg-blue-400" />
                          </div>
                        </td>

                        {/* Data cells */}
                        {allColumns.map((col, ci) => {
                          const isActive    = activeCell?.rowId === row._rowId && activeCell?.colId === col.id
                          const groupColor  = colToGroup.get(col.id)?.color ?? 'slate'
                          const w           = colWidths[col.id] ?? col.width
                          const stickyLeft  = stickyLeftByColIdx[ci]
                          const isInSel     = normSel ? ri >= normSel.rMin && ri <= normSel.rMax && ci >= normSel.cMin && ci <= normSel.cMax : false
                          const selEdges    = isInSel && normSel ? { top: ri === normSel.rMin, bottom: ri === normSel.rMax, left: ci === normSel.cMin, right: ci === normSel.cMax } : null
                          const isCorner    = !!(normSel && !isFillDragging && ri === normSel.rMax && ci === normSel.cMax)
                          const isFT        = !!(fillTarget && ri >= fillTarget.rMin && ri <= fillTarget.rMax && ci >= fillTarget.cMin && ci <= fillTarget.cMax)
                          const ftEdges     = isFT && fillTarget ? { top: ri === fillTarget.rMin, bottom: ri === fillTarget.rMax, left: ci === fillTarget.cMin, right: ci === fillTarget.cMax } : null
                          const isCB        = !!(clipboardRange && ri >= clipboardRange.rMin && ri <= clipboardRange.rMax && ci >= clipboardRange.cMin && ci <= clipboardRange.cMax)
                          const cbEdges     = isCB && clipboardRange ? { top: ri === clipboardRange.rMin, bottom: ri === clipboardRange.rMax, left: ci === clipboardRange.cMin, right: ci === clipboardRange.cMax } : null
                          const isCellEdit  = isEditing && isActive
                          const isMatch     = matchKeys.has(`${ri}:${ci}`)
                          const toneCls     = toneMap.get(`${ri}:${col.id}`) ? TONE_CLASSES[toneMap.get(`${ri}:${col.id}`)! as keyof typeof TONE_CLASSES] : undefined
                          const cellBg      = stickyLeft !== undefined ? gColor(groupColor).band : gColor(groupColor).cell

                          return (
                            <SpreadsheetCell key={col.id}
                              col={col} row={row} value={row[col.id]}
                              isActive={isActive} cellBg={cellBg} width={w} cellHeight={rowHeight}
                              ri={ri} ci={ci}
                              isSelected={isInSel} selEdges={selEdges}
                              isCorner={isCorner}
                              isFillTarget={isFT} fillTargetEdges={ftEdges}
                              isEditing={isCellEdit} editInitialChar={isCellEdit ? editInitialChar : null}
                              isClipboard={isCB} clipboardEdges={cbEdges}
                              isMatch={isMatch} toneCls={toneCls}
                              stickyLeft={stickyLeft}
                              renderCellContent={renderCellContent}
                              onCellPointerDown={(shiftKey) => handleCellPointerDown(ri, ci, shiftKey)}
                              onCellDoubleClick={() => handleCellDoubleClick(ri, ci)}
                              onFillHandlePointerDown={() => handleFillHandlePointerDown(ri, ci)}
                              onFillDrop={handleFillDrop}
                              onDeactivate={onDeactivate}
                              onChange={(v) => updateCell(row._rowId, col.id, v)}
                              onLiveChange={(val) => liveUpdateCell(row._rowId, col.id, val)}
                              onPushSnapshot={pushSnapshot}
                              onNavigate={(dir) => navigate(row._rowId, col.id, dir)} />
                          )
                        })}
                      </tr>
                    )
                  })
                })
                return rendered
              })()}

              {filteredRows.length === 0 && !loading && (
                <tr><td colSpan={allColumns.length + 2} className="px-6 py-6 text-center text-sm text-slate-400 italic">
                  {searchQuery ? 'No rows match your search.' : 'No rows yet.'}
                </td></tr>
              )}

              <tr>
                <td colSpan={allColumns.length + 2} className="px-4 py-2 border-t border-dashed border-slate-200 dark:border-slate-700">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={addRow}><Plus className="w-3.5 h-3.5 mr-1" />Add row</Button>
                    {selectedRows.size > 0 && (
                      <Button size="sm" variant="ghost" onClick={deleteSelected} className="text-red-500 hover:text-red-700 ml-2">
                        <Trash2 className="w-3.5 h-3.5 mr-1" />Delete {selectedRows.size}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1 flex items-center gap-4 text-xs text-slate-400 select-none flex-shrink-0">
        <span>{filteredRows.length} row{filteredRows.length !== 1 ? 's' : ''}</span>
        {normSel && (() => { const rC = normSel.rMax - normSel.rMin + 1; const cC = normSel.cMax - normSel.cMin + 1; const tot = rC * cC; return <span className="text-blue-500">{tot === 1 ? '1 cell' : `${rC} × ${cC} = ${tot} cells`} selected</span> })()}
        {dirtyCount > 0 && <span className="text-amber-500 ml-auto">{dirtyCount} unsaved change{dirtyCount !== 1 ? 's' : ''}</span>}
        {(errorCount > 0 || warnCount > 0) && (
          <button type="button" onClick={() => setShowValidation((o) => !o)}
            className={cn('flex items-center gap-1 ml-auto', errorCount > 0 ? 'text-red-500' : 'text-amber-500')}>
            <AlertTriangle className="w-3 h-3" />
            {errorCount > 0 && <span>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
            {warnCount  > 0 && <span>{warnCount} warning{warnCount !== 1 ? 's' : ''}</span>}
          </button>
        )}
        <span className="ml-auto">{channel.toUpperCase()} · {marketplace}</span>
      </div>
    </div>
  )
}
