'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  flexRender,
  type ExpandedState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { buildColumns } from './lib/columns'
import { matchesView } from './lib/rollup'
import {
  CATALOG_VIEWS,
  HIGHLIGHT_MODES,
  type CatalogNode,
  type ViewId,
  type HighlightMode,
} from './lib/types'
import type { CellChange } from '@/app/_shared/bulk-edit/types'
import { useBulkUndoRedo } from '@/app/_shared/bulk-edit/use-bulk-undo-redo'
import { FindReplaceBar } from '@/app/_shared/bulk-edit/components/FindReplaceBar'
import { ConditionalFormatBar } from '@/app/_shared/bulk-edit/components/ConditionalFormatBar'
import PreviewChangesModal from '@/app/_shared/bulk-edit/modals/PreviewChangesModal'
import type { PastePreview } from '@/app/_shared/bulk-edit/types'
import PastePreviewModal from '@/app/_shared/bulk-edit/modals/PastePreviewModal'
import type { ConditionalRule } from '@/app/_shared/bulk-edit/conditional-format'

// Row height from the design system — 44px per WCAG / iOS HIG touch target
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 36

// ─── Highlight row class ──────────────────────────────────────────────────────

function rowHighlightClass(node: CatalogNode, mode: HighlightMode): string {
  if (mode === 'sync-errors') {
    const hasError = Object.values(node.channels).some((s) => s === 'ERROR')
    if (hasError) return 'bg-red-50/60 dark:bg-red-950/20'
  }
  if (mode === 'translation-gaps') {
    if (node.locales) {
      const hasGap = Object.values(node.locales).some((pct) => pct < 100)
      if (hasGap) return 'bg-amber-50/60 dark:bg-amber-950/20'
    }
  }
  if (mode === 'pricing-overrides') {
    const hasOverride = Object.values(node.channels).some((s) => s === 'OVERRIDE')
    if (hasOverride) return 'bg-blue-50/60 dark:bg-blue-950/20'
  }
  return ''
}

// ─── Dropdown primitives ──────────────────────────────────────────────────────

interface DropdownItem<T extends string> {
  id: T
  label: string
}

function ToolbarDropdown<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: T
  items: DropdownItem<T>[]
  onChange: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  const current = items.find((i) => i.id === value)
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:border-slate-300 hover:bg-slate-50 transition-colors dark:text-slate-300 dark:bg-slate-900 dark:border-slate-700"
      >
        <span className="text-slate-400 text-[10px] uppercase tracking-wider">{label}:</span>
        <span>{current?.label ?? value}</span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 min-w-[160px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-md py-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => { onChange(item.id); setOpen(false) }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors',
                item.id === value
                  ? 'text-blue-600 font-medium'
                  : 'text-slate-700 dark:text-slate-300',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CommandMatrixClient() {
  // ── Data ───────────────────────────────────────────────────────────
  const [data, setData] = useState<CatalogNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/command-matrix`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: CatalogNode[]) => {
        if (cancelled) return
        setData(Array.isArray(json) ? json : [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // ── View + Highlight ────────────────────────────────────────────────
  const [viewId, setViewId] = useState<ViewId>('global')
  const [highlightMode, setHighlightMode] = useState<HighlightMode>('none')

  // ── Edit buffer ─────────────────────────────────────────────────────
  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())

  const writeChange = useCallback(
    (rowId: string, columnId: string, oldValue: unknown, newValue: unknown) => {
      setChanges((prev) => {
        const next = new Map(prev)
        const key = `${rowId}:${columnId}`
        next.set(key, {
          rowId,
          columnId,
          oldValue,
          newValue,
          cascade: false,
          timestamp: Date.now(),
        })
        return next
      })
    },
    [],
  )
  // writeChange wired to editable cells in Phase 6
  void writeChange

  // ── Undo/Redo ───────────────────────────────────────────────────────
  const {
    history: _history,
    pushEntry: _pushEntry,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useBulkUndoRedo({ applyEntry: (_entry, _dir) => {} })

  // ── Save state ──────────────────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  >('idle')

  useEffect(() => {
    if (changes.size > 0) setSaveStatus('dirty')
    else setSaveStatus('idle')
  }, [changes])

  const saveChanges = useCallback(async () => {
    if (changes.size === 0) return
    setSaveStatus('saving')
    try {
      const payload = Array.from(changes.values())
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: payload }),
      })
      if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`)
      setChanges(new Map())
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2500)
    } catch (err: unknown) {
      setSaveStatus('error')
      console.error('[CommandMatrix] save failed', err)
    }
  }, [changes])

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false)
  const [cfOpen, setCfOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null)
  const [cfRules, setCfRules] = useState<ConditionalRule[]>([])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 's') {
        e.preventDefault()
        saveChanges()
      }
      if (meta && e.key === 'f') {
        e.preventDefault()
        setFindOpen((v) => !v)
      }
      if (meta && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [saveChanges, undo, redo])

  // ── View filtering ──────────────────────────────────────────────────
  const filteredData = useMemo(() => {
    if (viewId === 'global') return data
    return data.filter((node) => matchesView(node, viewId))
  }, [data, viewId])

  // ── Table ───────────────────────────────────────────────────────────
  const columns = useMemo(() => buildColumns(), [])
  const [expanded, setExpanded] = useState<ExpandedState>({})

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.subRows,
    columnResizeMode: 'onChange',
  })

  // ── Virtualization ──────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const allRows = table.getRowModel().rows

  const rowVirtualizer = useVirtualizer({
    count: loading ? 20 : allRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalHeight = rowVirtualizer.getTotalSize()

  // ── Expand all / Collapse all ────────────────────────────────────────
  const expandAll = useCallback(() => {
    const next: ExpandedState = {}
    for (const row of table.getCoreRowModel().rows) {
      if (row.subRows?.length) next[row.id] = true
    }
    setExpanded(next)
  }, [table])

  const collapseAll = useCallback(() => setExpanded({}), [])

  // ── Header columns ──────────────────────────────────────────────────
  const headerGroups = table.getHeaderGroups()
  const leafHeaders = table.getVisibleLeafColumns()
  const totalWidth = leafHeaders.reduce((s, c) => s + c.getSize(), 0)

  // ─────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-600">
        Failed to load catalog: {error}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex-none">
        <span className="text-xs font-bold text-slate-700 dark:text-slate-200 tracking-widest uppercase mr-1">
          🎛 COMMAND MATRIX
        </span>

        <ToolbarDropdown
          label="View"
          value={viewId}
          items={CATALOG_VIEWS}
          onChange={setViewId}
        />
        <ToolbarDropdown
          label="Highlight"
          value={highlightMode}
          items={HIGHLIGHT_MODES}
          onChange={setHighlightMode}
        />

        <div className="flex-1" />

        {/* Expand/Collapse */}
        <button
          onClick={expandAll}
          className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
        >
          Expand all
        </button>
        <button
          onClick={collapseAll}
          className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
        >
          Collapse all
        </button>

        {/* Find / Replace */}
        <button
          onClick={() => setFindOpen((v) => !v)}
          className={cn(
            'px-2 py-1 text-xs rounded transition-colors',
            findOpen
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
          )}
        >
          Find
        </button>

        {/* Rules */}
        <button
          onClick={() => setCfOpen((v) => !v)}
          className={cn(
            'px-2 py-1 text-xs rounded transition-colors',
            cfOpen
              ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
          )}
        >
          Rules
        </button>

        {/* Save */}
        {changes.size > 0 && (
          <button
            onClick={() => setPreviewOpen(true)}
            className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
          >
            Review {changes.size} change{changes.size !== 1 ? 's' : ''}
          </button>
        )}

        {/* Undo/Redo */}
        <button
          disabled={!canUndo}
          onClick={undo}
          className="px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 rounded disabled:opacity-30 transition-colors"
          title="Undo (Cmd+Z)"
        >
          ↩
        </button>
        <button
          disabled={!canRedo}
          onClick={redo}
          className="px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 rounded disabled:opacity-30 transition-colors"
          title="Redo (Cmd+Shift+Z)"
        >
          ↪
        </button>
      </div>

      {/* ── Find/Replace bar ─────────────────────────────────────────── */}
      {findOpen && (
        <div className="border-b border-slate-200 dark:border-slate-800 flex-none">
          <FindReplaceBar
            open={findOpen}
            onClose={() => setFindOpen(false)}
            cells={[]}
            rangeBounds={null}
            visibleColumns={leafHeaders.map((c) => ({ id: c.id, label: typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id }))}
            onActivate={() => {}}
            onMatchSetChange={() => {}}
            onReplaceCell={() => {}}
            onCommitReplaceBatch={() => {}}
          />
        </div>
      )}

      {/* ── Conditional Format bar ───────────────────────────────────── */}
      {cfOpen && (
        <div className="border-b border-slate-200 dark:border-slate-800 flex-none">
          <ConditionalFormatBar
            open={cfOpen}
            onClose={() => setCfOpen(false)}
            rules={cfRules}
            onChange={setCfRules}
            visibleColumns={leafHeaders.map((c) => ({ id: c.id, label: typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id }))}
          />
        </div>
      )}

      {/* ── Grid ─────────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto min-h-0 relative"
        style={{ contain: 'strict' }}
      >
        <div style={{ minWidth: totalWidth }}>
          {/* Sticky column headers */}
          <div
            className="sticky top-0 z-20 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700"
            style={{ minWidth: totalWidth }}
          >
            {headerGroups.map((hg) => (
              <div key={hg.id} className="flex">
                {hg.headers.map((header) => {
                  const isGroup = header.isPlaceholder || header.subHeaders.length > 0
                  return (
                    <div
                      key={header.id}
                      className={cn(
                        'border-r border-slate-200 dark:border-slate-700 last:border-r-0',
                        'flex items-center px-2',
                        isGroup
                          ? 'justify-center bg-slate-100 dark:bg-slate-800 font-bold text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400'
                          : 'text-[11px] font-semibold text-slate-600 dark:text-slate-400',
                      )}
                      style={{
                        width: header.isPlaceholder
                          ? header.getSize()
                          : header.getSize(),
                        height: HEADER_HEIGHT,
                      }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Virtual rows */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            {loading
              ? Array.from({ length: 20 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex border-b border-slate-100 dark:border-slate-800"
                    style={{
                      position: 'absolute',
                      top: i * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      width: '100%',
                    }}
                  >
                    <div className="flex-1 animate-pulse bg-slate-100 dark:bg-slate-800 mx-2 my-3 rounded" />
                  </div>
                ))
              : virtualItems.map((virtualRow) => {
                  const row = allRows[virtualRow.index]
                  if (!row) return null
                  const node = row.original
                  const highlightCls = rowHighlightClass(node, highlightMode)
                  const isVariant = !node.isMaster
                  return (
                    <div
                      key={row.id}
                      data-row-id={row.id}
                      className={cn(
                        'flex border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/80 dark:hover:bg-slate-800/50 group',
                        isVariant && 'bg-slate-50/40 dark:bg-slate-900/50',
                        highlightCls,
                      )}
                      style={{
                        position: 'absolute',
                        top: virtualRow.start,
                        height: ROW_HEIGHT,
                        width: '100%',
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <div
                          key={cell.id}
                          className="flex items-center border-r border-slate-100 dark:border-slate-800 last:border-r-0 overflow-hidden px-1.5"
                          style={{ width: cell.column.getSize(), height: ROW_HEIGHT }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      ))}
                    </div>
                  )
                })}
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex-none">
        <span className="text-[11px] text-slate-500">
          {loading
            ? 'Loading…'
            : `${filteredData.length} master${filteredData.length !== 1 ? 's' : ''}`}
        </span>
        {changes.size > 0 && (
          <span className="text-[11px] text-amber-600 font-medium">
            {changes.size} unsaved change{changes.size !== 1 ? 's' : ''} · Cmd+S to save
          </span>
        )}
        {saveStatus === 'saving' && (
          <span className="text-[11px] text-blue-600">Saving…</span>
        )}
        {saveStatus === 'saved' && (
          <span className="text-[11px] text-green-600">Saved ✓</span>
        )}
        {saveStatus === 'error' && (
          <span className="text-[11px] text-red-600">Save failed</span>
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────────────────── */}
      <PreviewChangesModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        changes={changes}
        products={filteredData as any}
      />
      <PastePreviewModal
        preview={pastePreview}
        onCancel={() => setPastePreview(null)}
        onApply={() => setPastePreview(null)}
      />
    </div>
  )
}
