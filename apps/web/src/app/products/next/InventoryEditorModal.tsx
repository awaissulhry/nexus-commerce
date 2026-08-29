'use client'

/**
 * The inventory editor — the modal behind the Available cell.
 *
 * One AG Grid for both cases (a family's variations, or a single product as a one-row family),
 * edited like a spreadsheet, applied as ONE audited batch: every change the operator has typed
 * sits in `pending` until Apply, with one reason and one note for the batch. The server derives
 * each delta from a fresh read and answers per change; a refused cell stays pending and marked,
 * a confirmed one clears. Nothing here writes a number the server has not confirmed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Redo2, Search, Undo2 } from 'lucide-react'

import { Modal, Combobox, Listbox, MultiSelect } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { Input, Button, Pill } from '@/design-system/primitives'
import { GridFooterSpacer, GridFooterStrip, GridPanel, type GridApi } from '@/design-system/grid'
import type { ProductRow } from '../_types'

import { useInventoryEditor } from './useInventoryEditor'
import type { DensityMode } from './density'
import { InventoryGrid, OPTIONAL_COLUMN_KINDS, OPTIONAL_COLUMN_LABELS, type OptionalColumnKind } from './InventoryGrid'
import { changesOf, DEFAULT_REASON, editorModeForRow, pendingKey, REASON_OPTIONS, withEdit, type MatrixRow } from './inventoryEditor.logic'
import styles from './styles.module.css'

/** Which optional columns the operator has hidden; remembered per browser. */
const COLUMNS_KEY = 'products-next:inventory-editor:hidden-columns'
const readHidden = (): OptionalColumnKind[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((k): k is OptionalColumnKind => (OPTIONAL_COLUMN_KINDS as readonly string[]).includes(k)) : []
  } catch { return [] }
}

export function InventoryEditorModal({ row, density, onClose }: { row: ProductRow | null; density: DensityMode; onClose: () => void }) {
  const open = row != null
  const single = row ? editorModeForRow(row) === 'list' : true
  const { loading, error, model, reload, applyBatch } = useInventoryEditor(row)

  const [pending, setPending] = useState<Map<string, number>>(new Map())
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
    const hidden = OPTIONAL_COLUMN_KINDS.filter((k) => !visible.includes(k))
    setHiddenKinds(hidden)
    try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(hidden)) } catch { /* the choice just won't survive a reload */ }
  }, [])

  // A fresh product is a fresh session: nothing pending carries over.
  useEffect(() => {
    setPending(new Map()); setFailed(new Map()); setSelected([]); setReason(DEFAULT_REASON); setNotes('')
    setSearch(''); setConfirmDiscard(false); setMessage(null); setHistory({ undo: 0, redo: 0 }); setSetValue('')
  }, [row?.id])

  const editableLocations = useMemo(() => (model?.columns ?? []).filter((c) => c.editable), [model])
  useEffect(() => {
    if (!setLocation || !editableLocations.some((c) => c.locationId === setLocation)) setSetLocation(editableLocations[0]?.locationId ?? '')
  }, [editableLocations, setLocation])

  /** Every edit path — keystroke, fill, paste, undo, "Set selected" — lands here. */
  const onEdit = useCallback((r: MatrixRow, locationId: string, value: unknown) => {
    setPending((prev) => withEdit(prev, r, locationId, value))
    setFailed((prev) => {
      const key = pendingKey(r.productId, locationId)
      if (!prev.has(key)) return prev
      const next = new Map(prev); next.delete(key); return next
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

  const apply = useCallback(async () => {
    if (!pending.size || applying) return
    setApplying(true)
    setMessage(null)
    const res = await applyBatch({ reason, notes: notes.trim() || undefined, changes: changesOf(pending) })
    setApplying(false)
    if (!res.ok) { setMessage({ text: res.error, tone: 'danger' }); return }
    const refused = new Map<string, string>()
    let applied = 0
    for (const r of res.results) {
      if (r.ok) applied += 1
      else refused.set(pendingKey(r.productId, r.locationId), r.error ?? 'Refused')
    }
    setPending((prev) => {
      const next = new Map<string, number>()
      for (const [k, v] of prev) if (refused.has(k)) next.set(k, v)
      return next
    })
    setFailed(refused)
    setHistory({ undo: 0, redo: 0 })
    setMessage(
      refused.size
        ? { text: `${applied} applied · ${refused.size} refused — hover a red cell for why`, tone: 'danger' }
        : { text: `${applied} ${applied === 1 ? 'change' : 'changes'} applied`, tone: 'success' },
    )
  }, [pending, applying, applyBatch, reason, notes])

  /** Close asks first when there is unapplied work; the DS modal routes Esc and ✕ here too. */
  const requestClose = useCallback(() => {
    if (pending.size && !confirmDiscard) { setConfirmDiscard(true); return }
    onClose()
  }, [pending.size, confirmDiscard, onClose])

  const pendingCount = pending.size
  const rowCount = model?.rows.length ?? 0
  const subtitle = row
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
          <Input fieldClassName={styles.ieNotes} placeholder="Notes (optional) — stored on every movement in this batch" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Adjustment notes" />
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
    <Modal open={open} onClose={requestClose} size="xxl" className={styles.ieModal} title={row ? row.name : 'Inventory'} subtitle={subtitle}>
      {loading && <div className={styles.invState}>Loading inventory…</div>}

      {!loading && error && (
        <div className={styles.invState}>
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void reload()}>Retry</Button>
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
                      options={OPTIONAL_COLUMN_KINDS.map((k) => ({ value: k, label: OPTIONAL_COLUMN_LABELS[k] }))}
                      value={OPTIONAL_COLUMN_KINDS.filter((k) => !hiddenKinds.includes(k))}
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
