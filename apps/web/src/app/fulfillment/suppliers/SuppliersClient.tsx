'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { Search, Plus, Upload, Trash2, Star, Loader2, X, Check } from 'lucide-react'

interface Supplier {
  id: string
  name: string
  leadTimeDays: number
  defaultCurrency: string | null
  isActive: boolean
  _count?: { products: number; purchaseOrders: number }
}

interface CatalogRow {
  id: string
  supplierSku: string | null
  costCents: number | null
  currencyCode: string | null
  moq: number
  casePack: number | null
  leadTimeDaysOverride: number | null
  // S2 — split production + shipping time overrides.
  productionTimeDaysOverride: number | null
  productionUnitsPerDayOverride: number | null
  shippingTimeDaysOverride: number | null
  isPrimary: boolean
  // PD.1 — factory-facing naming (per-supplier default; auto-fills PO lines).
  factoryName: string | null
  factorySize: string | null
  factorySpec: string | null
  product: { id: string; sku: string; name: string; basePrice: number | null } | null
}

const API = getBackendUrl()

function eur(cents: number | null): string {
  if (cents == null) return '—'
  return `€${(cents / 100).toFixed(2)}`
}

export default function SuppliersClient() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingSuppliers, setLoadingSuppliers] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSuppliers = useCallback(async () => {
    setLoadingSuppliers(true)
    try {
      const res = await fetch(`${API}/api/fulfillment/suppliers`, { cache: 'no-store' })
      const data = await res.json()
      setSuppliers(data.items ?? [])
      setSelectedId((prev) => prev ?? (data.items?.[0]?.id ?? null))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load suppliers')
    } finally {
      setLoadingSuppliers(false)
    }
  }, [])

  useEffect(() => {
    void loadSuppliers()
  }, [loadSuppliers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return suppliers
    return suppliers.filter((s) => s.name.toLowerCase().includes(q))
  }, [suppliers, search])

  const selected = suppliers.find((s) => s.id === selectedId) ?? null

  async function createSupplier() {
    const name = window.prompt('New supplier name')?.trim()
    if (!name) return
    try {
      const res = await fetch(`${API}/api/fulfillment/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'create failed')
      const created = await res.json()
      await loadSuppliers()
      setSelectedId(created.id)
    } catch (e: any) {
      alert(e?.message ?? 'Failed to create supplier')
    }
  }

  async function deleteSupplier(s: Supplier) {
    if (
      !window.confirm(
        `Delete supplier "${s.name}"? This removes its product costs. (Suppliers with purchase orders can't be deleted — deactivate them instead.)`,
      )
    )
      return
    try {
      const res = await fetch(`${API}/api/fulfillment/suppliers/${s.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'delete failed')
      if (selectedId === s.id) setSelectedId(null)
      await loadSuppliers()
    } catch (e: any) {
      alert(e?.message ?? 'Failed to delete supplier')
    }
  }

  return (
    <div className="space-y-3">
      {/* PD.5 — in-page tabs into the development board (no sidebar link) */}
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">Catalog</span>
        <a href="/fulfillment/suppliers/development" className="rounded px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900">Development →</a>
      </div>
      {/* PD.4 — follow-ups due across all suppliers */}
      <FollowUpsDueBanner onPick={setSelectedId} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_1fr]">
      {/* Supplier list */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 p-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search suppliers"
              className="w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button
            onClick={createSupplier}
            title="New supplier"
            className="rounded border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {loadingSuppliers ? (
            <div className="flex items-center justify-center p-6 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-500">
              No suppliers. Create one to start adding costs.
            </div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id}
                className={`group flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-xs hover:bg-slate-50 ${
                  s.id === selectedId ? 'bg-slate-100' : ''
                }`}
              >
                <button onClick={() => setSelectedId(s.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate font-medium text-slate-900">{s.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {s._count?.products ?? 0} products · LT {s.leadTimeDays}d
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  {!s.isActive && (
                    <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-600">
                      inactive
                    </span>
                  )}
                  <button
                    onClick={() => deleteSupplier(s)}
                    title="Delete supplier"
                    className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Catalog */}
      <div className="rounded-lg border border-slate-200 bg-white">
        {selected ? (
          <SupplierCatalog supplier={selected} onChanged={loadSuppliers} />
        ) : (
          <div className="p-8 text-center text-sm text-slate-500">
            {error ?? 'Select a supplier to manage its product costs and lead times.'}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

// PD.4 — global "follow-ups due" banner across all suppliers.
function FollowUpsDueBanner({ onPick }: { onPick: (id: string) => void }) {
  const [items, setItems] = useState<Array<{ id: string; title: string; dueDate: string; supplier: { id: string; name: string } }>>([])
  useEffect(() => {
    void (async () => {
      const res = await fetch(`${API}/api/fulfillment/suppliers/followups/due?withinDays=7`, { cache: 'no-store' })
      if (res.ok) setItems((await res.json()).items ?? [])
    })()
  }, [])
  if (items.length === 0) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const overdue = items.filter((f) => new Date(f.dueDate) < today).length
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
      <div className="mb-1 text-[11px] font-semibold text-amber-800">
        {items.length} follow-up{items.length === 1 ? '' : 's'} due{overdue > 0 ? ` · ${overdue} overdue` : ''}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 12).map((f) => {
          const od = new Date(f.dueDate) < today
          return (
            <button key={f.id} onClick={() => onPick(f.supplier.id)} className={`rounded border px-1.5 py-0.5 text-[11px] ${od ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
              <span className="font-medium">{f.supplier.name}</span> · {f.title} · {new Date(f.dueDate).toLocaleDateString()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SupplierCatalog({
  supplier,
  onChanged,
}: {
  supplier: Supplier
  onChanged: () => void
}) {
  const [rows, setRows] = useState<CatalogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  // Add-row form
  const [newSku, setNewSku] = useState('')
  const [newCost, setNewCost] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${API}/api/fulfillment/suppliers/${supplier.id}/catalog?take=200`,
        { cache: 'no-store' },
      )
      const data = await res.json()
      setRows(data.items ?? [])
    } finally {
      setLoading(false)
    }
  }, [supplier.id])

  useEffect(() => {
    void load()
  }, [load])

  async function addProduct() {
    setAddError(null)
    const sku = newSku.trim()
    if (!sku) return
    setAdding(true)
    try {
      const res = await fetch(
        `${API}/api/fulfillment/suppliers/${supplier.id}/products`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku,
            costEur: newCost.trim() || undefined,
            currencyCode: supplier.defaultCurrency ?? 'EUR',
          }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'add failed')
      setNewSku('')
      setNewCost('')
      await load()
      onChanged()
    } catch (e: any) {
      setAddError(e?.message ?? 'Failed to add product')
    } finally {
      setAdding(false)
    }
  }

  async function patchRow(row: CatalogRow, patch: Record<string, any>) {
    if (!row.product) return
    const res = await fetch(
      `${API}/api/fulfillment/suppliers/${supplier.id}/products/${row.product.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    )
    if (!res.ok) {
      alert((await res.json()).error ?? 'update failed')
      return
    }
    await load()
  }

  async function deleteRow(row: CatalogRow) {
    if (!row.product) return
    if (!window.confirm(`Remove ${row.product.sku} from ${supplier.name}'s catalog?`)) return
    await fetch(
      `${API}/api/fulfillment/suppliers/${supplier.id}/products/${row.product.id}`,
      { method: 'DELETE' },
    )
    await load()
    onChanged()
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{supplier.name}</h2>
          <p className="text-[11px] text-slate-500">
            Default {supplier.defaultCurrency ?? 'EUR'} · base lead time {supplier.leadTimeDays}d ·{' '}
            {rows.length} products in catalog
          </p>
        </div>
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Upload className="h-3.5 w-3.5" /> Import CSV
        </button>
      </div>

      {/* PD.2 — supplier details + contacts */}
      <SupplierDetailPanel supplierId={supplier.id} />

      {/* Add row */}
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-slate-50 p-3">
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
            Product SKU
          </label>
          <input
            value={newSku}
            onChange={(e) => setNewSku(e.target.value)}
            placeholder="e.g. GALE-JACKET-BLACK-MEN-L"
            className="w-56 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
            Unit cost (€)
          </label>
          <input
            value={newCost}
            onChange={(e) => setNewCost(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <button
          onClick={addProduct}
          disabled={adding || !newSku.trim()}
          className="flex items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add to catalog
        </button>
        {addError && <span className="text-[11px] text-rose-600">{addError}</span>}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No products yet. Add one above or import a CSV.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">SKU / Product</th>
                <th className="px-2 py-2">Supplier SKU</th>
                <th className="px-2 py-2" title="Name the factory understands — auto-fills PO lines">Factory name</th>
                <th className="px-2 py-2">Factory size</th>
                <th className="px-2 py-2">Unit cost</th>
                <th className="px-2 py-2">Ccy</th>
                <th className="px-2 py-2">MOQ</th>
                <th className="px-2 py-2">Case</th>
                <th className="px-2 py-2" title="Production + shipping time → effective lead time">Lead time</th>
                <th className="px-2 py-2 text-center">Primary</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CatalogRowView
                  key={r.id}
                  row={r}
                  onPatch={(patch) => patchRow(r, patch)}
                  onDelete={() => deleteRow(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importOpen && (
        <ImportModal
          supplier={supplier}
          onClose={() => setImportOpen(false)}
          onDone={async () => {
            await load()
            onChanged()
          }}
        />
      )}
    </div>
  )
}

// PD.2 — supplier details (editable) + contact persons.
type SupplierContact = {
  id: string
  name: string
  role: string | null
  email: string | null
  phone: string | null
  whatsapp: string | null
  wechat: string | null
  isPrimary: boolean
  notes: string | null
}
type SupplierFull = {
  id: string
  name: string
  email: string | null
  phone: string | null
  taxId: string | null
  paymentTerms: string | null
  addressLine1: string | null
  city: string | null
  postalCode: string | null
  country: string | null
  leadTimeDays: number
  notes: string | null
  contacts: SupplierContact[]
}

const SUPPLIER_FIELDS: Array<{ key: keyof SupplierFull; label: string }> = [
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'taxId', label: 'VAT / Tax ID' },
  { key: 'paymentTerms', label: 'Payment terms' },
  { key: 'addressLine1', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
]

function SupplierDetailPanel({ supplierId }: { supplierId: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SupplierFull | null>(null)
  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
  }, [supplierId])
  useEffect(() => { setData(null) }, [supplierId])
  useEffect(() => { if (open && !data) void load() }, [open, data, load])

  const patchSupplier = async (patch: Record<string, unknown>) => {
    await fetch(`${API}/api/fulfillment/suppliers/${supplierId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    void load()
  }
  const saveContact = async (c: Partial<SupplierContact> & { id?: string }) => {
    const url = c.id
      ? `${API}/api/fulfillment/suppliers/${supplierId}/contacts/${c.id}`
      : `${API}/api/fulfillment/suppliers/${supplierId}/contacts`
    const res = await fetch(url, { method: c.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
    if (res.ok) void load()
    return res.ok
  }
  const deleteContact = async (id: string) => {
    if (!window.confirm('Delete this contact?')) return
    await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/contacts/${id}`, { method: 'DELETE' })
    void load()
  }

  return (
    <div className="border-b border-slate-200">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
        <span>{open ? '▾' : '▸'}</span> Details &amp; contacts{data ? ` (${data.contacts.length})` : ''}
      </button>
      {open && data && (
        <div className="space-y-3 bg-slate-50 p-3">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
            {SUPPLIER_FIELDS.map(({ key, label }) => (
              <label key={String(key)} className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
                <input
                  defaultValue={(data[key] as string | null) ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (((data[key] as string | null) ?? ''))) void patchSupplier({ [key]: v })
                  }}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none"
                />
              </label>
            ))}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Contact persons</div>
            <div className="space-y-1">
              {data.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} onSave={saveContact} onDelete={() => deleteContact(c.id)} />
              ))}
              <ContactRow contact={null} onSave={saveContact} />
            </div>
          </div>
          {/* PD.4 — follow-ups / reminders */}
          <SupplierFollowUpsSection supplierId={supplierId} />
          {/* PD.3 — comms log + compose-and-send */}
          <SupplierCommsSection supplierId={supplierId} contacts={data.contacts} />
        </div>
      )}
    </div>
  )
}

// PD.4 — per-supplier follow-ups / reminders.
type FollowUp = { id: string; title: string; nextAction: string | null; dueDate: string; status: string; completedAt: string | null }

function SupplierFollowUpsSection({ supplierId }: { supplierId: string }) {
  const [items, setItems] = useState<FollowUp[]>([])
  const [title, setTitle] = useState('')
  const [nextAction, setNextAction] = useState('')
  const [due, setDue] = useState('')
  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/followups`, { cache: 'no-store' })
    if (res.ok) setItems((await res.json()).items ?? [])
  }, [supplierId])
  useEffect(() => { void load() }, [load])
  const add = async () => {
    if (!title.trim() || !due) return
    const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/followups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), nextAction: nextAction.trim() || undefined, dueDate: due }) })
    if (res.ok) { setTitle(''); setNextAction(''); setDue(''); void load() }
  }
  const patch = async (id: string, b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/followups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); void load() }
  const del = async (id: string) => { await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/followups/${id}`, { method: 'DELETE' }); void load() }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Follow-ups</div>
      <div className="space-y-1">
        {items.map((f) => {
          const overdue = f.status === 'OPEN' && new Date(f.dueDate) < today
          return (
            <div key={f.id} className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${f.status === 'DONE' ? 'border-slate-200 opacity-50' : overdue ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
              <input type="checkbox" checked={f.status === 'DONE'} onChange={() => patch(f.id, { status: f.status === 'DONE' ? 'OPEN' : 'DONE' })} />
              <div className="min-w-0 flex-1">
                <div className={`truncate ${f.status === 'DONE' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{f.title}</div>
                {f.nextAction && <div className="truncate text-slate-500">{f.nextAction}</div>}
              </div>
              <span className={overdue ? 'text-rose-600' : 'text-slate-500'}>{new Date(f.dueDate).toLocaleDateString()}</span>
              <button onClick={() => del(f.id)} className="text-slate-400 hover:text-rose-600">✕</button>
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-1.5">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Follow-up (e.g. chase sample)" className="w-44 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
          <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Next action" className="w-32 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none" />
          <button onClick={add} disabled={!title.trim() || !due} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">Add</button>
        </div>
      </div>
    </div>
  )
}

// PD.3 — supplier comms timeline + compose-and-send email + log note/call.
type SupplierCommRow = {
  id: string
  channel: string
  direction: string
  subject: string | null
  body: string
  emailTo: string | null
  emailOk: boolean | null
  createdAt: string
}

function SupplierCommsSection({ supplierId, contacts }: { supplierId: string; contacts: SupplierContact[] }) {
  const [items, setItems] = useState<SupplierCommRow[]>([])
  const [mode, setMode] = useState<'email' | 'note'>('email')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/comms`, { cache: 'no-store' })
    if (res.ok) setItems((await res.json()).items ?? [])
  }, [supplierId])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    if (!body.trim()) return
    setBusy(true); setMsg(null)
    try {
      if (mode === 'email') {
        const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/comms/email`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to.trim(), subject: subject.trim(), body: body.trim() }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setMsg(d.error ?? 'Send failed'); return }
        setMsg(d.delivery?.dryRun ? 'Email queued (dry-run)' : 'Email sent')
      } else {
        const res = await fetch(`${API}/api/fulfillment/suppliers/${supplierId}/comms`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'NOTE', body: body.trim(), subject: subject.trim() || undefined }),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); setMsg(d.error ?? 'Save failed'); return }
        setMsg('Logged')
      }
      setBody(''); setSubject('')
      void load()
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Communication</span>
        <div className="inline-flex overflow-hidden rounded border border-slate-300">
          {(['email', 'note'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 text-[11px] ${mode === m ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>{m === 'email' ? 'Email' : 'Log note'}</button>
          ))}
        </div>
        {msg && <span className="text-[11px] text-emerald-600">{msg}</span>}
      </div>
      <div className="space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2">
        {mode === 'email' && (
          <div className="flex flex-wrap gap-1.5">
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@factory.com" list="supplier-emails" className="w-56 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
            <datalist id="supplier-emails">
              {contacts.filter((c) => c.email).map((c) => <option key={c.id} value={c.email!}>{c.name}</option>)}
            </datalist>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="flex-1 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
          </div>
        )}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={mode === 'email' ? 'Message to the factory…' : 'Call summary / note…'} className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
        <div className="flex justify-end">
          <button onClick={send} disabled={busy || !body.trim()} className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? '…' : mode === 'email' ? 'Send email' : 'Log'}
          </button>
        </div>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {items.map((c) => (
            <li key={c.id} className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-700">
                  {c.channel}{c.emailTo ? ` → ${c.emailTo}` : ''}{c.channel === 'EMAIL' ? (c.emailOk ? ' ✓' : ' ⚠') : ''}
                </span>
                <span className="text-slate-400">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              {c.subject && <div className="text-slate-600">{c.subject}</div>}
              <div className="truncate text-slate-500">{c.body}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ContactRow({
  contact, onSave, onDelete,
}: {
  contact: SupplierContact | null
  onSave: (c: Partial<SupplierContact> & { id?: string }) => Promise<boolean>
  onDelete?: () => void
}) {
  const [name, setName] = useState(contact?.name ?? '')
  const [role, setRole] = useState(contact?.role ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [whatsapp, setWhatsapp] = useState(contact?.whatsapp ?? '')
  const isNew = !contact
  const submit = async () => {
    if (!name.trim()) return
    const ok = await onSave({ id: contact?.id, name: name.trim(), role: role.trim() || null, email: email.trim() || null, phone: phone.trim() || null, whatsapp: whatsapp.trim() || null })
    if (ok && isNew) { setName(''); setRole(''); setEmail(''); setPhone(''); setWhatsapp('') }
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Name" className="w-28 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
      <input value={role} onChange={(e) => setRole(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Role" className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
      <input value={email} onChange={(e) => setEmail(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Email" className="w-40 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
      <input value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Phone" className="w-28 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
      <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="WhatsApp/WeChat" className="w-32 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none" />
      {isNew ? (
        <button onClick={submit} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100">Add</button>
      ) : (
        <button onClick={onDelete} className="rounded px-1.5 py-0.5 text-xs text-rose-600 hover:bg-rose-50">✕</button>
      )}
    </div>
  )
}

function EditableNum({
  value,
  suffix,
  prefix,
  onSave,
  placeholder = '—',
}: {
  value: number | null
  suffix?: string
  prefix?: string
  onSave: (v: string) => void
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          inputMode="decimal"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSave(draft)
              setEditing(false)
            }
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => {
            onSave(draft)
            setEditing(false)
          }}
          className="w-16 rounded border border-blue-400 bg-white px-1.5 py-0.5 text-xs text-slate-900 focus:outline-none"
        />
      </span>
    )
  }
  return (
    <button
      onClick={() => {
        setDraft(value == null ? '' : String(value))
        setEditing(true)
      }}
      className="rounded px-1 py-0.5 text-slate-800 hover:bg-slate-100"
    >
      {value == null ? (
        <span className="text-slate-400">{placeholder}</span>
      ) : (
        `${prefix ?? ''}${value}${suffix ?? ''}`
      )}
    </button>
  )
}

// PD.1 — inline editable text cell (string), used for factory name/size.
function EditableText({
  value,
  onSave,
  placeholder = '—',
  width = 'w-28',
}: {
  value: string | null
  onSave: (v: string) => void
  placeholder?: string
  width?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onSave(draft.trim()); setEditing(false) }
          if (e.key === 'Escape') setEditing(false)
        }}
        onBlur={() => { onSave(draft.trim()); setEditing(false) }}
        className={`${width} rounded border border-blue-400 bg-white px-1.5 py-0.5 text-xs text-slate-900 focus:outline-none`}
      />
    )
  }
  return (
    <button
      onClick={() => { setDraft(value ?? ''); setEditing(true) }}
      className="rounded px-1 py-0.5 text-left text-slate-800 hover:bg-slate-100"
    >
      {value ? value : <span className="text-slate-400">{placeholder}</span>}
    </button>
  )
}

// S2 — compact lead-time cell: shows the production+shipping summary and opens
// a small editor. Production is flat days OR a units/day rate (the operator
// picks); shipping is days. Keeps the grid narrow vs. three raw columns.
function LeadTimeCell({
  row,
  onPatch,
}: {
  row: CatalogRow
  onPatch: (p: Record<string, any>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const prodFlat = row.productionTimeDaysOverride
  const prodRate = row.productionUnitsPerDayOverride
  const ship = row.shippingTimeDaysOverride
  const legacy = row.leadTimeDaysOverride
  const hasSplit = prodFlat != null || prodRate != null || ship != null

  let summary: string
  if (hasSplit) {
    const p = prodRate != null ? `${prodRate}/d` : prodFlat != null ? `${prodFlat}d` : '0d'
    summary = `${p}+${ship ?? 0}d`
  } else if (legacy != null) summary = `${legacy}d`
  else summary = 'set'

  const [mode, setMode] = useState<'flat' | 'rate'>(prodRate != null ? 'rate' : 'flat')
  const [flat, setFlat] = useState(prodFlat?.toString() ?? '')
  const [rate, setRate] = useState(prodRate?.toString() ?? '')
  const [shipD, setShipD] = useState(ship?.toString() ?? '')
  const num = (s: string) => (s.trim() === '' ? null : Number(s))

  function save() {
    onPatch({
      productionTimeDaysOverride: mode === 'flat' ? num(flat) : null,
      productionUnitsPerDayOverride: mode === 'rate' ? num(rate) : null,
      shippingTimeDaysOverride: num(shipD),
    })
    setOpen(false)
  }
  function clear() {
    onPatch({
      productionTimeDaysOverride: null,
      productionUnitsPerDayOverride: null,
      shippingTimeDaysOverride: null,
    })
    setFlat('')
    setRate('')
    setShipD('')
    setOpen(false)
  }
  const previewDays = (num(flat) ?? 0) + (num(shipD) ?? 0)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Production + shipping time"
        className={`rounded px-1.5 py-0.5 hover:bg-slate-100 ${
          hasSplit || legacy != null ? 'text-slate-800' : 'text-slate-400'
        }`}
      >
        {summary}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 space-y-2 rounded-md border border-slate-200 bg-white p-2 text-xs shadow-lg">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Production</div>
          <div className="flex gap-1">
            <button
              onClick={() => setMode('flat')}
              className={`flex-1 rounded px-2 py-1 ${mode === 'flat' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Flat days
            </button>
            <button
              onClick={() => setMode('rate')}
              className={`flex-1 rounded px-2 py-1 ${mode === 'rate' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Units/day
            </button>
          </div>
          {mode === 'flat' ? (
            <label className="flex items-center gap-2">
              <span className="w-16 text-slate-500">Days</span>
              <input
                value={flat}
                onChange={(e) => setFlat(e.target.value)}
                inputMode="numeric"
                placeholder="12"
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 focus:border-blue-500 focus:outline-none"
              />
            </label>
          ) : (
            <label className="flex items-center gap-2">
              <span className="w-16 text-slate-500">Units/day</span>
              <input
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                inputMode="numeric"
                placeholder="100"
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 focus:border-blue-500 focus:outline-none"
              />
            </label>
          )}
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Shipping</div>
          <label className="flex items-center gap-2">
            <span className="w-16 text-slate-500">Days</span>
            <input
              value={shipD}
              onChange={(e) => setShipD(e.target.value)}
              inputMode="numeric"
              placeholder="3"
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </label>
          <div className="text-[11px] text-slate-500">
            {mode === 'flat'
              ? `≈ ${previewDays} days total`
              : 'Rate-based — production scales with order qty, + shipping'}
          </div>
          <div className="flex items-center justify-between pt-1">
            <button onClick={clear} className="text-[11px] text-slate-500 hover:text-rose-600">
              Clear
            </button>
            <button
              onClick={save}
              className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CatalogRowView({
  row,
  onPatch,
  onDelete,
}: {
  row: CatalogRow
  onPatch: (patch: Record<string, any>) => void
  onDelete: () => void
}) {
  const [costEditing, setCostEditing] = useState(false)
  const [costDraft, setCostDraft] = useState('')
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-3 py-2">
        <div className="font-medium text-slate-900">{row.product?.sku ?? '—'}</div>
        <div className="max-w-[260px] truncate text-[11px] text-slate-500">
          {row.product?.name ?? ''}
        </div>
      </td>
      <td className="px-2 py-2 text-slate-500">{row.supplierSku ?? '—'}</td>
      <td className="px-2 py-2">
        <EditableText value={row.factoryName} onSave={(v) => onPatch({ factoryName: v })} placeholder="factory name" />
      </td>
      <td className="px-2 py-2">
        <EditableText value={row.factorySize} onSave={(v) => onPatch({ factorySize: v })} placeholder="size" width="w-16" />
      </td>
      <td className="px-2 py-2">
        {costEditing ? (
          <input
            autoFocus
            value={costDraft}
            inputMode="decimal"
            onChange={(e) => setCostDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onPatch({ costEur: costDraft })
                setCostEditing(false)
              }
              if (e.key === 'Escape') setCostEditing(false)
            }}
            onBlur={() => {
              if (costDraft.trim()) onPatch({ costEur: costDraft })
              setCostEditing(false)
            }}
            className="w-20 rounded border border-blue-400 bg-white px-1.5 py-0.5 text-xs text-slate-900 focus:outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setCostDraft(row.costCents == null ? '' : (row.costCents / 100).toFixed(2))
              setCostEditing(true)
            }}
            className={`rounded px-1.5 py-0.5 font-medium hover:bg-slate-100 ${
              row.costCents == null ? 'text-rose-600' : 'text-emerald-600'
            }`}
          >
            {row.costCents == null ? 'set cost' : eur(row.costCents)}
          </button>
        )}
      </td>
      <td className="px-2 py-2 text-slate-500">{row.currencyCode ?? 'EUR'}</td>
      <td className="px-2 py-2">
        <EditableNum value={row.moq} onSave={(v) => onPatch({ moq: Number(v) || 1 })} />
      </td>
      <td className="px-2 py-2">
        <EditableNum
          value={row.casePack}
          onSave={(v) => onPatch({ casePack: v.trim() === '' ? null : Number(v) })}
        />
      </td>
      <td className="px-2 py-2">
        <LeadTimeCell row={row} onPatch={onPatch} />
      </td>
      <td className="px-2 py-2 text-center">
        <button
          onClick={() => onPatch({ isPrimary: !row.isPrimary })}
          title={row.isPrimary ? 'Primary supplier (feeds replenishment)' : 'Set as primary'}
          className="inline-flex"
        >
          <Star
            className={`h-4 w-4 ${
              row.isPrimary ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-slate-400'
            }`}
          />
        </button>
      </td>
      <td className="px-2 py-2 text-right">
        <button
          onClick={onDelete}
          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}

interface ParsedRow {
  sku?: string
  supplierSku?: string
  costEur?: string
  costCents?: string
  currencyCode?: string
  moq?: string
  casePack?: string
  leadTimeDaysOverride?: string
  productionTimeDaysOverride?: string
  productionUnitsPerDayOverride?: string
  shippingTimeDaysOverride?: string
  isPrimary?: boolean
}

function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const splitLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = !inQ
      } else if (c === ',' && !inQ) {
        out.push(cur)
        cur = ''
      } else cur += c
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ''))
  const norm: Record<string, keyof ParsedRow> = {
    sku: 'sku',
    suppliersku: 'supplierSku',
    cost: 'costEur',
    costeur: 'costEur',
    costcents: 'costCents',
    currency: 'currencyCode',
    currencycode: 'currencyCode',
    moq: 'moq',
    casepack: 'casePack',
    leadtime: 'leadTimeDaysOverride',
    leadtimedaysoverride: 'leadTimeDaysOverride',
    // S2 — production + shipping time columns.
    productiontime: 'productionTimeDaysOverride',
    productiondays: 'productionTimeDaysOverride',
    productionrate: 'productionUnitsPerDayOverride',
    unitsperday: 'productionUnitsPerDayOverride',
    shippingtime: 'shippingTimeDaysOverride',
    shippingdays: 'shippingTimeDaysOverride',
    primary: 'isPrimary',
    isprimary: 'isPrimary',
  }
  const rows: ParsedRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i])
    const row: ParsedRow = {}
    headers.forEach((h, idx) => {
      const key = norm[h]
      if (!key) return
      const v = cells[idx] ?? ''
      if (key === 'isPrimary') row.isPrimary = /^(1|true|yes|y)$/i.test(v)
      else (row as any)[key] = v
    })
    if (row.sku) rows.push(row)
  }
  return rows
}

function ImportModal({
  supplier,
  onClose,
  onDone,
}: {
  supplier: Supplier
  onClose: () => void
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const parsed = useMemo(() => parseCsv(text), [text])

  async function submit() {
    setSubmitting(true)
    setResult(null)
    try {
      const res = await fetch(`${API}/api/fulfillment/suppliers/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsed, defaultSupplierId: supplier.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'import failed')
      setResult(data)
      await onDone()
    } catch (e: any) {
      setResult({ error: e?.message ?? 'import failed' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 p-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Import costs → {supplier.name}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-3">
          <p className="text-[11px] text-slate-500">
            Paste CSV with a header row. Columns:{' '}
            <code className="text-slate-700">
              sku, cost, currency, moq, casePack, leadTime, supplierSku, primary
            </code>
            . Only <code className="text-slate-700">sku</code> is required. Rows apply to{' '}
            <span className="text-slate-900">{supplier.name}</span> unless a{' '}
            <code className="text-slate-700">supplierName</code> column overrides it.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setText(await f.text())
              }}
              className="text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-slate-700"
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={'sku,cost,moq,leadTime,primary\nGALE-JACKET-BLACK-MEN-L,42.50,50,21,true'}
            className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              {parsed.length} row{parsed.length === 1 ? '' : 's'} parsed
            </span>
            <button
              onClick={submit}
              disabled={submitting || parsed.length === 0}
              className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Import {parsed.length} rows
            </button>
          </div>
          {result && (
            <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px]">
              {result.error ? (
                <span className="text-rose-600">{result.error}</span>
              ) : (
                <>
                  <div className="text-slate-800">
                    ✓ {result.summary.created} created · {result.summary.updated} updated ·{' '}
                    <span className={result.summary.failed ? 'text-rose-600' : 'text-slate-500'}>
                      {result.summary.failed} failed
                    </span>
                  </div>
                  {result.summary.failed > 0 && (
                    <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-rose-600/80">
                      {result.results
                        .filter((r: any) => r.status === 'error')
                        .slice(0, 20)
                        .map((r: any) => (
                          <li key={r.row}>
                            row {r.row + 1}: {r.reason}
                          </li>
                        ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
