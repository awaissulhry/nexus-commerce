'use client'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

// PO.6 — Edit-in-place line grid for DRAFT/REVIEW POs.
//
// Replaces the read-only SummaryPane on the detail page when the PO
// status permits edits. Layout mirrors the read-only pane (same column
// set, same alignment) so the operator's eye doesn't have to retrain.
//
// Features:
//   - Per-cell inline editing for qty / unit cost / note
//   - SKU autocomplete against /api/fulfillment/suppliers/:id/catalog
//     when the PO has a supplier; falls back to plain text otherwise
//   - HTML5 drag-and-drop reorder (sets lineOrder server-side)
//   - Add / remove rows (≥1 row enforced server-side)
//   - Notes + expected-delivery-date inline-editable on the header
//   - Debounced autosave (1.5s after last edit) with toast feedback; one
//     save at a time, each sending the draft as it is when it goes out
//     (po-autosave.ts)
//   - Optimistic lock via PO.version — 409 triggers a full refetch +
//     "Reloaded — PO was changed elsewhere" toast.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import {
  Check,
  GripVertical,
  Loader2,
  Package,
  Plus,
  Trash2,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { DateField } from '@/design-system/components/DateField'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { mayReseed, type SaveGate } from './po-autosave'
import { formatCurrency } from './po-lens'
import { useDraft, useSaveQueue } from './use-po-autosave'

// ── Types ──────────────────────────────────────────────────────────

interface POItemInput {
  id: string // local-only id for keying (also used as React key)
  serverId?: string // present on rows that came from the server
  productId: string | null
  sku: string
  supplierSku: string | null
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
  note: string | null
  // Constraint hints — populated when the row is bound to a catalog entry.
  moq?: number
  casePack?: number | null
}

interface POHeaderInput {
  id: string
  version: number
  status: string
  supplierId: string | null
  supplier: { id: string; name: string } | null
  warehouseId: string | null
  expectedDeliveryDate: string | null
  notes: string | null
  currencyCode: string
}

interface CatalogItem {
  id: string
  supplierSku: string | null
  costCents: number | null
  currencyCode: string | null
  moq: number
  casePack: number | null
  isPrimary: boolean
  product: {
    id: string
    sku: string
    name: string
  } | null
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

interface EditableSummaryPaneProps {
  po: POHeaderInput & { items: POItemInput[] }
  onRefresh: () => void | Promise<void>
  /** The page flushes the pending save through it before a status transition. */
  saveGate?: SaveGate
}

let localSeq = 0
const newLocalId = () => `local-${++localSeq}`

// ── Helpers ────────────────────────────────────────────────────────

function rowsFromServerItems(items: POItemInput[]): POItemInput[] {
  return items.map((it) => ({ ...it, id: it.id, serverId: it.id }))
}

function isEditableStatus(status: string): boolean {
  return status === 'DRAFT' || status === 'REVIEW'
}

function parseCentsField(value: string): number {
  const normalized = value.replace(',', '.').trim()
  if (!normalized) return 0
  const n = parseFloat(normalized)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

// ── Main component ────────────────────────────────────────────────

interface Draft {
  items: POItemInput[]
  notes: string
  expectedDate: string
}

function draftFromPo(po: EditableSummaryPaneProps['po']): Draft {
  return {
    items: rowsFromServerItems(po.items),
    notes: po.notes ?? '',
    expectedDate: po.expectedDeliveryDate ? po.expectedDeliveryDate.slice(0, 10) : '',
  }
}

// Keys for "what the server holds", to skip no-op saves. The date compares
// as yyyy-mm-dd: the server answers a full timestamp for the day sent.
function itemsKey(items: POItemInput[]): string {
  return JSON.stringify(serializeItems(items))
}

function headerKey(notes: string, expectedDate: string | null): string {
  return JSON.stringify({ notes, expectedDate: expectedDate ? expectedDate.slice(0, 10) : null })
}

export function EditableSummaryPane({ po, onRefresh, saveGate }: EditableSummaryPaneProps) {
  const { toast } = useToast()

  // Local draft, seeded from props. Edits live here until autosave commits
  // them. The save reads draftRef when it is SENT, so the last keystroke
  // before the timer ends goes out too.
  const [draft, draftRef, setDraft] = useDraft<Draft>(() => draftFromPo(po))
  const { items, notes, expectedDate } = draft
  const [saveState, setSaveState] = useState<SaveState>('idle')

  // The server's copy as this editor knows it: the version (seeded, or
  // returned by our own last save — never taken back from an older refresh)
  // and the last-saved values.
  const versionRef = useRef<number>(po.version)
  const lastServerItemsRef = useRef<string>(itemsKey(po.items))
  const lastServerHeaderRef = useRef<string>(headerKey(po.notes ?? '', po.expectedDeliveryDate))
  // Set by a 409: the server version the editor reloads from, draft or not.
  const conflictVersionRef = useRef<number | null>(null)
  const poRef = useRef(po)
  poRef.current = po

  // ── Autosave logic ──────────────────────────────────────────────
  //
  // Two save streams: header (PATCH /:id) and lines (PATCH /:id/lines),
  // collapsed into one save that runs 1.5s after the last edit. One save at
  // a time: an edit during a save waits behind it (useSaveQueue).

  // 409 — drop the draft and reload the server's copy.
  const conflict = async (res: Response): Promise<false> => {
    const body = await res.json().catch(() => ({}))
    queue.cancel()
    conflictVersionRef.current =
      typeof body?.current?.version === 'number' ? body.current.version : versionRef.current
    toast.warning('PO was changed elsewhere — reloading')
    setSaveState('idle')
    await onRefresh()
    return false
  }

  const save = async (): Promise<boolean> => {
    // The draft as it is NOW, not when the timer started.
    const sent = draftRef.current
    const itemsPayload = serializeItems(sent.items)
    const sentItemsKey = JSON.stringify(itemsPayload)
    const sentHeaderKey = headerKey(sent.notes, sent.expectedDate || null)
    const itemsDirty = sentItemsKey !== lastServerItemsRef.current
    const headerDirty = sentHeaderKey !== lastServerHeaderRef.current

    if (!itemsDirty && !headerDirty) {
      setSaveState((curr) => (curr === 'saved' ? curr : 'idle'))
      return true
    }

    setSaveState('saving')
    try {
      // Header first, then lines; each sends the version the one before
      // returned.
      if (headerDirty) {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              version: versionRef.current,
              notes: sent.notes,
              expectedDeliveryDate: sent.expectedDate || null,
            }),
          },
        )
        if (res.status === 409) return await conflict(res)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        const updated = await res.json()
        versionRef.current = updated.version
        lastServerHeaderRef.current = sentHeaderKey
      }

      if (itemsDirty) {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/lines`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              version: versionRef.current,
              items: itemsPayload,
            }),
          },
        )
        if (res.status === 409) return await conflict(res)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        const updated = await res.json()
        versionRef.current = updated.version
        lastServerItemsRef.current = sentItemsKey
      }

      setSaveState('saved')
      // Fade the "Saved ✓" badge back to idle after 2s so it doesn't
      // sit there permanently.
      window.setTimeout(() => {
        setSaveState((curr) => (curr === 'saved' ? 'idle' : curr))
      }, 2000)
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setSaveState('error')
      return false
    }
  }

  // Take the server's copy only when it is newer than what this editor
  // knows and nothing is unsaved — or after a 409. The echo of our own save
  // (po.updated → refresh) carries the version that save returned, so it
  // never wipes typing in progress.
  const reseedIfNewer = () => {
    const server = poRef.current
    const current = draftRef.current
    const unsaved =
      queue.busy() ||
      itemsKey(current.items) !== lastServerItemsRef.current ||
      headerKey(current.notes, current.expectedDate || null) !== lastServerHeaderRef.current
    if (
      !mayReseed({
        serverVersion: server.version,
        knownVersion: versionRef.current,
        unsaved,
        conflictVersion: conflictVersionRef.current,
      })
    ) {
      return
    }
    queue.cancel()
    conflictVersionRef.current = null
    versionRef.current = server.version
    lastServerItemsRef.current = itemsKey(server.items)
    lastServerHeaderRef.current = headerKey(server.notes ?? '', server.expectedDeliveryDate)
    setDraft(draftFromPo(server))
    setSaveState('idle')
  }

  const queue = useSaveQueue(save, 1500, reseedIfNewer)
  useEffect(() => saveGate?.register(queue), [saveGate, queue])

  // Each fresh server copy from the parent (a peer's change, a refresh).
  useEffect(() => {
    reseedIfNewer()
    // reseedIfNewer reads refs only; it runs once per server copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po])

  const scheduleSave = useCallback(() => {
    setSaveState('pending')
    queue.schedule()
  }, [queue])

  // ── Mutators ────────────────────────────────────────────────────

  const updateLine = useCallback(
    (id: string, patch: Partial<POItemInput>) => {
      setDraft((prev) => ({
        ...prev,
        items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      }))
      scheduleSave()
    },
    [setDraft, scheduleSave],
  )

  const addLine = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          id: newLocalId(),
          productId: null,
          sku: '',
          supplierSku: null,
          quantityOrdered: 1,
          quantityReceived: 0,
          unitCostCents: 0,
          note: null,
          moq: 1,
          casePack: null,
        },
      ],
    }))
    // No save — empty SKU rows wouldn't validate. Wait for SKU input.
  }, [setDraft])

  const removeLine = useCallback(
    (id: string) => {
      setDraft((prev) => ({
        ...prev,
        items: prev.items.length === 1 ? prev.items : prev.items.filter((it) => it.id !== id),
      }))
      scheduleSave()
    },
    [setDraft, scheduleSave],
  )

  const reorderLine = useCallback(
    (fromIdx: number, toIdx: number) => {
      setDraft((prev) => {
        if (fromIdx === toIdx) return prev
        const next = [...prev.items]
        const [moved] = next.splice(fromIdx, 1)
        next.splice(toIdx, 0, moved)
        return { ...prev, items: next }
      })
      scheduleSave()
    },
    [setDraft, scheduleSave],
  )

  // ── Render ──────────────────────────────────────────────────────

  const totalCents = items.reduce(
    (s, it) => s + it.unitCostCents * it.quantityOrdered,
    0,
  )

  return (
    <div className="space-y-4">
      {/* Header inline-edit (expected date + notes) */}
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
            Edit draft
          </div>
          <SaveStateBadge state={saveState} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
              Expected delivery
            </label>
            <DateField
              value={expectedDate}
              onChange={(v) => {
                setDraft((prev) => ({ ...prev, expectedDate: v }))
                scheduleSave()
              }}
              ariaLabel="Expected delivery"
              className="w-full"
            />
          </div>
          <div className="flex items-end">
            <div className="text-sm text-slate-500 dark:text-slate-400">
              Supplier / warehouse / currency are set at create-time. Cancel
              and recreate the PO if any of those need to change.
            </div>
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => {
              const next = e.target.value
              setDraft((prev) => ({ ...prev, notes: next }))
              scheduleSave()
            }}
            rows={3}
            placeholder="Operator notes; visible on the factory PDF"
            className="w-full px-2 py-1.5 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-tertiary dark:placeholder:text-slate-500"
          />
        </div>
      </div>

      {/* Editable line grid */}
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center justify-between">
          <span>Line items</span>
          <button
            type="button"
            onClick={addLine}
            className="text-sm px-2 py-1 border border-default dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 inline-flex items-center gap-1 normal-case font-normal"
          >
            <Plus size={11} /> Add line
          </button>
        </div>
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-default dark:border-slate-700">
            <tr>
              <th className="w-6"></th>
              <th className="text-left font-medium px-3 py-1.5 w-12">#</th>
              <th className="text-left font-medium px-3 py-1.5">SKU / Product</th>
              <th className="text-right font-medium px-3 py-1.5 w-28">Qty</th>
              <th className="text-right font-medium px-3 py-1.5 w-32">Unit cost</th>
              <th className="text-right font-medium px-3 py-1.5 w-28">Subtotal</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <EditableLineRow
                key={it.id}
                row={it}
                index={idx}
                currency={po.currencyCode}
                supplierId={po.supplierId}
                canRemove={items.length > 1}
                onUpdate={(patch) => updateLine(it.id, patch)}
                onRemove={() => removeLine(it.id)}
                onReorder={reorderLine}
              />
            ))}
          </tbody>
          <tfoot className="bg-slate-50 dark:bg-slate-800 border-t border-default dark:border-slate-700">
            <tr>
              <td colSpan={5} className="px-4 py-2 text-right text-sm font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                Total
              </td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                {formatCurrency(totalCents, po.currencyCode)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ── Serializer ─────────────────────────────────────────────────────

function serializeItems(items: POItemInput[]) {
  return items
    .filter((it) => it.sku.trim() && it.quantityOrdered > 0)
    .map((it, idx) => ({
      productId: it.productId,
      sku: it.sku.trim(),
      supplierSku: it.supplierSku,
      quantityOrdered: it.quantityOrdered,
      unitCostCents: it.unitCostCents,
      note: it.note,
      lineOrder: idx,
    }))
}

// ── Save-state badge ───────────────────────────────────────────────

function SaveStateBadge({ state }: { state: SaveState }) {
  const map: Record<SaveState, { label: string; cls: string; icon: React.ReactNode | null }> = {
    idle: { label: '', cls: '', icon: null },
    pending: {
      label: 'Editing…',
      cls: 'text-slate-500 dark:text-slate-400',
      icon: null,
    },
    saving: {
      label: 'Saving…',
      cls: 'text-blue-700 dark:text-blue-300',
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
    },
    saved: {
      label: 'Saved',
      cls: 'text-green-700 dark:text-green-300',
      icon: <Check className="w-3 h-3" />,
    },
    error: {
      label: 'Save failed — will retry',
      cls: 'text-red-700 dark:text-red-300',
      icon: null,
    },
  }
  const cfg = map[state]
  if (!cfg.label) return <span />
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', cfg.cls)}>
      {cfg.icon}
      {cfg.label}
    </span>
  )
}

// ── Row ────────────────────────────────────────────────────────────

function EditableLineRow({
  row,
  index,
  currency,
  supplierId,
  canRemove,
  onUpdate,
  onRemove,
  onReorder,
}: {
  row: POItemInput
  index: number
  currency: string
  supplierId: string | null
  canRemove: boolean
  onUpdate: (patch: Partial<POItemInput>) => void
  onRemove: () => void
  onReorder: (fromIdx: number, toIdx: number) => void
}) {
  const [dragOver, setDragOver] = useState(false)

  const subtotal = row.quantityOrdered * row.unitCostCents
  const moqViolation =
    row.moq && row.moq > 1 && row.quantityOrdered > 0 && row.quantityOrdered < row.moq

  const onDragStart = (e: DragEvent<HTMLTableRowElement>) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
  const onDragOver = (e: DragEvent<HTMLTableRowElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }
  const onDragLeave = () => setDragOver(false)
  const onDrop = (e: DragEvent<HTMLTableRowElement>) => {
    e.preventDefault()
    setDragOver(false)
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain') || '-1', 10)
    if (Number.isFinite(fromIdx) && fromIdx >= 0) {
      onReorder(fromIdx, index)
    }
  }

  return (
    <tr
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'border-b border-subtle dark:border-slate-800 last:border-0 align-top',
        dragOver && 'bg-blue-50 dark:bg-blue-950/30',
      )}
    >
      <td className="px-1 py-2 text-center align-top">
        <span
          className="cursor-grab text-tertiary dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 inline-flex"
          title="Drag to reorder"
        >
          <GripVertical className="w-4 h-4" />
        </span>
      </td>
      <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 tabular-nums align-top">
        {index + 1}
      </td>
      <td className="px-3 py-2 align-top">
        <SkuAutocomplete
          row={row}
          supplierId={supplierId}
          onTextChange={(sku) =>
            onUpdate({
              sku,
              productId: null,
              supplierSku: null,
              moq: 1,
              casePack: null,
            })
          }
          onPick={(picked) => {
            const sku = picked.product?.sku ?? picked.supplierSku ?? ''
            onUpdate({
              sku,
              productId: picked.product?.id ?? null,
              supplierSku: picked.supplierSku ?? null,
              moq: picked.moq,
              casePack: picked.casePack,
              quantityOrdered:
                row.quantityOrdered > 0
                  ? row.quantityOrdered
                  : picked.moq && picked.moq > 1
                    ? picked.moq
                    : 1,
              unitCostCents:
                row.unitCostCents > 0 ? row.unitCostCents : picked.costCents ?? 0,
            })
          }}
        />
        {/* Per-line note pill / inline editor */}
        <NoteEditor
          value={row.note ?? ''}
          onChange={(note) => onUpdate({ note: note || null })}
        />
      </td>
      <td className="px-3 py-2 text-right align-top">
        <input
          type="number"
          min="0"
          step="1"
          value={row.quantityOrdered || ''}
          onChange={(e) =>
            onUpdate({ quantityOrdered: parseInt(e.target.value, 10) || 0 })
          }
          className={cn(
            'w-full h-8 px-2 text-base text-right tabular-nums border rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100',
            moqViolation
              ? 'border-red-300 dark:border-red-700 bg-red-50/30 dark:bg-red-950/20'
              : 'border-default dark:border-slate-700',
          )}
        />
        {moqViolation && (
          <div className="text-xs text-red-700 dark:text-red-300 mt-0.5 text-right">
            Min {row.moq}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top">
        <input
          type="text"
          inputMode="decimal"
          value={(row.unitCostCents / 100).toFixed(2)}
          onChange={(e) =>
            onUpdate({ unitCostCents: parseCentsField(e.target.value) })
          }
          className="w-full h-8 px-2 text-base text-right tabular-nums border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100 align-top pt-3">
        {formatCurrency(subtotal, currency)}
      </td>
      <td className="px-1 py-2 align-top">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          className="h-8 w-8 inline-flex items-center justify-center rounded text-tertiary dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-30"
          aria-label="Remove line"
        >
          <Trash2 size={12} />
        </button>
      </td>
    </tr>
  )
}

// ── Note editor (collapsed pill until first focus) ─────────────────

function NoteEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const [editing, setEditing] = useState(!!value)
  if (!editing && !value) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 inline-flex items-center gap-1"
      >
        + line note
      </button>
    )
  }
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (!value) setEditing(false)
      }}
      rows={1}
      placeholder="Line note (lot code, defect spec, …)"
      className="mt-1 w-full px-2 py-1 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 placeholder:text-tertiary dark:placeholder:text-slate-500"
    />
  )
}

// ── SKU autocomplete ───────────────────────────────────────────────
//
// Duplicates the create-modal autocomplete pattern with row-shape
// adapted for POItemInput. PO.18 polish can dedupe these by extracting
// a single autocomplete into _shared/po-line-bits.tsx.

function SkuAutocomplete({
  row,
  supplierId,
  onTextChange,
  onPick,
}: {
  row: POItemInput
  supplierId: string | null
  onTextChange: (sku: string) => void
  onPick: (picked: CatalogItem) => void
}) {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!supplierId || !open) {
      setResults([])
      return
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    setLoading(true)
    debounceRef.current = window.setTimeout(async () => {
      try {
        const url = new URL(
          `${getBackendUrl()}/api/fulfillment/suppliers/${supplierId}/catalog`,
        )
        if (row.sku.trim()) url.searchParams.set('q', row.sku.trim())
        const res = await fetch(url.toString(), { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          setResults(data.items ?? [])
        }
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [supplierId, row.sku, open])

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={row.sku}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={supplierId ? 'Type SKU or product name…' : 'SKU'}
        className="w-full h-8 px-2 text-base font-mono border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-tertiary dark:placeholder:text-slate-500"
      />
      {row.productId && (
        <div className="text-xs text-green-700 dark:text-green-300 mt-0.5 inline-flex items-center gap-1">
          <Check className="w-3 h-3" />
          Linked to catalog
        </div>
      )}
      {open && supplierId && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              No catalog matches.{' '}
              <span className="text-tertiary dark:text-slate-500">Free SKU entry is fine.</span>
            </div>
          )}
          {!loading &&
            results.map((r) => {
              const p = r.product
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onPick(r)
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-subtle dark:border-slate-800 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Package className="w-3 h-3 text-tertiary dark:text-slate-500 flex-shrink-0" />
                    <span className="font-mono text-sm text-slate-900 dark:text-slate-100">
                      {p?.sku ?? r.supplierSku ?? '—'}
                    </span>
                    {p?.name && (
                      <span className="text-sm text-slate-500 dark:text-slate-400 truncate">
                        · {p.name}
                      </span>
                    )}
                    {r.isPrimary && (
                      <span className="text-xs text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/40 px-1 rounded">
                        primary
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-3">
                    {r.costCents != null && (
                      <span className="tabular-nums">
                        {formatCurrency(r.costCents, r.currencyCode || 'EUR')}
                      </span>
                    )}
                    {r.moq > 1 && <span>MOQ {r.moq}</span>}
                    {r.casePack && r.casePack > 1 && <span>case {r.casePack}</span>}
                  </div>
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}

export { isEditableStatus }
