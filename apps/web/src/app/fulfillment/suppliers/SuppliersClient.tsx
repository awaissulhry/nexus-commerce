'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_1fr]">
      {/* Supplier list */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/40">
        <div className="flex items-center gap-2 border-b border-slate-700 p-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search suppliers"
              className="w-full rounded border border-slate-700 bg-slate-950 py-1 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
            />
          </div>
          <button
            onClick={createSupplier}
            title="New supplier"
            className="rounded border border-slate-700 bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {loadingSuppliers ? (
            <div className="flex items-center justify-center p-6 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-500">
              No suppliers. Create one to start adding costs.
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`flex w-full items-center justify-between border-b border-slate-800 px-3 py-2 text-left text-xs hover:bg-slate-800/60 ${
                  s.id === selectedId ? 'bg-slate-800' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-200">{s.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {s._count?.products ?? 0} products · LT {s.leadTimeDays}d
                  </div>
                </div>
                {!s.isActive && (
                  <span className="rounded bg-slate-700 px-1 text-[10px] text-slate-400">
                    inactive
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Catalog */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/40">
        {selected ? (
          <SupplierCatalog supplier={selected} onChanged={loadSuppliers} />
        ) : (
          <div className="p-8 text-center text-sm text-slate-500">
            {error ?? 'Select a supplier to manage its product costs and lead times.'}
          </div>
        )}
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 p-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{supplier.name}</h2>
          <p className="text-[11px] text-slate-500">
            Default {supplier.defaultCurrency ?? 'EUR'} · base lead time {supplier.leadTimeDays}d ·{' '}
            {rows.length} products in catalog
          </p>
        </div>
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          <Upload className="h-3.5 w-3.5" /> Import CSV
        </button>
      </div>

      {/* PD.2 — supplier details + contacts */}
      <SupplierDetailPanel supplierId={supplier.id} />

      {/* Add row */}
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-800 bg-slate-900/60 p-3">
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
            Product SKU
          </label>
          <input
            value={newSku}
            onChange={(e) => setNewSku(e.target.value)}
            placeholder="e.g. GALE-JACKET-BLACK-MEN-L"
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-slate-500 focus:outline-none"
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
            className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-slate-500 focus:outline-none"
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
        {addError && <span className="text-[11px] text-rose-400">{addError}</span>}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No products yet. Add one above or import a CSV.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">SKU / Product</th>
                <th className="px-2 py-2">Supplier SKU</th>
                <th className="px-2 py-2" title="Name the factory understands — auto-fills PO lines">Factory name</th>
                <th className="px-2 py-2">Factory size</th>
                <th className="px-2 py-2">Unit cost</th>
                <th className="px-2 py-2">Ccy</th>
                <th className="px-2 py-2">MOQ</th>
                <th className="px-2 py-2">Case</th>
                <th className="px-2 py-2">LT override</th>
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
    <div className="border-b border-slate-800">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800/50">
        <span>{open ? '▾' : '▸'}</span> Details &amp; contacts{data ? ` (${data.contacts.length})` : ''}
      </button>
      {open && data && (
        <div className="space-y-3 bg-slate-900/40 p-3">
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
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100 focus:border-slate-500 focus:outline-none"
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
          {/* PD.3 — comms log + compose-and-send */}
          <SupplierCommsSection supplierId={supplierId} contacts={data.contacts} />
        </div>
      )}
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
        <div className="inline-flex overflow-hidden rounded border border-slate-700">
          {(['email', 'note'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 text-[11px] ${mode === m ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'}`}>{m === 'email' ? 'Email' : 'Log note'}</button>
          ))}
        </div>
        {msg && <span className="text-[11px] text-emerald-400">{msg}</span>}
      </div>
      <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950/40 p-2">
        {mode === 'email' && (
          <div className="flex flex-wrap gap-1.5">
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@factory.com" list="supplier-emails" className="w-56 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100 focus:outline-none" />
            <datalist id="supplier-emails">
              {contacts.filter((c) => c.email).map((c) => <option key={c.id} value={c.email!}>{c.name}</option>)}
            </datalist>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100 focus:outline-none" />
          </div>
        )}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={mode === 'email' ? 'Message to the factory…' : 'Call summary / note…'} className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100 focus:outline-none" />
        <div className="flex justify-end">
          <button onClick={send} disabled={busy || !body.trim()} className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? '…' : mode === 'email' ? 'Send email' : 'Log'}
          </button>
        </div>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {items.map((c) => (
            <li key={c.id} className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-300">
                  {c.channel}{c.emailTo ? ` → ${c.emailTo}` : ''}{c.channel === 'EMAIL' ? (c.emailOk ? ' ✓' : ' ⚠') : ''}
                </span>
                <span className="text-slate-600">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              {c.subject && <div className="text-slate-400">{c.subject}</div>}
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
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Name" className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none" />
      <input value={role} onChange={(e) => setRole(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Role" className="w-20 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none" />
      <input value={email} onChange={(e) => setEmail(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Email" className="w-40 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none" />
      <input value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="Phone" className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none" />
      <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} onBlur={isNew ? undefined : submit} placeholder="WhatsApp/WeChat" className="w-32 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none" />
      {isNew ? (
        <button onClick={submit} className="rounded border border-emerald-700 bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-900/60">Add</button>
      ) : (
        <button onClick={onDelete} className="rounded px-1.5 py-0.5 text-xs text-rose-400 hover:bg-rose-900/30">✕</button>
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
          className="w-16 rounded border border-slate-500 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none"
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
      className="rounded px-1 py-0.5 text-slate-200 hover:bg-slate-800"
    >
      {value == null ? (
        <span className="text-slate-600">{placeholder}</span>
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
        className={`${width} rounded border border-slate-500 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none`}
      />
    )
  }
  return (
    <button
      onClick={() => { setDraft(value ?? ''); setEditing(true) }}
      className="rounded px-1 py-0.5 text-left text-slate-200 hover:bg-slate-800"
    >
      {value ? value : <span className="text-slate-600">{placeholder}</span>}
    </button>
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
    <tr className="border-b border-slate-800 hover:bg-slate-800/40">
      <td className="px-3 py-2">
        <div className="font-medium text-slate-200">{row.product?.sku ?? '—'}</div>
        <div className="max-w-[260px] truncate text-[11px] text-slate-500">
          {row.product?.name ?? ''}
        </div>
      </td>
      <td className="px-2 py-2 text-slate-400">{row.supplierSku ?? '—'}</td>
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
            className="w-20 rounded border border-slate-500 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setCostDraft(row.costCents == null ? '' : (row.costCents / 100).toFixed(2))
              setCostEditing(true)
            }}
            className={`rounded px-1.5 py-0.5 font-medium hover:bg-slate-800 ${
              row.costCents == null ? 'text-rose-400' : 'text-emerald-300'
            }`}
          >
            {row.costCents == null ? 'set cost' : eur(row.costCents)}
          </button>
        )}
      </td>
      <td className="px-2 py-2 text-slate-400">{row.currencyCode ?? 'EUR'}</td>
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
        <EditableNum
          value={row.leadTimeDaysOverride}
          suffix="d"
          onSave={(v) => onPatch({ leadTimeDaysOverride: v.trim() === '' ? null : Number(v) })}
        />
      </td>
      <td className="px-2 py-2 text-center">
        <button
          onClick={() => onPatch({ isPrimary: !row.isPrimary })}
          title={row.isPrimary ? 'Primary supplier (feeds replenishment)' : 'Set as primary'}
          className="inline-flex"
        >
          <Star
            className={`h-4 w-4 ${
              row.isPrimary ? 'fill-amber-400 text-amber-400' : 'text-slate-600 hover:text-slate-400'
            }`}
          />
        </button>
      </td>
      <td className="px-2 py-2 text-right">
        <button
          onClick={onDelete}
          className="rounded p-1 text-slate-500 hover:bg-rose-900/40 hover:text-rose-400"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-700 p-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Import costs → {supplier.name}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-3">
          <p className="text-[11px] text-slate-400">
            Paste CSV with a header row. Columns:{' '}
            <code className="text-slate-300">
              sku, cost, currency, moq, casePack, leadTime, supplierSku, primary
            </code>
            . Only <code className="text-slate-300">sku</code> is required. Rows apply to{' '}
            <span className="text-slate-200">{supplier.name}</span> unless a{' '}
            <code className="text-slate-300">supplierName</code> column overrides it.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setText(await f.text())
              }}
              className="text-xs text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200"
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={'sku,cost,moq,leadTime,primary\nGALE-JACKET-BLACK-MEN-L,42.50,50,21,true'}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] text-slate-200 focus:border-slate-500 focus:outline-none"
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
            <div className="rounded border border-slate-700 bg-slate-950 p-2 text-[11px]">
              {result.error ? (
                <span className="text-rose-400">{result.error}</span>
              ) : (
                <>
                  <div className="text-slate-200">
                    ✓ {result.summary.created} created · {result.summary.updated} updated ·{' '}
                    <span className={result.summary.failed ? 'text-rose-400' : 'text-slate-400'}>
                      {result.summary.failed} failed
                    </span>
                  </div>
                  {result.summary.failed > 0 && (
                    <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-rose-300/80">
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
