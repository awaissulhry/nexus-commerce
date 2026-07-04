'use client'

import { useCallback, useEffect, useState } from 'react'
import { Listbox } from '@/design-system/components/Listbox'
import { MapPin, Pencil, PowerOff, Plus, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Card } from '@/design-system/components/Card'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Modal } from '@/design-system/components/Modal'
import { EmptyState } from '@/design-system/components/EmptyState'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Toggle } from '@/design-system/primitives/Toggle'
import { Pill } from '@/design-system/primitives/Pill'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type LocationType = 'WAREHOUSE' | 'AMAZON_FBA' | 'CHANNEL_RESERVED' | 'SHOPIFY_LOCATION'

interface LocationAddress {
  street?: string
  city?: string
  country?: string
}

interface StockLocation {
  id: string
  code: string
  name: string
  type: LocationType
  isActive: boolean
  servesMarketplaces: string[]
  address?: LocationAddress | null
  skuCount: number
  totalQuantity: number
  totalReserved: number
  totalAvailable: number
}

interface FormState {
  name: string
  code: string
  type: 'WAREHOUSE' | 'AMAZON_FBA'
  servesMarketplaces: string
  isActive: boolean
  street: string
  city: string
  country: string
}

const BLANK_FORM: FormState = {
  name: '',
  code: '',
  type: 'WAREHOUSE',
  servesMarketplaces: '',
  isActive: true,
  street: '',
  city: '',
  country: '',
}

const TYPE_TONE: Record<LocationType, TagTone> = {
  WAREHOUSE: 'info',
  AMAZON_FBA: 'success',
  CHANNEL_RESERVED: 'warning',
  SHOPIFY_LOCATION: 'neutral',
}

const EDITABLE_TYPES: LocationType[] = ['WAREHOUSE', 'AMAZON_FBA']

// ── Inner component (needs ToastProvider above) ───────────────────────────────

function LocationsInner() {
  const { t } = useTranslations()
  const { toast } = useToast()

  const [locations, setLocations] = useState<StockLocation[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [formError, setFormError] = useState<string | null>(null)

  // Deactivate confirm
  const [deactivatingLoc, setDeactivatingLoc] = useState<StockLocation | null>(null)
  const [deactivating, setDeactivating] = useState(false)

  const fetchLocations = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/locations`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setLocations(data.locations ?? [])
    } catch (err) {
      toast(t('stock.locations.errorLoad'), 'danger')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast, t])

  useEffect(() => { void fetchLocations() }, [fetchLocations])

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function openCreate() {
    setEditingId(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setModalOpen(true)
  }

  function openEdit(loc: StockLocation) {
    setEditingId(loc.id)
    setForm({
      name: loc.name,
      code: loc.code,
      type: (EDITABLE_TYPES.includes(loc.type) ? loc.type : 'WAREHOUSE') as 'WAREHOUSE' | 'AMAZON_FBA',
      servesMarketplaces: loc.servesMarketplaces.join(', '),
      isActive: loc.isActive,
      street: (loc.address?.street ?? ''),
      city: (loc.address?.city ?? ''),
      country: (loc.address?.country ?? ''),
    })
    setFormError(null)
    setModalOpen(true)
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSave() {
    setFormError(null)
    const serves = form.servesMarketplaces
      .split(/[\s,]+/)
      .map((s) => s.toUpperCase().trim())
      .filter(Boolean)

    const body = editingId
      ? {
          name: form.name.trim(),
          servesMarketplaces: serves,
          isActive: form.isActive,
          address:
            form.street || form.city || form.country
              ? { street: form.street || undefined, city: form.city || undefined, country: form.country || undefined }
              : undefined,
        }
      : {
          name: form.name.trim(),
          code: form.code.trim(),
          type: form.type,
          servesMarketplaces: serves,
          isActive: form.isActive,
          address:
            form.street || form.city || form.country
              ? { street: form.street || undefined, city: form.city || undefined, country: form.country || undefined }
              : undefined,
        }

    setSaving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/locations${editingId ? `/${editingId}` : ''}`,
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      toast(t('stock.locations.saveSuccess'), 'success')
      setModalOpen(false)
      await fetchLocations()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDeactivate() {
    if (!deactivatingLoc) return
    setDeactivating(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/locations/${deactivatingLoc.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      toast(t('stock.locations.deactivateSuccess'), 'success')
      setDeactivatingLoc(null)
      await fetchLocations()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger')
    } finally {
      setDeactivating(false)
    }
  }

  // ── Columns ──────────────────────────────────────────────────────────────────

  const columns: Array<Column<StockLocation>> = [
    {
      key: 'code',
      label: t('stock.locations.col.code'),
      sticky: true,
      width: 140,
      render: (row) => <code className="font-mono text-xs text-slate-700 dark:text-slate-300">{row.code}</code>,
      sortable: true,
      sortValue: (row) => row.code,
    },
    {
      key: 'name',
      label: t('stock.locations.col.name'),
      render: (row) => <span className="font-medium">{row.name}</span>,
      sortable: true,
      sortValue: (row) => row.name,
    },
    {
      key: 'type',
      label: t('stock.locations.col.type'),
      width: 130,
      render: (row) => (
        <Tag tone={TYPE_TONE[row.type] ?? 'neutral'}>
          {t(`stock.locations.type.${row.type}` as any) || row.type}
        </Tag>
      ),
    },
    {
      key: 'serves',
      label: t('stock.locations.col.serves'),
      width: 160,
      render: (row) =>
        row.servesMarketplaces.length > 0 ? (
          <span className="text-sm text-secondary">
            {row.servesMarketplaces.join(', ')}
          </span>
        ) : (
          <span className="text-sm text-tertiary">—</span>
        ),
    },
    {
      key: 'skus',
      label: t('stock.locations.col.skus'),
      width: 70,
      align: 'right',
      render: (row) => <span className="tabular-nums">{row.skuCount}</span>,
      sortable: true,
      sortValue: (row) => row.skuCount,
    },
    {
      key: 'available',
      label: t('stock.locations.col.available'),
      width: 90,
      align: 'right',
      render: (row) => <span className="tabular-nums font-medium">{row.totalAvailable.toLocaleString()}</span>,
      sortable: true,
      sortValue: (row) => row.totalAvailable,
    },
    {
      key: 'status',
      label: t('stock.locations.col.status'),
      width: 90,
      render: (row) => (
        <Pill tone={row.isActive ? 'success' : 'neutral'}>
          {row.isActive ? t('stock.locations.status.active') : t('stock.locations.status.inactive')}
        </Pill>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: 100,
      align: 'right',
      render: (row) => {
        const canEdit = EDITABLE_TYPES.includes(row.type)
        return (
          <div className="flex items-center justify-end gap-1">
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('stock.locations.edit')}
                onClick={() => openEdit(row)}
              >
                <Pencil size={13} />
              </Button>
            )}
            {canEdit && row.isActive && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('stock.locations.deactivate')}
                onClick={() => setDeactivatingLoc(row)}
                className="text-rose-600 hover:text-rose-700"
              >
                <PowerOff size={13} />
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  // ── Render ───────────────────────────────────────────────────────────────────

  const rows = locations ?? []

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={t('stock.locations.title')}
        subtitle={t('stock.locations.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchLocations(true)}
              disabled={refreshing}
              aria-label="Refresh"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={14} />
              {t('stock.locations.add')}
            </Button>
          </div>
        }
      />

      <StockSubNav />

      <Card elevated>
        {loading ? (
          <div className="p-6 flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} height={36} />
            ))}
          </div>
        ) : (
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            initialSort={{ key: 'name', dir: 'asc' }}
            emptyState={
              <EmptyState
                icon={<MapPin size={32} className="text-tertiary" />}
                title={t('stock.locations.empty.title')}
                description={t('stock.locations.empty.description')}
                action={
                  <Button variant="primary" size="sm" onClick={openCreate}>
                    <Plus size={14} />
                    {t('stock.locations.add')}
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      {/* ── Create / Edit modal ─────────────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? t('stock.locations.edit') : t('stock.locations.add')}
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 p-1">
          {formError && (
            <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-300">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1 col-span-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('stock.locations.form.name')}
              </label>
              <Input
                placeholder={t('stock.locations.form.namePlaceholder')}
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
              />
            </div>

            {!editingId && (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {t('stock.locations.form.code')}
                  </label>
                  <Input
                    placeholder={t('stock.locations.form.codePlaceholder')}
                    value={form.code}
                    onChange={(e) => setField('code', e.target.value.toUpperCase())}
                  />
                  <span className="text-xs text-slate-500">{t('stock.locations.form.codeHint')}</span>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {t('stock.locations.form.type')}
                  </label>
                  <Listbox
                    value={form.type}
                    onChange={(v) => setField('type', v as 'WAREHOUSE' | 'AMAZON_FBA')}
                    ariaLabel={t('stock.locations.form.type')}
                    options={[
                      { value: 'WAREHOUSE', label: t('stock.locations.type.WAREHOUSE') },
                      { value: 'AMAZON_FBA', label: t('stock.locations.type.AMAZON_FBA') },
                    ]} />
                </div>
              </>
            )}

            <div className="flex flex-col gap-1 col-span-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('stock.locations.form.serves')}
              </label>
              <Input
                placeholder={t('stock.locations.form.servesPlaceholder')}
                value={form.servesMarketplaces}
                onChange={(e) => setField('servesMarketplaces', e.target.value)}
              />
              <span className="text-xs text-slate-500">{t('stock.locations.form.servesHint')}</span>
            </div>
          </div>

          <div className="border-t border-default pt-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
              {t('stock.locations.form.addressStreet')} / {t('stock.locations.form.addressCity')} / {t('stock.locations.form.addressCountry')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <Input
                placeholder={t('stock.locations.form.addressStreet')}
                value={form.street}
                onChange={(e) => setField('street', e.target.value)}
                className="col-span-3 sm:col-span-1"
              />
              <Input
                placeholder={t('stock.locations.form.addressCity')}
                value={form.city}
                onChange={(e) => setField('city', e.target.value)}
              />
              <Input
                placeholder={t('stock.locations.form.addressCountry')}
                value={form.country}
                onChange={(e) => setField('country', e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-default px-3 py-2">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('stock.locations.form.active')}
              </p>
              <p className="text-xs text-slate-500">{t('stock.locations.form.activeHint')}</p>
            </div>
            <Toggle checked={form.isActive} onChange={(v) => setField('isActive', v)} />
          </div>
        </div>
      </Modal>

      {/* ── Deactivate confirm ──────────────────────────────────────────────── */}
      <Modal
        open={deactivatingLoc !== null}
        onClose={() => setDeactivatingLoc(null)}
        title={t('stock.locations.deactivateConfirm', { name: deactivatingLoc?.name ?? '' })}
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeactivatingLoc(null)} disabled={deactivating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleDeactivate}
              disabled={deactivating}
              className="bg-rose-600 hover:bg-rose-700 border-rose-600"
            >
              {deactivating ? 'Deactivating…' : t('stock.locations.deactivate')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-secondary px-1 py-2">
          {t('stock.locations.deactivateNote')}
        </p>
      </Modal>
    </div>
  )
}

// ── Export (wrapped in ToastProvider) ────────────────────────────────────────

export default function LocationsClient() {
  return (
    <ToastProvider>
      <LocationsInner />
    </ToastProvider>
  )
}
