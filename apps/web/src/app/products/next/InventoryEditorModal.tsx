'use client'

/**
 * The inventory editor — the modal behind the Available cell.
 *
 * One AG Grid for both cases (a family's variations, or a single product as a one-row family),
 * edited like a spreadsheet, applied as ONE audited batch: every change the operator has typed
 * sits in `pending` until Apply, with one reason and one note for the batch. The server derives
 * each delta from a fresh read and answers per change; a refused cell stays pending and marked,
 * a confirmed one clears. Nothing here writes a number the server has not confirmed.
 *
 * Cases (Step 3): a typed sealed count (one per case size) sits in `pendingCases` and travels in
 * the SAME change as that cell's on-hand, so the server writes and checks them in one transaction.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Redo2, Search, Undo2 } from 'lucide-react'

import { Modal, Combobox, Listbox, MultiSelect } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { Input, Button, Pill } from '@/design-system/primitives'
import { GridFooterSpacer, GridFooterStrip, GridPanel, type GridApi } from '@/design-system/grid'
import { useInventoryEditor, type InventoryEditorTarget } from './useInventoryEditor'
import type { DensityMode } from './density'
import { InventoryGrid, OPTIONAL_COLUMN_KINDS, OPTIONAL_COLUMN_LABELS, optionalKindsOf, type OptionalColumnKind } from './InventoryGrid'
import {
  casesFailKey, changesOf, DEFAULT_REASON, editorModeForRow, keepCasesOf, pendingCellCount, pendingKey, REASON_OPTIONS, refusedColumn, withCasesEdit, withEdit,
  type MatrixRow,
} from './inventoryEditor.logic'
import styles from './styles.module.css'

/** Which optional columns the operator has hidden; remembered per browser. */
const COLUMNS_KEY = 'products-next:inventory-editor:hidden-columns'
const readHidden = (): OptionalColumnKind[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((k): k is OptionalColumnKind => (OPTIONAL_COLUMN_KINDS as readonly string[]).includes(k)) : []
  } catch { return [] }
}

export interface InventoryEditorModalProps {
  row: InventoryEditorTarget | null
  density: DensityMode
  onClose: () => void
  /** The dialog's title; absent = the product's name (the Products page). The Matrix passes "Stock · <SKU>". */
  title?: string
  /** The line under the title; absent = SKU · variations · locations. The Matrix passes the product's name. */
  subtitle?: ReactNode
}

export function InventoryEditorModal({ row, density, onClose, title, subtitle: subtitleProp }: InventoryEditorModalProps) {
  const open = row != null
  const single = row ? editorModeForRow(row) === 'list' : true
  const { loading, error, model, reload, applyBatch } = useInventoryEditor(row)

  const [pending, setPending] = useState<Map<string, number>>(new Map())
  const [pendingCases, setPendingCases] = useState<Map<string, number>>(new Map())
  const [failed, setFailed] = useState<Map<string, string>>(new Map())
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState<string>(DEFAULT_REASON)
  const [notes, setNotes] = useState('')
  const [search, setSearch] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'danger' } | null>(null)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [setLocation, setSetLocation] = useState<string>('')
  const [setValue, setSetValue] = useState('')
  const [gridApi, setGridApi] = useState<GridApi<never> | null>(null)
  const [hiddenKinds, setHiddenKinds] = useState<OptionalColumnKind[]>([])
  useEffect(() => { setHiddenKinds(readHidden()) }, [])
  const setVisibleKinds = useCallback((visible: string[]) => {
    // A kind this product does not offer (Cases without a case size) keeps the choice made elsewhere.
    const offered: readonly OptionalColumnKind[] = model ? optionalKindsOf(model) : OPTIONAL_COLUMN_KINDS
    const hidden = OPTIONAL_COLUMN_KINDS.filter((k) => (offered.includes(k) ? !visible.includes(k) : hiddenKinds.includes(k)))
    setHiddenKinds(hidden)
    try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(hidden)) } catch { /* the choice just won't survive a reload */ }
  }, [model, hiddenKinds])

  // A fresh product is a fresh session: nothing pending carries over.
  useEffect(() => {
    setPending(new Map()); setPendingCases(new Map()); setFailed(new Map()); setSelected([]); setReason(DEFAULT_REASON); setNotes('')
    setSearch(''); setConfirmDiscard(false); setMessage(null); setHistory({ undo: 0, redo: 0 }); setSetValue('')
  }, [row?.id])

  const editableLocations = useMemo(() => (model?.columns ?? []).filter((c) => c.editable), [model])

  /*
   * Focus (Matrix polish, Owner 2026-10-08): the editor opens on its first FIELD — the first row's first editable On hand
   * cell, so a keyboard open can type at once — never on the ✕. The DS Modal focuses its first focusable (the ✕) on
   * open, before the grid has loaded: the box itself holds focus meanwhile (it draws no ring), then the cell takes it.
   * Only while nothing inside was chosen yet (a click in the meantime wins).
   */
  const focusedFirst = useRef(false)
  useEffect(() => {
    focusedFirst.current = false
    if (!open) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('.nds-modal-x')) active.closest<HTMLElement>('[role="dialog"]')?.focus()
  }, [open, row?.id])
  useEffect(() => {
    if (!gridApi || !model || focusedFirst.current) return
    const first = editableLocations[0]
    const active = document.activeElement
    const untouched = active instanceof HTMLElement && (active.matches('[role="dialog"]') || active.matches('.nds-modal-x'))
    if (!first || !untouched || (model.rows.length ?? 0) === 0) return
    focusedFirst.current = true
    gridApi.setFocusedCell(0, `onhand:${first.locationId}`)
  }, [gridApi, model, editableLocations])
  useEffect(() => {
    if (!setLocation || !editableLocations.some((c) => c.locationId === setLocation)) setSetLocation(editableLocations[0]?.locationId ?? '')
  }, [editableLocations, setLocation])

  /** Every edit path — keystroke, fill, paste, undo, "Set selected" — lands here, On hand or Cases. */
  const pendingRef = useRef(pending); pendingRef.current = pending
  const onEdit = useCallback((r: MatrixRow, locationId: string, value: unknown, kind: 'onhand' | 'cases' = 'onhand', unitsPerCase?: number) => {
    if (kind === 'cases') {
      if (unitsPerCase !== undefined) setPendingCases((prev) => withCasesEdit(prev, r, locationId, unitsPerCase, value, pendingRef.current))
    } else setPending((prev) => withEdit(prev, r, locationId, value))
    // The cell's change is a new one: the last Apply's refusal of it no longer stands (a count that still
    // does not fit the units stays red from the live check).
    setFailed((prev) => {
      const keys = [pendingKey(r.productId, locationId), casesFailKey(r.productId, locationId)]
      if (!keys.some((k) => prev.has(k))) return prev
      const next = new Map(prev); for (const k of keys) next.delete(k); return next
    })
    setMessage(null)
  }, [])

  const setSelectedTo = useCallback(() => {
    if (!model || !setLocation) return
    const n = Number(setValue.trim())
    if (!Number.isInteger(n) || n < 0) return
    setPending((prev) => {
      let next: Map<string, number> = new Map(prev)
      for (const id of selected) {
        const r = model.rows.find((x) => x.productId === id)
        if (r) next = withEdit(next, r, setLocation, n)
      }
      return next
    })
    setMessage(null)
  }, [model, selected, setLocation, setValue])

  const pendingCount = pendingCellCount(pending, pendingCases)
  const apply = useCallback(async () => {
    if (!pendingCount || applying) return
    setApplying(true)
    setMessage(null)
    const changes = changesOf(pending, pendingCases)
    const res = await applyBatch({ reason, notes: notes.trim() || undefined, changes })
    setApplying(false)
    if (!res.ok) { setMessage({ text: res.error, tone: 'danger' }); return }
    // A refused change keeps its cell pending (On hand and Cases alike); the red goes on the cell it concerns.
    const refusedCells = new Set<string>()
    const refused = new Map<string, string>()
    let applied = 0
    for (const r of res.results) {
      if (r.ok) { applied += 1; continue }
      const key = pendingKey(r.productId, r.locationId)
      refusedCells.add(key)
      const change = changes.find((c) => c.productId === r.productId && c.locationId === r.locationId)
      refused.set(refusedColumn(change, r.code) === 'cases' ? casesFailKey(r.productId, r.locationId) : key, r.error ?? 'Refused')
    }
    setPending((prev) => {
      const next = new Map<string, number>()
      for (const [k, v] of prev) if (refusedCells.has(k)) next.set(k, v)
      return next
    })
    setPendingCases((prev) => keepCasesOf(prev, refusedCells))
    setFailed(refused)
    setHistory({ undo: 0, redo: 0 })
    setMessage(
      refusedCells.size
        ? { text: `${applied} applied · ${refusedCells.size} refused — hover a red cell for why`, tone: 'danger' }
        : { text: `${applied} ${applied === 1 ? 'change' : 'changes'} applied`, tone: 'success' },
    )
  }, [pending, pendingCases, pendingCount, applying, applyBatch, reason, notes])

  /** Close asks first when there is unapplied work; the DS modal routes Esc and ✕ here too. */
  const requestClose = useCallback(() => {
    if (pendingCount && !confirmDiscard) { setConfirmDiscard(true); return }
    onClose()
  }, [pendingCount, confirmDiscard, onClose])

  const rowCount = model?.rows.length ?? 0
  // A passed name (the Matrix) can be long: two lines at most, the whole name on hover.
  const subtitle = typeof subtitleProp === 'string' ? <span className={styles.ieSubtitle} title={subtitleProp}>{subtitleProp}</span>
    : subtitleProp !== undefined ? subtitleProp : row
    ? [row.sku, single ? null : `${rowCount} ${rowCount === 1 ? 'variation' : 'variations'}`, model ? `${model.columns.length} ${model.columns.length === 1 ? 'location' : 'locations'}` : null].filter(Boolean).join(' · ')
    : undefined

  /** The card's footer strip — the page's pager row, carrying the batch's reason, notes and Apply. */
  const footerStrip = (
    <GridFooterStrip>
      {confirmDiscard ? (
        <>
          <span className={styles.ieDiscard}>Discard {pendingCount} unapplied {pendingCount === 1 ? 'change' : 'changes'}?</span>
          <GridFooterSpacer />
          <Button size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
          <Button size="sm" variant="danger" onClick={onClose}>Discard</Button>
        </>
      ) : (
        <>
          <span className={styles.ieSetLabel}>Reason</span>
          <Combobox options={[...REASON_OPTIONS]} value={reason} onChange={setReason} placeholder="Select reason" className={styles.ieReason} />
          <Input fieldClassName={styles.ieNotes} placeholder="Notes (optional)" title="Stored on every movement in this batch" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Adjustment notes" />
          <GridFooterSpacer />
          {message && <span className={message.tone === 'danger' ? styles.ieMsgDanger : styles.ieMsgSuccess} role="status">{message.text}</span>}
          <Button size="sm" variant="secondary" onClick={requestClose}>{pendingCount ? 'Cancel' : 'Close'}</Button>
          <Button size="sm" variant="primary" disabled={!pendingCount || applying} onClick={() => void apply()}>
            {applying ? 'Applying…' : pendingCount ? `Apply ${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'}` : 'Apply'}
          </Button>
        </>
      )}
    </GridFooterStrip>
  )

  return (
    <Modal open={open} onClose={requestClose} size="xxl" className={styles.ieModal} title={title ?? (row ? row.name : 'Inventory')} subtitle={subtitle}>
      {loading && <div className={styles.invState}>Loading inventory…</div>}

      {!loading && error && (
        <div className={styles.invState}>
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void reload()}>Try again</Button>
        </div>
      )}

      {!loading && !error && model && (
        model.columns.length === 0 ? (
          <div className={styles.invState}>
            <p>No active locations yet.</p>
            <a href="/fulfillment/stock/locations" className={styles.invManageLink} target="_blank" rel="noopener noreferrer">Create a location →</a>
          </div>
        ) : (
          <>
            {/* The page's own grid card and toolbar: the editor is the products grid, in a modal. */}
            <GridPanel footer={footerStrip}>
              <GridToolbar
                count={
                  pendingCount
                    ? <Pill tone="warning" size="sm">{pendingCount} {pendingCount === 1 ? 'change' : 'changes'} pending</Pill>
                    : <Pill tone="neutral" size="sm">No changes</Pill>
                }
                right={
                  <>
                    <Button size="sm" variant="ghost" disabled={!history.undo} onClick={() => gridApi?.undoCellEditing()} title="Undo (⌘Z)"><Undo2 size={13} /> Undo</Button>
                    <Button size="sm" variant="ghost" disabled={!history.redo} onClick={() => gridApi?.redoCellEditing()} title="Redo (⌘⇧Z)"><Redo2 size={13} /> Redo</Button>
                    {selected.length > 0 && editableLocations.length > 0 && (
                      <span className={styles.ieSetSel}>
                        <span className={styles.ieSetLabel}>Set {selected.length} selected at</span>
                        <Listbox size="sm" width={150} options={editableLocations.map((c) => ({ value: c.locationId, label: c.locationCode }))} value={setLocation} onChange={setSetLocation} ariaLabel="Location" />
                        <span className={styles.ieSetLabel}>to</span>
                        <Input fieldClassName={styles.ieSetInput} inputMode="numeric" placeholder="0" value={setValue} onChange={(e) => setSetValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSelectedTo() }} aria-label="On hand value" />
                        <Button size="sm" onClick={setSelectedTo} disabled={setValue.trim() === ''}>Set</Button>
                      </span>
                    )}
                    <span className={styles.ieSetLabel}>Columns</span>
                    <MultiSelect
                      className={styles.ieColumns}
                      options={optionalKindsOf(model).map((k) => ({ value: k, label: OPTIONAL_COLUMN_LABELS[k] }))}
                      value={optionalKindsOf(model).filter((k) => !hiddenKinds.includes(k))}
                      onChange={setVisibleKinds}
                      placeholder="Columns"
                      ariaLabel="Columns"
                    />
                  </>
                }
              >
                {!single && (
                  <span className={styles.searchField}>
                    <Input leadingIcon={<Search size={13} style={{ color: 'var(--nds-text-3)' }} />} placeholder="Search variations…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search variations" style={{ width: '100%' }} />
                  </span>
                )}
              </GridToolbar>
              <InventoryGrid
                model={model}
                density={density}
                hiddenKinds={hiddenKinds}
                pending={pending}
                pendingCases={pendingCases}
                failed={failed}
                onEdit={onEdit}
                onSelectionChanged={setSelected}
                onReady={(api) => setGridApi(api as unknown as GridApi<never>)}
                onHistoryChanged={setHistory}
                quickFilterText={search}
                single={single}
              />
            </GridPanel>
            <p className={styles.ieHint}>Type into a cell to edit · <kbd>Enter</kbd> moves down · <kbd>Tab</kbd> moves right · <kbd>Esc</kbd> reverts · drag a cell's corner to fill · paste a column from a sheet · <kbd>⌘Z</kbd> undo</p>
          </>
        )
      )}
    </Modal>
  )
}
