'use client'

/**
 * Pull Diff Modal — Phase 2 of in-editor Pull from Amazon.
 *
 * After a pull-preview job completes, this modal sits between the
 * pulled data and the editor's row state. The operator reviews what
 * Amazon returned, sees per-cell old → new diffs, gets flagged for
 * rows with unsaved local edits ("conflicts"), and chooses which
 * rows to apply. Field-level cherry-pick is row-level only in v1 —
 * field-level cherry-pick within a row is planned for a follow-up.
 *
 * The merge itself happens in the parent component after onApply()
 * fires, wrapped in pushSnapshot() so ⌘Z reverts the applied pull
 * as a single step.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download,
  Search, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

type PullGroupId = 'content' | 'pricing' | 'stock' | 'images' | 'variations' | 'other'

interface Row {
  _rowId: string
  _dirty?: boolean
  [key: string]: unknown
}

function pullFieldGroup(field: string): PullGroupId {
  if (field === 'item_name' || field === 'product_description' || field === 'generic_keyword' || field === 'brand' || field === 'color') return 'content'
  if (/^bullet_point(_\d+)?$/.test(field)) return 'content'
  if (field.startsWith('purchasable_offer')) return 'pricing'
  if (field.startsWith('fulfillment_availability')) return 'stock'
  if (field === 'main_product_image_locator' || /image_locator(_\d+)?$/.test(field)) return 'images'
  if (field === 'parentage_level' || field === 'parent_sku' || field === 'variation_theme') return 'variations'
  return 'other'
}

const GROUP_LABEL: Record<PullGroupId, string> = {
  content:    'Content',
  pricing:    'Pricing',
  stock:      'Stock',
  images:     'Images',
  variations: 'Variations',
  other:      'Other',
}

const GROUP_BADGE_CLASS: Record<PullGroupId, string> = {
  content:    'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  pricing:    'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  stock:      'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  images:     'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300',
  variations: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
  other:      'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

interface FieldChange {
  field: string
  label: string
  group: PullGroupId
  oldValue: string
  newValue: string
}

interface RowDiff {
  rowId: string          // existing editor row id (so the parent can match on merge)
  pulledRowId: string    // pulled row id (may differ for never-saved rows — sku is the bridge)
  sku: string
  itemName: string
  hasConflict: boolean   // current row was _dirty before pull
  changes: FieldChange[]
}

export interface PullDiffApplyResult {
  selectedRowIds: string[]            // rowIds from currentRows
  selectedSkus: string[]              // for audit
  fieldsApplied: number               // sum of changes across selected rows
  groupsApplied: PullGroupId[]        // distinct groups touched
}

export interface PullDiffModalProps {
  open: boolean
  pulledRows: Row[]
  currentRows: Row[]
  marketplace: string
  productType: string
  selectedColumns: 'all' | PullGroupId[]
  columnLabels?: Map<string, string>   // optional, from manifest
  onApply: (result: PullDiffApplyResult) => void | Promise<void>
  onClose: () => void
}

type Filter = 'all' | 'changed' | 'conflicts' | 'unchanged'

export function PullDiffModal({
  open, pulledRows, currentRows, marketplace, productType,
  selectedColumns, columnLabels, onApply, onClose,
}: PullDiffModalProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('changed')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const initialSelectionRef = useRef(false)

  // Index current rows by SKU for diff matching.
  const currentBySku = useMemo<Map<string, Row>>(() => {
    const m = new Map<string, Row>()
    for (const r of currentRows) {
      const sku = String(r.item_sku ?? '')
      if (sku) m.set(sku, r)
    }
    return m
  }, [currentRows])

  // Compute diffs once per (pulledRows, currentRows, selectedColumns).
  const diffs = useMemo<RowDiff[]>(() => {
    const isAllCols = selectedColumns === 'all'
    const groupSet = new Set(isAllCols ? [] : (selectedColumns as PullGroupId[]))
    const out: RowDiff[] = []

    for (const pulled of pulledRows) {
      const sku = String(pulled.item_sku ?? '')
      if (!sku) continue
      const current = currentBySku.get(sku)
      if (!current) continue   // pulled SKU not in editor — shouldn't happen because pull is scoped to editor SKUs

      const changes: FieldChange[] = []
      for (const [k, vRaw] of Object.entries(pulled)) {
        if (k.startsWith('_')) continue
        const group = pullFieldGroup(k)
        if (!isAllCols && !groupSet.has(group)) continue
        const newVal = vRaw == null ? '' : String(vRaw)
        const oldVal = current[k] == null ? '' : String(current[k])
        if (newVal === oldVal) continue
        changes.push({
          field: k,
          label: columnLabels?.get(k) ?? k,
          group,
          oldValue: oldVal,
          newValue: newVal,
        })
      }

      if (changes.length === 0) continue

      changes.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
      out.push({
        rowId: String(current._rowId),
        pulledRowId: String(pulled._rowId ?? sku),
        sku,
        itemName: String(pulled.item_name ?? current.item_name ?? ''),
        hasConflict: Boolean(current._dirty),
        changes,
      })
    }

    // Conflicts first, then by SKU
    out.sort((a, b) => {
      if (a.hasConflict !== b.hasConflict) return a.hasConflict ? -1 : 1
      return a.sku.localeCompare(b.sku, undefined, { numeric: true })
    })
    return out
  }, [pulledRows, currentBySku, selectedColumns, columnLabels])

  // Default selection: all non-conflicting diffs checked.
  useEffect(() => {
    if (!open) {
      initialSelectionRef.current = false
      return
    }
    if (initialSelectionRef.current) return
    initialSelectionRef.current = true
    setSelected(new Set(diffs.filter((d) => !d.hasConflict).map((d) => d.rowId)))
    setExpanded(new Set())
    setSearch('')
    setFilter('changed')
  }, [open, diffs])

  // Counts for header + filter chips
  const counts = useMemo(() => {
    const conflicts = diffs.filter((d) => d.hasConflict).length
    const changed = diffs.length
    const unchanged = pulledRows.length - changed
    return {
      total: pulledRows.length,
      changed,
      conflicts,
      unchanged: Math.max(0, unchanged),
    }
  }, [diffs, pulledRows.length])

  // Filtered list for display
  const visibleDiffs = useMemo(() => {
    let list = diffs
    if (filter === 'conflicts') list = list.filter((d) => d.hasConflict)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((d) =>
        d.sku.toLowerCase().includes(q) ||
        d.itemName.toLowerCase().includes(q),
      )
    }
    return list
  }, [diffs, filter, search])

  const selectedFieldsCount = useMemo(() => {
    let n = 0
    for (const d of diffs) if (selected.has(d.rowId)) n += d.changes.length
    return n
  }, [diffs, selected])

  function toggleRow(rowId: string) {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(rowId)) n.delete(rowId); else n.add(rowId)
      return n
    })
  }

  function toggleExpand(rowId: string) {
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(rowId)) n.delete(rowId); else n.add(rowId)
      return n
    })
  }

  function selectVisible() {
    setSelected((prev) => {
      const n = new Set(prev)
      for (const d of visibleDiffs) n.add(d.rowId)
      return n
    })
  }

  function deselectAll() {
    setSelected(new Set())
  }

  function selectNonConflicting() {
    setSelected(new Set(diffs.filter((d) => !d.hasConflict).map((d) => d.rowId)))
  }

  async function handleApply() {
    if (!selected.size) return
    setApplying(true)
    try {
      const chosen = diffs.filter((d) => selected.has(d.rowId))
      const fieldsApplied = chosen.reduce((sum, d) => sum + d.changes.length, 0)
      const groupSet = new Set<PullGroupId>()
      for (const d of chosen) for (const c of d.changes) groupSet.add(c.group)

      await onApply({
        selectedRowIds: chosen.map((d) => d.rowId),
        selectedSkus: chosen.map((d) => d.sku),
        fieldsApplied,
        groupsApplied: [...groupSet],
      })
    } finally {
      setApplying(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-12 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[920px] max-w-full max-h-[85vh] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <Download className="w-4 h-4 text-blue-600" />
              Review pull from Amazon {marketplace}
              <span className="text-xs font-normal text-slate-500">· {productType}</span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {counts.changed} row{counts.changed !== 1 ? 's' : ''} would change
              {counts.conflicts > 0 && (
                <> · <span className="text-amber-600 dark:text-amber-400">{counts.conflicts} have unsaved edits</span></>
              )}
              {counts.unchanged > 0 && <> · {counts.unchanged} already match</>}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Toolbar ───────────────────────────────────────────────── */}
        <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-shrink-0 bg-slate-50 dark:bg-slate-900/50">
          {/* Filter chips */}
          <div className="flex items-center gap-1">
            {([
              ['changed',   `Changed (${counts.changed})`],
              ['conflicts', `Conflicts (${counts.conflicts})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded border transition-colors',
                  filter === id
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Filter by SKU or title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-7 pl-7 pr-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-blue-400"
            />
          </div>

          {/* Bulk select */}
          <div className="flex items-center gap-1 ml-auto">
            <button
              type="button"
              onClick={selectNonConflicting}
              className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Select non-conflicting
            </button>
            <button
              type="button"
              onClick={selectVisible}
              className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Select visible
            </button>
            <button
              type="button"
              onClick={deselectAll}
              className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Clear
            </button>
          </div>
        </div>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {visibleDiffs.length === 0 && (
            <div className="text-center py-10 text-sm text-slate-500 dark:text-slate-400">
              {diffs.length === 0
                ? 'Nothing to change. Amazon values match the editor for the selected columns.'
                : 'No rows match the current filter or search.'}
            </div>
          )}

          {visibleDiffs.map((d) => {
            const isOpen = expanded.has(d.rowId)
            const isChecked = selected.has(d.rowId)
            return (
              <div
                key={d.rowId}
                className={cn(
                  'border rounded-lg overflow-hidden transition-colors',
                  isChecked
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-950/10'
                    : 'border-slate-200 dark:border-slate-700',
                  d.hasConflict && 'border-amber-300 dark:border-amber-700',
                )}
              >
                {/* Row header */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleRow(d.rowId)}
                    className="w-3.5 h-3.5 accent-blue-600 flex-shrink-0"
                  />

                  <button
                    type="button"
                    onClick={() => toggleExpand(d.rowId)}
                    className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                  >
                    {isOpen
                      ? <ChevronDown className="w-3.5 h-3.5" />
                      : <ChevronRight className="w-3.5 h-3.5" />}
                  </button>

                  <div className="font-mono text-xs text-slate-700 dark:text-slate-200 flex-shrink-0">
                    {d.sku}
                  </div>

                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">
                    {d.itemName || <span className="italic text-slate-400">(no title)</span>}
                  </div>

                  {d.hasConflict && (
                    <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 flex-shrink-0">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Unsaved edits
                    </span>
                  )}

                  <span className="text-[10px] text-slate-500 dark:text-slate-400 flex-shrink-0">
                    {d.changes.length} change{d.changes.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Expanded diff list */}
                {isOpen && (
                  <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200 dark:border-slate-700">
                          <th className="text-left px-3 py-1.5 font-medium">Field</th>
                          <th className="text-left px-3 py-1.5 font-medium w-2/5">Current</th>
                          <th className="text-left px-3 py-1.5 font-medium w-2/5">From Amazon</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.changes.map((c) => (
                          <tr key={c.field} className="border-b border-slate-100 dark:border-slate-800 last:border-b-0">
                            <td className="px-3 py-1.5 align-top">
                              <div className="flex items-center gap-1.5">
                                <span className={cn(
                                  'text-[9px] uppercase font-medium px-1 py-0.5 rounded',
                                  GROUP_BADGE_CLASS[c.group],
                                )}>
                                  {GROUP_LABEL[c.group]}
                                </span>
                                <span className="text-slate-700 dark:text-slate-200 break-all">{c.label}</span>
                              </div>
                            </td>
                            <td className="px-3 py-1.5 align-top text-slate-500 dark:text-slate-400 break-all">
                              {c.oldValue || <span className="italic text-slate-400">(empty)</span>}
                            </td>
                            <td className="px-3 py-1.5 align-top text-slate-800 dark:text-slate-100 break-all">
                              {c.newValue || <span className="italic text-slate-400">(empty)</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center gap-3 flex-shrink-0 bg-slate-50 dark:bg-slate-900/50">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {selected.size > 0 ? (
              <>
                <CheckCircle2 className="w-3 h-3 inline -mt-0.5 mr-1 text-emerald-600" />
                Will apply <span className="font-semibold text-slate-800 dark:text-slate-100">{selectedFieldsCount}</span> change{selectedFieldsCount !== 1 ? 's' : ''} across <span className="font-semibold text-slate-800 dark:text-slate-100">{selected.size}</span> row{selected.size !== 1 ? 's' : ''} · ⌘Z reverts after apply
              </>
            ) : (
              <>Select rows to apply.</>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={applying}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              disabled={!selected.size || applying}
              loading={applying}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Apply {selectedFieldsCount > 0 ? selectedFieldsCount : ''} change{selectedFieldsCount !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
