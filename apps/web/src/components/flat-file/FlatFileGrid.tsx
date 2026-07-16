'use client'

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useMemo, memo,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  FileSpreadsheet,
  Image as ImageIcon, Keyboard, Layers, Loader2, Pin, Plus, Settings2,
  Search, Trash2, Undo2, Redo2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Tooltip } from '@/design-system/primitives/Tooltip'
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
  FooterActionsCtx,
} from './FlatFileGrid.types'
import { normalizeCellValue } from './normalizeCellValue'
import { computeDropdownPosition, MIN_DROPDOWN_WIDTH } from './dropdown-position'
import { computeAutoFitWidth } from './column-autofit'
import { applyColumnOrder, moveColumnInGroup, canMoveColumn } from './column-prefs'
import { FlatFileContextMenu } from './FlatFileContextMenu'
import { tokenizeClipboard } from './paste-tokenizer'
import { isComposingKeyEvent } from './composition'
import { setFlatFileDirtyCount, shouldConfirmLeave } from './unsaved-guard'
import { dropReadOnlyCellChanges, typeApplicabilityGuidance, isRequiredForRow, enumOptionsForRow } from './cellFlags'
import { countGhosts, makeGhostRows, materializeGhostPatch, pasteGrowCount, topUpGhosts } from './ghost-rows'
import { SortPanel, applySortLevels, type SortLevel, type SortGroup } from './SortPanel'
import {
  loadGroups, saveGroups, loadGroupMode, saveGroupMode, loadCollapsedGroups, saveCollapsedGroups,
  groupIdForSku, assignSkusToGroup, makeGroupId, GROUP_PALETTE,
  type CustomGroup, type CustomGroupMode, type GroupColorName,
} from './group-model'
import { GroupCreatePopover } from './GroupCreatePopover'
import { ManageGroupsModal } from './ManageGroupsModal'
import {
  FlatFileIconToolbar,
  type RowImageSize as SharedRowImageSize,
} from '@/app/products/_shared/FlatFileIconToolbar'
import { KeyboardShortcutsModal } from '@/app/_shared/grid-lens/KeyboardShortcutsModal'
import { FLAT_FILE_SHORTCUTS } from '@/app/products/_shared/flat-file-shortcuts'
import { useCatalogWorkbookExport } from '@/app/products/_shared/useCatalogWorkbookExport'

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
  // #80 — eBay 'Package & Shipping' group uses cyan; add it so it doesn't fall back to slate.
  cyan:    { band: 'bg-cyan-50 dark:bg-cyan-950/30', header: 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-800 dark:text-cyan-200', text: 'text-cyan-700 dark:text-cyan-300', cell: 'bg-cyan-50/50 dark:bg-cyan-950/10', badge: 'bg-cyan-100 text-cyan-700 border border-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300 dark:border-cyan-800' },
  red:     { band: 'bg-red-50 dark:bg-red-950/30', header: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200', text: 'text-red-700 dark:text-red-300', cell: 'bg-red-50/50 dark:bg-red-950/10', badge: 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800' },
  violet:  { band: 'bg-violet-50 dark:bg-violet-950/30', header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', text: 'text-violet-700 dark:text-violet-300', cell: 'bg-violet-50/50 dark:bg-violet-950/10', badge: 'bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
  slate:   { band: 'bg-slate-50 dark:bg-slate-900/30', header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300', text: 'text-slate-600 dark:text-slate-400', cell: '', badge: 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700' },
}

function gColor(color: string) { return GROUP_COLORS[color] ?? GROUP_COLORS.slate }

// #7 — the single writability gate for every bulk mutation (paste, fill,
// fill-down, replace, AI). A column locked via readOnly OR kind:'readonly'
// must never be written by any path, matching the click/type editors.
function isWritableCol(col?: { readOnly?: boolean; kind?: string } | null): boolean {
  return !!col && !col.readOnly && col.kind !== 'readonly'
}

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

// TbBtn moved to apps/web/src/app/products/_shared/FlatFileIconToolbar.tsx
// in Phase B. Toolbar buttons are rendered by FlatFileIconToolbar; this
// file no longer needs a local primitive.

// ── MenuDropdown ───────────────────────────────────────────────────────────

function MenuDropdown({ label, items }: { label: string; items: Array<{ label?: string; icon?: React.ReactNode; shortcut?: string; onClick?: () => void; disabled?: boolean; separator?: boolean; checked?: boolean }> }) {
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
                {item.checked !== undefined && (
                  <span className="w-3.5 flex-shrink-0 text-violet-600 dark:text-violet-400 font-semibold">{item.checked ? '✓' : ''}</span>
                )}
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

function EnumDropdown({ anchor, options, optionLabels, current, enumMode, multi, initialQuery = '', onSelect, onClose }: {
  /** The cell (<td>) the dropdown belongs to — the portal positions off its
   *  viewport rect (UFX P7 item 2). */
  anchor: HTMLElement
  options: string[]; optionLabels?: Record<string, string>
  current: string
  /** 'strict' = eBay only accepts listed values; a typed custom value is
   *  still allowed but flagged. 'open'/undefined = free text, no flag. */
  enumMode?: 'open' | 'strict'
  /** Multi-value: the cell holds a comma list; selecting toggles membership
   *  and the dropdown stays open. onSelect receives the full comma-joined
   *  string. Single (default) replaces the value and closes. */
  multi?: boolean
  /** Seed the search box (e.g. the character the user typed on the cell to
   *  open the dropdown) so dropdown cells support Excel-style type-to-filter. */
  initialQuery?: string
  /** #14 — dir is how the value was committed: Enter→'down', Tab→'right',
   *  mouse-click→undefined (stay on the cell). */
  onSelect: (v: string, dir?: 'right' | 'down') => void; onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // UFX P7 (item 2) — portal position. Measured AFTER render (menu height
  // depends on the filtered list), then clamped/flipped by the pure math in
  // dropdown-position.ts. Null until first measure → rendered invisible so
  // there's no flash at (0,0).
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const reposition = useCallback(() => {
    const menu = rootRef.current
    if (!menu) return
    const r = anchor.getBoundingClientRect()
    const next = computeDropdownPosition({
      cell: { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
      menuHeight: menu.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.width === next.width ? p : next))
  }, [anchor])
  // Runs every render: the menu height changes as the query filters the list,
  // and the setPos bail-out (same values → same reference) prevents loops.
  useLayoutEffect(() => { reposition() })
  // Track container + window scroll (capture catches the grid's own
  // overflow-auto scroller) and window resize.
  useEffect(() => {
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [reposition])

  const label = (opt: string) => optionLabels?.[opt] ?? opt

  // Multi-value: parse the current comma list into a membership set.
  const selected = useMemo(
    () => multi ? new Set(current.split(',').map((s) => s.trim()).filter(Boolean)) : new Set<string>(),
    [multi, current],
  )

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    if (!q) return options
    // #45 — rank matches exact > prefix > substring (stable within each tier) so
    // an exact/prefix hit isn't buried past the render cap on big lists.
    const rank = (o: string) => {
      const a = o.toLowerCase(), b = label(o).toLowerCase()
      if (a === q || b === q) return 0
      if (a.startsWith(q) || b.startsWith(q)) return 1
      return 2
    }
    return options
      .map((o, i) => ({ o, i, r: rank(o) }))
      .filter(({ o }) => label(o).toLowerCase().includes(q) || o.toLowerCase().includes(q))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map(({ o }) => o)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, optionLabels, query])

  // Whether the typed query can be committed as a custom value
  const hasCustom = query.trim() !== '' && !options.includes(query.trim())

  // FF-EN.6 — cap rendered rows for large value lists (e.g. Brand); the
  // search box narrows further. Keyboard nav + commit operate on the cap.
  const CAP = 200
  const visible = filtered.length > CAP ? filtered.slice(0, CAP) : filtered
  const overflow = filtered.length - visible.length
  const totalItems = visible.length + (hasCustom ? 1 : 0)
  const listId = useId()

  // Focus the search box on open; if seeded with a typed char, place the caret
  // at the end so the next keystroke appends (Excel-style type-to-replace).
  useEffect(() => { const el = searchRef.current; if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n) } }, [])
  useEffect(() => { setHi(0) }, [filtered])
  useEffect(() => { (listRef.current?.children[hi] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }) }, [hi])
  useEffect(() => {
    // Portaled: the menu root (not the td) owns the click-outside boundary —
    // same semantics as the old inline dropdown (clicking the cell closes it).
    function h(e: MouseEvent) { if (!rootRef.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [onClose])

  // Single: replace + (caller) close. Multi: toggle membership, stay open.
  function choose(v: string, dir?: 'right' | 'down') {
    if (!multi) { onSelect(v, dir); return }
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onSelect([...next].join(','))
    // #70 — keep the search query so the filter survives each multi toggle.
  }

  function commit(idx: number, dir?: 'right' | 'down') {
    if (idx === visible.length && hasCustom) { choose(query.trim(), dir); return }
    if (visible[idx] != null) choose(visible[idx], dir)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Keep these keys inside the dropdown — otherwise they bubble to the grid's
    // global keydown handler and double-fire (Escape clearing the whole
    // selection, Enter/Tab moving the active cell out from under the popover).
    e.stopPropagation()
    // #76 / UFX P7 — Enter/Tab confirming an IME candidate in the search box
    // must not commit an option.
    if (isComposingKeyEvent(e.nativeEvent)) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, totalItems - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(hi, 'down') }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); commit(hi, e.shiftKey ? undefined : 'right') }
  }

  // UFX P7 (item 2) — portaled to <body> so the grid's overflow container /
  // frozen-column stacking can't clip it; flips above the cell on bottom rows.
  return createPortal(
    <div ref={rootRef}
      className="fixed z-[9999] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden"
      style={pos
        ? { left: pos.left, top: pos.top, width: pos.width }
        : { left: 0, top: 0, width: Math.max(MIN_DROPDOWN_WIDTH, anchor.getBoundingClientRect().width), visibility: 'hidden' }}
      onKeyDown={handleKeyDown}>
      <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={enumMode === 'strict' ? 'Search eBay’s values…' : multi ? 'Search or add values…' : 'Search or type your own…'}
          role="combobox" aria-expanded={true} aria-autocomplete="list" aria-controls={listId}
          aria-activedescendant={totalItems > 0 ? `${listId}-opt-${hi}` : undefined}
          aria-label="Search or type a value"
          className="w-full text-xs px-1.5 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-multiselectable={multi || undefined} className="max-h-52 overflow-y-auto">
        {visible.map((opt, i) => {
          const isOn = multi ? selected.has(opt) : opt === current
          return (
          <div key={opt || '_empty'} id={`${listId}-opt-${i}`} role="option" aria-selected={isOn}
            onMouseDown={(e) => { e.preventDefault(); choose(opt) }}
            onMouseEnter={() => setHi(i)}
            className={cn('px-3 py-1.5 text-xs cursor-pointer flex items-center gap-1.5',
              i === hi ? 'bg-blue-500 text-white'
              : isOn ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50')}>
            {multi && (
              <span className={cn('shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center',
                isOn ? (i === hi ? 'bg-white/20 border-white' : 'bg-blue-500 border-blue-500') : 'border-slate-300 dark:border-slate-600')}>
                {isOn && <Check className={cn('w-2.5 h-2.5', i === hi ? 'text-white' : 'text-white')} />}
              </span>
            )}
            {opt === '' ? <span className="italic opacity-60">— empty —</span> : (
              optionLabels?.[opt]
                ? <span className="flex items-baseline gap-1.5 min-w-0">
                    <span className="truncate">{optionLabels[opt]}</span>
                    <span className={cn('text-[10px] font-mono shrink-0', i === hi ? 'text-blue-200' : 'text-slate-400')}>{opt}</span>
                  </span>
                : opt
            )}
          </div>
          )
        })}
        {visible.length === 0 && !hasCustom && (
          <div className="px-3 py-2 text-xs text-slate-400 italic">No matches</div>
        )}
        {hasCustom && (
          <div id={`${listId}-opt-${visible.length}`} role="option" aria-selected={false}
            onMouseDown={(e) => { e.preventDefault(); choose(query.trim()) }}
            onMouseEnter={() => setHi(visible.length)}
            className={cn('px-3 py-1.5 text-xs cursor-pointer border-t flex items-center gap-1.5',
              enumMode === 'strict' ? 'border-amber-200 dark:border-amber-800/60' : 'border-slate-100 dark:border-slate-700',
              hi === visible.length
                ? (enumMode === 'strict' ? 'bg-amber-500 text-white' : 'bg-blue-500 text-white')
                : (enumMode === 'strict'
                    ? 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'))}>
            {enumMode === 'strict' && <AlertCircle className="w-3 h-3 shrink-0" />}
            <span className="opacity-60">Use</span>
            <span className="font-mono font-medium truncate">&ldquo;{query.trim()}&rdquo;</span>
            {enumMode === 'strict' && (
              <span className={cn('ml-auto text-[10px] shrink-0', hi === visible.length ? 'text-amber-100' : 'text-amber-500/80')}>
                not in eBay&apos;s list
              </span>
            )}
          </div>
        )}
        {overflow > 0 && (
          <div className="px-3 py-1.5 text-[10px] text-slate-400 italic border-t border-slate-100 dark:border-slate-700">
            +{overflow} more — keep typing to filter
          </div>
        )}
      </div>
      {multi && (
        <div className="px-2 py-1 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
          <span className="text-[10px] text-slate-400">{selected.size} selected</span>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); onClose() }}
            className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline px-1">Done</button>
        </div>
      )}
    </div>,
    document.body,
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
  guidanceLevel?: 'not-applicable' | 'optional' | null
  /** UFX P2b — per-cell lock from getCellReadOnly (e.g. FBA-managed quantity). */
  cellReadOnly: boolean
  renderCellContent?: RenderCellContent
  onCellPointerDown: (shiftKey: boolean) => void
  onCellDoubleClick: () => void
  onFillHandlePointerDown: () => void
  onFillToBottom: () => void
  onFillDrop: () => void
  onDeactivate: () => void
  onChange: (val: unknown) => void
  onLiveChange: (val: string) => void
  onPushSnapshot: () => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetCellImpl({ col, row, value, isActive, cellBg, width, cellHeight, ri, ci,
  isSelected, selEdges, isCorner, isFillTarget, fillTargetEdges,
  isEditing, editInitialChar, isClipboard, clipboardEdges,
  validIssue, stickyLeft, isMatch, toneCls,
  guidanceLevel, cellReadOnly,
  renderCellContent,
  onCellPointerDown, onCellDoubleClick, onFillHandlePointerDown, onFillToBottom, onFillDrop,
  onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate,
}: CellInternalProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // UFX P7 (item 2) — enum cells hand their <td> to the portaled EnumDropdown
  // as the position anchor.
  const tdRef = useRef<HTMLTableCellElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [liveLen, setLiveLen] = useState(displayValue.length)
  const cancelledRef = useRef(false)
  const pendingWordSelRef = useRef<{ start: number; end: number } | null | undefined>(undefined)
  const originalValueRef = useRef('')
  const snapshotPushedRef = useRef(false)

  const isReadOnly = col.readOnly || col.kind === 'readonly' || cellReadOnly

  // UFX P2b — safety net (mirrors the Amazon FBA cell): if the grid somehow
  // starts editing a per-cell-locked cell, deactivate immediately.
  useEffect(() => { if (isEditing && cellReadOnly) onDeactivate() }, [isEditing, cellReadOnly, onDeactivate])

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

  // Typing on an active enum/boolean cell (or pressing F2) flips the grid into
  // edit mode; bridge that into opening this cell's dropdown, pre-filled with
  // the typed character. Without this the keystroke is swallowed and the cell
  // appears frozen — the root of the "can't type into dropdown cells" glitch.
  useEffect(() => {
    if (isEditing && (col.kind === 'enum' || col.kind === 'boolean')) setDropdownOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, col.kind])

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

  // Guidance overlay — applied only when cell is not actively selected/highlighted
  const guidanceCls = !isActive && !isSelected && !isMatch && !toneCls
    ? guidanceLevel === 'not-applicable' ? 'bg-slate-200 dark:bg-slate-700/70'
    : guidanceLevel === 'optional'       ? 'bg-slate-100/80 dark:bg-slate-800/60'
    : ''
    : ''

  // UFX P2c — the required marker/styling are per-ROW when the column declares
  // requiredForProductTypes; legacy columns (field absent) keep col.required.
  const isRequired = isRequiredForRow(col, row)

  const guidanceTitle = guidanceLevel === 'not-applicable'
    ? typeApplicabilityGuidance(col, row) === 'not-applicable'
      ? `Not applicable to ${String(row.product_type)} — this category doesn't use this field, so a value here is NOT submitted for this row (still editable)`
      : col.applicableParentage?.length
        ? `Not needed for this row type — typically set on ${col.applicableParentage.map((p) => p.replace('VARIATION_', '').toLowerCase()).join(' or ')} rows only`
        : 'Not applicable for this row / product configuration'
    : undefined

  // The background class(es) this cell paints — state first (same precedence
  // as always), then the group band/guidance tint, plus the validation tint.
  const stateBg =
    isSelected ? 'bg-blue-100/60 dark:bg-blue-900/20'
    : isClipboard ? 'bg-green-50/40 dark:bg-green-900/10'
    : isFillTarget ? 'bg-blue-50/80 dark:bg-blue-900/10'
    : isMatch ? 'bg-yellow-100 dark:bg-yellow-900/30'
    : toneCls ? toneCls
    : guidanceCls || cellBg
  const validBg = !isActive && !isSelected && !isMatch && !toneCls && !guidanceLevel
    ? (validIssue?.level === 'error' ? 'bg-red-100/80 dark:bg-red-950/30'
      : validIssue?.level === 'warn' ? 'bg-amber-50/80 dark:bg-amber-950/20'
      : '')
    : ''

  // UFX P7 (item 4) — frozen (sticky) cells must composite OPAQUE: the
  // selected/error/warn/fill/guidance tints are alpha classes, so rows
  // scrolling underneath used to bleed through them. Sticky cells paint a
  // solid base on the <td> and the tint on an inset overlay ABOVE it — the
  // same alpha over the same solid base in light AND dark, so visual parity
  // holds while horizontal scroll can no longer show through. (Skipped while
  // editing: the editor input paints its own solid background.)
  const isSticky = stickyLeft !== undefined
  const stickyTint = isSticky && !isEditing ? cn(stateBg, validBg) : null
  const stickyOverlay = stickyTint ? (
    <span aria-hidden className={cn('absolute inset-0 pointer-events-none transition-colors', stickyTint,
      // Hover tint lives HERE for sticky cells — on the <td> it would override
      // the solid base (hover:bg-white/50 beats bg-white while hovered) and
      // reopen the translucency this overlay exists to close.
      'group-hover/ffc:bg-white/50 dark:group-hover/ffc:bg-slate-700/30')} />
  ) : null
  const cellHoverCls = stickyTint
    ? 'cursor-pointer group/ffc'
    : 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30'

  const baseCls = cn(
    'border-b border-r border-slate-200 dark:border-slate-700 relative transition-colors',
    stickyTint ? 'bg-white dark:bg-slate-900' : cn(stateBg, validBg),
    isActive && !isEditing && 'outline outline-2 outline-blue-500 outline-offset-[-1px] z-[5]',
    isEditing && 'ring-2 ring-inset ring-blue-500 z-[5]',
    // Suppress native text selection while dragging to select cells; the input
    // in an editing cell keeps its own selectable text (UA reset).
    !isEditing && 'select-none',
    // Read-only dim: on sticky cells opacity on the <td> would translucify the
    // solid base (same bleed class as the hover bug) — dim the content instead.
    isReadOnly && !stickyTint && 'opacity-75',
  )
  // Content must be POSITIONED so it paints above the sticky overlay.
  const contentAboveOverlay = stickyOverlay ? cn('relative', isReadOnly && 'opacity-75') : ''

  const tdPointerDown = (e: React.PointerEvent<HTMLTableCellElement>) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    if (isEditing && (tag === 'INPUT' || tag === 'TEXTAREA')) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    onCellPointerDown(e.shiftKey)
  }

  // Commit the input's CURRENT value before leaving the cell. A single typed
  // char arrives as the input's defaultValue and fires NO onInput, so without
  // this it was silently dropped on Tab/Enter/blur ("type 5, Enter → gone").
  const commitInput = () => {
    const inp = inputRef.current
    if (!inp) return
    const val = inp.value
    if (val === displayValue) return
    if (!snapshotPushedRef.current) {
      originalValueRef.current = displayValue
      onPushSnapshot()
      snapshotPushedRef.current = true
    }
    onLiveChange(val)
  }

  function handleKeyDown(e: KeyboardEvent) {
    // #76 / UFX P7 — a keydown that is part of an IME composition (e.g. the
    // Enter confirming a candidate) must not commit or move the cell.
    if (isComposingKeyEvent(e.nativeEvent)) return
    if (e.key === 'Tab') { e.preventDefault(); commitInput(); onNavigate(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Enter' && col.kind !== 'longtext') { e.preventDefault(); commitInput(); onNavigate(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Escape') {
      if (snapshotPushedRef.current) { onLiveChange(originalValueRef.current); snapshotPushedRef.current = false }
      cancelledRef.current = true
      onDeactivate(); setDropdownOpen(false)
    }
    else if (e.key === 'ArrowDown' && (col.kind === 'enum' || col.kind === 'boolean')) { e.preventDefault(); setDropdownOpen(true) }
  }

  const fillHandle = isCorner ? (
    <div className="absolute bottom-[-3px] right-[-3px] w-[7px] h-[7px] bg-blue-500 border-[1.5px] border-white dark:border-slate-900 z-20 cursor-crosshair"
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.releasePointerCapture(e.pointerId); onFillHandlePointerDown() }}
      onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); onFillToBottom() }}
      title="Drag to fill · double-click to fill down" />
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

  // Readonly cell — column-level (readOnly / kind:'readonly') renders exactly as
  // before; a per-CELL lock (cellReadOnly) additionally gets cursor-not-allowed +
  // select-none and shows an em-dash when empty (Amazon FBA-cell parity).
  if (isReadOnly) {
    const custom = renderCellContent?.(col, row, value, displayValue)
    return (
      <td {...tdShared} className={cn(baseCls, cellReadOnly && 'cursor-not-allowed')} style={{ ...cellStyle, ...selStyle }}
        title={cellReadOnly ? (col.description ?? 'Read-only for this row') : undefined}>
        {stickyOverlay}
        {fillHandle}
        <div className={cn('px-1.5 flex items-center text-xs truncate text-slate-500 dark:text-slate-400', cellReadOnly && 'select-none', contentAboveOverlay)} style={hStyle}>
          {custom ?? (cellReadOnly && isEmpty ? '—' : displayValue)}
        </div>
      </td>
    )
  }

  // Enum / boolean cell — UFX P4d: options resolve per ROW (a union column
  // with optionsByProductType offers/validates the row's own type's list).
  const enumOptions = enumOptionsForRow(col, row)
  if (enumOptions) {
    const custom = renderCellContent?.(col, row, value, displayValue)
    // FF-EN.5 — a strict (SELECTION_ONLY / category-condition) cell holding a
    // value the channel doesn't list FOR THIS ROW (per-type list on union
    // sheets). Allowed (per the product owner) but flagged, since the channel
    // rejects it at publish. Multi cells flag if ANY part is off-list.
    const strictInvalid =
      col.kind === 'enum' && col.enumMode === 'strict' && !!displayValue &&
      displayValue.split(',').map((s) => s.trim()).filter(Boolean).some((v) => !enumOptions.includes(v))
    // #13 — show the friendly label(s) (e.g. "Fixed Price", "kg") the dropdown
    // shows, not the raw code (FIXED_PRICE, KILOGRAM). Map each part for multi.
    const labelFor = (v: string) => col.optionLabels?.[v] ?? v
    const shownLabel = displayValue
      ? displayValue.split(',').map((s) => labelFor(s.trim())).filter(Boolean).join(', ')
      : ''
    return (
      <td {...tdShared} ref={tdRef} className={baseCls} style={{ ...cellStyle, ...selStyle }}
        title={strictInvalid ? `"${displayValue}" isn't in the accepted list for this field${typeof row.product_type === 'string' && row.product_type && col.optionsByProductType ? ` on ${String(row.product_type).toUpperCase()}` : ''} — it may be rejected at publish` : undefined}
        aria-haspopup="listbox" aria-expanded={isActive && dropdownOpen}
        onClick={() => { if (isActive) setDropdownOpen(true) }}
        onDoubleClick={(e) => {
          const charPos = getCharIndexFromPoint(e.clientX, e.clientY)
          pendingWordSelRef.current = charPos >= 0 ? (() => { const [s, end] = wordBoundsAt(displayValue, charPos); return { start: s, end } })() : null
          onCellDoubleClick(); setDropdownOpen(true)
        }}>
        {stickyOverlay}
        <div className={cn('px-1.5 flex items-center justify-between gap-1 cursor-pointer group/cell', contentAboveOverlay)} style={hStyle}>
          {custom != null ? custom : (
            <span className={cn('text-xs truncate flex-1 flex items-center gap-1',
              strictInvalid ? 'text-amber-600 dark:text-amber-400'
              : isEmpty ? 'text-slate-300 dark:text-slate-600 italic' : 'text-slate-800 dark:text-slate-200')}>
              {strictInvalid && <AlertCircle className="w-3 h-3 shrink-0" aria-hidden />}
              <span className="truncate">{shownLabel || (isRequired ? '⚠ required' : enumOptions[1] ? `e.g. ${labelFor(enumOptions[1])}` : '—')}</span>
            </span>
          )}
          {/* #39 — the pick-list chevron is always visible once the cell is
              active/selected (only hover-revealed otherwise), so enum cells read
              as dropdowns. */}
          <ChevronDown className={cn('w-3 h-3 text-slate-400 flex-shrink-0 transition-opacity', isActive || isSelected ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100')} />
        </div>
        {fillHandle}
        {isActive && dropdownOpen && tdRef.current && (
          <EnumDropdown anchor={tdRef.current} options={enumOptions} optionLabels={col.optionLabels} current={displayValue}
            enumMode={col.kind === 'enum' ? col.enumMode : undefined}
            multi={col.kind === 'enum' ? col.multiValue : undefined}
            initialQuery={editInitialChar ?? ''}
            onSelect={(v, dir) => {
              onChange(v)
              // Multi keeps the dropdown open for more toggles; single replaces
              // and advances only in the direction implied by how it was
              // committed (#14): Enter→down, Tab→right, mouse-click→stay.
              if (!(col.kind === 'enum' && col.multiValue)) {
                setDropdownOpen(false)
                if (dir) onNavigate(dir); else onDeactivate()
              }
            }}
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
            onInput={(e) => setLiveLen((e.target as HTMLTextAreaElement).value.length) /* #5 — commit-once: no per-keystroke setRows; commitInput writes on exit */}
            onBlur={() => { if (!cancelledRef.current) commitInput(); cancelledRef.current = false; onDeactivate() }}
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
      <td {...tdShared} className={cn(baseCls, cellHoverCls)} style={{ ...cellStyle, ...selStyle }}>
        {stickyOverlay}
        {fillHandle}
        <div className={cn('px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate', contentAboveOverlay)} style={hStyle}>
          {custom ?? (displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{isRequired ? '⚠ required' : ''}</span>)}
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
        {/* #22 — text + inputMode instead of type=number: allows it-IT comma
            decimals (9,99), stops scroll-wheel mutating the value, and respects
            maxLength (all broken by the native number input). */}
        <input ref={inputRef as any} type="text" inputMode={col.kind === 'number' ? 'decimal' : undefined}
          defaultValue={editInitialChar !== null ? editInitialChar : displayValue} maxLength={col.maxLength}
          onInput={(e) => setLiveLen((e.target as HTMLInputElement).value.length) /* #5 — commit-once: commitInput writes on exit */}
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
    <td {...tdShared} className={cn(baseCls, cellHoverCls)}
      style={{ ...cellStyle, ...selStyle }} title={guidanceTitle ?? validIssue?.msg ?? col.description}
      aria-invalid={validIssue?.level === 'error' ? true : undefined}>
      {stickyOverlay}
      {fillHandle}
      {/* #41 — non-color error/warning cue (Excel-style corner marker) */}
      {validIssue && (
        <span aria-hidden className="absolute top-0 right-0 w-0 h-0 border-t-[5px] border-l-[5px] border-l-transparent"
          style={{ borderTopColor: validIssue.level === 'error' ? '#ef4444' : '#f59e0b' }} />
      )}
      <div className={cn('px-1.5 flex items-center text-xs truncate', contentAboveOverlay,
        isEmpty ? (isRequired ? 'text-red-500 dark:text-red-400 italic' : 'text-slate-400 dark:text-slate-500') : 'text-slate-800 dark:text-slate-200')}
        style={hStyle}>
        {custom ?? (displayValue || (isRequired ? '⚠ required' : ''))}
      </div>
    </td>
  )
}

// #3 (perf) — memoize each cell so moving the active cell / typing only
// re-renders the cells whose VISUAL props changed, not the whole sheet. The
// on* callbacks are intentionally excluded: they're recreated every render but
// close over the stable ri/ci, and every visual input is compared below.
// `row` identity is compared (commitCells only clones changed rows) which
// covers renderCellContent reading any row field.
type CellEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
function edgesEqual(a: CellEdges, b: CellEdges): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left
}
function areCellPropsEqual(a: CellInternalProps, b: CellInternalProps): boolean {
  return (
    a.col === b.col &&
    a.row === b.row &&
    a.value === b.value &&
    a.isActive === b.isActive &&
    a.isEditing === b.isEditing &&
    a.editInitialChar === b.editInitialChar &&
    a.cellBg === b.cellBg &&
    a.width === b.width &&
    a.cellHeight === b.cellHeight &&
    a.ri === b.ri &&
    a.ci === b.ci &&
    a.isSelected === b.isSelected &&
    a.isCorner === b.isCorner &&
    a.isFillTarget === b.isFillTarget &&
    a.isClipboard === b.isClipboard &&
    a.isMatch === b.isMatch &&
    a.toneCls === b.toneCls &&
    a.guidanceLevel === b.guidanceLevel &&
    a.cellReadOnly === b.cellReadOnly &&
    a.stickyLeft === b.stickyLeft &&
    a.renderCellContent === b.renderCellContent &&
    edgesEqual(a.selEdges, b.selEdges) &&
    edgesEqual(a.fillTargetEdges, b.fillTargetEdges) &&
    edgesEqual(a.clipboardEdges, b.clipboardEdges) &&
    (a.validIssue === b.validIssue ||
      (!!a.validIssue && !!b.validIssue && a.validIssue.level === b.validIssue.level && a.validIssue.msg === b.validIssue.msg))
  )
}
const SpreadsheetCell = memo(SpreadsheetCellImpl, areCellPropsEqual)

// ── GroupHeader ────────────────────────────────────────────────────────────

const GROUP_DOT: Record<string, string> = {
  blue: 'bg-blue-500', purple: 'bg-purple-500', emerald: 'bg-emerald-500',
  orange: 'bg-orange-500', teal: 'bg-teal-500', amber: 'bg-amber-500',
}
function GroupHeader({ row, label, color, count, bandClass, isExpanded, onToggle, showImage, imageSize, colSpan }: {
  row?: BaseRow; label?: string; color?: string; count?: number
  bandClass: string; isExpanded: boolean; onToggle: () => void
  showImage: boolean; imageSize: number; colSpan: number
}) {
  const shownLabel = label ?? String(row?.title ?? row?.sku ?? row?.item_sku ?? row?._rowId ?? '')
  const imgUrl = row?.image_1 as string | undefined
  return (
    <tr className={cn('border-b border-slate-200 dark:border-slate-700', bandClass)}>
      <td colSpan={colSpan} className="px-3 py-1">
        <div className="flex items-center gap-3">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !isExpanded && '-rotate-90')} />
            {color && <span className={cn('w-2 h-2 rounded-full shrink-0', GROUP_DOT[color] ?? 'bg-slate-400')} />}
            {shownLabel}
            {count != null && <span className="text-slate-400 font-normal tabular-nums">· {count}</span>}
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
  columnGroups, initialRows, makeBlankRow, minRows = 15, ghostRows,
  getGroupKey, bucketMode, validate,
  onSave, onReload, onCellChange, onMaterializeRow,
  onSortConfigChange, onRowOrderChange,
  renderCellContent, renderRowMeta, getRowImageUrl, onBeforeEditCell, getCellGuidance, getCellReadOnly,
  onReplicate,
  renderChannelStrip, renderPushExtras, renderFeedBanner, renderModals,
  renderToolbarFetch, renderToolbarImport, renderBar3Left,
  renderAiPanel, renderEmptyAction, renderContextMenu, renderFooterActions,
  onColumnsClick, columnsActive, toolbarTrailing,
  columnGroupState, onGroupStateChange,
  fileMenuItems, editMenuItems, viewMenuItems,
  apiRef,
  enableCustomGroups = false,
}: FlatFileGridProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { exportCatalogWorkbook, exporting: exportingWorkbook } = useCatalogWorkbookExport()

  // ── Row state ──────────────────────────────────────────────────────────
  // UFX P2d — with the ghost canvas on, minRows padding is redundant (the
  // canvas IS the padding, and unlike padToMin rows it's excluded from dirty
  // counts/save/validation): skip it so 0 real rows reach the empty-state CTA.
  const ghostEnabled = ghostRows != null && ghostRows > 0
  const effectiveMinRows = ghostEnabled ? 0 : minRows
  const paddedInitRef = useRef<BaseRow[] | null>(null)
  if (!paddedInitRef.current) {
    const padded = padToMin(initialRows, makeBlankRow, effectiveMinRows)
    // Restore saved drag-drop order: reconcile saved _rowId order with current rows.
    // New rows (not in saved order) append at end; deleted ids are dropped.
    try {
      const saved: string[] | null = JSON.parse(localStorage.getItem(`${storageKey}-row-order`) ?? 'null')
      if (Array.isArray(saved) && saved.length > 0) {
        const orderMap = new Map(saved.map((id, i) => [id, i]))
        const inOrder = padded.filter((r) => orderMap.has(r._rowId))
        inOrder.sort((a, b) => orderMap.get(a._rowId)! - orderMap.get(b._rowId)!)
        const notInOrder = padded.filter((r) => !orderMap.has(r._rowId))
        paddedInitRef.current = [...inOrder, ...notInOrder]
      } else {
        paddedInitRef.current = padded
      }
    } catch {
      paddedInitRef.current = padded
    }
  }

  const [rows, setRows]       = useState<BaseRow[]>(paddedInitRef.current)
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)

  // ── Undo / redo (Amazon-style history/future arrays) ───────────────────
  const rowsRef = useRef<BaseRow[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  // UFX P2d — ghost-canvas topup (GX.5 parity): keep `ghostRows` trailing
  // blank rows so there's always a canvas to type into; refills after a ghost
  // materializes (auto-grow). Converges: the count guard here plus topUpGhosts
  // returning the SAME array when full means it can never render-loop.
  useEffect(() => {
    if (!ghostEnabled) return
    if (countGhosts(rows) >= ghostRows!) return
    setRows((prev) => topUpGhosts(prev, ghostRows!, makeBlankRow))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ghostEnabled, ghostRows])

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
  // Anchor for shift-click range selection on the row checkboxes (display-row index).
  const lastCheckedRef   = useRef<number | null>(null)
  const [activeCell,     setActiveCell]     = useState<{ rowId: string; colId: string } | null>(null)
  const [selAnchor,      setSelAnchor]      = useState<{ ri: number; ci: number } | null>(null)
  const [selEnd,         setSelEnd]         = useState<{ ri: number; ci: number } | null>(null)
  const [isFillDragging, setIsFillDragging] = useState(false)
  const [fillDragEnd,    setFillDragEnd]    = useState<{ ri: number; ci: number } | null>(null)
  const [isEditing,      setIsEditing]      = useState(false)
  const [editInitialChar, setEditInitialChar] = useState<string | null>(null)
  const [clipboardRange, setClipboardRange] = useState<NormSel | null>(null)
  // UFX P3 — consumer context-menu anchor (only used with renderContextMenu)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

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

  // B4 — sticky COLUMN headers, take 2. A sticky thead binds to its NEAREST
  // overflow ancestor — the grid's own `overflow-auto` wrapper — but that
  // wrapper never actually scrolled (the min-h-screen root grows and the app
  // shell's <main> scrolls instead), so sticky never engaged and an offset
  // against <main> couldn't help either. Fix: bound the wrapper's height to
  // the viewport (measured from its live top; re-measured when the toolbar
  // wraps or the window resizes) so IT becomes the real scroller — then the
  // plain `sticky top-0` thead pins directly under the toolbar.
  const stickyHeaderRef = useRef<HTMLElement>(null)
  const scrollWrapRef = useRef<HTMLDivElement>(null)
  const [stickyHeaderH, setStickyHeaderH] = useState(0)
  useEffect(() => {
    const el = stickyHeaderRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setStickyHeaderH(Math.round(el.getBoundingClientRect().height))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = scrollWrapRef.current
    if (!el) return
    const update = () => {
      const top = el.getBoundingClientRect().top
      el.style.maxHeight = `${Math.max(240, Math.round(window.innerHeight - top))}px`
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [stickyHeaderH])

  // #49 — mirror sizes into refs and skip the localStorage write while a resize
  // drag is in progress (it fired JSON.stringify + write on every mousemove);
  // the final value is flushed once on mouseup (onUp below).
  const colWidthsRef = useRef(colWidths); useEffect(() => { colWidthsRef.current = colWidths }, [colWidths])
  const rowHeightRef = useRef(rowHeight); useEffect(() => { rowHeightRef.current = rowHeight }, [rowHeight])
  useEffect(() => { if (resizeDragRef.current) return; try { localStorage.setItem(`${storageKey}-col-widths`, JSON.stringify(colWidths)) } catch {} }, [colWidths, storageKey])
  useEffect(() => { if (resizeDragRef.current) return; try { localStorage.setItem(`${storageKey}-row-height`, String(rowHeight)) } catch {} }, [rowHeight, storageKey])
  useEffect(() => { try { localStorage.setItem(`${storageKey}-frozen-cols`, String(frozenColCount)) } catch {} }, [frozenColCount, storageKey])

  // ── Sort state (persisted) ─────────────────────────────────────────────
  const [sortConfig, setSortConfig] = useState<SortLevel[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-sort`) ?? '[]') } catch { return [] }
  })
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  useEffect(() => { try { localStorage.setItem(`${storageKey}-sort`, JSON.stringify(sortConfig)) } catch {} }, [sortConfig, storageKey])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = resizeDragRef.current; if (!d) return
      if (d.type === 'col' && d.colId) setColWidths((p) => ({ ...p, [d.colId!]: Math.max(60, d.startVal + e.clientX - d.startX) }))
      else if (d.type === 'row') setRowHeight(Math.max(24, d.startVal + e.clientY - d.startY))
    }
    function onUp() {
      const d = resizeDragRef.current
      resizeDragRef.current = null
      if (!d) return
      // #49 — flush the final size once, now that the per-move writes were skipped
      try {
        if (d.type === 'col') localStorage.setItem(`${storageKey}-col-widths`, JSON.stringify(colWidthsRef.current))
        else localStorage.setItem(`${storageKey}-row-height`, String(rowHeightRef.current))
      } catch {}
    }
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
  const [aiPanelOpen,     setAiPanelOpen]     = useState(false)
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
  const [internalClosedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]')) } catch { return new Set() }
  })
  const [internalGroupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') } catch { return [] }
  })

  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  // Derive from controlled prop if available, else fall back to internal state
  const closedGroups: Set<string> = columnGroupState
    ? new Set(columnGroupState.filter((g) => !g.visible).map((g) => g.id))
    : internalClosedGroups

  const groupOrder: string[] = columnGroupState
    ? columnGroupState.map((g) => g.id)
    : internalGroupOrder

  // ── Per-column hide/reorder (UFX P7 item 7) ────────────────────────────
  // A view-preference layer UNDER the group machinery: hidden columns are
  // removed from the rendered sheet only (data/saves/validation/replicate
  // untouched); order is per group, persisted per storageKey.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-hidden-cols`) ?? '[]')) } catch { return new Set() }
  })
  const [colOrderByGroup, setColOrderByGroup] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-col-order`) ?? '{}') } catch { return {} }
  })
  useEffect(() => { try { localStorage.setItem(`${storageKey}-hidden-cols`, JSON.stringify([...hiddenCols])) } catch {} }, [hiddenCols, storageKey])
  useEffect(() => { try { localStorage.setItem(`${storageKey}-col-order`, JSON.stringify(colOrderByGroup)) } catch {} }, [colOrderByGroup, storageKey])
  // Column header menu (chevron / right-click on a column header)
  const [colMenu, setColMenu] = useState<{ colId: string; x: number; y: number } | null>(null)

  // ── Row collapse ───────────────────────────────────────────────────────
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Set<string>>(new Set())

  // ── P4 — custom named groups (opt-in; persisted under the storageKey scope) ─
  const [customGroups, setCustomGroups] = useState<CustomGroup[]>(() => enableCustomGroups ? loadGroups(storageKey) : [])
  const [rawGroupMode, setGroupMode] = useState<CustomGroupMode>(() => enableCustomGroups ? loadGroupMode(storageKey) : 'family')
  // UFX P3 — 'bucket' only means something when the consumer declared a
  // bucketMode; a stale persisted value otherwise falls back to 'family'.
  const groupMode: CustomGroupMode = rawGroupMode === 'bucket' && !bucketMode ? 'family' : rawGroupMode
  const [collapsedCustomGroups, setCollapsedCustomGroups] = useState<Set<string>>(() => enableCustomGroups ? loadCollapsedGroups(storageKey) : new Set())
  const [groupCreate, setGroupCreate] = useState<{ skus: string[] } | null>(null)
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false)
  useEffect(() => { if (enableCustomGroups) saveGroups(storageKey, customGroups) }, [enableCustomGroups, storageKey, customGroups])
  useEffect(() => { if (enableCustomGroups) saveGroupMode(storageKey, groupMode) }, [enableCustomGroups, storageKey, groupMode])
  useEffect(() => { if (enableCustomGroups) saveCollapsedGroups(storageKey, collapsedCustomGroups) }, [enableCustomGroups, storageKey, collapsedCustomGroups])
  const UNGROUPED = 'cg:__ungrouped__'
  const skuOf = useCallback((row: BaseRow) => String(row.item_sku ?? row.sku ?? ''), [])

  // ── Drag-drop rows ─────────────────────────────────────────────────────
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [dropTarget,    setDropTarget]    = useState<{ rowId: string; half: 'top' | 'bottom' } | null>(null)
  // Only the row whose drag-handle is currently pressed is `draggable`. Leaving
  // every <tr> draggable makes the browser run native HTML5 drag-detection on
  // press, which swallows the first pointer moves and makes cell range-select
  // and fill-drag feel glitchy/laggy to start.
  const [armedDragRowId, setArmedDragRowId] = useState<string | null>(null)
  const canDragRef   = useRef(false)
  const rowDragRef   = useRef<number | null>(null)

  // ── Refs for stale-closure-free callbacks ──────────────────────────────
  const displayRowsRef       = useRef<BaseRow[]>([])
  const allColumnsRef        = useRef<FlatFileColumn[]>([])
  const selAnchorRef         = useRef<{ ri: number; ci: number } | null>(null)
  const selEndRef            = useRef<{ ri: number; ci: number } | null>(null)
  // #35 / UFX P2a — the column a row's Tab-entry started in; Enter returns here
  // and drops down (Sheets/Excel semantics). Maintained by BOTH the navigation-
  // mode keydown Tab/Enter AND the in-edit navigate() path (Tab/Enter out of a
  // cell editor). Reset by any other navigation (moveSelection default), a
  // mouse click, or Escape.
  const entryColRef          = useRef<number | null>(null)
  const isEditingRef         = useRef(false)
  // Mirrors isFillDragging synchronously. The container onPointerMove/onPointerUp
  // read this instead of the state value: setIsFillDragging(true) hasn't
  // re-rendered yet when the first move fires, so reading the state there routed
  // the whole gesture into selection-extend and the fill silently no-op'd.
  const isFillDraggingRef    = useRef(false)
  const onBeforeEditCellRef  = useRef(onBeforeEditCell)
  const getCellGuidanceRef   = useRef(getCellGuidance)
  const getCellReadOnlyRef   = useRef(getCellReadOnly)
  const onMaterializeRowRef  = useRef(onMaterializeRow)

  useEffect(() => { selAnchorRef.current = selAnchor }, [selAnchor])
  useEffect(() => { selEndRef.current    = selEnd }, [selEnd])
  useEffect(() => { isEditingRef.current = isEditing }, [isEditing])
  useEffect(() => { onBeforeEditCellRef.current = onBeforeEditCell }, [onBeforeEditCell])
  useEffect(() => { getCellGuidanceRef.current  = getCellGuidance },  [getCellGuidance])
  useEffect(() => { getCellReadOnlyRef.current  = getCellReadOnly },  [getCellReadOnly])
  useEffect(() => { onMaterializeRowRef.current = onMaterializeRow }, [onMaterializeRow])

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

  // UFX P7 (item 7) — what actually renders: each open group's columns with
  // the per-group saved order applied and hidden columns removed; a group
  // whose every column is hidden drops out of the sheet (its Bar-3 pill and
  // the Edit-menu "Show hidden columns" remain as the way back).
  // visibleGroups (full columns) still feeds replicate/sort so hide stays a
  // pure view preference.
  const renderGroups = useMemo(
    () => visibleGroups
      .map((g) => ({ ...g, columns: applyColumnOrder(g.columns, colOrderByGroup[g.id]).filter((c) => !hiddenCols.has(c.id)) }))
      .filter((g) => g.columns.length > 0),
    [visibleGroups, colOrderByGroup, hiddenCols],
  )

  const allColumns = useMemo<FlatFileColumn[]>(
    () => renderGroups.flatMap((g) => g.columns),
    [renderGroups],
  )
  useEffect(() => { allColumnsRef.current = allColumns }, [allColumns])

  const colToGroup = useMemo<Map<string, FlatFileColumnGroup>>(() => {
    const m = new Map<string, FlatFileColumnGroup>()
    for (const g of orderedGroups) for (const c of g.columns) m.set(c.id, g)
    return m
  }, [orderedGroups])

  const defaultGetGroupKey = useCallback((row: BaseRow) => String(row.platformProductId ?? row._rowId), [])
  const resolvedGetGroupKey = getGroupKey ?? defaultGetGroupKey

  // UFX P2d — the REAL (non-ghost) rows: everything that already consumed
  // `rows` for data purposes (grouping, search, counts, validation) now reads
  // this instead, so the trailing blank canvas can't leak into any of them.
  // With ghostRows off this IS `rows` (same reference — legacy identical).
  const realRows = useMemo(
    () => ghostEnabled ? rows.filter((r) => !r._ghost) : rows,
    [rows, ghostEnabled],
  )

  const rowGroups = useMemo(() => {
    const groups = new Map<string, BaseRow[]>()
    for (const row of realRows) {
      const key = resolvedGetGroupKey(row)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    return groups
  }, [realRows, resolvedGetGroupKey])

  // UFX P3 — the Bar-3 filter panel (parentage / has-ASIN / missing-required)
  // now actually filters rows (it previously only fed saved views). Row
  // parentage resolves generically: Amazon's parentage_level, eBay's explicit
  // parentage, or the legacy _isParent flag.
  const filterActive = filterState.parentage !== 'any' || filterState.hasAsin !== 'any' || filterState.missingRequired
  const filteredRows = useMemo(() => {
    let out = realRows
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      out = out.filter((r) => {
        if (String(r.sku ?? r.item_sku ?? '').toLowerCase().includes(q)) return true
        if (String(r.title ?? r.item_name ?? '').toLowerCase().includes(q)) return true
        if (String(r.asin ?? r._asin ?? '').toLowerCase().includes(q)) return true
        // #53 — also match any per-market eBay item/listing id column shown in the
        // grid (was only the single ebay_item_id field).
        for (const k in r) {
          if (/(_item_id|_listing_id)$|^ebay_item_id/.test(k) && String(r[k] ?? '').toLowerCase().includes(q)) return true
        }
        return false
      })
    }
    if (filterState.parentage !== 'any') {
      const want = filterState.parentage === 'parent' ? 'parent' : 'child'
      const parentageOf = (r: BaseRow): string => {
        const p = String(r.parentage_level ?? r.parentage ?? '')
        if (p) return p
        return r._isParent === true ? 'parent' : r._isParent === false ? 'child' : ''
      }
      out = out.filter((r) => parentageOf(r) === want)
    }
    if (filterState.hasAsin !== 'any') {
      out = out.filter((r) => (filterState.hasAsin === 'yes') === !!(r.asin ?? r._asin))
    }
    if (filterState.missingRequired) {
      out = out.filter((r) => allColumns.some((c) => {
        if (c.readOnly || c.kind === 'readonly') return false
        if (!isRequiredForRow(c, r)) return false
        const v = r[c.id]
        return v == null || String(v).trim() === ''
      }))
    }
    return out
  }, [realRows, searchQuery, filterState, allColumns])

  // P4 — custom-group section key for a row (only meaningful in custom mode).
  const customSectionKey = useCallback((row: BaseRow) => {
    const id = groupIdForSku(customGroups, skuOf(row))
    return id ? `cg:${id}` : UNGROUPED
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customGroups, skuOf])

  const displayRows = useMemo(() => {
    // UFX P2d — the ghost canvas is appended at the very bottom, OUTSIDE the
    // family/custom sections, and only in the default (unsearched, unfiltered)
    // view — a search/filter result shouldn't be padded with blanks. Empty when
    // disabled, so finish() returns each branch's array untouched.
    const ghostTail = ghostEnabled && !searchQuery && !filterActive ? rows.filter((r) => r._ghost) : []
    const finish = (result: BaseRow[]): BaseRow[] => {
      const final = ghostTail.length ? [...result, ...ghostTail] : result
      displayRowsRef.current = final
      return final
    }
    // P4 — CUSTOM mode: partition rows by custom group (in group.order),
    // Ungrouped last; column-sort applies WITHIN each group. A collapsed group
    // contributes just its first row as a header anchor (skipped in render).
    if (enableCustomGroups && groupMode === 'custom') {
      const buckets = new Map<string, BaseRow[]>()
      for (const g of [...customGroups].sort((a, b) => a.order - b.order)) buckets.set(`cg:${g.id}`, [])
      buckets.set(UNGROUPED, [])
      for (const row of filteredRows) {
        const key = customSectionKey(row)
        ;(buckets.get(key) ?? buckets.get(UNGROUPED)!).push(row)
      }
      const out: BaseRow[] = []
      buckets.forEach((bucket, key) => {
        if (!bucket.length) return  // don't render empty sections (incl. empty Ungrouped)
        if (collapsedCustomGroups.has(key)) { out.push(bucket[0]); return }
        out.push(...(sortConfig.length ? applySortLevels(bucket as Array<Record<string, unknown>>, sortConfig) as BaseRow[] : bucket))
      })
      return finish(out)
    }
    // P4 — NONE mode: flat, no sections; column sort applies to the whole sheet.
    if (enableCustomGroups && groupMode === 'none') {
      const out = sortConfig.length ? applySortLevels([...filteredRows] as Array<Record<string, unknown>>, sortConfig) as BaseRow[] : [...filteredRows]
      return finish(out)
    }
    // FAMILY (default / feature-off) — unchanged.
    // Build per-group arrays, pinning _isParent=true to index 0 within each group.
    const groupArrays: BaseRow[][] = []
    rowGroups.forEach((groupRows, groupKey) => {
      if (collapsedRowGroups.has(groupKey)) {
        if (groupRows.length > 1) {
          // Anchor = parent row so GroupHeader shows parent data
          const parent = groupRows.find((r) => r._isParent === true) ?? groupRows[0]
          groupArrays.push([parent])
        }
        return
      }
      const filtered = groupRows.filter((r) => filteredRows.some((fr) => fr._rowId === r._rowId))
      if (!filtered.length) return
      // Guarantee parent row is always first regardless of sort
      const parentIdx = filtered.findIndex((r) => r._isParent === true)
      if (parentIdx > 0) {
        const reordered = [...filtered]
        const [parent] = reordered.splice(parentIdx, 1)
        reordered.unshift(parent)
        groupArrays.push(reordered)
      } else {
        groupArrays.push(filtered)
      }
    })
    let result: BaseRow[]
    if (sortConfig.length > 0) {
      // Sort GROUPS by their representative (parent/first) row — not the full flat array.
      // This preserves intra-group parent-first order while still honouring column sorts.
      const reps = groupArrays.map((g) => g[0])
      const sortedReps = applySortLevels(reps as Array<Record<string, unknown>>, sortConfig) as BaseRow[]
      const repById = new Map(groupArrays.map((g) => [g[0]._rowId, g]))
      result = sortedReps.flatMap((r) => repById.get(r._rowId) ?? [r])
    } else {
      result = groupArrays.flat()
    }
    // UFX P3 — BUCKET mode: keep the family ordering computed above, then
    // stably partition it into the consumer's declared sections (empty buckets
    // hidden; a collapsed bucket contributes its first row as a header anchor,
    // skipped in render). Unknown bucket keys fall into the first bucket.
    if (bucketMode && groupMode === 'bucket') {
      const byBucket = new Map<string, BaseRow[]>(bucketMode.buckets.map((b) => [b.key, []]))
      const fallbackKey = bucketMode.buckets[0]?.key
      for (const row of result) {
        const k = bucketMode.bucketFor(row, realRows)
        ;(byBucket.get(k) ?? byBucket.get(fallbackKey))?.push(row)
      }
      const out: BaseRow[] = []
      for (const b of bucketMode.buckets) {
        const bucketRows = byBucket.get(b.key)!
        if (!bucketRows.length) continue
        if (collapsedCustomGroups.has(`bk:${b.key}`)) { out.push(bucketRows[0]); continue }
        out.push(...bucketRows)
      }
      return finish(out)
    }
    return finish(result)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ghostEnabled, filterActive, realRows, rowGroups, filteredRows, collapsedRowGroups, sortConfig, enableCustomGroups, groupMode, bucketMode, customGroups, collapsedCustomGroups, customSectionKey])

  // UFX P2d — displayed rows minus the ghost canvas, for the select-all
  // checkbox (Amazon parity: realDisplayRows). Same reference when disabled.
  const realDisplayRows = useMemo(
    () => ghostEnabled ? displayRows.filter((r) => !r._ghost) : displayRows,
    [displayRows, ghostEnabled],
  )

  // P4 — per-section metadata for custom-group headers (name/color/count).
  const customGroupMeta = useMemo(() => {
    const m = new Map<string, { name: string; color: GroupColorName; count: number }>()
    if (!enableCustomGroups || groupMode !== 'custom') return m
    for (const g of customGroups) m.set(`cg:${g.id}`, { name: g.name, color: g.color, count: 0 })
    m.set(UNGROUPED, { name: 'Ungrouped', color: 'blue', count: 0 })
    for (const row of filteredRows) { const e = m.get(customSectionKey(row)) ?? m.get(UNGROUPED)!; e.count++ }
    return m
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableCustomGroups, groupMode, customGroups, filteredRows, customSectionKey])

  // UFX P3 — per-bucket header metadata (name/color/count) for bucket mode.
  const bucketMeta = useMemo(() => {
    const m = new Map<string, { name: string; color: GroupColorName; count: number }>()
    if (!bucketMode || groupMode !== 'bucket') return m
    for (const b of bucketMode.buckets) m.set(`bk:${b.key}`, { name: b.name, color: b.color, count: 0 })
    const fallback = bucketMode.buckets[0] ? `bk:${bucketMode.buckets[0].key}` : ''
    for (const row of filteredRows) {
      const e = m.get(`bk:${bucketMode.bucketFor(row, realRows)}`) ?? m.get(fallback)
      if (e) e.count++
    }
    return m
  }, [bucketMode, groupMode, filteredRows, realRows])

  const normSel = useMemo<NormSel | null>(() => {
    if (!selAnchor || !selEnd) return null
    return {
      rMin: Math.min(selAnchor.ri, selEnd.ri), rMax: Math.max(selAnchor.ri, selEnd.ri),
      cMin: Math.min(selAnchor.ci, selEnd.ci), cMax: Math.max(selAnchor.ci, selEnd.ci),
    }
  }, [selAnchor, selEnd])

  // #47 — live Count / Sum / Avg / Min / Max for the selected cells (numeric
  // aware, it-IT comma decimals), so operators can sanity-check totals inline.
  const selectionStats = useMemo(() => {
    if (!normSel) return null
    const parseNum = (raw: string): number | null => {
      let t = raw.trim().replace(/[^\d.,-]/g, '')
      if (!t) return null
      const hasDot = t.includes('.'), hasComma = t.includes(',')
      if (hasDot && hasComma) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
      else if (hasComma) { const p = t.split(','); t = (p.length === 2 && p[1].length <= 2) ? `${p[0]}.${p[1]}` : t.replace(/,/g, '') }
      const n = parseFloat(t)
      return Number.isFinite(n) ? n : null
    }
    const { rMin, rMax, cMin, cMax } = normSel
    let nonEmpty = 0, numCount = 0, sum = 0, min = Infinity, max = -Infinity
    for (let ri = rMin; ri <= rMax; ri++) {
      const row = displayRowsRef.current[ri]; if (!row) continue
      for (let ci = cMin; ci <= cMax; ci++) {
        const col = allColumnsRef.current[ci]; if (!col) continue
        const s = row[col.id] == null ? '' : String(row[col.id]).trim()
        if (!s) continue
        nonEmpty++
        const n = parseNum(s)
        if (n != null) { numCount++; sum += n; if (n < min) min = n; if (n > max) max = n }
      }
    }
    return { nonEmpty, numCount, sum, avg: numCount ? sum / numCount : 0, min, max }
  }, [normSel, displayRows, allColumns])

  // #8 — reconcile the index-based selection to row/col IDENTITY. Capture the
  // rowId/colId under the selection whenever it changes…
  const selIdentityRef = useRef<{ aR?: string; aC?: string; eR?: string; eC?: string } | null>(null)
  useEffect(() => {
    if (!selAnchor || !selEnd) { selIdentityRef.current = null; return }
    const dr = displayRowsRef.current, ac = allColumnsRef.current
    selIdentityRef.current = {
      aR: dr[selAnchor.ri]?._rowId, aC: ac[selAnchor.ci]?.id,
      eR: dr[selEnd.ri]?._rowId,    eC: ac[selEnd.ci]?.id,
    }
  }, [selAnchor, selEnd])

  // …and remap those identities back to indices when the displayed rows or
  // columns change (sort / filter / collapse / reorder / delete), so the
  // highlight (and every bulk op that reads it) stays on the same records
  // instead of the same screen coordinates — and stops diverging from the
  // identity-based active cell. If a selected row/col vanished, clear rather
  // than point destructive ops at the wrong data.
  useEffect(() => {
    const id = selIdentityRef.current
    if (!id) return
    const dr = displayRowsRef.current, ac = allColumnsRef.current
    const aRi = id.aR ? dr.findIndex((r) => r._rowId === id.aR) : -1
    const aCi = id.aC ? ac.findIndex((c) => c.id === id.aC) : -1
    const eRi = id.eR ? dr.findIndex((r) => r._rowId === id.eR) : -1
    const eCi = id.eC ? ac.findIndex((c) => c.id === id.eC) : -1
    if (aRi < 0 || aCi < 0 || eRi < 0 || eCi < 0) {
      setSelAnchor(null); setSelEnd(null); setActiveCell(null); setClipboardRange(null)
      return
    }
    setSelAnchor((p) => (p && p.ri === aRi && p.ci === aCi ? p : { ri: aRi, ci: aCi }))
    setSelEnd((p) => (p && p.ri === eRi && p.ci === eCi ? p : { ri: eRi, ci: eCi }))
    setClipboardRange((c) => (c ? null : c))  // index-based copy marquee: drop on structural change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRows, allColumns])

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

  // UFX P2d — validate() sees only real rows: blank canvas rows are not data.
  const validationIssues = useMemo(
    () => validate ? validate(realRows) : [],
    [realRows, validate],
  )

  // UFX P3 — per-CELL issue map so validation issues shade the exact cell
  // (red/amber tint + corner marker + tooltip; the cell already supported a
  // validIssue prop but it was never wired). Keyed by `${sku}:${field}`;
  // an error wins over a warn on the same cell.
  const issueByCell = useMemo(() => {
    const m = new Map<string, ValidationIssue>()
    for (const iss of validationIssues) {
      const k = `${iss.sku}:${iss.field}`
      const prev = m.get(k)
      if (!prev || (prev.level === 'warn' && iss.level === 'error')) m.set(k, iss)
    }
    return m
  }, [validationIssues])

  // #83 — memoize the status-bar derivations instead of recomputing every render
  // (UFX P2d — dirty is counted over realRows; a ghost is never dirty anyway,
  // but this guarantees the canvas can't inflate the count.)
  const dirtyCount  = useMemo(() => realRows.filter((r) => r._dirty).length, [realRows])
  const errorCount  = useMemo(() => validationIssues.filter((i) => i.level === 'error').length, [validationIssues])
  const warnCount   = useMemo(() => validationIssues.filter((i) => i.level === 'warn').length, [validationIssues])

  // UFX P7 (item 3) — nav-away guard. Publish the dirty (non-ghost) count so
  // the ChannelStrip can confirm channel switches, and confirm tab-close /
  // hard-nav via beforeunload while dirty rows exist. Market switches are
  // deliberately unguarded (they flush edits to a local draft).
  useEffect(() => {
    setFlatFileDirtyCount(dirtyCount)
    return () => setFlatFileDirtyCount(0)
  }, [dirtyCount])
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!shouldConfirmLeave()) return
      e.preventDefault()
      // Chrome requires returnValue to be set; the browser shows its own copy.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

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
    // #55 — only build the rows×cols index while Find/Replace is open (was
    // rebuilt on every edit even when closed); depend on allColumns so it
    // doesn't read a lagging ref.
    if (!showFindReplace) return []
    const out: FindCell[] = []
    displayRows.forEach((row, ri) => {
      allColumns.forEach((col, ci) => {
        // #7 — readonly columns stay FINDABLE (search ASIN/item-id) but the
        // replace write is gated in onReplaceCell, so they can't be mutated.
        out.push({ rowIdx: ri, colIdx: ci, rowId: row._rowId, columnId: col.id, value: row[col.id] })
      })
    })
    return out
  }, [displayRows, allColumns, showFindReplace])

  // #16 — the row# column widens to fit thumbnails when row images are on; the
  // frozen-column sticky offset (and the header cell) must use the same width or
  // the frozen columns slide ~20px and overlap the row-number column.
  const rowHeaderWidth = showRowImages ? imageSize + 12 : 40
  const stickyLeftByColIdx = useMemo<Record<number, number>>(() => {
    const out: Record<number, number> = {}
    let left = 36 + rowHeaderWidth // checkbox(36) + row#
    for (let i = 0; i < Math.min(frozenColCount, allColumns.length); i++) {
      out[i] = left
      left += colWidths[allColumns[i].id] ?? allColumns[i].width
    }
    return out
  }, [frozenColCount, allColumns, colWidths, rowHeaderWidth])

  // ── Clipboard + fill ops ───────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    const tsv = displayRowsRef.current.slice(rMin, rMax + 1)
      .map((row) => allColumnsRef.current.slice(cMin, cMax + 1).map((col) => String(row[col.id] ?? '')).join('\t'))
      .join('\n')
    navigator.clipboard.writeText(tsv).catch(() => {})
  }, [normSel])

  // #9/#24 — the single write path for every bulk mutation. Pushes ONE snapshot,
  // applies all changes in one O(N) pass (no per-row findIndex), and emits
  // onCellChange for each (rowId,colId,value) so side-effects (e.g. the eBay
  // category_id → schema reload) fire no matter how the value was set.
  // UFX P2d — `appendRows` (paste-beyond-end auto-grow) are ghost rows added
  // to the sheet in the SAME setRows pass as the changes that write into them,
  // so the whole paste is one undo snapshot. Materialization also lives here:
  // since this is the single write path, ANY real write into a ghost (typing
  // commit via updateCell, paste, fill, enum pick, F&R, AI) flips it into a
  // plain new row (_ghost:false, _isNew:true, _dirty:true).
  type CellChange = { rowId: string; colId: string; value: unknown }
  const commitCells = useCallback((changes: CellChange[], appendRows: BaseRow[] = []) => {
    if (changes.length === 0) return
    // #23/#74/#75 — normalize every bulk-written value the same way the
    // interactive editors do (normalizeCellValue): coerce booleans, clamp to
    // maxLength/maxUtf8ByteLength, and — the hardening — ENFORCE strict enums
    // (paste 'pinned' → 'Pinned', junk → rejected) and number columns (non-numeric
    // rejected, below-min clamped) so paste/fill/replace/AI can't smuggle in
    // invalid values the channel later rejects. A `null` result REJECTS the write
    // for that cell: it's dropped here so the previous value is kept (never blanked).
    const colById = new Map(allColumnsRef.current.map((c) => [c.id, c]))
    const normalized: CellChange[] = []
    for (const ch of changes) {
      const col = colById.get(ch.colId)
      if (!col || typeof ch.value !== 'string') { normalized.push(ch); continue }
      const nv = normalizeCellValue(col, ch.value)
      if (nv === null) continue // rejected — keep the cell's previous value
      normalized.push(nv === ch.value ? ch : { ...ch, value: nv })
    }
    // #30 — drop no-op changes (delete-empty, fill-same, re-pick same enum) so
    // rows aren't falsely marked dirty and undo isn't polluted with dead steps.
    const rowById = new Map([...rowsRef.current, ...appendRows].map((r) => [r._rowId, r]))
    // UFX P2b — central per-CELL read-only guard: since commitCells is the single
    // write path for paste/fill/delete/replace/AI, filtering here means no bulk
    // path can write a cell the getCellReadOnly predicate locks.
    const writable = dropReadOnlyCellChanges(normalized, colById, rowById, getCellReadOnlyRef.current)
    const real = writable.filter((ch) => {
      const r = rowById.get(ch.rowId)
      return !!r && (r[ch.colId] ?? '') !== (ch.value ?? '')
    })
    if (real.length === 0) return
    pushSnapshot()
    const byRow = new Map<string, CellChange[]>()
    for (const ch of real) {
      const arr = byRow.get(ch.rowId)
      if (arr) arr.push(ch); else byRow.set(ch.rowId, [ch])
    }
    setRows((prev) => {
      // UFX P2d — appended grow-rows join the sheet only when something was
      // actually written (real.length > 0 — guaranteed here); pasted-into
      // ghosts (appended or pre-existing) materialize via the patch below.
      const base = appendRows.length ? [...prev, ...appendRows] : prev
      return base.map((r) => {
        const cs = byRow.get(r._rowId)
        if (!cs) return r
        // UFX P3 — the consumer materialize patch stamps infra fields (e.g.
        // product_type) after the built-in patch; the edited cell values are
        // applied last, so a user editing one of those fields wins.
        const updated: BaseRow = { ...r, ...materializeGhostPatch(r), ...(r._ghost ? onMaterializeRowRef.current?.(r) : undefined), _dirty: true }
        for (const c of cs) updated[c.colId] = c.value
        return updated
      })
    })
    for (const ch of real) onCellChange?.(ch.rowId, ch.colId, ch.value)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushSnapshot, onCellChange])

  const handleDeleteCells = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    const changes: CellChange[] = []
    for (let ri = rMin; ri <= rMax; ri++) {
      const dr = displayRowsRef.current[ri]; if (!dr) continue
      for (let ci = cMin; ci <= cMax; ci++) {
        const col = allColumnsRef.current[ci]
        if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: '' })
      }
    }
    commitCells(changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normSel, commitCells])

  const handleCut = useCallback(() => { handleCopy(); handleDeleteCells() }, [handleCopy, handleDeleteCells])

  const handlePaste = useCallback(async () => {
    if (!selAnchor) return
    // #69 — surface a denied/unavailable clipboard read instead of failing silently.
    let text = ''
    try { text = await navigator.clipboard.readText() }
    catch { toast({ title: 'Clipboard access blocked', description: 'Allow clipboard permission for this site, then paste again.', tone: 'warning' }); return }
    if (!text) return
    // #29 / UFX P7 — RFC-4180-aware tokenizer: quoted cells from Excel/Sheets
    // (embedded newlines/tabs, "" escapes) stay ONE cell instead of exploding
    // into rows. Line endings are normalized and trailing blank lines dropped
    // (interior blank rows preserved) inside the tokenizer; unquoted input
    // tokenizes exactly like the legacy split.
    const pasteRows = tokenizeClipboard(text)
    if (!pasteRows.length) return
    const firstRow = pasteRows[0]
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
    const dataRows = hasHeaders ? pasteRows.slice(1) : pasteRows
    // #10 — anchor paste at the normalized TOP-LEFT of the selection, not the
    // drag-origin corner, so an up/left-dragged selection doesn't spill paste
    // onto unselected cells.
    const startRi = normSel ? normSel.rMin : selAnchor.ri
    const startCi = normSel ? normSel.cMin : selAnchor.ci
    const changes: CellChange[] = []
    let tgtH = dataRows.length
    let tgtW = 1
    // UFX P2d — paste-beyond-end auto-grow: with the ghost canvas enabled (and
    // its tail visible, i.e. the default unsearched view) the pool grows to fit
    // the pasted block instead of refusing (#11). The grown rows start as
    // ghosts appended at the very end — same place the paste targets — and
    // commitCells materializes every row actually written into a plain new row,
    // exactly like Add-row produces (per the #11 comment below, they carry no
    // parent/child structure of their own).
    const canGrow = ghostEnabled && !searchQuery && !filterActive
    const baseLen = displayRowsRef.current.length
    let extraRows: BaseRow[] = []
    const rowAt = (i: number): BaseRow | undefined =>
      i < baseLen ? displayRowsRef.current[i] : extraRows[i - baseLen]
    if (hasHeaders) {
      if (canGrow) extraRows = makeGhostRows(pasteGrowCount(baseLen, startRi, dataRows.length), makeBlankRow)
      dataRows.forEach((pasteRow, riOffset) => {
        const dr = rowAt(startRi + riOffset); if (!dr) return
        pasteRow.forEach((val, pi) => { const ci = headerMap.get(pi); if (ci !== undefined) { const col = allColumnsRef.current[ci]; if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: val }) } })
      })
    } else {
      // #28 — tile a smaller copied block (or a single cell) across a larger
      // selection when it divides evenly; otherwise paste the block as-is.
      const block = dataRows
      const dataH = block.length, dataW = Math.max(...block.map((r) => r.length))
      tgtH = dataH; tgtW = dataW
      if (normSel) {
        const selH = normSel.rMax - normSel.rMin + 1, selW = normSel.cMax - normSel.cMin + 1
        if (selH >= dataH && selW >= dataW && selH % dataH === 0 && selW % dataW === 0) { tgtH = selH; tgtW = selW }
      }
      if (canGrow) extraRows = makeGhostRows(pasteGrowCount(baseLen, startRi, tgtH), makeBlankRow)
      for (let ro = 0; ro < tgtH; ro++) {
        const dr = rowAt(startRi + ro); if (!dr) continue
        const srcRow = block[ro % dataH]
        for (let co = 0; co < tgtW; co++) {
          const col = allColumnsRef.current[startCi + co]
          if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: srcRow[co % dataW] ?? '' })
        }
      }
    }
    commitCells(changes, extraRows)
    // #11 — without the ghost canvas, rows past the end can't be written
    // (parent/child structure makes silent auto-append unsafe); warn instead
    // of dropping them silently. With auto-grow, grownLen covers the block.
    const grownLen = baseLen + extraRows.length
    const overflow = (startRi + tgtH) - grownLen
    if (overflow > 0) {
      toast({ title: `${overflow} pasted row${overflow > 1 ? 's' : ''} didn't fit`, description: 'Add more rows first, then paste again to include them.', tone: 'warning' })
    }
    const lastR = Math.min(tgtH - 1, grownLen - 1 - startRi)
    const lastC = hasHeaders ? Math.max(0, ...headerMap.values()) : startCi + tgtW - 1
    setSelEnd({ ri: startRi + lastR, ci: Math.min(lastC, allColumnsRef.current.length - 1) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selAnchor, normSel, commitCells, smartPasteEnabled, toast, ghostEnabled, searchQuery, filterActive, makeBlankRow])

  const handleFillDown = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    // #27 — Ctrl+D on a single cell pulls the value from the row directly above.
    const srcRi = rMin === rMax ? rMin - 1 : rMin
    const startRi = rMin === rMax ? rMin : rMin + 1
    const srcRow = displayRowsRef.current[srcRi]; if (!srcRow) return
    const changes: CellChange[] = []
    for (let ri = startRi; ri <= rMax; ri++) {
      const dr = displayRowsRef.current[ri]; if (!dr) continue
      for (let ci = cMin; ci <= cMax; ci++) {
        const col = allColumnsRef.current[ci]
        if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: srcRow[col.id] })
      }
    }
    commitCells(changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normSel, commitCells])

  // #27 — Ctrl+R fills the selection's leftmost column value(s) rightward.
  const handleFillRight = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    const srcCi = cMin === cMax ? cMin - 1 : cMin
    const startCi = cMin === cMax ? cMin : cMin + 1
    const srcCol = allColumnsRef.current[srcCi]; if (!srcCol) return
    const changes: CellChange[] = []
    for (let ri = rMin; ri <= rMax; ri++) {
      const dr = displayRowsRef.current[ri]; if (!dr) continue
      for (let ci = startCi; ci <= cMax; ci++) {
        const col = allColumnsRef.current[ci]
        if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: dr[srcCol.id] })
      }
    }
    commitCells(changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normSel, commitCells])

  // #27 — double-clicking the fill handle fills the selection's columns down to
  // the last row (Excel's fill-to-bottom).
  const fillToBottom = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    // UFX P2d — fill down to the last REAL row (GX.6 parity): the trailing
    // ghost canvas is not a fill-to-bottom target. Without ghosts this is
    // simply the last row, as before.
    const dr = displayRowsRef.current
    let lastRi = -1
    for (let i = dr.length - 1; i >= 0; i--) { if (!dr[i]?._ghost) { lastRi = i; break } }
    if (lastRi <= rMax) return
    const selH = rMax - rMin + 1
    const changes: CellChange[] = []
    for (let ri = rMax + 1; ri <= lastRi; ri++) {
      const dr = displayRowsRef.current[ri]; if (!dr) continue
      const srcDr = displayRowsRef.current[rMin + ((ri - rMin) % selH)]; if (!srcDr) continue
      for (let ci = cMin; ci <= cMax; ci++) {
        const col = allColumnsRef.current[ci]
        if (isWritableCol(col)) changes.push({ rowId: dr._rowId, colId: col.id, value: srcDr[col.id] })
      }
    }
    commitCells(changes)
    setSelEnd({ ri: lastRi, ci: cMax })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normSel, commitCells])

  const handleSelectAll = useCallback(() => {
    const rMax = displayRowsRef.current.length - 1
    const cMax = allColumnsRef.current.length - 1
    if (rMax < 0 || cMax < 0) return
    setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: rMax, ci: cMax })
    // #82 — keep an active cell (seed A1 if none) so the grid stays keyboard-live
    // after select-all instead of going dead.
    if (!selAnchorRef.current) { const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]; if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id }) }
    selAnchorRef.current = { ri: 0, ci: 0 }
  }, [])

  const executeFill = useCallback(() => {
    // Guard against the double pointer-up: both the container onPointerUp and the
    // cell's onPointerUp fire executeFill; only the first (which flips the ref)
    // should run, so we don't push two undo snapshots for one fill.
    if (!isFillDraggingRef.current) return
    isFillDraggingRef.current = false
    if (!normSel || !fillTarget) { setIsFillDragging(false); setFillDragEnd(null); return }
    const { rMin, rMax, cMin, cMax } = normSel
    const selH = rMax - rMin + 1; const selW = cMax - cMin + 1
    const changes: CellChange[] = []
    for (let ri = fillTarget.rMin; ri <= fillTarget.rMax; ri++) {
      const srcRi = rMin + ((ri - fillTarget.rMin) % selH)
      const dr = displayRowsRef.current[ri]; if (!dr) continue
      const srcDr = displayRowsRef.current[srcRi]; if (!srcDr) continue
      for (let ci = fillTarget.cMin; ci <= fillTarget.cMax; ci++) {
        const srcCi = cMin + ((ci - fillTarget.cMin) % selW)
        const col = allColumnsRef.current[ci]; const srcCol = allColumnsRef.current[srcCi]
        if (isWritableCol(col) && srcCol) changes.push({ rowId: dr._rowId, colId: col.id, value: srcDr[srcCol.id] })
      }
    }
    commitCells(changes)
    // #72 — highlight the UNION of the source and filled range (so fill-up
    // extends the selection upward, not only downward).
    setSelAnchor({ ri: Math.min(normSel.rMin, fillTarget.rMin), ci: Math.min(normSel.cMin, fillTarget.cMin) })
    setSelEnd({ ri: Math.max(normSel.rMax, fillTarget.rMax), ci: Math.max(normSel.cMax, fillTarget.cMax) })
    setIsFillDragging(false); setFillDragEnd(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normSel, fillTarget, commitCells])

  // ── Row checkbox selection (with shift-click range select) ───────────────
  // Toggling a checkbox sets the anchor. Shift-clicking another checkbox applies
  // the clicked box's new checked state to every row between the anchor and it
  // (inclusive), in displayed order — matching Gmail/Airtable range-select.
  const toggleRowSelection = useCallback((ri: number, rowId: string, checked: boolean, shiftKey: boolean) => {
    // Snapshot the anchor BEFORE it's overwritten below. setSelectedRows defers
    // its updater to React's render phase, so reading lastCheckedRef.current
    // inside the updater would see the just-assigned `ri` (line at end) and the
    // range guard would always be false — the reason shift-range never worked.
    const anchor = lastCheckedRef.current
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor !== null && anchor !== ri) {
        const lo = Math.min(anchor, ri)
        const hi = Math.max(anchor, ri)
        const rows = displayRowsRef.current
        for (let i = lo; i <= hi; i++) {
          const r = rows[i]
          if (!r) continue
          if (checked) next.add(r._rowId); else next.delete(r._rowId)
        }
      } else if (checked) {
        next.add(rowId)
      } else {
        next.delete(rowId)
      }
      return next
    })
    lastCheckedRef.current = ri
  }, [])

  // P4 — open the Create-Group popover for the current selection (checkbox Set ∪
  // range), collecting item_sku values. No-ops if nothing resolvable.
  const groupFromSelection = useCallback(() => {
    const ids = new Set<string>(selectedRows)
    if (normSel) for (const r of displayRowsRef.current.slice(normSel.rMin, normSel.rMax + 1)) if (r) ids.add(r._rowId)
    const skus: string[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      if (!ids.has(r._rowId)) continue
      const sku = skuOf(r)
      if (sku && !seen.has(sku)) { seen.add(sku); skus.push(sku) }
    }
    if (skus.length) setGroupCreate({ skus })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, normSel, rows, skuOf])

  // ── Pointer handlers ───────────────────────────────────────────────────

  const handleCellPointerDown = useCallback((ri: number, ci: number, shiftKey: boolean) => {
    if (shiftKey && selAnchorRef.current) {
      setSelEnd({ ri, ci }); setIsEditing(false); setActiveCell(null)
    } else {
      // Update ref immediately so onPointerMove sees it before React re-renders
      selAnchorRef.current = { ri, ci }
      entryColRef.current = null  // #35 — a mouse click resets the Tab-entry column
      setSelAnchor({ ri, ci }); setSelEnd({ ri, ci }); setIsEditing(false); setEditInitialChar(null)
      const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
      if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
    }
  }, [])

  const handleCellDoubleClick = useCallback((ri: number, ci: number) => {
    const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
    if (row && col && getCellReadOnlyRef.current?.(col, row)) return  // UFX P2b — locked cell: no edit entry
    if (row && col && onBeforeEditCellRef.current?.(col, row)) return
    setSelAnchor({ ri, ci }); setSelEnd({ ri, ci }); setIsEditing(true); setEditInitialChar(null)
    if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
  }, [])

  // #35 / UFX P2a — 4th param mirrors the Amazon grid: Tab/Enter pass
  // keepEntryAnchor=true so the row-entry column survives them; every other
  // navigation resets it here (instead of ad-hoc per-branch resets).
  const moveSelection = useCallback((dCol: number, dRow: number, extend = false, keepEntryAnchor = false) => {
    if (!keepEntryAnchor) entryColRef.current = null
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
    isFillDraggingRef.current = true          // synchronous — first onPointerMove reads this
    setIsFillDragging(true); setFillDragEnd({ ri, ci })
  }, [])

  const handleFillDrop = useCallback(() => { if (isFillDraggingRef.current) executeFill() }, [executeFill])

  // ── Keyboard handler ───────────────────────────────────────────────────

  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      // #76 / UFX P7 — IME composition in progress (or the keystroke that
      // starts one): the grid must not type-to-edit, navigate or commit, and
      // must not preventDefault (that would break the composition).
      if (isComposingKeyEvent(e)) return

      // #2 — when focus is in a NON-grid form field (toolbar Search, Find &
      // Replace, a filter box, a dropdown search), let that field own every key.
      // Otherwise Backspace/Delete wiped the selected grid cells, Ctrl+A/C/V
      // hijacked the grid, and a letter flipped a grid cell into edit mode.
      // The grid's OWN cell editor has isEditingRef.current === true and is
      // handled by the dedicated isEditing branch below, so it's exempt here.
      const tgt = e.target as HTMLElement | null
      const inField = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)
      if (inField && !isEditingRef.current) return

      // UFX P3 — any key closes the consumer context menu (Amazon parity).
      setCtxMenu((p) => (p ? null : p))
      // UFX P7 (item 7) — and the column header menu.
      setColMenu((p) => (p ? null : p))

      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && e.key === 'z' &&  e.shiftKey) { e.preventDefault(); redo(); return }
      if (mod && e.key === 'y')                { e.preventDefault(); redo(); return }
      if (mod && e.key === 'f') { e.preventDefault(); setShowFindReplace(true); return }
      if (mod && e.key === 'g') { e.preventDefault(); onColumnsClick?.(); return }
      // PE: '?' opens the shortcuts modal (no modifier — skip when typing in an
      // input or when a grid cell is selected so #64 '?' can be typed into it)
      if (e.key === '?' && !mod && !isEditingRef.current && !selAnchorRef.current) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault()
          setShortcutsOpen(true)
          return
        }
      }

      if (isEditingRef.current) {
        if (e.key === 'Escape') { e.preventDefault(); setIsEditing(false); setEditInitialChar(null) }
        return
      }

      if (mod && e.key === 'a') { e.preventDefault(); handleSelectAll(); return }

      // #4 — wake at A1: with no active selection (fresh load, or after
      // Escape/delete) the first arrow/Tab/Enter/typing bootstraps a selection
      // at the top-left instead of doing nothing until a mouse click.
      if (!selAnchorRef.current) {
        const isNav = !mod && (e.key.startsWith('Arrow') || e.key === 'Tab' || e.key === 'Enter')
        const isPrintable = !mod && e.key.length === 1
        if (!isNav && !isPrintable) return
        const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]
        if (!row || !col) return
        selAnchorRef.current = { ri: 0, ci: 0 }
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 }); setActiveCell({ rowId: row._rowId, colId: col.id })
        if (isNav) { e.preventDefault(); return }  // land on A1; next key navigates. Printable falls through to edit A1.
      }
      if (!selAnchorRef.current) return

      if (mod && e.key === 'c') { e.preventDefault(); handleCopy(); setClipboardRange(normSel); return }
      if (mod && e.key === 'x') { e.preventDefault(); handleCut(); setClipboardRange(normSel); return }
      if (mod && e.key === 'v') { e.preventDefault(); void handlePaste(); setClipboardRange(null); return }
      if (mod && e.key === 'd') { e.preventDefault(); handleFillDown(); return }
      // #27 fill-right — only for a real multi-column selection, so a lone
      // selected cell doesn't steal the browser's Ctrl/Cmd+R reload.
      if (mod && e.key === 'r' && normSel && normSel.cMax > normSel.cMin) { e.preventDefault(); handleFillRight(); return }

      if (mod && e.key === 'Home') {
        e.preventDefault()
        entryColRef.current = null
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 })
        const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]
        if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
        requestAnimationFrame(() => document.querySelector('[data-ri="0"][data-ci="0"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }
      if (mod && e.key === 'End') {
        e.preventDefault()
        entryColRef.current = null
        const ri = displayRowsRef.current.length - 1; const ci = allColumnsRef.current.length - 1
        setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
        const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
        if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
        requestAnimationFrame(() => document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }

      // #34 — Cmd/Ctrl+Shift+Arrow EXTENDS the selection to the data edge (a big
      // delta clamps to the edge in moveSelection). Must precede the plain
      // mod-jump branches, which have no shiftKey check and would collapse it.
      if (mod && e.shiftKey && e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  displayRowsRef.current.length, true); return }
      if (mod && e.shiftKey && e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -displayRowsRef.current.length, true); return }
      if (mod && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); moveSelection(allColumnsRef.current.length, 0, true); return }
      if (mod && e.shiftKey && e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-allColumnsRef.current.length, 0, true); return }

      if (mod && e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  displayRowsRef.current.length - 1 - (selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -(selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowRight') { e.preventDefault(); moveSelection(allColumnsRef.current.length - 1 - (selAnchorRef.current?.ci ?? 0), 0); return }
      if (mod && e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-(selAnchorRef.current?.ci ?? 0), 0); return }

      // #37 — Alt+Down opens the dropdown on an active enum/boolean cell.
      if (e.altKey && e.key === 'ArrowDown') {
        const a = selAnchorRef.current
        const col = a ? allColumnsRef.current[a.ci] : null
        const row = a ? displayRowsRef.current[a.ri] : null
        if (col && row && getCellReadOnlyRef.current?.(col, row)) return  // UFX P2b
        if (col && (col.kind === 'enum' || col.kind === 'boolean')) { e.preventDefault(); setIsEditing(true); setEditInitialChar(null) }
        return
      }

      if (!e.shiftKey && !mod && !e.altKey) {
        const a = selAnchorRef.current
        const maxCi = allColumnsRef.current.length - 1
        // #35/#36/UFX P2a — Tab advances (wrapping to the next row at the last
        // column) and records the entry column; Enter returns to that column and
        // drops down. Both pass keepEntryAnchor so moveSelection preserves it;
        // every other navigation resets it inside moveSelection.
        if (e.key === 'Tab') {
          e.preventDefault()
          if (a && entryColRef.current === null) entryColRef.current = a.ci
          if (a && a.ci >= maxCi) moveSelection(-maxCi, 1, false, true); else moveSelection(1, 0, false, true)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          if (a && entryColRef.current !== null) moveSelection(entryColRef.current - a.ci, 1, false, true)
          else moveSelection(0, 1, false, true)
          return
        }
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  1); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1,  0); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0); return }
        // #37 — plain Home/End jump to the first/last column of the row; PageUp/
        // Down move by roughly a screen of rows.
        if (e.key === 'Home') { e.preventDefault(); moveSelection(-maxCi, 0); return }
        if (e.key === 'End')  { e.preventDefault(); moveSelection(maxCi, 0); return }
        if (e.key === 'PageDown') { e.preventDefault(); moveSelection(0,  20); return }
        if (e.key === 'PageUp')   { e.preventDefault(); moveSelection(0, -20); return }
      }
      if (e.shiftKey && !mod) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0,  1, true); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1, true); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1,  0, true); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0, true); return }
        // #36 — Shift+Tab moves back one cell, wrapping up at the first column
        // (was a non-standard extend-left).
        if (e.key === 'Tab') {
          e.preventDefault()
          const a = selAnchorRef.current
          const maxCi = allColumnsRef.current.length - 1
          if (a && a.ci <= 0) moveSelection(maxCi, -1); else moveSelection(-1, 0)
          return
        }
        if (e.key === 'Enter')      { e.preventDefault(); moveSelection(0, -1, true); return }
      }

      if (e.key === 'F2') {
        e.preventDefault()
        const anchor = selAnchorRef.current
        if (anchor) {
          const row = displayRowsRef.current[anchor.ri]; const col = allColumnsRef.current[anchor.ci]
          if (row && col && getCellReadOnlyRef.current?.(col, row)) return  // UFX P2b
          if (row && col && onBeforeEditCellRef.current?.(col, row)) return
        }
        setIsEditing(true); setEditInitialChar(null); return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); handleDeleteCells(); return }

      // #4 — Escape collapses the range to its anchor (and clears the copy
      // marquee) but KEEPS the anchor live, so arrows/typing keep working after
      // Escape instead of the grid going keyboard-dead until a mouse click.
      if (e.key === 'Escape') {
        entryColRef.current = null  // UFX P2a — Escape also ends the row-entry run
        if (clipboardRange) { setClipboardRange(null); return }
        if (selAnchorRef.current) setSelEnd(selAnchorRef.current)
        return
      }

      if (e.key.length === 1 && !mod) {
        const anchor = selAnchorRef.current
        if (anchor) {
          const row = displayRowsRef.current[anchor.ri]; const col = allColumnsRef.current[anchor.ci]
          if (row && col && getCellReadOnlyRef.current?.(col, row)) return  // UFX P2b
          if (row && col && onBeforeEditCellRef.current?.(col, row)) return
        }
        // preventDefault so the browser doesn't ALSO type the char into the freshly-
        // focused input — the char becomes the input's defaultValue via editInitialChar.
        // Mirrors the Amazon grid fix; without this the first letter was entered twice
        // (single-click → type "T" → "TT"; double-click was fine, editInitialChar=null).
        e.preventDefault()
        setIsEditing(true); setEditInitialChar(e.key)
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [undo, redo, normSel, clipboardRange, handleCopy, handleCut, handlePaste, handleFillDown, handleFillRight, handleDeleteCells, handleSelectAll, moveSelection, onColumnsClick])

  // ── Row ops ────────────────────────────────────────────────────────────

  function reorderRow(fromId: string, toId: string, half: 'top' | 'bottom') {
    if (fromId === toId) return
    pushSnapshot()
    setSortConfig([])  // drag-drop overrides sort (same as Amazon)
    onSortConfigChange?.([])  // UFX P3 — consumers mirroring the sort see the clear
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
      const reordered = [...next.map((id) => rowMap.get(id)!).filter(Boolean), ...notDisplayed]
      // Persist row order so drag-drop survives page reload
      const ids = reordered.map((r) => r._rowId)
      try { localStorage.setItem(`${storageKey}-row-order`, JSON.stringify(ids)) } catch {}
      onRowOrderChange?.(ids)  // UFX P3 — e.g. Amazon market-sync propagation
      return reordered
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
    commitCells([{ rowId, colId, value }])  // #30 — no-op re-pick of same enum won't dirty/snapshot
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitCells])

  // A4.1 — apply AI-proposed changes as a single undoable snapshot
  const applyAiChanges = useCallback((changes: import('./FlatFileGrid.types.js').FlatFileAiChange[]) => {
    if (changes.length === 0) return
    const rows = rowsRef.current
    const byRowId = new Map(rows.map((r) => [r._rowId, r]))
    const bySku = new Map(rows.map((r) => [(r as any).sku, r]))
    const resolved: CellChange[] = []
    for (const ch of changes) {
      const row = byRowId.get(ch.rowId) ?? bySku.get(ch.sku)
      if (!row) continue
      if (!isWritableCol(allColumnsRef.current.find((c) => c.id === ch.field))) continue  // #7 — AI can't write readonly cols
      resolved.push({ rowId: row._rowId, colId: ch.field, value: ch.newValue })
    }
    commitCells(resolved)  // #9 — one snapshot + emits onCellChange per change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitCells])

  const liveUpdateCell = useCallback((rowId: string, colId: string, value: string) => {
    // UFX P2d — a typed edit committed on exit (commitInput) is the other write
    // path besides commitCells; it materializes a ghost the same way.
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, ...materializeGhostPatch(r), ...(r._ghost ? onMaterializeRowRef.current?.(r) : undefined), [colId]: value, _dirty: true } : r))
    onCellChange?.(rowId, colId, value)  // #9 — commit-on-exit (commitInput) fires side-effects for typed edits too
  }, [onCellChange])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumnsRef.current.map((c) => c.id)
    const rowIds = displayRowsRef.current.map((r) => r._rowId)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    // UFX P2a (ported from the Amazon grid GX.9) — entry-anchor for IN-EDIT
    // navigation: Tab out of an editor records the column where the entry run
    // started; Enter out of an editor drops to the NEXT ROW in that column
    // (Sheets/Excel row-entry semantics). Without this, typing + Tab + Enter
    // landed one row down in the LAST tabbed column instead of the first.
    if (dir === 'right') {
      if (entryColRef.current === null) entryColRef.current = ci
      ci = Math.min(ci + 1, colIds.length - 1)
    } else if (dir === 'left') { entryColRef.current = null; ci = Math.max(ci - 1, 0) }
    else if (dir === 'down') {
      ri = Math.min(ri + 1, rowIds.length - 1)
      if (entryColRef.current !== null) ci = Math.min(entryColRef.current, colIds.length - 1)
    } else { entryColRef.current = null; ri = Math.max(ri - 1, 0) }
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
    // UFX P2d — onSave(dirty) must never receive ghosts. A ghost is never
    // dirty by construction; the !_ghost guard makes it a hard guarantee.
    const dirty = rows.filter((r) => r._dirty && !r._ghost)
    if (!dirty.length) { toast({ title: 'Nothing to save', tone: 'info' }); return }
    setSaving(true)
    try {
      const result = await onSave(dirty)
      setRows((prev) => prev.map((r) => ({ ...r, _dirty: false })))
      setSaveFlash(true); setTimeout(() => setSaveFlash(false), 2000)
      // Only show the generic toast when there are no errors — if the caller
      // (e.g. eBay) returned createResult.errors, it owns the combined toast.
      if (!result.createResult?.errors?.length) toast.success(`Saved ${result.saved} rows`)
    } catch (err) {
      toast.error('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally { setSaving(false) }
  }

  async function loadData() {
    setLoading(true)
    try {
      const loaded = await onReload()
      // UFX P2d — with the ghost canvas on, no padToMin: the topup effect
      // re-appends the canvas below the freshly loaded rows.
      const padded = padToMin(loaded, makeBlankRow, effectiveMinRows)
      setRows(padded); setHistory([]); setFuture([])
    } catch (err) {
      toast.error('Failed to reload: ' + (err instanceof Error ? err.message : String(err)))
    } finally { setLoading(false) }
  }

  // Load on mount
  useEffect(() => { void loadData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // UFX P3 — minimal imperative API for the consumer (jump-to-cell from
  // page-level panels like the Amazon feed report). Clears search + collapse
  // state first so the target row can't be hidden, then selects + scrolls.
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      goToCell: (sku: string, field: string) => {
        setSearchQuery('')
        setCollapsedRowGroups(new Set())
        setCollapsedCustomGroups(new Set())
        const go = (): boolean => {
          const ri = displayRowsRef.current.findIndex((r) => String(r.sku ?? r.item_sku ?? '') === sku)
          const ci = allColumnsRef.current.findIndex((c) => c.id === field)
          if (ri < 0 || ci < 0) return false
          selAnchorRef.current = { ri, ci }
          setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
          const row = displayRowsRef.current[ri]
          if (row) setActiveCell({ rowId: row._rowId, colId: field })
          requestAnimationFrame(() =>
            document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'center', inline: 'center' }))
          return true
        }
        // displayRows recomputes after the state flush above — retry across frames
        requestAnimationFrame(() => { if (!go()) requestAnimationFrame(() => { go() }) })
      },
    }
    return () => { apiRef.current = null }
  }, [apiRef])

  // ── Slot contexts ──────────────────────────────────────────────────────

  const modalsCtx = useMemo<ModalsCtx>(
    () => ({ rows, setRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  )
  const toolbarFetchCtx = useMemo<ToolbarFetchCtx>(
    () => ({ rows, selectedRows, loading, setRows, setSelectedRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedRows, loading],
  )
  const toolbarImportCtx = useMemo<ToolbarImportCtx>(
    // UFX P3 — ctx.onReload now runs the GRID's own load (fetch via the
    // consumer's onReload + setRows), matching the toolbar Reload button.
    // It previously invoked the consumer callback and DISCARDED the rows, so
    // slot-triggered reloads (eBay scope toggle, market-switch draft restore)
    // never updated the mounted grid.
    () => ({ loading, rows, setRows, pushHistory: (r: BaseRow[]) => { pushSnapshot(); setRows(r) }, onReload: () => { void loadData() } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, rows],
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
      <header ref={stickyHeaderRef} className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

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
            { separator: true },
            { label: exportingWorkbook ? 'Exporting workbook…' : 'Catalog workbook (v2)', icon: <FileSpreadsheet className="w-3.5 h-3.5" />, disabled: exportingWorkbook, onClick: () => { const skuIn = [...new Set(rows.filter((r) => !r._ghost).map((r) => skuOf(r)).filter(Boolean))]; void exportCatalogWorkbook({ skuIn }) } },
            ...(fileMenuItems ?? []),
          ]} />
          <MenuDropdown label="Edit" items={[
            { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: !history.length, shortcut: '⌘Z' },
            { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: !future.length, shortcut: '⌘⇧Z' },
            { separator: true },
            { label: 'Reset column group order', onClick: () => { setGroupOrder([]); try { localStorage.removeItem(`${storageKey}-group-order`) } catch {} onGroupStateChange?.(internalClosedGroups, []) }, disabled: !groupOrder.length },
            { label: 'Show all column groups', onClick: () => { setClosedGroups(new Set()); try { localStorage.removeItem(`${storageKey}-closed-groups`) } catch {} onGroupStateChange?.(new Set(), internalGroupOrder) }, disabled: !closedGroups.size },
            // UFX P7 (item 7) — per-column layer escape hatches
            { label: hiddenCols.size > 0 ? `Show ${hiddenCols.size} hidden column${hiddenCols.size === 1 ? '' : 's'}` : 'Show hidden columns', onClick: () => setHiddenCols(new Set()), disabled: !hiddenCols.size },
            { label: 'Reset column order (within groups)', onClick: () => setColOrderByGroup({}), disabled: !Object.keys(colOrderByGroup).length },
            ...(editMenuItems?.(toolbarFetchCtx) ?? []),
          ]} />
          {/* B1 — View menu: display toggles (e.g. # column row details), channel-supplied.
              B2.1 — built-in density reset: a dragged row height persists per
              storageKey (the "eBay rows taller than Amazon" mystery was a saved
              36px here) — this puts it back to the compact default in one click. */}
          {viewMenuItems && <MenuDropdown label="View" items={[
            ...viewMenuItems(toolbarFetchCtx),
            { separator: true },
            {
              label: rowHeight === 28 ? 'Row height: compact (default)' : `Row height: reset to compact (now ${rowHeight}px)`,
              checked: rowHeight === 28,
              onClick: () => { setRowHeight(28); try { localStorage.setItem(`${storageKey}-row-height`, '28') } catch {} },
            },
          ]} />}
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />
          {titleIcon}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">{title}</span>
          <Badge variant="default">{realRows.length} rows</Badge>
          {dirtyCount > 0 && <Badge variant="warning" className="flex-shrink-0"><AlertCircle className="w-3 h-3 mr-1" />{dirtyCount} unsaved</Badge>}
          <div className="flex-1 min-w-0" />
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />
          <Button size="sm" variant="ghost" onClick={() => { if (!dirtyCount) return; if (confirm('Discard all unsaved changes?')) void loadData() }} disabled={!dirtyCount || loading} className="text-slate-500 hover:text-red-600 dark:hover:text-red-400">Discard</Button>
          <Button size="sm" variant="ghost" onClick={saveDraft} disabled={loading || saving} className={saveFlash ? 'text-emerald-600 dark:text-emerald-400' : ''}>
            {saving ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Saving…</> : saveFlash ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Saved</> : 'Save'}
          </Button>
          {renderPushExtras?.({ rows, selectedRows, dirtyCount, loading, saving })}
          {/* PE: keyboard shortcuts modal trigger */}
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 flex-shrink-0"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="w-3 h-3" />
          </button>
        </div>

        {/* Bar 2: icon toolbar — shared with Amazon via FlatFileIconToolbar */}
        <FlatFileIconToolbar
          canUndo={history.length > 0}
          canRedo={future.length > 0}
          onUndo={undo}
          onRedo={redo}

          onCopy={() => { handleCopy(); setClipboardRange(normSel) }}
          copyDisabled={!normSel}

          onReplicate={onReplicate ? () => setReplicateOpen(true) : undefined}
          replicateDisabled={!rows.length}
          replicateActive={replicateOpen}

          validationErrorCount={errorCount}
          validationWarnCount={warnCount}
          validationActive={showValidation}
          onValidationClick={() => setShowValidation((o) => !o)}

          smartPasteEnabled={smartPasteEnabled}
          onSmartPasteToggle={() => setSmartPasteEnabled((o) => !o)}

          showRowImages={showRowImages}
          rowImageSize={imageSize as SharedRowImageSize}
          rowImagesDisabled={!rows.length}
          onRowImagesToggle={() => setShowRowImages((o) => !o)}
          onRowImageSizeChange={(s) => setImageSize(s)}

          sortLevelCount={sortConfig.length}
          sortPanelOpen={sortPanelOpen}
          onSortClick={() => setSortPanelOpen((o) => !o)}
          sortPanel={
            sortPanelOpen ? (
              <SortPanel
                rows={rows as Array<Record<string, unknown>>}
                groups={orderedGroups.map((g): SortGroup => ({
                  id: g.id,
                  label: g.label,
                  columns: g.columns.map((c) => ({ id: c.id, label: c.label ?? c.id })),
                }))}
                initial={sortConfig}
                onApply={(levels) => { setSortConfig(levels); onSortConfigChange?.(levels); setSortPanelOpen(false) }}
                onClose={() => setSortPanelOpen(false)}
              />
            ) : null
          }

          findReplaceOpen={showFindReplace}
          onFindReplaceClick={() => setShowFindReplace((o) => !o)}

          conditionalEnabledCount={cfRules.filter((r) => r.enabled).length}
          conditionalOpen={showConditional}
          onConditionalClick={() => setShowConditional((o) => !o)}

          aiBulkSelectedCount={selectedRows.size}
          onAiBulkClick={() => setAiModalOpen(true)}

          aiAssistantOpen={aiPanelOpen}
          onAiAssistantClick={renderAiPanel ? () => setAiPanelOpen((o) => !o) : undefined}

          slotAfterReplicate={renderToolbarFetch?.(toolbarFetchCtx)}
          slotAfterSmartPaste={renderToolbarImport?.(toolbarImportCtx)}
          onColumnsClick={onColumnsClick}
          columnsActive={columnsActive}
          trailing={toolbarTrailing}
        />

        {/* Bar 3: search + filter + saved views + column pills */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
          {renderBar3Left?.()}
          {/* P4 — Group by: Family | Custom | None */}
          {enableCustomGroups && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-400">Group by</span>
              <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
                {(['family', ...(bucketMode ? (['bucket'] as CustomGroupMode[]) : []), 'custom', 'none'] as CustomGroupMode[]).map((m) => (
                  <button key={m} type="button" onClick={() => setGroupMode(m)}
                    className={cn('px-2 py-0.5 text-[11px]', m !== 'bucket' && 'capitalize', groupMode === m
                      ? 'bg-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700')}>
                    {m === 'bucket' ? bucketMode!.label : m}
                  </button>
                ))}
              </div>
              {groupMode === 'custom' && (
                <button type="button" onClick={() => setManageGroupsOpen(true)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400" title="Manage groups">
                  <Settings2 className="w-3 h-3" />Manage
                </button>
              )}
            </div>
          )}
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
            onApply={(state: FFViewState) => { const nextClosed = new Set(state.closedGroups); setClosedGroups(nextClosed); setFilterState(state.ffFilter); setCfRules(state.cfRules); onGroupStateChange?.(nextClosed, internalGroupOrder) }} />
          <div className="flex items-center gap-1 flex-wrap">
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
                    onGroupStateChange?.(internalClosedGroups, next)
                    setDraggingGroupId(null)
                  }}
                  onClick={() => setClosedGroups((prev) => {
                    if (open && orderedGroups.filter((x) => !prev.has(x.id)).length <= 1) return prev
                    const n = new Set(prev); open ? n.add(g.id) : n.delete(g.id)
                    try { localStorage.setItem(`${storageKey}-closed-groups`, JSON.stringify([...n])) } catch {}
                    onGroupStateChange?.(n, internalGroupOrder)
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
              <button type="button" onClick={() => { setGroupOrder([]); setClosedGroups(new Set()); try { localStorage.removeItem(`${storageKey}-group-order`); localStorage.removeItem(`${storageKey}-closed-groups`) } catch {} onGroupStateChange?.(new Set(), []) }}
                className="text-xs text-slate-400 hover:text-slate-600 px-1" title="Reset group order and visibility">↺</button>
            )}
          </div>
        </div>
      </header>

      {renderFeedBanner?.()}

      {/* PE: keyboard shortcuts modal */}
      {shortcutsOpen && (
        <KeyboardShortcutsModal
          groups={FLAT_FILE_SHORTCUTS}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

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

      {/* P4 — custom groups: create popover + manage modal */}
      {groupCreate && (
        <GroupCreatePopover
          skuCount={groupCreate.skus.length}
          defaultColor={GROUP_PALETTE[customGroups.length % GROUP_PALETTE.length]}
          onCancel={() => setGroupCreate(null)}
          onCreate={(name, color) => {
            const id = makeGroupId(customGroups)
            const order = customGroups.reduce((m, g) => Math.max(m, g.order), -1) + 1
            const withNew: CustomGroup[] = [...customGroups, { id, name, color, order, memberSkus: [] }]
            setCustomGroups(assignSkusToGroup(withNew, id, groupCreate.skus))
            setGroupMode('custom')
            setGroupCreate(null)
            setSelectedRows(new Set())
          }} />
      )}
      {enableCustomGroups && (
        <ManageGroupsModal open={manageGroupsOpen} groups={customGroups}
          onChange={setCustomGroups} onClose={() => setManageGroupsOpen(false)} />
      )}

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
            onReplaceCell={(rowId, columnId, newValue, batch) => {
              if (!isWritableCol(allColumnsRef.current.find((c) => c.id === columnId))) return
              const change: CellChange = { rowId, colId: columnId, value: newValue }
              // #12 — during Replace All the bar collects a batch; accumulate and
              // apply it in ONE commitCells (one snapshot) instead of N per cell.
              if (batch) { batch.push(change); return }
              commitCells([change])
            }}
            onCommitReplaceBatch={(batch) => commitCells(batch as CellChange[])} />
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
            // #40 — click a validation row to jump to (and select) the offending cell.
            <button key={i} type="button"
              onClick={() => {
                const ri = displayRows.findIndex((r) => String(r.sku ?? r.item_sku ?? '') === String(issue.sku))
                const ci = allColumns.findIndex((c) => c.id === issue.field)
                if (ri < 0 || ci < 0) return
                const row = displayRows[ri]
                selAnchorRef.current = { ri, ci }
                setSelAnchor({ ri, ci }); setSelEnd({ ri, ci }); setActiveCell({ rowId: row._rowId, colId: issue.field })
                requestAnimationFrame(() => document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
              }}
              className={cn('w-full flex items-center gap-2 text-xs py-0.5 text-left rounded hover:bg-slate-100 dark:hover:bg-slate-800', issue.level === 'error' ? 'text-red-600' : 'text-amber-600')}>
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="font-mono">{issue.sku}</span>
              <span className="text-slate-400">·</span>
              <span className="font-medium">{issue.field}</span>
              <span className="text-slate-400">·</span>
              <span>{issue.msg}</span>
            </button>
          ))}
        </div>
      )}

      {renderModals?.(modalsCtx)}

      {/* UFX P3 — consumer context menu (fresh ops each render, so a menu
          click never acts on a stale selection). */}
      {ctxMenu && renderContextMenu && renderContextMenu({
        x: ctxMenu.x,
        y: ctxMenu.y,
        close: () => setCtxMenu(null),
        hasSelection: !!normSel,
        selRowCount: Math.max(selectedRows.size, normSel ? normSel.rMax - normSel.rMin + 1 : 0),
        selectionRows: normSel ? displayRows.slice(normSel.rMin, normSel.rMax + 1).filter((r) => !r._ghost) : [],
        anchorRow: selAnchor ? displayRows[selAnchor.ri] ?? null : null,
        ops: {
          cut: () => { handleCut(); setClipboardRange(normSel) },
          copy: () => { handleCopy(); setClipboardRange(normSel) },
          paste: () => { void handlePaste(); setClipboardRange(null) },
          clearCells: handleDeleteCells,
          groupFromSelection,
        },
      })}

      {/* UFX P7 (item 7) — column header menu (hide / move within group) */}
      {colMenu && (() => {
        const group = colToGroup.get(colMenu.colId)
        const groupColumnIds = group ? group.columns.map((c) => c.id) : []
        const moveOpts = (dir: -1 | 1) => ({
          groupColumnIds,
          savedOrder: group ? colOrderByGroup[group.id] : undefined,
          hidden: hiddenCols,
          colId: colMenu.colId,
          dir,
        })
        const applyMove = (dir: -1 | 1) => {
          if (!group) return
          const next = moveColumnInGroup(moveOpts(dir))
          if (next) setColOrderByGroup((prev) => ({ ...prev, [group.id]: next }))
        }
        return (
          <FlatFileContextMenu
            x={colMenu.x}
            y={colMenu.y}
            onClose={() => setColMenu(null)}
            items={[
              { label: 'Hide column', disabled: allColumns.length <= 1,
                onClick: () => setHiddenCols((prev) => new Set([...prev, colMenu.colId])) },
              { separator: true },
              { label: 'Move left', disabled: !group || !canMoveColumn(moveOpts(-1)), onClick: () => applyMove(-1) },
              { label: 'Move right', disabled: !group || !canMoveColumn(moveOpts(1)), onClick: () => applyMove(1) },
              { separator: true },
              { label: hiddenCols.size > 0 ? `Show ${hiddenCols.size} hidden column${hiddenCols.size === 1 ? '' : 's'}` : 'Show hidden columns',
                disabled: hiddenCols.size === 0, onClick: () => setHiddenCols(new Set()) },
              { label: `Reset ${group?.label ?? 'group'} column order`,
                disabled: !group || !(colOrderByGroup[group.id]?.length),
                onClick: () => { if (group) setColOrderByGroup((prev) => { const n = { ...prev }; delete n[group.id]; return n }) } },
            ]}
          />
        )
      })()}

      {/* ── Main grid + optional AI panel ─────────────── */}
      <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto" ref={scrollWrapRef}
        onContextMenu={(e) => {
          // UFX P3 — consumer context menu: right-click on the row # selects
          // the whole row (unless already inside the selection); on a cell
          // outside the selection, selects that cell. Then opens the menu.
          if (!renderContextMenu) return
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
          const rowEl = el?.closest('[data-row-ri]') as HTMLElement | null
          if (rowEl) {
            e.preventDefault()
            const ri = parseInt(rowEl.dataset.rowRi ?? '', 10)
            if (isNaN(ri)) return
            const sel = selAnchorRef.current && selEndRef.current
              ? { rMin: Math.min(selAnchorRef.current.ri, selEndRef.current.ri), rMax: Math.max(selAnchorRef.current.ri, selEndRef.current.ri) }
              : null
            if (!(sel && ri >= sel.rMin && ri <= sel.rMax)) {
              const maxCi = allColumnsRef.current.length - 1
              selAnchorRef.current = { ri, ci: 0 }
              setSelAnchor({ ri, ci: 0 }); setSelEnd({ ri, ci: maxCi })
              const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[0]
              if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
            }
            setCtxMenu({ x: e.clientX, y: e.clientY })
            return
          }
          const td = el?.closest('[data-ri]') as HTMLElement | null
          if (!td) return
          e.preventDefault()
          const ri = parseInt(td.dataset.ri ?? '', 10)
          const ci = parseInt(td.dataset.ci ?? '', 10)
          if (isNaN(ri) || isNaN(ci)) return
          if (!selAnchorRef.current || !selEndRef.current) {
            selAnchorRef.current = { ri, ci }
            setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
            const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
            if (row && col) setActiveCell({ rowId: row._rowId, colId: col.id })
          }
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
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
          if (isFillDraggingRef.current) {
            setFillDragEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
          } else if (selAnchorRef.current) {
            const a = selAnchorRef.current
            // Ignore jitter that stays on the anchor cell — otherwise a still
            // single click nulls activeCell and dropdown cells won't open on click.
            if (ri === a.ri && ci === a.ci) return
            setSelEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
            setActiveCell(null)
          }
        }}
        onPointerUp={() => { rowDragRef.current = null; setArmedDragRowId(null); if (isFillDraggingRef.current) executeFill() }}>

        {loading && <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>}

        {!loading && (
          <table className="border-collapse text-sm w-max min-w-full">
            <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
              {/* Row 1: group color bands */}
              <tr>
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-9 min-w-[36px] text-center" rowSpan={2}>
                  {/* UFX P2d — select-all covers only real rows (ghost canvas excluded) */}
                  <input type="checkbox" className="w-3.5 h-3.5 accent-blue-600" aria-label="Select all rows"
                    checked={realDisplayRows.length > 0 && selectedRows.size === realDisplayRows.length}
                    ref={(el) => { if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < realDisplayRows.length }}
                    onChange={(e) => setSelectedRows(e.target.checked ? new Set(realDisplayRows.map((r) => r._rowId)) : new Set())} />
                </th>
                <th className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 text-xs text-slate-400 text-center font-normal" style={{ width: rowHeaderWidth, minWidth: rowHeaderWidth }} rowSpan={2}>#</th>
                {renderGroups.map((g) => (
                  <th key={g.id} colSpan={g.columns.length}
                    className={cn('px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap', gColor(g.color).header)}>
                    <button onClick={() => {
                      // #52 — don't let the chevrons collapse the last visible group
                      // (leaving an empty grid); the Bar-3 pill path already guards.
                      if (!closedGroups.has(g.id)) {
                        const stillOpen = columnGroups.filter((cg) => !closedGroups.has(cg.id) && cg.id !== g.id).length
                        if (stillOpen === 0) { toast({ title: 'Keep at least one column group visible', tone: 'info' }); return }
                      }
                      setClosedGroups((prev) => { const n = new Set(prev); n.has(g.id) ? n.delete(g.id) : n.add(g.id); onGroupStateChange?.(n, internalGroupOrder); return n })
                    }} className="flex items-center gap-1">
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
                      }}
                      // UFX P7 (item 7) — right-click a column header opens its menu
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setColMenu({ colId: col.id, x: e.clientX, y: e.clientY }) }}>
                      {col.label}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                      {col.maxLength != null && <span className="ml-1 font-normal font-mono text-[10px] text-slate-300 dark:text-slate-600">max {col.maxLength}</span>}
                      {/* Column menu (hide / reorder) — UFX P7 item 7 */}
                      <button type="button"
                        className={cn('ml-0.5 p-0.5 rounded-sm opacity-0 group-hover/th:opacity-100 transition-opacity flex-shrink-0',
                          colMenu?.colId === col.id ? 'text-blue-500 opacity-100' : 'text-slate-400 hover:text-blue-500')}
                        title="Column options (hide · move)"
                        aria-label={`Column options for ${col.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setColMenu((p) => (p?.colId === col.id ? null : { colId: col.id, x: r.left, y: r.bottom + 2 }))
                        }}>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {/* Freeze pin */}
                      <button type="button"
                        className={cn('ml-1 p-0.5 rounded-sm opacity-0 group-hover/th:opacity-100 transition-opacity flex-shrink-0',
                          isSticky ? 'text-blue-500 opacity-100' : 'text-slate-400 hover:text-blue-500')}
                        title={isSticky ? 'Unfreeze' : 'Freeze up to here'}
                        onClick={(e) => { e.stopPropagation(); setFrozenColCount(colIdx < frozenColCount ? colIdx : colIdx + 1) }}>
                        <Pin className="w-3 h-3" />
                      </button>
                      {/* Resize handle — double-click auto-fits to rendered content (UFX P7 item 6) */}
                      <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/cr flex items-center justify-center z-10"
                        onMouseDown={(e) => { e.stopPropagation(); startColResize(e, col.id, w) }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          // Measure the header label + every RENDERED cell's content
                          // (rows skipped by content-visibility measure 0 and are
                          // ignored by computeAutoFitWidth). td > div covers the
                          // content wrapper in every display branch.
                          const th = (e.currentTarget as HTMLElement).closest('th')
                          const widths: number[] = [th ? th.scrollWidth : 0]
                          document.querySelectorAll<HTMLElement>(`td[data-ci="${colIdx}"] > div`)
                            .forEach((el) => widths.push(el.scrollWidth))
                          const fit = computeAutoFitWidth(widths)
                          if (fit != null) setColWidths((p) => (p[col.id] === fit ? p : { ...p, [col.id]: fit }))
                        }}>
                        <div className="w-px h-3/4 rounded-full bg-slate-300/50 group-hover/cr:bg-blue-400 dark:bg-slate-600/50 dark:group-hover/cr:bg-blue-500 transition-colors" />
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {/* UFX P2d — the empty state sits ABOVE the data rows: with the
                  ghost canvas and 0 real rows, the CTA renders WITH the blank
                  canvas below it (click the CTA or just start typing). Legacy
                  (no ghosts): displayRows is empty whenever filteredRows is, so
                  the DOM is identical to when this block sat below the loop. */}
              {filteredRows.length === 0 && !loading && (
                <tr><td colSpan={allColumns.length + 2} className="px-6 py-10 text-center">
                  {searchQuery ? (
                    <span className="text-sm text-slate-400 italic">No rows match your search.</span>
                  ) : (
                    <div className="flex flex-col items-center gap-1.5">
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No products yet</p>
                      <p className="text-xs text-slate-400 max-w-md">Add your first listing to get started — choose a parent if it has variations (sizes, colours), or a single item if it doesn’t.</p>
                      {renderEmptyAction ? <div className="mt-1">{renderEmptyAction()}</div> : null}
                    </div>
                  )}
                </td></tr>
              )}

              {(() => {
                const rendered: React.ReactNode[] = []
                const GROUP_BAND_COLORS = ['bg-blue-50/30 dark:bg-blue-950/10', 'bg-violet-50/30 dark:bg-violet-950/10', 'bg-emerald-50/30 dark:bg-emerald-950/10', 'bg-amber-50/30 dark:bg-amber-950/10', 'bg-rose-50/30 dark:bg-rose-950/10', 'bg-cyan-50/30 dark:bg-cyan-950/10']

                // Render in displayRows order (same as displayRowsRef.current) so that
                // the ri index assigned here matches the index used by pointer/keyboard
                // handlers when they do displayRowsRef.current[ri]. Iterating rowGroups
                // (insertion order) while displayRows is sorted caused a mismatch:
                // clicking ri=5 activated the sorted-position-5 row, not the visual-5 row.
                const groupBandIdx = new Map<string, number>()
                const renderedGroupHeaders = new Set<string>()
                let bandCounter = 0
                let displayIdx = 0

                const customMode = enableCustomGroups && groupMode === 'custom'
                const noneMode   = enableCustomGroups && groupMode === 'none'
                const bucketModeOn = !!bucketMode && groupMode === 'bucket'
                const bucketKeyFor = (row: BaseRow): string => {
                  if (!bucketMode) return ''
                  const k = `bk:${bucketMode.bucketFor(row, realRows)}`
                  return bucketMeta.has(k) ? k : (bucketMode.buckets[0] ? `bk:${bucketMode.buckets[0].key}` : k)
                }

                displayRows.forEach((row, rowIndex) => {
                  // UFX P2d — the trailing ghost canvas renders as plain rows
                  // OUTSIDE the family/custom-group machinery: no section
                  // headers, no collapse, no family band colour.
                  const isGhostRow = row._ghost === true
                  const groupKey   = resolvedGetGroupKey(row)
                  const groupRows  = rowGroups.get(groupKey) ?? [row]
                  // P4 — section key + collapse are mode-aware.
                  const sectionKey  = customMode ? customSectionKey(row) : bucketModeOn ? bucketKeyFor(row) : groupKey
                  const isCollapsed = isGhostRow ? false
                    : customMode || bucketModeOn ? collapsedCustomGroups.has(sectionKey)
                    : noneMode ? false
                    : collapsedRowGroups.has(groupKey)

                  if (!isGhostRow && !renderedGroupHeaders.has(sectionKey)) {
                    renderedGroupHeaders.add(sectionKey)
                    if (bucketModeOn) {
                      // UFX P3 — bucket section header (e.g. FBA / FBM)
                      const meta = bucketMeta.get(sectionKey)
                      if (meta) {
                        rendered.push(
                          <GroupHeader key={`hdr-${sectionKey}`} label={meta.name}
                            color={meta.color} count={meta.count}
                            bandClass="bg-slate-50 dark:bg-slate-800/50"
                            isExpanded={!isCollapsed} showImage={false} imageSize={imageSize}
                            colSpan={allColumns.length + 2}
                            onToggle={() => setCollapsedCustomGroups((prev) => { const n = new Set(prev); n.has(sectionKey) ? n.delete(sectionKey) : n.add(sectionKey); return n })} />
                        )
                      }
                    } else if (customMode) {
                      const meta = customGroupMeta.get(sectionKey)
                      if (meta) {
                        rendered.push(
                          <GroupHeader key={`hdr-${sectionKey}`} label={meta.name}
                            color={sectionKey === UNGROUPED ? undefined : meta.color} count={meta.count}
                            bandClass="bg-slate-50 dark:bg-slate-800/50"
                            isExpanded={!isCollapsed} showImage={false} imageSize={imageSize}
                            colSpan={allColumns.length + 2}
                            onToggle={() => setCollapsedCustomGroups((prev) => { const n = new Set(prev); n.has(sectionKey) ? n.delete(sectionKey) : n.add(sectionKey); return n })} />
                        )
                      }
                    } else if (!noneMode) {
                      if (!groupBandIdx.has(groupKey)) groupBandIdx.set(groupKey, bandCounter++)
                      if (groupRows.length > 1) {
                        const bandClass = GROUP_BAND_COLORS[groupBandIdx.get(groupKey)! % GROUP_BAND_COLORS.length]
                        rendered.push(
                          <GroupHeader key={`hdr-${groupKey}`} row={groupRows[0]} bandClass={bandClass}
                            isExpanded={!isCollapsed} showImage={showRowImages} imageSize={imageSize}
                            colSpan={allColumns.length + 2}
                            onToggle={() => setCollapsedRowGroups((prev) => { const n = new Set(prev); n.has(groupKey) ? n.delete(groupKey) : n.add(groupKey); return n })} />
                        )
                      }
                    }
                    // none mode: no section header
                  }

                  // Collapsed groups: skip rendering the anchor data row (header already rendered above)
                  if (isCollapsed) return

                  {
                    // ri is the TRUE index into displayRows / displayRowsRef.current
                    // (so cell selection, range-fill and shift-range checkbox
                    // ranges stay aligned even when a group above is collapsed and
                    // skipped in render). rowNum is a separate contiguous counter
                    // for the visible "#" so numbering has no gaps.
                    const ri         = rowIndex
                    const rowNum     = displayIdx++
                    const isRowSel   = selectedRows.has(row._rowId)
                    const isDragging = draggingRowId === row._rowId
                    const dropInd    = dropTarget?.rowId === row._rowId ? dropTarget.half : null

                    // UFX P3 — 'success' (Amazon feed result) styles like 'pushed'.
                    const pushedOk = row._status === 'pushed' || row._status === 'success'
                    const rowBg = isRowSel ? 'bg-blue-50/40 dark:bg-blue-900/10'
                      : pushedOk ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
                      : row._status === 'error'   ? 'bg-red-50/70 dark:bg-red-950/20'
                      : row._status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
                      : row._isNew  ? 'bg-sky-50/40 dark:bg-sky-950/10'
                      : row._dirty  ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
                      : (!isGhostRow && !customMode && !noneMode && !bucketModeOn && groupRows.length > 1) ? GROUP_BAND_COLORS[groupBandIdx.get(groupKey)! % GROUP_BAND_COLORS.length] : ''

                    const frozenBg = pushedOk ? 'bg-emerald-50 dark:bg-emerald-950/60'
                      : row._status === 'error'   ? 'bg-red-50 dark:bg-red-950/60'
                      : row._status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60'
                      : row._isNew  ? 'bg-sky-50 dark:bg-sky-950/40'
                      : row._dirty  ? 'bg-yellow-50 dark:bg-yellow-950/40'
                      : 'bg-white dark:bg-slate-900'

                    rendered.push(
                      <tr key={row._rowId} draggable={armedDragRowId === row._rowId}
                        onDragStart={(e) => { if (!canDragRef.current) { e.preventDefault(); return } e.dataTransfer.effectAllowed = 'move'; setDraggingRowId(row._rowId) }}
                        onDragEnd={() => { canDragRef.current = false; setArmedDragRowId(null); setDraggingRowId(null); setDropTarget(null) }}
                        onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setDropTarget((p) => { const half: 'top' | 'bottom' = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'; return p?.rowId === row._rowId && p?.half === half ? p : { rowId: row._rowId, half } }) }}
                        onDrop={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); if (draggingRowId) reorderRow(draggingRowId, row._rowId, e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom') }}
                        style={{
                          // #3 (perf) — browser skips layout/paint of off-screen rows.
                          // Every row stays in the DOM, so drag/fill/selection/
                          // scroll-into-view keep working; the intrinsic height keeps
                          // the scrollbar accurate for skipped rows.
                          contentVisibility: 'auto',
                          containIntrinsicSize: `0 ${rowHeight}px`,
                          borderTop: dropInd === 'top' ? '2px solid #3b82f6' : undefined,
                          borderBottom: dropInd === 'bottom' ? '2px solid #3b82f6' : undefined,
                        }}
                        className={cn('group/row transition-colors', rowBg, isDragging ? 'opacity-40' : 'hover:bg-white/60 dark:hover:bg-slate-800/40')}>

                        {/* Checkbox + drag handle */}
                        <td className={cn('sticky left-0 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center cursor-grab active:cursor-grabbing', frozenBg)}
                          title="Drag to reorder · click to select"
                          // FFP.11 — Amazon parity: arm the drag from the CHECKBOX too
                          // (the INPUT guard made grabbing the checkbox itself inert, so
                          // reordering felt missing). A plain click still toggles — the
                          // native drag only starts if the pointer moves while held, and
                          // a completed drag suppresses the click.
                          onMouseDown={() => { canDragRef.current = true; setArmedDragRowId(row._rowId) }} onMouseUp={() => { canDragRef.current = false; setArmedDragRowId(null) }}>
                          {pushedOk ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
                          : row._status === 'error'   ? <Tooltip label={<span className="text-xs">{String(row._feedMessage ?? 'Push error')}</span>} className="h10-ds-tooltip--light"><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></Tooltip>
                          : row._status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
                          : <input type="checkbox" className="w-3.5 h-3.5 accent-blue-600" checked={isRowSel} draggable={false}
                              aria-label={`Select row ${rowNum + 1}${row.sku ? ` (${row.sku})` : ''}`}
                              // Read shiftKey from onClick (a real MouseEvent) — onChange's
                              // nativeEvent doesn't reliably carry modifier keys, so shift-range
                              // never fired. onClick handles the toggle; onChange is a no-op to
                              // satisfy React's controlled-checkbox requirement.
                              onClick={(e) => toggleRowSelection(ri, row._rowId, !isRowSel, e.shiftKey)}
                              onChange={() => {}} />}
                        </td>

                        {/* Row # + optional image + row meta slot */}
                        <td data-row-ri={ri}
                          className={cn('sticky left-9 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-0.5 relative group/rr select-none', frozenBg)}
                          style={{ width: showRowImages ? imageSize + 12 : 40, minWidth: showRowImages ? imageSize + 12 : 40, height: rowHeight, cursor: 'ns-resize' }}
                          onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.releasePointerCapture(e.pointerId); rowDragRef.current = ri; const maxCi = allColumns.length - 1; selAnchorRef.current = { ri, ci: 0 }; setSelAnchor({ ri, ci: 0 }); setSelEnd({ ri, ci: maxCi }); setIsEditing(false); const col = allColumns[0]; if (col) setActiveCell({ rowId: row._rowId, colId: col.id }) }}>
                          <div className={cn('flex flex-col gap-0.5 w-full', showRowImages ? 'items-center' : 'items-end')} style={{ minHeight: rowHeight, justifyContent: 'center', padding: '4px 2px' }}>
                            {showRowImages && (() => {
                              // UFX P2e — thumbnail source hook (Amazon ASIN-map
                              // parity): string → image, null → resolving
                              // skeleton, undefined → default row.image_1.
                              const resolved = getRowImageUrl?.(row)
                              const imgUrl = resolved !== undefined ? resolved : (row.image_1 ? String(row.image_1) : null)
                              if (imgUrl) {
                                return (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={imgUrl} alt="" className="object-contain rounded flex-shrink-0" style={{ width: imageSize, height: imageSize }} draggable={false} />
                                )
                              }
                              if (resolved === null && getRowImageUrl) {
                                return <div className="rounded bg-slate-100 dark:bg-slate-800 animate-pulse flex-shrink-0" style={{ width: imageSize, height: imageSize }} />
                              }
                              return (
                                <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0" style={{ width: imageSize, height: imageSize }}>
                                  <ImageIcon className="text-slate-300 dark:text-slate-600" style={{ width: imageSize * 0.4, height: imageSize * 0.4 }} />
                                </div>
                              )
                            })()}
                            <span className={cn('tabular-nums leading-none', showRowImages ? 'text-[9px] text-slate-400' : 'text-xs text-slate-400')}>{rowNum + 1}</span>
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
                          // UFX P2c — explicit getCellGuidance wins; the built-in
                          // per-type applicability (applicableProductTypes vs the
                          // row's product_type) fills in when the callback is
                          // absent or returns null. Cell stays fully editable.
                          const guidanceLevel = getCellGuidanceRef.current?.(col, row) ?? typeApplicabilityGuidance(col, row)
                          const cellReadOnly  = getCellReadOnlyRef.current?.(col, row) ?? false
                          // UFX P3 — wire validation issues to the exact cell
                          const validIssue    = issueByCell.size ? issueByCell.get(`${skuOf(row)}:${col.id}`) : undefined

                          return (
                            <SpreadsheetCell key={`${row._rowId}-${col.id}`}
                              col={col} row={row} value={row[col.id]}
                              validIssue={validIssue}
                              isActive={isActive} cellBg={cellBg} width={w} cellHeight={rowHeight}
                              ri={ri} ci={ci}
                              isSelected={isInSel} selEdges={selEdges}
                              isCorner={isCorner}
                              isFillTarget={isFT} fillTargetEdges={ftEdges}
                              isEditing={isCellEdit} editInitialChar={isCellEdit ? editInitialChar : null}
                              isClipboard={isCB} clipboardEdges={cbEdges}
                              isMatch={isMatch} toneCls={toneCls}
                              stickyLeft={stickyLeft}
                              guidanceLevel={guidanceLevel}
                              cellReadOnly={cellReadOnly}
                              renderCellContent={renderCellContent}
                              onCellPointerDown={(shiftKey) => handleCellPointerDown(ri, ci, shiftKey)}
                              onCellDoubleClick={() => handleCellDoubleClick(ri, ci)}
                              onFillHandlePointerDown={() => handleFillHandlePointerDown(ri, ci)}
                              onFillToBottom={fillToBottom}
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
                  }
                })
                return rendered
              })()}

              <tr>
                <td colSpan={allColumns.length + 2} className="px-4 py-2 border-t border-dashed border-slate-200 dark:border-slate-700">
                  {renderFooterActions ? (
                    // UFX P3 — consumer-owned footer actions (e.g. Amazon's
                    // Add row/parent/variant + API-backed delete). The default
                    // buttons below are fully replaced.
                    renderFooterActions({
                      ...toolbarFetchCtx,
                      anchorRow: (selAnchor ? displayRows[selAnchor.ri] ?? null : null),
                      groupFromSelection,
                    } satisfies FooterActionsCtx)
                  ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={addRow}><Plus className="w-3.5 h-3.5 mr-1" />Add row</Button>
                    {enableCustomGroups && selectedRows.size > 0 && (
                      <Button size="sm" variant="ghost" onClick={groupFromSelection} className="ml-2"
                        title={`Create a custom group from the ${selectedRows.size} selected row(s)`}>
                        <Layers className="w-3.5 h-3.5 mr-1" />Group {selectedRows.size}…
                      </Button>
                    )}
                    {selectedRows.size > 0 && (
                      <Button size="sm" variant="ghost" onClick={deleteSelected} className="text-red-500 hover:text-red-700 ml-2">
                        <Trash2 className="w-3.5 h-3.5 mr-1" />Delete {selectedRows.size}
                      </Button>
                    )}
                  </div>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* #21 — announce the current selection to screen readers */}
      <div aria-live="polite" className="sr-only">
        {normSel ? `${normSel.rMax - normSel.rMin + 1} by ${normSel.cMax - normSel.cMin + 1} cells selected` : ''}
      </div>

      {/* Status bar */}
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 select-none flex-shrink-0">
        <span>{filteredRows.length} row{filteredRows.length !== 1 ? 's' : ''}</span>
        {normSel && (() => { const rC = normSel.rMax - normSel.rMin + 1; const cC = normSel.cMax - normSel.cMin + 1; const tot = rC * cC; return <span className="text-blue-500">{tot === 1 ? '1 cell' : `${rC} × ${cC} = ${tot} cells`} selected</span> })()}
        {/* #47 — aggregates for the selection (numeric columns show Sum/Avg/Min/Max) */}
        {selectionStats && selectionStats.nonEmpty >= 2 && (() => {
          const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
          return (
            <span className="text-slate-500 dark:text-slate-400 tabular-nums">
              Count {selectionStats.nonEmpty}
              {selectionStats.numCount >= 1 && <> · Sum {fmt(selectionStats.sum)} · Avg {fmt(selectionStats.avg)} · Min {fmt(selectionStats.min)} · Max {fmt(selectionStats.max)}</>}
            </span>
          )
        })()}
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
      </div>{/* end inner flex-col */}

      {/* AI panel — right side, 40% width */}
      {aiPanelOpen && renderAiPanel && (
        <div className="w-[40%] min-w-[360px] max-w-[560px] border-l border-slate-200 dark:border-slate-700 flex-shrink-0 overflow-y-auto bg-white dark:bg-slate-900">
          {renderAiPanel({ rows, columns: allColumns, marketplace, onApplyChanges: applyAiChanges })}
        </div>
      )}
      </div>{/* end outer flex row */}
    </div>
  )
}
